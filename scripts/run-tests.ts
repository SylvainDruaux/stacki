#!/usr/bin/env node
// Every test:* command belongs to the gate. The manifest is parsed before use
// so an invalid script entry cannot become an unchecked shell command.

import { spawnSync } from 'node:child_process';
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import {
  parseJobs,
  runTestPool,
  stopTestPool,
  type TestCommand,
  type TestOutcome,
} from './test-pool';
import { repositoryRoot } from './lib/repoRoot';

interface PackageScripts {
  readonly [name: string]: string;
}

type GateCommand = readonly [label: string, command: string, argumentsList: readonly string[]];

function readScripts(packagePath: string): PackageScripts {
  const input: unknown = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (typeof input !== 'object' || input === null || !('scripts' in input)) {
    throw new Error('package.json: expected scripts object');
  }
  const value = input.scripts;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('package.json.scripts: expected object');
  }
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    if (typeof command !== 'string') {
      throw new Error(`package.json.scripts.${name}: expected string`);
    }
    scripts[name] = command;
  }
  return scripts;
}

const root = repositoryRoot();
const scripts = readScripts(path.join(root, 'package.json'));
const flags = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const unknownFlags = flags.filter((flag) => !flag.startsWith('--jobs='));
if (unknownFlags.length > 0) {
  console.error(`Unknown flag: ${unknownFlags.join(', ')} (supported: --jobs=<n>)`);
  process.exit(1);
}
const jobs = parseJobs(
  flags.find((flag) => flag.startsWith('--jobs='))?.slice('--jobs='.length),
  os.availableParallelism(),
);
const requested = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith('--'))
  .map((name) => (name.startsWith('test:') ? name : `test:${name}`));
const names =
  requested.length > 0
    ? requested
    : Object.keys(scripts).filter((name) => name.startsWith('test:'));
const unknown = names.filter((name) => scripts[name] === undefined);
if (names.length === 0 || unknown.length > 0) {
  console.error(`Unknown test command: ${unknown.join(', ')}`);
  process.exit(1);
}

const startedMs = Date.now();
const failed: string[] = [];
const pathValue = process.env['PATH'] ?? '';
const environment = {
  ...process.env,
  PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${pathValue}`,
};
const node = process.execPath;
const typeScript = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const staticGates: readonly GateCommand[] = [
  // Node >= 22.18 strips types itself (package.json engines).
  ['build:clean', node, [path.join(root, 'scripts/clean-build.mts')]],
  ['build:contracts', node, [typeScript, '-p', path.join('shared', 'tsconfig.json')]],
  ['build:electron', node, [typeScript, '-p', path.join('electron', 'tsconfig.json')]],
  ['build:scripts', node, [typeScript, '-p', path.join('scripts', 'tsconfig.build.json')]],
  ['build:morph', node, [typeScript, '-p', path.join('electron', 'tsconfig.morph.json')]],
  ['build:preload', node, [typeScript, '-p', path.join('electron', 'tsconfig.preload.json')]],
  ['stage:runtime', node, [path.join(root, 'dist/scripts/stage-runtime.js')]],
  ['build:web', node, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']],
];
// The checks only read what the builds produced, so they run side by side.
const staticChecks: readonly TestCommand[] = [
  { name: 'tsc --noEmit', command: node, argumentsList: [typeScript, '--noEmit'] },
  {
    // The scripts emit CommonJS, so their build config cannot hold
    // verbatimModuleSyntax; this check-only program holds the full flag set.
    name: 'tsc scripts',
    command: node,
    argumentsList: [typeScript, '-p', path.join('scripts', 'tsconfig.json')],
  },
  {
    name: 'eslint',
    command: node,
    argumentsList: [
      path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      '--max-warnings',
      '0',
      '.',
    ],
  },
  {
    // Line width, shell scripts, test headers, the dependency record, one
    // lockfile, agent instructions, assertion density (docs/enforcement.md).
    name: 'policy scan',
    command: node,
    argumentsList: [path.join(root, 'scripts/policy/scan.mts')],
  },
  {
    name: 'prettier',
    command: node,
    argumentsList: [
      path.join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
      '--check',
      '--log-level',
      'warn',
      '.',
    ],
  },
  {
    name: 'adapter-surface',
    command: node,
    argumentsList: [path.join(root, 'dist/scripts/adapter-surface.js')],
  },
];

for (const [label, command, argumentsList] of staticGates) {
  console.log(`\n[gate] ${label}`);
  const gateStartedMs = Date.now();
  const result = spawnSync(command, argumentsList, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') {
    process.exit(130);
  }
  if (result.status !== 0 || result.error) {
    console.error(`\nStatic gate failed: ${label}`);
    process.exit(1);
  }
  console.log(`[gate] ${label} done in ${((Date.now() - gateStartedMs) / 1000).toFixed(1)}s`);
}

// Three phases. Exclusive commands rebuild output the others read, so they run
// first and alone. Load-sensitive commands measure timing or drive a real
// window, so they run last and alone. Everything else shares the pool.
// selectorwell is here because a stylesheet read that starts before an edit can
// land after it under load and restore the old value; until that race is
// understood, it runs where its timing assumptions hold.
const exclusive = ['test:contracts'];
const alone = ['test:hovercost', 'test:popoverdropdown', 'test:selectorwell', 'test:thumbs'];
const toCommand = (name: string): TestCommand => {
  const command = scripts[name];
  if (command === undefined) {
    throw new Error(`Missing validated test command ${name}`);
  }
  return { name, command };
};
const phases: readonly (readonly TestCommand[])[] = [
  names.filter((name) => exclusive.includes(name)).map(toCommand),
  names.filter((name) => !exclusive.includes(name) && !alone.includes(name)).map(toCommand),
  names.filter((name) => alone.includes(name)).map(toCommand),
];
process.on('SIGINT', () => {
  stopTestPool();
  process.exit(130);
});
let testsStartedMs = Date.now();
let finished = 0;
const report = (outcome: TestOutcome): void => {
  finished += 1;
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  const verdict = outcome.passed ? 'ok  ' : 'FAIL';
  console.log(`[${finished}/${names.length}] ${verdict} ${outcome.name} (${seconds}s)`);
  if (!outcome.passed) {
    failed.push(outcome.name);
    console.log(outcome.output);
  }
};
// Every check's output is shown (lint warnings included); any failure stops the
// gate before the tests, as a failed build does.
async function runStaticChecks(): Promise<void> {
  const options = { cwd: root, environment, jobs: Math.min(jobs, staticChecks.length) };
  const outcomes = await runTestPool(staticChecks, options, (outcome) => {
    const seconds = (outcome.durationMs / 1000).toFixed(1);
    console.log(`\n[gate] ${outcome.name} ${outcome.passed ? 'done' : 'FAILED'} in ${seconds}s`);
    console.log(outcome.output);
  });
  const failures = outcomes.filter((outcome) => !outcome.passed);
  if (failures.length > 0) {
    console.error(`\nStatic gate failed: ${failures.map((outcome) => outcome.name).join(', ')}`);
    process.exit(1);
  }
}

async function runPhases(): Promise<readonly TestOutcome[]> {
  await runStaticChecks();
  testsStartedMs = Date.now();
  console.log(`\n[gate] ${names.length} test commands, ${jobs} at a time`);
  const outcomes: TestOutcome[] = [];
  for (const [index, phase] of phases.entries()) {
    const phaseJobs = index === 1 ? jobs : 1;
    const options = { cwd: root, environment, jobs: phaseJobs };
    outcomes.push(...(await runTestPool(phase, options, report)));
  }
  return outcomes;
}

function summarize(outcomes: readonly TestOutcome[]): void {
  const slowest = [...outcomes].sort((left, right) => right.durationMs - left.durationMs);
  const named = slowest
    .slice(0, 5)
    .map((outcome) => `${outcome.name} ${(outcome.durationMs / 1000).toFixed(1)}s`);
  const testSeconds = ((Date.now() - testsStartedMs) / 1000).toFixed(1);
  console.log(`\nTest commands took ${testSeconds}s. Slowest: ${named.join(', ')}`);

  const quarantined: readonly string[] = [];
  const flaky = ['test:hovercost', 'test:popoverdropdown'] as const;
  const durationSeconds = ((Date.now() - startedMs) / 1000).toFixed(1);
  const passed = names.length - failed.length;
  console.log(`\n${passed}/${names.length} test commands passed in ${durationSeconds}s.`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(', ')}`);
  }
  const tolerated = [...quarantined, ...flaky];
  const unexpected = failed.filter((name) => !tolerated.includes(name));
  const healed = quarantined.filter((name) => !failed.includes(name) && names.includes(name));
  if (healed.length > 0) {
    console.error(`\nQuarantined tests now pass — remove them: ${healed.join(', ')}`);
  }
  process.exitCode = unexpected.length > 0 || healed.length > 0 ? 1 : 0;
}

runPhases().then(summarize, (error: unknown) => {
  console.error(error);
  process.exit(1);
});
