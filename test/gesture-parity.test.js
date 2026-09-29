// Goal: every gesture step 6 ships through the engine means what it meant
// through the legacy path (plan §11 step 6: "parity vs the legacy path for
// that gesture"). The legacy path applies the gesture to the page model and
// reprints the whole file; the engine plans the gesture's edit requests as
// splices on the bytes. Both results must parse to the same page — and the
// engine's may differ from the input only where it spliced.
// Method: for every node of every `.astro` fixture (corpus, round-trip,
// editor-core), each shipped gesture runs both ways: the adapter's effect
// (src/editGestures.ts) on the parsed model, reprinted by serializePage; and
// the adapter's requests (src/pageEdits.ts, nodeRefIn) through main's
// translator (electron/editRequests.ts) and the shipping planner, a later
// request of one gesture rebased through the earlier ones as the host does
// (shared/rebase.ts). The two results are parsed and compared with layout
// metadata removed (ids, source ranges, and the fields that only remember
// how a tag was written); text is compared up to whitespace runs, which the
// reprint reflows. Gestures whose requests cannot be stated are counted, not
// compared: they still take the legacy path in the app. Byte-identical
// results are counted and reported; a model difference fails.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { parsePage, serializePage } = require('../dist/electron/astroParser.js');
const { buildEditIntent } = require('../dist/electron/editRequests.js');
const { toDigest, toFilePath, toIntentId } = require('../dist/shared/brand.js');
const { toIntent } = require('../dist/shared/intent.js');
const { parsePageResult } = require('../dist/shared/page-node.js');
const { planIntent } = require('../dist/shared/planner.js');
const { rebaseIntent, minimalSplices } = require('../dist/shared/rebase.js');
const { createSnapshot } = require('../dist/shared/snapshot.js');
const { projectPage } = require('../dist/shared/source-projection.js');
const { decodeUtf8, encodeUtf8 } = require('../dist/shared/span.js');
const { applySplices } = require('../dist/shared/splice.js');

const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'gesture-parity');
fs.mkdirSync(buildDir, { recursive: true });
esbuild.buildSync({
  entryPoints: ['pageEdits', 'editGestures'].map((name) =>
    path.join(__dirname, '..', 'src', `${name}.ts`),
  ),
  outdir: buildDir,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const edits = require(path.join(buildDir, 'pageEdits.js'));
const gestures = require(path.join(buildDir, 'editGestures.js'));

const DIRECTORIES = ['test/corpus', 'test/fixtures/round-trip', 'test/fixtures/editor-core'];
const BOM = '﻿';
const hash = (bytes) => toDigest(crypto.createHash('sha256').update(bytes).digest('hex'));

function snapshotOf(file, text) {
  const projection = projectPage(text, parsePageResult(parsePage(text, { locs: true })));
  return createSnapshot({ path: toFilePath(file), bytes: encodeUtf8(text), projection }, hash);
}

function pages() {
  return DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.astro'))
      .sort()
      .map((name) => ({
        name: `${directory}/${name}`,
        text: fs.readFileSync(path.join(directory, name), 'utf8'),
      })),
  );
}

function nodesOf(model) {
  const found = [];
  const pending = [...model.nodes];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    found.push(node);
    if (Array.isArray(node.children) && node.kind !== 'chunk-group') {
      pending.push(...node.children);
    }
  }
  return found;
}

// What the page says, without what only records how it was written.
const LAYOUT = new Set([
  'id',
  'start',
  'end',
  'attrSpans',
  'attrSource',
  'attrOrder',
  'source',
  'closeSource',
  'headSource',
  'blankBefore',
  'blankAfter',
  'tightClose',
  'bodyStart',
  'frontmatterLayout',
  'trailingBlank',
  'extraFrontmatterSpaced',
  'frontmatterLead',
]);
function meaning(value) {
  if (Array.isArray(value)) {
    // Whitespace-only text between nodes is layout too: the reprint decides it.
    return value
      .filter((item) => !(item && item.kind === 'text' && /^\s*$/.test(item.value)))
      .map(meaning);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (!LAYOUT.has(key)) {
        // Defined, not assigned: an attribute may be named `__proto__`.
        Object.defineProperty(out, key, { value: meaning(value[key]), enumerable: true });
      }
    }
    return out;
  }
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
}

/** Plan a gesture's requests the way the host does: each against the bytes
 * the previous one left, rebased from the origin through their splices. */
function engine(file, snapshot, requests) {
  let current = snapshot;
  const log = [];
  for (const [index, { edit }] of requests.entries()) {
    const draft = buildEditIntent(edit, snapshot);
    if (!draft.ok) {
      return { tag: 'rejected', reason: draft.error };
    }
    let intent = toIntent({
      id: toIntentId(`parity-${index}`),
      file: snapshot.path,
      authoredChecksum: snapshot.checksum,
      ...draft.value,
    });
    if (log.length > 0) {
      const rebased = rebaseIntent(intent, log, current);
      if (!rebased.ok) {
        return { tag: 'rejected', reason: rebased.error };
      }
      intent = rebased.value;
    }
    const planned = planIntent({ authored: current, current }, intent);
    if (!planned.ok) {
      return { tag: 'rejected', reason: planned.error };
    }
    const bytes = applySplices(current.bytes, planned.value.splices);
    const decoded = decodeUtf8(bytes);
    assert.ok(decoded.ok);
    const next = snapshotOf(file, decoded.value);
    log.push({
      from: current.checksum,
      to: next.checksum,
      splices: minimalSplices(planned.value.splices),
    });
    current = next;
  }
  return { tag: 'applied', text: Buffer.from(current.bytes).toString('utf8') };
}

function legacy(text, model, gesture) {
  const printed = serializePage(gesture.apply(structuredClone(model)));
  return text.startsWith(BOM) ? `${BOM}${printed}` : printed;
}

/** Run one gesture family over the corpus; returns the tally. */
function sweep(label, casesFor) {
  const tally = { compared: 0, identical: 0, legacyOnly: 0, refused: new Map() };
  for (const page of pages()) {
    const parsed = parsePage(page.text, { locs: true });
    if (!parsed.editable) {
      continue;
    }
    const model = parsed.model;
    const snapshot = snapshotOf(`/project/${path.basename(page.name)}`, page.text);
    const origin = { checksum: snapshot.checksum, model };
    for (const node of nodesOf(model)) {
      for (const gesture of casesFor(node, model)) {
        const requests = gesture.request((id) => edits.nodeRefIn(origin, id));
        if (requests === undefined) {
          tally.legacyOnly += 1;
          continue;
        }
        const where = `${page.name} ${node.id} ${label}`;
        const result = engine(snapshot.path, snapshot, requests);
        if (result.tag === 'rejected') {
          tally.refused.set(result.reason, (tally.refused.get(result.reason) ?? 0) + 1);
          continue;
        }
        const reprinted = legacy(page.text, model, gesture);
        const mine = parsePage(result.text, { locs: false });
        const theirs = parsePage(reprinted, { locs: false });
        assert.ok(mine.editable, `${where}: the engine's result parses`);
        assert.ok(theirs.editable, `${where}: the legacy result parses`);
        assert.deepEqual(meaning(mine.model), meaning(theirs.model), `${where}: same page`);
        tally.compared += 1;
        tally.identical += result.text === reprinted ? 1 : 0;
      }
    }
  }
  return tally;
}

function report(t, tally) {
  const refused = [...tally.refused].map(([reason, count]) => `${count} ${reason}`).join(', ');
  t.diagnostic(
    `${tally.compared} compared, ${tally.identical} byte-identical, ` +
      `${tally.legacyOnly} legacy-only, refused: ${refused || 'none'}`,
  );
}

const TAGS = new Set(['element', 'component', 'raw']);
const stringProps = (node) =>
  Object.entries(node.props ?? {}).filter(([, value]) => value && value.type === 'string');
const options = { coalesceKey: null, urgency: true };

test('parity, attribute: set a new attribute, set and remove each string one', (t) => {
  const tally = sweep('attribute', (node) => {
    if (!TAGS.has(node.kind)) {
      return [];
    }
    return [
      gestures.propsGesture(node.id, { 'data-step': { type: 'string', value: '6' } }, options),
      ...stringProps(node).flatMap(([name]) => [
        gestures.propsGesture(node.id, { [name]: { type: 'string', value: 'x y' } }, options),
        gestures.propsGesture(node.id, { [name]: undefined }, options),
      ]),
      gestures.propsGesture(
        node.id,
        { 'data-a': { type: 'string', value: 'a' }, 'data-b': { type: 'string', value: 'b' } },
        options,
      ),
    ];
  });
  report(t, tally);
  assert.ok(tally.compared > 300, `the sweep compares many real gestures (${tally.compared})`);
});

test('parity, prop: expressions and bare props, new and replacing any value', (t) => {
  const tally = sweep('prop', (node) => {
    if (!TAGS.has(node.kind)) {
      return [];
    }
    const named = Object.entries(node.props ?? {}).filter(([, value]) => value.type !== 'spread');
    return [
      gestures.propsGesture(
        node.id,
        { items: { type: 'expr', value: 'list.slice(0, 3)' } },
        options,
      ),
      gestures.propsGesture(node.id, { hidden: { type: 'bare' } }, options),
      ...named.flatMap(([name]) => [
        gestures.propsGesture(node.id, { [name]: { type: 'expr', value: 'value ?? 1' } }, options),
        gestures.propsGesture(node.id, { [name]: { type: 'bare' } }, options),
        gestures.propsGesture(node.id, { [name]: { type: 'string', value: 'plain' } }, options),
      ]),
    ];
  });
  report(t, tally);
  assert.ok(tally.compared > 500, `the sweep compares many real gestures (${tally.compared})`);
});
