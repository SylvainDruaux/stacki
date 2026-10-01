// Goal: a drop on the Navigator acts only on drag data it can trust — a palette
// component or a tree node, each named within the page-tree bound — and ignores
// anything else another window might put on the drag.
// Method: the pure parser reads from stub DataTransfer getters holding each
// known-good payload and each known-bad one (nothing, foreign types only, a
// name or id one past the bound).
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS } = require('#dist/shared/limits.js');
const { parseNavigatorDrop } = require('./helpers/rendererModule')(
  'src/features/structure/navigatorDrop.ts',
);

const transfer = (data) => (type) => data[type] ?? '';

test('palette components and tree nodes parse; the component wins when both are set', () => {
  assert.deepEqual(parseNavigatorDrop(transfer({ 'avb/component': 'Hero' })), {
    kind: 'component',
    name: 'Hero',
  });
  const node = parseNavigatorDrop(transfer({ 'avb/node': 'n0.1' }));
  assert.deepEqual(node, { kind: 'node', id: 'n0.1' });
  assert.deepEqual(parseNavigatorDrop(transfer({ 'avb/component': 'Hero', 'avb/node': 'n0' })), {
    kind: 'component',
    name: 'Hero',
  });
});

test('empty, foreign and oversized drag data is no drop', () => {
  const over = 'x'.repeat(LIMITS.tagNameCharsMax + 1);
  for (const data of [
    {},
    { 'text/plain': 'Hero' },
    { 'avb/component': over },
    { 'avb/node': over },
  ]) {
    assert.equal(parseNavigatorDrop(transfer(data)), undefined);
  }
});
