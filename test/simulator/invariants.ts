// The simulator invariants (plan §10), checked from the outside. Each check
// recomputes what it needs from the recorded bytes and projections instead of
// trusting the actor's own conclusions — an invariant the actor asserts about
// itself is the producer side; these are the consumer side of the same pair.
//
//   1. Every accepted intent reaches one terminal result.     (checkOutcome, checkQuiescent)
//   2. Every applied splice matched its expected bytes.       (checkCommitted)
//   3. Bytes outside splice ranges are unchanged.             (checkCommitted)
//   4. No anchor resolves to the wrong node kind.             (checkCommitted)
//   5. Ambiguous anchors never apply.                         (checkCommitted)
//   6. A stale preview cannot submit a silently remapped edit.(checkCommitted,
//      and world.ts judges every remap against the recorded byte origins)
//   7. The actor never commits an older snapshot over a newer one. (checkGeneration)
//   8. Queue, parser, diff and snapshot bounds hold.          (checkBounds)
//   9. The same seed produces the same results.               (the suite runs seeds twice)
import { assert } from '../../dist/shared/assert.js';
import type { Intent, Outcome } from '../../dist/shared/intent.js';
import { LIMITS } from '../../dist/shared/limits.js';
import { isNodeKind } from '../../dist/shared/ref.js';
import type { ActorEffect, ActorState } from '../../dist/shared/documentActor.js';
import { orderedSplices } from '../../dist/shared/splice.js';

type Committed = Extract<ActorEffect, { tag: 'committed' }>;

export function checkOutcome(
  outcome: Outcome,
  accepted: ReadonlyMap<string, Intent>,
  terminal: ReadonlyMap<string, Outcome>,
): void {
  assert(accepted.has(outcome.intentId), 'Invariant 1: only accepted intents reach an outcome');
  assert(!terminal.has(outcome.intentId), 'Invariant 1: an intent reaches exactly one outcome');
}

export function checkQuiescent(
  accepted: ReadonlyMap<string, Intent>,
  terminal: ReadonlyMap<string, Outcome>,
): void {
  for (const id of accepted.keys()) {
    assert(terminal.has(id), `Invariant 1: accepted intent ${id} reached a terminal outcome`);
  }
  assert(terminal.size === accepted.size, 'Invariant 1: no outcome without an accepted intent');
}

export function checkCommitted(effect: Committed): void {
  const before = effect.base.bytes;
  const after = effect.candidate.bytes;
  const splices = orderedSplices(effect.plan.splices);
  assert(splices.length <= LIMITS.splicesPerIntentMax, 'Invariant 8: splice count is bounded');
  let cursorBefore = 0;
  let cursorAfter = 0;
  for (const splice of splices) {
    const found = before.subarray(splice.range.start, splice.range.end);
    assert(equalBytes(found, splice.expectedBytes), 'Invariant 2: the splice matched its witness');
    const gap = splice.range.start - cursorBefore;
    assert(
      equalBytes(before.subarray(cursorBefore, splice.range.start), after.subarray(cursorAfter, cursorAfter + gap)),
      'Invariant 3: bytes before a splice are unchanged',
    );
    cursorAfter += gap;
    const replaced = after.subarray(cursorAfter, cursorAfter + splice.replacementBytes.length);
    assert(equalBytes(replaced, splice.replacementBytes), 'The replacement landed where planned');
    cursorAfter += splice.replacementBytes.length;
    cursorBefore = splice.range.end;
  }
  assert(equalBytes(before.subarray(cursorBefore), after.subarray(cursorAfter)), 'Invariant 3: the tail is unchanged');
  checkTarget(effect);
  // Invariant 6, the part checkable here: only set-attribute is mapped at step
  // 3, so any other intent applied to bytes it was not authored against is a
  // silent remap. A mapped set-attribute is judged in world.ts, against where
  // the authored bytes really went — not against the planner's own claim.
  if (effect.intent.authoredChecksum !== effect.base.checksum) {
    assert(effect.intent.operation.tag === 'set-attribute', 'Invariant 6: no silent remap');
  }
  checkGeneration(effect.previousGeneration, effect.generation);
}

// Invariants 4 and 5, from the projections alone: the anchored node had the
// expected kind before and after, and an attribute edit named one attribute.
// The target in the base is found from the splice, not from the anchor path: a
// remapped intent's authored path can name another node in the base.
function checkTarget(effect: Committed): void {
  const anchor = effect.intent.anchor;
  if (!isNodeKind(anchor.expectedKind)) {
    return;
  }
  const before = effect.base.projection;
  const after = effect.candidate.projection;
  assert(before.tag === 'valid', 'A node intent applied to a parsing file');
  assert(after.tag === 'valid', 'A node intent produced a parsing file');
  const path = targetPath(effect);
  const same = (candidate: readonly number[]) =>
    candidate.length === path.length && candidate.every((step, index) => step === path[index]);
  const target = before.nodes.find((node) => same(node.path));
  const result = after.nodes.find((node) => same(node.path));
  assert(target?.kind === anchor.expectedKind, 'Invariant 4: the anchor held the expected kind');
  assert(result?.kind === anchor.expectedKind, 'Invariant 4: the target kept its kind');
  const operation = effect.intent.operation;
  if (operation.tag === 'set-attribute') {
    const named = target.attributes.filter((attribute) => attribute.name === operation.name);
    assert(named.length === 1, 'Invariant 5: an ambiguous attribute never applies');
  }
}

// The anchor path for an unmapped intent; for a set-attribute, the path of the
// base node whose attribute value the splice replaces — which, unmapped, must
// be the anchor's own node.
function targetPath(effect: Committed): readonly number[] {
  const operation = effect.intent.operation;
  const anchorPath = effect.intent.anchor.path;
  if (operation.tag !== 'set-attribute') {
    return anchorPath;
  }
  const before = effect.base.projection;
  assert(before.tag === 'valid', 'A set-attribute applied to a parsing file');
  const [splice] = effect.plan.splices;
  assert(splice !== undefined, 'A set-attribute plan has a splice');
  const owner = before.nodes.find((node) =>
    node.attributes.some((attribute) => attribute.valueSpan?.start === splice.range.start),
  );
  assert(owner !== undefined, 'The splice replaces an attribute value of a base node');
  if (effect.intent.authoredChecksum === effect.base.checksum) {
    const unmoved = owner.path.length === anchorPath.length;
    assert(unmoved, 'Invariant 6: an unmapped intent edits its own node');
    assert(
      owner.path.every((step, index) => step === anchorPath[index]),
      'Invariant 6: an unmapped intent edits its own node',
    );
  }
  return owner.path;
}

export function checkGeneration(previous: number, next: number): void {
  assert(next >= previous, 'Invariant 7: a snapshot never goes back to an older generation');
}

export function checkBounds(actors: Iterable<ActorState>, parses: number): void {
  assert(parses <= LIMITS.parseTasksInFlightMax, 'Invariant 8: parses per step are bounded');
  for (const actor of actors) {
    assert(actor.queue.length <= LIMITS.intentsPendingMax, 'Invariant 8: the queue is bounded');
    const retained = (actor.snapshot === undefined ? 0 : 1) + (actor.phase.tag === 'idle' ? 0 : 1);
    assert(retained <= LIMITS.snapshotsRetainedMax, 'Invariant 8: retained snapshots are bounded');
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length === right.length) {
    return left.every((byte, index) => byte === right[index]);
  }
  return false;
}
