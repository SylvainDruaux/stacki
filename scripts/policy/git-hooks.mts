#!/usr/bin/env node
// Git hook entry point. The stubs in .githooks/ call this with the hook name:
//
//   pre-commit   staged files: Prettier check, policy scan, ESLint
//   commit-msg   the message: typed subject, length, a body (AGENTS.md §17)
//   pre-push     the type checker, full ESLint, and the full policy scan
//
// The checks are the ones every agent harness runs (checks.mts); CI runs the
// full gate. `git commit --no-verify` skips these, which is why the agent
// hooks refuse that flag and CI stays the gate no one can skip.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assert } from './assert.mts';
import { checkFiles, repositoryRoot, runEslint, runTypeCheck, stagedFiles } from './checks.mts';
import { commitMessageProblems, describeCommitMessageProblem } from './commit-message.mts';
import { formatViolations, repositoryFiles, repositoryViolations, scanPaths } from './scan.mts';

const HOOKS = ['pre-commit', 'commit-msg', 'pre-push'] as const;
type Hook = (typeof HOOKS)[number];

function parseHook(name: string | undefined): Hook {
  const hook = HOOKS.find((candidate) => candidate === name);
  assert(hook !== undefined, `git-hooks: unknown hook ${String(name)}`);
  return hook;
}

function preCommit(root: string): number {
  const files = stagedFiles(root);
  const result = checkFiles(root, files, { format: 'check' });
  if (result.kind === 'pass') {
    return 0;
  }
  console.error(result.report);
  console.error('\npre-commit: fix the findings above (`npm run format` fixes Prettier).');
  return 1;
}

function commitMessage(messageFile: string | undefined): number {
  assert(messageFile !== undefined, 'commit-msg: git passes the message file');
  const problems = commitMessageProblems(fs.readFileSync(messageFile, 'utf8'));
  if (problems.length === 0) {
    return 0;
  }
  for (const problem of problems) {
    console.error(`commit-msg: ${describeCommitMessageProblem(problem)}`);
  }
  return 1;
}

function prePush(root: string): number {
  const failures: string[] = [];
  const types = runTypeCheck(root);
  if (types.status !== 0) {
    failures.push(types.stdout + types.stderr);
  }
  const lint = runEslint(root, ['.']);
  if (lint.status !== 0) {
    failures.push(lint.stdout + lint.stderr);
  }
  const files = repositoryFiles(root);
  const violations = [...scanPaths(root, files), ...repositoryViolations(root, files)];
  if (violations.length > 0) {
    failures.push(formatViolations(violations));
  }
  if (failures.length === 0) {
    return 0;
  }
  console.error(failures.join('\n\n'));
  console.error('\npre-push: the findings above would fail CI.');
  return 1;
}

function main(argumentsList: readonly string[]): number {
  const hook = parseHook(argumentsList[0]);
  const root = repositoryRoot();
  switch (hook) {
    case 'pre-commit':
      return preCommit(root);
    case 'commit-msg':
      return commitMessage(argumentsList[1]);
    case 'pre-push':
      return prePush(root);
    default: {
      const unreachable: never = hook;
      return unreachable;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
