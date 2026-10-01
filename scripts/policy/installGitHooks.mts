#!/usr/bin/env node
// Points git at the tracked hooks in .githooks/ and at the blame ignore list.
// Runs from `npm install` (postinstall), so every clone — a person's or an
// agent's — gets the same hooks with no extra step and no hook-manager
// dependency. Idempotent; outside a git work tree (a packed tarball) it does
// nothing.

import fs from 'node:fs';
import path from 'node:path';
import { assert } from './assert.mts';
import { runChild } from './child.mts';

const HOOKS_DIRECTORY = '.githooks';
const HOOK_MODE = 0o755;
const SETTINGS = [
  ['core.hooksPath', HOOKS_DIRECTORY],
  ['blame.ignoreRevsFile', '.git-blame-ignore-revs'],
] as const;

function main(): number {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const inside = runChild('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    console.log('hooks:install: not a git work tree; skipped.');
    return 0;
  }
  for (const [key, value] of SETTINGS) {
    const current = runChild('git', ['config', '--local', '--get', key], { cwd: root });
    if (current.stdout.trim() === value) {
      continue;
    }
    const set = runChild('git', ['config', '--local', key, value], { cwd: root });
    assert(set.status === 0, `hooks:install: git config ${key} failed: ${set.stderr}`);
  }
  // A checkout on a filesystem without modes, or a zip download, can lose the
  // execute bit; git then skips the hook silently.
  if (process.platform !== 'win32') {
    for (const entry of fs.readdirSync(path.join(root, HOOKS_DIRECTORY))) {
      fs.chmodSync(path.join(root, HOOKS_DIRECTORY, entry), HOOK_MODE);
    }
  }
  console.log(`hooks:install: git hooks run from ${HOOKS_DIRECTORY}/.`);
  return 0;
}

process.exitCode = main();
