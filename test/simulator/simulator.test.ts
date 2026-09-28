// Goal: the step-1 simulator skeleton runs seeded scenarios over the hostile
// corpus and a slice of the round-trip corpus, every invariant holds after every
// event, and a seed reproduces its run exactly (plan §10, invariant 9).
// Method: this file is the only one under test/simulator/ that touches the
// filesystem — it loads fixture texts and hands them to runSimulation, which
// is pure. Each gate seed runs twice and the trace digests must match; the
// seeds together must reach every outcome class the skeleton can produce, so a
// thin run fails instead of passing quietly. Nightly: STACKI_SIMULATOR_SEEDS
// raises the seed count (up to SEEDS_MAX) without changing the gate.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Prng } from './prng.ts';
import { runSimulation, type SimulationFile, type SimulationReport } from './world.ts';

const HOSTILE = path.resolve('test/fixtures/editor-core');
const CORPUS = path.resolve('test/corpus');
const CORPUS_SLICE = [
  'map-loop.astro',
  'nested-components.astro',
  'spread-props.astro',
  'slots-named.astro',
  'style-and-script.astro',
  'why-a-loop-exists.astro',
] as const;
const GATE_SEEDS = 24;
const SEEDS_MAX = 100_000;
const STEPS = 400;

function load(): { files: readonly SimulationFile[]; alternates: Map<string, readonly string[]> } {
  const read = (directory: string, name: string) => fs.readFileSync(path.join(directory, name), 'utf8');
  const inputs = fs.readdirSync(HOSTILE).filter((name) => !name.includes('.expected.')).sort();
  const files = [
    ...inputs.map((name) => ({ name, text: read(HOSTILE, name) })),
    ...CORPUS_SLICE.map((name) => ({ name, text: read(CORPUS, name) })),
  ];
  const alternates = new Map<string, readonly string[]>();
  for (const name of inputs) {
    const expected = name.replace(/\.(\w+)$/, '.expected.$1');
    if (fs.existsSync(path.join(HOSTILE, expected))) {
      alternates.set(name, [read(HOSTILE, name), read(HOSTILE, expected)]);
    }
  }
  alternates.set('malformed.astro', [read(HOSTILE, 'malformed.astro'), '<div>\n  <span>closed</span>\n</div>\n']);
  return { files, alternates };
}

function seedCount(): number {
  const raw = process.env['STACKI_SIMULATOR_SEEDS'];
  if (raw === undefined) {
    return GATE_SEEDS;
  }
  const seeds = Number(raw);
  assert.ok(Number.isSafeInteger(seeds), 'STACKI_SIMULATOR_SEEDS is an integer');
  assert.ok(seeds > 0, 'STACKI_SIMULATOR_SEEDS is positive');
  assert.ok(seeds <= SEEDS_MAX, `STACKI_SIMULATOR_SEEDS is at most ${SEEDS_MAX}`);
  return seeds;
}

const fixtures = load();
const run = (seed: number): SimulationReport => runSimulation({ seed, steps: STEPS, ...fixtures });

test('the PRNG is pinned: the same seed yields the same stream on every machine', () => {
  const stream = (seed: number) => {
    const prng = new Prng(seed);
    return Array.from({ length: 4 }, () => prng.nextUint32());
  };
  assert.deepEqual(stream(1), stream(1));
  assert.notDeepEqual(stream(1), stream(2));
  assert.deepEqual(stream(1), [PINNED_SEED_1[0], PINNED_SEED_1[1], PINNED_SEED_1[2], PINNED_SEED_1[3]]);
  const prng = new Prng(7);
  const buckets = [0, 0, 0, 0];
  for (let draw = 0; draw < 4_000; draw++) {
    const bucket = prng.below(4);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  for (const size of buckets) {
    assert.ok(size > 850 && size < 1_150, `below(4) is roughly uniform: ${buckets.join(', ')}`);
  }
  assert.throws(() => prng.below(0), /Bound is positive/);
  assert.throws(() => new Prng(-1), /Seed is nonnegative/);
});

test('every seeded run holds the invariants and reproduces per seed (invariant 9)', () => {
  const tally: Record<string, number> = {};
  const digests = new Set<string>();
  for (let seed = 1; seed <= seedCount(); seed++) {
    const first = run(seed);
    const second = run(seed);
    assert.equal(second.digest, first.digest, `seed ${seed} reproduces`);
    assert.deepEqual(second.trace, first.trace);
    digests.add(first.digest);
    for (const [key, value] of Object.entries(first.tally)) {
      tally[key] = (tally[key] ?? 0) + value;
    }
  }
  assert.equal(digests.size, seedCount(), 'different seeds drive different runs');
  // Corpus diversity is a gate (tracker step 1): the seeds must reach every
  // outcome class the skeleton can produce, or the run proves little.
  for (const reached of REQUIRED_TALLIES) {
    assert.ok((tally[reached] ?? 0) > 0, `the gate seeds reach ${reached}: ${JSON.stringify(tally)}`);
  }
});

const REQUIRED_TALLIES = [
  'outcome:applied',
  'outcome:rejected anchor-moved',
  'outcome:rejected anchor-ambiguous',
  'outcome:rejected region-externally-modified',
  'outcome:rejected source-invalid',
  'outcome:rejected unsupported-operation',
  'outcome:rejected write-failed',
  'outcome:rejected write-race',
  'outcome:uncertain',
  'submit:backpressured',
  'gesture:completed',
  'gesture:cancelled',
] as const;

const PINNED_SEED_1 = [2442144158, 3238099751, 3819917871, 2104621829] as const;
