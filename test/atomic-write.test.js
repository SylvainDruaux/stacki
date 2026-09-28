// Goal: electron/atomicWrite.ts replaces a file all at once or not at all,
// never leaves its temporary file behind, keeps the target's mode, writes
// through symlinks, and reports another writer landing after it as a
// `write-race` instead of claiming success (plan §5.2, §11 step 0).
// Method: real files in a temporary directory; filesystem failures are
// injected by wrapping one `fs` function at a time, since the module calls the
// shared `fs` object.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  digestOf,
  isAtomicTemporary,
  readSourceSnapshot,
  writeFileAtomic,
} = require('../dist/electron/atomicWrite.js');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function directory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-atomic-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const leftovers = (root) => fs.readdirSync(root).filter((name) => isAtomicTemporary(name));

// Replace fs[name] for the duration of `run`, restoring it even on failure.
function withFailure(name, replacement, run) {
  const original = fs[name];
  fs[name] = (...argumentsList) => replacement(original, ...argumentsList);
  try {
    run();
  } finally {
    fs[name] = original;
  }
}

test('a write replaces the file, keeps its mode and returns the checksum', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'old\n');
    fs.chmodSync(file, 0o640);
    const result = writeFileAtomic(file, 'new é\n');
    assert.deepEqual(result, { ok: true, value: sha256(Buffer.from('new é\n', 'utf8')) });
    assert.equal(fs.readFileSync(file, 'utf8'), 'new é\n');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    }
    assert.deepEqual(leftovers(root), []);
  });
});

test('a missing target is created', () => {
  directory((root) => {
    const file = path.join(root, 'chunk.html');
    assert.equal(writeFileAtomic(file, '<p/>').ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '<p/>');
  });
});

test('a failed write leaves the target untouched and no temporary file', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    for (const name of ['writeFileSync', 'fsyncSync', 'renameSync']) {
      withFailure(
        name,
        () => {
          throw new Error(`Simulated ${name} failure`);
        },
        () => {
          const result = writeFileAtomic(file, 'replacement\n');
          assert.equal(result.ok, false, name);
          assert.equal(result.error.code, 'filesystem');
          assert.match(result.error.message, new RegExp(`Simulated ${name} failure`));
        },
      );
      assert.equal(fs.readFileSync(file, 'utf8'), 'authored\n', `${name} kept the old bytes`);
      assert.deepEqual(leftovers(root), [], `${name} removed its temporary file`);
    }
  });
});

test('a failed cleanup names the temporary file it could not remove', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    withFailure('renameSync', () => { throw new Error('no rename'); }, () => {
      withFailure('rmSync', () => { throw new Error('no remove'); }, () => {
        const result = writeFileAtomic(file, 'replacement\n');
        assert.equal(result.error.code, 'filesystem');
        assert.match(result.error.message, /or remove temporary file .*\.stacki-write-.*\.tmp/);
      });
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'authored\n');
  });
});

test('another writer landing right after the rename is a write-race', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    withFailure(
      'renameSync',
      (rename, from, to) => {
        rename(from, to);
        fs.writeFileSync(to, 'theirs\n');
      },
      () => {
        const result = writeFileAtomic(file, 'mine\n');
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'write-race');
      },
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'theirs\n');
  });
});

const posixOnly = { skip: process.platform === 'win32' };
test('a symlinked page is written through, and the link stays a link', posixOnly, () => {
  directory((root) => {
    const real = path.join(root, 'real.astro');
    const link = path.join(root, 'link.astro');
    fs.writeFileSync(real, 'old\n');
    fs.symlinkSync(real, link);
    assert.equal(writeFileAtomic(link, 'new\n').ok, true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(real, 'utf8'), 'new\n');
  });
});

test('snapshots keep a BOM in the text and reject invalid UTF-8', () => {
  directory((root) => {
    const file = path.join(root, 'page.md');
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Hi\r\n')]);
    fs.writeFileSync(file, bytes);
    const snapshot = readSourceSnapshot(file);
    assert.equal(snapshot.text, '﻿# Hi\r\n');
    assert.equal(snapshot.checksum, sha256(bytes));
    assert.equal(digestOf(snapshot.text), snapshot.checksum, 'the text re-encodes to the bytes');
    fs.writeFileSync(file, Buffer.from([0x23, 0x20, 0xc3, 0x28]));
    assert.throws(() => readSourceSnapshot(file), /page\.md is not valid UTF-8/);
  });
});

test('only the module’s own temporary names are treated as temporary', () => {
  assert.equal(isAtomicTemporary('/p/src/pages/.stacki-write-1b2c.tmp'), true);
  assert.equal(isAtomicTemporary('.stacki-write-1b2c.tmp'), true);
  assert.equal(isAtomicTemporary('.stacki-write-1b2c.astro'), false);
  assert.equal(isAtomicTemporary('page.tmp'), false);
  assert.equal(isAtomicTemporary('stacki-write-1.tmp'), false);
});
