#!/usr/bin/env node
// Claude Code hook entry point (see hook.mts): `node scripts/agent/claude.mts <event>`.

import { runHook } from './hook.mts';

process.exitCode = runHook('claude', process.argv.slice(2));
