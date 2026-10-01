// Keep Vite alive while Electron restarts itself for “Reload All Code”. The
// supervisor mirrors every other exit so concurrently still owns shutdown.

import { spawn, type ChildProcess } from 'node:child_process';
const RELAUNCH_CODE = 42;
// Where `npm run dev:vite` serves the renderer (vite.config.mjs server.port);
// electron/main.ts loads from it whenever the variable is set.
const DEV_SERVER_URL = 'http://localhost:5173';
const argumentsList = process.argv.slice(2);
const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

let child: ChildProcess | undefined;

// Relaunching calls run() again from the child's exit event, not from inside
// run(): the stack unwinds between launches, and each relaunch is a developer
// pressing "Reload All Code".
// eslint-disable-next-line stacki/bounded-recursion -- event re-entry, not stack recursion
function run(): void {
  const electronInput: unknown = require('electron');
  if (typeof electronInput !== 'string' || electronInput.length === 0) {
    throw new Error('Electron executable path must be a non-empty string');
  }
  const spawnedChild = spawn(electronInput, ['.', ...argumentsList], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL },
  });
  child = spawnedChild;
  spawnedChild.on('exit', (code, signal) => {
    child = undefined;
    if (code === RELAUNCH_CODE) {
      console.log('[dev] reloading all code…');
      run();
      return;
    }
    if (signal !== null) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

for (const signal of HANDLED_SIGNALS) {
  process.on(signal, () => {
    if (child) {
      child.kill(signal);
    } else {
      process.exit(0);
    }
  });
}

run();
