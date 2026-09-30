#!/usr/bin/env node
// Codex hook entry point (see hook.mts): `node scripts/agent/codex.mts <event>`.

import { runHook } from './hook.mts';

process.exitCode = runHook('codex', process.argv.slice(2));
