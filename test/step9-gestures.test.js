// Goal: every gesture the whole-model save used to carry reaches disk as edit
// requests (plan §11 step 9): rewording a note, renaming a prop, changing a
// tag or a component, setting content, a condition's test and its else
// branch, and picking, renaming or removing a layout — each writes only its
// own bytes, `page:write` is never called for an .astro page, and undoing
// every gesture restores the file byte for byte.
// Method: the real App in jsdom with stub panels that capture their props, as
// in page-navigation.test.js. The bridge serves a real file in a temporary
// folder: `page:read` parses it with the real parser, and `page:edit` does
// what main's handler does — the real document host (electron/documentActors.ts)
// submits each request through main's own translation (editRequests.ts), so
// requests of one gesture rebase through the host's commit log exactly as in
// the app. Undo is the ⌘Z the user presses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { parsePage } = require('../dist/electron/astroParser.js');
const { createNodeDocumentActors } = require('../dist/electron/documentActors.js');
const { buildEdit } = require('../dist/electron/editRequests.js');
const { decodeUtf8 } = require('../dist/shared/span.js');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
// Past the typing batch (300 ms) and the save that follows it.
const saved = () => new Promise((resolve) => setTimeout(resolve, 450));

const PAGE = [
  '---',
  "import Card from '../components/Card.astro';",
  '---',
  '<main>',
  '  <!-- Hero note -->',
  '  <section class="hero" title="Hi">',
  '    <p>Hello</p>',
  '  </section>',
  '  <div id="box">text</div>',
  '  {show && (<p>Shown</p>)}',
  '  <Card />',
  '</main>',
  '',
].join('\n');

const LAYOUT_PAGE = [
  '---',
  "import Base from '../layouts/Base.astro';",
  '---',
  '<Base>',
  '  <main>m</main>',
  '</Base>',
  '',
].join('\n');

// A panel that records its props and renders nothing.
const panelStub = (name) =>
  "export const relativeTime = () => ''; " +
  'export default function Panel(props) { ' +
  `globalThis.__panels[${JSON.stringify(name)}] = props; return null; }`;

async function mountApp(root, files) {
  const dir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'step9-gestures');
  fs.mkdirSync(dir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'App.tsx')],
    outfile: path.join(dir, 'app.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'capture-panels',
        setup(build) {
          build.onLoad({ filter: /\/src\/panels\/[^/]+\.[jt]sx$/ }, (args) => {
            const name = path.basename(args.path, path.extname(args.path));
            return {
              contents: panelStub(name),
              loader: 'jsx',
            };
          });
        },
      },
    ],
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'KeyboardEvent',
  ]) {
    global[key] = key === 'window' ? window : window[key];
  }
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.ResizeObserver = global.ResizeObserver;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  global.__panels = {};
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const documents = createNodeDocumentActors({
    log: () => {},
    schedule: (task) => setImmediate(task),
  });
  const calls = { writePage: 0, edits: [] };
  const read = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    return { ...parsePage(text, { locs: true }), source: text, checksum: sha256(text) };
  };
  const bridge = new Proxy(
    {
      pendingProject: async () => null,
      scanProject: async () => files.scan,
      hasNodeModules: async () => true,
      startDevServer: async () => ({ url: 'http://localhost:4321' }),
      listProjectClasses: async () => [],
      readPage: async (file) => read(file),
      // The whole-model save: an .astro page must never reach it.
      writePage: async () => {
        calls.writePage += 1;
        throw new Error('page:write was called for an .astro page');
      },
      editPage: async ({ pagePath, authoredChecksum, edit }) => {
        calls.edits.push(edit.tag);
        const stated = { authoredChecksum, gone: 'anchor-moved' };
        const report = documents.submitEdit(pagePath, stated, (base) => buildEdit(edit, base));
        if (report.tag !== 'applied') {
          const error =
            report.tag === 'rejected'
              ? {
                  code: 'rejected',
                  reason: report.reason,
                  message: report.message,
                  diskChecksum: report.diskChecksum ?? null,
                }
              : { code: 'filesystem', message: report.tag };
          return { ok: false, error };
        }
        const decoded = decodeUtf8(report.bytes);
        assert.ok(decoded.ok);
        return { ok: true, ...read(pagePath), inverse: report.inverse };
      },
      importPathFor: async ({ targetPath }) => ({
        relative: `../${path.relative(path.join(root, 'src'), targetPath)}`,
        srcRelative: null,
      }),
      onFsChanged: () => () => {},
      gitInfo: async () => ({ isRepo: false }),
      onCssChanged: () => () => {},
    },
    {
      get: (target, key) =>
        key in target
          ? target[key]
          : String(key).startsWith('on')
            ? () => () => {}
            : async () => null,
    },
  );
  window.avb = bridge;
  global.avb = bridge;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const reactRoot = createRoot(document.getElementById('root'));
  const App = require(path.join(dir, 'app.js')).default;
  await act(async () => {
    reactRoot.render(React.createElement(App));
    await tick();
  });
  await act(async () => {
    await __panels.WelcomeScreen.onOpen(root);
    await tick();
  });
  return { act, calls, window, unmount: () => act(() => reactRoot.unmount()) };
}

// The shown node at a path of the page's model, through the navigator's props.
function nodeAt(pathSteps) {
  let list = __panels.StructurePanel.pageState.model.nodes;
  let node;
  for (const step of pathSteps) {
    node = list[step];
    assert.ok(node, `a node at ${pathSteps.join('/')}`);
    list = Array.isArray(node.children) ? node.children : [];
  }
  return node;
}

async function select(app, pathSteps) {
  await app.act(async () => {
    __panels.StructurePanel.onSelect(nodeAt(pathSteps).id);
    await tick();
  });
}

// A gesture, then its save. React commits the gesture's state when the act
// scope ends — in the app it commits before an urgent save's zero-delay timer
// fires, which is what that timer is for — so the wait is its own scope.
async function gesture(app, run) {
  await app.act(run);
  await app.act(() => saved());
}

async function undo(app) {
  await gesture(app, async () => {
    document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }),
    );
  });
}

test('each converted gesture writes only its bytes; undo restores every byte', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-step9-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  const card = path.join(root, 'src/components/Card.astro');
  fs.writeFileSync(file, PAGE);
  fs.writeFileSync(card, '<div><slot /></div>\n');
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [{ name: 'Card', path: card, folder: '' }],
    layouts: [],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan });
  context.after(app.unmount);
  const disk = () => fs.readFileSync(file, 'utf8');
  const expectDisk = (lines, what) => assert.equal(disk(), lines.join('\n'), what);
  const body = (rest) => [
    '---',
    "import Card from '../components/Card.astro';",
    '---',
    ...rest,
    '',
  ];

  // The note above the section, reworded: its words only.
  await select(app, [0, 1]);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetComment('Hero section');
  });
  expectDisk(
    body([
      '<main>',
      '  <!-- Hero section -->',
      '  <section class="hero" title="Hi">',
      '    <p>Hello</p>',
      '  </section>',
      '  <div id="box">text</div>',
      '  {show && (<p>Shown</p>)}',
      '  <Card />',
      '</main>',
    ]),
    'the note is reworded in place',
  );
  // A prop renamed: its name only.
  await gesture(app, async () => {
    __panels.PropsPanel.onRenameProp('title', 'aria-label');
  });
  // The tag changed: both names; its global and aria attributes stay.
  await gesture(app, async () => {
    await __panels.PropsPanel.onChangeTag('article');
  });
  expectDisk(
    body([
      '<main>',
      '  <!-- Hero section -->',
      '  <article class="hero" aria-label="Hi">',
      '    <p>Hello</p>',
      '  </article>',
      '  <div id="box">text</div>',
      '  {show && (<p>Shown</p>)}',
      '  <Card />',
      '</main>',
    ]),
    'the prop and the tag are renamed where they are written',
  );
  // Content set on the box: its text only.
  await select(app, [0, 2]);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetContent('new text');
  });
  // The box becomes a Card: its names, and the import it already has.
  await gesture(app, async () => {
    await __panels.PropsPanel.onChangeTag('Card');
  });
  expectDisk(
    body([
      '<main>',
      '  <!-- Hero section -->',
      '  <article class="hero" aria-label="Hi">',
      '    <p>Hello</p>',
      '  </article>',
      '  <Card id="box">new text</Card>',
      '  {show && (<p>Shown</p>)}',
      '  <Card />',
      '</main>',
    ]),
    'the content and the component change land on their bytes',
  );
  // The condition: its test, then an else branch.
  await select(app, [0, 3]);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetText('visible');
  });
  assert.match(disk(), /\{visible && \(<p>Shown<\/p>\)\}/, 'the test is rewritten in place');
  await gesture(app, async () => {
    __panels.PropsPanel.onToggleElse(true);
  });
  assert.match(disk(), /\{visible \? \(/, 'the else branch is added');
  assert.equal(app.calls.writePage, 0, 'no gesture saved the whole model');
  // Undo every gesture, newest first: the file comes back byte for byte.
  for (let step = 0; step < 7; step++) {
    await undo(app);
  }
  assert.equal(disk(), PAGE, 'undo restores every byte');
  assert.equal(app.calls.writePage, 0, 'undo never saved the whole model either');
});

test('paste and extract-to-component insert, remove and import as requests', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-step9-paste-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  const start = '---\n---\n<main>\n  <p class="a">One</p>\n  <div>Two</div>\n</main>\n';
  fs.writeFileSync(file, start);
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [],
    layouts: [],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan });
  context.after(app.unmount);
  const disk = () => fs.readFileSync(file, 'utf8');
  // Copy the paragraph, select the div, paste: a new node after the div.
  await gesture(app, async () => {
    __panels.StructurePanel.onCopyNode(nodeAt([0, 0]).id);
  });
  await select(app, [0, 1]);
  await gesture(app, async () => {
    await __panels.StructurePanel.onPasteNode();
  });
  // A tag that holds children takes the paste as its last child (the rule
  // the whole-model paste had): one insertion, inside the selection.
  assert.equal(
    disk(),
    '---\n---\n<main>\n  <p class="a">One</p>\n  <div>Two<p class="a">One</p></div>\n</main>\n',
    'the paste is one insertion inside the selection',
  );
  // The div becomes a component of its own: the instance goes in, the markup
  // comes out, and the page imports it.
  const created = path.join(root, 'src/components/Two.astro');
  global.avb.createComponent = async () => {
    fs.writeFileSync(created, '<div>Two<p class="a">One</p></div>\n');
    return { path: created, rel: 'src/components/Two.astro', name: 'Two' };
  };
  await select(app, [0, 1]);
  const components = [...document.querySelectorAll('.rail-btn')].find((button) =>
    String(button.getAttribute('aria-label')).startsWith('Components'),
  );
  assert.ok(components, 'the Components rail button');
  await app.act(async () => {
    components.click();
    await tick();
  });
  await gesture(app, async () => {
    await __panels.PalettePanel.onCreateComponent('Two');
  });
  assert.equal(
    disk(),
    "---\nimport Two from '../components/Two.astro';\n---\n" +
      '<main>\n  <p class="a">One</p>\n  <Two />\n</main>\n',
    'extract: an instance where the markup was, and its import',
  );
  assert.equal(app.calls.writePage, 0, 'neither saved the whole model');
});

test('a layout renamed, removed and picked again reaches disk as requests', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-step9-layout-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/layouts'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  const base = path.join(root, 'src/layouts/Base.astro');
  const other = path.join(root, 'src/layouts/Other.astro');
  fs.writeFileSync(file, LAYOUT_PAGE);
  fs.writeFileSync(base, '<slot />\n');
  fs.writeFileSync(other, '<slot />\n');
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [],
    layouts: [
      { name: 'Base', path: base, folder: 'layouts' },
      { name: 'Other', path: other, folder: 'layouts' },
    ],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan });
  context.after(app.unmount);
  const disk = () => fs.readFileSync(file, 'utf8');
  await gesture(app, async () => {
    await __panels.StructurePanel.onChangeLayout('Other');
  });
  assert.equal(
    disk(),
    "---\nimport Other from '../layouts/Other.astro';\n---\n<Other>\n  <main>m</main>\n</Other>\n",
    'the wrapper is renamed and its import follows',
  );
  await gesture(app, async () => {
    await __panels.StructurePanel.onChangeLayout('');
  });
  assert.equal(
    disk(),
    '---\n---\n  <main>m</main>\n',
    'removed: its tags and its import go, the page stays',
  );
  await gesture(app, async () => {
    await __panels.StructurePanel.onChangeLayout('Base');
  });
  assert.equal(
    disk(),
    "---\nimport Base from '../layouts/Base.astro';\n---\n  <Base>\n  <main>m</main>\n  </Base>\n",
    'picked again: the page is wrapped as written, and the import added',
  );
  assert.equal(app.calls.writePage, 0, 'no layout change saved the whole model');
});
