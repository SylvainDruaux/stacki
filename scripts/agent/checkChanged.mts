#!/usr/bin/env node
// `npm run check:changed`: the check an agent's stop hook runs, for anyone to
// run by hand — Prettier, the policy scan, and ESLint on every file that
// differs from HEAD, then the type checker. The full gate is `npm test`.

import { checkChanged, repositoryRoot } from '../policy/checks.mts';

const outcome = checkChanged(repositoryRoot());
if (outcome.kind === 'fail') {
  console.error(outcome.report);
  process.exitCode = 1;
} else {
  console.log('check:changed: every changed file passes.');
}
