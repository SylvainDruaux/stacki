// Goal: a document lock file is written by another process, so its owner is
// parsed like any foreign input — a well-formed owner is read back exactly, and
// every malformed, oversized or missing file reads as no owner at all.
// Methodology: write lock files into a temporary directory — a known-good owner,
// then each known-bad shape (not JSON, not an object, a mistyped or missing
// field, an unsafe pid, a file one byte past the bound) — and read each with the
// built electron/documentDisk.ts.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { LOCK_OWNER_CHARS_MAX, readLockOwner } from '#dist/electron/documentDisk.js';

function lockFile(context: { after: (fn: () => void) => void }, contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-lock-owner-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'page.lock');
  fs.writeFileSync(file, contents);
  return file;
}

test('a well-formed lock owner reads back exactly', (context) => {
  const owner = { pid: 4242, host: 'studio.local', token: 'a1b2c3' };
  assert.deepEqual(readLockOwner(lockFile(context, JSON.stringify(owner))), owner);
});

test('a missing, malformed or oversized lock file has no owner', (context) => {
  const good = { pid: 1, host: 'h', token: 't' };
  const bad: readonly string[] = [
    '',
    'not json',
    '[]',
    'null',
    JSON.stringify({ ...good, pid: '1' }),
    JSON.stringify({ ...good, pid: 1.5 }),
    JSON.stringify({ ...good, pid: 2 ** 53 }),
    JSON.stringify({ ...good, host: 7 }),
    JSON.stringify({ pid: 1, host: 'h' }),
    JSON.stringify({ ...good, padding: 'x'.repeat(LOCK_OWNER_CHARS_MAX) }),
  ];
  for (const contents of bad) {
    assert.equal(readLockOwner(lockFile(context, contents)), undefined, contents.slice(0, 40));
  }
  assert.equal(readLockOwner(path.join(os.tmpdir(), 'stacki-no-such-lock.lock')), undefined);
});
