// Judging a stale set-attribute intent (step 3, the spike): the planner decided
// from the diff alone; this module decides again from the byte origins the
// simulator recorded (provenance.ts) and says whether the planner was right.
//
//   applied-correct    planned at the element the authored one became
//   wrong-site         planned at any other element — the one outcome the
//                      step-4 gate allows zero of
//   conservative       rejected by the mapping although the element and the
//                      value being edited both survived: a missed edit, never
//                      a wrong one (plan §14)
//   rejected-conflict  rejected; the element survived, but another writer
//                      rewrote the very value being edited, so applying would
//                      have overwritten that edit
//   rejected-gone      rejected; the element no longer exists
//   other              rejected for a reason that is not a mapping decision
//   unjudged           no ground truth: git replaced the whole file in between
//
// An element is identified by its own `<` byte: it survived when that byte's
// origin is still in the file and an element of the same kind starts there.
// Editing its attributes does not make it another element; a pasted copy is
// new bytes, so it is another element however alike the two look.
//
// The same case also holds the fast mapper to the brute-force reference on the
// scenario's real bytes (plan §10), and checks that the planner's decision is
// the one the mapping implies.
import { assert } from '../../dist/shared/assert.js';
import { DIFF_BUDGET } from '../../dist/shared/diff.js';
import type { Intent, RejectionReason } from '../../dist/shared/intent.js';
import { mapSpan, type SpanMapping } from '../../dist/shared/mapSpan.js';
import type { Plan } from '../../dist/shared/planner.js';
import type { Snapshot } from '../../dist/shared/snapshot.js';
import type { ProjectedNode, Projection } from '../../dist/shared/source-projection.js';
import { toByteSpan, type ByteSpan } from '../../dist/shared/span.js';
import { survivingSpan, type Origins } from './provenance.ts';
import { referenceMapSpan, referenceTables } from './reference-diff.ts';

export type RemapDecision =
  | { readonly tag: 'planned'; readonly plan: Plan }
  | { readonly tag: 'rejected'; readonly reason: RejectionReason };

export type RemapVerdict =
  | { readonly tag: 'applied-correct' }
  | { readonly tag: 'wrong-site'; readonly detail: string }
  | { readonly tag: 'conservative'; readonly reason: RejectionReason }
  | { readonly tag: 'rejected-conflict'; readonly reason: RejectionReason }
  | { readonly tag: 'rejected-gone'; readonly reason: RejectionReason }
  | { readonly tag: 'other'; readonly reason: RejectionReason }
  | { readonly tag: 'unjudged'; readonly decision: RemapDecision['tag'] };

export interface RemapCase {
  readonly intent: Intent;
  readonly authored: Snapshot;
  readonly current: Snapshot;
  /** Undefined when the run no longer holds them (bounded retention). */
  readonly authoredOrigins: Origins | undefined;
  readonly currentOrigins: Origins | undefined;
  /** A git-style replacement happened between the two versions. */
  readonly replacedWhole: boolean;
  readonly decision: RemapDecision;
}

/** The brute-force table this check builds at most: files up to about 1 KB. */
export const JUDGE_REFERENCE_CELLS_MAX = 1_000_000;

const MAPPING_REASONS: readonly RejectionReason[] = [
  'anchor-ambiguous',
  'anchor-moved',
  'resource-limit',
];

type ValidProjection = Extract<Projection, { tag: 'valid' }>;

export function judgeRemap(input: RemapCase): RemapVerdict {
  assert(input.authored.checksum !== input.current.checksum, 'Only stale intents are judged');
  const operation = input.intent.operation;
  assert(operation.tag === 'set-attribute', 'Only set-attribute is mapped at step 3');
  const decision = input.decision;
  const authored = input.authored.projection;
  const current = input.current.projection;
  if (authored.tag === 'parse-error') {
    return otherRejection(decision);
  }
  if (current.tag === 'parse-error') {
    return otherRejection(decision);
  }
  const node = anchoredNode(authored, input.intent);
  const named = node.attributes.filter((attribute) => attribute.name === operation.name);
  if (decision.tag === 'rejected') {
    if (!MAPPING_REASONS.includes(decision.reason)) {
      return { tag: 'other', reason: decision.reason };
    }
    if (named.length > 1) {
      return { tag: 'other', reason: decision.reason }; // Duplicate names, before any mapping.
    }
  }
  if (input.authoredOrigins === undefined) {
    return { tag: 'unjudged', decision: decision.tag };
  }
  if (input.currentOrigins === undefined || input.replacedWhole) {
    return { tag: 'unjudged', decision: decision.tag };
  }
  const survivor = survivingElement(node, input.authoredOrigins, current, input.currentOrigins);
  if (decision.tag === 'rejected') {
    const reason = decision.reason;
    if (survivor === undefined) {
      return { tag: 'rejected-gone', reason };
    }
    assert(named.length === 1, 'A mapping decision was reached for one named attribute');
    const [attribute] = named;
    assert(attribute !== undefined, 'The named attribute exists');
    const kept = survivingSpan(input.authoredOrigins, attribute.span, input.currentOrigins);
    const now = survivor.attributes.find((candidate) => candidate.name === operation.name);
    if (kept !== undefined && kept.start === now?.span.start) {
      return { tag: 'conservative', reason };
    }
    return { tag: 'rejected-conflict', reason };
  }
  const target = plannedTarget(current, operation.name, decision.plan);
  if (survivor === undefined) {
    return { tag: 'wrong-site', detail: `${describe(input, target)}; the element is gone` };
  }
  if (target.span.start === survivor.span.start) {
    return { tag: 'applied-correct' };
  }
  const detail = `${describe(input, target)}; the element is at ${survivor.span.start}`;
  return { tag: 'wrong-site', detail };
}

/** Fast mapper and brute-force reference agree on the planner's region, and
 * the planner's decision is the one the mapping implies. False when the files
 * are too large for the reference table. */
export function checkMappingReference(input: RemapCase): boolean {
  const operation = input.intent.operation;
  assert(operation.tag === 'set-attribute', 'Only set-attribute is mapped at step 3');
  const authored = input.authored.projection;
  if (authored.tag === 'parse-error') {
    return false;
  }
  if (input.current.projection.tag === 'parse-error') {
    return false; // Rejected before mapping: nothing to compare.
  }
  const node = anchoredNode(authored, input.intent);
  const region = identityRegion(node);
  if (region === undefined) {
    return false;
  }
  const cells = (input.authored.bytes.length + 1) * (input.current.bytes.length + 1);
  if (cells > JUDGE_REFERENCE_CELLS_MAX) {
    return false;
  }
  const fast = mapSpan(input.authored.bytes, input.current.bytes, region, DIFF_BUDGET);
  const tables = referenceTables(input.authored.bytes, input.current.bytes);
  const reference = referenceMapSpan(tables, region);
  assert(sameMapping(fast, reference), 'The fast mapper agrees with the brute-force reference');
  checkDecisionFollowsMapping(input.decision, fast, region, node, operation.name);
  return true;
}

function checkDecisionFollowsMapping(
  decision: RemapDecision,
  mapping: SpanMapping,
  region: ByteSpan,
  node: ProjectedNode,
  name: string,
): void {
  if (decision.tag === 'planned') {
    assert(mapping.tag === 'resolved', 'A stale plan follows a resolved mapping');
    const [splice] = decision.plan.splices;
    assert(splice !== undefined, 'A set-attribute plan has a splice');
    const value = node.attributes.find((attribute) => attribute.name === name)?.valueSpan;
    assert(value !== undefined, 'A planned attribute had a value when authored');
    const shift = mapping.span.start - region.start;
    assert(splice.range.start === value.start + shift, 'The splice sits at the mapped value');
    return;
  }
  const reason = decision.reason;
  if (mapping.tag === 'ambiguous') {
    assert(reason !== 'anchor-moved', 'An ambiguous mapping never reads as a move');
  }
  if (mapping.tag === 'too-costly') {
    assert(reason === 'resource-limit', 'An exhausted diff is a resource limit');
  }
}

/** The authored node the intent names: its own view's projection holds it. */
function anchoredNode(projection: ValidProjection, intent: Intent): ProjectedNode {
  const anchor = intent.anchor;
  const node = projection.nodes.find((candidate) => {
    if (candidate.path.length === anchor.path.length) {
      return candidate.path.every((step, index) => step === anchor.path[index]);
    }
    return false;
  });
  assert(node !== undefined, 'A visual intent names a node of its authored view');
  assert(node.span.start === anchor.span.start, 'The anchor span is the node span');
  assert(node.kind === anchor.expectedKind, 'The anchor kind is the node kind');
  return node;
}

/** The planner's identity region, rebuilt here from its definition (tag name
 * through the last attribute), so the planner's own helper is not the judge. */
function identityRegion(node: ProjectedNode): ByteSpan | undefined {
  const end = node.attributes.reduce<number>(
    (last, attribute) => Math.max(last, attribute.span.end),
    node.span.start,
  );
  return end > node.span.start + 1 ? toByteSpan(node.span.start + 1, end) : undefined;
}

// The element survived if its own `<` byte is still in the file and an element
// of the same kind still starts there: a `<` that became comment text is gone.
function survivingElement(
  node: ProjectedNode,
  authoredOrigins: Origins,
  current: ValidProjection,
  currentOrigins: Origins,
): ProjectedNode | undefined {
  const opening = survivingSpan(
    authoredOrigins,
    toByteSpan(node.span.start, node.span.start + 1),
    currentOrigins,
  );
  if (opening === undefined) {
    return undefined;
  }
  return current.nodes.find((candidate) => {
    if (candidate.span.start === opening.start) {
      return candidate.kind === node.kind;
    }
    return false;
  });
}

function plannedTarget(current: ValidProjection, name: string, plan: Plan): ProjectedNode {
  assert(plan.splices.length === 1, 'A set-attribute plan is one splice');
  const [splice] = plan.splices;
  assert(splice !== undefined, 'The splice exists');
  const target = current.nodes.find((node) =>
    node.attributes.some((attribute) => {
      if (attribute.name === name) {
        return attribute.valueSpan?.start === splice.range.start;
      }
      return false;
    }),
  );
  assert(target !== undefined, 'The splice lands on an attribute value of a current node');
  return target;
}

function otherRejection(decision: RemapDecision): RemapVerdict {
  assert(decision.tag === 'rejected', 'A file that does not parse plans no visual intent');
  return { tag: 'other', reason: decision.reason };
}

function sameMapping(left: SpanMapping, right: SpanMapping): boolean {
  if (left.tag === 'resolved') {
    if (right.tag === 'resolved') {
      return left.span.start === right.span.start;
    }
    return false;
  }
  return left.tag === right.tag;
}

function describe(input: RemapCase, target: ProjectedNode): string {
  return `${input.intent.id} on ${input.intent.file} planned at byte ${target.span.start}`;
}
