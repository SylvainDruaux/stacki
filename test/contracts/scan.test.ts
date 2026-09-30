// Goal: shared/scan.ts validates the 'project:scan' payload — the project's
// inventory as the renderer sees it. Every panel indexes into this; a bad
// entry poisons selection, routing, and the palette.
//
// Methodology: a full scan passes; each known-bad entry shape fails with a
// pinned message; array bounds from LIMITS are exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScanResult } from '../../dist/shared/scan.js';
import { LIMITS } from '../../dist/shared/limits.js';

const goodScan = {
  pages: [{ path: '/p/src/pages/index.astro', name: 'index.astro', route: '/' }],
  pageFolders: ['blog'],
  layouts: [
    {
      path: '/p/src/layouts/Base.astro',
      name: 'Base',
      folder: 'layouts',
      isLayout: true,
      instances: 3,
      schema: [{ name: 'title', type: 'string', optional: false }],
      extendsTag: 'div',
      slots: ['default'],
      slotText: false,
      renderTag: { tag: 'html' },
      hasRest: true,
    },
  ],
  components: [{ path: '/p/src/components/Hero.astro', name: 'Hero', folder: '', instances: 2 }],
  trailingSlash: 'ignore',
};

test('a full scan passes intact', () => {
  const parsed = parseScanResult(structuredClone(goodScan));
  assert.equal(parsed.pages[0]?.route, '/');
  assert.equal(parsed.layouts[0]?.schema?.[0]?.type, 'string');
  assert.equal(parsed.layouts[0]?.renderTag?.tag, 'html');
  assert.equal(parsed.layouts[0]?.hasRest, true);
  assert.equal(parsed.trailingSlash, 'ignore');
});

test('negative space: wrong entry shapes fail with pinned messages', () => {
  assert.throws(() => parseScanResult(null), /expected object/);
  assert.throws(() => parseScanResult({ ...goodScan, pages: {} }), /pages: expected array/);
  assert.throws(
    () => parseScanResult({ ...goodScan, pages: [{ path: '/x', name: 'x.astro' }] }),
    /route: expected string/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', isLayout: false }],
      }),
    /isLayout: only true is ever written/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', instances: 1.5 }],
      }),
    /instances: expected nonnegative integer/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', instances: -1 }],
      }),
    /instances: expected nonnegative integer/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', slots: [1] }],
      }),
    /slots: expected strings/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', schema: {} }],
      }),
    /schema: expected array of fields/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', schema: [{ type: 'string' }] }],
      }),
    /name: expected non-empty string/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', hasRest: 'yes' }],
      }),
    /hasRest: expected boolean/,
  );
});

test('bounds: entry counts fail at LIMITS', () => {
  const page = goodScan.pages[0];
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        pages: Array.from({ length: LIMITS.scanEntriesMax + 1 }, () => page),
      }),
    /exceeds \d+ entries/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        pageFolders: Array.from({ length: LIMITS.scanFoldersMax + 1 }, () => 'f'),
      }),
    /exceeds \d+ entries/,
  );
});
