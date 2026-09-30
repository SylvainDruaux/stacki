// Exercise actual CSS parser output through the renderer boundary, then corrupt
// each nested contract. Scripted bridge failures pin the operating-error channel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readVariables } = require('../dist/electron/cssVars.js');
const { parseCSSVariables, readCSSVariables, VARIABLES_LIMITS } =
  require('./renderer-module')('variablesBridge.ts');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-variable-boundary-'));
let wire;
try {
  fs.mkdirSync(path.join(directory, 'src/styles'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'src/styles/tokens.css'),
    ':root { /* Palette */ --brand: #0af; --accent: var(--brand); --gap: 1rem; }\n' +
      '.dark { --brand: #111; --accent: var(--brand); --gap: 2rem; }\n',
  );
  fs.writeFileSync(path.join(directory, 'src/styles/broken.css'), ':root { --broken:');
  wire = readVariables(directory);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
const result = parseCSSVariables(wire);
assert.equal(result.ok, true);
assert.deepEqual(result.value, wire, 'derived color/reference metadata survives the real wire');
assert.deepEqual(parseCSSVariables({ files: [], values: {} }), {
  ok: true,
  value: { files: [], values: {} },
});
assert.deepEqual(parseCSSVariables({ files: [], error: 'unavailable' }), {
  ok: false,
  error: 'unavailable',
});
const good = () => structuredClone(wire);
const validFile = (snapshot) => snapshot.files.find((file) => !file.error);
const group = (snapshot) => validFile(snapshot).groups[0];
const block = (snapshot) => group(snapshot).blocks[0];
const row = (snapshot) => block(snapshot).rows[0];
const cell = (snapshot) => row(snapshot).cells.find(Boolean);
for (const mutate of [
  (s) => {
    s.files = null;
  },
  (s) => {
    s.values = [];
  },
  (s) => {
    s.values['--brand'] = 2;
  },
  (s) => {
    s.error = 'cannot contain successful files';
  },
  (s) => {
    validFile(s).rel = 'bad\0path';
  },
  (s) => {
    validFile(s).count = -1;
  },
  (s) => {
    validFile(s).groups = null;
  },
  (s) => {
    group(s).kind = 'matrix';
  },
  (s) => {
    group(s).columns[0].line = 1.5;
  },
  (s) => {
    group(s).columns[0].context = [false];
  },
  (s) => {
    block(s).kind = 'single';
  },
  (s) => {
    block(s).title = 2;
  },
  (s) => {
    block(s).titleStart = -1;
  },
  (s) => {
    block(s).rows = null;
  },
  (s) => {
    row(s).cells = {};
  },
  (s) => {
    row(s).label = null;
  },
  (s) => {
    cell(s).value = 1;
  },
  (s) => {
    cell(s).valueStart = -1;
  },
  (s) => {
    cell(s).valueEnd = 0;
  },
  (s) => {
    cell(s).valueEnd = VARIABLES_LIMITS.fileCharsMax + 1;
  },
  (s) => {
    cell(s).resolved = false;
  },
  (s) => {
    cell(s).color = [];
  },
  (s) => {
    cell(s).unknownColor = 'true';
  },
  (s) => {
    cell(s).value = 'x'.repeat(VARIABLES_LIMITS.fileCharsMax + 1);
  },
  (s) => {
    group(s).columns = Array(VARIABLES_LIMITS.entriesMax + 1).fill(null);
  },
  (s) => {
    s.files = Array(VARIABLES_LIMITS.entriesMax + 1).fill(null);
  },
]) {
  const invalid = good();
  mutate(invalid);
  assert.throws(() => parseCSSVariables(invalid));
}
const matrix = good();
block(matrix).kind = 'matrix';
assert.throws(() => parseCSSVariables(matrix), /matrix columns are required/);
block(matrix).columns = group(matrix).columns;
assert.equal(parseCSSVariables(matrix).ok, true);
block(matrix).titleStart = 30;
block(matrix).titleEnd = 20;
assert.throws(() => parseCSSVariables(matrix), /reversed title range/);
const holes = good();
row(holes).cells[0] = undefined;
assert.equal(parseCSSVariables(holes).ok, true, 'matrix holes are valid');
for (const invalid of [null, [], {}, { files: [] }, { files: [], error: false }]) {
  assert.throws(() => parseCSSVariables(invalid));
}
(async () => {
  global.window = {
    avb: {
      cssVariables: async (project) => {
        assert.equal(project, '/project');
        return wire;
      },
    },
  };
  assert.deepEqual(await readCSSVariables('/project'), result);
  window.avb.cssVariables = async () => {
    throw new Error('disk unavailable');
  };
  assert.deepEqual(await readCSSVariables('/project'), { ok: false, error: 'disk unavailable' });
  window.avb.cssVariables = async () => null;
  await assert.rejects(() => readCSSVariables('/project'));
  console.log(
    'variables-boundary: real parser round trip, nested bounds and failure channels passed',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
