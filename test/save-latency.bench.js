// Step 5's cost on the save path: `page:write` through the legacy build
// (a881aee) and through the document actors, on the same machine, same files,
// interleaved sample by sample. Not a gate: step 5 registered no latency
// threshold; this records what the actor protocol (a projection of the base on
// first read, the candidate's projection, the lock, the re-read and the
// verifying read) costs against the step-0 guarded path.
//
// Run: STACKI_LEGACY_DIST=<worktree>/dist node test/save-latency.bench.js
// after `npm run fixtures:large`. 20 samples per series after 2 warm-ups,
// nearest-rank p50 and p95, milliseconds; the load average is printed first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const SAMPLES = 20;
const WARMUPS = 2;
const FILES = [
  ['corpus max', 'test/corpus/why-a-loop-exists.astro'],
  ['nodes-25', 'test/fixtures/large/nodes-25.astro'],
  ['nodes-50', 'test/fixtures/large/nodes-50.astro'],
];

async function main() {
  const legacyDist = process.env.STACKI_LEGACY_DIST;
  assert.ok(legacyDist, 'STACKI_LEGACY_DIST names the legacy build dist folder');
  console.log(`load average (1 min) at start: ${os.loadavg()[0].toFixed(2)}`);
  const { mainHarness } = await import('./contracts/main-harness.ts');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-latency-'));
  const builds = {
    legacy: mainHarness(path.join(scratch, 'u-legacy'), undefined, path.join(legacyDist, 'electron', 'main.js')),
    actor: mainHarness(path.join(scratch, 'u-actor')),
  };
  try {
    for (const [label, source] of FILES) {
      const series = { legacy: [], actor: [] };
      const pages = {};
      for (const build of ['legacy', 'actor']) {
        pages[build] = path.join(scratch, `${build}-${path.basename(source)}`);
        fs.copyFileSync(source, pages[build]);
      }
      for (let sample = 0; sample < SAMPLES + WARMUPS; sample++) {
        for (const build of sample % 2 === 0 ? ['legacy', 'actor'] : ['actor', 'legacy']) {
          const elapsed = await saveOnce(builds[build], pages[build], sample);
          if (sample >= WARMUPS) {
            series[build].push(elapsed);
          }
        }
      }
      const report = (values) => `p50 ${rank(values, 0.5).toFixed(1)}  p95 ${rank(values, 0.95).toFixed(1)}`;
      console.log(`${label.padEnd(10)} legacy ${report(series.legacy)}   actor ${report(series.actor)}`);
    }
  } finally {
    builds.legacy.dispose();
    builds.actor.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// One save as the renderer makes it: read, one attribute edit, write. Only the
// write is timed.
async function saveOnce(harness, page, sample) {
  const read = await harness.invoke('page:read', page);
  assert.equal(read.editable, true);
  const model = structuredClone(read.model);
  assert.ok(setFirstString(model.nodes, `sample ${sample}`), 'the page has a string attribute');
  const started = performance.now();
  const written = await harness.invoke('page:write', { pagePath: page, model, baseChecksum: read.checksum });
  const elapsed = performance.now() - started;
  assert.equal(written.ok, true, JSON.stringify(written.error));
  return elapsed;
}

function setFirstString(nodes, value) {
  const pending = [...nodes];
  for (let visited = 0; visited < pending.length; visited++) {
    assert.ok(visited < 200_000);
    const node = pending[visited];
    for (const [name, prop] of Object.entries(node.props ?? {})) {
      if (prop?.type === 'string') {
        node.props[name] = { type: 'string', value };
        return true;
      }
    }
    pending.push(...(Array.isArray(node.children) ? node.children : []));
  }
  return false;
}

function rank(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
