// The canvas's morph client, bundled from its source modules for a test in
// jsdom: every module but the entry (morphClient.ts fetches the page at load),
// in one bundle, so the functions share one module state as they do in the
// page. The shipped client gets its caps prepended by main; here a banner
// declares them, so a test can bundle a copy with caps of its own.
// The modules read the page through the global `document`, which the test sets.
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('./sources.js');

const MODULES = ['morphNodes', 'morphBudget', 'morphAnchors', 'morphPatch', 'morphAssets'];

module.exports = function loadMorphModules(limits) {
  const folder = repoPath('electron/previewClient');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-morph-modules-'));
  const output = path.join(directory, 'morph.cjs');
  try {
    buildSync({
      stdin: {
        contents: MODULES.map((name) => `export * from './${name}';`).join('\n'),
        resolveDir: folder,
        loader: 'ts',
      },
      outfile: output,
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      banner: { js: `const AVB_PREVIEW_LIMITS = Object.freeze(${JSON.stringify(limits)});` },
      logLevel: 'silent',
    });
    return require(output);
  } finally {
    delete require.cache[output];
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
