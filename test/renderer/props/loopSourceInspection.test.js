// Goal: a loop picker explains the list it uses, its contents, and its source.
// Method: inspect representative static and computed declarations without
// executing project code, including malformed paths and unsupported values.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { inspectLoopSource } = load('src/features/props/loopSourceInspection.ts');

const source = `export const home = {
  hero: {
    ctas: [
      { label: "Start planning", href: "/start", variant: "primary" },
      { label: "See destinations", href: "/destinations", variant: "secondary" },
    ],
  },
};`;

test('a nested imported list shows its source, count, and real item content', () => {
  const detail = inspectLoopSource(source, 'home', 'home.hero.ctas', 'src/data/home.ts');
  assert.equal(detail.count, 2);
  assert.match(detail.items[0], /label: "Start planning"/);
  assert.match(detail.items[1], /href: "\/destinations"/);
  assert.equal(detail.tree.children[0].children[0].kind, 'list');
});

test('computed sources are labeled honestly and never invented as items', () => {
  const detail = inspectLoopSource(
    'export const home = { hero: { ctas: fetchLinks() } };',
    'home',
    'home.hero.ctas',
    'src/data/home.ts',
  );
  assert.equal(detail.count, undefined);
  assert.deepEqual(detail.items, []);
  assert.match(detail.note, /computed at runtime/);
  const spread = inspectLoopSource(
    'export const home = { hero: { ctas: [{label: "One"}, ...moreCtas] } };',
    'home',
    'home.hero.ctas',
    'src/data/home.ts',
  );
  assert.equal(spread.count, undefined);
  assert.match(spread.note, /computed items/);
  assert.throws(
    () => inspectLoopSource(source, 'home', 'other.ctas', 'src/data/home.ts'),
    /must start at root/,
  );
});
