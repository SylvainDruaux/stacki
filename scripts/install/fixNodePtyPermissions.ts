// node-pty's packaged Unix spawn helper can lose its execute bit. This script
// repairs both prebuilt and locally built helpers during install and packaging.

import fs = require('node:fs');
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';

const EXEC_MODE = 0o755;

function findSpawnHelpers(nodePtyDirectory: string): readonly string[] {
  const prebuilds = path.join(nodePtyDirectory, 'prebuilds');
  let entries: readonly fs.Dirent[];
  try {
    entries = fs.readdirSync(prebuilds, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(prebuilds, entry.name, 'spawn-helper'))
    .filter((helperPath) => fs.existsSync(helperPath));
}

function findBuiltHelper(nodePtyDirectory: string): readonly string[] {
  const helperPath = path.join(nodePtyDirectory, 'build', 'Release', 'spawn-helper');
  return fs.existsSync(helperPath) ? [helperPath] : [];
}

export function fixNodePtyPermissions(nodePtyDirectory: string): readonly string[] {
  const fixed: string[] = [];
  const helpers = [...findSpawnHelpers(nodePtyDirectory), ...findBuiltHelper(nodePtyDirectory)];
  for (const helperPath of helpers) {
    const mode = fs.statSync(helperPath).mode & 0o777;
    if ((mode & 0o111) === 0o111) {
      continue;
    }
    fs.chmodSync(helperPath, EXEC_MODE);
    fixed.push(helperPath);
  }
  return fixed;
}

function main(): void {
  if (process.platform === 'win32') {
    return;
  }
  const root = repositoryRoot();
  const nodePtyDirectory = path.join(root, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyDirectory)) {
    return;
  }
  try {
    for (const helperPath of fixNodePtyPermissions(nodePtyDirectory)) {
      console.log(`  • node-pty: made ${path.relative(root, helperPath)} executable`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Installation still succeeds because the terminal is an optional surface.
    console.warn(`  • node-pty: could not fix spawn-helper permissions: ${message}`);
  }
}

if (require.main === module) {
  main();
}
