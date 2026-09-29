// The electron half of the compat adapter (plan §2 layer 3; step 6): an edit
// request, stated in the renderer's terms, becomes an intent against the
// snapshot it was authored against. Here the renderer's node references are
// checked against main's own projection of the same bytes, UTF-16 ranges
// become byte spans, new nodes and frontmatter are printed by the legacy
// printer (only what is new — never the file), and a loop rename's sites are
// found (shared/loopScope.ts). Everything else is the planner's.
//
// On the legacy writer boundary (eslint.config.mjs) because it prints: new
// nodes with serializeNodes, and the frontmatter block with serializePage over
// a model without nodes. Step 9 moves node printing into the engine and
// deletes this module with the rest of the adapter.
import { assert } from '../shared/assert';
import { toUtf16Offset } from '../shared/brand';
import type { Edit, NodeRef } from '../shared/edit-request';
import type { IntentDraft } from './documentActors';
import type { Operation, Placement, RejectionReason } from '../shared/intent';
import { renameSites } from '../shared/loopScope';
import { lineIndent, nodeAtPath, type ValidProjection } from '../shared/planSupport';
import { toAnchorRef, toChildIndex, type AnchorRef } from '../shared/ref';
import { err, ok, type Result } from '../shared/result';
import type { Snapshot } from '../shared/snapshot';
import {
  decodeUtf8,
  spansAscending,
  toByteSpan,
  utf16ToByteOffsets,
  type ByteSpan,
} from '../shared/span';
import { serializeNodes, serializePage } from './astroParser';

interface Authored {
  readonly snapshot: Snapshot;
  readonly text: string;
  readonly projection: ValidProjection;
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

function inside(placement: Placement): boolean {
  return placement === 'first-child' || placement === 'last-child';
}
