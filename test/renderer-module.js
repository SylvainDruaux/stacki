// Run a renderer module through the app's bundler before testing it in Node.
// Temporary bundles keep tests independent of extension inference and TS emit.
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('./helpers/sources.js');

// `file` is a repository path: loadRenderer('src/editor/pageEdits.ts').
module.exports = function loadRenderer(file) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-renderer-module-'));
  const output = path.join(directory, 'module.cjs');
  try {
    buildSync({
      entryPoints: [repoPath(file)],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    return require(output);
  } finally {
    delete require.cache[output];
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
