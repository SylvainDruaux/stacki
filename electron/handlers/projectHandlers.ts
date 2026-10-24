// The project IPC: opening and creating projects (from a dialog, the Astro
// template or a starter), and installing their dependencies.

import { gitErrorDetail } from '../git/git';
import { toRecord } from '../../shared/core/record';
import { assert } from '../../shared/core/assert';
import * as path from 'path';
import * as fs from 'fs';
import {
  createStarter,
  newSiteDirectory,
  runCreateCommand,
  startSiteHistory,
  STARTERS,
} from '../project/starter';
import { isWin } from '../lib/mainHelpers';
import { ensureToolPath, run } from '../lib/nodeTools';
import { isAstroProject } from '../project/projectFiles';
import { detectPackageManager, installArguments } from '../project/packageManager';
import type { MainHost } from './mainHost';

export function registerProjectHandlers(
  host: Pick<MainHost, 'ipcMain' | 'send' | 'showOpenDialog'>,
): void {
  registerProjectOpenDialogHandlers(host);
  registerProjectCreateAstroHandlers(host);
}

function registerProjectOpenDialogHandlers({
  ipcMain,
  showOpenDialog,
}: Pick<MainHost, 'ipcMain' | 'showOpenDialog'>): void {
  ipcMain.handle('project:openDialog', async () => {
    const result = await showOpenDialog({
      title: 'Open an Astro project',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true as const };
    }
    const directory = result.filePaths[0];
    assert(directory !== undefined, 'Accepted directory dialog must have a path');
    if (!isAstroProject(directory)) {
      return {
        canceled: false as const,
        error:
          'That folder does not look like an Astro project ' +
          '(no astro dependency or astro.config found).',
      };
    }
    return { canceled: false as const, projectPath: directory };
  });
}

function registerProjectCreateAstroHandlers({
  ipcMain,
  send,
  showOpenDialog,
}: Pick<MainHost, 'ipcMain' | 'send' | 'showOpenDialog'>): void {
  // Runs the real `npm create astro@latest`, answering the questions the CLI
  // would ask interactively with the choices collected in the app's wizard.
  // Output is streamed to the renderer so the user sees the same progress the
  // terminal would show. The wizard names the site, so its folder is made here,
  // empty, and create-astro runs in it with "." as the target rather than
  // guessing a name.
  ipcMain.handle('project:createAstro', async (_event, options) => {
    const {
      parentPath,
      name,
      template = 'basics',
      install = true,
      git = true,
      ai = false,
    } = options || {};
    const directory = newSiteDirectory(parentPath, name);
    ensureToolPath(); // npm is a Node shim — same PATH problem as astro
    fs.mkdirSync(directory);

    const args = [
      'create',
      'astro@latest',
      '.',
      '--',
      '--template',
      template,
      '--no-install', // Stacki installs, then makes the first commit (finishNewSite).
      '--no-git',
      ...(ai ? [] : ['--no-ai']),
      '--skip-houston',
      '--yes', // accept defaults for anything not covered above
    ];

    send('create:log', `> npm ${args.join(' ')}\n\n`);
    await runCreateAstroInNewFolder({ send }, directory, args);
    await finishNewSite({ send }, directory, { install, history: git, label: 'Astro' });
    return { ok: true as const, installed: install, projectPath: directory };
  });

  // A folder to put a new project IN, rather than the project's own folder: the
  // starter arrives as a directory of its own, named by the user.
  ipcMain.handle('project:parentDialog', async () => {
    const result = await showOpenDialog({
      title: 'Choose where the site should go',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true as const };
    }
    return { canceled: false as const, parentPath: result.filePaths[0] };
  });

  // Starting from a starter. The scaffolder, the first commit and the package's
  // name are in ./starter.js; what is here is the install that follows and the
  // log the wizard reads.
  ipcMain.handle(
    'project:createStarter',
    async (_event, { starter = 'lumos', parentPath, name }) => {
      ensureToolPath(); // npm and git are both on the PATH the Dock does not have
      const result = await createStarter({
        starter,
        parentPath,
        name,
        onLog: (text) => send('create:log', text),
      });
      const label = STARTERS[starter]?.label ?? starter;
      await finishNewSite({ send }, result.projectPath, { install: true, history: true, label });
      return result;
    },
  );
}

export async function installDependencies({ send }: Pick<MainHost, 'send'>, directory: string) {
  ensureToolPath(); // npm/pnpm/yarn are Node shims — same PATH problem as astro
  const pm = detectPackageManager(directory);
  send('progress', { message: `Installing dependencies (${pm} install)…` });
  try {
    await run(isWin ? `${pm}.cmd` : pm, [...installArguments(pm)], directory, {
      timeout: 10 * 60 * 1000,
      shell: isWin,
    });
  } catch (error: unknown) {
    if (toRecord(error)?.['code'] === 'ENOENT') {
      throw new Error(
        `This project uses ${pm}, but ${pm} is not installed. Install it and try again.`,
      );
    }
    throw new Error(`${pm} install failed: ${gitErrorDetail(error).slice(-400)}`);
  }
}

// The install comes first, so the site's first commit includes the lockfile. The site gets
// its history even when the install fails; the install error still reaches the wizard.
async function finishNewSite(
  { send }: Pick<MainHost, 'send'>,
  directory: string,
  options: { readonly install: boolean; readonly history: boolean; readonly label: string },
): Promise<void> {
  const onLog = (text: string): void => send('create:log', text);
  try {
    if (options.install) {
      onLog('\n> installing dependencies\n');
      await installDependencies({ send }, directory);
    }
  } finally {
    if (options.history) {
      await startSiteHistory(directory, options.label, onLog);
    }
  }
  send('progress', PROGRESS_CLEARED);
}

// Clears the progress line: no message (src/ipc/appBridge.ts, onAppProgress). IPC is
// a structured clone, which keeps the absent value.
export const PROGRESS_CLEARED = { message: undefined } as const;

// A run that wrote nothing leaves no folder behind, so Try again can reuse the
// name. Anything it did write stays for the user to inspect; nothing is deleted
// recursively.
async function runCreateAstroInNewFolder(
  { send }: Pick<MainHost, 'send'>,
  directory: string,
  args: readonly string[],
): Promise<void> {
  try {
    await runCreateAstro({ send }, directory, args);
  } catch (error: unknown) {
    if (fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
    throw error;
  }
}

// The create-astro run itself, its output streamed to the wizard's log. It
// settles once the CLI exits and a package.json has landed in `directory`.
async function runCreateAstro(
  { send }: Pick<MainHost, 'send'>,
  directory: string,
  args: readonly string[],
): Promise<void> {
  const npm = isWin ? 'npm.cmd' : 'npm';
  await runCreateCommand(npm, args, directory, (text) => send('create:log', text));
  if (!fs.existsSync(path.join(directory, 'package.json'))) {
    throw new Error('create-astro finished but no package.json appeared.');
  }
}
