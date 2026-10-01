// Mount the real variables rail with deferred reads. Watcher bursts must coalesce,
// and responses from an old project or an unmounted panel must not replace its list.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('./helpers/sources.js');

test('variables refresh coalesces watcher bursts and ignores obsolete projects', async () => {
  const output = repoPath('node_modules/.stacki-test/variables-refresh.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/variables/VariablesPanel.tsx')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const reads = [];
  const listeners = new Set();
  window.avb = {
    cssVariables(project) {
      return new Promise((resolve, reject) => reads.push({ project, resolve, reject }));
    },
    onCssChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Panel = require(output).default;
  const root = createRoot(document.getElementById('root'));
  const show = (project) =>
    act(async () => {
      root.render(React.createElement(Panel, { project: { path: project }, onSelect() {} }));
    });
  const snapshot = (name) => ({ files: [{ rel: name, name, groups: [], count: 0 }], values: {} });
  try {
    await show('/first');
    assert.equal(reads.length, 1);
    assert.equal(listeners.size, 1);
    for (let i = 0; i < 50; i++) {
      for (const listener of listeners) {
        listener();
      }
    }
    assert.equal(reads.length, 1, 'only one read is in flight');
    await act(async () => {
      reads[0].resolve(snapshot('first.css'));
    });
    assert.equal(reads.length, 2, 'all watcher events request one follow-up');
    assert.match(document.body.textContent, /first.css/);
    await show('/second');
    assert.equal(reads.length, 3);
    assert.equal(reads[2].project, '/second');
    assert.equal(listeners.size, 1, 'previous project listener was removed');
    await act(async () => {
      reads[2].resolve(snapshot('second.css'));
    });
    await act(async () => {
      reads[1].resolve(snapshot('obsolete.css'));
    });
    assert.match(document.body.textContent, /second.css/);
    assert.doesNotMatch(document.body.textContent, /obsolete.css/);
    await act(async () => {
      for (const listener of listeners) {
        listener();
      }
    });
    await act(async () => {
      reads[3].reject(new Error('disk unavailable'));
    });
    assert.match(document.querySelector('.cms-error').textContent, /disk unavailable/);
    await act(async () => {
      for (const listener of listeners) {
        listener();
      }
    });
    await act(async () => {
      root.unmount();
    });
    assert.equal(listeners.size, 0);
    await act(async () => {
      reads[4].resolve(snapshot('late.css'));
    });
    assert.equal(document.getElementById('root').textContent, '');
  } finally {
    dom.window.close();
  }
});
