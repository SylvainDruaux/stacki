// The renderer's layers (docs/codebase.md, "Directory map"): a module imports
// only the layers below its own, a feature imports another feature only along
// an edge the config names, and renderer code reaches outside its root only
// into the contract layer. Relative imports carry no extension: tsc and Vite
// resolve the module, and one spelling is what the move tool writes.
//
// The rule reads import paths only, never the disk: a specifier is resolved
// against the importing file's own path, so the answer is the same on every
// machine and costs nothing per file.

import path from 'node:path';
import type { TSESTree } from '@typescript-eslint/utils';
import { assert } from '../policy/assert.mts';
import type { RuleModule } from './ast.mts';

type MessageIds = 'crossFeature' | 'extension' | 'layerOrder' | 'outsideRoot';

interface Options {
  // The repository, absolute; the config passes its own folder. Lint runs
  // from anywhere, so the working directory cannot stand in for it.
  readonly repository?: string;
  // The source root, repository-relative: `src`.
  readonly root: string;
  // Layer folders under the root, lowest first.
  readonly layers: readonly string[];
  // The layer whose folders are features: `features`.
  readonly featureLayer: string;
  // Feature name → the files of other features it may import, root-relative
  // and without an extension (`features/style/VariableConnect`).
  readonly featureEdges?: Readonly<Record<string, readonly string[]>>;
  // Repository folders outside the root that any module may import.
  readonly outside: readonly string[];
  // Root-relative importer, without an extension → the repository files
  // outside the allowed folders it may still import, also without one.
  readonly outsideEdges?: Readonly<Record<string, readonly string[]>>;
}

// Extensions a relative specifier must not carry; a stylesheet keeps its own.
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

export const sourceLayers: RuleModule<MessageIds, [Options]> = {
  meta: {
    type: 'problem',
    docs: { description: 'Renderer modules import along the layer order (docs/codebase.md).' },
    messages: {
      layerOrder:
        '{{from}} may not import {{to}}: a layer imports only the layers below it ({{order}}).',
      crossFeature:
        'features/{{from}} may not import {{target}}: features import each other only along ' +
        'the edges eslint.config.mjs lists.',
      outsideRoot:
        '{{importer}} may not import {{target}}: renderer code reaches outside {{root}}/ only ' +
        'into {{outside}}.',
      extension:
        "Relative imports carry no extension ('{{specifier}}'): tsc and Vite resolve the module.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          root: { type: 'string' },
          layers: { type: 'array', items: { type: 'string' } },
          featureLayer: { type: 'string' },
          featureEdges: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
          outside: { type: 'array', items: { type: 'string' } },
          outsideEdges: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
        },
        required: ['root', 'layers', 'featureLayer', 'outside'],
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ root: 'src', layers: [], featureLayer: 'features', outside: [] }],
  create(context) {
    const [options] = context.options;
    assert(options !== undefined, 'sourceLayers: options are required');
    const repository = options.repository ?? context.cwd;
    const importer = path.relative(repository, context.filename).split(path.sep).join('/');
    if (!importer.startsWith(`${options.root}/`)) {
      return {};
    }
    function check(source: TSESTree.Node | undefined): void {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') {
        return;
      }
      const verdict = importVerdict(options, importer, source.value);
      if (verdict !== undefined) {
        context.report({ node: source, messageId: verdict.messageId, data: verdict.data });
      }
    }
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source ?? undefined),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) =>
        check(node.argument.type === 'TSLiteralType' ? node.argument.literal : undefined),
    };
  },
};

interface Verdict {
  readonly messageId: MessageIds;
  readonly data: Readonly<Record<string, string>>;
}

// The whole decision, as a pure function of the options, the importing file
// and the specifier: undefined when the import is allowed.
export function importVerdict(
  options: Options,
  importer: string,
  specifier: string,
): Verdict | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  if (CODE_EXTENSION.test(specifier)) {
    return { messageId: 'extension', data: { specifier } };
  }
  const target = path.posix.join(path.posix.dirname(importer), specifier);
  const rootPrefix = `${options.root}/`;
  const from = importer.slice(rootPrefix.length);
  if (!target.startsWith(rootPrefix)) {
    return outsideVerdict(options, from, target);
  }
  return layerVerdict(options, from, target.slice(rootPrefix.length));
}

function outsideVerdict(options: Options, from: string, target: string): Verdict | undefined {
  if (options.outside.some((folder) => target.startsWith(`${folder}/`))) {
    return undefined;
  }
  const allowed = options.outsideEdges?.[withoutExtension(from)] ?? [];
  if (allowed.includes(withoutExtension(target))) {
    return undefined;
  }
  const data = {
    importer: `${options.root}/${from}`,
    target,
    root: options.root,
    outside: options.outside.map((folder) => `${folder}/`).join(', '),
  };
  return { messageId: 'outsideRoot', data };
}

// Root-relative paths in, layers by their first folder. A file directly in the
// root (the entry, main.tsx) sits above every layer.
function layerVerdict(options: Options, from: string, to: string): Verdict | undefined {
  const fromLayer = layerOf(from);
  const toLayer = layerOf(to);
  if (fromLayer === undefined) {
    return undefined;
  }
  if (toLayer === undefined) {
    const order = options.layers.join(' → ');
    return { messageId: 'layerOrder', data: { from: fromLayer, to: 'the entry', order } };
  }
  const fromRank = options.layers.indexOf(fromLayer);
  const toRank = options.layers.indexOf(toLayer);
  assert(fromRank >= 0, `sourceLayers: ${fromLayer}/ is not a listed layer`);
  assert(toRank >= 0, `sourceLayers: ${toLayer}/ is not a listed layer`);
  if (toRank > fromRank) {
    const order = options.layers.join(' → ');
    return { messageId: 'layerOrder', data: { from: fromLayer, to: toLayer, order } };
  }
  if (fromLayer === options.featureLayer && toLayer === options.featureLayer) {
    return featureVerdict(options, from, to);
  }
  return undefined;
}

function featureVerdict(options: Options, from: string, to: string): Verdict | undefined {
  const fromFeature = from.split('/')[1];
  const toFeature = to.split('/')[1];
  assert(fromFeature !== undefined, 'sourceLayers: a feature file sits in a feature folder');
  if (fromFeature === toFeature) {
    return undefined;
  }
  const allowed = options.featureEdges?.[fromFeature] ?? [];
  if (allowed.includes(withoutExtension(to))) {
    return undefined;
  }
  return {
    messageId: 'crossFeature',
    data: { from: fromFeature, target: `${options.root}/${to}` },
  };
}

function layerOf(rootRelative: string): string | undefined {
  const parts = rootRelative.split('/');
  return parts.length > 1 ? parts[0] : undefined;
}

function withoutExtension(file: string): string {
  return file.replace(/\.(?:[cm]?[jt]sx?|css)$/, '');
}
