// Goal: the two baselines the step-4 revision needs, on the six named large
// fixtures, measured with no editor-core code at all. A measurement, not a test.
//   floor   — the plan §5.2 disk work alone: read + SHA-256, then
//             writeVerified (temp file, fsync, rename, directory flush, read-back). No engine
//             change can go below it on this machine.
//   legacy  — the page:write path shipped at step 4 (retired at step 10),
//             lower bound: serializePage(model), the base-checksum read,
//             writeVerified, then parsePage(locs) of the written text (main.ts
//             writePageText → parsePageSource, both gone since).
//             Chunk writes and the IPC transfer are left out.
// Method: 2 warm-ups then SAMPLES samples per fixture, nearest-rank p95, on a
// scratch copy. A legacy serialization that is not byte-identical, or that
// exceeds the source limit, is reported instead of timed.
// Run: npm run build:runtime && node test/simulator/baseline.bench.ts.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeVerified } from './verified-write.entry.ts';
import { parsePage, serializePage } from '../../dist/electron/astroParser.js';
import { LIMITS } from '../../dist/shared/limits.js';

const NAMES = ['nodes-25', 'nodes-50', 'nodes-100', 'bytes-25', 'bytes-50', 'bytes-100'] as const;
const SAMPLES = 30;
const WARMUP = 2;

main();

function main(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-baseline-'));
  const rows: string[] = [];
  try {
    for (const name of NAMES) {
      const file = path.join(directory, `${name}.astro`);
      fs.copyFileSync(path.resolve('test/fixtures/large', `${name}.astro`), file);
      rows.push(fixtureRow(name, file));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'}\n`);
  console.log('| Fixture | floor p50 | floor p95 | legacy p50 | legacy p95 | legacy round-trip |');
  console.log('|---|---|---|---|---|---|');
  console.log(rows.join('\n'));
}

function fixtureRow(name: string, file: string): string {
  const text = fs.readFileSync(file, 'utf8');
  const floor = samples(() => floorOnce(file, text));
  const model = editableModel(text);
  const serialized = serializePage(model);
  const size = Buffer.byteLength(serialized);
  const before = Buffer.byteLength(text);
  const identical = serialized === text ? 'identical' : `changed, ${before} → ${size} B`;
  const floorCells = [format(percentile(floor, 50)), format(percentile(floor, 95))];
  if (size > LIMITS.sourceBytesMax) {
    return `| ${[name, ...floorCells, '—', '—', `${identical}, over the limit`].join(' | ')} |`;
  }
  const legacy = samples(() => legacyOnce(file, model));
  const legacyCells = [format(percentile(legacy, 50)), format(percentile(legacy, 95))];
  return `| ${[name, ...floorCells, ...legacyCells, identical].join(' | ')} |`;
}

function editableModel(text: string): unknown {
  const parsed = parsePage(text, { locs: true });
  if (!parsed.editable) {
    throw new Error(`Assertion failed: a large fixture parses as editable: ${parsed.reason}`);
  }
  return parsed.model;
}

function floorOnce(file: string, text: string): number {
  const started = performance.now();
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const written = writeVerified(file, text);
  if (!written.ok) {
    throw new Error(`Assertion failed: the floor write succeeds: ${written.error.message}`);
  }
  return performance.now() - started;
}

function legacyOnce(file: string, model: unknown): number {
  const started = performance.now();
  const serialized = serializePage(model);
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const written = writeVerified(file, serialized);
  if (!written.ok) {
    throw new Error(`Assertion failed: the legacy write succeeds: ${written.error.message}`);
  }
  parsePage(serialized, { locs: true });
  return performance.now() - started;
}

function samples(measure: () => number): readonly number[] {
  const kept: number[] = [];
  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const elapsed = measure();
    if (index >= WARMUP) {
      kept.push(elapsed);
    }
  }
  return kept;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  const value = sorted[rank - 1];
  if (value === undefined) {
    throw new Error('Assertion failed: a percentile of a non-empty series');
  }
  return value;
}

function format(milliseconds: number): string {
  return milliseconds.toFixed(1);
}
