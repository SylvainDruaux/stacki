// Goal: the renderer shows the engine's capability for the node it selects
// (plan §6, step 7) — the same classification the projection makes, so a node
// the engine treats as repeated, opaque or unsupported says so beside its
// panels instead of looking plainly editable.
// Method: parse corpus pages with the real parser, bundle src/nodeCapability.ts,
// and compare its answer for every node with the projection's capability at the
// same path (shared/source-projection.ts run on the same bytes). Markdown pages
// and absent ids are the negative space.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'node-capability');
fs.mkdirSync(buildDir, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'nodeCapability.ts')],
  outdir: buildDir,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { nodeCapability, capabilityNeedsNotice } = require(path.join(buildDir, 'nodeCapability.js'));
const { parsePage } = require('../dist/electron/astroParser.js');
const { parseMarkdownPage } = require('../dist/electron/markdownParser.js');
const { projectPage } = require('../dist/shared/source-projection.js');
const { CAPABILITIES } = require('../dist/shared/capability.js');

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

test('Markdown is unsupported, never read-only; an absent node has no capability', () => {
  const parsed = parseMarkdownPage('# Title\n\nSome text.\n');
  assert.ok(parsed.editable, 'the markdown page parses');
  assert.ok(parsed.model.nodes.length > 0);
  for (const node of parsed.model.nodes) {
    assert.equal(nodeCapability(parsed.model, node.id), 'unsupported');
  }
  const text = fs.readFileSync(path.join(corpus, 'map-loop.astro'), 'utf8');
  const astro = parsePage(text);
  assert.ok(astro.editable);
  assert.equal(nodeCapability(astro.model, 'no-such-node'), undefined);
});
