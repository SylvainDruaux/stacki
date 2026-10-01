#!/usr/bin/env node
// The gate: builds, static checks, then every test suite under test/.
//
//   npm test                         everything
//   npm test -- hoverCost electron/  suites by name, or every suite under a folder
//   npm test -- --list               the suites, without running them
//   npm test -- --jobs=4             at most four suites at once
//
// Suites are found by name (testDiscovery.ts); the few that need a different
// runner, Node flags or to run alone say so in testSuites.ts. Each runs as a
// direct spawn with an argument list, never a shell line.

import { spawnSync } from 'node:child_process';
import os = require('node:os');
import path = require('node:path');
import {
  parseJobs,
  runTestPool,
  stopTestPool,
  type TestCommand,
  type TestOutcome,
} from './testPool';
import { repositoryRoot } from '../lib/repoRoot';
import { discoverTestFiles, selectSuites, suitesFor, type Suite } from './testDiscovery';

type GateCommand = readonly [label: string, command: string, argumentsList: readonly string[]];

const root = repositoryRoot();
const flags = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const unknownFlags = flags.filter((flag) => !flag.startsWith('--jobs=') && flag !== '--list');
if (unknownFlags.length > 0) {
  console.error(`Unknown flag: ${unknownFlags.join(', ')} (supported: --jobs=<n>, --list)`);
  process.exit(1);
}
const jobs = parseJobs(
  flags.find((flag) => flag.startsWith('--jobs='))?.slice('--jobs='.length),
  os.availableParallelism(),
);
const queries = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const { selected, unmatched } = selectSuites(suitesFor(discoverTestFiles(root)), queries);
if (selected.length === 0 || unmatched.length > 0) {
  console.error(`No test suite matches: ${unmatched.join(', ')} (npm test -- --list)`);
  process.exit(1);
}
if (flags.includes('--list')) {
  console.log(selected.map((suite) => `${suite.name}  (${suite.file})`).join('\n'));
  process.exit(0);
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
  ['build:clean', node, [path.join(root, 'scripts/build/cleanBuild.mts')]],
  ['build:contracts', node, [typeScript, '-p', path.join('shared', 'tsconfig.json')]],
  ['build:electron', node, [typeScript, '-p', path.join('electron', 'tsconfig.json')]],
  ['build:scripts', node, [typeScript, '-p', path.join('scripts', 'tsconfig.build.json')]],
  ['build:morph', node, [typeScript, '-p', path.join('electron', 'tsconfig.morph.json')]],
  ['build:preload', node, [typeScript, '-p', path.join('electron', 'tsconfig.preload.json')]],
  ['stage:runtime', node, [path.join(root, 'dist/scripts/build/stageRuntime.js')]],
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
    argumentsList: [path.join(root, 'dist/scripts/gate/adapterSurface.js')],
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

// Two phases: the shared pool, then the suites that run alone (they measure
// timing or drive a real window) one at a time with nothing else running.
// The Electron binary's path is what the electron package exports.
const electronInput: unknown = require('electron');
const electronBinary = typeof electronInput === 'string' ? electronInput : 'electron';
const toCommand = (suite: Suite): TestCommand => {
  if (suite.options.runner === 'electron') {
    return { name: suite.name, command: electronBinary, argumentsList: [suite.file] };
  }
  const nodeArguments = suite.options.nodeArguments ?? [];
  return { name: suite.name, command: node, argumentsList: [...nodeArguments, suite.file] };
};
const phases: readonly (readonly TestCommand[])[] = [
  selected.filter((suite) => suite.options.phase !== 'alone').map(toCommand),
  selected.filter((suite) => suite.options.phase === 'alone').map(toCommand),
];
const names = selected.map((suite) => suite.name);
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
  console.log(`\n[gate] ${names.length} test suites, ${jobs} at a time`);
  const outcomes: TestOutcome[] = [];
  for (const [index, phase] of phases.entries()) {
    const phaseJobs = index === 0 ? jobs : 1;
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
  console.log(`\nTest suites took ${testSeconds}s. Slowest: ${named.join(', ')}`);

  const quarantined: readonly string[] = [];
  const flaky = selected
    .filter((suite) => suite.options.flaky !== undefined)
    .map((suite) => suite.name);
  const durationSeconds = ((Date.now() - startedMs) / 1000).toFixed(1);
  const passed = names.length - failed.length;
  console.log(`\n${passed}/${names.length} test suites passed in ${durationSeconds}s.`);
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
