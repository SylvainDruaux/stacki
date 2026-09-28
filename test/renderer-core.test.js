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
  entryPoints: ['editorTree', 'loopBindings', 'pagePersistence'].map((name) => path.join(__dirname, '..', 'src', `${name}.js`)),
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

// Page saver harness: `replace` and `markConflicted` update `current` at once,
// the way App's ref catches up on the next render. Writes are held on gates so
// each test decides exactly when disk answers.
const sum = (digit) => String(digit).repeat(64);
const dirty = (base) => ({ tag: 'dirty', baseChecksum: base });
const clean = (checksum) => ({ tag: 'clean', checksum });
function saverHarness(pageState, path = '/page.astro') {
  const harness = { current: { currentPage: { path }, pageState }, writes: [], gates: [] };
  harness.save = createPageSaver({
    readCurrent: () => harness.current,
    write: (writePath, state, baseChecksum) => {
      harness.writes.push({ path: writePath, state, baseChecksum });
      const gate = deferred();
      harness.gates.push(gate);
      return gate.promise;
    },
    withSave: (state, save) => ({ ...state, save }),
    replace: (previous, next) => {
      if (harness.current.pageState === previous) {
        harness.current = { ...harness.current, pageState: next };
      }
    },
    markConflicted: (baseChecksum, diskChecksum) => {
      const state = harness.current.pageState;
      if (state && state.save.tag !== 'clean') {
        const save = { tag: 'conflicted', baseChecksum, diskChecksum };
        harness.current = { ...harness.current, pageState: { ...state, save } };
      }
    },
  });
  harness.edit = (fields) => {
    const state = harness.current.pageState;
    const base = state.save.baseChecksum ?? state.save.checksum;
    const save = state.save.tag === 'conflicted' ? state.save : dirty(base);
    harness.current = { ...harness.current, pageState: { ...state, ...fields, save } };
  };
  harness.written = (index, checksum, fields = {}) =>
    harness.gates[index].resolve({
      tag: 'written',
      state: { ...harness.writes[index].state, ...fields, save: clean(checksum) },
      checksum,
    });
  return harness;
}

test('saving serializes concurrent writes and drains newer edits before navigation', async () => {
  const page = saverHarness({ save: dirty(sum(0)), model: { version: 1 } });
  const one = page.save.flush();
  await tick();
  assert.equal(page.current.pageState.save.tag, 'saving');
  assert.equal(page.save.writing(), true);
  page.edit({ model: { version: 2 } });
  const two = page.save.flush();
  await tick();
  assert.equal(page.writes.length, 1);
  page.written(0, sum(1));
  await tick();
  assert.equal(page.current.pageState.save.tag, 'saving');
  assert.equal(page.writes.length, 2);
  assert.deepEqual(page.writes[1].state.model, { version: 2 });
  // The second state was authored against the bytes before the first save;
  // the saver advances it to the checksum it wrote itself.
  assert.equal(page.writes[1].state.save.baseChecksum, sum(0));
  assert.equal(page.writes[1].baseChecksum, sum(1));
  page.written(1, sum(2));
  assert.deepEqual(await Promise.all([one, two]), ['settled', 'settled']);
  assert.deepEqual(page.current.pageState.save, clean(sum(2)));
  assert.equal(page.writes.length, 2);
  assert.equal(page.save.writing(), false);
});

test('failed saves can retry and completing an old save never cleans another page', async () => {
  const page = saverHarness({ save: dirty(sum(0)) }, '/first.astro');
  const first = page.current.pageState;
  const failed = page.save.flush();
  await tick();
  page.gates[0].reject(new Error('disk full'));
  await assert.rejects(failed, /disk full/);
  assert.deepEqual(page.current.pageState, first, 'the edit is unsaved again');
  const retry = page.save.flush();
  await tick();
  assert.deepEqual(page.writes[1].state, first);
  page.current = { currentPage: { path: '/second.astro' }, pageState: { save: dirty(sum(5)) } };
  page.written(1, sum(1));
  assert.equal(await retry, 'settled');
  assert.deepEqual(page.current.pageState.save, dirty(sum(5)));
});

test('a refused save marks the page conflicted and autosave stays off', async () => {
  const page = saverHarness({ save: dirty(sum(0)), model: { version: 1 } });
  const refused = page.save.flush();
  await tick();
  page.gates[0].resolve({ tag: 'conflict', diskChecksum: sum(9) });
  assert.equal(await refused, 'conflicted');
  assert.deepEqual(page.current.pageState.save, {
    tag: 'conflicted',
    baseChecksum: sum(0),
    diskChecksum: sum(9),
  });
  // Edits keep applying locally, but nothing reaches disk.
  page.edit({ model: { version: 2 } });
  assert.equal(await page.save.flush(), 'conflicted');
  assert.equal(await page.save.flush(), 'conflicted');
  assert.equal(page.writes.length, 1);
  assert.deepEqual(page.current.pageState.model, { version: 2 });
  // Keeping the local version is a deliberate edit against the disk's bytes.
  page.current = {
    ...page.current,
    pageState: { ...page.current.pageState, save: dirty(sum(9)) },
  };
  const kept = page.save.flush();
  await tick();
  assert.equal(page.writes[1].baseChecksum, sum(9));
  page.written(1, sum(3));
  assert.equal(await kept, 'settled');
  assert.deepEqual(page.current.pageState.save, clean(sum(3)));
});

test('a clean page resets the lineage so an old base is never advanced again', async () => {
  const page = saverHarness({ save: dirty(sum(0)), model: { version: 1 } });
  const saving = page.save.flush();
  await tick();
  page.edit({ model: { version: 2 } });
  page.written(0, sum(1));
  await tick();
  // Mid-drain: the pending edit still names sum(0), which the saver replaced.
  assert.equal(page.save.baseFor('/page.astro', dirty(sum(0))), sum(1));
  assert.equal(page.save.baseFor('/other.astro', dirty(sum(0))), sum(0));
  page.written(1, sum(2));
  assert.equal(await saving, 'settled');
  // Once a clean state is current every later edit grows from its checksum. A
  // file reverted outside to the old bytes and reloaded must name those bytes.
  assert.equal(page.save.baseFor('/page.astro', dirty(sum(0))), sum(0));
  assert.throws(() => page.save.baseFor('/page.astro', clean(sum(0))), /nothing to write/);
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
