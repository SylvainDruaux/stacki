// Goal: the page save contract (plan §11 step 0) holds end to end. Reads report
// the SHA-256 of the exact bytes; a write names the checksum it was authored
// against, and main refuses it — leaving the disk untouched — when the file no
// longer holds those bytes. Opening and saving a page unchanged reproduces
// every byte, byte-order mark and line endings included.
// Method: the wire parsers get one known-good and each known-bad shape; the
// real main-process handlers run in the windowless harness against temporary
// files, with outside edits made directly on disk between read and write.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from './main-harness.ts';
import { IPC_PAYLOADS, parseIpcPayload } from '../../dist/shared/ipc-payloads.js';
import {
  parsePageDiskRead,
  parsePageEditResult,
  parsePageWriteResult,
} from '../../dist/shared/page-save.js';
import { diffCodePatch } from '../../dist/shared/code-patch.js';
import { toDigest } from '../../dist/shared/brand.js';
import type { PageDiskRead } from '../../dist/shared/page-save.js';
import { toRecord } from '../../dist/shared/record.js';

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const FIXTURES = path.resolve('test/fixtures/round-trip');
const page = {
  source: '<h1>Hi</h1>\n',
  editable: true,
  model: {
    imports: [],
    frontmatterLead: '',
    extraFrontmatter: '',
    extraFrontmatterSpaced: false,
    frontmatterLayout: { extra: '', slots: [] },
    hadFrontmatter: false,
    trailingBlank: 0,
    nodes: [],
  },
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-save-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(path.join(root, 'user'));
  return {
    root,
    ...harness,
    dispose: () => {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Harness = ReturnType<typeof fixture>;

function temporaries(directory: string): readonly string[] {
  return fs.readdirSync(directory).filter((name) => name.startsWith('.stacki-write-'));
}

test('Digest accepts exactly 64 lowercase hex characters', () => {
  assert.equal(toDigest('a'.repeat(64)), 'a'.repeat(64));
  for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    assert.throws(() => toDigest(bad), /Digest: expected 64 lowercase hex characters/);
  }
});

test('write payloads require a well-formed base checksum', () => {
  const base = 'b'.repeat(64);
  const pagePath = '/p.astro';
  const model = parseIpcPayload('page:write', { pagePath, model: {}, baseChecksum: base });
  assert.equal(model.baseChecksum, base);
  const payload = { pagePath: '/p.astro', model: {} };
  assert.throws(() => parseIpcPayload('page:write', payload), /Expected digest string/);
  assert.throws(() => parseIpcPayload('page:write', { ...payload, baseChecksum: 42 }), /digest/);
  assert.throws(
    () => parseIpcPayload('page:write', { ...payload, baseChecksum: 'B'.repeat(64) }),
    /Digest: expected 64 lowercase hex characters/,
  );
});

test('the raw-source channel is retired: code saves are patches through page:edit', () => {
  // Step 8: `page:writeRaw` wrote the code editor's whole text; the code editor
  // now sends a byte diff through the page's actor, the one path for edits.
  assert.equal(Object.hasOwn(IPC_PAYLOADS, 'page:writeRaw'), false);
  assert.equal(Object.hasOwn(IPC_PAYLOADS, 'page:edit'), true);
});

/** Save `next` as the code editor does: the patch from the text it read. */
async function saveCode(harness: Harness, file: string, read: PageDiskRead, next: string) {
  const hunks = diffCodePatch(read.source, next);
  assert.ok(hunks.ok, 'the text is inside the bounds');
  const edit = { tag: 'code-patch', hunks: hunks.value };
  const payload = { pagePath: file, authoredChecksum: read.checksum, edit };
  return parsePageEditResult(await harness.invoke('page:edit', payload));
}

test('page read and write replies parse only with a valid checksum', () => {
  const checksum = 'c'.repeat(64);
  assert.equal(parsePageDiskRead({ ...page, checksum }).checksum, checksum);
  assert.throws(() => parsePageDiskRead(page), /PageDiskRead\.checksum: expected string/);
  assert.throws(
    () => parsePageDiskRead({ ...page, checksum: 'c'.repeat(63) }),
    /PageDiskRead\.checksum: Digest/,
  );
  // A whole save's reply carries the inverse Undo submits (step 9).
  const written = parsePageWriteResult({ ok: true, ...page, checksum, inverse: [] });
  assert.equal(written.ok && written.value.checksum, checksum);
  assert.throws(
    () => parsePageWriteResult({ ok: true, ...page, inverse: [] }),
    /PageDiskRead\.checksum/,
  );
  assert.throws(
    () => parsePageWriteResult({ ok: true, ...page, checksum }),
    /PageEdited\.inverse: expected array/,
  );
  assert.throws(() => parsePageWriteResult(null), /PageWriteResult: expected object/);
  assert.throws(() => parsePageWriteResult({ ok: 'yes' }), /PageWriteResult\.ok/);
});

test('write refusals parse per code; unknown or malformed ones throw', () => {
  const diskChecksum = 'd'.repeat(64);
  const conflict = parsePageWriteResult({
    ok: false,
    error: { code: 'conflict', message: 'changed', diskChecksum },
  });
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: 'conflict', message: 'changed', diskChecksum },
  });
  for (const code of ['missing', 'filesystem', 'write-race', 'uncertain', 'backpressured']) {
    assert.deepEqual(parsePageWriteResult({ ok: false, error: { code, message: 'm' } }), {
      ok: false,
      error: { code, message: 'm' },
    });
  }
  const bad = [
    [{ code: 'conflict', message: 'changed' }, /PageWriteError\.diskChecksum: expected string/],
    [{ code: 'conflict', message: 'changed', diskChecksum: 'x' }, /diskChecksum: Digest/],
    [{ code: 'teapot', message: 'm' }, /PageWriteError\.code: unknown value/],
    [{ code: 'missing' }, /PageWriteError\.message: expected string/],
    [{ code: 'missing', message: 'm'.repeat(9000) }, /PageWriteError\.message: exceeds limit/],
    [undefined, /PageWriteError: expected object/],
  ] as const;
  for (const [error, message] of bad) {
    assert.throws(() => parsePageWriteResult({ ok: false, error }), message);
  }
});

test('a read reports the checksum of the exact bytes on disk', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, '<h1>é</h1>\n');
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.equal(read.checksum, sha256(fs.readFileSync(file)));
  fs.writeFileSync(file, Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0x0a]));
  await assert.rejects(harness.invoke('page:read', file), /not valid UTF-8/);
});

test('an outside edit between read and write is refused and left on disk', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  // The whole save is a Markdown page's until step 10; its guard is the step-0 one.
  const notes = path.join(harness.root, 'src/pages/notes.md');
  fs.writeFileSync(notes, '# Before\n');
  const before = parsePageDiskRead(await harness.invoke('page:read', notes));
  assert.ok(before.editable);
  fs.writeFileSync(notes, '# Outside\n');
  const payload = { pagePath: notes, model: before.model, baseChecksum: before.checksum };
  const result = parsePageWriteResult(await harness.invoke('page:write', payload));
  assert.equal(!result.ok && result.error.code, 'conflict');
  assert.equal(
    !result.ok && result.error.code === 'conflict' && result.error.diskChecksum,
    sha256('# Outside\n'),
  );
  assert.equal(fs.readFileSync(notes, 'utf8'), '# Outside\n', 'page:write left disk alone');
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, '<h1>Before</h1>\n');
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  fs.writeFileSync(file, '<h1>Outside</h1>\n');
  // The code editor's save of the same word overlaps the outside edit.
  const code = await saveCode(harness, file, read, '<h1>Mine</h1>\n');
  assert.equal(!code.ok && code.error.code === 'rejected' && code.error.reason, 'merge-conflict');
  assert.equal(
    !code.ok && code.error.code === 'rejected' && code.error.diskChecksum,
    sha256('<h1>Outside</h1>\n'),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Outside</h1>\n', 'the patch left disk alone');
  assert.deepEqual(temporaries(path.dirname(file)), []);
});

test('a write against current bytes lands atomically with its checksum', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, '<h1>Before</h1>\n');
  fs.chmodSync(file, 0o640);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  const source = '<h1>After</h1>\n';
  const written = await saveCode(harness, file, read, source);
  assert.ok(written.ok, 'the code save applied');
  assert.equal(written.value.checksum, sha256(source));
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'the replacement keeps the mode');
  }
  assert.deepEqual(temporaries(path.dirname(file)), []);
  // The next save names the checksum the last one returned.
  const again = await saveCode(harness, file, written.value, '<h1>Again</h1>\n');
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Again</h1>\n');
});

test('a page deleted since it was read is missing, not a conflict', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/gone.md');
  fs.writeFileSync(file, 'Gone.\n');
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  fs.rmSync(file);
  const result = parsePageWriteResult(
    await harness.invoke('page:write', {
      pagePath: file,
      model: read.editable ? read.model : {},
      baseChecksum: read.checksum,
    }),
  );
  assert.equal(!result.ok && result.error.code, 'missing');
  const code = await saveCode(harness, file, read, 'Still here.\n');
  assert.equal(code.ok, false, 'a code save does not recreate the file either');
  assert.equal(fs.existsSync(file), false, 'a refused write does not recreate the file');
});

test('opening and saving every round-trip fixture reproduces its bytes', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const names = fs.readdirSync(FIXTURES).filter((name) => /\.(astro|mdx?)$/.test(name));
  assert.ok(names.filter((name) => name !== 'README.md').length >= 9, 'the corpus is not thin');
  for (const name of names.filter((entry) => entry !== 'README.md')) {
    const original = fs.readFileSync(path.join(FIXTURES, name));
    const file = path.join(harness.root, 'src/pages', name);
    fs.writeFileSync(file, original);
    const read = parsePageDiskRead(await harness.invoke('page:read', file));
    assert.ok(read.editable, `${name} opens in the visual editor`);
    assert.equal(read.checksum, sha256(original));
    const serialized = toRecord(
      await harness.invoke('page:serialize', { pagePath: file, model: read.model }),
    );
    assert.equal(serialized?.['source'], original.toString('utf8'), `${name} reviews exactly`);
    const written = parsePageWriteResult(
      await harness.invoke('page:write', {
        pagePath: file,
        model: read.model,
        baseChecksum: read.checksum,
      }),
    );
    if (name.endsWith('.astro')) {
      // Step 9: an .astro page is edited as splices and never saved whole.
      assert.equal(!written.ok && written.error.code, 'filesystem', `${name} is not saved whole`);
    } else {
      assert.equal(written.ok, true, name);
      assert.equal(written.ok && written.value.checksum, sha256(original));
      assert.deepEqual(written.ok && written.value.inverse, [], `${name}: nothing to undo`);
    }
    assert.ok(fs.readFileSync(file).equals(original), `${name} round-trips byte for byte`);
  }
});

test('a byte-order mark does not hide the frontmatter', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/page-bom-crlf.astro');
  fs.copyFileSync(path.join(FIXTURES, 'page-bom-crlf.astro'), file);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  assert.ok('imports' in read.model);
  assert.deepEqual(
    read.model.imports.map((entry) => entry.name),
    ['Layout'],
  );
  const markdown = path.join(harness.root, 'src/pages/post-bom-crlf.md');
  fs.copyFileSync(path.join(FIXTURES, 'post-bom-crlf.md'), markdown);
  const post = toRecord(toRecord(await harness.invoke('page:read', markdown))?.['model']);
  assert.equal(post?.['mdHasFrontmatter'], true);
  assert.match(String(post?.['extraFrontmatter']), /^title: Shipping the editor/);
});
