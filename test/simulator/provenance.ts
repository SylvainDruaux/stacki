// Byte provenance: the ground truth a remapped intent is judged against (step
// 3). Every byte a simulated writer puts on the fake disk carries an origin
// number, and a byte a writer keeps keeps its origin. The simulator knows what
// each writer did — it did it — so "where did the authored element go?" has an
// exact answer that owes nothing to the diff: follow the origins. The mapper
// never sees them; the judge (remap-judge.ts) compares its answer with theirs.
//
// Origins are unique within one version of a file: fresh ones come from one
// counter per run, and every writer below keeps an existing origin at most once.
import { assert } from '../../dist/shared/assert.js';
import type { Splice } from '../../dist/shared/planner.js';
import { toByteSpan, type ByteSpan, type ByteString } from '../../dist/shared/span.js';
import { orderedSplices } from './splice.ts';

/** One origin per byte of one version of a file. */
export type Origins = readonly number[];

const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

/** Hands out origins no byte has had before. */
export class OriginSource {
  private next = 0;

  fresh(count: number): Origins {
    assert(Number.isSafeInteger(count), 'Origin count is an integer');
    assert(count >= 0, 'Origin count is nonnegative');
    const first = this.next;
    this.next += count;
    assert(Number.isSafeInteger(this.next), 'Origins stay safe integers');
    return Array.from({ length: count }, (_, index) => first + index);
  }
}

/** A writer inserted `count` new bytes at `at` and kept everything else. */
export function insertOrigins(origins: Origins, at: number, inserted: Origins): Origins {
  assert(at <= origins.length, 'An insertion point lies inside the file');
  return [...origins.slice(0, at), ...inserted, ...origins.slice(at)];
}

/** The actor applied `splices`. Bytes outside them keep their origins; inside,
 * the bytes a replacement shares with its witness at either end keep theirs —
 * a code save that appends to the file keeps the file — and the rest are new. */
export function spliceOrigins(
  origins: Origins,
  splices: readonly Splice[],
  source: OriginSource,
): Origins {
  const result: number[] = [];
  let cursor = 0;
  for (const splice of orderedSplices(splices)) {
    result.push(...origins.slice(cursor, splice.range.start));
    const kept = origins.slice(splice.range.start, splice.range.end);
    const expected = splice.expectedBytes;
    const replacement = splice.replacementBytes;
    const prefix = commonPrefix(expected, replacement);
    const suffix = commonSuffix(expected, replacement, prefix);
    const middle = replacement.length - prefix - suffix;
    result.push(...kept.slice(0, prefix), ...source.fresh(middle));
    result.push(...kept.slice(kept.length - suffix));
    cursor = splice.range.end;
  }
  result.push(...origins.slice(cursor));
  return result;
}

/** A formatter flipped every line ending: CRLF to LF drops each CR, LF to
 * CRLF adds a new CR before each LF. The LF bytes keep their origins. */
export function lineEndingOrigins(
  bytes: ByteString,
  origins: Origins,
  direction: 'to-lf' | 'to-crlf',
  source: OriginSource,
): Origins {
  assert(bytes.length === origins.length, 'Origins describe these bytes');
  const result: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    const origin = origins[index];
    assert(origin !== undefined, 'Every byte has an origin');
    const byte = bytes[index];
    if (direction === 'to-lf') {
      if (byte === CARRIAGE_RETURN) {
        if (bytes[index + 1] === LINE_FEED) {
          continue;
        }
      }
    } else if (byte === LINE_FEED) {
      result.push(...source.fresh(1));
    }
    result.push(origin);
  }
  return result;
}

/** Where `span` of the authored version sits in the current one, when every
 * one of its bytes survived, in order and contiguous; undefined otherwise. */
export function survivingSpan(
  authored: Origins,
  span: ByteSpan,
  current: Origins,
): ByteSpan | undefined {
  assert(span.start < span.end, 'Only non-empty spans are followed');
  assert(span.end <= authored.length, 'The span lies inside the authored version');
  const first = authored[span.start];
  assert(first !== undefined, 'The span has a first byte');
  const start = current.indexOf(first);
  if (start < 0) {
    return undefined;
  }
  const length = span.end - span.start;
  for (let offset = 1; offset < length; offset++) {
    if (current[start + offset] !== authored[span.start + offset]) {
      return undefined;
    }
  }
  return toByteSpan(start, start + length);
}

function commonPrefix(left: ByteString, right: ByteString): number {
  const bound = Math.min(left.length, right.length);
  let length = 0;
  while (length < bound) {
    if (left[length] !== right[length]) {
      break;
    }
    length += 1;
  }
  return length;
}

function commonSuffix(left: ByteString, right: ByteString, prefix: number): number {
  const bound = Math.min(left.length, right.length) - prefix;
  let length = 0;
  while (length < bound) {
    if (left[left.length - 1 - length] !== right[right.length - 1 - length]) {
      break;
    }
    length += 1;
  }
  return length;
}
