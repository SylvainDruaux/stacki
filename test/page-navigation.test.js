// Goal: page navigation, watcher reloads and saves never let an older read or
// an outside edit replace the user's current edit, and a refused save keeps the
// edit, stops autosave and asks the user (plan §7).
// Method: render the real App in jsdom with stub panels that capture their
// props, drive it through those callbacks, and hold every disk read on a
// deferred so each interleaving is chosen by the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const nodeId = (label) =>
  `n${Array.from(label).reduce(
    (hash, character) => (hash * 31 + character.charCodeAt(0)) % 1_000_000_007,
    7,
  )}`;
// Every page read reports the checksum of the bytes it read (plan §11 step 0).
const diskChecksum = 'a'.repeat(64);
const pageState = (label) => ({
  editable: true,
  source: '',
  checksum: diskChecksum,
  model: {
    imports: [],
    frontmatterLead: '',
    extraFrontmatter: '',
    extraFrontmatterSpaced: false,
    frontmatterLayout: { extra: '', slots: [] },
    hadFrontmatter: false,
    trailingBlank: 0,
    nodes: [{ id: nodeId(label), kind: 'element', name: 'div', props: {}, children: [] }],
  },
});

test('out-of-order page reads and external reads cannot replace the current edit', async () => {
  const dir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'page-navigation');
  fs.mkdirSync(dir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'App.tsx')], outfile: path.join(dir, 'app.js'),
    bundle: true, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' }, logLevel: 'silent',
    plugins: [{ name: 'capture-panels', setup(build) {
      build.onLoad({ filter: /\/src\/panels\/[^/]+\.[jt]sx$/ }, (args) => {
        const name = path.basename(args.path, path.extname(args.path));
        return { contents: `export const relativeTime = () => ''; export default function Panel(props) { globalThis.__panels[${JSON.stringify(name)}] = props; return null; }`, loader: 'jsx' };
      });
    } }],
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {global[key] = key === 'window' ? window : window[key];}
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  window.ResizeObserver = global.ResizeObserver;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  global.__panels = {};
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const pages = ['index', 'second', 'third'].map((name) => ({ name: `${name}.astro`, path: `/project/src/pages/${name}.astro`, route: name === 'index' ? '/' : `/${name}` }));
  const scan = { pages, components: [{ name: 'Card', path: '/project/src/components/Card.astro', folder: '' }], layouts: [], pageFolders: [] };
  const reads = [];
  const scans = [];
  let deferScans = false;
  const writes = [];
  let writeError = null;
  let refuseWrites = null; // the checksum on disk when main refuses a write
  let onFsChanged;
  const bridge = new Proxy({
    pendingProject: async () => null,
    scanProject: async () => {
      if (!deferScans) {return scan;}
      const request = deferred();
      scans.push(request);
      return request.promise;
    },
    hasNodeModules: async () => true,
    startDevServer: async () => ({ url: 'http://localhost:4321' }),
    listProjectClasses: async () => [],
    readPage: (path) => { const request = deferred(); reads.push({ path, ...request }); return request.promise; },
    writePage: async (payload) => {
      if (writeError) {throw writeError;}
      writes.push(payload);
      if (refuseWrites) {
        const error = { code: 'conflict', message: 'changed', diskChecksum: refuseWrites };
        return { ok: false, error };
      }
      const checksum = String(writes.length % 10).repeat(64);
      return { ok: true, editable: true, source: '', model: payload.model, checksum };
    },
    serializePage: async () => ({ source: '<div>local</div>\n' }),
    onFsChanged: (cb) => { onFsChanged = cb; return () => {}; },
    gitInfo: async () => ({ isRepo: false }),
    onCssChanged: () => () => {},
  }, { get: (target, key) => key in target ? target[key] : String(key).startsWith('on') ? () => () => {} : async () => null });
  window.avb = bridge;
  global.avb = bridge;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const root = createRoot(document.getElementById('root'));
  const App = require(path.join(dir, 'app.js')).default;
  await act(async () => { root.render(React.createElement(App)); await tick(); });
  await act(async () => { await __panels.WelcomeScreen.onOpen('/project'); await tick(); });
  assert.equal(reads[0].path, pages[0].path);
  await act(async () => { reads[0].resolve(pageState('first')); await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('first'));
  await act(async () => {
    __panels.StructurePanel.onHoverNode(nodeId('first'));
    await tick();
  });
  assert.equal(__panels.PreviewPane.navHoverPath, '0');
  // Use the actual page switcher callback through the editor's URL input.
  const navigate = async (route) => {
    const input = document.querySelector('.url-bar input, input[spellcheck="false"]');
    assert.ok(input, 'URL input is available');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, route);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await tick();
    });
    await act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(); });
  };
  await navigate('/second');
  await navigate('/third');
  assert.equal(reads.length, 3);
  await act(async () => { reads[2].resolve(pageState('third')); await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('third'));
  assert.equal(
    __panels.PreviewPane.navHoverPath,
    null,
    'Installing a page clears navigator hover so canvas hover can take over',
  );
  await act(async () => { reads[1].resolve(pageState('stale-second')); await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('third'));
  assert.equal(__panels.PropsPanel.filePath, pages[2].path);
  // Two watcher reads overlap: the earlier response must not block the
  // later snapshot merely because it arrived first and changed state identity.
  let olderReload, newerReload;
  await act(async () => { olderReload = onFsChanged({ files: [pages[2].path] }); await tick(); });
  await act(async () => { newerReload = onFsChanged({ files: [pages[2].path] }); await tick(); });
  assert.equal(reads.length, 5);
  await act(async () => { reads[3].resolve(pageState('older-disk')); await olderReload; await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('third'));
  await act(async () => { reads[4].resolve(pageState('latest-disk')); await newerReload; await tick(); });
  // An external read is re-keyed onto the session's node ids (issue #29), so
  // the node at the same trail keeps the id the editor already knows.
  assert.equal(__panels.PropsPanel.node.id, nodeId('third'));
  // Begin an external reload, then edit while it is waiting on disk.
  let external;
  await act(async () => { external = onFsChanged({ files: [pages[2].path] }); await tick(); });
  assert.equal(reads.length, 6);
  await act(async () => { __panels.PropsPanel.onSetProp('title', { type: 'string', value: 'keep this' }); await tick(); });
  await act(async () => { reads[5].resolve(pageState('stale-disk')); await external; await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('third'));
  assert.equal(__panels.PropsPanel.node.props.title.value, 'keep this');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  assert.equal(writes.at(-1).pagePath, pages[2].path);
  assert.equal(writes.at(-1).model.nodes[0].props.title.value, 'keep this');
  assert.equal(writes.at(-1).baseChecksum, diskChecksum, 'the save names the bytes it edited');
  let openComponent;
  await act(async () => { openComponent = __panels.StructurePanel.onOpenComponent('Card'); await tick(); });
  assert.equal(reads[6].path, scan.components[0].path);
  await act(async () => { reads[6].resolve(pageState('card')); await openComponent; await tick(); });
  let componentReload;
  await act(async () => { componentReload = onFsChanged({ files: [scan.components[0].path] }); await tick(); });
  assert.equal(reads[7].path, scan.components[0].path, 'an open component is reloaded, not treated as deleted');
  await act(async () => { reads[7].resolve(pageState('card-updated')); await componentReload; await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('card'));
  assert.equal(__panels.PropsPanel.filePath, scan.components[0].path);
  writeError = new Error('disk full');
  await act(async () => { __panels.PropsPanel.onSetProp('title', { type: 'string', value: 'unsaved card' }); await tick(); });
  await navigate('/second');
  assert.equal(reads.length, 8, 'a failed save blocks navigation before reading the next page');
  assert.equal(__panels.PropsPanel.filePath, scan.components[0].path);
  assert.equal(__panels.PreviewPane.route, '/third');
  assert.match(document.querySelector('.toast.error').textContent, /disk full/);
  writeError = null;
  await navigate('/second');
  assert.equal(reads[8].path, pages[1].path);
  await act(async () => { reads[8].resolve(pageState('second-retry')); await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('second-retry'));
  // A relevant page change is followed by an unrelated file change while the
  // first scan is pending. One scan runs at a time (src/coalescedRun.ts): the
  // later event waits for the scan after it, and that scan owns the
  // accumulated paths.
  deferScans = true;
  let earlierScanEvent, laterScanEvent;
  await act(async () => { earlierScanEvent = onFsChanged({ files: [pages[1].path] }); await tick(); });
  await act(async () => { laterScanEvent = onFsChanged({ files: ['/project/src/components/New.astro'] }); await tick(); });
  assert.equal(scans.length, 1, 'the later event waits behind the scan in flight');
  // The earlier snapshot says the page was deleted. A newer scan waits behind
  // it, so it must neither replace the panel lists nor clear the page.
  const layoutsBefore = __panels.StructurePanel.layouts;
  await act(async () => {
    scans[0].resolve({ ...scan, pages: pages.filter((page) => page.path !== pages[1].path) });
    await earlierScanEvent;
    await tick();
  });
  assert.equal(__panels.StructurePanel.currentPage.path, pages[1].path);
  assert.equal(__panels.StructurePanel.layouts, layoutsBefore, 'a superseded scan is never applied');
  assert.equal(scans.length, 2, 'the waiting scan starts once the first ends');
  const latestScan = { ...scan, layouts: [{ name: 'NewLayout', path: '/project/src/layouts/NewLayout.astro', folder: 'layouts' }] };
  await act(async () => { scans[1].resolve(latestScan); await tick(); });
  assert.equal(reads[9].path, pages[1].path, 'the unrelated later event keeps the earlier page change');
  await act(async () => { reads[9].resolve(pageState('after-newest-scan')); await laterScanEvent; await tick(); });
  assert.equal(__panels.StructurePanel.currentPage.path, pages[1].path);
  assert.equal(__panels.PropsPanel.node.id, nodeId('second-retry'));
  assert.deepEqual(__panels.StructurePanel.layouts, latestScan.layouts);

  // The same accumulation must span a pending READ, not only its scan.
  deferScans = false;
  let pendingReadEvent, unrelatedEvent;
  await act(async () => { pendingReadEvent = onFsChanged({ files: [pages[1].path] }); await tick(); });
  await act(async () => { unrelatedEvent = onFsChanged({ files: ['/project/src/components/New.astro'] }); await tick(); });
  assert.equal(reads[10].path, pages[1].path);
  assert.equal(reads[11].path, pages[1].path);
  await act(async () => { reads[10].resolve(pageState('stale-before-unrelated')); await pendingReadEvent; await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('second-retry'));
  await act(async () => { reads[11].resolve(pageState('latest-after-unrelated')); await unrelatedEvent; await tick(); });
  assert.equal(__panels.PropsPanel.node.id, nodeId('second-retry'));

  // --- A refused save (plan §7) ---------------------------------------------
  // Main refuses the write: the page turns conflicted, the notice appears, and
  // the edit stays on screen. Later edits apply locally but never autosave.
  // Separate acts: the save timer relies on React committing the edit first.
  const typeTitle = async (value) => {
    await act(async () => {
      __panels.PropsPanel.onSetProp('title', { type: 'string', value });
      await tick();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  };
  refuseWrites = 'd'.repeat(64);
  const attempted = writes.length;
  delete __panels.SaveConflictNotice;
  await typeTitle('mine');
  assert.equal(writes.length, attempted + 1);
  assert.equal(__panels.SaveConflictNotice.fileName, pages[1].name);
  assert.equal(__panels.SaveConflictNotice.reviewing, false);
  await typeTitle('mine, again');
  assert.equal(writes.length, attempted + 1, 'autosave stays off while conflicted');
  assert.equal(__panels.PropsPanel.node.props.title.value, 'mine, again');
  // Leaving would drop the edits, so navigation stops and says why.
  await navigate('/third');
  assert.equal(reads.length, 12, 'a conflicted page blocks navigation before any read');
  assert.match(
    document.querySelector('.toast.error').textContent,
    /conflict with a change on disk/,
  );
  // Review shows the local text in code; keeping it saves against the disk bytes.
  await act(async () => { __panels.SaveConflictNotice.onReview(); await tick(); });
  assert.equal(__panels.SaveConflictNotice.reviewing, true);
  refuseWrites = null;
  // A synchronous act commits the click's state before the zero-delay save
  // timer runs, as a real discrete event does.
  act(() => { __panels.SaveConflictNotice.onKeep(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.equal(writes.length, attempted + 2);
  assert.equal(writes.at(-1).baseChecksum, 'd'.repeat(64));
  assert.equal(writes.at(-1).model.nodes[0].props.title.value, 'mine, again');
  delete __panels.SaveConflictNotice;
  await typeTitle('clean again');
  assert.equal(__panels.SaveConflictNotice, undefined, 'the notice leaves with the conflict');
  assert.equal(writes.length, attempted + 3);

  // An outside edit while the page has unsaved edits is surfaced, not dropped:
  // the pending save must not overwrite it, and the watcher must not discard
  // the user's input by reloading.
  // Typing batches for 300 ms; the outside edit lands inside that window.
  let dirtyEvent;
  await act(async () => {
    __panels.PropsPanel.onSetProp('title', { type: 'string', value: 'typing' });
    await tick();
  });
  await act(async () => { dirtyEvent = onFsChanged({ files: [pages[1].path] }); await tick(); });
  assert.equal(reads[12].path, pages[1].path);
  await act(async () => {
    reads[12].resolve({ ...pageState('outside'), checksum: 'e'.repeat(64) });
    await dirtyEvent;
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  assert.equal(writes.length, attempted + 3, 'the pending save never reached disk');
  assert.equal(__panels.SaveConflictNotice.fileName, pages[1].name);
  assert.equal(__panels.PropsPanel.node.props.title.value, 'typing');
  // Reload from disk is the deliberate way out; it discards the local edit.
  await act(async () => { __panels.SaveConflictNotice.onReload(); await tick(); });
  assert.equal(reads[13].path, pages[1].path);
  delete __panels.SaveConflictNotice;
  await act(async () => { reads[13].resolve(pageState('reloaded')); await tick(); });
  assert.equal(__panels.SaveConflictNotice, undefined);
  assert.equal(writes.length, attempted + 3, 'reloading writes nothing');
  await act(async () => root.unmount());
  dom.window.close();
});
