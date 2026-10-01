// Pure row planning preserves column holes and heading boundaries. A controlled
// frame queue checks scroll echoes, cleanup, and registration/collection limits.
const assert = require('node:assert/strict');
const load = require('./renderer-module');
const rows = load('src/panels/variableRows.ts');
const { createScrollSync } = load('src/panels/variableScroll.ts');
const cell = (name) => ({
  name,
  file: 'tokens.css',
  selector: ':root',
  column: '0',
  value: 'red',
  valueStart: 10,
  valueEnd: 13,
  line: 1,
});
const first = {
  label: 'primary',
  name: '--color-primary',
  cells: [cell('--color-primary'), undefined],
};
const second = {
  label: 'secondary',
  name: '--color-secondary',
  cells: [cell('--color-secondary')],
};
const block = { kind: 'rows', title: 'color', rows: [first, second] };
const empty = { kind: 'rows', title: 'Other', titleStart: 90, rows: [] };
const { slots, offsets } = rows.buildSheetSlots([block, empty]);
assert.deepEqual(offsets, [
  { head: 0, rows: 1 },
  { head: 4, rows: 5 },
]);
assert.equal(rows.stemOf(block), '--color-');
assert.equal(rows.sectionPrefix(block), 'color');
assert.deepEqual(rows.rowRenames(block, first, 'accent'), [
  { from: '--color-primary', to: '--color-accent' },
]);
assert.deepEqual(rows.movesForDrop(slots, 1, 3), [
  { file: 'tokens.css', selector: ':root', name: '--color-primary', at: 90 },
]);
assert.equal(rows.dropPlan(slots, 0, 1), undefined);
assert.equal(rows.dropPlan(slots, 99, 0), undefined);
assert.equal(rows.dropPlan(slots, 0, 2).before, '--color-secondary');
const matrix = { kind: 'matrix', title: 'Heading', rows: [] };
assert.equal(rows.sectionPrefix(matrix), undefined);
assert.deepEqual(
  rows.rowRenames(
    matrix,
    { label: 'size', cells: [cell('--h1-size'), undefined, cell('--h3-size')] },
    'weight',
  ),
  [
    { from: '--h1-size', to: '--h1-weight' },
    { from: '--h3-size', to: '--h3-weight' },
  ],
);
for (const invalid of [-1, 0.5, NaN, Infinity]) {
  assert.throws(() => rows.movesForDrop(slots, invalid, 0), /source index/);
  assert.throws(() => rows.dropPlan(slots, 0, invalid), /target index/);
}
assert.throws(() => rows.buildSheetSlots(Array(10001).fill(empty)), /block limit exceeded/);
assert.throws(
  () => rows.buildSheetSlots([{ ...block, rows: Array(10000).fill(first) }]),
  /slot limit exceeded/,
);
assert.throws(() => rows.rowRenames(block, first, 'x'.repeat(8193)), /name limit exceeded/);
assert.throws(
  () => rows.stemOf({ ...block, rows: [{ name: '--x', label: 'too long' }] }),
  /label exceeds name/,
);
const frames = new Map();
let nextFrame = 0;
global.requestAnimationFrame = (callback) => {
  const id = ++nextFrame;
  frames.set(id, callback);
  return id;
};
global.cancelAnimationFrame = (id) => frames.delete(id);
const flush = () => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback());
};
const sync = createScrollSync();
const firstPeer = { scrollLeft: 0 },
  secondPeer = { scrollLeft: 0 },
  otherWidth = { scrollLeft: 0 };
const unregister = sync.register(2, secondPeer);
sync.register(2, firstPeer);
sync.register(3, otherWidth);
sync.broadcast(2, firstPeer, 80);
assert.equal(secondPeer.scrollLeft, 80);
assert.equal(otherWidth.scrollLeft, 0);
sync.broadcast(2, secondPeer, 30);
assert.equal(firstPeer.scrollLeft, 0, 'echoes are suppressed');
assert.equal(frames.size, 1, 'one frame bounds echo suppression');
flush();
unregister();
sync.broadcast(2, firstPeer, 100);
assert.equal(secondPeer.scrollLeft, 80, 'unregistered peers stay untouched');
sync.dispose();
assert.equal(frames.size, 0, 'unmount cancels the pending frame');
const oldCleanup = sync.register(2, secondPeer);
sync.dispose();
const current = { scrollLeft: 0 };
sync.register(2, current);
oldCleanup();
sync.broadcast(2, firstPeer, 50);
assert.equal(current.scrollLeft, 50, 'old cleanup cannot remove a new registration');
sync.dispose();
assert.throws(() => sync.register(-1, current), /nonnegative/);
assert.throws(() => sync.register(1.5, current), /integer/);
assert.throws(() => sync.broadcast(2, current, NaN), /finite/);
for (let index = 0; index < 10000; index++) {
  sync.register(1, { scrollLeft: 0 });
}
assert.throws(() => sync.register(1, { scrollLeft: 0 }), /peer limit exceeded/);
sync.dispose();
console.log('variable-core: moves, rename rules, bounds, scroll echoes and cleanup passed');
