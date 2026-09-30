// Exercise iframe replies through real parsers and the pending-query lifecycle.
// Fake postMessage avoids a browser; real promises expose cancellation and limits.
const assert = require('node:assert/strict');
const loadRenderer = require('./renderer-module.js');
const { BOUNDARY_LIMITS } = require('../dist/shared/boundary.js');
const { parseCanvasReply } = loadRenderer('canvasReply.ts');
const canvas = loadRenderer('canvasQuery.ts');

const valid = {
  id: 1, found: true, ready: true,
  identity: { tag: 'div', id: null, classes: ['card'], attributes: { class: 'card' } },
  matched: { '.card': true, '[': null },
  computed: { 'var(--color)': 'rgb(0, 0, 0)' },
  computedProps: { display: 'block' },
};
assert.equal(parseCanvasReply(valid).ok, true);
for (const input of [
  null, [], {}, { ...valid, id: -1 }, { ...valid, id: 1.5 },
  { ...valid, id: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, found: 'yes' },
  { ...valid, ready: 1 }, { ...valid, identity: { tag: 123 } },
  { ...valid, identity: { ...valid.identity, classes: [1] } },
  { ...valid, matched: { '.card': 'yes' } }, { ...valid, computed: { color: 123 } },
  { ...valid, computedProps: { color: false } },
  { ...valid, identity: { ...valid.identity, classes: Array(100001).fill('a') } },
  { ...valid, identity: { ...valid.identity, tag: 'a'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) } },
]) {
  assert.equal(parseCanvasReply(input).ok, false);
}

async function main() {
  const sent = [];
  canvas.setCanvasFrame({ postMessage: (message) => sent.push(message) });
  const result = canvas.queryCanvas('0', ['.card']);
  const id = sent[0].id;
  canvas.receiveCanvasReply({ id, found: false, ready: false });
  canvas.noteCanvasReady();
  assert.equal(sent.length, 2);
  canvas.receiveCanvasReply({ ...valid, id, matched: { '.card': 'invalid' } });
  canvas.receiveCanvasReply({ ...valid, id });
  assert.deepEqual(await result, {
    identity: valid.identity, matched: valid.matched,
    computed: valid.computed, computedProps: valid.computedProps,
  });

  const cancelled = canvas.queryCanvas('1');
  canvas.setCanvasFrame(null);
  assert.equal(await cancelled, null);
  assert.equal(canvas.hasCanvas(), false);
  assert.equal(await canvas.queryCanvas('2'), null);
  canvas.setCanvasFrame({ postMessage() { throw new Error('detached'); } });
  assert.equal(await canvas.queryCanvas('3'), null);
  assert.equal(canvas.tellCanvas({ type: 'test' }), false);

  canvas.setCanvasFrame({ postMessage() {} });
  const waiting = Array.from({ length: canvas.CANVAS_LIMITS.pendingMax }, () => canvas.queryCanvas('0'));
  assert.equal(await canvas.queryCanvas('overflow'), null);
  canvas.setCanvasFrame(null);
  assert.equal((await Promise.all(waiting)).every((value) => value === null), true);

  const { createPreviewWatch } = loadRenderer('previewRecovery.ts');
  for (const duration of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => createPreviewWatch({
      probe: async () => ({ ok: true }), onRecover() {}, retryMs: duration,
    }), /Preview interval/);
  }
  console.log('renderer-messages: parser rejection, held replies, cancellation and bounds passed');
}
main().catch((error) => {
  canvas.setCanvasFrame(null);
  console.error(error);
  process.exitCode = 1;
});
