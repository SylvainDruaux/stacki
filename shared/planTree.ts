// Planning the tree operations (plan §3.3, §3.4): `insert-node`, `remove-node`
// and `move-node`. A removal takes the node's bytes and the whitespace that
// set it apart; an insertion is a zero-width splice beside or inside a
// resolved node, separated the way that node is separated from what precedes
// it; a move is the two at once, and relocates the node's original bytes —
// it never prints the node again. Leaving a loop, the moved bytes lose their
// references to the loop's item (loopScope.ts, stripEdits): an expression
// becomes text, the one kind change a move makes.
//
// Every rejection is decided in the three plan functions; the helpers compute.
import { assert } from './assert';
import type { Operation, Placement, RejectionReason } from './intent';
import { stripEdits, scopeAt, type SourceReplacement } from './loopScope';
import type { Plan, PostKind, Splice } from './planner';
import {
  blankText,
  closeTagStart,
  containsNewline,
  lineIndent,
  nodeAtPath,
  nodeEditable,
  nodePlaceable,
  nodeUnchanged,
  openTagEnd,
  parentPath,
  resolveTarget,
  siblingsOf,
  slice,
  startsWith,
  textOf,
  whitespaceAfter,
  whitespaceBefore,
  type PlanContext,
  type Target,
  type ValidProjection,
} from './planSupport';
import { toChildIndex, type AnchorRef } from './ref';
import { err, ok, type Result } from './result';
import type { ProjectedNode } from './source-projection';
import { encodeUtf8, toByteSpan, toByteString, type ByteSpan, type ByteString } from './span';

/** A zero-width point and the text that goes there. */
interface Insertion {
  readonly at: number;
  readonly text: string;
  /** Where the anchor node sits once the text is in: an insertion before it
   * shifts it one sibling on. */
  readonly anchorPath: readonly number[];
}

export function planRemoveNode(
  context: PlanContext,
  anchor: AnchorRef,
): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  if (!movable(target.current.kind)) {
    return err('unsupported-operation'); // A branch or a chunk group is structure.
  }
  if (!nodePlaceable(target.current)) {
    return err('unsupported-operation');
  }
  if (!nodeUnchanged(context, target)) {
    return err('region-externally-modified');
  }
  const current = currentProjection(context);
  if (leavesCodeEmpty(context.current.bytes, current, target.current)) {
    return err('unsupported-operation');
  }
  const range = removalRange(context.current.bytes, current, target.current);
  const splice = spliceAt(context.current.bytes, range, '');
  return ok({
    splices: [splice],
    postKinds: parentKind(current, target.current),
    candidate: 'must-parse',
  });
}

export function planInsertNode(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'insert-node' }>,
): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  if (!placeWritable(target.current, operation.placement)) {
    return err('unsupported-operation');
  }
  const current = currentProjection(context);
  const insertion = insertionAt(
    context.current.bytes,
    current,
    target.current,
    operation.placement,
    operation.source,
  );
  if (!insertion.ok) {
    return insertion;
  }
  const at = toByteSpan(insertion.value.at, insertion.value.at);
  const splice = spliceAt(context.current.bytes, at, insertion.value.text);
  const postKinds = [
    { path: insertion.value.anchorPath.map(toChildIndex), kind: target.current.kind },
  ];
  return ok({ splices: [splice], postKinds, candidate: 'must-parse' });
}

// A node inside a loop is one source node the loop repeats (plan §6). Its own
// content is edited like any node's (step 7), but the list it sits in is the
// loop body's code, so nothing is removed from it or placed beside it — with one
// exception: moving it. That gesture exists to take a node out of its loop, and
// the move rewrites exactly what would break (the kind-changing class of §3.3).
export function planMoveNode(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'move-node' }>,
): Result<Plan, RejectionReason> {
  const source = resolveTarget(context, anchor);
  if (!source.ok) {
    return source;
  }
  const destination = resolveTarget(context, operation.destination);
  if (!destination.ok) {
    return destination;
  }
  const moved = source.value.current;
  if (!movable(moved.kind)) {
    return err('unsupported-operation');
  }
  if (!nodePlaceable(moved)) {
    if (moved.capability !== 'repeated-source-node') {
      return err('unsupported-operation');
    }
  }
  if (!placeWritable(destination.value.current, operation.placement)) {
    return err('unsupported-operation');
  }
  if (startsWith(destination.value.current.path, moved.path)) {
    return err('unsupported-operation'); // Into itself or its own subtree.
  }
  if (!nodeUnchanged(context, source.value)) {
    return err('region-externally-modified');
  }
  if (leavesCodeEmpty(context.current.bytes, currentProjection(context), moved)) {
    return err('unsupported-operation');
  }
  return planRelocation(context, source.value, destination.value, operation.placement);
}

function planRelocation(
  context: PlanContext,
  source: Target,
  destination: Target,
  placement: Placement,
): Result<Plan, RejectionReason> {
  const bytes = context.current.bytes;
  const current = currentProjection(context);
  const text = relocatedText(bytes, current, source.current, destination.current, placement);
  if (!text.ok) {
    return text;
  }
  const insertion = insertionAt(bytes, current, destination.current, placement, text.value);
  if (!insertion.ok) {
    return insertion;
  }
  const removal = removalRange(bytes, current, source.current);
  const at = insertion.value.at;
  if (removal.start < at) {
    if (at < removal.end) {
      return err('unsupported-operation'); // Beside itself: a move that goes nowhere.
    }
  }
  // Ascending, the insertion first when both start at one byte (orderedSplices
  // keeps that order, and the zero-width splice ends where the removal starts).
  const insert = spliceAt(bytes, toByteSpan(at, at), insertion.value.text);
  const remove = spliceAt(bytes, removal, '');
  const splices = at <= removal.start ? [insert, remove] : [remove, insert];
  return ok({ splices, postKinds: [], candidate: 'must-parse' });
}

// The moved bytes, minus the loop references the destination cannot satisfy.
function relocatedText(
  bytes: ByteString,
  projection: ValidProjection,
  moved: ProjectedNode,
  destination: ProjectedNode,
  placement: Placement,
): Result<string, RejectionReason> {
  const before = scopeAt(projection, bytes, moved.path);
  const destinationPath = inside(placement)
    ? [...destination.path, toChildIndex(0)]
    : destination.path;
  const after = scopeAt(projection, bytes, destinationPath);
  if (before === undefined) {
    return err('unsupported-operation'); // A loop head this cannot read.
  }
  if (after === undefined) {
    return err('unsupported-operation');
  }
  const lost = before.filter((name) => !after.includes(name));
  const edits = lost.length === 0 ? [] : stripEdits(projection, bytes, moved, lost);
  if (edits === undefined) {
    return err('unsupported-operation');
  }
  const relocated = withReplacements(bytes, moved.span, edits);
  return ok(textOf(relocated, toByteSpan(0, relocated.length)));
}

// The bytes of `span` with each edit (absolute, ascending, inside it) applied.
function withReplacements(
  bytes: ByteString,
  span: ByteSpan,
  edits: readonly SourceReplacement[],
): ByteString {
  const parts: Uint8Array[] = [];
  let cursor = span.start;
  for (const edit of edits) {
    assert(cursor <= edit.span.start, 'Replacements ascend without overlapping');
    assert(edit.span.end <= span.end, 'Replacements lie inside the moved node');
    parts.push(bytes.subarray(cursor, edit.span.start), encodeUtf8(edit.text));
    cursor = edit.span.end;
  }
  parts.push(bytes.subarray(cursor, span.end));
  const size = parts.reduce((total, part) => total + part.length, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return toByteString(joined);
}

function inCode(projection: ValidProjection, node: ProjectedNode): boolean {
  if (node.path.length === 1) {
    return false;
  }
  const parent = nodeAtPath(projection, parentPath(node.path));
  assert(parent !== undefined, 'A nested node has a parent');
  return parent.kind === 'branch' || parent.kind === 'map';
}

// A condition's branch and a loop's body are JavaScript around markup: taking
// out the only node leaves `cond && ( )`, which the parser reads but no
// JavaScript engine will run. The legacy printer writes `null` there; until a
// planner rule does, such a removal is refused and the page saved whole.
function leavesCodeEmpty(
  bytes: ByteString,
  projection: ValidProjection,
  node: ProjectedNode,
): boolean {
  if (node.path.length === 1) {
    return false;
  }
  if (!inCode(projection, node)) {
    return false;
  }
  const others = siblingsOf(projection, node).filter(
    (sibling) => sibling !== node && !blankText(bytes, sibling),
  );
  return others.length === 0;
}

/** What a removal takes: the node, and the whitespace run before it when that
 * run holds a line break (the node's own line); otherwise the whitespace after
 * it through the first line break, so no blank line is left; otherwise the
 * node alone (it sat inline). The runs never cross a sibling or the parent. */
export function removalRange(
  bytes: ByteString,
  projection: ValidProjection,
  node: ProjectedNode,
): ByteSpan {
  const bounds = siblingBounds(bytes, projection, node);
  const before = whitespaceBefore(bytes, node.span.start, bounds.floor);
  if (containsNewline(bytes, toByteSpan(before, node.span.start))) {
    return toByteSpan(before, node.span.end);
  }
  const after = whitespaceAfter(bytes, node.span.end, bounds.ceiling);
  const newline = bytes.subarray(node.span.end, after).indexOf(0x0a);
  if (newline >= 0) {
    return toByteSpan(node.span.start, node.span.end + newline + 1);
  }
  return node.span;
}

function insertionAt(
  bytes: ByteString,
  projection: ValidProjection,
  anchor: ProjectedNode,
  placement: Placement,
  text: string,
): Result<Insertion, RejectionReason> {
  if (inside(placement)) {
    return insertionInside(bytes, projection, anchor, placement, text);
  }
  if (!movable(anchor.kind)) {
    return err('unsupported-operation'); // Beside a branch is inside its condition.
  }
  if (inCode(projection, anchor)) {
    // A condition's branch or a loop's body is JavaScript around markup: a
    // second node beside the first can land outside the parentheses (a bare
    // `: other ? …` branch) and break the expression. The legacy printer
    // rewraps it; until a planner rule does, the page is saved whole.
    return err('unsupported-operation');
  }
  const separator = separatorBefore(bytes, projection, anchor);
  if (placement === 'after') {
    return ok({ at: anchor.span.end, text: `${separator}${text}`, anchorPath: anchor.path });
  }
  return ok({
    at: anchor.span.start,
    text: `${text}${separator}`,
    anchorPath: shifted(anchor.path),
  });
}

// Inside a tag: beside its first or last child, or, when it has none, right
// after its opening tag — on a line of its own, one level in, when the tag's
// closing sits on a later line. A self-closing tag has no inside to write to.
function insertionInside(
  bytes: ByteString,
  projection: ValidProjection,
  parent: ProjectedNode,
  placement: Placement,
  text: string,
): Result<Insertion, RejectionReason> {
  if (parent.kind !== 'element') {
    if (parent.kind !== 'component') {
      return err('unsupported-operation');
    }
  }
  const children = childrenOf(projection, parent);
  const first = children[0];
  const last = children[children.length - 1];
  if (first !== undefined) {
    if (last !== undefined) {
      const beside = placement === 'first-child' ? first : last;
      const separator = separatorBefore(bytes, projection, beside);
      return placement === 'first-child'
        ? ok({ at: first.span.start, text: `${text}${separator}`, anchorPath: parent.path })
        : ok({ at: last.span.end, text: `${separator}${text}`, anchorPath: parent.path });
    }
  }
  const open = openTagEnd(bytes, parent);
  if (open.selfClosing) {
    return err('unsupported-operation');
  }
  const close = closeTagStart(bytes, parent, open.end);
  if (close === undefined) {
    return err('unsupported-operation');
  }
  const lined = containsNewline(bytes, toByteSpan(open.end, close));
  const lead = lined ? `\n${lineIndent(bytes, parent.span.start)}  ` : '';
  return ok({ at: open.end, text: `${lead}${text}`, anchorPath: parent.path });
}

// How the node is set apart from what precedes it: the whitespace run between
// them. A root node with nothing before it on its line gets a line break.
function separatorBefore(
  bytes: ByteString,
  projection: ValidProjection,
  node: ProjectedNode,
): string {
  const bounds = siblingBounds(bytes, projection, node);
  const start = whitespaceBefore(bytes, node.span.start, bounds.floor);
  const separator = textOf(bytes, toByteSpan(start, node.span.start));
  if (separator === '') {
    if (node.path.length === 1) {
      return '\n';
    }
  }
  return separator;
}

// A node's whitespace neighbourhood ends at its siblings, else at its parent's
// content (inside a tag's opening and closing), else at the file's body.
function siblingBounds(
  bytes: ByteString,
  projection: ValidProjection,
  node: ProjectedNode,
): { readonly floor: number; readonly ceiling: number } {
  // Blank text between siblings is the separator itself, never a neighbour.
  const siblings = siblingsOf(projection, node).filter(
    (sibling) => sibling === node || !blankText(bytes, sibling),
  );
  const index = siblings.indexOf(node);
  assert(index >= 0, 'A node is among its siblings');
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const outer = contentOf(bytes, projection, node);
  return {
    floor: previous === undefined ? outer.start : previous.span.end,
    ceiling: next === undefined ? outer.end : next.span.start,
  };
}

// The bytes a node's parent holds its children in.
function contentOf(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): ByteSpan {
  if (node.path.length === 1) {
    const body =
      projection.frontmatter === undefined ? bomLength(bytes) : projection.frontmatter.end;
    return toByteSpan(body, bytes.length);
  }
  const parent = nodeAtPath(projection, parentPath(node.path));
  assert(parent !== undefined, 'A nested node has a parent');
  if (parent.kind === 'element' || parent.kind === 'component') {
    const open = openTagEnd(bytes, parent);
    const close = closeTagStart(bytes, parent, open.end);
    assert(close !== undefined, 'A tag with children has a closing tag');
    return toByteSpan(open.end, close);
  }
  return parent.span;
}

function bomLength(bytes: ByteString): number {
  if (bytes[0] === 0xef) {
    if (bytes[1] === 0xbb) {
      return bytes[2] === 0xbf ? 3 : 0;
    }
  }
  return 0;
}

function childrenOf(projection: ValidProjection, node: ProjectedNode): readonly ProjectedNode[] {
  return projection.nodes.filter(
    (candidate) =>
      candidate.path.length === node.path.length + 1 && startsWith(candidate.path, node.path),
  );
}

function parentKind(projection: ValidProjection, node: ProjectedNode): readonly PostKind[] {
  if (node.path.length === 1) {
    return [];
  }
  const parent = nodeAtPath(projection, parentPath(node.path));
  assert(parent !== undefined, 'A nested node has a parent');
  return [{ path: parent.path, kind: parent.kind }];
}

function currentProjection(context: PlanContext): ValidProjection {
  const projection = context.current.projection;
  assert(projection.tag === 'valid', 'A resolved target lies in a parsing file');
  return projection;
}

function shifted(path: readonly number[]): readonly number[] {
  const last = path[path.length - 1];
  assert(last !== undefined, 'A tree node has a path');
  return [...path.slice(0, -1), last + 1];
}

// Beside a node, the list it sits in is written; inside it, its own content.
function placeWritable(node: ProjectedNode, placement: Placement): boolean {
  return inside(placement) ? nodeEditable(node) : nodePlaceable(node);
}

function inside(placement: Placement): boolean {
  switch (placement) {
    case 'first-child':
    case 'last-child':
      return true;
    case 'before':
    case 'after':
      return false;
    default: {
      const exhaustive: never = placement;
      return exhaustive;
    }
  }
}

// A branch belongs to its condition and a chunk group to its chunk file; the
// rest of the tree can be taken out, put back, or stood beside.
function movable(kind: ProjectedNode['kind']): boolean {
  switch (kind) {
    case 'branch':
    case 'chunk-group':
      return false;
    case 'component':
    case 'element':
    case 'raw':
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'map':
    case 'cond':
      return true;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function spliceAt(bytes: ByteString, range: ByteSpan, replacement: string): Splice {
  return {
    range,
    expectedBytes: slice(bytes, range),
    replacementBytes: encodeUtf8(replacement),
  };
}
