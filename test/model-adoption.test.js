// Goal: pin the id-adoption contract that keeps editor focus stable across
// saves (issue #29) — a fresh parse keeps its structure and source ranges but
// borrows the session's ids wherever the two trees agree on the same slot.
//
// Methodology: unit cases over hand-built trees cover the pairing rule and its
// negative space (kind, name, children-shape mismatches, tails, bounds); a
// parser round trip covers the real save path end to end. Inputs must never be
// mutated.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('./renderer-module');

const { adoptNodeIds } = loadRenderer('modelAdoption.ts');
const { parsePage, serializePage } = require('../dist/electron/astroParser.js');

function text(id, value) {
  return { kind: 'text', id, value };
}

function element(id, name, children, props) {
  const node = { kind: 'element', id, name, children };
  if (props !== undefined) {
    node.props = props;
  }
  return node;
}

function ids(nodes) {
  const found = [];
  const walk = (list) => {
    for (const node of list) {
      found.push(node.id);
      if (Array.isArray(node.children)) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return found;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nest(depth, baseId) {
  let node = text(`${baseId}-leaf`, 'deep');
  for (let level = 0; level < depth; level += 1) {
    node = element(`${baseId}-${level}`, 'div', [node]);
  }
  return [node];
}

test('identical trees adopt every local id without mutating the inputs', () => {
  const local = [element('n1', 'div', [text('n2', 'hi'), element('n3', 'p', [text('n4', 'x')])])];
  const fresh = [element('n7', 'div', [text('n8', 'hi'), element('n9', 'p', [text('n10', 'x')])])];
  const localBefore = deepClone(local);
  const freshBefore = deepClone(fresh);
  const adopted = adoptNodeIds(local, fresh);
  assert.deepEqual(ids(adopted), ['n1', 'n2', 'n3', 'n4']);
  assert.deepEqual(deepClone(local), localBefore, 'local input mutated');
  assert.deepEqual(deepClone(fresh), freshBefore, 'fresh input mutated');
});

test('the per-keystroke case: changed text adopts the session id and keeps the typed content', () => {
  const local = [element('n1', 'h1', [text('n2', 'Hel')])];
  const fresh = [element('n5', 'h1', [text('n6', 'Hello')])];
  const adopted = adoptNodeIds(local, fresh);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].id, 'n1');
  assert.equal(adopted[0].children[0].id, 'n2');
  assert.equal(adopted[0].children[0].value, 'Hello');
});

test('a kind mismatch keeps fresh ids there while aligned siblings still adopt', () => {
  const local = [element('n1', 'div', []), element('n2', 'p', [text('n3', 'keep')])];
  const fresh = [text('n8', 'new'), element('n9', 'p', [text('n10', 'keep')])];
  // Position 1 pairs element-with-element (same kind, same name), so it adopts
  // the session id; only the mismatched slot keeps its fresh id.
  const adopted = adoptNodeIds(local, fresh);
  assert.deepEqual(ids(adopted), ['n8', 'n2', 'n3']);
  assert.equal(adopted[1].children[0].value, 'keep');
});

test('a name mismatch keeps fresh ids so an inserted element cannot borrow a displaced id', () => {
  const local = [element('n1', 'h1', [text('n2', 'title')])];
  const fresh = [element('n5', 'div', [text('n6', 'title')])];
  assert.deepEqual(ids(adoptNodeIds(local, fresh)), ['n5', 'n6']);
});

test('a children-shape mismatch (self-closing vs paired) is not the same slot', () => {
  const local = [element('n1', 'br', [text('n2', 'was paired')])];
  const fresh = [element('n5', 'br', null)];
  assert.deepEqual(ids(adoptNodeIds(local, fresh)), ['n5']);
});

test('components pair by name like elements', () => {
  const card = [{ kind: 'component', id: 'n1', name: 'Card', children: null }];
  assert.deepEqual(ids(adoptNodeIds(card, [{ kind: 'component', id: 'n5', name: 'Card', children: null }])), ['n1']);
  assert.deepEqual(ids(adoptNodeIds(card, [{ kind: 'component', id: 'n5', name: 'Tabs', children: null }])), ['n5']);
});

test('a longer fresh list is genuinely new nodes: the tail keeps fresh ids', () => {
  const local = [element('n1', 'div', [text('n2', 'a')])];
  const fresh = [element('n5', 'div', [text('n6', 'a')]), element('n7', 'p', [text('n8', 'b')])];
  assert.deepEqual(ids(adoptNodeIds(local, fresh)), ['n1', 'n2', 'n7', 'n8']);
});

test('a longer local list means removed nodes: the shared prefix adopts without crashing', () => {
  const local = [element('n1', 'div', [text('n2', 'a')]), element('n3', 'p', [text('n4', 'b')])];
  const fresh = [element('n5', 'div', [text('n6', 'a')])];
  assert.deepEqual(ids(adoptNodeIds(local, fresh)), ['n1', 'n2']);
});

test('deep trees adopt at every level below the contract depth bound', () => {
  const local = nest(30, 'n1');
  const fresh = nest(30, 'n8');
  assert.deepEqual(ids(adoptNodeIds(local, fresh)), ids(local));
});

test('a tree deeper than LIMITS.treeDepthMax asserts', () => {
  assert.throws(() => adoptNodeIds(nest(64, 'n1'), nest(64, 'n8')), /tree depth/);
});

test('a list longer than LIMITS.treeNodesMax asserts', () => {
  const huge = Array.from({ length: 20_001 }, (_, index) => text(`n${index + 1}`, 'x'));
  assert.throws(() => adoptNodeIds(huge, [text('n1', 'x')]), /treeNodesMax/);
});

test('nameless kinds (map loops) pair on kind alone, like text', () => {
  const local = [{ kind: 'map', id: 'n1', head: 'project of projects', children: [text('n2', 'x')] }];
  const fresh = [{ kind: 'map', id: 'n5', head: 'post of posts', children: [text('n6', 'y')] }];
  const adopted = adoptNodeIds(local, fresh);
  assert.deepEqual(ids(adopted), ['n1', 'n2']);
  assert.equal(adopted[0].head, 'post of posts');
});

test('list-level markdown metadata survives adoption from the fresh list', () => {
  // A fresh markdown parse carries mdTrailingBlanks on the top-level list;
  // adopting must not drop it or serialization round trips would drift.
  const local = [text('n1', 'body')];
  const fresh = Object.assign([text('n2', 'body')], { mdTrailingBlanks: 1 });
  const adopted = adoptNodeIds(local, fresh);
  assert.deepEqual(ids(adopted), ['n1']);
  assert.equal(adopted.mdTrailingBlanks, 1);
});

test('a parser round trip with a panel edit keeps every session id', () => {
  // The real save path: parse → panel edit (text value only) → serialize →
  // re-parse → adopt. Every node keeps the session id, and the typed content
  // is what the adopted tree carries.
  const source = [
    '---',
    "import Card from '../components/Card.astro';",
    '---',
    '<section class="wrap">',
    '  <h1>Hello</h1>',
    '  <Card>',
    '    <p>Body text</p>',
    '  </Card>',
    '  <img src="a.png" />',
    '</section>',
    '',
  ].join('\n');
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true, 'fixture page must parse');
  const local = parsed.model;
  const walk = (nodes, visit) => {
    for (const node of nodes) {
      visit(node);
      if (Array.isArray(node.children)) {
        walk(node.children, visit);
      }
    }
  };
  walk(local.nodes, (node) => {
    if (node.kind === 'text' && node.value === 'Hello') {
      node.value = 'Hello!';
    }
  });

  const fresh = parsePage(serializePage(local));
  assert.equal(fresh.editable, true, 'round-tripped page must parse');
  assert.notDeepEqual(ids(fresh.model.nodes), ids(local.nodes), 'parser ids must regenerate');

  const adopted = adoptNodeIds(local.nodes, fresh.model.nodes);
  assert.deepEqual(ids(adopted), ids(local.nodes));
  const titles = [];
  walk(adopted, (node) => {
    if (node.kind === 'text') {
      titles.push(node.value);
    }
  });
  assert.ok(titles.includes('Hello!'), 'adopted tree carries the fresh content');
});