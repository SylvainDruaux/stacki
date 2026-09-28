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
//   6. A stale preview cannot submit a silently remapped edit.(checkCommitted)
//   7. The actor never commits an older snapshot over a newer one. (checkGeneration)
//   8. Queue, parser, diff and snapshot bounds hold.          (checkBounds)
//   9. The same seed produces the same results.               (the suite runs seeds twice)
import { assert } from '../../dist/shared/assert.js';
import type { Intent, Outcome } from '../../dist/shared/intent.js';
import { LIMITS } from '../../dist/shared/limits.js';
import { isNodeKind } from '../../dist/shared/ref.js';
import type { ActorEffect, ActorState } from './actor.ts';
import { orderedSplices } from './splice.ts';

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
  // Step 1 maps nothing, so an applied intent was authored against exactly the
  // bytes it changed. From step 2 a mapped intent records its mapping instead.
  assert(effect.intent.authoredChecksum === effect.base.checksum, 'Invariant 6: no silent remap');
  checkGeneration(effect.previousGeneration, effect.generation);
}

// Invariants 4 and 5, from the projections alone: the anchored node had the
// expected kind before and after, and an attribute edit named one attribute.
function checkTarget(effect: Committed): void {
  const anchor = effect.intent.anchor;
  if (!isNodeKind(anchor.expectedKind)) {
    return;
  }
  const before = effect.base.projection;
  const after = effect.candidate.projection;
  assert(before.tag === 'valid', 'A node intent applied to a parsing file');
  assert(after.tag === 'valid', 'A node intent produced a parsing file');
  const same = (path: readonly number[]) =>
    path.length === anchor.path.length && path.every((step, index) => step === anchor.path[index]);
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
