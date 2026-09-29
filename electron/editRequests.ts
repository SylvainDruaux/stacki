// The electron half of the compat adapter (plan §2 layer 3; step 6): an edit
// request, stated in the renderer's terms, becomes an intent against the
// snapshot it was authored against. Here the renderer's node references are
// checked against main's own projection of the same bytes, UTF-16 ranges
// become byte spans, new nodes and frontmatter are printed by the legacy
// printer (only what is new — never the file), a node's new text is turned
// into hunks placed on its own bytes (step 9, `replace-node`), and a loop
// rename's sites are found (shared/loopScope.ts). Everything else is the
// planner's.
//
// On the legacy writer boundary (eslint.config.mjs) because it prints: new
// nodes with serializeNodes, and the frontmatter block with serializePage over
// a model without nodes. Step 9 moves node printing into the engine and
// deletes this module with the rest of the adapter.
import { assert } from '../shared/assert';
import { toUtf16Offset } from '../shared/brand';
import { diffCodePatch } from '../shared/code-patch';
import { DIFF_BUDGET, diffBytes, type ByteDiff } from '../shared/diff';
import type { Edit, NodeRef } from '../shared/edit-request';
import { mapSpanThroughDiff } from '../shared/mapSpan';
import type { BuiltEdit, EditBase, IntentDraft } from './documentActors';
import { TAG_NAME_RE } from '../shared/intent';
import type { Operation, Placement, RejectionReason, SourceEdit } from '../shared/intent';
import { renameSites } from '../shared/loopScope';
import {
  lineIndent,
  nodeAtPath,
  tagNameEnd,
  textOf,
  type ValidProjection,
} from '../shared/planSupport';
import { parsePageResult, type PageNode } from '../shared/page-node';
import { toAnchorRef, toChildIndex, type AnchorRef } from '../shared/ref';
import { err, ok, type Result } from '../shared/result';
import type { Snapshot } from '../shared/snapshot';
import {
  byteStringsEqual,
  decodeUtf8,
  encodeUtf8,
  spansAscending,
  toByteSpan,
  toByteString,
  utf16ToByteOffsets,
  type ByteSpan,
} from '../shared/span';
import { parsePage, serializeNodes, serializePage } from './astroParser';

interface Authored {
  readonly snapshot: Snapshot;
  readonly text: string;
  readonly projection: ValidProjection;
}

/** The intent an edit is. Every edit is built against the snapshot it names,
 * except a frontmatter request after the app's own commits: it states the
 * whole block the model now describes, and that model already holds what
 * those commits did, so it is compared with the block on disk now — against
 * the authored block it would do their part a second time. */
export function buildEdit(edit: Edit, base: EditBase): Result<BuiltEdit, RejectionReason> {
  if (edit.tag === 'set-frontmatter') {
    if (base.history === 'own-commits') {
      const built = buildEditIntent(edit, base.current);
      return built.ok ? ok({ draft: built.value, basis: 'current' }) : built;
    }
  }
  const built = buildEditIntent(edit, base.authored);
  return built.ok ? ok({ draft: built.value, basis: 'authored' }) : built;
}

/** The intent an edit is, against the snapshot it names. */
export function buildEditIntent(
  edit: Edit,
  snapshot: Snapshot,
): Result<IntentDraft, RejectionReason> {
  const decoded = decodeUtf8(snapshot.bytes);
  assert(decoded.ok, 'A page the renderer read decodes');
  if (edit.tag === 'revert') {
    return revertDraft(snapshot, edit.hunks);
  }
  if (edit.tag === 'code-patch') {
    return codePatchDraft(snapshot, edit.hunks); // Text, not nodes: a broken file takes it too.
  }
  const projection = snapshot.projection;
  if (projection.tag === 'parse-error') {
    return err('source-invalid');
  }
  const authored = { snapshot, text: decoded.value, projection };
  switch (edit.tag) {
    case 'set-attribute':
    case 'remove-attribute':
    case 'set-inline-style':
    case 'remove-node': {
      const { target, ...rest } = edit;
      return withAnchor(authored, target, (anchor) => ok({ anchor, operation: rest }));
    }
    case 'insert-node':
      return withAnchor(authored, edit.target, (anchor) => insertDraft(authored, anchor, edit));
    case 'move-node':
      return withAnchor(authored, edit.target, (anchor) =>
        withAnchor(authored, edit.destination, (destination) =>
          ok({ anchor, operation: { tag: 'move-node', destination, placement: edit.placement } }),
        ),
      );
    case 'rename-binding':
      return withAnchor(authored, edit.target, (anchor) => renameDraft(authored, anchor, edit));
    case 'rename-tag':
      return withAnchor(authored, edit.target, (anchor) =>
        tagRenameDraft(authored, anchor, edit.to),
      );
    case 'rename-attribute':
      return withAnchor(authored, edit.target, (anchor) =>
        tagAnchor(anchor)
          ? ok({ anchor, operation: { tag: 'rename-attribute', from: edit.from, to: edit.to } })
          : err('unsupported-operation'),
      );
    case 'replace-node':
      return withAnchor(authored, edit.target, (anchor) =>
        replaceDraft(authored, anchor, edit.node),
      );
    case 'set-frontmatter':
      return frontmatterDraft(authored, edit.model);
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

// The renderer's node reference, checked against the projection of the same
// bytes: the node at that path must have that kind and that range. A
// mismatch means the renderer's parse is not of these bytes.
function withAnchor(
  authored: Authored,
  ref: NodeRef,
  next: (anchor: AnchorRef) => Result<IntentDraft, RejectionReason>,
): Result<IntentDraft, RejectionReason> {
  const node = nodeAtPath(authored.projection, ref.path.map(toChildIndex));
  if (node === undefined) {
    return err('anchor-moved');
  }
  if (node.kind !== ref.kind) {
    return err('anchor-moved');
  }
  const span = byteSpanOf(authored.text, ref.span.start, ref.span.end);
  if (span === undefined) {
    return err('anchor-moved');
  }
  if (span.start !== node.span.start || span.end !== node.span.end) {
    return err('anchor-moved');
  }
  return next(toAnchorRef({ span, path: node.path, expectedKind: node.kind }));
}

// UTF-16 offsets from the wire: inside the text and on code-point boundaries,
// or no span at all.
function byteSpanOf(text: string, start: number, end: number): ByteSpan | undefined {
  if (end > text.length) {
    return undefined;
  }
  if (splitsPair(text, start) || splitsPair(text, end)) {
    return undefined;
  }
  const [first, last] = utf16ToByteOffsets(text, [toUtf16Offset(start), toUtf16Offset(end)]);
  assert(first !== undefined, 'The start was converted');
  assert(last !== undefined, 'The end was converted');
  return toByteSpan(first, last);
}

function splitsPair(text: string, offset: number): boolean {
  if (offset === 0 || offset >= text.length) {
    return false;
  }
  const before = text.charCodeAt(offset - 1);
  const at = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

// New nodes print with the legacy printer, their continuation lines indented
// to where they land; a copy is the source node's own bytes.
function insertDraft(
  authored: Authored,
  anchor: AnchorRef,
  edit: Extract<Edit, { tag: 'insert-node' }>,
): Result<IntentDraft, RejectionReason> {
  const eol = authored.text.includes('\r\n') ? '\r\n' : '\n';
  const indent =
    lineIndent(authored.snapshot.bytes, anchor.span.start) + (inside(edit.placement) ? '  ' : '');
  const content = edit.content;
  if (content.tag === 'copy') {
    return withAnchor(authored, content.source, (source) => {
      const bytes = authored.snapshot.bytes.subarray(source.span.start, source.span.end);
      const text = Buffer.from(bytes).toString('utf8');
      return ok({
        anchor,
        operation: { tag: 'insert-node', placement: edit.placement, source: text },
      });
    });
  }
  const printed = serializeNodes(content.nodes).replace(/\r?\n$/, '');
  const text = printed.split(/\r?\n/).join(`${eol}${indent}`);
  const operation: Operation = { tag: 'insert-node', placement: edit.placement, source: text };
  return ok({ anchor, operation });
}

function renameDraft(
  authored: Authored,
  anchor: AnchorRef,
  edit: Extract<Edit, { tag: 'rename-binding' }>,
): Result<IntentDraft, RejectionReason> {
  const loop = nodeAtPath(authored.projection, anchor.path);
  assert(loop !== undefined, 'A checked anchor names a projected node');
  if (loop.kind !== 'map') {
    return err('unsupported-operation');
  }
  const sites = renameSites(authored.projection, authored.snapshot.bytes, loop, edit.from);
  if (sites === undefined) {
    return err('unsupported-operation'); // A head or a test the rename cannot read.
  }
  return ok({ anchor, operation: { tag: 'rename-binding', from: edit.from, to: edit.to, sites } });
}

// A tag's new name: the old one is read off the authored bytes, where the
// planner will find it again (its witness). A `<style>` or `<script>` is raw
// text by its name, and `<>` has none: neither is renamed visually.
function tagRenameDraft(
  authored: Authored,
  anchor: AnchorRef,
  to: string,
): Result<IntentDraft, RejectionReason> {
  const node = nodeAtPath(authored.projection, anchor.path);
  assert(node !== undefined, 'A checked anchor names a projected node');
  if (node.kind !== 'element' && node.kind !== 'component') {
    return err('unsupported-operation');
  }
  const bytes = authored.snapshot.bytes;
  const from = textOf(bytes, toByteSpan(node.span.start + 1, tagNameEnd(bytes, node)));
  if (!TAG_NAME_RE.test(from)) {
    return err('unsupported-operation');
  }
  if (from === to) {
    return err('unsupported-operation'); // Nothing to write; the gesture had no change.
  }
  return ok({ anchor, operation: { tag: 'rename-tag', from, to } });
}

// A node as it should now read (step 9). The printer renders the node as it is
// and as it should be; the difference is the edit. The node's own bytes may be
// written differently from the printer's rendering — spacing, line breaks,
// entities the parser kept — so each changed range of the rendering is placed
// on the bytes through a diff between the two (the span mapper, which refuses
// rather than guesses). A range the formatting itself changed has no place:
// the edit is refused, and the node is never reprinted.
function replaceDraft(
  authored: Authored,
  anchor: AnchorRef,
  next: PageNode,
): Result<IntentDraft, RejectionReason> {
  const projected = nodeAtPath(authored.projection, anchor.path);
  assert(projected !== undefined, 'A checked anchor names a projected node');
  const previous = pageNodeAt(authored.text, anchor.path);
  if (previous === undefined) {
    return err('anchor-moved');
  }
  const bytes = authored.snapshot.bytes;
  const eol = authored.text.includes('\r\n') ? '\r\n' : '\n';
  const indent = lineIndent(bytes, projected.span.start);
  const print = (node: PageNode): string =>
    serializeNodes([node]).replace(/\r?\n$/, '').split(/\r?\n/).join(`${eol}${indent}`);
  const own = textOf(bytes, projected.span);
  const hunks = placedHunks(print(previous), print(next), own);
  if (!hunks.ok) {
    return hunks;
  }
  const shift = projected.span.start;
  const moved = hunks.value.map((hunk) => ({
    span: toByteSpan(hunk.span.start + shift, hunk.span.end + shift),
    text: hunk.text,
  }));
  return ok({ anchor, operation: { tag: 'rewrite-node', hunks: moved } });
}

// The printer's change from `before` to `after`, as hunks of `own` — the
// node's bytes. Equal renderings mean the printer and the bytes agree, and the
// change applies as it is; otherwise each hunk is placed on `own` through the
// diff from `before`.
function placedHunks(
  before: string,
  after: string,
  own: string,
): Result<readonly SourceEdit[], RejectionReason> {
  const change = diffCodePatch(before, after);
  if (!change.ok) {
    return change;
  }
  if (change.value.length === 0) {
    return err('unsupported-operation'); // The gesture changed nothing the printer writes.
  }
  if (before === own) {
    return ok(change.value.map((hunk) => ({ span: hunk.span, text: hunk.text })));
  }
  const diff = diffBytes(encodeUtf8(before), encodeUtf8(own), DIFF_BUDGET);
  if (diff.tag === 'too-costly') {
    return err('resource-limit');
  }
  const placed: SourceEdit[] = [];
  for (const hunk of change.value) {
    const span = placedSpan(diff.diff, hunk.span);
    if (span === undefined) {
      return err('unsupported-operation');
    }
    placed.push({ span, text: hunk.text });
  }
  if (!spansAscending(placed.map((hunk) => hunk.span))) {
    return err('unsupported-operation');
  }
  return ok(placed);
}

// A range of the rendering on the node's bytes: its own bytes kept whole, or,
// for an insertion, a neighbouring byte kept whole beside it.
function placedSpan(diff: ByteDiff, span: ByteSpan): ByteSpan | undefined {
  if (span.start < span.end) {
    const mapped = mapSpanThroughDiff(diff, span);
    return mapped.tag === 'resolved' ? mapped.span : undefined;
  }
  if (span.start > 0) {
    const before = mapSpanThroughDiff(diff, toByteSpan(span.start - 1, span.start));
    if (before.tag === 'resolved') {
      return toByteSpan(before.span.end, before.span.end);
    }
  }
  if (span.start < diff.source.length) {
    const after = mapSpanThroughDiff(diff, toByteSpan(span.start, span.start + 1));
    if (after.tag === 'resolved') {
      return toByteSpan(after.span.start, after.span.start);
    }
  }
  return undefined;
}

// Attributes live on tags: elements, component invocations, `<style>`/`<script>`.
function tagAnchor(anchor: AnchorRef): boolean {
  const kind = anchor.expectedKind;
  return kind === 'element' || kind === 'component' || kind === 'raw';
}

// The parsed node at a projection path: projections index the same tree.
function pageNodeAt(text: string, path: readonly number[]): PageNode | undefined {
  const parsed = parsePageResult(parsePage(text, { locs: true }));
  if (!parsed.editable) {
    return undefined;
  }
  let list: readonly PageNode[] = parsed.model.nodes;
  let node: PageNode | undefined;
  for (const step of path) {
    node = list[step];
    if (node === undefined) {
      return undefined;
    }
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  return node;
}

// The frontmatter the model describes, printed by the legacy printer, against
// the block on disk: only the differing middle becomes the slot, so a new
// import touches its line and nothing else.
function frontmatterDraft(
  authored: Authored,
  model: Extract<Edit, { tag: 'set-frontmatter' }>['model'],
): Result<IntentDraft, RejectionReason> {
  const block = authored.projection.frontmatter;
  if (block === undefined) {
    return err('unsupported-operation'); // Creating a block is a whole-file change.
  }
  const before = Buffer.from(authored.snapshot.bytes.subarray(block.start, block.end)).toString(
    'utf8',
  );
  const printed = printedBlock(serializePage({ ...model, nodes: [] }), before);
  if (printed === undefined) {
    return err('unsupported-operation');
  }
  let prefix = 0;
  const shorter = Math.min(before.length, printed.length);
  while (prefix < shorter && before.charCodeAt(prefix) === printed.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      printed.charCodeAt(printed.length - 1 - suffix)
  ) {
    suffix++;
  }
  // Whole code points only: a boundary inside a pair moves out of it.
  if (splitsPair(before, prefix) || splitsPair(printed, prefix)) {
    prefix--;
  }
  if (splitsPair(before, before.length - suffix) || splitsPair(printed, printed.length - suffix)) {
    suffix--;
  }
  const slot = byteSpanOf(before, prefix, before.length - suffix);
  assert(slot !== undefined, 'The slot lies inside the block on code-point boundaries');
  const anchor = toAnchorRef({ span: block, path: [], expectedKind: 'frontmatter' });
  const shifted = toByteSpan(block.start + slot.start, block.start + slot.end);
  const text = printed.slice(prefix, printed.length - suffix);
  return ok({ anchor, operation: { tag: 'edit-frontmatter-slot', slot: shifted, text } });
}

// The fenced block of a printed page without nodes, ending as the block on
// disk ends (with or without the line break after the closing fence).
function printedBlock(page: string, before: string): string | undefined {
  const eol = page.includes('\r\n') ? '\r\n' : '\n';
  const lines = page.split(eol);
  const close = lines.indexOf('---', 1);
  if (lines[0] !== '---' || close === -1) {
    return undefined;
  }
  const block = lines.slice(0, close + 1).join(eol);
  return before.endsWith('\n') ? `${block}${eol}` : block;
}

function revertDraft(
  snapshot: Snapshot,
  hunks: Extract<Edit, { tag: 'revert' }>['hunks'],
): Result<IntentDraft, RejectionReason> {
  const inside = hunks.every((hunk) => hunk.span.end <= snapshot.bytes.length);
  if (!inside || !spansAscending(hunks.map((hunk) => hunk.span)) || hunks.length === 0) {
    return err('anchor-moved'); // Not hunks of these bytes.
  }
  const anchor = toAnchorRef({
    span: toByteSpan(0, snapshot.bytes.length),
    path: [],
    expectedKind: 'document',
  });
  return ok({ anchor, operation: { tag: 'revert-splices', hunks } });
}

// The code editor's patch (step 8), checked against the bytes it names: every
// hunk inside them, on code-point boundaries, holding the text it says it
// replaces. A hunk that does not is not a diff of these bytes — the editor's
// text descends from some other version — and it cannot be merged.
function codePatchDraft(
  snapshot: Snapshot,
  hunks: Extract<Edit, { tag: 'code-patch' }>['hunks'],
): Result<IntentDraft, RejectionReason> {
  assert(hunks.length > 0, 'The wire parser requires a hunk');
  assert(spansAscending(hunks.map((hunk) => hunk.span)), 'The wire parser orders the hunks');
  const bytes = snapshot.bytes;
  for (const hunk of hunks) {
    if (bytes.length < hunk.span.end) {
      return err('merge-conflict');
    }
    if (continuesCodePoint(bytes, hunk.span.start) || continuesCodePoint(bytes, hunk.span.end)) {
      return err('merge-conflict');
    }
    const held = bytes.subarray(hunk.span.start, hunk.span.end);
    if (!byteStringsEqual(toByteString(held), encodeUtf8(hunk.expected))) {
      return err('merge-conflict');
    }
  }
  const anchor = toAnchorRef({
    span: toByteSpan(0, bytes.length),
    path: [],
    expectedKind: 'document',
  });
  const edits = hunks.map((hunk) => ({ span: hunk.span, text: hunk.text }));
  return ok({ anchor, operation: { tag: 'apply-code-patch', hunks: edits } });
}

// A UTF-8 continuation byte at `offset`: a span edge there splits a character.
function continuesCodePoint(bytes: Uint8Array, offset: number): boolean {
  const byte = bytes[offset];
  if (byte === undefined) {
    return false; // The end of the file is a boundary.
  }
  return byte >= 0x80 && byte < 0xc0;
}

function inside(placement: Placement): boolean {
  return placement === 'first-child' || placement === 'last-child';
}
