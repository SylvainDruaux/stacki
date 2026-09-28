// Oracle scenarios (plan §10): hand-built files with hand-derived expected
// splices. The nine simulator invariants are self-consistency; they cannot catch
// a planner that derives the wrong splice from a correct mapping. These can:
// each splice below is a literal byte offset read off the fixture by a human,
// and each expected output file was written by hand, not produced by code.
//
// The corpus carries the hard intent classes from day one (tracker step 1),
// even where shipping is deferred: a multi-span loop rename, a kind-changing
// move out of a loop (stripLostBindings), a multi-file page + stylesheet
// gesture, a frontmatter slot edit, a wrong-site trap (identical bytes at
// several ranges) and an encoding trap (BOM, CRLF, astral characters, so byte
// offsets differ from UTF-16 offsets).
//
// Fixtures: test/fixtures/editor-core/<file> and <name>.expected.<extension>.
import type { Operation, RejectionReason } from '../../dist/shared/intent.js';
import type { AnchorKind, AnchorRef, NodeKind } from '../../dist/shared/ref.js';
import type { ByteSpan } from '../../dist/shared/span.js';

export type IntentClass =
  | 'multi-span'
  | 'kind-changing'
  | 'multi-file'
  | 'frontmatter-slot'
  | 'wrong-site'
  | 'encoding';

/** Replace the bytes of `expected` at byte offset `start` with `replacement`. */
export interface OracleSplice {
  readonly start: number;
  readonly expected: string;
  readonly replacement: string;
}

export interface OracleContext {
  /** The byte span of each oracle splice's expected bytes, in order. */
  readonly spans: readonly ByteSpan[];
  /** The authored anchor of the node at `path` in the input file. */
  readonly anchorAt: (path: readonly number[]) => AnchorRef;
}

export interface OracleStep {
  readonly file: string;
  readonly expectedFile: string;
  readonly anchor: { readonly path: readonly number[]; readonly kind: AnchorKind };
  readonly operation: (context: OracleContext) => Operation;
  readonly splices: readonly OracleSplice[];
  /** Kinds the expected output shows at these paths. */
  readonly postKinds: readonly { readonly path: readonly number[]; readonly kind: NodeKind }[];
  /** What the step-1 reference planner must do: produce exactly these splices,
   * or reject with this reason because the operation is planned later. */
  readonly reference: 'agrees' | RejectionReason;
}

export interface OracleScenario {
  readonly name: string;
  readonly intentClass: IntentClass;
  /** Ordered and dependent: a step is submitted only after the previous one is
   * `applied`, and carries only its own file's witness (plan §3.3). */
  readonly steps: readonly OracleStep[];
}

const span = (context: OracleContext, index: number): ByteSpan => {
  const found = context.spans[index];
  if (found === undefined) {
    throw new Error(`Oracle: no splice ${index}`);
  }
  return found;
};

export const ORACLE_SCENARIOS: readonly OracleScenario[] = [
  {
    name: 'rename the first loop binding, not the second loop or the decoys',
    intentClass: 'multi-span',
    steps: [
      {
        file: 'loop-rename.astro',
        expectedFile: 'loop-rename.expected.astro',
        anchor: { path: [0, 0], kind: 'map' },
        operation: (context) => ({ tag: 'rename-binding', from: 'item', to: 'entry', sites: context.spans }),
        splices: [
          { start: 148, expected: 'item', replacement: 'entry' },
          { start: 189, expected: 'item', replacement: 'entry' },
          { start: 201, expected: 'item', replacement: 'entry' },
        ],
        postKinds: [
          { path: [0, 0], kind: 'map' },
          { path: [0, 0, 0, 0, 0], kind: 'expr' },
          { path: [2, 0], kind: 'map' },
        ],
        reference: 'agrees',
      },
    ],
  },
  {
    name: 'move a bound paragraph out of its loop; its binding becomes text',
    intentClass: 'kind-changing',
    steps: [
      {
        file: 'strip-bindings.astro',
        expectedFile: 'strip-bindings.expected.astro',
        anchor: { path: [0, 0, 0, 0], kind: 'element' },
        operation: (context) => ({
          tag: 'move-node',
          destination: context.anchorAt([0, 1]),
          placement: 'first-child',
        }),
        splices: [
          { start: 90, expected: '\n      <p>{item.title}</p>', replacement: '' },
          { start: 147, expected: '</aside>', replacement: '<p>content</p></aside>' },
        ],
        postKinds: [
          { path: [0, 1, 0], kind: 'element' },
          { path: [0, 1, 0, 0], kind: 'text' },
        ],
        reference: 'unsupported-operation',
      },
    ],
  },
  {
    name: 'feature a card: class on the page, then a rule in its stylesheet',
    intentClass: 'multi-file',
    steps: [
      {
        file: 'stylesheet-page.astro',
        expectedFile: 'stylesheet-page.expected.astro',
        anchor: { path: [0], kind: 'element' },
        operation: () => ({
          tag: 'set-attribute',
          name: 'class',
          value: { type: 'string', value: 'card card--featured' },
        }),
        splices: [{ start: 47, expected: 'card', replacement: 'card card--featured' }],
        postKinds: [{ path: [0], kind: 'element' }],
        reference: 'agrees',
      },
      {
        file: 'stylesheet.css',
        expectedFile: 'stylesheet.expected.css',
        anchor: { path: [], kind: 'document' },
        operation: (context) => ({
          tag: 'apply-code-patch',
          hunks: [
            { span: span(context, 0), text: '}\n\n.card--featured {\n  border: 2px solid gold;\n}\n' },
          ],
        }),
        splices: [
          {
            start: 25,
            expected: '}\n',
            replacement: '}\n\n.card--featured {\n  border: 2px solid gold;\n}\n',
          },
        ],
        postKinds: [],
        reference: 'agrees',
      },
    ],
  },
  {
    name: 'edit a code slot between two imports in the frontmatter',
    intentClass: 'frontmatter-slot',
    steps: [
      {
        file: 'frontmatter-slots.astro',
        expectedFile: 'frontmatter-slots.expected.astro',
        anchor: { path: [], kind: 'frontmatter' },
        operation: (context) => ({
          tag: 'edit-frontmatter-slot',
          slot: span(context, 0),
          text: '"New title"',
        }),
        splices: [{ start: 88, expected: '"Old title"', replacement: '"New title"' }],
        postKinds: [
          { path: [0], kind: 'component' },
          { path: [1], kind: 'component' },
        ],
        reference: 'agrees',
      },
    ],
  },
  {
    name: 'retitle the second of two identical cards — every title holds "Old"',
    intentClass: 'wrong-site',
    steps: [
      {
        file: 'duplicate-siblings.astro',
        expectedFile: 'duplicate-siblings.expected.astro',
        anchor: { path: [3], kind: 'component' },
        operation: () => ({ tag: 'set-attribute', name: 'title', value: { type: 'string', value: 'New' } }),
        splices: [{ start: 78, expected: 'Old', replacement: 'New' }],
        postKinds: [{ path: [3], kind: 'component' }],
        reference: 'agrees',
      },
    ],
  },
  {
    name: 'set an attribute after a BOM, CRLF lines and astral characters',
    intentClass: 'encoding',
    steps: [
      {
        file: 'unicode-offsets.astro',
        expectedFile: 'unicode-offsets.expected.astro',
        anchor: { path: [1], kind: 'element' },
        operation: () => ({
          tag: 'set-attribute',
          name: 'data-note',
          value: { type: 'string', value: 'plain' },
        }),
        splices: [{ start: 99, expected: 'naïve', replacement: 'plain' }],
        postKinds: [
          { path: [1], kind: 'element' },
          { path: [1, 0], kind: 'expr' },
        ],
        reference: 'agrees',
      },
    ],
  },
];
