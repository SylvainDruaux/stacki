// Goal: pin every SaveState transition (plan §7), the refused ones included.
// Method: bundle src/saveState.ts and apply each transition to each state. A
// transition a state does not accept is a programmer error, so those cases
// assert and the test pins the message; the accepted ones pin the result.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const buildDirectory = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'save-state');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'saveState.ts')],
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const save = require(path.join(buildDirectory, 'saveState.js'));

const base = 'a'.repeat(64);
const disk = 'b'.repeat(64);
const written = 'c'.repeat(64);
const states = {
  clean: { tag: 'clean', checksum: base },
  dirty: { tag: 'dirty', baseChecksum: base },
  saving: { tag: 'saving', baseChecksum: base },
  conflicted: { tag: 'conflicted', baseChecksum: base, diskChecksum: disk },
};

test('reading or writing a file yields a clean state naming its bytes', () => {
  assert.deepEqual(save.saveStateClean(written), { tag: 'clean', checksum: written });
});

test('an edit applies in every state; only its path to disk differs', () => {
  assert.deepEqual(save.saveStateEdited(states.clean), states.dirty);
  assert.equal(save.saveStateEdited(states.dirty), states.dirty);
  // The write in flight does not carry this edit, so another must follow.
  assert.deepEqual(save.saveStateEdited(states.saving), states.dirty);
  // A conflicted page keeps its edits locally and keeps autosave off.
  assert.equal(save.saveStateEdited(states.conflicted), states.conflicted);
});

test('only a dirty state starts a save', () => {
  assert.deepEqual(save.saveStateStarted(states.dirty), states.saving);
  for (const tag of ['clean', 'saving', 'conflicted']) {
    assert.throws(
      () => save.saveStateStarted(states[tag]),
      new RegExp(`Assertion failed: Only a dirty page starts a save, not ${tag}`),
    );
  }
});

test('a failed save returns the edit to dirty against the same base', () => {
  assert.deepEqual(save.saveStateFailed(states.saving), states.dirty);
  for (const tag of ['clean', 'dirty', 'conflicted']) {
    assert.throws(
      () => save.saveStateFailed(states[tag]),
      new RegExp(`Only a saving page can fail a save, not ${tag}`),
    );
  }
});

test('a refusal records the base compared and the bytes found on disk', () => {
  const conflicted = { tag: 'conflicted', baseChecksum: written, diskChecksum: disk };
  for (const tag of ['dirty', 'saving', 'conflicted']) {
    assert.deepEqual(save.saveStateRefused(states[tag], written, disk), conflicted);
  }
  assert.throws(
    () => save.saveStateRefused(states.clean, base, disk),
    /A clean page has nothing to refuse/,
  );
  assert.throws(
    () => save.saveStateRefused(states.dirty, disk, disk),
    /A refusal names bytes other than the base/,
  );
});

test('keeping the local version after review rebases it on the disk bytes', () => {
  assert.deepEqual(save.saveStateAccepted(states.conflicted), {
    tag: 'dirty',
    baseChecksum: disk,
  });
  for (const tag of ['clean', 'dirty', 'saving']) {
    assert.throws(
      () => save.saveStateAccepted(states[tag]),
      new RegExp(`Only a conflicted page can be accepted, not ${tag}`),
    );
  }
});

test('autosave writes only a dirty state', () => {
  assert.deepEqual(
    Object.keys(states).filter((tag) => save.saveStateNeedsWrite(states[tag])),
    ['dirty'],
  );
});

test('every state names the checksum it is relative to', () => {
  for (const tag of Object.keys(states)) {
    assert.equal(save.saveStateBase(states[tag]), base);
  }
});
