// Goal: the renderer's pure core — tree index, loop bindings, and page and file
// persistence — behaves as its callers rely on.
// Method: bundle the real modules with esbuild and drive them directly; saves
// resolve on test-held gates so every interleaving is chosen, not timed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'renderer-core');
fs.mkdirSync(buildDir, { recursive: true });
esbuild.buildSync({
  entryPoints: ['editorTree', 'loopBindings', 'pagePersistence', 'pageEdits'].map((name) =>
    path.join(__dirname, '..', 'src', `${name}.ts`),
  ),
  outdir: buildDir, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent',
});
const tree = require(path.join(buildDir, 'editorTree.js'));
const loops = require(path.join(buildDir, 'loopBindings.js'));
const { createPageSaver, scanContainsFile } = require(path.join(buildDir, 'pagePersistence.js'));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(setImmediate);

test('tree index preserves locations, ancestry and anchors after moves', () => {
  const leaf = { id: 'leaf', props: { id: { type: 'string', value: 'anchor' } }, children: null };
  const nodes = [{ id: 'first', children: [leaf] }, { id: 'second', children: [] }];
  const index = tree.createTreeIndex(nodes);
  assert.equal(index.node('leaf'), leaf);
  assert.equal(index.parent('leaf'), nodes[0]);
  assert.equal(index.path('leaf'), '0.0');
  assert.deepEqual(index.ancestors('leaf'), [nodes[0], leaf]);
  assert.deepEqual(index.sectionIds, ['anchor']);
  assert.equal(index.byPath.get('0.0'), leaf);
  assert.equal(index.path('missing'), null);
  assert.equal(index.parent('first'), null);
  assert.equal(tree.isDescendantOf(leaf, 'leaf'), true);
  nodes[1].children.push(nodes[0].children.pop());
  assert.equal(tree.findParentNode(nodes, 'leaf'), nodes[1]);
  assert.deepEqual(tree.pathOfNode(nodes, 'leaf'), [1, 0]);
  assert.deepEqual(tree.ancestorChain(nodes, 'leaf'), [nodes[1], leaf]);
  assert.equal(tree.nodeAtPath(nodes, [1, 0]), leaf);
  assert.equal(tree.createTreeIndex(nodes).path('leaf'), '1.0');
  assert.deepEqual(tree.findParentList({ nodes }, 'leaf'), { list: nodes[1].children, index: 0 });
});

test('deep tree lookup does not exhaust the JavaScript call stack', () => {
  let node = { id: 'leaf' };
  for (let i = 0; i < 15000; i++) {node = { id: `parent${i}`, children: [node] };}
  assert.equal(tree.findNodeById([node], 'leaf').id, 'leaf');
  assert.equal(tree.pathOfNode([node], 'leaf').length, 15001);
});

test('loop renames preserve dollar identifiers, property names and nested shadows', () => {
  const nodes = [
    { kind: 'expr', value: '{$item.label + $items.label + other.$item}' },
    { kind: 'text', value: '$item prose {$item.label}' },
    { kind: 'map', head: '$item.children.map(($item) => (', body: ['const title = $item.title;'], children: [{ kind: 'expr', value: '{$item.title}' }] },
    { kind: 'map', head: '$item.children.map((child) => (', body: ['const title = $item.title;'], children: [{ kind: 'expr', value: '{$item.title}' }] },
  ];
  loops.renameLoopVar(nodes, '$item', 'next$');
  assert.equal(nodes[0].value, '{next$.label + $items.label + other.$item}');
  assert.equal(nodes[1].value, '$item prose {next$.label}');
  assert.equal(nodes[2].head, 'next$.children.map(($item) => (');
  assert.equal(nodes[2].body[0], 'const title = $item.title;');
  assert.equal(nodes[2].children[0].value, '{$item.title}');
  assert.equal(nodes[3].body[0], 'const title = next$.title;');
  assert.equal(nodes[3].children[0].value, '{next$.title}');
});

test('moving from a loop drops lost bindings without rewriting nested local variables', () => {
  const node = { kind: 'element', props: {
    href: { type: 'expr', value: 'item$.url' },
    title: { type: 'expr', value: 'other.item$' },
  }, children: [
    { kind: 'expr', value: '{item$.label}' },
    { kind: 'map', head: 'item$.children.map((item$) => (', body: ['const title = item$.title;'], children: [{ kind: 'expr', value: '{item$.label}' }] },
  ] };
  assert.equal(loops.stripLostBindings(node, ['item$']), 3);
  assert.equal(node.props.href, undefined);
  assert.equal(node.props.title.value, 'other.item$');
  assert.equal(node.children[0].value, 'content');
  assert.equal(node.children[1].head, '[].map((item$) => (');
  assert.equal(node.children[1].body[0], 'const title = item$.title;');
  assert.equal(node.children[1].children[0].value, '{item$.label}');
});

// Page saver harness: a real queue (src/pageEdits.ts) and a send held on a
// gate per entry, so each test decides exactly when disk answers.
const edits = require(path.join(buildDir, 'pageEdits.js'));
const step = () => ({ outcome: { tag: 'applied', applied: [] } });
const gesture = (name) => ({
  coalesceKey: null,
  urgency: true,
  stream: null,
  request: () => [],
  apply: (model) => model,
  name,
});
function saverHarness(path = '/page.astro') {
  const harness = { path, queue: new edits.EditDrafts(), sent: [], gates: [], conflicted: false };
  harness.save = createPageSaver({
    queue: harness.queue,
    currentPath: () => harness.path,
    conflicted: () => harness.conflicted,
    send: (sentPath, entry) => {
      harness.sent.push({ path: sentPath, name: entry.gesture.name });
      const gate = deferred();
      harness.gates.push(gate);
      return gate.promise;
    },
  });
  harness.add = (name) => harness.queue.addGesture(harness.path, gesture(name), step());
  harness.answer = (index, outcome) => harness.gates[index].resolve(outcome);
  return harness;
}

test('the saver sends the queued entries in order, one at a time; later ones wait', async () => {
  const page = saverHarness();
  page.add('a');
  page.add('b');
  const one = page.save.flush();
  await tick();
  assert.deepEqual(page.sent.map((entry) => entry.name), ['a']);
  assert.equal(page.save.writing(), true);
  page.add('c'); // Made while the flush runs: the next flush sends it.
  const two = page.save.flush();
  page.answer(0, { tag: 'sent' });
  await tick();
  assert.deepEqual(page.sent.map((entry) => entry.name), ['a', 'b'], 'one at a time, in order');
  page.answer(1, { tag: 'sent' });
  assert.equal(await one, 'settled', 'a flush sends what it found, and no more');
  await tick();
  assert.deepEqual(page.sent.map((entry) => entry.name), ['a', 'b', 'c'], 'the flush asked later');
  page.answer(2, { tag: 'sent' });
  assert.equal(await two, 'settled');
  assert.equal(page.save.writing(), false);
  assert.equal(page.queue.empty(page.path), true);
});

test('a failed send puts its entry back in front and rejects; a retry sends it again', async () => {
  const page = saverHarness();
  page.add('a');
  page.add('b');
  const failed = page.save.flush();
  await tick();
  page.answer(0, { tag: 'failed', error: new Error('disk full') });
  await assert.rejects(failed, /disk full/);
  assert.equal(page.queue.entries(page.path).length, 2, 'nothing was lost');
  const retry = page.save.flush();
  await tick();
  assert.equal(page.sent[1].name, 'a', 'the failed entry goes first');
  page.answer(1, { tag: 'sent' });
  await tick();
  page.answer(2, { tag: 'sent' });
  assert.equal(await retry, 'settled');
});

test('a refused send stops autosave until the user decides', async () => {
  const page = saverHarness();
  page.add('a');
  page.add('b');
  const refused = page.save.flush();
  await tick();
  page.conflicted = true; // The sender marks the page conflicted with its reason.
  page.answer(0, { tag: 'conflicted' });
  assert.equal(await refused, 'conflicted');
  assert.equal(page.queue.entries(page.path).length, 2, 'the refused entry is kept');
  assert.equal(await page.save.flush(), 'conflicted', 'nothing reaches disk');
  assert.equal(page.sent.length, 1);
  page.conflicted = false; // "Review in code" and "Keep", or "Reload".
  const kept = page.save.flush();
  await tick();
  page.answer(1, { tag: 'sent' });
  await tick();
  page.answer(2, { tag: 'sent' });
  assert.equal(await kept, 'settled');
});

test('no open file: nothing to send', async () => {
  const page = saverHarness();
  page.add('a');
  page.path = undefined;
  assert.equal(await page.save.flush(), 'settled');
  assert.equal(page.sent.length, 0);
});

test('external edits recognize pages, components and layouts as editable files', () => {
  const scan = { pages: [{ path: 'a.astro' }], components: [{ path: 'b.astro' }], layouts: [{ path: 'c.astro' }] };
  for (const file of ['a.astro', 'b.astro', 'c.astro']) {assert.equal(scanContainsFile(scan, file), true);}
  assert.equal(scanContainsFile(scan, 'deleted.astro'), false);
});

test('code window saves keep each file and flush the latest version in order', async () => {
  const { createFileSaver } = require(path.join(buildDir, 'pagePersistence.js'));
  const writes = [];
  const saver = createFileSaver({ delay: 10000 });
  saver.schedule('a.css', async () => writes.push('a:old'));
  saver.schedule('b.css', async () => writes.push('b:current'));
  saver.schedule('a.css', async () => writes.push('a:current'));
  await saver.flush();
  assert.deepEqual(writes.sort(), ['a:current', 'b:current']);
  const gate = deferred();
  saver.schedule('a.css', async () => { writes.push('a:pending'); await gate.promise; });
  const first = saver.flush();
  await tick();
  saver.schedule('a.css', async () => writes.push('a:newest'));
  const second = saver.flush();
  await tick();
  assert.equal(writes.includes('a:newest'), false);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(writes.slice(-2), ['a:pending', 'a:newest']);
});

test('failed code window writes are retained for an explicit retry', async () => {
  const { createFileSaver } = require(path.join(buildDir, 'pagePersistence.js'));
  let fail = true;
  let attempts = 0;
  const errors = [];
  const saver = createFileSaver({ delay: 10000, onError: (error) => errors.push(error.message) });
  saver.schedule('a.css', async () => { attempts++; if (fail) {throw new Error('disk full');} });
  await assert.rejects(saver.flush(), /disk full/);
  assert.deepEqual(errors, ['disk full']);
  fail = false;
  await saver.flush();
  assert.equal(attempts, 2);
});
