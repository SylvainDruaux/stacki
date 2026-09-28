// Applying splices, the only write primitive (plan §3.4), in their step-1
// reference form. The expected bytes are the witness: a splice applies only
// where the range still holds exactly the bytes the plan saw. The Splice type
// is the planner's (shared/planner.ts, step 2); step 3 promotes applying into
// the engine, until then the simulator owns the one implementation.
import { assert } from '../../dist/shared/assert.js';
import { LIMITS } from '../../dist/shared/limits.js';
import type { Splice } from '../../dist/shared/planner.js';
import {
  byteStringsEqual,
  toByteSpan,
  toByteString,
  type ByteSpan,
  type ByteString,
} from '../../dist/shared/span.js';

export type { Splice };

/** Whether every splice's range holds its expected bytes (plan §5.2 step 4). */
export function witnessesHold(bytes: ByteString, splices: readonly Splice[]): boolean {
  assert(splices.length <= LIMITS.splicesPerIntentMax, 'Splice count is inside its bound');
  return splices.every((splice) => {
    if (splice.range.end <= bytes.length) {
      const found = toByteString(bytes.subarray(splice.range.start, splice.range.end));
      return byteStringsEqual(found, splice.expectedBytes);
    }
    return false;
  });
}

/** Splices sorted by start, checked disjoint. Overlapping splices would make the
 * result depend on application order — a planner bug, so it asserts. */
export function orderedSplices(splices: readonly Splice[]): readonly Splice[] {
  const ordered = [...splices].sort((left, right) => left.range.start - right.range.start);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    assert(previous !== undefined, 'Previous splice exists');
    assert(current !== undefined, 'Current splice exists');
    assert(previous.range.end <= current.range.start, 'Splices do not overlap');
  }
  return ordered;
}

/** Apply splices in memory (plan §5.2 step 5). Witnesses were verified by the
 * caller; they are asserted again here, the pair on the other side. */
export function applySplices(bytes: ByteString, splices: readonly Splice[]): ByteString {
  assert(witnessesHold(bytes, splices), 'Every witness holds at apply time');
  const ordered = orderedSplices(splices);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const splice of ordered) {
    parts.push(bytes.subarray(cursor, splice.range.start), splice.replacementBytes);
    cursor = splice.range.end;
  }
  parts.push(bytes.subarray(cursor));
  const size = parts.reduce((total, part) => total + part.length, 0);
  assert(size === bytes.length + sizeDelta(ordered), 'Result size is the sum of the splices');
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return toByteString(result);
}

/** Where each splice's replacement landed in the result, ascending. */
export function changedRanges(splices: readonly Splice[]): readonly ByteSpan[] {
  let delta = 0;
  return orderedSplices(splices).map((splice) => {
    const start = splice.range.start + delta;
    delta += splice.replacementBytes.length - splice.expectedBytes.length;
    return toByteSpan(start, start + splice.replacementBytes.length);
  });
}

function sizeDelta(splices: readonly Splice[]): number {
  return splices.reduce(
    (total, splice) => total + splice.replacementBytes.length - splice.expectedBytes.length,
    0,
  );
}
