// Goal: a page that finishes loading clears everything cached about the last
// one. The preview reports a ready canvas to canvasQuery, which tells every
// cache that registered with onCanvasReady; the style panel's computed-color
// and computed-style caches register when they load.
// Method: the real canvasQuery module, bundled; listeners are counted across
// a ready signal, an unsubscribe and a second signal. The two caches'
// registration is pinned in their source, since their state is private.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const loadRenderer = require('./helpers/rendererModule.js');
const { repoPath } = require('./helpers/sources.js');

test('a ready canvas tells each registered cache, until it unsubscribes', () => {
  const canvas = loadRenderer('src/canvasQuery.ts');
  let first = 0;
  let second = 0;
  const stopFirst = canvas.onCanvasReady(() => {
    first += 1;
  });
  canvas.onCanvasReady(() => {
    second += 1;
  });
  canvas.noteCanvasReady();
  assert.deepEqual([first, second], [1, 1]);
  stopFirst();
  canvas.noteCanvasReady();
  assert.deepEqual([first, second], [1, 2], 'an unsubscribed cache hears nothing more');
});

test('the computed-value caches forget on a ready canvas', () => {
  for (const [file, forget] of [
    ['src/style-panel/lib/computed-color.ts', 'forgetComputedColors'],
    ['src/style-panel/lib/computed-style.ts', 'forgetComputedStyles'],
  ]) {
    const source = fs.readFileSync(repoPath(file), 'utf8');
    assert.match(source, new RegExp(`^onCanvasReady\\(${forget}\\);$`, 'm'), file);
  }
});
