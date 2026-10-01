#!/usr/bin/env node
// Compare the preview diff against a Git checkpoint without changing checkout.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs = require('node:fs');
import path = require('node:path');
import { performance } from 'node:perf_hooks';

interface DiffImplementation {
  readonly diff: (before: readonly string[], after: readonly string[]) => unknown;
  readonly allocation: () => number;
  readonly reset: () => void;
}

const root = path.join(__dirname, '..', '..');
const sourcePath = 'electron/previewClient/morphClient.ts';

function load(source: string): DiffImplementation {
  let allocatedBytes = 0;
  const startIndex = source.indexOf('function diffChildren(');
  const endIndex = source.indexOf('// Raised when the live document', startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error('Cannot locate the preview diff in this revision.');
  }
  function TrackedArray(size: number): Int32Array {
    allocatedBytes += size * Int32Array.BYTES_PER_ELEMENT;
    return new Int32Array(size);
  }
  const factoryInput: unknown = Reflect.construct(Function, [
    'Int32Array',
    `${source.slice(startIndex, endIndex)}\nreturn diffChildren;`,
  ]);
  if (typeof factoryInput !== 'function') {
    throw new Error('Preview diff source did not produce a factory');
  }
  const candidate: unknown = Reflect.apply(factoryInput, undefined, [TrackedArray]);
  if (typeof candidate !== 'function') {
    throw new Error('Preview diff source did not produce a function');
  }
  return {
    diff: (before, after) => {
      const result: unknown = Reflect.apply(candidate, undefined, [before, after]);
      return result;
    },
    allocation: () => allocatedBytes,
    reset: () => {
      allocatedBytes = 0;
    },
  };
}

function measure(
  implementation: DiffImplementation,
  before: readonly string[],
  after: readonly string[],
): { readonly ms: string; readonly matrixBytes: number } {
  implementation.diff(before, after);
  implementation.reset();
  const runs = 5;
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) {
    implementation.diff(before, after);
  }
  return {
    ms: ((performance.now() - started) / runs).toFixed(3),
    matrixBytes: implementation.allocation() / runs,
  };
}

const current = load(fs.readFileSync(path.join(root, 'dist', sourcePath), 'utf8'));
const reference = process.argv[2];
const before = reference
  ? load(
      execFileSync('git', ['show', `${reference}:${sourcePath}`], {
        cwd: root,
        encoding: 'utf8',
      }),
    )
  : undefined;
const keys = Array.from({ length: 2_000 }, (_, index) => `node:${index}`);
const cases: ReadonlyArray<
  readonly [label: string, oldKeys: readonly string[], newKeys: readonly string[]]
> = [
  ['Unchanged siblings', keys, keys],
  ['Append one sibling', keys, [...keys, 'new']],
  ['Remove last sibling', keys, keys.slice(0, -1)],
  [
    'Swap first two siblings',
    keys.slice(0, 200),
    [keys[1] ?? '', keys[0] ?? '', ...keys.slice(2, 200)],
  ],
];

console.log('Preview sibling diff; mean of 5 warm runs. Matrix bytes exclude inputs.');
for (const [label, oldKeys, newKeys] of cases) {
  if (before) {
    assert.deepEqual(
      current.diff(oldKeys, newKeys),
      before.diff(oldKeys, newKeys),
      `${label} preserves exact edit operations`,
    );
  }
  console.log(
    JSON.stringify({
      case: label,
      siblings: oldKeys.length,
      ...(before ? { before: measure(before, oldKeys, newKeys) } : {}),
      after: measure(current, oldKeys, newKeys),
    }),
  );
}
