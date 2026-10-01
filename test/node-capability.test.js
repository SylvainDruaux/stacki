// Goal: the renderer shows the engine's capability for the node it selects
// (plan §6, step 7) — the same classification the projection makes, so a node
// the engine treats as repeated, opaque or unsupported says so beside its
// panels instead of looking plainly editable.
// Method: parse corpus pages with the real parser, bundle src/editor/nodeCapability.ts,
// and compare its answer for every node with the projection's capability at the
// same path (shared/source-projection.ts run on the same bytes), for .astro
// corpus pages and Markdown and MDX pages alike. Absent ids are the negative
// space.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('./helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/node-capability');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  entryPoints: [repoPath('src/editor/nodeCapability.ts')],
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { nodeCapability, capabilityNeedsNotice } = require(
  path.join(buildDirectory, 'nodeCapability.js'),
);
const { parsePage } = require('#dist/electron/astroParser.js');
const { parseMarkdownPage } = require('#dist/electron/markdownParser.js');
const { projectPage } = require('#dist/shared/source-projection.js');
const { CAPABILITIES } = require('#dist/shared/capability.js');

const corpus = path.join(__dirname, 'corpus');

function nodesWithPaths(roots) {
  const out = [];
  const stack = roots.map((node, index) => ({ node, path: [index] })).reverse();
  while (stack.length > 0) {
    const entry = stack.pop();
    out.push(entry);
    const children = entry.node.children ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], path: [...entry.path, index] });
    }
  }
  return out;
}

test('every node of every corpus page gets the projection capability', () => {
  let compared = 0;
  for (const name of fs.readdirSync(corpus).filter((file) => file.endsWith('.astro'))) {
    const text = fs.readFileSync(path.join(corpus, name), 'utf8');
    const located = parsePage(text, { locs: true });
    if (!located.editable) {
      continue;
    }
    const projection = projectPage(text, located);
    assert.equal(projection.tag, 'valid', name);
    const byPath = new Map(projection.nodes.map((node) => [node.path.join('/'), node.capability]));
    for (const { node, path: at } of nodesWithPaths(located.model.nodes)) {
      const expected = byPath.get(at.join('/'));
      if (expected === undefined) {
        continue; // The projection has no entry for a synthetic node.
      }
      assert.equal(nodeCapability(located.model, node.id), expected, `${name} ${at.join('/')}`);
      compared++;
    }
  }
  assert.ok(compared > 200, `compared ${compared} nodes`);
});

test('a node a loop repeats is repeated-source-node and says so', () => {
  const text = fs.readFileSync(path.join(corpus, 'map-loop.astro'), 'utf8');
  const parsed = parsePage(text);
  assert.ok(parsed.editable);
  const [list] = parsed.model.nodes;
  const loop = list.children[0];
  const item = loop.children[0];
  assert.equal(nodeCapability(parsed.model, list.id), 'editable');
  assert.equal(nodeCapability(parsed.model, loop.id), 'editable', 'the loop itself is one node');
  assert.equal(nodeCapability(parsed.model, item.id), 'repeated-source-node');
  assert.equal(nodeCapability(parsed.model, item.children[0].id), 'repeated-source-node');
  assert.equal(capabilityNeedsNotice('repeated-source-node'), true);
  assert.equal(capabilityNeedsNotice('editable'), false);
});

test('only plain editable nodes go without a notice', () => {
  assert.deepEqual(
    CAPABILITIES.filter((capability) => !capabilityNeedsNotice(capability)),
    ['editable'],
  );
});

test('a Markdown page gets its projection capability; an absent node has none', () => {
  // Step 10: Markdown and MDX are classified like any page — a table or an ESM
  // block is kept verbatim, everything else is editable.
  const roundTrip = path.join(__dirname, 'fixtures', 'round-trip');
  let compared = 0;
  for (const name of ['post.md', 'components.mdx']) {
    const text = fs.readFileSync(path.join(roundTrip, name), 'utf8');
    const parsed = parseMarkdownPage(text, { mdx: name.endsWith('.mdx') });
    assert.ok(parsed.editable, `${name} parses`);
    const projection = projectPage(text, parsed);
    assert.equal(projection.tag, 'valid', name);
    const byPath = new Map(projection.nodes.map((node) => [node.path.join('/'), node.capability]));
    for (const { node, path: at } of nodesWithPaths(parsed.model.nodes)) {
      const expected = byPath.get(at.join('/'));
      assert.ok(expected !== undefined, `${name} ${at.join('/')} is projected`);
      assert.equal(nodeCapability(parsed.model, node.id), expected, `${name} ${at.join('/')}`);
      compared++;
    }
  }
  assert.ok(compared > 40, `compared ${compared} nodes`);
  const table = parseMarkdownPage('| a |\n|---|\n| 1 |\n');
  assert.ok(table.editable);
  assert.equal(nodeCapability(table.model, table.model.nodes[0].id), 'read-only-opaque');
  const text = fs.readFileSync(path.join(corpus, 'map-loop.astro'), 'utf8');
  const astro = parsePage(text);
  assert.ok(astro.editable);
  assert.equal(nodeCapability(astro.model, 'no-such-node'), undefined);
});
