// Goal: the adapter-surface ratchet counts what its header says it counts, so
// a number in the tracker means the same thing at every step (plan §11 step 3).
// Method: one snippet per rule of the written method, plus the exclusions and
// the forms that must not count (comparisons, arrows, DOM writes, comments).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countTreeEdits, countWrapperCalls } from '../../dist/scripts/adapter-surface.js';

test('each rule of the written method counts one site', () => {
  const cases: readonly [string, number, number][] = [
    ['node.value = next;', 1, 0],
    ['node.children += x; node.name -= y;', 2, 0],
    ['parent.children.splice(index, 0, node);', 1, 0],
    ['delete first.blankBefore; delete n.head; delete n.children;', 1, 0],
    ['const kids = node.children;\nkids.push(child);', 1, 0],
    ['found.list.splice(found.index, 1);', 1, 0],
    ['const { list, index } = found;\nlist.splice(index, 1);', 1, 0],
    ['node.props[key] = value;', 0, 1], // A prop-index write, not a field assignment.
    ['props[attribute] = { type: "string", value };', 0, 1],
    ['delete node.props[key];', 0, 1],
  ];
  for (const [text, mutations, propIndexWrites] of cases) {
    assert.deepEqual(countTreeEdits(text), { mutations, propIndexWrites }, text);
  }
});

test('comparisons, arrows, DOM and CMS objects, and comments do not count', () => {
  const ignored = [
    'if (node.kind === "text") {}',
    'const pick = (node) => node.value => 1;',
    'event.currentTarget.value = "";',
    'master.gain.value = 0.06;',
    'field.value = describe(field);',
    '// node.value = next;',
    ' * node.children.push(x)',
  ];
  for (const text of ignored) {
    assert.deepEqual(countTreeEdits(text), { mutations: 0, propIndexWrites: 0 }, text);
  }
});

test('wrapper call sites exclude their own definitions', () => {
  const text = [
    'function mutateModel(update) {}',
    'const applyEdit = useCallback(async () => {});',
    'mutateModel((model) => model);',
    'void applyEdit(rule, () => {});',
    'void applyEdit(rule, () => {});',
  ].join('\n');
  assert.deepEqual(countWrapperCalls(text), { mutateModelCalls: 1, applyEditCalls: 2 });
});
