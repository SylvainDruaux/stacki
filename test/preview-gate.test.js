// Goal: a canvas click selects only from a rendering of the bytes the editor
// shows (plan §9, §10 invariant 6; step 7). The gate is the renderer's half of
// the preview token: the frame's latest token, the open file's stamp against
// the page state, then main's disk check — and the page state read again after
// main answers, because it can change while the disk is being read.
// Method: bundle src/previewGate.ts and drive it with renderings, page states
// and a fake main check. Each rejection is exercised along with the valid case
// beside it — a clean page, then the same page one save later; unsaved text,
// then an unsaved move.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'preview-gate');
fs.mkdirSync(buildDir, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'previewGate.ts')],
  outdir: buildDir,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { judgeCanvasEvent, judgeLocally, sameShape, shownChecksum } = require(
  path.join(buildDir, 'previewGate.js'),
);

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const T = 'c'.repeat(64);
const FILE = 'src/pages/index.astro';
const render = {
  token: T,
  stamps: [
    { file: 'src/components/Card.astro', checksum: B },
    { file: FILE, checksum: A },
  ],
};

const tree = (...names) => [
  {
    id: 'n1',
    kind: 'element',
    name: 'main',
    children: names.map((name, i) => ({ id: `c${i}`, kind: 'element', name, children: [] })),
  },
];
const clean = (checksum, nodes = tree('h1', 'p')) => ({
  editable: true,
  source: '',
  save: { tag: 'clean', checksum },
  model: { nodes },
  origin: { checksum, model: { nodes } },
});
const dirty = (origin, shown) => ({
  editable: true,
  source: '',
  save: { tag: 'dirty', baseChecksum: A },
  model: { nodes: shown },
  origin: { checksum: A, model: { nodes: origin } },
});
const shown = (state) => ({ file: FILE, state });

test('the token must be the latest rendering', () => {
  assert.deepEqual(judgeLocally(undefined, render, shown(clean(A))), {
    tag: 'stale',
    reason: 'no-render',
    file: undefined,
  });
  assert.deepEqual(judgeLocally(T, undefined, shown(clean(A))).reason, 'no-render');
  assert.deepEqual(judgeLocally(B, render, shown(clean(A))).reason, 'superseded');
  assert.deepEqual(judgeLocally(T, render, shown(clean(A))), { tag: 'current' });
});

test('the open file must have rendered from the bytes the editor shows', () => {
  // One save later: the editor shows B, the canvas still A.
  assert.deepEqual(judgeLocally(T, render, shown(clean(B))), {
    tag: 'stale',
    reason: 'shown-page-differs',
    file: FILE,
  });
  // Text typed and not saved yet: every path means the same node.
  const typed = tree('h1', 'p').map((node) => ({
    ...node,
    children: node.children.map((c) => ({ ...c, value: 'new' })),
  }));
  assert.equal(shownChecksum(dirty(tree('h1', 'p'), typed)), A);
  assert.deepEqual(judgeLocally(T, render, shown(dirty(tree('h1', 'p'), typed))), {
    tag: 'current',
  });
  // A node moved and not saved: the canvas's paths are not the editor's.
  const moved = tree('p', 'h1');
  assert.equal(shownChecksum(dirty(tree('h1', 'p'), moved)), undefined);
  assert.equal(
    judgeLocally(T, render, shown(dirty(tree('h1', 'p'), moved))).reason,
    'shown-page-differs',
  );
  const inserted = tree('h1', 'p', 'p');
  assert.equal(
    judgeLocally(T, render, shown(dirty(tree('h1', 'p'), inserted))).reason,
    'shown-page-differs',
  );
  // No origin (typed code, a restored snapshot): nothing ties the model to bytes.
  assert.equal(shownChecksum({ ...dirty(tree('h1'), tree('h1')), origin: undefined }), undefined);
  // A raw page shows its source; only a clean one is a known version.
  assert.equal(
    shownChecksum({ editable: false, source: '', save: { tag: 'saving', baseChecksum: A } }),
    undefined,
  );
  // A file the rendering does not include is not what the canvas shows.
  assert.deepEqual(judgeLocally(T, render, { file: 'src/pages/about.astro', state: clean(A) }), {
    tag: 'stale',
    reason: 'unstamped-file',
    file: 'src/pages/about.astro',
  });
  // Markdown carries no stamp until step 10; its layout is still checked on disk.
  const markdown = { ...clean(B), model: { format: 'md', nodes: [] } };
  assert.deepEqual(judgeLocally(T, render, { file: 'src/pages/post.md', state: markdown }), {
    tag: 'current',
  });
  // Nothing open for editing: nothing to select into.
  assert.deepEqual(judgeLocally(T, render, undefined), { tag: 'current' });
});

test('shape: kinds, names and child counts, not values', () => {
  assert.equal(sameShape(tree('h1'), tree('h1')), true);
  assert.equal(sameShape(tree('h1'), tree('h2')), false);
  assert.equal(sameShape(tree('h1'), tree('h1', 'p')), false);
  assert.equal(sameShape([{ kind: 'text', value: 'a' }], [{ kind: 'text', value: 'b' }]), true);
  assert.equal(sameShape([{ kind: 'text' }], [{ kind: 'comment' }]), false);
  assert.equal(sameShape([], []), true);
});

test('main is asked only when needed, and the page is judged again after', async () => {
  let asked = 0;
  const current = async () => {
    asked++;
    return { tag: 'current' };
  };
  assert.equal(
    (await judgeCanvasEvent(B, render, () => shown(clean(A)), current)).reason,
    'superseded',
  );
  assert.equal(asked, 0, 'a superseded token never reaches main');
  assert.deepEqual(await judgeCanvasEvent(T, render, () => shown(clean(A)), current), {
    tag: 'current',
  });
  assert.equal(asked, 1);
  // Main finds the card changed on disk: stale, whatever the page says.
  const cardChanged = async () => ({
    tag: 'stale',
    reason: 'file-changed',
    file: 'src/components/Card.astro',
  });
  assert.deepEqual(await judgeCanvasEvent(T, render, () => shown(clean(A)), cardChanged), {
    tag: 'stale',
    reason: 'file-changed',
    file: 'src/components/Card.astro',
  });
  // The page saved while main was reading: the answer is for the new page.
  let state = clean(A);
  const slow = async () => {
    state = clean(B);
    return { tag: 'current' };
  };
  assert.deepEqual(await judgeCanvasEvent(T, render, () => shown(state), slow), {
    tag: 'stale',
    reason: 'shown-page-differs',
    file: FILE,
  });
});
