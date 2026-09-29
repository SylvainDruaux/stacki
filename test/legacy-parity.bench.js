// Step 5's single-gesture parallel run (plan §11 step 5, §15 "behavior
// preservation proven by parity"): the same gesture through the legacy write
// path and through the document actors must leave identical files.
//
// Method. The legacy path is not re-implemented here: it is the real main
// process of the commit before step 5 (a881aee), compiled in a scratch
// worktree, loaded by the windowless harness beside the current build's. For
// every fixture, two copies of one small project are made, one per build, and
// each gesture is run through the real IPC handler of each; afterwards every
// file of the two projects is compared byte for byte, and the two replies are
// compared by their outcome (`ok` and checksum, or the error code). Messages
// may differ in wording and are not compared.
//
// Gestures, each once per fixture:
//   save      page:read, one attribute (or text) edit on the model, page:write
//   raw       page:writeRaw of the source with a line appended
//   stale     an outside edit, then page:write against the old checksum
//   noop      page:write of the model as read
// and once per run: a chunk page whose edit lands in its `.html` chunk, a
// stylesheet save (style:writeFile), a code-window save (src:writeText), and
// the component:editProperties batch (a prop rename across a component and
// two consumers, and an option rename).
//
// Run: build the legacy main first (see the tracker, step 5), then
//   STACKI_LEGACY_DIST=<worktree>/dist node test/legacy-parity.bench.js
// Prints one line per difference and a summary; exits 1 on any difference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURE_DIRECTORIES = ['test/corpus', 'test/fixtures/round-trip', 'test/fixtures/editor-core'];
const PAGE_EXTENSIONS = /\.(astro|md|mdx)$/;

async function main() {
  const legacyDist = process.env.STACKI_LEGACY_DIST;
  assert.ok(legacyDist, 'STACKI_LEGACY_DIST names the legacy build (a881aee) dist folder');
  const { mainHarness } = await import('./contracts/main-harness.ts');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-parity-'));
  const builds = {
    legacy: mainHarness(path.join(scratch, 'user-legacy'), undefined, path.join(legacyDist, 'electron', 'main.js')),
    actor: mainHarness(path.join(scratch, 'user-actor')),
  };
  const tally = { gestures: 0, identical: 0, differences: [], outcomes: {} };
  try {
    for (const fixture of fixtures()) {
      for (const gesture of PAGE_GESTURES) {
        await compare(tally, builds, scratch, `${gesture.name} ${fixture.name}`, (root) => {
          const page = path.join(root, 'src', 'pages', fixture.name);
          fs.writeFileSync(page, fixture.bytes);
          return (harness) => gesture.run(harness, page);
        });
      }
    }
    for (const scenario of PROJECT_SCENARIOS) {
      await compare(tally, builds, scratch, scenario.name, scenario.setup);
    }
  } finally {
    builds.legacy.dispose();
    builds.actor.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  for (const difference of tally.differences) {
    console.log(`DIFFERENT ${difference}`);
  }
  for (const [key, count] of Object.entries(tally.outcomes).sort()) {
    console.log(`  ${String(count).padStart(3)} × ${key}`);
  }
  console.log(
    `parity: ${tally.identical} of ${tally.gestures} gestures identical ` +
      `(${fixtures().length} fixtures × ${PAGE_GESTURES.length} page gestures + ` +
      `${PROJECT_SCENARIOS.length} project scenarios)`,
  );
  process.exitCode = tally.differences.length === 0 ? 0 : 1;
}

function fixtures() {
  return FIXTURE_DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => PAGE_EXTENSIONS.test(name))
      .filter((name) => !name.includes('.expected.'))
      .sort()
      .map((name) => ({ name, bytes: fs.readFileSync(path.join(directory, name)) })),
  );
}

// Run one gesture on twin projects and compare what it left behind.
async function compare(tally, builds, scratch, name, setup) {
  tally.gestures += 1;
  const results = {};
  const trees = {};
  let changed = false;
  for (const build of ['legacy', 'actor']) {
    const root = path.join(scratch, `${build}-${tally.gestures}`);
    fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
    const run = setup(root);
    const before = tree(root);
    results[build] = summarize(await run(builds[build]));
    trees[build] = tree(root);
    changed = changed || !sameTree(before, trees[build]);
  }
  // What the gesture did, so a run where both sides fail alike cannot pass
  // unnoticed: its outcome, and whether it changed any file.
  const outcome = results.legacy?.ok === false ? results.legacy.code : 'ok';
  const key = `${name.split(' ')[0]} ${outcome}, ${changed ? 'bytes changed' : 'bytes unchanged'}`;
  tally.outcomes[key] = (tally.outcomes[key] ?? 0) + 1;
  const problems = [];
  if (JSON.stringify(results.legacy) !== JSON.stringify(results.actor)) {
    problems.push(`reply ${JSON.stringify(results.legacy)} vs ${JSON.stringify(results.actor)}`);
  }
  const names = new Set([...trees.legacy.keys(), ...trees.actor.keys()]);
  for (const file of names) {
    const legacy = trees.legacy.get(file);
    const actor = trees.actor.get(file);
    if (legacy === undefined || actor === undefined || !legacy.equals(actor)) {
      problems.push(`file ${file}: ${legacy?.length ?? 'absent'} vs ${actor?.length ?? 'absent'} bytes`);
    }
  }
  if (problems.length === 0) {
    tally.identical += 1;
  } else {
    tally.differences.push(`${name}: ${problems.join('; ')}`);
  }
}

function sameTree(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  return [...left].every(([file, bytes]) => right.get(file)?.equals(bytes) === true);
}

// What a reply says, without its wording: the outcome and the checksum.
function summarize(reply) {
  if (reply === undefined || reply === null || typeof reply !== 'object') {
    return reply ?? null;
  }
  if (reply.ok === false) {
    return { ok: false, code: reply.error?.code, diskChecksum: reply.error?.diskChecksum };
  }
  return { ok: reply.ok, checksum: reply.checksum };
}

// Every file under root, relative path → bytes. The write protocol's own
// temporary and lock files would be differences too, and are not skipped.
function tree(root) {
  const files = new Map();
  const pending = [root];
  for (let visited = 0; visited < pending.length; visited++) {
    assert.ok(visited < 10_000, 'a parity project is small');
    for (const entry of fs.readdirSync(pending[visited], { withFileTypes: true })) {
      const full = path.join(pending[visited], entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        files.set(path.relative(root, full), fs.readFileSync(full));
      }
    }
  }
  return files;
}

// --- Gestures ---------------------------------------------------------------------

const PAGE_GESTURES = [
  {
    name: 'save',
    run: async (harness, page) => {
      const read = await harness.invoke('page:read', page);
      if (!read.editable) {
        return harness.invoke('page:writeRaw', { pagePath: page, source: read.source, baseChecksum: read.checksum });
      }
      const model = structuredClone(read.model);
      editOnce(model.nodes);
      return harness.invoke('page:write', { pagePath: page, model, baseChecksum: read.checksum });
    },
  },
  {
    name: 'raw',
    run: async (harness, page) => {
      const read = await harness.invoke('page:read', page);
      const source = `${read.source}\n<!-- parity -->\n`;
      return harness.invoke('page:writeRaw', { pagePath: page, source, baseChecksum: read.checksum });
    },
  },
  {
    name: 'stale',
    run: async (harness, page) => {
      const read = await harness.invoke('page:read', page);
      fs.appendFileSync(page, '\n<!-- outside -->\n');
      const payload = { pagePath: page, model: read.model, baseChecksum: read.checksum };
      return read.editable
        ? harness.invoke('page:write', payload)
        : harness.invoke('page:writeRaw', { pagePath: page, source: read.source, baseChecksum: read.checksum });
    },
  },
  {
    name: 'noop',
    run: async (harness, page) => {
      const read = await harness.invoke('page:read', page);
      if (!read.editable) {
        return harness.invoke('page:writeRaw', { pagePath: page, source: read.source, baseChecksum: read.checksum });
      }
      return harness.invoke('page:write', { pagePath: page, model: read.model, baseChecksum: read.checksum });
    },
  },
];

// The single gesture the visual editor makes most: change one string attribute,
// or, on a page without one, one run of text. Depth-first, first match only.
function editOnce(nodes) {
  const pending = [...nodes];
  const texts = [];
  for (let visited = 0; visited < pending.length; visited++) {
    assert.ok(visited < 100_000, 'a fixture tree is bounded');
    const node = pending[visited];
    for (const [name, value] of Object.entries(node.props ?? {})) {
      if (value?.type === 'string') {
        node.props[name] = { type: 'string', value: 'Parity edit' };
        return;
      }
    }
    if (node.kind === 'text') {
      texts.push(node);
    }
    pending.push(...(Array.isArray(node.children) ? node.children : []));
  }
  if (texts.length > 0) {
    texts[0].value = `${texts[0].value} parity`;
  }
}

const COMPONENT = [
  '---',
  'interface Props {',
  '  title: string;',
  "  variant?: 'solid' | 'outline';",
  '}',
  "const { title, variant = 'solid' } = Astro.props;",
  '---',
  '<article class={variant}><h2>{title}</h2></article>',
  '',
].join('\n');

const PROJECT_SCENARIOS = [
  {
    name: 'chunk page, edit inside its .html chunk',
    setup: (root) => {
      const page = path.join(root, 'src', 'pages', 'chunked.astro');
      fs.writeFileSync(page, "---\nimport hero from './hero.html?raw';\n---\n<Fragment set:html={hero} />\n");
      fs.writeFileSync(path.join(root, 'src', 'pages', 'hero.html'), '<section>\n  <h1 class="title">Hi</h1>\n</section>\n');
      return async (harness) => {
        const read = await harness.invoke('page:read', page);
        const model = structuredClone(read.model);
        editOnce(model.nodes);
        return harness.invoke('page:write', { pagePath: page, model, baseChecksum: read.checksum });
      };
    },
  },
  {
    name: 'stylesheet save (style:writeFile)',
    setup: (root) => {
      const css = path.join(root, 'src', 'styles', 'site.css');
      fs.mkdirSync(path.dirname(css), { recursive: true });
      fs.writeFileSync(css, ':root {\n  --brand: red;\n}\n');
      return async (harness) => {
        await harness.invoke('watch:start', root);
        const reply = await harness.invoke('style:writeFile', { filePath: css, css: ':root {\n  --brand: blue;\n}\n' });
        harness.call('stopWatchingProject');
        return reply;
      };
    },
  },
  {
    name: 'code window save (src:writeText)',
    setup: (root) => {
      const file = path.join(root, 'src', 'pages', 'index.astro');
      fs.writeFileSync(file, '<h1>Old</h1>\n');
      return async (harness) => {
        await harness.invoke('watch:start', root);
        const reply = await harness.invoke('src:writeText', { projectPath: root, rel: 'src/pages/index.astro', text: '<h1>New</h1>\n' });
        harness.call('stopWatchingProject');
        return reply;
      };
    },
  },
  ...['rename', 'options'].map((kind) => ({
    name: `component:editProperties ${kind}`,
    setup: (root) => {
      const component = path.join(root, 'src', 'components', 'Card.astro');
      fs.mkdirSync(path.dirname(component), { recursive: true });
      fs.writeFileSync(component, COMPONENT);
      const consumer = "---\nimport Card from '../components/Card.astro';\n---\n";
      fs.writeFileSync(path.join(root, 'src', 'pages', 'a.astro'), `${consumer}<Card title="A" variant="solid" />\n`);
      fs.writeFileSync(path.join(root, 'src', 'pages', 'b.astro'), `${consumer}<Card title="B" />\n`);
      return async (harness) => {
        const properties = await harness.invoke('component:properties', { projectPath: root, file: component });
        assert.equal(properties.ok, true, JSON.stringify(properties));
        const byName = (name) => properties.value.properties.find((property) => property.name === name);
        const change = kind === 'rename'
          ? { kind: 'save', originalName: 'title', property: { ...byName('title'), name: 'heading' } }
          : {
              kind: 'save',
              originalName: 'variant',
              property: { ...byName('variant'), type: "'filled' | 'outline'", defaultValue: "'filled'" },
              optionRenames: [{ from: "'solid'", to: "'filled'" }],
            };
        const reply = await harness.invoke('component:editProperties', {
          projectPath: root,
          file: component,
          source: fs.readFileSync(component, 'utf8'),
          change,
        });
        return reply.ok ? { ok: true, checksum: JSON.stringify(reply.value) } : { ok: false, error: reply.error };
      };
    },
  })),
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
