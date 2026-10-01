// A hand-rolled seeded PRNG (plan §10): xoshiro128** seeded through splitmix32.
// No dependency (no fast-check) and no Math.random — the same seed yields the
// same stream on every machine, which is what makes invariant 9 structural.
// Only 32-bit integer arithmetic (Math.imul, >>> 0), so no float rounding can
// make two platforms diverge.
import { assert } from '#dist/shared/assert.js';

/** Rejection sampling draws again at most this often; each draw is rejected
 * with probability below 1/2, so hitting the cap means a broken generator. */
const DRAWS_MAX = 64;

export class Prng {
  private readonly state: Uint32Array;

  constructor(seed: number) {
    assert(Number.isSafeInteger(seed), 'Seed is a safe integer');
    assert(seed >= 0, 'Seed is nonnegative');
    this.state = new Uint32Array(4);
    let mix = seed >>> 0;
    for (let index = 0; index < 4; index++) {
      mix = (mix + 0x9e3779b9) >>> 0;
      let z = mix;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      this.state[index] = (z ^ (z >>> 16)) >>> 0;
    }
    // xoshiro's one forbidden state is all zeros; splitmix never produces it.
    assert(
      this.state.some((word) => word !== 0),
      'Seeded state is not all zeros',
    );
  }

  nextUint32(): number {
    const state = this.state;
    const [word0 = 0, word1 = 0, word2 = 0, word3 = 0] = state;
    const result = Math.imul(rotl(Math.imul(word1, 5) >>> 0, 7), 9) >>> 0;
    const shifted = (word1 << 9) >>> 0;
    state[2] = word2 ^ word0;
    state[3] = word3 ^ word1;
    state[1] = word1 ^ (state[2] ?? 0);
    state[0] = word0 ^ (state[3] ?? 0);
    state[2] = (state[2] ?? 0) ^ shifted;
    state[3] = rotl(state[3] ?? 0, 11);
    return result;
  }

  /** A uniform integer in `[0, bound)`, without modulo bias. */
  below(bound: number): number {
    assert(Number.isSafeInteger(bound), 'Bound is a safe integer');
    assert(bound > 0, 'Bound is positive');
    assert(bound <= 0x1_0000_0000, 'Bound fits in 32 bits');
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
    for (let draw = 0; draw < DRAWS_MAX; draw++) {
      const value = this.nextUint32();
      if (value < limit) {
        return value % bound;
      }
    }
    throw new Error(`Assertion failed: rejection sampling exceeded ${DRAWS_MAX} draws`);
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.below(items.length)];
    assert(item !== undefined, 'Picked index lies inside the list');
    return item;
  }

  /** True with probability numerator / denominator. */
  chance(numerator: number, denominator: number): boolean {
    assert(numerator >= 0, 'Probability numerator is nonnegative');
    assert(numerator <= denominator, 'Probability is at most one');
    return this.below(denominator) < numerator;
  }
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}
