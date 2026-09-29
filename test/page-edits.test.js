// Goal: the renderer's half of step 6 — the edit-request queue that succeeds
// createPageSaver's whole-model writes (src/pageEdits.ts) and the gesture
// adapter (src/editGestures.ts) — keeps plan §7's rules: requests coalesce
// within one stream of one undo step while unsent; a gesture without an intent
// form turns the queue into whole-model saves until the page is clean; a
// refusal never loses input and names its reason; a transient failure sends
// the same requests again, a write that may have landed never does; and every
// applied request leaves its undo step the inverse that restores the file.
// Method: the real modules, bundled with esbuild, driven directly; the send
// function is a fake for the outcome table, then main's real handlers in the
// windowless harness for the end-to-end run, undo included, on a temporary
// project.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePageDiskRead, parsePageEditResult } = require('../dist/shared/page-save.js');

const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'page-edits');
fs.mkdirSync(buildDir, { recursive: true });
esbuild.buildSync({
  entryPoints: ['pageEdits', 'editGestures'].map((name) =>
    path.join(__dirname, '..', 'src', `${name}.ts`),
  ),
  outdir: buildDir,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const edits = require(path.join(buildDir, 'pageEdits.js'));
const gestures = require(path.join(buildDir, 'editGestures.js'));

const sum = (digit) => String(digit).repeat(64);
const REF = { path: [0], kind: 'element', span: { start: 0, end: 4 } };
const record = () => ({ outcome: { tag: 'applied', applied: [] } });
const draft = (stream, owner = record(), origin = sum(1)) => ({
  edit: { tag: 'remove-node', target: REF },
  stream,
  record: owner,
  authoredChecksum: origin,
});

test('the queue coalesces one stream of one undo step, and nothing else', () => {
  const store = new edits.EditDrafts();
  const step = record();
  assert.equal(store.record('/p', draft('title', step)), true);
  assert.equal(store.record('/p', draft('title', step)), true);
  assert.equal(store.queue('/p').pending.length, 1, 'the newer value replaced the older');
  assert.deepEqual(step.outcome, { tag: 'pending', waiting: 1, applied: [] });
  store.record('/p', draft('title', record()));
  store.record('/p', draft(null, step));
  store.record('/p', draft(null, step));
  assert.equal(
    store.queue('/p').pending.length,
    4,
    'another step, and structural requests, stay apart',
  );
  assert.deepEqual(step.outcome, { tag: 'pending', waiting: 3, applied: [] });
  assert.equal(store.take('/p').length, 4);
  assert.deepEqual(store.take('/p'), [], 'taken requests are gone from the queue');
});

test('a gesture without an intent form saves whole models until the page is clean', () => {
  const store = new edits.EditDrafts();
  const early = record();
  store.record('/p', draft('a', early));
  store.markModel('/p');
  assert.deepEqual(early.outcome, { tag: 'subsumed' }, 'the queued request is carried whole');
  const late = record();
  assert.equal(store.record('/p', draft('b', late)), false);
  assert.deepEqual(late.outcome, { tag: 'subsumed' });
  assert.deepEqual(store.take('/p'), []);
  // A clean page has another origin: requests go out again.
  assert.equal(store.record('/p', draft('c', record(), sum(2))), true);
  assert.equal(store.queue('/p').tag, 'edits');
  assert.equal(store.queue('/elsewhere').tag, 'model', 'another page queues nothing here');
});

test('the queue is bounded: past it, the whole model carries the requests', () => {
  const store = new edits.EditDrafts();
  for (let index = 0; index < 64; index++) {
    assert.equal(store.record('/p', draft(null)), true);
  }
  const over = record();
  assert.equal(store.record('/p', draft(null, over)), false);
  assert.equal(store.queue('/p').tag, 'model');
  assert.deepEqual(over.outcome, { tag: 'subsumed' });
});

test('answers fill the undo step in order; a step is applied when nothing is owed', () => {
  const step = record();
  const store = new edits.EditDrafts();
  store.record('/p', draft(null, step));
  store.record('/p', draft(null, step));
  edits.recordApplied(step, { checksum: sum(2), inverse: [] });
  assert.equal(step.outcome.tag, 'pending');
  edits.recordApplied(step, { checksum: sum(3), inverse: [] });
  assert.deepEqual(step.outcome, {
    tag: 'applied',
    applied: [
      { checksum: sum(2), inverse: [] },
      { checksum: sum(3), inverse: [] },
    ],
  });
});

const PAGE_OK = (checksum) => ({
  ok: true,
  value: { source: '', editable: false, reason: '', bail: null, checksum, inverse: [] },
});
const refusal = (reason, diskChecksum) => ({
  ok: false,
  error: { code: 'rejected', reason, message: reason, diskChecksum },
});

async function sent(answers, count = answers.length) {
  const store = new edits.EditDrafts();
  const steps = Array.from({ length: count }, () => record());
  const drafts = steps.map((step) => draft(null, step));
  for (const one of drafts) {
    store.record('/p', one);
  }
  const queued = store.take('/p');
  let index = 0;
  const outcome = await edits.sendDrafts({
    path: '/p',
    drafts: queued,
    base: sum(1),
    store,
    send: async () => answers[index++],
  });
  return { outcome, store, steps };
}

test('a save of requests: every outcome, and what happens to the rest', async () => {
  const applied = await sent([PAGE_OK(sum(2)), PAGE_OK(sum(3))]);
  assert.equal(applied.outcome.tag, 'applied');
  assert.equal(applied.outcome.last.checksum, sum(3));

  const fallback = await sent([PAGE_OK(sum(2)), refusal('unsupported-operation', sum(2))]);
  assert.deepEqual(fallback.outcome, { tag: 'fallback', base: sum(2) });
  assert.equal(fallback.store.queue('/p').tag, 'model', 'the whole model carries the rest');
  assert.deepEqual(fallback.steps[1].outcome, { tag: 'subsumed' });

  const unchanged = await sent([refusal('anchor-moved', sum(1))]);
  assert.deepEqual(unchanged.outcome, { tag: 'fallback', base: sum(1) }, 'nothing moved under it');

  const refused = await sent([PAGE_OK(sum(2)), refusal('region-externally-modified', sum(9))]);
  assert.deepEqual(refused.outcome, {
    tag: 'refused',
    reason: 'region-externally-modified',
    diskChecksum: sum(9),
    advanced: sum(2),
  });

  const busy = await sent([{ ok: false, error: { code: 'backpressured', message: 'busy' } }], 2);
  assert.deepEqual(busy.outcome, { tag: 'failed', message: 'busy', advanced: undefined });
  assert.equal(busy.store.queue('/p').pending.length, 2, 'never accepted: sent again later');

  const maybe = await sent([
    PAGE_OK(sum(2)),
    { ok: false, error: { code: 'uncertain', message: '?' } },
  ]);
  assert.deepEqual(maybe.outcome, { tag: 'failed', message: '?', advanced: sum(2) });
  assert.equal(maybe.store.queue('/p').tag, 'model', 'may have landed: never sent twice');
});

test('nodeRefIn names nodes of the origin by path, kind and range, and nothing else', () => {
  const model = {
    imports: [],
    nodes: [
      {
        id: 'a',
        kind: 'element',
        name: 'div',
        start: 0,
        end: 20,
        children: [{ id: 'b', kind: 'text', value: 'x', start: 5, end: 6 }],
      },
      {
        id: 'c',
        kind: 'chunk-group',
        name: 'x',
        chunkFile: '/x.html',
        start: 21,
        end: 30,
        children: [{ id: 'd', kind: 'text', value: 'y', start: 0, end: 1 }],
      },
      { id: 'e', kind: 'element', name: 'p', children: [] },
    ],
  };
  const origin = { checksum: sum(1), model };
  assert.deepEqual(edits.nodeRefIn(origin, 'b'), {
    path: [0, 0],
    kind: 'text',
    span: { start: 5, end: 6 },
  });
  assert.equal(edits.nodeRefIn(origin, 'd'), undefined, 'inside a chunk file');
  assert.equal(edits.nodeRefIn(origin, 'e'), undefined, 'no source range: created since');
  assert.equal(edits.nodeRefIn(origin, 'zz'), undefined);
});

test('propsGesture: values of every type but a spread are requests; the effect copies', () => {
  const refOf = (id) => (id === 'a' ? REF : undefined);
  const set = gestures.propsGesture(
    'a',
    { title: { type: 'string', value: 'T' }, alt: undefined },
    { coalesceKey: 'k', urgency: false },
  );
  assert.deepEqual(set.request(refOf), [
    {
      edit: {
        tag: 'set-attribute',
        target: REF,
        name: 'title',
        value: { type: 'string', value: 'T' },
      },
      stream: 'attribute:0:title',
    },
    { edit: { tag: 'remove-attribute', target: REF, name: 'alt' }, stream: 'attribute:0:alt' },
  ]);
  assert.equal(
    gestures
      .propsGesture('b', { title: undefined }, { coalesceKey: null, urgency: true })
      .request(refOf),
    undefined,
  );
  const options = { coalesceKey: null, urgency: true };
  const expr = gestures
    .propsGesture('a', { n: { type: 'expr', value: 'x' } }, options)
    .request(refOf);
  assert.deepEqual(expr?.[0]?.edit.value, { type: 'expr', value: 'x' }, 'the prop step');
  const bare = gestures.propsGesture('a', { hidden: { type: 'bare' } }, options).request(refOf);
  assert.deepEqual(bare?.[0]?.edit.value, { type: 'bare' });
  const spread = gestures.propsGesture('a', { rest: { type: 'spread', value: 'rest' } }, options);
  assert.equal(spread.request(refOf), undefined, 'a spread is code: the whole model carries it');
  const node = {
    id: 'a',
    kind: 'element',
    name: 'img',
    props: { alt: { type: 'string', value: 'x' }, src: { type: 'string', value: 's' } },
    children: null,
  };
  const model = {
    imports: [],
    nodes: [{ id: 'r', kind: 'element', name: 'div', children: [node] }],
  };
  const next = set.apply(model);
  assert.deepEqual(
    Object.keys(next.nodes[0].children[0].props),
    ['src', 'title'],
    'order kept, new last',
  );
  assert.deepEqual(Object.keys(node.props), ['alt', 'src'], 'the old model is untouched');
  assert.notEqual(next.nodes[0], model.nodes[0], 'every list on the path is new');
});

// --- End to end: main's real handlers ------------------------------------------------

test('requests reach the page as splices; the undo step restores every byte', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-edits-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('./contracts/main-harness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/pages/index.astro');
  const text = '<main>\n  <img\n    src="/a.png"\n    alt="Old"\n  />\n</main>\n';
  fs.writeFileSync(file, text);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  const origin = { checksum: read.checksum, model: read.model };
  const image = read.model.nodes[0]?.children?.[0];
  assert.ok(image !== undefined);
  const store = new edits.EditDrafts();
  const step = record();
  for (const patch of [
    { alt: { type: 'string', value: 'New' } },
    { alt: { type: 'string', value: 'Newer' } },
    { loading: { type: 'string', value: 'lazy' } },
  ]) {
    const gesture = gestures.propsGesture(image.id, patch, { coalesceKey: 'k', urgency: false });
    for (const { edit, stream } of gesture.request((id) => edits.nodeRefIn(origin, id))) {
      store.record(file, { edit, stream, record: step, authoredChecksum: origin.checksum });
    }
  }
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const outcome = await edits.sendDrafts({
    path: file,
    drafts: store.take(file),
    base: read.checksum,
    store,
    send,
  });
  assert.equal(outcome.tag, 'applied');
  const written =
    '<main>\n  <img\n    src="/a.png"\n    alt="Newer"\n    loading="lazy"\n  />\n</main>\n';
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    written,
    'two requests: the coalesced value and the new one',
  );
  assert.equal(step.outcome.tag, 'applied');
  for (const applied of [...step.outcome.applied].reverse()) {
    const undone = await send({
      pagePath: file,
      authoredChecksum: applied.checksum,
      edit: { tag: 'revert', hunks: applied.inverse },
    });
    assert.ok(undone.ok);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'undone on the engine, byte for byte');
});
