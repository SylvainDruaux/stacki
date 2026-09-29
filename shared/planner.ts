// The intent planner (plan §5.2 steps 2–6): which bytes an intent replaces, and
// what they must hold. Pure — snapshots and an intent in, a Result out; no I/O,
// no clock, no randomness — so the simulator calls it directly and the actor
// wraps it with the disk (plan §5.2, invariant 9 by construction).
//
// Step 2 plans one operation, `set-attribute`, against an intent that may be
// stale: its anchor is resolved in the bytes it was authored against, the
// element's identity region is mapped through the diff to the bytes on disk now
// (mapSpan.ts), and the splice is planned at the mapped value, with the authored
// value bytes as its witness.
//
// The identity region runs from the tag name through the end of the last
// attribute: `Hero title="Old"` in `<Hero title="Old" />`. It carries the
// element's identity and holds the value being replaced. Smaller fails: the
// value alone repeats everywhere (`title="Old"` on the hero and the footer).
// Larger fails too: the whole element would refuse an attribute edit whenever
// someone edits text inside it, and the tag's own `<` and `/>` are bytes every
// neighbouring tag shares — insert `<div>` before `<Hero`, and a script that
// matches Hero's `<` to the div's costs exactly as little as the true one, so
// the mapper, which never picks between tied scripts, would call it ambiguous.
//
// The witness guards staleness, not identity (plan §3.4); identity comes from
// the mapping, which rejects on ambiguity. From step 5 the migration-only
// `replace-source` is planned too, without mapping (planReplaceSource). Every
// other operation is `unsupported-operation` here until its step (6 and 8); the
// simulator's reference planner plans the zero-diff cases of the rest until then.
import { assert } from './assert';
import { countOccurrences } from './byteSearch';
import { capabilityAcceptsVisualIntent } from './capability';
import { diffBytes, DIFF_BUDGET } from './diff';
import type { Intent, Operation, RejectionReason } from './intent';
import { LIMITS } from './limits';
import { mapSpanThroughDiff, type SpanMapping } from './mapSpan';
import type { AnchorRef, NodeKind, StructuralPath } from './ref';
import { err, ok, type Result } from './result';
import type { Snapshot } from './snapshot';
import type { ProjectedAttribute, ProjectedNode, Projection } from './source-projection';
import {
  byteStringsEqual,
  encodeUtf8,
  toByteSpan,
  toByteString,
  type ByteSpan,
  type ByteString,
} from './span';

/** The only write primitive (plan §3.4): replace `range` with
 * `replacementBytes`, but only while it still holds `expectedBytes`. */
export interface Splice {
  readonly range: ByteSpan;
  readonly expectedBytes: ByteString;
  readonly replacementBytes: ByteString;
}

export interface PostKind {
  readonly path: StructuralPath;
  readonly kind: NodeKind;
}

/** What the candidate must satisfy after the splices apply (plan §5.2 step 6).
 * Visual intents need a parsing candidate; the code editor and the legacy save
 * may write invalid bytes (plan §3.6). */
export type CandidatePolicy = 'must-parse' | 'may-be-invalid';

export interface Plan {
  readonly splices: readonly Splice[];
  /** Nodes that must keep their kind in the candidate, in its own paths. */
  readonly postKinds: readonly PostKind[];
  readonly candidate: CandidatePolicy;
}

export interface PlanningBase {
  /** The snapshot the intent was authored against: its checksum is the
   * intent's `authoredChecksum`. Which snapshots the actor keeps for this is
   * the step-5 retention question (tracker, open questions). */
  readonly authored: Snapshot;
  /** The snapshot of the bytes on disk now (plan §5.2 step 1). */
  readonly current: Snapshot;
}

/** Plan an intent. When nothing changed since it was authored, the mapping is
 * the identity and no diff runs — the fast path; `planIntentThroughDiff` is its
 * brute-force reference and must agree with it (plan §10). */
export function planIntent(base: PlanningBase, intent: Intent): Result<Plan, RejectionReason> {
  if (base.authored.checksum === base.current.checksum) {
    assert(
      byteStringsEqual(base.authored.bytes, base.current.bytes),
      'Equal checksums name equal bytes',
    );
    return planWith(base, intent, (span) => ({ tag: 'resolved', span }));
  }
  return planIntentThroughDiff(base, intent);
}

/** The same planner with every span mapped through a computed diff, even an
 * empty one. The actor calls `planIntent`; tests call this to hold the
 * identity fast path to it. */
export function planIntentThroughDiff(
  base: PlanningBase,
  intent: Intent,
): Result<Plan, RejectionReason> {
  // The diff runs once, on the first span that needs it, and only then: a
  // rejection before any mapping costs no diff. Local, private memo state.
  let computed: ReturnType<typeof diffBytes> | undefined;
  return planWith(base, intent, (span) => {
    computed ??= diffBytes(base.authored.bytes, base.current.bytes, DIFF_BUDGET);
    switch (computed.tag) {
      case 'computed':
        return uniqueOrAmbiguous(
          base,
          computed.diff.distance,
          mapSpanThroughDiff(computed.diff, span),
        );
      case 'too-costly':
        return { tag: 'too-costly' };
      default: {
        const exhaustive: never = computed;
        return exhaustive;
      }
    }
  });
}

// --- Internal ----------------------------------------------------------------

// A resolved remap names bytes equal to the authored identity region. Those
// bytes are only proof of identity if they occur once in the current file: if
// the target's region survives intact, it is an occurrence, so a unique
// occurrence is the target (the invariant). Where they repeat, the minimum edit
// script can still be unique and wrong — edit above, paste a copy of the target,
// and the cheapest script maps the target onto the copy (the step-3 wrong-site
// plans, planner.test.ts). The minimum script is not the history, so repeated
// bytes are ambiguous whatever the script says. A distance of zero maps by
// identity and holds nothing to guess, so the fast path and this one agree.
//
// Not covered, and not coverable from bytes: a copy of the target pasted while
// another writer rewrites the original's region. The same bytes arise from an
// element inserted above the untouched target; only history tells them apart.
function uniqueOrAmbiguous(base: PlanningBase, distance: number, mapped: SpanMapping): SpanMapping {
  assert(Number.isSafeInteger(distance), 'The diff distance is an integer');
  if (mapped.tag === 'resolved') {
    if (distance > 0) {
      const region = base.current.bytes.subarray(mapped.span.start, mapped.span.end);
      const occurrences = countOccurrences(base.current.bytes, toByteString(region), 2);
      assert(occurrences >= 1, 'The resolved region occurs where it was mapped');
      if (occurrences === 1) {
        return mapped;
      }
      return { tag: 'ambiguous' };
    }
    return mapped; // Identical files: the identity mapping guesses nothing.
  }
  return mapped;
}

type SpanMapper = (span: ByteSpan) => SpanMapping;

type SetAttribute = Extract<Operation, { tag: 'set-attribute' }>;

type ValidProjection = Extract<Projection, { tag: 'valid' }>;

const QUOTES: readonly number[] = [0x22, 0x27]; // `"` and `'`
const TAG_OPEN = 0x3c; // `<`

function planWith(
  base: PlanningBase,
  intent: Intent,
  mapSpan: SpanMapper,
): Result<Plan, RejectionReason> {
  assert(base.authored.path === intent.file, 'An intent is planned against its own file');
  assert(base.current.path === intent.file, 'The current snapshot is of the intent file');
  assert(
    base.authored.checksum === intent.authoredChecksum,
    'The authored snapshot is the one the intent names',
  );
  const operation = intent.operation;
  switch (operation.tag) {
    case 'set-attribute':
      return planSetAttribute(base, intent.anchor, operation, mapSpan);
    case 'remove-attribute':
    case 'insert-node':
    case 'move-node':
    case 'rename-binding':
    case 'set-inline-style':
    case 'edit-frontmatter-slot':
    case 'apply-code-patch':
      // Planned from step 6 (gestures) and step 8 (code editor); rejected
      // visibly until then.
      return err('unsupported-operation');
    case 'replace-source':
      return planReplaceSource(base, intent.anchor, operation.text);
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unknown operation ${JSON.stringify(exhaustive)}`);
    }
  }
}

// The control flow of one set-attribute plan: every rejection is decided here
// and in planAtMappedRegion; the helpers below compute and do not branch on
// outcomes. Rejections that need no diff come first, so they cost none.
function planSetAttribute(
  base: PlanningBase,
  anchor: AnchorRef,
  operation: SetAttribute,
  mapSpan: SpanMapper,
): Result<Plan, RejectionReason> {
  const authored = base.authored.projection;
  if (base.current.projection.tag === 'parse-error') {
    return err('source-invalid'); // Fix it in code first, stale or not.
  }
  if (authored.tag === 'parse-error') {
    return err('source-invalid'); // No node was ever there to anchor.
  }
  const authoredNode = authoredAnchorNode(authored, anchor);
  if (authoredNode === undefined) {
    return err('anchor-moved');
  }
  if (!capabilityAcceptsVisualIntent(authoredNode.capability)) {
    return err('unsupported-operation');
  }
  const authoredValue = soleAttribute(authoredNode, operation.name);
  if (!authoredValue.ok) {
    return authoredValue;
  }
  if (operation.value.type !== 'string') {
    return err('unsupported-operation'); // Expressions and bare values arrive at step 6.
  }
  const authoredRegion = identityRegion(base.authored.bytes, authoredNode);
  assert(authoredRegion !== undefined, 'A node with the attribute has an identity region');
  assert(authoredRegion.start <= authoredValue.value.start, 'The region holds the value');
  assert(authoredValue.value.end <= authoredRegion.end, 'The region holds the whole value');
  const mapped = mapSpan(authoredRegion);
  switch (mapped.tag) {
    case 'resolved':
      // The consumer side of the mapper's postcondition: a region moves whole.
      assert(
        mapped.span.end - mapped.span.start === authoredRegion.end - authoredRegion.start,
        'A resolved region keeps its length',
      );
      return planAtMappedRegion(base, anchor, operation.name, operation.value.value, {
        authoredRegion,
        currentRegion: mapped.span,
        authoredValue: authoredValue.value,
      });
    case 'ambiguous':
      return err('anchor-ambiguous');
    case 'gone':
      return err('anchor-moved');
    case 'too-costly':
      return err('resource-limit');
    default: {
      const exhaustive: never = mapped;
      return exhaustive;
    }
  }
}

// The migration-only whole-file replacement (plan §3.3), which the legacy save
// path submits from step 5 so the actor is the only writer. It never maps: its
// witness is the authored checksum itself, so any change since it was authored
// is a rejection, and a whole-file replacement is written as one splice whose
// expected bytes are the whole authored file. The result may not parse — a raw
// page, a code-panel save, Markdown — so the candidate is not required to.
// Agrees exactly with the step-1 reference (test/simulator/reference-planner.ts).
function planReplaceSource(
  base: PlanningBase,
  anchor: AnchorRef,
  text: string,
): Result<Plan, RejectionReason> {
  assert(anchor.expectedKind === 'document', 'A replacement anchors the whole document');
  assert(anchor.span.start === 0, 'A document anchor starts at byte 0');
  if (base.current.checksum !== base.authored.checksum) {
    return err('region-externally-modified');
  }
  if (anchor.span.end !== base.current.bytes.length) {
    return err('anchor-moved'); // The anchor names bytes of another length.
  }
  const splice: Splice = {
    range: anchor.span,
    expectedBytes: base.current.bytes,
    replacementBytes: encodeUtf8(text),
  };
  assert(splice.replacementBytes.length <= LIMITS.intentPayloadBytesMax, 'Payload is bounded');
  return ok({ splices: [splice], postKinds: [], candidate: 'may-be-invalid' });
}

interface RegionMapping {
  readonly authoredRegion: ByteSpan;
  readonly currentRegion: ByteSpan;
  readonly authoredValue: ByteSpan;
}

// The mapped bytes are the authored name and attributes; the node found there
// must still parse as them — the context can change around unchanged bytes (a
// comment opened above turns the element into comment text).
function planAtMappedRegion(
  base: PlanningBase,
  anchor: AnchorRef,
  name: string,
  value: string,
  mapping: RegionMapping,
): Result<Plan, RejectionReason> {
  const current = base.current.projection;
  assert(current.tag === 'valid', 'Only a parsing current file reaches the mapped tag');
  const node = nodeStartingAt(current, mapping.currentRegion.start - 1, anchor.expectedKind);
  if (!node.ok) {
    return node;
  }
  // Bytes someone else wrote: a region that parses differently is a rejection.
  const currentRegion = identityRegion(base.current.bytes, node.value);
  if (currentRegion === undefined) {
    return err('anchor-moved');
  }
  if (!sameSpan(currentRegion, mapping.currentRegion)) {
    return err('anchor-moved');
  }
  if (!capabilityAcceptsVisualIntent(node.value.capability)) {
    return err('unsupported-operation'); // Moved into a loop, or given `set:html`.
  }
  const attribute = soleAttribute(node.value, name);
  if (!attribute.ok) {
    return attribute;
  }
  const shift = mapping.currentRegion.start - mapping.authoredRegion.start;
  const authoredValue = mapping.authoredValue;
  const expectedValue = toByteSpan(authoredValue.start + shift, authoredValue.end + shift);
  if (!sameSpan(attribute.value, expectedValue)) {
    return err('anchor-moved');
  }
  const splice = valueSplice(base.current.bytes, attribute.value, value);
  if (splice === undefined) {
    return err('unsupported-operation');
  }
  const authoredBytes = base.authored.bytes.subarray(authoredValue.start, authoredValue.end);
  const witness = toByteString(authoredBytes);
  assert(byteStringsEqual(splice.expectedBytes, witness), 'The witness is the authored value');
  const postKinds = [{ path: node.value.path, kind: node.value.kind }];
  return ok({ splices: [splice], postKinds, candidate: 'must-parse' });
}

/** The node the anchor names in the bytes it was authored against: the path,
 * the span and the kind must all agree, or the intent names nothing. */
function authoredAnchorNode(
  projection: ValidProjection,
  anchor: AnchorRef,
): ProjectedNode | undefined {
  assert(projection.nodes.length <= LIMITS.treeNodesMax, 'The projection is inside its bound');
  const node = projection.nodes.find((candidate) => samePath(candidate.path, anchor.path));
  if (node === undefined) {
    return undefined;
  }
  if (node.kind === anchor.expectedKind) {
    return sameSpan(node.span, anchor.span) ? node : undefined;
  }
  return undefined;
}

/** The value span of the one attribute named `name`, when it is a quoted
 * string. Duplicate names are ambiguous — which one the page uses is a guess;
 * a missing one needs insertion, which is step 6. */
function soleAttribute(node: ProjectedNode, name: string): Result<ByteSpan, RejectionReason> {
  assert(node.attributes.length <= LIMITS.attrsPerNodeMax, 'Attributes are inside their bound');
  const found = node.attributes.filter((attribute) => attribute.name === name);
  const [attribute] = found;
  if (attribute === undefined) {
    return err('unsupported-operation');
  }
  if (found.length > 1) {
    return err('anchor-ambiguous');
  }
  if (!attributeEditable(attribute)) {
    return err('unsupported-operation');
  }
  assert(attribute.valueSpan !== undefined, 'A string attribute has a value span');
  return ok(attribute.valueSpan);
}

function attributeEditable(attribute: ProjectedAttribute): boolean {
  if (attribute.type === 'string') {
    return capabilityAcceptsVisualIntent(attribute.capability);
  }
  return false;
}

function nodeStartingAt(
  projection: ValidProjection,
  start: number,
  kind: AnchorRef['expectedKind'],
): Result<ProjectedNode, RejectionReason> {
  const found = projection.nodes.filter((node) => {
    if (node.span.start === start) {
      return node.kind === kind;
    }
    return false;
  });
  const [node] = found;
  if (node === undefined) {
    return err('anchor-moved');
  }
  // A tag opens one element: two same-kind nodes cannot start on one byte.
  assert(found.length === 1, 'One node of a kind starts at a byte');
  return ok(node);
}

/** The tag name through the end of the last attribute, or undefined for a tag
 * without attributes. The node's first byte is the `<` that opens its tag. */
function identityRegion(bytes: ByteString, node: ProjectedNode): ByteSpan | undefined {
  assert(bytes[node.span.start] === TAG_OPEN, 'An attribute host opens with `<`');
  const attributesEnd = node.attributes.reduce<number>(
    (end, attribute) => Math.max(end, attribute.span.end),
    node.span.start,
  );
  assert(attributesEnd <= node.span.end, 'Attributes lie inside their node');
  if (attributesEnd > node.span.start + 1) {
    return toByteSpan(node.span.start + 1, attributesEnd);
  }
  return undefined;
}

// The value sits between quotes the splice keeps. A new value containing that
// quote would end the attribute early and re-parse as another tree; re-quoting
// is a step-6 gesture, so until then the edit is refused, visibly.
function valueSplice(bytes: ByteString, range: ByteSpan, value: string): Splice | undefined {
  const quote = bytes[range.start - 1];
  assert(quote !== undefined, 'A string value has an opening quote before it');
  assert(QUOTES.includes(quote), 'A string value sits in quotes');
  assert(bytes[range.end] === quote, 'A string value closes with its opening quote');
  if (value.includes(String.fromCharCode(quote))) {
    return undefined;
  }
  return {
    range,
    expectedBytes: toByteString(bytes.subarray(range.start, range.end)),
    replacementBytes: encodeUtf8(value),
  };
}

function sameSpan(left: ByteSpan, right: ByteSpan): boolean {
  if (left.start === right.start) {
    return left.end === right.end;
  }
  return false;
}

function samePath(left: StructuralPath, right: StructuralPath): boolean {
  if (left.length === right.length) {
    return left.every((step, index) => step === right[index]);
  }
  return false;
}
