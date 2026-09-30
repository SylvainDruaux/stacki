// Packages a local, unsigned macOS build. Release builds sign and notarize
// (package.json build.mac), which needs the maintainer's certificates; this
// overrides exactly those three settings and nothing else. A script rather
// than an npm one-liner because the overrides do not fit in 100 columns.

import childProcess = require('node:child_process');
import path = require('node:path');

const UNSIGNED_OVERRIDES = [
  '-c.mac.forceCodeSigning=false',
  '-c.mac.notarize=false',
  '-c.mac.identity=null',
] as const;

const root = path.join(__dirname, '..', '..');
const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const result = childProcess.spawnSync(process.execPath, [builder, '--mac', ...UNSIGNED_OVERRIDES], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error !== undefined) {
  console.error(`electron-builder could not start: ${result.error.message}`);
}
process.exitCode = result.status ?? 1;
