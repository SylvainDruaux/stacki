// Parse real Git conflict parts through the renderer boundary, then exercise
// the merge dialog's default, per-hunk, whole-file, and busy choices. Invalid
// wire shapes and cumulative bounds must fail before choices reach a write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const load = require('./renderer-module');
const { BOUNDARY_LIMITS } = require('../dist/shared/boundary.js');
const { parseMergeResult, parseConflictPart } = load('gitBridge.ts');
const { initialConflictPicks, choicesForSend, conflictHunks } = load('panels/gitConflictModel.ts');
const { parseConflict } = require('../dist/electron/conflicts.js');
const clash = { kind: 'clash', ours: 'ours', theirs: 'theirs', changedBy: 'both' };
const file = (parts) => ({ path: 'a.astro', ours: 'ours', theirs: 'theirs', parts });
const conflict = (files) => ({ ok: false, conflicted: true, from: 'main', branch: 'topic', files });

test('real conflict output survives the renderer parser and preserves each choice', () => {
  const parts = parseConflict('before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nafter');
  const value = conflict([file(parts)]);
  assert.deepEqual(parseMergeResult(value), value);
  const picks = initialConflictPicks(value);
  assert.deepEqual(choicesForSend(value, picks), { 'a.astro': ['ours'] });
  const hunks = conflictHunks(parts);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].before, 'before');
  assert.equal(hunks[0].after, 'after');
  const automatic = conflict([
    file([
      { ...clash, changedBy: 'theirs' },
      { ...clash, merged: 'combined' },
    ]),
  ]);
  assert.deepEqual(initialConflictPicks(automatic), { 'a.astro': ['theirs', 'merged'] });
  assert.throws(() => choicesForSend(automatic, { 'a.astro': ['ours'] }), /choice count changed/);
  assert.deepEqual(choicesForSend(conflict([file(null)]), { 'a.astro': ['theirs'] }), {
    'a.astro': 'theirs',
  });
});

test('merge contracts reject unknown parts and bound total files plus parts', () => {
  for (const part of [
    null,
    {},
    { kind: 'same', text: 1 },
    { ...clash, changedBy: 'someone' },
    { ...clash, ours: null },
    { ...clash, merged: false },
  ]) {
    assert.throws(() => parseConflictPart(part));
  }
  assert.throws(() => parseMergeResult(conflict([])), /at least one conflict/);
  assert.throws(() => parseMergeResult(conflict([file([{ kind: 'unknown' }])])));
  assert.throws(() => parseMergeResult(conflict([file(Array(100001).fill(clash))])), /limit/);
  assert.throws(
    () =>
      parseMergeResult(
        conflict([
          file(Array(50000).fill(clash)),
          { ...file(Array(50000).fill(clash)), path: 'b.astro' },
        ]),
      ),
    /item limit exceeded/,
  );
  assert.throws(
    () => parseConflictPart({ kind: 'same', text: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) }),
    /String exceeds limit/,
  );
  assert.throws(() => initialConflictPicks(conflict([])), /at least one file/);
  assert.throws(() => conflictHunks(Array(100001).fill(clash)), /part limit exceeded/);
});

test('merge dialog sends exact selected choices and locks binary choices while busy', async () => {
  const output = path.join(__dirname, '../node_modules/.stacki-test/git-conflict.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [path.join(__dirname, '../src/panels/MergeConflictModal.tsx')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  for (const name of ['MutationObserver', 'HTMLElement', 'Element', 'Node', 'DOMRect', 'Window']) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Modal = require(output).default;
  const root = createRoot(document.getElementById('root'));
  const value = conflict([
    file([clash, { ...clash, merged: 'combined' }]),
    { ...file(null), path: 'image.png' },
  ]);
  const resolutions = [];
  let cancellations = 0;
  const show = (busy = null) =>
    act(async () =>
      root.render(
        React.createElement(Modal, {
          conflict: value,
          busy,
          onResolve: (choices) => resolutions.push(choices),
          onCancel: () => cancellations++,
        }),
      ),
    );
  const click = (element) => act(async () => element.click());
  const button = (selector, label) =>
    [...document.querySelectorAll(selector)].find((entry) => entry.textContent.trim() === label);
  try {
    await show();
    assert.equal(document.querySelectorAll('.conflict-hunk').length, 2);
    await click(
      button('.conflict-hunk:first-child button', 'Both') ||
        button('.conflict-hunk button', 'Both'),
    );
    await click(document.querySelector('[title="image.png"]'));
    await click(button('.conflict-whole button', 'topic'));
    await click(document.querySelector('.modal-footer .primary'));
    assert.deepEqual(resolutions[0], { 'a.astro': ['both', 'merged'], 'image.png': 'theirs' });
    await show('Merging…');
    assert.ok(
      [...document.querySelectorAll('.conflict-whole button')].every((entry) => entry.disabled),
    );
    await act(async () =>
      document
        .querySelector('.modal-overlay')
        .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })),
    );
    assert.equal(cancellations, 0);
    await show();
    await act(async () =>
      document
        .querySelector('.modal-overlay')
        .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })),
    );
    assert.equal(cancellations, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
