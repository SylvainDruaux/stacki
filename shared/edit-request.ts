// Edit requests (plan §2 layer 3, the compat adapter; §11 step 6): a gesture
// as the renderer can state it — in terms of the page it shows. The renderer
// holds a parse of the bytes it last read or was sent back, with UTF-16 source
// ranges on every node, and the checksum of those bytes; it does not hold the
// bytes, the byte offsets, or the printer that writes a new node. Main does:
// it turns a request into an Intent against the snapshot of the named
// checksum (electron/editRequests.ts), and the actor plans it like any other.
//
// A node is referred to by the facts of that parse — its path, its kind and
// its source range — and main checks them against its own projection of the
// same bytes before it trusts them. The request never carries an identity of
// its own (plan §4): a session id means nothing to main.
//
// The adapter half in main dies at step 9, when the renderer holds
// projections and authors intents directly.
import type { Digest } from './brand';
import { digest, pathText } from './boundary';
import type { CodeHunk } from './code-patch';
import type { AttributeValue, Placement, SourceEdit, StyleDeclaration } from './intent';
import { PLACEMENTS } from './intent';
import { LIMITS } from './limits';
import { parsePageModel, parsePageNode, type PageModel, type PageNode } from './page-node';
import { toArray, toRecord } from './record';
import { NODE_KINDS, STRUCTURAL_PATH_STEPS_MAX, type NodeKind } from './ref';
import { parseByteSpan, parseUtf16Span, spansAscending, type Utf16Span } from './span';

/** A node of the parse the request was authored against. */
export interface NodeRef {
  readonly path: readonly number[];
  readonly kind: NodeKind;
  readonly span: Utf16Span;
}

/** What goes in: new nodes main prints, or a copy of a node's own bytes (a
 * duplicate is its source, never a reprint). */
export type InsertContent =
  | { readonly tag: 'nodes'; readonly nodes: readonly PageNode[] }
  | { readonly tag: 'copy'; readonly source: NodeRef };

export type Edit =
  | {
      readonly tag: 'set-attribute';
      readonly target: NodeRef;
      readonly name: string;
      readonly value: AttributeValue;
    }
  | { readonly tag: 'remove-attribute'; readonly target: NodeRef; readonly name: string }
  | {
      readonly tag: 'set-inline-style';
      readonly target: NodeRef;
      readonly property: string;
      readonly declaration: StyleDeclaration;
    }
  | {
      readonly tag: 'insert-node';
      readonly target: NodeRef;
      readonly placement: Placement;
      readonly content: InsertContent;
    }
  | { readonly tag: 'remove-node'; readonly target: NodeRef }
  | {
      readonly tag: 'move-node';
      readonly target: NodeRef;
      readonly destination: NodeRef;
      readonly placement: Placement;
    }
  | {
      readonly tag: 'rename-binding';
      readonly target: NodeRef;
      readonly from: string;
      readonly to: string;
    }
  /** The frontmatter the page model now describes; main prints it and writes
   * only the slot that differs (an edit-frontmatter-slot intent). */
  | { readonly tag: 'set-frontmatter'; readonly model: PageModel }
  /** Undo and redo: byte hunks a previous reply handed back, against the
   * checksum that reply named. */
  | { readonly tag: 'revert'; readonly hunks: readonly SourceEdit[] }
  /** The code editor (step 8): the byte diff from the text of the named
   * checksum to the editor's text (shared/code-patch.ts). Each hunk names the
   * bytes it replaces, and main checks them against that checksum's bytes.
   * The result may not parse (plan §3.6). */
  | { readonly tag: 'code-patch'; readonly hunks: readonly CodeHunk[] };

export type EditTag = Edit['tag'];

export interface EditRequest {
  readonly pagePath: string;
  /** The checksum of the bytes the renderer's parse was read from. */
  readonly authoredChecksum: Digest;
  readonly edit: Edit;
}

const ATTRIBUTE_NAME_RE = /^[\w@:.-]+$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const STYLE_PROPERTY_RE = /^(?:--[\w-]+|-?[a-z][a-z-]*)$/;

export function parseEditRequest(input: unknown): EditRequest {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('Expected an edit request object');
  }
  return {
    pagePath: pathText(record['pagePath']),
    authoredChecksum: digest(record['authoredChecksum']),
    edit: parseEdit(record['edit']),
  };
}

export function parseEdit(input: unknown): Edit {
  const record = requireRecord(input, 'Edit');
  const tag = record['tag'];
  switch (tag) {
    case 'set-attribute':
      return {
        tag,
        target: parseNodeRef(record['target'], 'Edit.target'),
        name: attributeName(record['name']),
        value: parseAttributeValue(record['value']),
      };
    case 'remove-attribute':
      return {
        tag,
        target: parseNodeRef(record['target'], 'Edit.target'),
        name: attributeName(record['name']),
      };
    case 'set-inline-style':
      return {
        tag,
        target: parseNodeRef(record['target'], 'Edit.target'),
        property: styleProperty(record['property']),
        declaration: parseDeclaration(record['declaration']),
      };
    case 'insert-node':
      return {
        tag,
        target: parseNodeRef(record['target'], 'Edit.target'),
        placement: parsePlacement(record['placement']),
        content: parseContent(record['content']),
      };
    case 'remove-node':
      return { tag, target: parseNodeRef(record['target'], 'Edit.target') };
    case 'move-node':
      return {
        tag,
        target: parseNodeRef(record['target'], 'Edit.target'),
        destination: parseNodeRef(record['destination'], 'Edit.destination'),
        placement: parsePlacement(record['placement']),
      };
    case 'rename-binding':
      return parseRename(record);
    case 'set-frontmatter':
      return { tag, model: parsePageModel(record['model']) };
    case 'revert':
      return { tag, hunks: parseHunks(record['hunks']) };
    case 'code-patch':
      return { tag, hunks: parseCodeHunks(record['hunks']) };
    default:
      throw new Error(`Edit.tag: unknown edit ${JSON.stringify(tag)}`);
  }
}

export function parseNodeRef(input: unknown, where: string): NodeRef {
  const record = requireRecord(input, where);
  const steps = toArray(record['path']);
  if (steps === undefined) {
    throw new Error(`${where}.path: expected array`);
  }
  if (steps.length === 0) {
    throw new Error(`${where}.path: a node has at least one step`);
  }
  if (steps.length > STRUCTURAL_PATH_STEPS_MAX) {
    throw new Error(`${where}.path: exceeds ${STRUCTURAL_PATH_STEPS_MAX} steps`);
  }
  const path = steps.map((step, index) => {
    if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0) {
      throw new Error(`${where}.path[${index}]: expected a child index`);
    }
    if (step >= LIMITS.treeNodesMax) {
      throw new Error(`${where}.path[${index}]: exceeds ${LIMITS.treeNodesMax} siblings`);
    }
    return step;
  });
  return {
    path,
    kind: nodeKind(record['kind'], `${where}.kind`),
    span: parseUtf16Span(record['span'], `${where}.span`),
  };
}

function nodeKind(input: unknown, where: string): NodeKind {
  for (const kind of NODE_KINDS) {
    if (kind === input) {
      return kind;
    }
  }
  throw new Error(`${where}: unknown node kind ${JSON.stringify(input)}`);
}

function parseContent(input: unknown): InsertContent {
  const record = requireRecord(input, 'Edit.content');
  const tag = record['tag'];
  if (tag === 'copy') {
    return { tag, source: parseNodeRef(record['source'], 'Edit.content.source') };
  }
  if (tag === 'nodes') {
    const nodes = toArray(record['nodes']);
    if (nodes === undefined) {
      throw new Error('Edit.content.nodes: expected array');
    }
    if (nodes.length === 0) {
      throw new Error('Edit.content.nodes: expected at least one node');
    }
    // One shared counter bounds the whole insertion like one page tree.
    const context = { nodes: 0 };
    return {
      tag,
      nodes: nodes.map((node, index) =>
        parsePageNode(node, `Edit.content.nodes[${index}]`, 0, context),
      ),
    };
  }
  throw new Error(`Edit.content.tag: unknown value ${JSON.stringify(tag)}`);
}

function parseRename(record: Record<string, unknown>): Edit {
  const from = identifier(record['from'], 'Edit.from');
  const to = identifier(record['to'], 'Edit.to');
  if (from === to) {
    throw new Error('Edit.to: a rename must change the name');
  }
  return { tag: 'rename-binding', target: parseNodeRef(record['target'], 'Edit.target'), from, to };
}

function parseHunks(input: unknown): readonly SourceEdit[] {
  const hunks = toArray(input);
  if (hunks === undefined) {
    throw new Error('Edit.hunks: expected array');
  }
  if (hunks.length > LIMITS.splicesPerIntentMax) {
    throw new Error(`Edit.hunks: exceeds ${LIMITS.splicesPerIntentMax} items`);
  }
  return hunks.map((hunk, index) => {
    const record = requireRecord(hunk, `Edit.hunks[${index}]`);
    return {
      span: parseByteSpan(record['span'], `Edit.hunks[${index}].span`),
      text: boundedText(record['text'], `Edit.hunks[${index}].text`, LIMITS.intentPayloadBytesMax),
    };
  });
}

// The shape only: at least one hunk, ascending and disjoint, each text inside
// the payload bound. Whether the witnesses hold, whether the hunks sit on code
// points, and whether the summed payload fits are main's to check against the
// bytes (electron/editRequests.ts, the host) — a typed refusal, not a throw.
function parseCodeHunks(input: unknown): readonly CodeHunk[] {
  const hunks = toArray(input);
  if (hunks === undefined) {
    throw new Error('Edit.hunks: expected array');
  }
  if (hunks.length === 0) {
    throw new Error('Edit.hunks: a code patch has at least one hunk');
  }
  if (hunks.length > LIMITS.splicesPerIntentMax) {
    throw new Error(`Edit.hunks: exceeds ${LIMITS.splicesPerIntentMax} items`);
  }
  const parsed = hunks.map((hunk, index) => {
    const where = `Edit.hunks[${index}]`;
    const record = requireRecord(hunk, where);
    return {
      span: parseByteSpan(record['span'], `${where}.span`),
      expected: boundedText(record['expected'], `${where}.expected`, LIMITS.intentPayloadBytesMax),
      text: boundedText(record['text'], `${where}.text`, LIMITS.intentPayloadBytesMax),
    };
  });
  if (!spansAscending(parsed.map((hunk) => hunk.span))) {
    throw new Error('Edit.hunks: expected ascending disjoint spans');
  }
  return parsed;
}

function parseAttributeValue(input: unknown): AttributeValue {
  const record = requireRecord(input, 'Edit.value');
  const type = record['type'];
  if (type === 'bare') {
    return { type };
  }
  if (type === 'string' || type === 'expr') {
    return { type, value: boundedText(record['value'], 'Edit.value.value', LIMITS.attrCharsMax) };
  }
  throw new Error(`Edit.value.type: unknown value ${JSON.stringify(type)}`);
}

function parseDeclaration(input: unknown): StyleDeclaration {
  const record = requireRecord(input, 'Edit.declaration');
  const tag = record['tag'];
  if (tag === 'remove') {
    return { tag };
  }
  if (tag === 'set') {
    return {
      tag,
      value: boundedText(record['value'], 'Edit.declaration.value', LIMITS.attrCharsMax),
    };
  }
  throw new Error(`Edit.declaration.tag: unknown value ${JSON.stringify(tag)}`);
}

function parsePlacement(input: unknown): Placement {
  for (const placement of PLACEMENTS) {
    if (placement === input) {
      return placement;
    }
  }
  throw new Error(`Edit.placement: unknown value ${JSON.stringify(input)}`);
}

function attributeName(input: unknown): string {
  const name = boundedText(input, 'Edit.name', LIMITS.attrCharsMax);
  if (!ATTRIBUTE_NAME_RE.test(name)) {
    throw new Error('Edit.name: expected an attribute name');
  }
  return name;
}

function styleProperty(input: unknown): string {
  const property = boundedText(input, 'Edit.property', LIMITS.attrCharsMax);
  if (!STYLE_PROPERTY_RE.test(property)) {
    throw new Error('Edit.property: expected a CSS property name');
  }
  return property;
}

function identifier(input: unknown, where: string): string {
  const name = boundedText(input, where, LIMITS.tagNameCharsMax);
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`${where}: expected an identifier`);
  }
  return name;
}

function boundedText(input: unknown, where: string, charsMax: number): string {
  if (typeof input !== 'string') {
    throw new Error(`${where}: expected string`);
  }
  if (input.length > charsMax) {
    throw new Error(`${where}: exceeds ${charsMax} chars`);
  }
  return input;
}

function requireRecord(input: unknown, where: string): Record<string, unknown> {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error(`${where}: expected object`);
  }
  return record;
}
