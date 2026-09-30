import {
  inverseBatch,
  loadComponentProperties,
  PropertyUndoStore,
  revertComponentProperties,
  updateComponentProperties,
  type FileChange,
} from './componentProperties';
import { renderComponentPreviewPage } from './componentPreview.js';
import { createIpcRegistrar } from './ipc.js';
import { MAIN_LIMITS, readSource, directoryBudget } from './main.bounds.js';
import { isAtomicTemporary } from './atomicWrite.js';
import { createNodeDocumentActors, type EditReport, type WriteReport } from './documentActors.js';
import { buildEdit } from './editRequests.js';
import { previewEdit } from './editPreview.js';
import {
  createProjectText,
  describeWriteReport,
  documentHost,
  installDocumentHost,
  writeProjectText,
} from './documentWrites.js';
import { definedFields } from '../shared/boundary.js';
import { gitErrorDetail } from './git.js';
import {
  commandNeedsShell,
  isPathDescendant,
  isPathWithin,
  mergeToolPaths,
  pathEnvironmentValue,
  sameFilesystemPath,
  setPathEnvironment,
  staticToolPathGuesses,
} from './platform.js';
import { userInfo } from 'os';
import type {
  BrowserWindow as Window,
  MenuItemConstructorOptions,
  MessageBoxOptions,
  OpenDialogOptions,
} from 'electron';
import type { ChildProcess, ExecFileOptions } from 'child_process';
import { toRecord, toArray } from '../shared/record.js';
import { assert } from '../shared/assert.js';
import type { IpcPayloads } from '../shared/ipc-payloads.js';
import type { IpcResults, WirePageEditError, WirePageWriteFailure } from '../shared/ipc-results.js';
import { describeRejection, type RejectionReason } from '../shared/intent.js';
import { decodeUtf8, encodeUtf8 } from '../shared/span.js';
import type { Digest } from '../shared/brand.js';
import { LIMITS } from '../shared/limits.js';
import { ok } from '../shared/result.js';
import type { SchemaField } from './astroParser.types.js';
import {
  parseData,
  parseRecord,
  parseOptionalString,
  parseRecents,
  parseValidationResult,
  parseSettings,
  parseContentConfig,
  parseAliases,
  parseDynamicPaths,
  parseSampleEntry,
  parseAstroLock,
} from './main.validation.js';
import type {
  RecentProject,
  AssetEntry,
  CmsFile,
  StyleFile,
  GitInfo,
  DevServer,
  PreviewServer,
} from './main.types.js';

import * as electronModule from 'electron';
const {
  app,
  BrowserWindow,
  screen,
  ipcMain: nativeIpcMain,
  dialog,
  shell,
  Menu,
  protocol,
  net: enet,
  nativeImage,
  clipboard,
} = electronModule;
import * as path from 'path';
import * as fs from 'fs';
import * as urlModule from 'url';
const { pathToFileURL } = urlModule;
import * as net from 'net';
import * as childprocessModule from 'child_process';
const { spawn, spawnSync, execFile, execFileSync } = childprocessModule;
// A stop or log command: ten seconds, and the output bound stated rather than
// left to Node's default.
const SHORT_COMMAND = { timeout: 10000, maxBuffer: MAIN_LIMITS.commandOutputBytesMax } as const;

import {
  parsePage,
  locateSelection,
  resolveChunks,
  parsePropSchema,
  parseExtendsTag,
  parseSlots,
  defaultSlotInline,
  rootTag,
} from './astroParser';
import { parseMarkdownPage } from './markdownParser';
import * as scaffoldModule from './scaffold';
const { scaffoldProject } = scaffoldModule;
import * as jsCollectionsModule from './jsCollections';
const { findCollections, replaceCollection, readGeneral, writeGeneral, GENERAL } =
  jsCollectionsModule;
import * as assetRefsModule from './assetRefs.js';
const { defaultImports, addImport, importName, importSpecFor, withAssets } = assetRefsModule;
import * as cmsRefsModule from './cmsRefs';
const { aliasMap, importersOf, resolveImport } = cmsRefsModule;
import * as contentConfigModule from './contentConfig';
const { readContentConfig, validateEntry, stopAllServices } = contentConfigModule;
import * as thumbs from './thumbs';
import * as cssVars from './cssVars';
import * as injectedRoutesModule from './injectedRoutes.js';
const { readInjectedRoutes } = injectedRoutesModule;
import * as starterModule from './starter';
const { createStarter } = starterModule;
import * as windowBoundsModule from './windowBounds';
const { openingBounds } = windowBoundsModule;
import * as componentFileModule from './componentFile';
const { componentFile, newPageText } = componentFileModule;
import * as componentUsageModule from './componentUsage';
const { componentUsage, instancesIn } = componentUsageModule;
import * as contentEntriesModule from './contentEntries';
const { listEntries, writeEntry, countEntries, coveredPaths } = contentEntriesModule;
import * as contentRefsModule from './contentRefs';
const { planRename, applyRename } = contentRefsModule;
import * as gitBranchesModule from './gitBranches';
const { mergeBranch, deleteBranch, switchBranch, resolveMerge } = gitBranchesModule;
import * as devProbeModule from './devProbe';
const { probeUrl } = devProbeModule;
import * as gitHistory from './gitHistory';
import * as gitSnapshot from './gitSnapshot';
import * as previewWorktree from './previewWorktree';
import { checkPreviewRender } from './previewCheck';
import * as terminalModule from './terminal';
const { registerTerminalHandlers, cleanupTerminals } = terminalModule;
import * as projectWatcherModule from './projectWatcher';
const { watchProject } = projectWatcherModule;
import * as serialQueueModule from './serialQueue';
const { createSerialQueue, createKeyedQueue } = serialQueueModule;
import * as electronupdaterModule from 'electron-updater';
const { autoUpdater } = electronupdaterModule;

// The facade keeps native Electron registration behind a parsed payload boundary.
const ipcMain = { handle: createIpcRegistrar(nativeIpcMain) };

let mainWindow: Window | undefined = undefined;
let devServer: DevServer | undefined = undefined; // {proc, url, projectPath}

// --- Dev reload ------------------------------------------------------------
// Only the renderer hot-reloads on its own (Vite). preload.js is re-read from
// disk on a window reload, but main.js and astroParser.js are bound into this
// process at require time and can only be picked up by starting over — which
// is what "Reload All Code" does. So the app relaunches itself, leaving the
// open project in a file for the next process to pick up (the supervisor
// re-spawns us with the same argv, so there's nothing to hand forward there),
// landing back where you were instead of on the welcome screen.
const isDev = !!process.env['VITE_DEV_SERVER_URL'];
// Exiting with this asks scripts/dev-electron.ts to start us again. Not
// app.relaunch(): `npm run dev` runs us under `concurrently -k`, so quitting
// would take the Vite server down with us and the new process would load a
// dead localhost:5173.
const RELAUNCH_CODE = 42;
const reopenFile = () => path.join(app.getPath('userData'), 'dev-reopen.json');

function relaunchApp() {
  try {
    // openProjectRoot is set whenever a project's watcher starts, i.e. on open.
    if (openProjectRoot) {
      fs.writeFileSync(reopenFile(), JSON.stringify({ path: openProjectRoot }), 'utf8');
    }
  } catch {
    /* worst case the reload lands on the welcome screen */
  }
  // app.exit skips before-quit, so take the Astro dev server down by hand —
  // otherwise it keeps the port and the next process adopts a server still
  // running the previously generated config.
  stopDevServer();
  app.exit(RELAUNCH_CODE);
}

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Asset previews
//
// Thumbnails (Assets panel, the props panel's image field) read straight off
// disk. A bare file:// URL only loads when the document itself came from
// file://, which is true of a packaged build (loadFile) but not of `npm run
// dev`, where the renderer is served over http — Chromium blocks file://
// subresources from an http document, so every preview fell back to its
// extension badge. Serving them over our own scheme behaves the same in both.
// ---------------------------------------------------------------------------

const ASSET_SCHEME = 'stacki-asset';
let openProjectRoot: string | undefined = undefined; // set when a project's watcher starts

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, (request) => {
    let abs;
    try {
      abs = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response(undefined, { status: 400 });
    }
    // The URL's path is stacki-asset://local/Users/… on POSIX, /C:/… for a
    // Windows drive, and ///server/share/… for a Windows UNC path.
    if (isWin) {
      abs = abs.replace(/^\//, '');
    }
    abs = path.resolve(abs);
    // Preview iframes run the user's own site; keep the scheme from being a
    // general-purpose file reader by serving only the open project's files.
    if (!openProjectRoot || !isPathDescendant(openProjectRoot, abs)) {
      return new Response(undefined, { status: 403 });
    }
    return serveFile(abs, request);
  });
}

async function serveFile(abs: string, request: Request) {
  const response = await enet.fetch(pathToFileURL(abs).toString(), { headers: request.headers });
  // The renderer is a different origin from this scheme, and font loading is
  // CORS-checked (unlike <img>/<video>), so the Assets panel's "Aa" preview
  // needs this to fetch the face at all. Reach is already limited to the open
  // project by the check above.
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const resource = (name: string) => path.join(__dirname, '..', 'resources', name);

// electron-builder stamps the icon onto packaged builds (build.mac.icon), but
// `npm run dev` runs the bare Electron binary, which shows its own icon in the
// Dock. Set it explicitly so dev looks like the real app. macOS takes the
// padded icon-dock.png; elsewhere the Dock isn't a thing and the window icon
// below covers it.
function setApplicationIcon() {
  if (process.platform !== 'darwin') {
    return;
  }
  const img = nativeImage.createFromPath(resource('icon-dock.png'));
  if (!img.isEmpty()) {
    app.dock?.setIcon(img);
  }
}

function createWindow() {
  // Opened filled: the display the pointer is on, minus what the OS keeps (see
  // windowBounds.js). The display under the pointer rather than the primary
  // one — on a laptop with a monitor beside it, the app should open where the
  // person is looking.
  let bounds;
  try {
    bounds = openingBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
  } catch {
    // No display to ask about (a headless run, an unusual session): a laptop
    // sized window is a fine thing to fall back to.
    bounds = openingBounds({ width: 1480, height: 940 });
  }
  mainWindow = new BrowserWindow({
    ...bounds,
    title: 'Stacki',
    backgroundColor: '#111111',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : isWin ? 'hidden' : 'default',
    ...(isWin
      ? {
          titleBarOverlay: {
            color: '#171717',
            symbolColor: '#a8a8a8',
            height: 40,
          },
        }
      : {}),
    // Windows/Linux taskbar + window chrome; macOS uses the Dock icon above.
    icon: resource(process.platform === 'darwin' ? 'icon.icns' : isWin ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Run the preload in preview iframes too, so they can report their
      // page height for the canvas view (the preload guards what each
      // frame type gets).
      nodeIntegrationInSubFrames: true,
    },
  });

  // A renderer that does not load leaves an empty window; the log says why.
  const loaded = process.env['VITE_DEV_SERVER_URL']
    ? mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL'])
    : mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  loaded.catch((error: unknown) => {
    console.error('[window] the renderer did not load:', error);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });

  // Somebody closed the window. Whatever was open is over: the next window is a
  // fresh start and belongs on the welcome screen, not back in the project this
  // one had. (A reload doesn't come through here, which is the difference the
  // reopen above is asking about.)
  mainWindow.on('closed', () => {
    openProjectRoot = undefined;
    stopWatchingProject();
    stopDevServer();
    stopAllServices();
    stopAllPreviews();
    cleanupTerminals();
  });
}

// Links open in the user's browser. There is no one to tell when the browser
// cannot be started, so the failure goes to the log.
function openExternalLink(url: string) {
  shell.openExternal(url).catch((error: unknown) => {
    console.error(`[shell] could not open ${url}:`, error);
  });
}

// Custom menu: on macOS the native menu consumes ⌘Z/⌘C/⌘V before the page
// sees them, so Undo/Redo/Copy/Paste forward to the renderer, which decides
// between app-level actions (nodes) and native ones (text fields).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      // Spelled out rather than `role: 'fileMenu'`, which takes no additions.
      // What that role provides is one item — Close Window on macOS, Quit
      // everywhere else — so the menu keeps exactly what it had, with the
      // update check above it.
      label: 'File',
      submenu: [
        {
          label: 'Interface Sounds',
          type: 'checkbox',
          checked: !!settings.sound,
          // The menu owns the setting: it is the only place it can be changed,
          // so the tick is the state rather than a copy of it.
          click: (item) => {
            settings = { ...settings, sound: item.checked };
            writeSettings();
            send('menu:sound', item.checked);
          },
        },
        { type: 'separator' },
        // Until now the only way out of a project was to close the app, and on
        // macOS closing the app is not what people think it is: the window goes
        // and the process stays, so coming back lands on the same project and
        // there is nothing to press that says otherwise.
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu:openProject'),
        },
        {
          label: 'Close Project',
          accelerator: 'Shift+CmdOrCtrl+W',
          click: () => send('menu:closeProject'),
        },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void checkForUpdatesFromMenu() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('menu:copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('menu:paste') },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Copy Selection',
          accelerator: 'Shift+CmdOrCtrl+C',
          click: () => send('menu:copySelection'),
        },
        { label: 'Insert Element…', accelerator: 'CmdOrCtrl+E', click: () => send('menu:insert') },
      ],
    },
    // In dev ⌘R has to mean "restart the process". main.js, astroParser.js and
    // the rest of this side are bound in at require time, so the stock reload
    // repaints the renderer while silently going on running the old code —
    // the failure mode is an edit that appears to do nothing. The plain window
    // reload keeps its usual behaviour one item down. A packaged build has no
    // supervisor to restart it and no source to pick up, so it keeps the stock
    // menu.
    buildViewMenu(),
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A project the app has been asked to open in the window it is about to load —
// set by `project:close` when somebody picks a different project, since letting
// go of one is done by reloading the window and the choice has to outlive that.
// Consumed on read.
let pendingProject: string | undefined = undefined;

// The project the renderer should pick up as it mounts, or undefined — which is the
// welcome screen, and is what a cold start gets.
//
// Three ways a renderer can come up wanting a project:
//   - it was told to: somebody chose one from the menu, and the window was
//     reloaded to let go of the last one (`pendingProject`).
//   - it reloaded but this process didn't — a Vite full page reload, or
//     "Reload Window Only" in dev. openProjectRoot is still in memory, so use
//     it. A window that a PERSON closed clears that memory (see createWindow),
//     because closing a window is not reloading it: the next one is a fresh
//     start and must land on the welcome screen.
//   - the whole process restarted ("Reload All Code"), and memory is gone —
//     relaunchApp left the path in a file. Consumed on read, so a later cold
//     start doesn't silently skip the welcome screen.
ipcMain.handle('project:pending', () => {
  const asked = pendingProject;
  pendingProject = undefined;
  if (asked && fs.existsSync(asked)) {
    return asked;
  }
  if (!isDev) {
    return undefined;
  }
  if (openProjectRoot && fs.existsSync(openProjectRoot)) {
    return openProjectRoot;
  }
  let reopenPath: string | undefined = undefined;
  try {
    const input: unknown = JSON.parse(readSource(reopenFile()));
    reopenPath = parseOptionalString(toRecord(input)?.['path']) || undefined;
  } catch {
    return undefined;
  }
  try {
    fs.rmSync(reopenFile(), { force: true });
  } catch {
    /* non-fatal */
  }
  return reopenPath && fs.existsSync(reopenPath) ? reopenPath : undefined;
});

// Native clipboard actions on the focused element, requested by the renderer
// when a menu Copy/Paste lands while a text field has focus.
ipcMain.handle('native:copy', () => {
  mainWindow?.webContents.copy();
  return { ok: true as const };
});
ipcMain.handle('native:paste', () => {
  mainWindow?.webContents.paste();
  return { ok: true as const };
});
// Undo INSIDE a field. ⌘Z is a menu accelerator, so the key never reaches the
// page and a text field's own undo never runs — this is the app handing it
// back when that is what the shortcut meant.
ipcMain.handle('native:undo', () => {
  mainWindow?.webContents.undo();
  return { ok: true as const };
});
ipcMain.handle('native:redo', () => {
  mainWindow?.webContents.redo();
  return { ok: true as const };
});

// Electron resolves whenReady once; were it ever refused, there is no window
// to report that to, so the log says it.
app.whenReady().then(
  () => {
    // Before the menu, which draws the sound item's tick from it.
    settings = readSettings();
    setApplicationIcon();
    registerAssetProtocol();
    buildMenu();
    createWindow();
    startAutoUpdateChecks();
    // Terminals open in the project the app has open — same reach as the asset
    // protocol, which is what `openProjectRoot` already scopes.
    registerTerminalHandlers({ send, projectRoot: () => openProjectRoot });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  },
  (error: unknown) => {
    console.error('[app] Electron did not become ready:', error);
  },
);

// Everything a project had running, let go of. The window reloads after this,
// which is the only way to be sure nothing of the last project is still being
// held — a page half-loaded, an undo stack, a watcher, a shell — and none of
// this survives the reload on its own: a pty outlives the window that opened
// it, and the dev server outlives everything.
ipcMain.handle('project:close', async (_event, next) => {
  pendingProject = typeof next === 'string' && next ? next : undefined;
  stopDevServer();
  stopAllServices();
  stopAllPreviews();
  cleanupTerminals();
  stopWatchingProject();
  // Nothing is open, so nothing is in reach: the asset protocol and the
  // terminals both scope themselves to this.
  openProjectRoot = undefined;
  // The window starts over. Done here rather than in the renderer because it
  // is the same act as the teardown above — the renderer holds a page, an undo
  // stack and forty pieces of state that belong to the project just closed, and
  // none of it should be in the window that opens the next one.
  mainWindow?.webContents.reload();
  return { ok: true as const };
});

app.on('window-all-closed', () => {
  // The hidden window a thumbnail is captured in is still a window, and
  // destroying it fires this. That is not the app being closed — and treating
  // it as one killed the dev server (and, off macOS, quit) in the middle of
  // taking a picture.
  if (mainWindow && !mainWindow.isDestroyed()) {
    return;
  }
  stopDevServer();
  // The pty ids are keyed to the window that opened them, so a surviving shell
  // could never be reached again — and on macOS the app stays running.
  cleanupTerminals();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopWatchingProject();
  stopDevServer();
});
// Reading a project's content config leaves a process behind holding its
// schemas; they go when the app does.
app.on('before-quit', () => stopAllServices());
// The preview checkouts live inside the user's projects, so leaving one behind
// leaves a stray folder in a place they will notice.
app.on('before-quit', () => stopAllPreviews());
// A pty outlives the window that opened it unless it is killed.
app.on('before-quit', () => cleanupTerminals());

// ---------------------------------------------------------------------------
// Auto update
//
// Feed is the GitHub releases repo configured under `build.publish` in
// package.json. The appId must stay `com.stacki.editor` so installs from
// earlier versions upgrade in place instead of landing beside themselves.
// ---------------------------------------------------------------------------

const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let autoUpdateInterval: ReturnType<typeof setTimeout> | undefined;
let autoUpdateCheckInFlight = false;
let autoUpdateErrorDialogShown = false;
// A check somebody asked for, rather than the scheduled one. It answers in a
// dialog either way, so the error handler below leaves the talking to it.
let manualUpdateCheck = false;

// Update-check failures the user can do nothing about, and so should never
// see a dialog for: they're offline, or a release is mid-publish and its
// channel file for this platform hasn't uploaded yet. Both resolve on their
// own by the next check.
function isExpectedAutoUpdateNetworkError(error: unknown) {
  const code = String(toRecord(error)?.['code'] || '').toUpperCase();
  const message = String(toRecord(error)?.['message'] || error || '').toLowerCase();

  // A release whose other platform published first: the channel file is
  // briefly absent, which surfaces as a 404 on latest-mac.yml / latest.yml.
  if (
    message.includes('cannot find latest') ||
    (message.includes('404') && message.includes('.yml'))
  ) {
    return true;
  }

  if (
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ERR_INTERNET_DISCONNECTED',
      'ERR_NAME_NOT_RESOLVED',
    ].includes(code)
  ) {
    return true;
  }

  return [
    'internet disconnected',
    'name not resolved',
    'network',
    'offline',
    'socket hang up',
    'timed out',
    'getaddrinfo',
    'failed to fetch',
    'could not connect',
    'connection refused',
  ].some((fragment) => message.includes(fragment));
}

function formatAutoUpdateError(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function logAutoUpdate(message: string, details?: unknown) {
  const detailText =
    details === undefined
      ? ''
      : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
  const line = `[${new Date().toISOString()}] ${message}${detailText}`;

  console.log(line);

  if (!app.isReady()) {
    return;
  }

  try {
    const logsDirectory = app.getPath('logs');
    fs.mkdirSync(logsDirectory, { recursive: true });
    fs.appendFileSync(path.join(logsDirectory, 'auto-update.log'), `${line}\n`);
  } catch (error: unknown) {
    console.warn('Failed to write auto update log:', error);
  }
}

async function promptToInstallDownloadedUpdate(version: string) {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = await showMessageBox(parent, {
    type: 'info',
    title: 'Update Ready',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: `Stacki ${version} has been downloaded.`,
    detail: 'Restart Stacki to install the update.',
  });

  if (response === 0) {
    stopDevServer();
    autoUpdater.quitAndInstall();
  }
}

function registerAutoUpdaterEvents() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => logAutoUpdate('Checking for updates'));
  autoUpdater.on('update-available', (info) =>
    logAutoUpdate('Update available', { version: info.version }),
  );
  autoUpdater.on('update-not-available', (info) =>
    logAutoUpdate('No update available', { version: info.version }),
  );

  autoUpdater.on('update-downloaded', (info) => {
    logAutoUpdate('Update downloaded', { version: info.version });
    void promptToInstallDownloadedUpdate(info.version);
  });

  autoUpdater.on('error', (error) => {
    logAutoUpdate('Auto update error', formatAutoUpdateError(error));

    // A check from the File menu reports its own failure, and reports it even
    // when this dialog has already been shown once — two dialogs for the one
    // click would be worse than none.
    if (manualUpdateCheck) {
      return;
    }
    if (autoUpdateErrorDialogShown || isExpectedAutoUpdateNetworkError(error)) {
      return;
    }
    autoUpdateErrorDialogShown = true;

    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    void showMessageBox(parent, {
      type: 'warning',
      title: 'Update Check Failed',
      message: 'Stacki could not check for updates.',
      // The raw error carries response headers and a stack trace; the full
      // text is in the log, so show the user only the first line.
      detail:
        formatAutoUpdateError(error).split('\n')[0]?.slice(0, 200) +
        '\n\nStacki will try again later.',
    });
  });
}

async function runAutoUpdateCheck() {
  if (!app.isPackaged || autoUpdateCheckInFlight) {
    return;
  }

  autoUpdateCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (error: unknown) {
    if (!isExpectedAutoUpdateNetworkError(error)) {
      console.warn('Auto update check failed:', error);
    }
  } finally {
    autoUpdateCheckInFlight = false;
  }
}

// The File menu's own check. The scheduled one is deliberately silent — it
// logs, and speaks up only when there is something to install — but somebody
// who asks is owed an answer either way, "you already have the latest"
// included. Otherwise the menu item looks broken every time it works.
async function checkForUpdatesFromMenu() {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;

  // Nothing to check against: electron-updater reads the feed the installer
  // was built with, and a dev run has no installer. Saying so beats a check
  // that silently does nothing.
  if (!app.isPackaged) {
    await showMessageBox(parent, {
      type: 'info',
      title: 'Check for Updates',
      message: 'Updates are only checked in the installed app.',
      detail:
        `This is a development build (${app.getVersion()}), ` +
        'which updates when you rebuild it.',
    });
    return;
  }

  if (autoUpdateCheckInFlight) {
    await showMessageBox(parent, {
      type: 'info',
      title: 'Check for Updates',
      message: 'Already checking for updates.',
    });
    return;
  }

  autoUpdateCheckInFlight = true;
  manualUpdateCheck = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    // `downloadPromise` is the difference between "there is a newer version"
    // and "there is a version": the feed always names one, and downloading is
    // what electron-updater does only when it is actually newer.
    if (result?.downloadPromise) {
      logAutoUpdate('Manual check found an update', { version: result.updateInfo?.version });
      await showMessageBox(parent, {
        type: 'info',
        title: 'Update Available',
        message: `Stacki ${result.updateInfo?.version} is downloading.`,
        detail: 'You’ll be asked whether to restart once it has finished.',
      });
      return;
    }
    logAutoUpdate('Manual check found no update', { version: app.getVersion() });
    await showMessageBox(parent, {
      type: 'info',
      title: 'Check for Updates',
      message: `Stacki ${app.getVersion()} is the latest version.`,
    });
  } catch (error: unknown) {
    logAutoUpdate('Manual check failed', formatAutoUpdateError(error));
    await showMessageBox(parent, {
      type: 'warning',
      title: 'Check for Updates',
      // The raw error carries response headers and a stack; the log has all of
      // it, the dialog gets the first line.
      message: 'Stacki could not check for updates.',
      detail: formatAutoUpdateError(error).split('\n')[0]?.slice(0, 200) ?? '',
    });
  } finally {
    autoUpdateCheckInFlight = false;
    manualUpdateCheck = false;
  }
}

function startAutoUpdateChecks() {
  if (!app.isPackaged) {
    logAutoUpdate('Skipping auto update checks in development');
    return;
  }

  registerAutoUpdaterEvents();
  void runAutoUpdateCheck();

  if (autoUpdateInterval) {
    clearInterval(autoUpdateInterval);
  }
  autoUpdateInterval = setInterval(() => void runAutoUpdateCheck(), AUTO_UPDATE_CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(channel: string, payload?: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Finding Node
//
// Launched from Finder or the Dock, the app inherits launchd's PATH —
// `/usr/bin:/bin:/usr/sbin:/sbin` — not the shell's. Nothing installed by
// Homebrew, nvm, fnm, volta, or the Node installer is on it, so `astro` (a
// `#!/usr/bin/env node` shim) dies with "env: node: No such file or
// directory" and `npm install` fails as ENOENT. Launched from a terminal it
// all works, which is why this only bites in the packaged app.
// ---------------------------------------------------------------------------

// Interactive login shell, because that's the one that sources .zshrc/.bashrc
// where version managers put themselves. Marker-delimited so rc-file chatter
// around the value can't be mistaken for it.
function shellPathDirectories() {
  // $SHELL is usually set even under launchd, but not always — the account's
  // registered login shell is the reliable source when it isn't.
  let shell: string | undefined = process.env['SHELL'];
  if (!shell) {
    try {
      shell = userInfo().shell || undefined;
    } catch {
      shell = undefined;
    }
  }
  if (!shell) {
    return [];
  }
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__AVB__%s__AVB__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Quieter rc files: no pagers, no update prompts, no color codes.
      env: { ...process.env, TERM: 'dumb', DISABLE_AUTO_UPDATE: 'true' },
    });
    const match = /__AVB__([\s\S]*?)__AVB__/.exec(out);
    return match ? (capture(match, 1) ?? '').split(path.delimiter).filter(Boolean) : [];
  } catch {
    return []; // no shell, hung rc file, exotic setup — fall through to the guesses
  }
}

const cmpVersion = (left: string, right: string) => {
  const parts = (version: string) =>
    version
      .replace(/^v/, '')
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
  const [x, y] = [parts(left), parts(right)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return (x[i] ?? 0) - (y[i] ?? 0);
    }
  }
  return 0;
};

// Where Node ends up when the shell probe comes back empty — every install
// route in common use, since we can't ask the user which one they took.
function nodeDirectoryGuesses() {
  const home = app.getPath('home');
  const directories = isWin
    ? [...staticToolPathGuesses(home, process.env)]
    : [
        '/opt/homebrew/bin', // Homebrew, Apple Silicon
        '/usr/local/bin', // Homebrew on Intel, and the official installer
        '/opt/local/bin', // MacPorts
        '/snap/bin', // Linux snap
        path.join(home, '.volta/bin'),
        path.join(home, '.asdf/shims'),
        path.join(home, '.nodenv/shims'),
        path.join(home, '.local/share/mise/shims'),
        path.join(home, '.local/bin'),
        path.join(home, '.npm-global/bin'),
        path.join(home, 'n/bin'),
      ];
  // Version managers keep one directory per version — take the newest, so a
  // project needing a modern Node still gets one.
  const versioned: readonly (readonly [string, string])[] = isWin
    ? [[path.join(home, 'AppData', 'Roaming', 'nvm'), '']]
    : [
        [path.join(home, '.nvm/versions/node'), 'bin'],
        [path.join(home, '.local/share/fnm/node-versions'), 'installation/bin'],
        [path.join(home, 'Library/Application Support/fnm/node-versions'), 'installation/bin'],
        [path.join(home, '.fnm/node-versions'), 'installation/bin'],
        [path.join(home, '.asdf/installs/nodejs'), 'bin'],
        [path.join(home, '.nodenv/versions'), 'bin'],
        [path.join(home, '.local/share/mise/installs/node'), 'bin'],
        ['/usr/local/n/versions/node', 'bin'],
      ];
  for (const [base, suffix] of versioned) {
    try {
      const newest = fs
        .readdirSync(base)
        .filter((version) => /^v?\d/.test(version))
        .sort(cmpVersion)
        .pop();
      if (newest) {
        directories.push(suffix ? path.join(base, newest, suffix) : path.join(base, newest));
      }
    } catch {
      /* not installed */
    }
  }
  return directories;
}

// Costs a shell spawn, so it runs once, lazily — nothing needs it until a
// child process is about to start.
let toolPathReady = false;
function ensureToolPath() {
  if (toolPathReady) {
    return;
  }
  toolPathReady = true;
  const candidates: string[] = [];
  // Appended, not prepended: the system's own resolution order stays intact,
  // and these directories only ever win for tools the base PATH lacks.
  if (!isWin) {
    candidates.push(...shellPathDirectories());
  }
  for (const directory of nodeDirectoryGuesses()) {
    if (fs.existsSync(directory)) {
      candidates.push(directory);
    }
  }
  const current = pathEnvironmentValue(process.env);
  setPathEnvironment(process.env, mergeToolPaths(current, candidates));
}

function resolveNodeBin() {
  ensureToolPath();
  const exe = isWin ? 'node.exe' : 'node';
  for (const directory of pathEnvironmentValue(process.env).split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, exe);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* not here */
    }
  }
  return undefined;
}

// node_modules/.bin/<name> is a symlink to the package's JS entry on POSIX
// and a wrapper script on Windows. The package's own `bin` field is correct
// on both (and survives pnpm's store layout, where the symlink points
// somewhere else entirely), so read that first and fall back to the link.
function resolveCliEntry(binPath: string) {
  const name = path.basename(binPath).replace(/\.(cmd|ps1|exe|bat)$/i, '');
  const pkgDirectory = path.join(path.dirname(binPath), '..', name);
  try {
    const pkg = parseRecord(readJson(path.join(pkgDirectory, 'package.json')));
    const bin = pkg['bin'];
    const rel = parseOptionalString(typeof bin === 'string' ? bin : toRecord(bin)?.[name]);
    if (rel) {
      const entry = path.join(pkgDirectory, rel);
      if (fs.existsSync(entry)) {
        return entry;
      }
    }
  } catch {
    /* not a plain node_modules layout */
  }
  try {
    const real = fs.realpathSync(binPath);
    if (/\.(js|mjs|cjs)$/i.test(real)) {
      return real;
    }
  } catch {
    /* not a symlink */
  }
  return undefined;
}

// Runs the CLI's JS entry point under a resolved Node instead of going
// through the .bin shim, so the shebang's own PATH lookup — the thing that
// fails on a GUI launch — never happens. Returns [command, argv].
function nodeCliCommand(binPath: string, args: readonly string[]): [string, string[]] {
  const node = resolveNodeBin();
  if (!node) {
    return [binPath, [...args]];
  }
  const entry = resolveCliEntry(binPath);
  return entry ? [node, [entry, ...args]] : [binPath, [...args]];
}

function run(cmd: string, args: readonly string[], cwd: string, options: ExecFileOptions = {}) {
  // Launched from Finder, the packaged app inherits a bare PATH — Homebrew's
  // bin isn't on it, so `gh` looks uninstalled however it was set up. Cheap
  // after the first call (memoized).
  ensureToolPath();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd,
        timeout: options.timeout || 60000,
        shell: commandNeedsShell(cmd),
        maxBuffer: MAIN_LIMITS.commandOutputBytesMax,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
        } else {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        }
      },
    );
  });
}

async function git(projectPath: string, args: readonly string[], options: ExecFileOptions = {}) {
  return run('git', args, projectPath, options);
}

async function findFreePort(start: number): Promise<number> {
  assert(Number.isSafeInteger(start), 'Starting port must be an integer');
  assert(start > 0, 'Starting port must be positive');
  for (let attempt = 0; attempt < MAIN_LIMITS.portAttemptsMax; attempt++) {
    const port = start + attempt;
    if (port > 65535) {
      break;
    }
    const available = await findFreePortProbe(port);
    if (available) {
      return port;
    }
  }
  throw new Error('No available preview port within the search limit');
}

function findFreePortProbe(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

// The page formats Astro routes from a file: .astro, plus markdown when the
// project has the integration for it (.md always, .mdx via @astrojs/mdx).
// Kept as one place so discovery, routing and reading can't drift apart.
const PAGE_MD_RE = /\.mdx?$/i;
const isMarkdownPage = (filePath: string) => PAGE_MD_RE.test(filePath);
const isMdx = (filePath: string) => /\.mdx$/i.test(filePath);

function listAstroFiles(directory: string) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const out: string[] = [];
  const checkDirectory = directoryBudget(directory);
  const walk = (folder: string, depth: number): void => {
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    checkDirectory(folder, entries.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'listAstroFiles: the budget bounds depth');
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      }
      // Markdown only counts as a page. A .md under src/components isn't a
      // component, it's a README.
      else if (
        entry.name.endsWith('.astro') ||
        (folder.includes(`${path.sep}pages`) && PAGE_MD_RE.test(entry.name))
      ) {
        out.push(full);
      }
    }
  };
  walk(directory, 0);
  return out;
}

function toPosix(filePath: string) {
  return filePath.split(path.sep).join('/');
}

function routeForPage(projectPath: string, pagePath: string) {
  const pagesDirectory = path.join(projectPath, 'src', 'pages');
  let rel = toPosix(path.relative(pagesDirectory, pagePath)).replace(/\.(astro|mdx?)$/i, '');
  if (rel === 'index') {
    return '/';
  }
  if (rel.endsWith('/index')) {
    rel = rel.slice(0, -'/index'.length);
  }
  return '/' + rel;
}

// Astro's dev server enforces the project's `trailingSlash`. Under 'always' a
// slashless URL is answered with a 404 and Astro's own page asking "Do you
// want to go to /de/hotel/ instead?"; under 'never' the slash is the 404. The
// canvas points at real URLs, so it has to know which spelling it serves.
const TRAILING_SLASH_MODES = ['always', 'never', 'ignore'];
const ASTRO_CONFIG_FILES = [
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.mts',
  'astro.config.ts',
  'astro.config.cjs',
];

// Read from the config's text, not by importing it: the file is ESM, is often
// TypeScript, and is written to be loaded by Astro rather than by this
// process. Whole-line comments go first so a commented-out setting doesn't
// count; a trailing `//` is left alone because it can't be told from the one
// in a URL without really parsing.
function trailingSlashFromSource(text: string) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const match = code.match(/(^|[\s,{])trailingSlash\s*:\s*['"`](always|never|ignore)['"`]/);
  return match ? capture(match, 2) : undefined;
}

function readTrailingSlash(projectPath: string) {
  // What the dev server resolved beats what the config says: it has been
  // through Astro's own defaults, and it accounts for a value that arrives by
  // variable, spread or integration rather than as a literal. Only this app's
  // own server writes it, so it is only trustworthy while that server is the
  // one running — an adopted external server never loads the marker config,
  // and a file left behind by an earlier run would answer for a config that
  // has since changed.
  const ours =
    devServer && sameFilesystemPath(devServer.projectPath, projectPath) && !devServer.external;
  try {
    if (!ours) {
      throw new Error('no server of ours');
    }
    const resolved = parseRecord(
      readJson(path.join(projectPath, 'node_modules', '.avb', 'resolved.json')),
    );
    const mode = parseOptionalString(resolved['trailingSlash']);
    if (mode && TRAILING_SLASH_MODES.includes(mode)) {
      return mode;
    }
  } catch {
    /* no server has run yet — read the config instead */
  }
  for (const file of ASTRO_CONFIG_FILES) {
    let text;
    try {
      text = readSource(path.join(projectPath, file));
    } catch {
      continue;
    }
    const mode = trailingSlashFromSource(text);
    if (mode) {
      return mode;
    }
    break; // the first config that exists is the one Astro loads
  }
  return 'ignore'; // Astro's default, and the one that serves either spelling
}

function isAstroProject(directory: string) {
  const pkgPath = path.join(directory, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = parseRecord(readJson(pkgPath));
      const deps = { ...toRecord(pkg['dependencies']), ...toRecord(pkg['devDependencies']) };
      if (parseOptionalString(deps['astro'])) {
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  return ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'].some((file) =>
    fs.existsSync(path.join(directory, file)),
  );
}

// ---------------------------------------------------------------------------
// Settings
//
// One file, read once at startup and written on every change. Only the app's
// own preferences live here — anything about a project belongs to the project.
// ---------------------------------------------------------------------------

// Sound is off. An editor that makes a noise the first time somebody touches it
// is an editor they turn off, so it is asked for rather than opted out of.
const SETTINGS_DEFAULTS = { sound: false };
let settings = { ...SETTINGS_DEFAULTS };

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    const input: unknown = JSON.parse(readSource(settingsFile()));
    return parseSettings(input);
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function writeSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch {
    /* non-fatal — the setting still holds for this run */
  }
}

// The renderer asks once on load; the menu pushes every change after that.
ipcMain.handle('settings:get', () => settings);

// ---------------------------------------------------------------------------
// Recent projects + preview thumbnails
// ---------------------------------------------------------------------------

const recentsFile = () => path.join(app.getPath('userData'), 'recents.json');

function readRecents() {
  try {
    const input: unknown = JSON.parse(readSource(recentsFile()));
    return parseRecents(input);
  } catch {
    return [];
  }
}

function writeRecents(list: readonly RecentProject[]) {
  try {
    fs.writeFileSync(recentsFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
}

ipcMain.handle('recents:list', async () => {
  // Drop entries whose folder is gone or no longer looks like an Astro project.
  const list = readRecents().filter((recent) => {
    try {
      return fs.existsSync(recent.path) && isAstroProject(recent.path);
    } catch {
      return false;
    }
  });
  const userData = app.getPath('userData');
  return list.map((recent) => {
    // `stale` compares the picture against the files it was taken from, so a
    // project edited in another editor — or by a teammate, through git — says
    // so on the card instead of showing last month's homepage as if it were
    // today's.
    let stale = true;
    let thumb: string | undefined = undefined;
    try {
      thumb = thumbs.readThumb(userData, recent.path) ?? undefined;
      stale = thumbs.isStale(userData, recent.path);
    } catch {
      /* card renders a placeholder */
    }
    return { ...recent, thumb, stale: !!stale, canRefresh: hasDependencies(recent.path) };
  });
});

// Astro has to be installed for a page to be rendered at all; without it the
// card can only offer to open the project.
function hasDependencies(projectPath: string) {
  const binName = isWin ? 'astro.cmd' : 'astro';
  return fs.existsSync(path.join(projectPath, 'node_modules', '.bin', binName));
}

ipcMain.handle('recents:add', async (_event, projectPath) => {
  const list = readRecents().filter((recent) => !sameFilesystemPath(recent.path, projectPath));
  list.unshift({
    path: projectPath,
    name: path.basename(projectPath),
    openedAt: Date.now(),
  });
  writeRecents(list.slice(0, 12));
  return { ok: true as const };
});

ipcMain.handle('recents:remove', async (_event, projectPath) => {
  writeRecents(readRecents().filter((recent) => !sameFilesystemPath(recent.path, projectPath)));
  // The picture and the note about when it was taken both go.
  thumbs.forget(app.getPath('userData'), projectPath);
  return { ok: true as const };
});

// The project's home page, rendered on its own and photographed from the top.
//
// Two ways in. The project that is open already has a dev server, so its
// picture costs one hidden window. A project on the start screen has nothing
// running, so one is started for it, used, and stopped again — which is what
// makes "the site as it is now" true for a project that was last edited
// somewhere else entirely.
const queueCapture = createSerialQueue(); // each capture owns a browser and a server
// Bumped when a project is opened. A capture waiting its turn behind another
// one belongs to a start screen that is no longer on screen — and the machine
// is now busy starting the project the user actually asked for.
let captureEra = 0;

function captureThumb(projectPath: string) {
  const era = captureEra;
  return queueCapture(() =>
    era === captureEra ? doCaptureThumb(projectPath) : { ok: false as const, error: 'skipped' },
  );
}

async function doCaptureThumb(projectPath: string) {
  const userData = app.getPath('userData');
  // Already running for this project (it is the one that is open) — use it.
  if (devServer && sameFilesystemPath(devServer.projectPath, projectPath) && devServer.url) {
    if (await serverAlive(devServer.url)) {
      return thumbs.capture(userData, projectPath, devServer.url + '/');
    }
  }
  if (!hasDependencies(projectPath)) {
    return { ok: false as const, error: 'This project has no dependencies installed yet.' };
  }
  return withTemporaryServer(projectPath, (url) =>
    thumbs.capture(userData, projectPath, url + '/'),
  );
}

// A dev server for a project that is not open, kept apart from the app's own:
// `devServer` belongs to the canvas, and a thumbnail must not disturb what the
// editor is showing. The project's own config is used rather than the app's
// generated one — the picture is of the site, not of the canvas.
function spawnAstroServer(projectPath: string, localBin: string, args: readonly string[]) {
  const [cmd, argv] = nodeCliCommand(localBin, args);
  return spawn(cmd, argv, {
    cwd: projectPath,
    shell: commandNeedsShell(cmd),
    // Give descendants their own process group so closing a project can stop
    // Vite and Astro together, including CLIs that launch another process.
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
}

function stopProcessTree(proc: ChildProcess | undefined) {
  if (!proc?.pid) {
    return;
  }
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => {
          try {
            proc.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        },
      );
    } else {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function withTemporaryServer(
  projectPath: string,
  capture: (url: string) => ReturnType<typeof thumbs.capture>,
) {
  const binName = isWin ? 'astro.cmd' : 'astro';
  const localBin = path.join(projectPath, 'node_modules', '.bin', binName);
  const port = await findFreePort(4400 + Math.floor(Math.random() * 200));
  const proc = spawnAstroServer(projectPath, localBin, [
    'dev',
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
  ]);
  const spawnState: { error?: Error } = {};
  proc.on('error', (error) => {
    spawnState.error = error;
  });
  let log = '';
  proc.stdout.on('data', (chunk) => (log = (log + chunk).slice(-4000)));
  proc.stderr.on('data', (chunk) => (log = (log + chunk).slice(-4000)));

  const url = `http://127.0.0.1:${port}`;
  const stop = () => {
    // Astro >= 7 forks the real server and the CLI exits, so killing what was
    // spawned is not enough — the CLI is asked to stop it, and the process
    // group is killed for the versions that do not fork.
    try {
      // Opening this project can replace the thumbnail's daemon while its
      // capture is running. Stop only the daemon that still owns our port.
      const lock = readAstroLock(projectPath);
      if (
        lock?.url &&
        new URL(lock.url).port === String(port) &&
        (!devServer || !sameFilesystemPath(devServer.projectPath, projectPath))
      ) {
        const [stopCmd, stopArgv] = nodeCliCommand(localBin, ['dev', 'stop']);
        execFile(
          stopCmd,
          stopArgv,
          { ...SHORT_COMMAND, cwd: projectPath, shell: commandNeedsShell(stopCmd) },
          () => {},
        );
      }
    } catch {
      /* best effort */
    }
    stopProcessTree(proc);
  };

  try {
    const deadline = Date.now() + 45000;
    let up = false;
    while (Date.now() < deadline) {
      if (spawnState.error) {
        return { ok: false as const, error: spawnState.error.message };
      }
      if (proc.exitCode !== null && proc.exitCode !== 0) {
        break;
      }
      if (await serverAlive(url)) {
        up = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!up) {
      return {
        ok: false as const,
        error: cleanDevLog(log) || 'the dev server did not start in time',
      };
    }
    return await capture(url);
  } finally {
    stop();
  }
}

const cleanDevLog = (text: string) =>
  String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\[?\d{1,2}:\d{2}/.test(line))
    .slice(-2)
    .join(' ')
    .slice(0, 300);

// Asked for by the start screen, for a card whose picture is out of date.
ipcMain.handle('recents:refreshThumb', async (_event, projectPath) => {
  const result = await captureThumb(projectPath);
  const userData = app.getPath('userData');
  return {
    ...result,
    thumb: thumbs.readThumb(userData, projectPath) ?? undefined,
    stale: thumbs.isStale(userData, projectPath),
  };
});

// While a project is open, its picture is kept current in the background: once
// when the preview comes up, and again a while after the last edit. Neither
// touches the window the user is working in.
let thumbTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleThumb(projectPath: string, delay: number) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    if (!devServer || !sameFilesystemPath(devServer.projectPath, projectPath)) {
      return;
    }
    if (!thumbs.isStale(app.getPath('userData'), projectPath)) {
      return;
    }
    captureThumb(projectPath)
      .then((result) => {
        if (result?.ok) {
          send('recents:thumb', { projectPath });
        }
      })
      .catch((error: unknown) => {
        // A background refresh: the old picture stays, and the log says why.
        console.error('[thumbs] capture failed:', error);
      });
  }, delay);
  if (thumbTimer.unref) {
    thumbTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Project IPC
// ---------------------------------------------------------------------------

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

ipcMain.handle('project:newDialog', async () => {
  const result = await showOpenDialog({
    title: 'Choose an empty folder for the new project',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true as const };
  }
  const directory = result.filePaths[0];
  assert(directory !== undefined, 'Accepted directory dialog must have a path');
  const entries = fs.readdirSync(directory).filter((name) => !name.startsWith('.'));
  if (entries.length > 0) {
    return {
      canceled: false as const,
      error: 'That folder is not empty. Choose or create an empty folder for the new project.',
    };
  }
  return { canceled: false as const, projectPath: directory };
});

// Detects the project's package manager from its lockfile.
function detectPackageManager(directory: string) {
  if (fs.existsSync(path.join(directory, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(directory, 'yarn.lock'))) {
    return 'yarn';
  }
  if (
    fs.existsSync(path.join(directory, 'bun.lockb')) ||
    fs.existsSync(path.join(directory, 'bun.lock'))
  ) {
    return 'bun';
  }
  return 'npm';
}

async function installDependencies(directory: string) {
  ensureToolPath(); // npm/pnpm/yarn are Node shims — same PATH problem as astro
  const pm = detectPackageManager(directory);
  send('progress', { message: `Installing dependencies (${pm} install)…` });
  const args = pm === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install'];
  try {
    await run(isWin ? `${pm}.cmd` : pm, args, directory, {
      timeout: 10 * 60 * 1000,
      shell: isWin,
    });
  } catch (error: unknown) {
    if (toRecord(error)?.['code'] === 'ENOENT') {
      throw new Error(
        `This project uses ${pm} (found its lockfile), but ${pm} is not installed. ` +
          'Install it and try again.',
      );
    }
    throw new Error(`${pm} install failed: ${gitErrorDetail(error).slice(-400)}`);
  }
}

// Clears the progress line: no message (src/appBridge.ts, onAppProgress). IPC is
// a structured clone, which keeps the absent value.
const PROGRESS_CLEARED = { message: undefined } as const;

// Runs the real `npm create astro@latest`, answering the questions the CLI
// would ask interactively with the choices collected in the app's wizard.
// Output is streamed to the renderer so the user sees the same progress the
// terminal would show. The chosen folder is the cwd and "." the target, so
// create-astro never has to guess a name from a parent directory.
ipcMain.handle('project:createAstro', async (_event, options) => {
  const {
    dir: directory,
    template = 'basics',
    install = true,
    git = true,
    ai = false,
  } = options || {};
  if (!directory || !fs.existsSync(directory)) {
    throw new Error('Choose a folder for the new project first.');
  }
  ensureToolPath(); // npm is a Node shim — same PATH problem as astro

  const args = [
    'create',
    'astro@latest',
    '.',
    '--',
    '--template',
    template,
    install ? '--install' : '--no-install',
    git ? '--git' : '--no-git',
    ...(ai ? [] : ['--no-ai']),
    '--skip-houston',
    '--yes', // accept defaults for anything not covered above
  ];

  send('create:log', `> npm ${args.join(' ')}\n\n`);
  await runCreateAstro(directory, args);
  return { ok: true as const, installed: install };
});

// The create-astro run itself, its output streamed to the wizard's log. It
// settles once the CLI exits and a package.json has landed in `directory`.
function runCreateAstro(directory: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(isWin ? 'npm.cmd' : 'npm', [...args], {
        cwd: directory,
        shell: isWin,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      });
    } catch (error: unknown) {
      reject(new Error(`Could not run npm: ${errorMessage(error)}`));
      return;
    }

    let tail = '';
    const onOut = (chunk: Buffer) => {
      // create-astro animates with cursor moves and line clears; strip the
      // escape codes so the log pane reads as plain text.
      const text = chunk
        .toString()
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r/g, '\n');
      tail = (tail + text).slice(-4000);
      send('create:log', text);
    };
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('error', (error) => {
      reject(
        new Error(
          toRecord(error)?.['code'] === 'ENOENT'
            ? 'npm could not be found. Install Node.js (which includes npm) and try again.'
            : `Could not run npm: ${errorMessage(error)}`,
        ),
      );
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        // Sanity-check that a project actually landed.
        if (!fs.existsSync(path.join(directory, 'package.json'))) {
          reject(new Error(`create-astro finished but no package.json appeared.\n\n${tail}`));
          return;
        }
        resolve();
      } else {
        reject(new Error(`create-astro exited with code ${code}.\n\n${tail}`));
      }
    });
  });
}

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
ipcMain.handle('project:createStarter', async (_event, { starter = 'lumos', parentPath, name }) => {
  ensureToolPath(); // npm and git are both on the PATH the Dock does not have
  const result = await createStarter({
    starter,
    parentPath,
    name,
    onLog: (text) => send('create:log', text),
  });
  send('create:log', '\n> installing dependencies\n');
  await installDependencies(result.projectPath);
  send('progress', PROGRESS_CLEARED);
  return result;
});

ipcMain.handle('project:scaffold', async (_event, { dir: directory, name }) => {
  scaffoldProject(directory, name);
  await installDependencies(directory);
  return { ok: true as const };
});

ipcMain.handle('project:hasNodeModules', async (_event, projectPath) => {
  return fs.existsSync(path.join(projectPath, 'node_modules'));
});

ipcMain.handle('project:install', async (_event, projectPath) => {
  await installDependencies(projectPath);
  return { ok: true as const };
});

ipcMain.handle('project:scan', async (_event, projectPath) => {
  // Also set here, not just in watch:start — the Assets panel can render
  // thumbnails before the watcher starts, and they'd be refused.
  openProjectRoot = path.resolve(projectPath);
  const sourceDirectory = path.join(projectPath, 'src');
  const pagesDirectory = path.join(sourceDirectory, 'pages');
  const layoutsDirectory = path.join(sourceDirectory, 'layouts');
  const componentsDirectory = path.join(sourceDirectory, 'components');

  const pages = listAstroFiles(pagesDirectory).map((filePath) => ({
    path: filePath,
    name: toPosix(path.relative(pagesDirectory, filePath)),
    route: routeForPage(projectPath, filePath),
  }));

  // Folders under src/pages (including empty ones) for the pages tree.
  const pageFolders: string[] = [];
  if (fs.existsSync(pagesDirectory)) {
    const checkDirectory = directoryBudget(pagesDirectory);
    const walkDirectories = (folder: string, depth: number): void => {
      const entries = fs.readdirSync(folder, { withFileTypes: true });
      checkDirectory(folder, entries.length);
      assert(depth <= MAIN_LIMITS.directoryDepthMax, 'project:scan: the budget bounds depth');
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const full = path.join(folder, entry.name);
        pageFolders.push(toPosix(path.relative(pagesDirectory, full)));
        walkDirectories(full, depth + 1);
      }
    };
    walkDirectories(pagesDirectory, 0);
  }

  // `folder` groups these in the components panel. Layouts are relative to
  // src, so they read as the folder they're actually in ("layouts", or
  // "layouts/marketing"); components are relative to src/components, whose
  // own root is the ungrouped case.
  const layouts = listAstroFiles(layoutsDirectory).map((filePath) => ({
    path: filePath,
    name: path.basename(filePath, '.astro'),
    folder: toPosix(path.relative(sourceDirectory, path.dirname(filePath))),
    instances: 0,
    isLayout: true,
    ...safeSchema(filePath, projectPath),
  }));

  const components = listAstroFiles(componentsDirectory).map((filePath) => ({
    path: filePath,
    name: path.basename(filePath, '.astro'),
    folder: toPosix(path.relative(componentsDirectory, path.dirname(filePath))),
    instances: 0,
    ...safeSchema(filePath, projectPath),
  }));

  // Instance counts: how often each component is used across every .astro
  // file in src (pages, layouts, and other components).
  const allSources = listAstroFiles(sourceDirectory).map((file) => {
    try {
      return { file, text: readSource(file) };
    } catch {
      return { file, text: '' };
    }
  });
  // Layouts are counted too: they show up in the palette alongside
  // components, so the instance line has to mean the same thing for both.
  // Counted by the same function the "where is it used" list counts with —
  // when the number and the list disagree, nothing says which one is wrong.
  // That function counts under the name each FILE imports it as: a layout
  // imported as `Layout` is never written `<BaseLayout>`, and counting the
  // filename found none of them.
  const importAliases = aliasMap(projectPath);
  for (const comp of [...components, ...layouts]) {
    comp.instances = allSources.reduce(
      (count, { file, text }) =>
        count +
        (sameFilesystemPath(file, comp.path)
          ? 0 // a file is not one of its own users
          : instancesIn(text, {
              file,
              targetPath: comp.path,
              name: comp.name,
              aliases: importAliases,
            })),
      0,
    );
  }

  return { pages, layouts, components, pageFolders, trailingSlash: readTrailingSlash(projectPath) };
});

// Every CSS class name used anywhere under src/ — class attributes in markup
// plus selectors in stylesheets and <style> blocks — for the class-prop
// autocomplete in the props panel.
ipcMain.handle('project:classes', async (_event, projectPath) => {
  const out = new Set<string>();
  const exts = /\.(astro|css|scss|less|html|jsx|tsx|js|ts|vue|svelte)$/i;
  const files: string[] = [];
  const checkDirectory = directoryBudget(path.join(projectPath, 'src'));
  const walk = (folder: string, depth: number): void => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    checkDirectory(folder, entries.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'project:classes: the budget bounds depth');
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (exts.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(path.join(projectPath, 'src'), 0);

  const addCssClasses = (css: string) => {
    const re = /(?:^|[\s,{>~+()])\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
    let match;
    while ((match = re.exec(css)) !== null) {
      out.add(capture(match, 1));
    }
  };
  for (const file of files) {
    let content;
    try {
      content = readSource(file);
    } catch {
      continue;
    }
    if (/\.(css|scss|less)$/i.test(file)) {
      addCssClasses(content);
      continue;
    }
    const attrRe = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = attrRe.exec(content)) !== null) {
      for (const token of (match[1] ?? match[2] ?? '').split(/\s+/)) {
        if (token) {
          out.add(token);
        }
      }
    }
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let sm;
    while ((sm = styleRe.exec(content)) !== null) {
      addCssClasses(capture(sm, 1));
    }
  }
  return [...out].sort();
});

// The declaration text for every type this file imports, so `type Props =
// SeoProps` can be read when SeoProps lives in types.ts. One level deep and
// only within the project — enough for the shape components actually use,
// without turning this into a type checker.
function importedTypes(source: string, filePath: string, projectPath: string) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) {
    return '';
  }
  const out: string[] = [];
  const seen = new Set();
  // `import type { A, B } from '…'`, `import { type A } from '…'`, and the
  // default form — a type-only import is the common way to write this, but a
  // plain `import { X }` of a type is legal too.
  const re = /import\s+(?:type\s+)?(\{[^}]*\}|[\w$]+)\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(capture(fm, 1))) !== null) {
    const names = capture(match, 1)
      .replace(/[{}]/g, '')
      .split(',')
      .map(
        (specifier) =>
          specifier
            .replace(/\btype\b/, '')
            .split(/\s+as\s+/)[0]
            ?.trim() ?? '',
      )
      .filter(Boolean);
    if (!names.length) {
      continue;
    }
    const target = resolveImportPath(projectPath, filePath, capture(match, 2));
    if (!target || seen.has(target) || target.endsWith('.astro')) {
      continue;
    }
    seen.add(target);
    let text;
    try {
      text = readSource(target);
    } catch {
      continue;
    }
    // Only the declarations that were actually imported, so an unrelated type
    // in the same file can't shadow one the component declares itself.
    for (const name of names) {
      const decl = new RegExp(
        `(?:^|\n)\\s*(?:export\\s+)?(?:type|interface)\\s+${name.replace(/[^\w$]/g, '')}\\b`,
      ).exec(text);
      if (!decl) {
        continue;
      }
      const from = decl.index;
      // To the end of the declaration: an interface ends at its closing brace,
      // a type alias at the semicolon that closes it.
      let depth = 0;
      let end = text.length;
      for (let i = from; i < text.length; i++) {
        const character = text.charAt(i);
        if ('{(['.includes(character)) {
          depth++;
        } else if ('})]'.includes(character)) {
          depth--;
          if (depth === 0 && /\{/.test(text.slice(from, i))) {
            end = i + 1;
            break;
          }
        } else if (character === ';' && depth === 0 && from !== i) {
          end = i + 1;
          break;
        }
      }
      out.push(text.slice(from, end));
    }
  }
  return out.join('\n');
}

function safeSchema(filePath: string, projectPath: string) {
  try {
    const source = readSource(filePath);
    const fields = parsePropSchema(source, importedTypes(source, filePath, projectPath));
    const schema = resolveIdentifierDefaults(fields, source, filePath, projectPath);
    return {
      schema,
      extendsTag: parseExtendsTag(source) ?? undefined,
      slots: parseSlots(source),
      // Where that default slot sits decides whether a fresh instance
      // arrives holding a word or empty — see defaultSlotInline.
      slotText: defaultSlotInline(source),
      // The HTML tag it renders as, so nesting rules apply through a
      // component the same way they do through a plain element.
      renderTag: rootTag(source) ?? undefined,
      // A `...rest` spread on Astro.props means the component forwards
      // arbitrary attributes — the UI offers a free-form Attributes section.
      // Anchored to the end of the destructure rather than scanning forward
      // from its `{`: a rest element is always last, and looking forward
      // tripped over any `}` in front of it (`containerAttrs = {}, ...rest`).
      // The optional `: Type` covers an annotated destructure.
      hasRest: /\.\.\.\s*\w+\s*\}\s*(?::[^=]+)?=\s*Astro\.props/.test(source),
    };
  } catch {
    return {
      schema: [],
      extendsTag: undefined,
      slots: [],
      slotText: false,
      renderTag: undefined,
      hasRest: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Prop-default resolution: a default like `SITE_TITLE` is often an identifier
// imported from another module (or a local const in the frontmatter). Follow
// it to its literal value so the UI shows the real default.
// ---------------------------------------------------------------------------

function literalValue(raw: string | undefined) {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^(true|false)$/.test(trimmed)) {
    return trimmed === 'true';
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  // Strings, including template literals without interpolation.
  if (/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)$/s.test(trimmed)) {
    return trimmed.slice(1, -1).replace(/\\(['"`\\])/g, '$1');
  }
  return undefined;
}

// Finds `export const NAME = <literal>` (or let/var, optional type note).
function constLiteralIn(code: string, name: string) {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]+)?=\\s*` +
      '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`[^`$]*`|-?\\d+(?:\\.\\d+)?|true|false)',
  );
  const match = code.match(re);
  return match ? literalValue(capture(match, 1)) : undefined;
}

// Finds which module a named import binds `name` from: {orig, spec}.
function findNamedImport(code: string, name: string) {
  const re = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    for (const part of capture(match, 1).split(',')) {
      const seg = part.trim().replace(/^type\s+/, '');
      if (!seg) {
        continue;
      }
      const asMatch = seg.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      const orig = asMatch ? capture(asMatch, 1) : seg;
      const local = asMatch ? capture(asMatch, 2) : seg;
      if (local === name) {
        return { orig, spec: capture(match, 2) };
      }
    }
  }
  return undefined;
}

function resolveModuleFile(spec: string, fromFile: string, projectPath: string) {
  let base;
  if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    base = path.join(projectPath, 'src', spec.slice(2));
  } else if (spec.startsWith('src/')) {
    base = path.join(projectPath, spec);
  } else {
    return undefined;
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.mts`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

function resolveIdentifierDefaults(
  schema: readonly SchemaField[],
  source: string,
  filePath: string,
  projectPath: string,
) {
  return schema.map((field): SchemaField => {
    if (!field.defaultExpr) {
      return field;
    }
    const ident = String(field.default).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
      return field;
    }
    // Local const in the component's own frontmatter first.
    let value = constLiteralIn(source, ident);
    if (value === undefined) {
      const imp = findNamedImport(source, ident);
      if (imp) {
        const file = resolveModuleFile(imp.spec, filePath, projectPath);
        if (file) {
          try {
            value = constLiteralIn(readSource(file), imp.orig);
          } catch {
            /* unreadable module — leave the identifier as-is */
          }
        }
      }
    }
    if (value === undefined) {
      return field;
    }
    // Build a resolved field without mutating the parser's original schema.
    const resolved = { ...field, default: value };
    delete resolved.defaultExpr;
    if (resolved.type === 'other') {
      resolved.type =
        typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    }
    return resolved;
  });
}

// ---------------------------------------------------------------------------
// File watching — reflect external edits back into the app
// ---------------------------------------------------------------------------

let watcher: ReturnType<typeof watchProject> | undefined;

// A compile error replaces the site with the dev server's own error screen, and
// that screen carries no HMR client — so when the mistake is fixed, nothing in
// the preview hears about it and it sits on the error until someone presses
// refresh. The app's own writes are deliberately invisible to the watcher
// below, so this is the one place that sees every one of them: say that the
// site may have changed, and let the renderer go and ask (see `dev:probe`).
// `external` — the change came from outside the app: an editor, a script, a
// git checkout. The canvas hears about the app's own writes through the dev
// server's HMR socket and patches itself; an outside change reaches it the
// same way, when that socket is still listening. This flag is what lets the
// app tell the canvas directly as well, so a socket that has gone quiet is no
// longer the difference between seeing your edit and pressing refresh.
let pageChangeTimer: ReturnType<typeof setTimeout> | undefined;
let pageChangeExternal = false;
function notePageMayHaveChanged(external = false) {
  pageChangeExternal = pageChangeExternal || external;
  clearTimeout(pageChangeTimer);
  pageChangeTimer = setTimeout(() => {
    const wasExternal = pageChangeExternal;
    pageChangeExternal = false;
    send('page:maybe-changed', { external: wasExternal });
  }, 200);
}

// The app changed a project file: its own text write (through the file's
// actor), or a move, rename or delete. The canvas may need to hear of it.
function noteAppWrite(): void {
  notePageMayHaveChanged();
}

// The main process's document actors (plan §2 layer 2): from step 5 every
// write of project text goes through them (documentWrites.ts). Telemetry (plan
// §9a) is one structured line per outcome on stdout, with hashed paths.
installDocumentHost({
  documents: createNodeDocumentActors({
    log: (line) => console.info(line),
    schedule: (task) => setImmediate(task),
  }),
  noteWrite: noteAppWrite,
});
const documents = documentHost().documents;

// Whether a watcher event is the app hearing its own write come back (plan
// §11.9): the file holds exactly the bytes its actor last wrote. That is a
// question about bytes, never about elapsed time — an editor's save a moment
// after the app's holds other bytes, and is heard. A save's temporary file and
// its lock file (atomicWrite.ts) are the app's own too: they exist only while
// the actor writes. A move, rename or delete is heard like an outside change;
// the one read each listener then makes finds what the app already has.
const isSelfWrite = (full: string): boolean => {
  if (isAtomicTemporary(full)) {
    return true;
  }
  return documents.echoes(path.resolve(full));
};

ipcMain.handle('watch:start', async (_event, projectPath) => {
  stopWatchingProject();
  openProjectRoot = path.resolve(projectPath);
  if (!fs.existsSync(path.join(projectPath, 'src'))) {
    return { ok: false as const };
  }
  watcher = watchProject({
    projectPath,
    send,
    isSelfWrite,
    noteExternalChange: (changed) => documents.noteExternalChange(changed),
    notePageMayHaveChanged,
    scheduleThumb,
    mediaPattern: MEDIA_EXT,
  });
  return { ok: true as const };
});

function stopWatchingProject() {
  watcher?.close();
  watcher = undefined;
  clearTimeout(pageChangeTimer);
  pageChangeTimer = undefined;
  pageChangeExternal = false;
  clearTimeout(thumbTimer);
  thumbTimer = undefined;
  for (const timer of styleNudges.values()) {
    clearTimeout(timer);
  }
  styleNudges.clear();
  captureEra++;
  documents.clear();
}

// ---------------------------------------------------------------------------
// Assets (public/) — list, upload, move, rename, folders
// ---------------------------------------------------------------------------

const publicDirectoryOf = (projectPath: string) => path.join(projectPath, 'public');

// Assets live in two places and they mean different things:
//
//   public/  copied to the site as-is; referenced by URL ("/hero.png")
//   src/     imported by the build; referenced by ESM import, and optimised
//            (this is where <Image> wants its images)
//
// So an asset is addressed by a ROOTED rel — "public/img/hero.png" or
// "src/assets/hero.png" — and every handler below takes that. The root is the
// first segment, which keeps one string identifying a file across listing,
// moving, renaming and picking, and makes a cross-root move just a move.
const ASSET_ROOTS = ['public', 'src'];

// Media only under src/: everything else there is code. public/ lists whatever
// is in it — that folder exists to be served.
const MEDIA_EXT = new RegExp(
  '\\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|' +
    'mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|flac|aac|woff2?|ttf|otf|eot)$',
  'i',
);

const rootOfRel = (rel: string) => String(rel || '').split('/')[0] ?? '';

// Refuses anything that escapes the two roots.
function assetAbs(projectPath: string, rel: string) {
  const clean = String(rel || '').replace(/^\/+/, '');
  const root = rootOfRel(clean);
  if (!ASSET_ROOTS.includes(root)) {
    throw new Error('Invalid asset path');
  }
  const rootAbs = path.resolve(projectPath, root);
  const abs = path.resolve(projectPath, clean);
  if (!isPathWithin(rootAbs, abs)) {
    throw new Error('Invalid asset path');
  }
  return abs;
}

// A destination name that doesn't collide: name.ext, name-1.ext, name-2.ext and on.
function uniqueTarget(directory: string, name: string) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(directory, candidate))) {
    if (i > MAIN_LIMITS.fileNameAttemptsMax) {
      throw new Error('File name attempts exceed limit');
    }
    candidate = `${base}-${i++}${ext}`;
  }
  return path.join(directory, candidate);
}

ipcMain.handle('assets:list', async (_event, projectPath) => {
  const entries: AssetEntry[] = [];
  // The roots themselves are entries, so the panel navigates and drops into
  // them with the folder handling it already has.
  const publicDirectory = publicDirectoryOf(projectPath);
  const sourceDirectory = path.join(projectPath, 'src');
  const hasPublic = fs.existsSync(publicDirectory);
  if (hasPublic) {
    entries.push({
      rel: 'public',
      name: 'public',
      parent: '',
      isDir: true,
      root: 'public',
      isRoot: true,
    });
    entries.push(...listAssetTree(publicDirectory, 'public', { mediaOnly: false }));
  }
  if (fs.existsSync(sourceDirectory)) {
    entries.push({ rel: 'src', name: 'src', parent: '', isDir: true, root: 'src', isRoot: true });
    entries.push(...listAssetTree(sourceDirectory, 'src', { mediaOnly: true }));
  }
  return { entries, missing: !hasPublic };
});

// Opens a picker and copies the chosen files into public/<destRel>.
ipcMain.handle('assets:pickUpload', async (_event, { projectPath, destRel: targetRel }) => {
  const result = await showOpenDialog({
    title: 'Upload assets',
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) {
    return { added: 0 };
  }
  return copyAssetsIn(projectPath, targetRel, result.filePaths);
});

// Copies OS-dragged files into public/<destRel>.
ipcMain.handle('assets:upload', async (_event, { projectPath, destRel: targetRel, filePaths }) => {
  return copyAssetsIn(projectPath, targetRel, filePaths || []);
});

function copyAssetsIn(projectPath: string, targetRel: string, filePaths: readonly string[]) {
  const targetDirectory = assetAbs(projectPath, targetRel);
  fs.mkdirSync(targetDirectory, { recursive: true });
  let added = 0;
  for (const source of filePaths) {
    try {
      const target = uniqueTarget(targetDirectory, path.basename(source));
      noteAppWrite();
      fs.cpSync(source, target, { recursive: true });
      added++;
    } catch {
      /* skip unreadable file */
    }
  }
  send('assets:changed', {});
  return { added };
}

ipcMain.handle(
  'assets:move',
  async (_event, { projectPath, fromRel, toDirRel: toDirectoryRel }) => {
    const from = assetAbs(projectPath, fromRel);
    const toDirectory = assetAbs(projectPath, toDirectoryRel);
    // Between roots the file's IDENTITY changes, not just its path: a public/
    // asset is referenced by URL and a src/ one by import, so every reference to
    // it would have to be rewritten in place. Until that rewrite exists, refuse
    // — moving the file alone would leave the site pointing at nothing, quietly.
    if (rootOfRel(fromRel) !== rootOfRel(toDirectoryRel)) {
      throw new Error(
        'Moving between public/ and src/ changes how the file is referenced ' +
          '(URL vs import), so it needs the references updated too. Not supported yet — ' +
          'move it outside the app and fix the references by hand.',
      );
    }
    if (!fs.existsSync(from)) {
      return { ok: false as const };
    }
    // Refuse moving a folder into itself/its own subtree.
    if (fs.statSync(from).isDirectory() && isPathWithin(from, toDirectory)) {
      throw new Error('Cannot move a folder into itself.');
    }
    const target = uniqueTarget(toDirectory, path.basename(from));
    noteAppWrite();
    noteAppWrite();
    fs.mkdirSync(toDirectory, { recursive: true });
    fs.renameSync(from, target);
    send('assets:changed', {});
    return { ok: true as const };
  },
);

ipcMain.handle('assets:rename', async (_event, { projectPath, rel, newName }) => {
  const clean = String(newName).trim().replace(/[/\\]/g, '');
  if (!clean) {
    throw new Error('Invalid name');
  }
  const from = assetAbs(projectPath, rel);
  const target = path.join(path.dirname(from), clean);
  if (sameFilesystemPath(target, from)) {
    return { ok: true as const };
  }
  if (fs.existsSync(target)) {
    throw new Error('Something with that name already exists.');
  }
  noteAppWrite();
  noteAppWrite();
  fs.renameSync(from, target);
  send('assets:changed', {});
  return { ok: true as const };
});

// To the system's bin, not to nothing. An asset is somebody's photograph as
// often as it is a placeholder, references to it live in files this does not
// read, and the app has no copy of it — so "gone" has to mean somewhere they
// can get it back from without us.
ipcMain.handle('assets:delete', async (_event, { projectPath, rel }) => {
  const abs = assetAbs(projectPath, rel);
  if (!fs.existsSync(abs)) {
    return { ok: false as const };
  }
  noteAppWrite();
  await shell.trashItem(abs);
  send('assets:changed', {});
  return { ok: true as const };
});

// Text assets (css/js/json/svg/…) are editable in the floating code window.
ipcMain.handle('assets:readText', async (_event, { projectPath, rel }) => {
  const abs = assetAbs(projectPath, rel);
  const stat = fs.statSync(abs);
  if (stat.size > MAIN_LIMITS.editableFileBytesMax) {
    throw new Error('That file is too large to edit in the app (over 5 MB).');
  }
  return { text: readSource(abs) };
});

ipcMain.handle('assets:writeText', async (_event, { projectPath, rel, text }) => {
  const abs = assetAbs(projectPath, rel);
  writeProjectText(abs, text);
  return { ok: true as const };
});

ipcMain.handle('assets:mkdir', async (_event, { projectPath, parentRel, name }) => {
  const clean = String(name).trim().replace(/[/\\]/g, '');
  if (!clean) {
    throw new Error('Invalid folder name');
  }
  const directory = path.join(assetAbs(projectPath, parentRel), clean);
  noteAppWrite();
  fs.mkdirSync(directory, { recursive: true });
  send('assets:changed', {});
  return { ok: true as const };
});

// ---------------------------------------------------------------------------
// CMS — JSON data files under src/ edited as collections
// ---------------------------------------------------------------------------

// Config files that happen to live in src/ aren't content.
const CMS_SKIP = /^(tsconfig|jsconfig|package|package-lock|env\.d)\.json$/i;

// How a page's frontmatter is scanned: no exports there, and a list of plain
// strings is the content itself rather than a constant.
const PAGE_SCAN = { requireExport: false, allowPlainLists: true };

const isAstroRel = (rel: string) => /\.astro$/i.test(String(rel || ''));

// The frontmatter's own span, so a page's data can be read and written without
// the scanners ever seeing its markup.
function frontmatterSpan(source: string) {
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) {
    return undefined;
  }
  const start = open[0].length;
  const close = source.slice(start).search(/\r?\n---[ \t]*(\r?\n|$)/);
  if (close === -1) {
    return undefined;
  }
  return { start, end: start + close };
}

function frontmatterOf(source: string) {
  const span = frontmatterSpan(source);
  return span ? source.slice(span.start, span.end) : undefined;
}

// A JS/TS collection is addressed as `path/to/file.ts#EXPORT_NAME` — the file
// holds several, so the export name picks which one. A page's frontmatter uses
// the same form: `pages/index.astro#rotatingWords`.
function splitCmsRel(rel: string) {
  const at = String(rel || '').lastIndexOf('#');
  return at === -1
    ? { fileRel: String(rel || ''), exportName: undefined }
    : { fileRel: String(rel).slice(0, at), exportName: String(rel).slice(at + 1) };
}

// Refuses paths that escape src/.
function cmsAbs(projectPath: string, rel: string) {
  const root = path.resolve(projectPath, 'src');
  const abs = path.resolve(root, rel || '');
  if (!isPathWithin(root, abs)) {
    throw new Error('Invalid data path');
  }
  return abs;
}

// Every .json under src/, with its parsed contents. Files are small enough
// that parsing them all up front is cheaper than a round trip per collection,
// and it lets the panel show item counts without opening anything.
ipcMain.handle('cms:list', async (_event, projectPath) => {
  const root = path.join(projectPath, 'src');
  const files: CmsFile[] = [];
  if (!fs.existsSync(root)) {
    return { files };
  }
  const checkDirectory = directoryBudget(root);
  const walk = (directory: string, rel: string, depth: number): void => {
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    checkDirectory(directory, entries.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'cms:list: the budget bounds depth');
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const full = path.join(directory, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, entryRel, depth + 1);
      } else if (/\.(ts|js|mjs|mts)$/i.test(entry.name) && !/\.d\.ts$/i.test(entry.name)) {
        files.push(...readCmsSource(full, entryRel, { page: false }));
      } else if (/\.astro$/i.test(entry.name)) {
        files.push(...readCmsSource(full, entryRel, { page: true }));
      } else if (/\.json$/i.test(entry.name) && !CMS_SKIP.test(entry.name)) {
        files.push(readCmsJson(full, entryRel, rel, entry.name));
      }
    }
  };
  walk(root, '', 0);
  files.sort((left, right) => left.rel.localeCompare(right.rel));
  return { files };
});

ipcMain.handle('cms:read', async (_event, { projectPath, rel }) => {
  const { fileRel, exportName } = splitCmsRel(rel);
  const abs = cmsAbs(projectPath, fileRel);
  if (!exportName) {
    return { data: parseData(readJson(abs)) };
  }
  const file = readSource(abs);
  // A page's data lives in its frontmatter; everything below it is markup the
  // scanners must never see.
  const page = isAstroRel(fileRel);
  const source = page ? frontmatterOf(file) : file;
  if (source === undefined) {
    throw new Error(`src/${fileRel} has no frontmatter.`);
  }
  const scan = page ? PAGE_SCAN : undefined;
  if (exportName === GENERAL) {
    const general = readGeneral(source, scan);
    if (!general) {
      throw new Error(`src/${fileRel} has no single values left to edit.`);
    }
    return { data: general };
  }
  const col = findCollections(source, scan).find((candidate) => candidate.name === exportName);
  if (!col) {
    throw new Error(
      page
        ? `${exportName} is no longer declared in src/${fileRel}.`
        : `${exportName} is no longer exported from src/${fileRel}.`,
    );
  }
  if (!col.data) {
    throw new Error(`${exportName} isn't plain data — ${col.reason}.`);
  }
  return { data: withAssets(col.data, assetOfImport(projectPath, abs, source)) };
});

// What a name in a data file is bound to, when it is bound to a picture: the
// project-relative file, or undefined for anything else. Only imports are read —
// `image: dailyDevotionals` says nothing on its own, and the import above it
// says everything.
function assetOfImport(projectPath: string, abs: string, source: string) {
  const imports = defaultImports(source);
  return (name: string) => {
    const imp = imports.find((i) => i.name === name);
    if (!imp) {
      return undefined;
    }
    const target = resolveImportPath(projectPath, abs, imp.spec);
    if (!target || !MEDIA_EXT.test(target)) {
      return undefined;
    }
    const rel = toPosix(path.relative(projectPath, target));
    return rel && !rel.startsWith('..') ? rel : undefined;
  };
}

// Points a data file's field at a picture. A file under public/ is served as it
// is and needs nothing written; one under src/ is imported, so the import is
// made — or the file's existing one for that image reused, since importing the
// same picture twice under two names is noise — and the name handed back for
// the value.
ipcMain.handle('cms:assetRef', async (_event, { projectPath, rel, assetRel }) => {
  const { fileRel } = splitCmsRel(rel);
  const abs = cmsAbs(projectPath, fileRel);
  const clean = String(assetRel || '').replace(/^\/+/, '');
  const root = clean.split('/')[0];
  if (root === 'public') {
    return { value: '/' + clean.split('/').slice(1).join('/') };
  }
  if (root !== 'src') {
    throw new Error('Invalid asset path');
  }
  const target = path.resolve(projectPath, clean);
  if (!fs.existsSync(target)) {
    throw new Error(`${clean} no longer exists.`);
  }
  const file = readSource(abs);
  const page = isAstroRel(fileRel);
  const span = page ? frontmatterSpan(file) : undefined;
  if (page && !span) {
    throw new Error(`src/${fileRel} has no frontmatter.`);
  }
  const source = span ? file.slice(span.start, span.end) : file;
  const imports = defaultImports(source);
  const already = imports.find((i) => resolveImportPath(projectPath, abs, i.spec) === target);
  if (already) {
    return { name: already.name, asset: clean };
  }
  const fromHere = toPosix(path.relative(path.dirname(abs), target));
  const spec = importSpecFor({
    imports,
    srcRelative: toPosix(path.relative(path.join(projectPath, 'src'), target)),
    relative: fromHere.startsWith('.') ? fromHere : './' + fromHere,
  });
  const name = importName(
    clean,
    imports.map((i) => i.name),
  );
  const next = addImport(source, name, spec);
  const written = span ? file.slice(0, span.start) + next + file.slice(span.end) : next;
  writeProjectText(abs, written);
  return { name, asset: clean };
});

// Writes the collection back, matching the file's existing indentation so
// the diff stays limited to what the user actually changed.
ipcMain.handle('cms:write', async (_event, { projectPath, rel, data }) => {
  const { fileRel, exportName } = splitCmsRel(rel);
  if (exportName) {
    const abs = cmsAbs(projectPath, fileRel);
    if (!fs.existsSync(abs)) {
      throw new Error(`src/${fileRel} no longer exists.`);
    }
    // Only the edited span is rewritten — imports, comments and the file's
    // other exports are left exactly as they were.
    const file = readSource(abs);
    // Only the frontmatter is handed to the writer for a page, and only its
    // span is spliced back — the markup below is never re-serialized.
    const page = isAstroRel(fileRel);
    const span = page ? frontmatterSpan(file) : undefined;
    if (page && !span) {
      throw new Error(`src/${fileRel} has no frontmatter.`);
    }
    const source = span ? file.slice(span.start, span.end) : file;
    const scan = page ? PAGE_SCAN : undefined;
    const written =
      exportName === GENERAL
        ? writeGeneral(
            source,
            data && typeof data === 'object' && !Array.isArray(data) ? data : {},
            scan,
          )
        : replaceCollection(source, exportName, parseDataList(data), scan);
    if (written === undefined) {
      throw new Error(`Couldn't write ${exportName} back into src/${fileRel}.`);
    }
    const next = span ? file.slice(0, span.start) + written + file.slice(span.end) : written;
    writeProjectText(abs, next);
    // Editing a page's own frontmatter changes a file the editor may have
    // open. Our writes are invisible to the watcher, so say so directly —
    // otherwise the model would keep the old data and write it back over this.
    if (page) {
      send('fs:changed', { files: [abs] });
    }
    return { ok: true as const };
  }
  const abs = cmsAbs(projectPath, rel);
  // A save still in flight when the collection is deleted must not recreate
  // the file — the editor closes a moment after the delete lands.
  if (!fs.existsSync(abs)) {
    throw new Error(`src/${rel} no longer exists.`);
  }
  let indent: string | number = 2;
  let trailingNewline = true;
  const before = readSource(abs);
  const match = before.match(/\n([ \t]+)\S/);
  if (match) {
    indent = capture(match, 1) === '\t' ? '\t' : capture(match, 1).length;
  }
  trailingNewline = /\n$/.test(before);
  const json = JSON.stringify(data, null, indent) + (trailingNewline ? '\n' : '');
  writeProjectText(abs, json);
  return { ok: true as const };
});

// New collections land in src/data/, the conventional home for Astro content
// that isn't a content collection.
ipcMain.handle('cms:create', async (_event, { projectPath, name }) => {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/\.json$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) {
    throw new Error('Give the collection a name.');
  }
  const rel = `data/${slug}.json`;
  const abs = cmsAbs(projectPath, rel);
  if (fs.existsSync(abs)) {
    throw new Error(`src/${rel} already exists.`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  createProjectText(abs, '[]\n');
  send('cms:changed', {});
  return { rel };
});

// A field's type is inferred from its values, which can't tell a phone number
// from a line of text — or anything at all from an empty field. Types the user
// picked explicitly are remembered here, keyed by collection and field path.
const cmsMetaPath = (projectPath: string) => path.join(projectPath, '.stacki', 'cms.json');

function readCmsMeta(projectPath: string) {
  try {
    return parseRecord(parseData(readJson(cmsMetaPath(projectPath))));
  } catch {
    return {};
  }
}

ipcMain.handle('cms:meta', async (_event, projectPath) => ({ meta: readCmsMeta(projectPath) }));

// What the project's content config declares: every collection, where its
// entries live, whether they can be written at all, and the JSON Schema its
// zod schema amounts to. Read from the config itself rather than inferred from
// the data, so the editor enforces the same rules the build does — see
// contentConfig.js for how, and why it happens in a child process.
ipcMain.handle('content:config', async (_event, { projectPath, force }) =>
  parseContentConfig(await readContentConfig(projectPath, { force: !!force })),
);

// One collection's entries: where each one lives, what it holds, and what
// identifies it. A collection whose loader builds its entries has none to give.
const collectionOf = async (projectPath: string, name: string) => {
  const config = parseContentConfig(await readContentConfig(projectPath));
  const collection = (config.collections || []).find((candidate) => candidate.name === name);
  if (!collection) {
    throw new Error(`${name} is not a collection in this project.`);
  }
  return { config, collection };
};

// The collections themselves, with counts, for the panel that lists them.
// Every CSS custom property in the project, grouped the way the stylesheets
// themselves group them — see cssVars.js for what "the way" means.
ipcMain.handle('css:variables', async (_event, projectPath) => {
  try {
    return cssVars.readVariables(projectPath);
  } catch (error: unknown) {
    return { files: [], error: errorMessage(error) };
  }
});

// A variable added at the bottom of a group. One call carries several: a row in
// a table of modes is one name in every mode, and a row in a family is one
// property of every member.
ipcMain.handle('css:addVariables', async (_event, { projectPath, adds }) => {
  let last: { ok: boolean; error?: string; name?: string; changed?: boolean } = { ok: true };
  for (const add of adds || []) {
    last = cssVars.addVariable(projectPath, add);
    if (!last.ok) {
      break;
    }
  }
  if (last.ok) {
    send('css:changed', {});
  }
  return last;
});

// A row dragged to a new place: the declaration moves inside its rule, which is
// where the order actually lives.
ipcMain.handle('css:moveVariables', async (_event, { projectPath, moves }) => {
  let last: { ok: boolean; error?: string; name?: string; changed?: boolean } = { ok: true };
  for (const move of moves || []) {
    // A group carries its heading and every line under it; a row is one line.
    last =
      'names' in move
        ? cssVars.moveSection(projectPath, move)
        : cssVars.moveVariable(projectPath, move);
    if (!last.ok) {
      break;
    }
  }
  if (last.ok) {
    send('css:changed', {});
  }
  return last;
});

// A heading that is a comment rather than a shared name: renaming it rewrites
// the comment, in place, the same way a value is written.
ipcMain.handle('css:setSectionTitle', async (_event, { projectPath, ...edit }) => {
  const result = cssVars.setSectionTitle(projectPath, edit);
  if (result.ok) {
    send('css:changed', {});
  }
  return result;
});

// A heading is a line between declarations: removing it joins the runs either
// side, and adding one splits them.
ipcMain.handle('css:removeSection', async (_event, { projectPath, ...edit }) => {
  const result = cssVars.removeSection(projectPath, edit);
  if (result.ok) {
    send('css:changed', {});
  }
  return result;
});

ipcMain.handle('css:moveHeading', async (_event, { projectPath, ...edit }) => {
  const result = cssVars.moveHeading(projectPath, edit);
  if (result.ok) {
    send('css:changed', {});
  }
  return result;
});

ipcMain.handle('css:addSection', async (_event, { projectPath, ...edit }) => {
  const result = cssVars.addSection(projectPath, edit);
  if (result.ok) {
    send('css:changed', {});
  }
  return result;
});

// Renaming reaches every file that mentions the name, so it is one call rather
// than one per file: the panel says which names become which, and either all of
// them move or none does.
ipcMain.handle('css:renameVariables', async (_event, { projectPath, renames }) => {
  const result = cssVars.renameVariables(projectPath, { renames });
  if (result.ok) {
    send('css:changed', {});
  }
  return result;
});

// One value, replaced where it sits. The old value is sent back with the new
// one: if the file no longer says what the panel was showing, somebody else has
// edited it and the offsets are meaningless.
ipcMain.handle('css:setVariable', async (_event, { projectPath, ...edit }) => {
  const result = cssVars.setVariable(projectPath, edit);
  if (result.ok) {
    send('css:changed', {});
  }
  return result;
});

ipcMain.handle('content:collections', async (_event, projectPath) => {
  const config = parseContentConfig(await readContentConfig(projectPath));
  if (config.missing || config.error) {
    return { ...config, collections: [] };
  }
  const collections = (config.collections || []).map((collection) => ({
    name: collection.name,
    editable: collection.editable,
    loader: collection.loader,
    hasSchema: !!collection.schema,
    freeform: !!collection.freeform,
    error: collection.error || undefined,
    count: countEntries(projectPath, collection),
  }));
  return {
    collections,
    covered: coveredPaths(config.collections || []),
    configPath: config.configPath,
  };
});

ipcMain.handle('content:entries', async (_event, { projectPath, name }) => {
  const { collection } = await collectionOf(projectPath, name);
  return { collection, ...listEntries(projectPath, collection) };
});

// A save is a list of edits against one entry, not a new copy of the file: see
// contentEntries.js and ./formats for what that protects.
ipcMain.handle('content:writeEntry', async (_event, { projectPath, entry, edits, body }) => {
  const result = writeEntry(projectPath, entry, edits || [], definedFields({ body }));
  noteAppWrite();
  send('cms:changed', {});
  return result;
});

ipcMain.handle('content:validate', async (_event, { projectPath, collection, data }) =>
  parseValidationResult(await validateEntry(projectPath, { collection, data })),
);

// What renaming an entry's id would change, and then changing it. Two calls,
// because an id is what every reference to the entry holds: the plan is shown
// before anything is written, so a rename that would touch six other entries
// says so first.
ipcMain.handle('content:renamePlan', async (_event, { projectPath, name, from, to }) => {
  const config = parseContentConfig(await readContentConfig(projectPath));
  const plan = planRename(
    projectPath,
    config.collections.map((collection) => ({
      ...collection,
      loader: collection.loader ?? { kind: 'none' },
    })),
    { collection: name, from, to },
  );
  // The entry data itself is big and the renderer only needs the shape of the
  // change.
  return { ...plan, entry: { id: plan.entry.id, file: plan.entry.file } };
});

ipcMain.handle('content:rename', async (_event, { projectPath, name, from, to }) => {
  const config = parseContentConfig(await readContentConfig(projectPath));
  const plan = planRename(
    projectPath,
    config.collections.map((collection) => ({
      ...collection,
      loader: collection.loader ?? { kind: 'none' },
    })),
    { collection: name, from, to },
  );
  const result = applyRename(projectPath, plan);
  if (result.files.length > 0) {
    noteAppWrite();
  }
  send('cms:changed', {});
  return result;
});

// Every entry of a collection something can point at, as id and label — what a
// reference field offers instead of asking the user to remember ids.
ipcMain.handle('content:targets', async (_event, { projectPath, name }) => {
  const { collection } = await collectionOf(projectPath, name);
  const { entries } = listEntries(projectPath, collection);
  return { targets: entries.map((entry) => ({ id: entry.id, title: entry.title })) };
});

// Where an import in a page actually points. The tag name is only a local
// binding — `import Layout from '@/layouts/BaseLayout.astro'` renders as
// <Layout> — so drilling into a component has to follow the import, not the
// name.
ipcMain.handle('project:resolveImport', async (_event, { projectPath, fromFile, spec }) => ({
  path: resolveImport(projectPath, fromFile, spec) ?? undefined,
}));

ipcMain.handle('cms:setMeta', async (_event, { projectPath, rel, fields }) => {
  const meta = readCmsMeta(projectPath);
  if (fields && Object.keys(fields).length) {
    meta[rel] = fields;
  } else {
    delete meta[rel];
  }
  const file = cmsMetaPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { ok: true as const };
});

// Deleting a collection rewrites the pages that imported it (see cmsRefs.js):
// the import becomes `const clients = []`, which leaves every
// `clients.map(...)` on the page working and rendering nothing.

ipcMain.handle('cms:usage', async (_event, { projectPath, rel }) => {
  const abs = cmsAbs(projectPath, splitCmsRel(rel).fileRel);
  return { files: importersOf(projectPath, abs).map((hit) => hit.rel) };
});

ipcMain.handle('cms:delete', async (_event, { projectPath, rel }) => {
  // An export shares its file with other code, so there's no file to trash and
  // removing the statement is a code edit, not a content one.
  if (splitCmsRel(rel).exportName) {
    throw new Error('This collection is an export inside a source file — remove it in code.');
  }
  const abs = cmsAbs(projectPath, rel);
  const hits = importersOf(projectPath, abs);
  for (const hit of hits) {
    writeProjectText(hit.file, hit.next);
  }
  await shell.trashItem(abs);
  const meta = readCmsMeta(projectPath);
  if (meta[rel]) {
    delete meta[rel];
    fs.writeFileSync(cmsMetaPath(projectPath), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }
  send('cms:changed', {});
  // Our own writes are invisible to the watcher, so tell the app directly —
  // an open page holding the old import needs to reload.
  if (hits.length) {
    send('fs:changed', { files: hits.map((hit) => hit.file) });
  }
  return { ok: true as const, rewritten: hits.map((hit) => hit.rel) };
});

// ---------------------------------------------------------------------------
// HTML chunks — resolution lives in astroParser so the dev server's marker
// config can reuse it (see writeMarkerConfig). The page editor shows a
// chunk's markup in the navigator and never writes it: no page save is a whole
// model any more (step 9), and a chunk file has no node intents of its own
// yet — its content is edited in code (src/nodeCapability.ts).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page IPC
// ---------------------------------------------------------------------------

function parsePageSource(pagePath: string, source: string): IpcResults['page:parse'] {
  if (isMarkdownPage(pagePath)) {
    return { ...parseMarkdownPage(source, { mdx: isMdx(pagePath) }), source };
  }
  const parsed = parsePage(source, { locs: true });
  if (parsed.editable) {
    resolveChunks(parsed.model, pagePath, { locs: true });
  }
  return { ...parsed, source };
}

// Read through the page's actor (step 6): the bytes the renderer is shown are
// the bytes its edits will name, so the host must hold them — as its current
// snapshot, and retained once an outside write replaces them — or an edit
// authored against them could only be refused.
ipcMain.handle('page:read', async (_event, pagePath) => {
  const snapshot = readThroughActor(pagePath);
  // Markdown builds the same tree from a different syntax, so everything
  // downstream — navigator, props, text editing, undo — is unchanged. Only
  // the writer has to know which one it is; model.format carries that.
  return { ...parsePageSource(pagePath, snapshot.text), checksum: snapshot.checksum };
});

function readThroughActor(pagePath: string): { readonly text: string; readonly checksum: Digest } {
  const current = documents.current(pagePath);
  if (!current.ok) {
    throw new Error(current.error.message);
  }
  const decoded = decodeUtf8(current.value.bytes);
  if (!decoded.ok) {
    throw new Error(`${path.basename(pagePath)} is not valid UTF-8`);
  }
  return { text: decoded.value, checksum: current.value.checksum };
}

ipcMain.handle('page:parse', async (_event, { pagePath, source }) => {
  return parsePageSource(pagePath, source);
});

// What a write that did not happen, or may have, means to the renderer's save
// state (plan §7). A refusal is the edit's own (`rejected`, pageEditError).
function pageWriteFailure(
  file: string,
  report: Extract<WriteReport, { readonly tag: 'uncertain' | 'backpressured' }>,
): WirePageWriteFailure {
  const name = path.basename(file);
  switch (report.tag) {
    case 'uncertain':
      return {
        code: 'uncertain',
        message: `${name} may not have been saved (${report.reconciliation ?? 'unreadable'}).`,
      };
    case 'backpressured':
      return { code: 'backpressured', message: describeWriteReport(name, report) };
    default: {
      const exhaustive: never = report;
      return exhaustive;
    }
  }
}

// Astro's dev server serves a page's <style> block ONE EDIT BEHIND: after the file
// changes it re-renders the HTML correctly, but hands the browser the *previous*
// transform of `…?astro&type=style&…`, and that module overwrites the (correct) CSS
// inlined in the SSR'd HTML. So a style edit only appeared on the canvas once the NEXT
// edit pushed the stale transform along — which read as "the panel writes the wrong
// value". Writing the same bytes a second time flushes it. Plain .css files transform
// correctly, so this is only for .astro files that carry a <style> block.
const STYLE_NUDGE_MS = 150;
const styleNudges = new Map<string, ReturnType<typeof setTimeout>>(); // path -> pending timer

function nudgeStyle(pagePath: string, checksum: Digest): void {
  if (!styleNudges.has(pagePath)) {
    if (styleNudges.size >= MAIN_LIMITS.styleNudgesMax) {
      return; // Past the bound only the dev server's style cache stays one edit behind.
    }
  }
  clearTimeout(styleNudges.get(pagePath)); // a newer edit supersedes this one's nudge
  styleNudges.set(
    pagePath,
    setTimeout(() => {
      styleNudges.delete(pagePath);
      // The same bytes again, witnessed by their own checksum: the actor
      // refuses if anything changed the file since, so the nudge never
      // resurrects superseded text. A refused or failed nudge leaves the
      // correct bytes on disk; only the dev server's style cache stays one
      // edit behind, so there is nothing to report beyond telemetry.
      noteAppWrite();
      documents.rewriteUnchanged(pagePath, checksum);
    }, STYLE_NUDGE_MS),
  );
}

// A visual edit (plan §11 step 6): the renderer states it against the page it
// shows; editRequests.ts makes it an intent against that snapshot, and the
// page's actor plans and writes it — splices, never a reprint of the file.
// The reply is the page as written plus the inverse Undo will submit.
//
// The code editor's saves arrive here too (step 8): a code patch is bytes, not
// nodes, so it applies to a page that does not parse — before or after.
// Markdown and MDX pages take every edit since step 10 (markdownEdits.ts).
ipcMain.handle('page:edit', async (_event, { pagePath, authoredChecksum, edit }) => {
  const code = edit.tag === 'code-patch';
  const gone = code ? ('merge-conflict' as const) : ('anchor-moved' as const);
  const stated = { authoredChecksum, gone };
  const report = documents.submitEdit(pagePath, stated, (base) => buildEdit(edit, base));
  if (report.tag !== 'applied') {
    return { ok: false as const, error: pageEditError(pagePath, report) };
  }
  const decoded = decodeUtf8(report.bytes);
  assert(decoded.ok, 'The actor wrote UTF-8');
  const text = decoded.value;
  noteAppWrite();
  if (/<style[\s>]/i.test(text)) {
    nudgeStyle(pagePath, report.checksum);
  }
  const reply = { ...parsePageSource(pagePath, text), checksum: report.checksum };
  return { ok: true as const, ...reply, inverse: report.inverse };
});

function pageEditError(
  file: string,
  report: Exclude<EditReport, { readonly tag: 'applied' }>,
): WirePageEditError {
  if (report.tag === 'rejected') {
    const { reason, diskChecksum } = report;
    const message = report.message === '' ? describeRejection(reason) : report.message;
    return { code: 'rejected', reason, message, diskChecksum };
  }
  return pageWriteFailure(file, report);
}

// A visual edit planned against the bytes the renderer sends and never
// written (electron/editPreview.ts): reviewing a conflicted page in code
// shows its unsaved gestures as the splices they are. The reply has page:edit's
// shape, so the renderer states the next request against it as it would
// against a write.
ipcMain.handle('page:previewEdit', async (_event, { pagePath, authoredChecksum, edit, source }) => {
  const refused = (reason: RejectionReason) => {
    const error = { code: 'rejected' as const, reason, message: describeRejection(reason) };
    return { ok: false as const, error: { ...error, diskChecksum: undefined } };
  };
  const planned = previewEdit(pagePath, encodeUtf8(source), authoredChecksum, edit);
  if (!planned.ok) {
    return refused(planned.error);
  }
  const decoded = decodeUtf8(planned.value.bytes);
  assert(decoded.ok, 'A plan of UTF-8 text is UTF-8');
  const reply = { ...parsePageSource(pagePath, decoded.value), checksum: planned.value.checksum };
  return { ok: true as const, ...reply, inverse: planned.value.inverse };
});

ipcMain.handle('page:create', async (_event, { projectPath, name, layout }) => {
  const pagesDirectory = path.join(projectPath, 'src', 'pages');
  let fileName = name.trim().replace(/\.astro$/i, '');
  fileName = fileName.replace(/[^a-zA-Z0-9/_-]+/g, '-');
  if (!fileName) {
    throw new Error('Invalid page name');
  }
  const pagePath = path.join(pagesDirectory, fileName + '.astro');
  if (fs.existsSync(pagePath)) {
    throw new Error('A page with that name already exists.');
  }
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });

  const eol = process.platform === 'win32' ? ('\r\n' as const) : ('\n' as const);
  const created = newPageText({ pagePath, layout: layout ?? undefined, eol });
  createProjectText(pagePath, created);
  return { pagePath };
});

ipcMain.handle('page:delete', async (_event, pagePath) => {
  noteAppWrite();
  fs.rmSync(pagePath);
  return { ok: true as const };
});

// Moves/renames a page within src/pages. `to` is the new path relative to
// the pages dir (with extension). When the folder changes, relative imports
// in the file's frontmatter are rewritten so they keep resolving.
ipcMain.handle('page:move', async (_event, { projectPath, from, to }) => {
  const pagesDirectory = path.join(projectPath, 'src', 'pages');
  const target = path.resolve(pagesDirectory, to);
  if (!isPathDescendant(pagesDirectory, target)) {
    throw new Error('Invalid destination.');
  }
  if (sameFilesystemPath(from, target)) {
    return { newPath: target };
  }
  if (fs.existsSync(target)) {
    throw new Error('A page with that name already exists there.');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let source = readSource(from);
  const fromDirectory = path.dirname(from);
  const toDirectory = path.dirname(target);
  if (!sameFilesystemPath(fromDirectory, toDirectory)) {
    source = source.replace(
      /(import\s[^'"]*?from\s*['"])(\.\.?\/[^'"]+)(['"])/g,
      (_match: string, pre: string, spec: string, post: string) => {
        const abs = path.resolve(fromDirectory, spec);
        let rel = toPosix(path.relative(toDirectory, abs));
        if (!rel.startsWith('.')) {
          rel = './' + rel;
        }
        return pre + rel + post;
      },
    );
  }
  noteAppWrite();
  createProjectText(target, source);
  fs.rmSync(from);
  return { newPath: target };
});

// Folder management under src/pages. Renames are same-parent only (from the
// UI), so contained files keep their relative-import depth.
const resolvePagesDirectory = (projectPath: string, rel: string) => {
  const pagesDirectory = path.join(projectPath, 'src', 'pages');
  const full = path.resolve(pagesDirectory, rel);
  if (!isPathWithin(pagesDirectory, full)) {
    throw new Error('Invalid folder.');
  }
  return full;
};

ipcMain.handle('pagefolder:create', async (_event, { projectPath, dir: directory }) => {
  fs.mkdirSync(resolvePagesDirectory(projectPath, directory), { recursive: true });
  return { ok: true as const };
});

ipcMain.handle('pagefolder:rename', async (_event, { projectPath, from, to }) => {
  const fromPath = resolvePagesDirectory(projectPath, from);
  const toPath = resolvePagesDirectory(projectPath, to);
  if (fs.existsSync(toPath)) {
    throw new Error('A folder with that name already exists.');
  }
  fs.renameSync(fromPath, toPath);
  return { ok: true as const };
});

ipcMain.handle('pagefolder:delete', async (_event, { projectPath, dir: directory }) => {
  const full = resolvePagesDirectory(projectPath, directory);
  const pagesDirectory = path.join(projectPath, 'src', 'pages');
  if (sameFilesystemPath(full, pagesDirectory)) {
    throw new Error('Invalid folder.');
  }
  fs.rmSync(full, { recursive: true, force: true });
  return { ok: true as const };
});

// Fill a route pattern in with one entry's params: /posts/[slug] + {slug:'a'}
// → /posts/a. A rest param ([...path]) holds a whole segment run, and an
// undefined one collapses rather than writing "undefined" into the URL.
function fillRoute(pattern: string, params: Readonly<Record<string, unknown>>) {
  const filled = pattern.replace(
    /\[(\.\.\.)?([^\]]+)\]/g,
    (_match: string, _rest: string | undefined, name: string) => {
      // Dev-server JSON writes null for a missing param, as absent as undefined.
      const value = params?.[name];
      if (value === undefined) {
        return '';
      }
      if (value === null) {
        return '';
      }
      return String(value)
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    },
  );
  // A dropped rest param leaves a double slash or a trailing one behind.
  return filled.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

// Routes the project serves that are NOT files under src/pages — pages an
// integration injected (issue #7). The site's own repo may have none of its
// own at all, in which case these are the only pages there are. Preview only:
// their source lives inside a dependency, so nothing here is editable, and
// they are deliberately kept out of the page list the editor writes through.
ipcMain.handle('project:injectedRoutes', async (_event, { projectPath }) => ({
  routes: readInjectedRoutes(projectPath),
}));

// The concrete URLs a dynamic page stands for, by asking the dev server to run
// its getStaticPaths. Returns [] for a static page, and for any failure — a
// page that can't answer is previewed at its own pattern, exactly as before.
ipcMain.handle('page:dynamicPaths', async (_event, { projectPath, pagePath, devUrl }) => {
  const pattern = routeForPage(projectPath, pagePath);
  if (!pattern.includes('[') || !devUrl) {
    return { entries: [] };
  }
  const rel = toPosix(path.relative(projectPath, pagePath));
  try {
    const response = await fetch(`${devUrl}/__avb/paths?p=${encodeURIComponent(rel)}`);
    if (!response.ok) {
      return { entries: [], error: `Dev server returned ${response.status}` };
    }
    const input: unknown = await response.json();
    const data = parseDynamicPaths(input);
    const entries = (data.entries || []).map((entry) => {
      // A dev server started before this app was updated still answers with
      // bare params objects — read both shapes rather than break its preview.
      const params = entry.params;
      return {
        params,
        props: (entry && entry.props) || undefined,
        route: fillRoute(pattern, params),
        // The values themselves read better in a picker than "slug=hello-world".
        label: Object.values(params).map(String).join(' / ') || pattern,
      };
    });
    return { entries, error: data.error || undefined };
  } catch (error: unknown) {
    return { entries: [], error: errorMessage(error) };
  }
});

// One entry of a collection, sampled — what a picker shows beside the fields
// of a page that lists them. Answered by the dev server because only it can
// run the project's loaders; without one there is simply no sample.
ipcMain.handle('content:sampleEntry', async (_event, { devUrl, name, id }) => {
  if (!devUrl || !name) {
    return { entry: undefined };
  }
  try {
    const query = `c=${encodeURIComponent(name)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
    const response = await fetch(`${devUrl}/__avb/data?${query}`);
    if (!response.ok) {
      return { entry: undefined, error: `Dev server returned ${response.status}` };
    }
    const input: unknown = await response.json();
    return parseSampleEntry(input);
  } catch (error: unknown) {
    return { entry: undefined, error: errorMessage(error) };
  }
});

// Turn a piece of a page into a component of its own. The file is worked out
// in componentFile.js; writing it belongs here, with every other write.
ipcMain.handle('component:create', async (_event, options) => {
  const { path: target, rel, text } = componentFile(options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  createProjectText(target, text);
  return { path: target, rel, name: options.name };
});

// Component property edits validate their revision before updating project sources.
ipcMain.handle('component:properties', (_event, location) => loadComponentProperties(location));
// Step 6: every applied property batch leaves its inverse here, and the reply
// carries the token Undo sends back (componentProperties.ts).
const propertyUndo = new PropertyUndoStore();
ipcMain.handle('component:editProperties', (_event, request) => {
  let undo: string | undefined;
  const onCommitted = (changes: readonly FileChange[]) => {
    undo = propertyUndo.record(inverseBatch(changes));
  };
  const result = updateComponentProperties(request, {
    documents,
    noteWrite: noteAppWrite,
    onCommitted,
  });
  if (!result.ok) {
    return result;
  }
  assert(undo !== undefined, 'An applied batch recorded its inverse');
  return ok({ ...result.value, undo });
});
ipcMain.handle('component:revertProperties', (_event, { token }) =>
  revertComponentProperties(token, propertyUndo, { documents, noteWrite: noteAppWrite }),
);

// Which files hold instances of a component — the palette’s instance count.
ipcMain.handle('component:usage', async (_event, { projectPath, name, exclude }) =>
  componentUsage(definedFields({ projectPath, name, exclude })),
);

ipcMain.handle('page:importPathFor', async (_event, { pagePath, targetPath, projectPath }) => {
  const rel = toPosix(path.relative(path.dirname(pagePath), targetPath));
  const relative = rel.startsWith('.') ? rel : './' + rel;
  let sourceRelative: string | undefined = undefined;
  if (projectPath) {
    const sourceDirectory = path.join(projectPath, 'src');
    if (isPathDescendant(sourceDirectory, targetPath)) {
      sourceRelative = toPosix(path.relative(sourceDirectory, targetPath));
    }
  }
  return { relative, srcRelative: sourceRelative };
});

// The same import, written for another page.
//
// A relative specifier says where a file is FROM WHERE IT IS WRITTEN, so
// `../assets/hero.png` copied from src/pages/index.astro into
// src/pages/blog/post.astro points at nothing. Anything else — an alias, a bare
// package, `astro:content` — means the same thing wherever it is written, and
// is handed back untouched.
ipcMain.handle('page:rebaseImport', async (_event, { fromPagePath, toPagePath, spec }) => {
  const text = String(spec || '');
  if (!text.startsWith('.')) {
    return { path: text };
  }
  if (!fromPagePath || !toPagePath) {
    return { path: text };
  }
  const abs = path.resolve(path.dirname(fromPagePath), text);
  const rel = toPosix(path.relative(path.dirname(toPagePath), abs));
  return { path: rel.startsWith('.') ? rel : './' + rel };
});

// ---------------------------------------------------------------------------
// Copy Selection (⇧⌘C)
//
// What the canvas has selected, as the editing-hierarchy trail that leads to
// it: the page, then the instance of each component drilled into, then the
// node itself — each entry a `<file>:<lines>` pointer. Pasted into an AI chat
// that can read the project, that trail is the one thing it can't work out for
// itself.
//
// Resolved on demand from the keys the renderer hands over, so nothing is
// stored here and nothing is written to the user's project.
// ---------------------------------------------------------------------------

// Turns "<file>#<path>" node keys into "<file>:<line>" / "<file>:<from>-<to>"
// pointers, project-relative. Returns undefined when there's nothing to point at.
function selectionTrail(state: IpcPayloads['selection:copy']) {
  if (!state || !state.projectPath || !Array.isArray(state.keys)) {
    return undefined;
  }
  const root = path.resolve(state.projectPath);
  const trail: string[] = [];
  for (const key of state.keys) {
    const hash = typeof key === 'string' ? key.indexOf('#') : -1;
    if (hash === -1) {
      continue;
    }
    // The key's file half is renderer input; keep it inside the project.
    const abs = path.resolve(root, key.slice(0, hash));
    if (!isPathWithin(root, abs)) {
      continue;
    }
    const at = locateSelection(abs, key.slice(hash + 1));
    if (!at) {
      continue;
    }
    const file = toPosix(path.relative(root, at.file));
    if (!('startLine' in at)) {
      trail.push(file);
    } else if (at.startLine === at.endLine) {
      trail.push(`${file}:${at.startLine}`);
    } else {
      trail.push(`${file}:${at.startLine}-${at.endLine}`);
    }
  }
  return trail.length ? trail : undefined;
}

ipcMain.handle('selection:copy', async (_event, state) => {
  const trail = selectionTrail(state);
  if (!trail) {
    return { ok: false as const };
  }
  clipboard.writeText(trail.join('\n'));
  return { ok: true as const, count: trail.length };
});

// ---------------------------------------------------------------------------
// Dev server IPC
// ---------------------------------------------------------------------------

function stopDevServer(cancelPending = true) {
  if (cancelPending) {
    devStarts.cancel();
  }
  if (!devServer) {
    return;
  }
  const { proc, daemon, bin, projectPath } = devServer;
  devServer = undefined;
  // Daemonized servers (Astro >= 7 forks a background process) stop via the CLI.
  if (daemon && bin) {
    try {
      const [cmd, argv] = nodeCliCommand(bin, ['dev', 'stop']);
      execFile(
        cmd,
        argv,
        { ...SHORT_COMMAND, cwd: projectPath, shell: commandNeedsShell(cmd) },
        () => {},
      );
    } catch {
      /* best effort */
    }
    return;
  }
  // External servers have no owned process and stay running.
  stopProcessTree(proc);
}

let devLogBuffer: string[] = [];

function pushDevLog(chunk: string) {
  devLogBuffer.push(chunk.slice(-MAIN_LIMITS.logChunkCharsMax));
  // Keep roughly the last 200 chunks.
  if (devLogBuffer.length > 200) {
    devLogBuffer = devLogBuffer.slice(-200);
  }
  send('dev:log', chunk);
}

function recentDevLog(charsMax = 1200) {
  const text = devLogBuffer.join('').replace(/\x1b\[[0-9;]*m/g, '');
  return text.slice(-charsMax).trim();
}

function portAnswers(port: number, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    sock.setTimeout(1500);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => resolve(false));
  });
}

// Astro >= 5 keeps a per-project single-instance lock and reports the
// already-running server's URL when it refuses to start. The message format
// varies: "already running.\n  URL: http://..." on a TTY, or a JSON log line
// "Dev server already running at http://localhost:4322 (pid 69052)" otherwise —
// so grab the first URL that follows "already running".
function parseExistingServer(log: string) {
  const match = log.match(/already running[\s\S]*?(https?:\/\/[^\s"\\)]+)/i);
  return match ? capture(match, 1).replace(/\/+$/, '') : undefined;
}

// Wraps the project's Astro config (dev preview only) with a Vite plugin
// that swaps each page's source for a marker-annotated equivalent — every
// model node sits between <!--avb-s:path--> / <!--avb-e:path--> comments so the
// preview can outline the node selected/hovered in the app. Written into
// node_modules/.avb so it never shows up in the user's git status; the file
// on disk is untouched.
// Which concrete URLs a dynamic route ([slug].astro) actually stands for.
//
// getStaticPaths is ordinary JS — it can read a content collection, hit an API,
// map over anything — so the only reliable way to know its paths is to run it,
// and the only thing that can run it is the dev server itself. Hence an
// injected endpoint rather than parsing the frontmatter.
//
// The page module is imported lazily through a glob: importing it evaluates
// module scope (where getStaticPaths lives) but not the component body, so
// nothing that needs Astro.params runs here.
const PATHS_ENDPOINT = `// Generated by Stacki (dev preview only) — do not edit.
export const prerender = false;

const pages = import.meta.glob('/src/pages/**/*.{astro,md,mdx}');

// getStaticPaths' props ARE the page's Astro.props — the only place the editor
// can see REAL data for a dynamic route, the entry behind the canvas with its
// values in it. What crosses the wire is a SAMPLE, not the data: long strings
// are clipped, long lists cut short, deep nesting stopped, and anything JSON
// can't hold (a function, a symbol) dropped. Enough to show a designer what a
// field holds and what it is called; never enough to be worth its weight.
const MAX_STRING = 160;
const MAX_ITEMS = 8;
const MAX_DEPTH = 6;
export function sample(value, depth) {
  const d = depth || 0;
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return undefined; // functions, symbols, bigints
  // A date is a value, not a shape: kept as one, tagged so the editor can say
  // "date" rather than showing an object with no keys.
  if (value instanceof Date)
    return { __stacki: 'date', value: isNaN(value.getTime()) ? null : value.toISOString() };
  if (d >= MAX_DEPTH) return { __stacki: 'deep' };
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((v) => {
      const s = sample(v, d + 1);
      return s === undefined ? null : s;
    });
    if (value.length > MAX_ITEMS) out.push({ __stacki: 'more', count: value.length - MAX_ITEMS });
    return out;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    let s;
    try {
      s = sample(value[key], d + 1);
    } catch {
      continue; // a getter that throws is not worth the whole entry
    }
    if (s !== undefined) out[key] = s;
  }
  return out;
}

// Named for the importer's sake: /__avb/data samples entries the same way.
export const SAMPLE = sample;

export async function GET({ url }) {
  const rel = url.searchParams.get('p') || '';
  const body = { entries: [], error: null };
  try {
    // The glob keys are project-root-absolute, matching what the app sends.
    const load = pages['/' + rel.replace(/^\\/+/, '')];
    if (!load) {
      body.error = 'Page not found: ' + rel;
    } else {
      const mod = await load();
      if (typeof mod.getStaticPaths === 'function') {
        const result = await mod.getStaticPaths();
        body.entries = (Array.isArray(result) ? result : [])
          .filter((e) => e && typeof e === 'object' && e.params && typeof e.params === 'object')
          .map((e, i) => ({
            params: e.params,
            // Only the first few: the editor shows ONE entry's data at a time,
            // and a collection of 400 posts would otherwise cross the wire in
            // full every time the frontmatter changes.
            props: i < 30 ? sample(e.props) : null,
          }));
      }
    }
  } catch (err) {
    body.error = String((err && err.message) || err);
  }
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}
`;

// The other half of the picker's data: a page that never declares
// getStaticPaths still reads collections in its frontmatter
// (`const posts = await getCollection("blog")`), and that is the common list
// page. One entry is all a picker needs to show what a post HAS.
const DATA_ENDPOINT = `// Generated by Stacki (dev preview only) — do not edit.
export const prerender = false;

import { SAMPLE } from './paths.js';

export async function GET({ url }) {
  const name = url.searchParams.get('c') || '';
  // A particular entry when the editor knows which one — a reference names it
  // — and otherwise the first, which is enough to show what a collection has.
  const id = url.searchParams.get('id') || '';
  const body = { entry: null, error: null };
  if (!/^[\\w-]+$/.test(name) || (id && (!/^[\\w\\-./]+$/.test(id) || id.includes('..')))) {
    body.error = 'Bad collection or entry name';
    return json(body);
  }
  try {
    // Imported here rather than at the top: a project with no content config
    // has no astro:content to import, and this route must not take the dev
    // server down with it.
    const { getCollection, getEntry } = await import('astro:content');
    if (id) {
      const entry = await getEntry(name, id);
      body.entry = entry ? SAMPLE(entry) : null;
    } else {
      const entries = await getCollection(name);
      body.entry = entries && entries.length ? SAMPLE(entries[0]) : null;
    }
  } catch (err) {
    body.error = String((err && err.message) || err);
  }
  return json(body);
}

const json = (body) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
`;

// The page patcher, handed to every page as a module. It lives in its own
// file rather than as a string in here because it is real code that has to
// stay readable — and it is read rather than required, since it runs in the
// browser and not in this process. If it cannot be read, pages simply reload
// the way they always did.
//
// Its bounds come from shared/limits.ts, prepended here — the bridge boundary —
// so the patcher in the page answers to the same numbers as the rest of the app
// (step 7). The patcher declares the constant and reads nothing else.
let MORPH_CLIENT = '';
try {
  const bounds = {
    previewMarkersMax: LIMITS.previewMarkersMax,
    previewMorphWorkMax: LIMITS.previewMorphWorkMax,
  };
  MORPH_CLIENT =
    `const AVB_PREVIEW_LIMITS = Object.freeze(${JSON.stringify(bounds)});\n` +
    readSource(path.join(__dirname, 'morphClient.js'));
} catch {
  MORPH_CLIENT = '';
}

// The patcher, written as a script Astro is allowed to process — which means
// Astro bundles it and puts it in <head>, exactly as it does for any script a
// component writes. It is still a module (import.meta.hot, which is what it
// listens on), and it is no longer a node in the page's own markup.
//
// It used to carry `is:inline`, which tells Astro to leave a tag exactly where
// it was written. A script is display:none, so a tag in the body looked free —
// and it is a child: :last-child, :nth-child, `+`, `~` and `> *` all count it.
// A page rendered into a layout's slot handed that slot one extra child, and
// CSS written for the children a component is given saw something the real
// build has not got.
const MORPH_TAG_HTML = MORPH_CLIENT ? "<script>import 'virtual:avb-morph';</script>" : '';

// Node's own parser, asked the same question it will be asked at startup.
// Cheap next to spawning a dev server, and it turns a whole class of mistake
// in the generated config from "no preview" into "preview without extras".
function parsesAsModule(file: string) {
  try {
    const bin = resolveNodeBin();
    if (!bin) {
      return true;
    } // nothing to check with — let Astro have its say
    const out = spawnSync(bin, ['--check', file], { encoding: 'utf8', timeout: 10000 });
    if (out.error || out.status === null) {
      return true;
    } // check could not run
    return out.status === 0;
  } catch {
    return true;
  }
}

function writeMarkerConfig(projectPath: string) {
  try {
    const directory = path.join(projectPath, 'node_modules', '.avb');
    fs.mkdirSync(directory, { recursive: true });
    // Stale until this run's astro:config:done writes it again; until then the
    // config's own text is the better answer.
    fs.rmSync(path.join(directory, 'resolved.json'), { force: true });
    fs.rmSync(path.join(directory, 'routes.json'), { force: true });
    const userConfig = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'].find((name) =>
      fs.existsSync(path.join(projectPath, name)),
    );
    // The dev server is a plain Node process, and plain Node can't read
    // inside app.asar — it would fail the config import and take the whole
    // preview down. build.asarUnpack keeps a real copy on disk beside the
    // archive; this points at that copy. Unpacked in dev too (no asar in the
    // path), so the replace is a no-op there.
    const markersPath = path
      .join(__dirname, 'previewMarkers.js')
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const previewHelperPath = path
      .join(__dirname, 'componentPreview.js')
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    // Vite normally resolves symlinks before loading source (including
    // macOS /var -> /private/var). Match both spellings because a project's
    // preserveSymlinks option can keep the original one instead.
    const projectDirectories = [
      ...new Set([toPosix(path.resolve(projectPath)), toPosix(fs.realpathSync(projectPath))]),
    ];
    const config = renderMarkerConfig([
      userConfig ? `import userConfig from '../../${userConfig}';` : 'const userConfig = {};',
      JSON.stringify(markersPath),
      JSON.stringify(previewHelperPath),
      JSON.stringify(projectDirectories),
      JSON.stringify(MORPH_CLIENT),
      JSON.stringify(MORPH_TAG_HTML),
      JSON.stringify(toPosix(path.join(directory, 'preview.astro'))),
      JSON.stringify(toPosix(path.join(directory, 'paths.js'))),
      JSON.stringify(toPosix(path.join(directory, 'data.js'))),
    ]);
    const configPath = path.join(directory, 'astro.config.mjs');
    fs.writeFileSync(configPath, config);
    fs.writeFileSync(path.join(directory, 'preview.astro'), renderComponentPreviewPage());
    fs.writeFileSync(path.join(directory, 'paths.js'), PATHS_ENDPOINT);
    fs.writeFileSync(path.join(directory, 'data.js'), DATA_ENDPOINT);
    // This file is assembled here and handed to Astro as its config. If it
    // will not parse, Astro does not start, and the project gets no preview at
    // all — the editor's own canvas broken by the editor's own scaffolding,
    // over something the project never asked for. Read it back the way node
    // will and say no rather than hand over something that cannot load: the
    // caller falls back to a plain dev server, which costs the outlines and
    // the live patching and keeps everything else working.
    if (!parsesAsModule(configPath)) {
      pushDevLog(
        '\n[stacki] the generated preview config did not parse; starting the dev ' +
          'server without it. Outlines and live updates are off for this session.\n',
      );
      return undefined;
    }
    return configPath;
  } catch {
    return undefined; // preview still works, just without outlines
  }
}

async function spawnDevServer(
  projectPath: string,
  localBin: string,
  { force, bare }: { readonly force: boolean; readonly bare: boolean },
  assertActive: () => void,
) {
  const port = await findFreePort(4321);
  assertActive();
  const args = ['dev', '--port', String(port), '--host', '127.0.0.1'];
  // Astro resolves --config against the project root and rejects absolute
  // paths ([ConfigNotFound]), so pass it relative to the spawn cwd.
  // `bare` is the last resort: the project's own config, none of this app's,
  // so a preview still comes up even if what this app generates cannot run.
  const markerConfig = bare ? undefined : writeMarkerConfig(projectPath);
  if (markerConfig) {
    args.push('--config', toPosix(path.relative(projectPath, markerConfig)));
  }
  if (force) {
    args.push('--force');
  }

  const proc = spawnAstroServer(projectPath, localBin, args);

  const url = `http://127.0.0.1:${port}`;
  devServer = { proc, url, projectPath, bin: localBin };

  proc.stdout.on('data', (chunk: Buffer) => pushDevLog(chunk.toString()));
  proc.stderr.on('data', (chunk: Buffer) => pushDevLog(chunk.toString()));
  proc.on('error', (error) => {
    pushDevLog(`\n[spawn error] ${errorMessage(error)}\n`);
    if (devServer?.proc === proc) {
      devServer = undefined;
    }
  });
  proc.on('exit', (code) => {
    if (devServer && devServer.proc === proc) {
      // Astro >= 7 daemonizes: the CLI exits 0 after forking the real server
      // into a background process. That's a success, not a failure.
      const running = recentDevLog().match(/Dev server running at (https?:\/\/[^\s"\\)]+)/i);
      if (code === 0 && running) {
        devServer = { proc: undefined, url, projectPath, daemon: true, bin: localBin };
      } else {
        devServer = undefined;
        send('dev:exit', { code, log: recentDevLog() });
      }
    }
  });

  // The daemon's own failure reasons only land in `astro dev logs`.

  // Wait until the port answers so the iframe doesn't load into a dead server.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    assertActive();
    if (!devServer) {
      throw new Error(
        'Dev server exited before it was ready.\n\n' +
          (await spawnDevServerFailureDetail(projectPath, localBin)),
      );
    }
    if (await portAnswers(port)) {
      assertActive();
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    'Astro dev server did not start within 60 seconds.\n\n' +
      (await spawnDevServerFailureDetail(projectPath, localBin)),
  );
}

// Probes the URL's port on its hostname plus both loopback families —
// on macOS "localhost" may resolve to ::1 while the server listens on IPv4.
async function serverAlive(urlString: string) {
  const parsed = new URL(urlString);
  const port = Number(parsed.port || 80);
  for (const host of [parsed.hostname, '127.0.0.1', '::1']) {
    if (await portAnswers(port, host)) {
      return true;
    }
  }
  return false;
}

// Astro's daemon lock file (.astro/dev.json) — the source of truth for an
// already-running background server, regardless of who started it.
function readAstroLock(projectPath: string) {
  try {
    const data = parseAstroLock(readJson(path.join(projectPath, '.astro', 'dev.json')));
    if (data.url) {
      return data;
    }
  } catch {
    /* no lock */
  }
  return undefined;
}

// Serialize dev:start calls — concurrent spawns race Astro's daemon lock and
// the loser dies with "exited before becoming ready".
const devStarts = createKeyedQueue<IpcResults['dev:start']>();

ipcMain.handle('dev:start', (_event, projectPath) => {
  captureEra++;
  return devStarts.run(projectPath, async (assertActive) => {
    const result = await doDevStart(projectPath, assertActive);
    assertActive();
    scheduleThumb(projectPath, 6000);
    return { ...result, trailingSlash: readTrailingSlash(projectPath) };
  });
});

async function doDevStart(projectPath: string, assertActive: () => void) {
  assertActive();
  if (devServer && sameFilesystemPath(devServer.projectPath, projectPath)) {
    // For adopted external servers, make sure it's still alive.
    if (devServer.external) {
      const current = devServer;
      if (await serverAlive(current.url)) {
        assertActive();
        return { url: current.url, external: true };
      }
      devServer = undefined;
    } else {
      return { url: devServer.url };
    }
  }
  assertActive();
  stopDevServer(false);
  devLogBuffer = [];

  const localBin = await doDevStartDependencies(projectPath, assertActive);

  // A lock file means a daemon exists (possibly stale, possibly started
  // without the app's marker config) — pass --force so ours replaces it.
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const force = attempt > 0 || !!readAstroLock(projectPath);
    try {
      // Retry with --force: first-attempt daemon startup can flake (stale
      // daemon state, vite re-optimizing after a config change).
      return {
        url: await spawnDevServer(projectPath, localBin, { force, bare: false }, assertActive),
      };
    } catch (error: unknown) {
      assertActive();
      lastError = error;
      stopDevServer(false);
      // Another dev server already running for this project?
      const existing = parseExistingServer(recentDevLog());
      if (existing) {
        const alive = await serverAlive(existing);
        assertActive();
        if (alive) {
          // Adopt the user's own server instead of fighting it.
          devServer = { proc: undefined, url: existing, projectPath, external: true };
          return { url: existing, external: true };
        }
      }
      devLogBuffer = [];
      await new Promise((resolve) => setTimeout(resolve, 800));
      assertActive();
    }
  }
  // Everything above ran with this app's generated config. A project whose
  // preview will not come up is worse than one without outlines, so try once
  // more on the project's own config before giving up. What starts here has no
  // markers and no live patching — an edit reloads the page, the way it did
  // before any of this — but the canvas is a canvas again.
  try {
    const url = await spawnDevServer(
      projectPath,
      localBin,
      { force: true, bare: true },
      assertActive,
    );
    pushDevLog(
      "\n[stacki] the preview would not start with this app's config, so it is " +
        "running on the project's own. Outlines and live updates are off; the " +
        'log above says why.\n',
    );
    if (devServer) {
      devServer = { ...devServer, bare: true };
    }
    return { url, bare: true };
  } catch {
    assertActive();
    stopDevServer(false);
    throw lastError; // report the first failure: it is the one that explains it
  }
}

// ---------------------------------------------------------------------------
// Style sources
//
// Where the style panel can author CSS: every stylesheet in the project, plus
// (added on the renderer side) the <style> blocks on the current page and in
// its components. Anything under node_modules, dist or the app's own generated
// config is skipped — those aren't the author's to edit.
// ---------------------------------------------------------------------------

// Same containment rule the asset protocol uses: the style panel writes only
// inside the project that is currently open.
function assertInProject(filePath: string) {
  const abs = path.resolve(String(filePath || ''));
  if (!openProjectRoot || !isPathDescendant(openProjectRoot, abs)) {
    throw new Error('Refusing to touch a file outside the open project.');
  }
  return abs;
}

const CSS_SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.astro', 'release', '.avb']);

function listCssFiles(root: string) {
  const out: StyleFile[] = [];
  const checkDirectory = directoryBudget(root);
  const walk = (directory: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    checkDirectory(directory, entries.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'listCssFiles: the budget bounds depth');
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        continue;
      }
      const full = path.join(directory, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (CSS_SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(full, relPath, depth + 1);
      } else if (/\.(css|scss|sass|less)$/i.test(entry.name)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* unreadable — still list it, the read will report the error */
        }
        out.push({ rel: toPosix(relPath), name: entry.name, path: full, size });
      }
    }
  };
  walk(root, '', 0);
  // Shallow paths first (src/styles/global.css before a deeply nested partial),
  // then alphabetical — the file you want is usually near the top of the tree.
  return out.sort((left, right) => {
    const da = left.rel.split('/').length;
    const db = right.rel.split('/').length;
    return da - db || left.rel.localeCompare(right.rel);
  });
}

ipcMain.handle('style:listFiles', async (_event, projectPath) => {
  if (!projectPath) {
    return { files: [] };
  }
  return { files: listCssFiles(projectPath) };
});

// A component's `<style is:global>` is page CSS. Astro leaves those rules
// unhashed, so they style whatever the page renders — including elements that
// live in a different file from the one being edited, which is exactly the case
// the style panel used to be blind to. Scoped `<style>` blocks are deliberately
// left out: Astro hashes them to their own component's elements, so their rules
// can't reach a selection made from another file.
const ASTRO_GLOBAL_STYLE = /<style\b[^>]*\bis:global\b[^>]*>/i;
const ASTRO_SCAN_LIMIT = 512 * 1024; // a .astro file this big isn't a component

function listAstroStyleFiles(root: string) {
  const out: StyleFile[] = [];
  const checkDirectory = directoryBudget(root);
  const walk = (directory: string, rel: string, depth: number): void => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    checkDirectory(directory, entries.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'listAstroStyleFiles: the budget bounds depth');
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(directory, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (CSS_SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(full, relPath, depth + 1);
        continue;
      }
      if (!/\.astro$/i.test(entry.name)) {
        continue;
      }
      try {
        const { size } = fs.statSync(full);
        if (size > ASTRO_SCAN_LIMIT) {
          continue;
        }
        if (!ASTRO_GLOBAL_STYLE.test(readSource(full))) {
          continue;
        }
        out.push({ rel: toPosix(relPath), name: entry.name, path: full, size });
      } catch {
        /* unreadable — nothing to offer for it */
      }
    }
  };
  // Only src/: components elsewhere aren't part of the page's CSS, and this
  // keeps the scan off node_modules and build output entirely.
  walk(path.join(root, 'src'), 'src', 0);
  return out.sort((left, right) => left.rel.localeCompare(right.rel));
}

ipcMain.handle('style:listAstroStyles', async (_event, projectPath) => {
  if (!projectPath) {
    return { files: [] };
  }
  return { files: listAstroStyleFiles(projectPath) };
});

ipcMain.handle('style:readFile', async (_event, filePath) => {
  const abs = assertInProject(filePath);
  return { css: readSource(abs) };
});

ipcMain.handle('style:writeFile', async (_event, { filePath, css }) => {
  const abs = assertInProject(filePath);
  writeProjectText(abs, css); // notes the write, so the watcher does not see it as external
  return { ok: true as const };
});

// ---------------------------------------------------------------------------
// Source files behind a symbol
// ---------------------------------------------------------------------------

// tsconfig/jsconfig `paths` for the open project, as [prefix, [targets]] with
// the trailing /* stripped. Astro's own config is extended, not read: only the
// project's aliases matter here, and those live in its own file.
function projectAliases(projectPath: string) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(projectPath, name);
    if (!fs.existsSync(file)) {
      continue;
    }
    try {
      // Config files allow comments and trailing commas; strip both rather
      // than pulling in a JSON5 parser for one field.
      const raw = readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      const input: unknown = JSON.parse(raw);
      const aliases = toRecord(toRecord(input)?.['compilerOptions'])?.['paths'];
      if (aliases) {
        return parseAliases(input);
      }
    } catch {
      // A malformed config just means no aliases.
    }
  }
  return [];
}

const SOURCE_EXTENSIONS = ['', '.ts', '.js', '.mjs', '.mts', '.tsx', '.jsx', '.json', '.astro'];

function firstExisting(base: string) {
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  for (const ext of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = path.join(base, 'index' + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

// The file an import specifier points at: relative paths, project aliases
// (`@/consts.ts`), and the usual extension guessing. Bare package names
// resolve to nothing — node_modules isn't the user's code to edit.
function resolveImportPath(projectPath: string, fromFile: string, spec: string) {
  const specifier = String(spec || '');
  if (!specifier) {
    return undefined;
  }
  if (specifier.startsWith('.')) {
    return firstExisting(path.resolve(path.dirname(fromFile), specifier));
  }
  for (const [prefix, targets] of projectAliases(projectPath)) {
    if (!prefix || !specifier.startsWith(prefix)) {
      continue;
    }
    const rest = specifier.slice(prefix.length);
    for (const target of targets) {
      const found = firstExisting(path.resolve(projectPath, target, rest));
      if (found) {
        return found;
      }
    }
  }
  if (specifier.startsWith('/')) {
    return firstExisting(path.join(projectPath, specifier.slice(1)));
  }
  return undefined;
}

// 1-based line of `name`'s top-level declaration, so the editor can open on it.
function declarationLine(text: string, name: string) {
  if (!name) {
    return 0;
  }
  const re = new RegExp(
    // `[ \t]*`, not `\s*`: with the m flag `\s` eats the newlines before the
    // declaration, and the match would start on a blank line above it.
    `^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+` +
      `${String(name).replace(/[^\w$]/g, '')}\\b`,
    'm',
  );
  const match = re.exec(text);
  if (!match) {
    return 0;
  }
  return text.slice(0, match.index).split('\n').length;
}

// Opens the file an imported symbol comes from. `fromFile` is the file doing
// the importing, so relative specifiers resolve the way the bundler sees them.
ipcMain.handle('src:readSymbol', async (_event, { projectPath, fromFile, spec, name }) => {
  if (!projectPath || !fromFile) {
    return { ok: false as const };
  }
  const abs = resolveImportPath(projectPath, path.resolve(fromFile), spec);
  if (!abs) {
    return { ok: false as const, reason: 'not-found' };
  }
  assertInProject(abs);
  const stat = fs.statSync(abs);
  if (stat.size > MAIN_LIMITS.editableFileBytesMax) {
    return { ok: false as const, reason: 'too-large' };
  }
  const text = readSource(abs);
  return {
    ok: true as const,
    rel: path.relative(projectPath, abs),
    text,
    line: declarationLine(text, name),
  };
});

// Where an import points, as a project-relative path. Same resolution as
// src:readSymbol, but it never reads the file — the callers here are asking
// about images, and their bytes are none of this channel's business.
ipcMain.handle('src:resolvePath', async (_event, { projectPath, fromFile, spec }) => {
  if (!projectPath || !fromFile) {
    return { ok: false as const };
  }
  const abs = resolveImportPath(projectPath, path.resolve(fromFile), spec);
  if (!abs) {
    return { ok: false as const };
  }
  assertInProject(abs);
  return { ok: true as const, rel: toPosix(path.relative(projectPath, abs)) };
});

// An image's pixel size, read from the file's own header.
//
// Astro takes the intrinsic size straight from a local asset — only a remote
// source gets `inferSize`. So a width/height field over a project file should
// say what that size IS, and to do that the app has to know it without waiting
// for a thumbnail somewhere to finish decoding.
function imageSizeOf(abs: string) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const head = Buffer.alloc(32768);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);

    // PNG: IHDR is always the first chunk.
    if (buf.length > 24 && buf.toString('binary', 1, 4) === 'PNG') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF: little-endian in the logical screen descriptor.
    if (buf.length > 10 && buf.toString('binary', 0, 3) === 'GIF') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    const webp = webpImageSize(buf);
    if (webp) {
      return webp;
    }
    // JPEG: walk the segments to the start-of-frame, which carries the size.
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let at = 2;
      while (at + 9 < buf.length) {
        if (buf[at] !== 0xff) {
          at += 1;
          continue;
        }
        const marker = buf.readUInt8(at + 1);
        const segmentLength = buf.readUInt16BE(at + 2);
        // SOF0…SOF15, minus the four that aren't frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc, 0xd8].includes(marker)) {
          return { h: buf.readUInt16BE(at + 5), w: buf.readUInt16BE(at + 7) };
        }
        at += 2 + segmentLength;
      }
    }
    // SVG: width/height when they're absolute, else the viewBox's own units.
    if (/\.svg$/i.test(abs)) {
      const text = buf.toString('utf8');
      const tag = text.match(/<svg\b[^>]*>/i)?.[0] || '';
      const dimension = (name: string) => {
        const raw = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
        return raw && /^[\d.]+(px)?$/i.test(raw.trim()) ? Math.round(parseFloat(raw)) : undefined;
      };
      const width = dimension('width');
      const height = dimension('height');
      if (width && height) {
        return { w: width, h: height };
      }
      const box = tag.match(/\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i);
      if (box) {
        return {
          w: Math.round(parseFloat(capture(box, 1))),
          h: Math.round(parseFloat(capture(box, 2))),
        };
      }
    }
  } catch {
    /* unreadable or a format we don't decode — the caller falls back */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
  return undefined;
}

ipcMain.handle('assets:dimensions', async (_event, { projectPath, rel }) => {
  const abs = assertInProject(path.resolve(projectPath, rel));
  return { dims: imageSizeOf(abs) ?? undefined };
});

ipcMain.handle('src:readText', async (_event, { projectPath, rel }) => {
  const abs = assertInProject(path.resolve(projectPath, rel));
  return { text: readSource(abs) };
});

ipcMain.handle('src:writeText', async (_event, { projectPath, rel, text }) => {
  const abs = assertInProject(path.resolve(projectPath, rel));
  writeProjectText(abs, text);
  return { ok: true as const };
});

ipcMain.handle('dev:stop', async () => {
  stopDevServer();
  return { ok: true as const };
});

// ---------------------------------------------------------------------------
// Why the dev server won't start
//
// A raw Astro log tells a user nothing actionable. Nearly every failure that
// isn't the project's own code is one of: no Node at all, a Node too old for
// the version of Astro the project pins, or dependencies never installed —
// so name which one it is and what the project actually needs.
// ---------------------------------------------------------------------------

// engines.node ranges as they're actually written ("18.20.8 || ^20.3.0 ||
// >=22.0.0", ">=22.12.0"). Anything this can't parse counts as satisfied:
// the point is to explain a failure that already happened, never to block a
// launch over a range we couldn't read.
function satisfiesRange(version: string | undefined, range: string | undefined) {
  if (!version || !range) {
    return true;
  }
  const parse = (text: string): readonly [number, number, number] | undefined => {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
    return match ? [+capture(match, 1), +capture(match, 2), +capture(match, 3)] : undefined;
  };
  const current = parse(version);
  if (!current) {
    return true;
  }
  const cmp = (left: readonly [number, number, number], right: readonly [number, number, number]) =>
    left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  return range.split('||').some((partRaw) => {
    const part = partRaw.trim();
    const target = parse(part);
    if (!target) {
      return true;
    } // "*", "latest", something exotic — don't judge
    if (part.startsWith('>=')) {
      return cmp(current, target) >= 0;
    }
    if (part.startsWith('>')) {
      return cmp(current, target) > 0;
    }
    if (part.startsWith('^')) {
      return current[0] === target[0] && cmp(current, target) >= 0;
    }
    if (part.startsWith('~')) {
      return current[0] === target[0] && current[1] === target[1] && cmp(current, target) >= 0;
    }
    return cmp(current, target) === 0;
  });
}

function nodeVersionOf(bin: string) {
  try {
    return execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

ipcMain.handle('dev:probe', (_event, url) => probeUrl(url));

ipcMain.handle('dev:diagnose', async (_event, projectPath) => {
  const nodePath = resolveNodeBin() ?? undefined;
  const nodeVersion = nodePath ? nodeVersionOf(nodePath) : undefined;

  let astroVersion: string | undefined = undefined;
  let requires: string | undefined = undefined;
  try {
    const pkg = parseRecord(
      readJson(path.join(projectPath, 'node_modules', 'astro', 'package.json')),
    );
    astroVersion = parseOptionalString(pkg['version']) || undefined;
    requires = parseOptionalString(toRecord(pkg['engines'])?.['node']) || undefined;
  } catch {
    /* astro not installed — reported as its own kind below */
  }

  const hasDeps = fs.existsSync(path.join(projectPath, 'node_modules'));
  const nodeOk = nodeVersion ? satisfiesRange(nodeVersion, requires) : false;

  let kind = 'unknown';
  if (!nodePath) {
    kind = 'no-node';
  } else if (!hasDeps || !astroVersion) {
    kind = 'no-deps';
  } else if (!nodeOk) {
    kind = 'node-too-old';
  }

  return {
    kind,
    nodePath,
    nodeVersion,
    astroVersion,
    requires,
    launchedFromGui: !process.env['SHELL'],
  };
});

// ---------------------------------------------------------------------------
// Git / GitHub IPC
// ---------------------------------------------------------------------------

ipcMain.handle('git:info', async (_event, projectPath) => {
  try {
    await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { isRepo: false as const };
  }
  const info: GitInfo = {
    isRepo: true as const,
    branch: '',
    branches: [],
    remote: undefined,
    dirty: false,
    ahead: 0,
    // Branches holding work that was left behind on the way out, so the
    // switcher can say where it is rather than making it a thing you have to
    // remember.
    parked: [],
  };
  info.parked = await readGitParked(projectPath);
  Object.assign(info, await readGitIdentity(projectPath));
  try {
    const listed = (await git(projectPath, ['branch', '--format=%(refname:short)'])).stdout
      .split('\n')
      .map((branch) => branch.trim())
      .filter(Boolean);
    // Git lists branches alphabetically, which puts the trunk wherever its
    // name happens to fall. But the trunk is not one branch among many — it
    // is the one you came from and the one you go back to, so it goes first
    // and the rest keep the order git gave them.
    const trunk = ['main', 'master'].find((branch) => listed.includes(branch));
    info.branches = trunk ? [trunk, ...listed.filter((branch) => branch !== trunk)] : listed;
    // Named as well as ordered. Git will delete the trunk as readily as any
    // other branch — `git branch -d main` succeeds the moment main is merged
    // into whatever you are standing on — and the branch everything comes back
    // to is not one to lose to a stray click.
    info.trunk = trunk || undefined;
  } catch {
    /* empty repo */
  }
  try {
    info.remote =
      (await git(projectPath, ['remote', 'get-url', 'origin'])).stdout.trim() || undefined;
  } catch {
    info.remote = undefined;
  }
  try {
    const out = (await git(projectPath, ['status', '--porcelain'])).stdout;
    // Porcelain v1 is "XY path" — two status columns, a space, then the path
    // (renames as "old -> new"). Don't trim the line before slicing: the
    // first column is a space for worktree-only changes.
    const lines = out.split('\n').filter((line) => line.trim());
    info.dirty = lines.length > 0;
    info.dirtyFiles = lines.slice(0, 50).map((line) => {
      const filePath = line.slice(3);
      const arrow = filePath.lastIndexOf(' -> ');
      return (arrow === -1 ? filePath : filePath.slice(arrow + 4)).replace(/^"|"$/g, '');
    });
  } catch {
    /* ignore */
  }
  // Without an upstream there's no count to give — and "0 ahead" would read
  // as "nothing to push" when in fact the branch has never been pushed at
  // all, so the two cases have to stay distinguishable.
  try {
    await git(projectPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    info.hasUpstream = true;
  } catch {
    info.hasUpstream = false;
  }
  if (info.hasUpstream) {
    try {
      const counts = (
        await git(projectPath, ['rev-list', '--count', '--left-only', 'HEAD...@{upstream}'])
      ).stdout.trim();
      info.ahead = parseInt(counts, 10) || 0;
    } catch {
      info.ahead = 0;
    }
  }
  return info;
});

// Is the GitHub CLI usable? Checked when the publish dialog opens so a
// missing or logged-out `gh` is stated up front, instead of surfacing as a
// failure after the user has filled the form in.
ipcMain.handle('git:ghStatus', async (_event, projectPath) => {
  try {
    await run('gh', ['--version'], projectPath);
  } catch {
    return { installed: false as const, authed: false as const };
  }
  try {
    // Writes its report to stderr and exits non-zero when logged out.
    const result = await run('gh', ['auth', 'status'], projectPath);
    const out = `${result.stdout}${result.stderr}`;
    const match = out.match(/(?:account|as)\s+([\w-]+)/i);
    return {
      installed: true as const,
      authed: true as const,
      user: match ? capture(match, 1) : undefined,
    };
  } catch {
    return { installed: true as const, authed: false as const };
  }
});

ipcMain.handle('git:init', async (_event, projectPath) => {
  await git(projectPath, ['init', '-b', 'main']);
  return { ok: true as const };
});

// Work in progress, set aside under the branch it belongs to.
//
// Git will not switch branches over changes it would have to overwrite, and
// the usual advice — commit first — asks for a commit that only exists to
// make git cooperate. So the changes are put away against the branch being
// left, and taken back out when that branch is next opened. They are never
// lost and never travel to a branch they were not written on.
//
// The tag is what makes this safe: only a stash Stacki wrote is ever restored,
// so someone's own `git stash` is left alone.
// Tags already in people's stash lists name a detached HEAD `null`; the
// spelling stays so those are still found.
const parkTag = (branch: string | undefined) => `stacki:park:${branch ?? 'null'}`;

async function isDirty(projectPath: string) {
  const { stdout } = await git(projectPath, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

// The most recent parking for this branch, as a ref that is still valid right
// now — stash indices shift as entries come and go, so this is resolved
// immediately before it is used.
async function parkedRef(projectPath: string, branch: string | undefined) {
  const { stdout } = await git(projectPath, ['stash', 'list', '--format=%gd%x09%gs']);
  const tag = parkTag(branch);
  for (const line of stdout.split('\n')) {
    const [ref, subject] = line.split('\t');
    if (ref && subject && subject.trim().endsWith(tag)) {
      return ref.trim();
    }
  }
  return undefined;
}

async function parkBranch(projectPath: string, branch: string | undefined) {
  if (!(await isDirty(projectPath))) {
    return false;
  }
  await git(projectPath, ['stash', 'push', '--include-untracked', '-m', parkTag(branch)]);
  return true;
}

async function unparkBranch(projectPath: string, branch: string | undefined) {
  const ref = await parkedRef(projectPath, branch);
  if (!ref) {
    return { restored: false };
  }
  try {
    await git(projectPath, ['stash', 'pop', ref]);
    return { restored: true };
  } catch {
    // A pop that cannot apply leaves conflict markers in the files. That is a
    // reasonable state for someone at a terminal and a bad one for an editor
    // that will parse those files a moment later — the page would read as
    // broken markup. The tree goes back to the branch as committed, and the
    // work stays parked, which is the state it was already in. Safe because
    // the switch left the tree clean, so there is nothing else here to lose.
    try {
      await git(projectPath, ['reset', '--hard', 'HEAD']);
      await git(projectPath, ['clean', '-fd']);
    } catch {
      /* nothing better to try */
    }
    return {
      restored: false,
      error:
        `Your work on "${branch}" is still parked — it could not be put back automatically ` +
        'because the branch has changed underneath it. ' +
        'It is safe: recover it with `git stash list` and `git stash pop`.',
    };
  }
}

// Switching branches. The behaviour, and why it tries before it asks, is in
// gitBranches.js; park/unpark are handed in because they live here.
ipcMain.handle('git:checkout', async (_event, { projectPath, branch, create, parkFirst }) => {
  const result = await switchBranch(git, {
    projectPath,
    branch,
    ...definedFields({ create, parkFirst }),
    park: async () => parkBranch(projectPath, await currentBranch(projectPath)),
    unpark: (from) => unparkBranch(projectPath, from),
  });
  if (!result.ok) {
    return result;
  }
  // Whatever was last left on this branch comes back out, however the switch
  // was made — that half is always wanted.
  const back = await unparkBranch(projectPath, branch);
  return { ...result, parkedFrom: result.parked ? result.from : undefined, ...back };
});

async function currentBranch(projectPath: string) {
  try {
    return (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    return undefined;
  }
}

// --- Previewing an old version ---------------------------------------------
//
// A second, deliberately dumb dev server pointed at a checkout of an old
// commit (see previewWorktree.js). None of the primary server's machinery
// applies: a preview is read-only, so it needs no markers, no morph client and
// no click-to-select — it only has to render. That is `bare` on spawnDevServer,
// which already exists as the primary server's last-resort path.
//
// Kept in its own registry rather than generalising `devServer`, whose daemon
// detection, external-server adoption and log plumbing are all keyed to there
// being exactly one.
const previewServers = new Map<string, PreviewServer>(); // projectPath -> {proc, url, ref, port}

async function stopPreview(projectPath: string) {
  const current = previewServers.get(projectPath);
  if (!current) {
    return;
  }
  previewServers.delete(projectPath);
  stopProcessTree(current.proc);
  try {
    await previewWorktree.removeWorktree(git, { projectPath });
  } catch {
    /* the checkout is disposable; nothing here is the user's work */
  }
}

function stopAllPreviews() {
  for (const [projectPath] of previewServers) {
    // Nothing to wait for: stopPreview settles on its own, since removing the
    // disposable checkout is already best-effort inside it.
    void stopPreview(projectPath);
  }
}

ipcMain.handle('preview:atCommit', async (_event, { projectPath, ref }) => {
  const directory = await previewWorktree.ensureWorktree(git, { projectPath, ref });

  // A server already up for this project just needs the checkout moved under
  // it — Vite notices the files changed and reloads, which is far quicker than
  // starting Astro again for every commit somebody clicks.
  const running = previewServers.get(projectPath);
  if (running?.proc && !running.proc.killed) {
    previewServers.set(projectPath, { ...running, ref });
    return { url: running.url, ref, reused: true as const };
  }

  const bin = isWin ? 'astro.cmd' : 'astro';
  const localBin = path.join(projectPath, 'node_modules', '.bin', bin);
  if (!fs.existsSync(localBin)) {
    throw new Error(
      'This project’s packages aren’t installed, so an older version can’t be shown. ' +
        'Install them and try again.',
    );
  }
  const port = await findFreePort(4500);
  if (previewServers.size >= MAIN_LIMITS.previewServersMax) {
    if (!previewServers.has(projectPath)) {
      throw new Error('Preview server limit');
    }
  }
  const proc = spawnAstroServer(directory, localBin, [
    'dev',
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
  ]);

  const url = `http://127.0.0.1:${port}`;
  let log = '';
  proc.stdout.on('data', (chunk) => (log = (log + chunk).slice(-12000)));
  proc.stderr.on('data', (chunk) => (log = (log + chunk).slice(-12000)));
  const spawnState: { error?: Error } = {};
  proc.on('error', (error) => {
    spawnState.error = error;
  });
  previewServers.set(projectPath, { proc, url, ref, port });
  proc.on('exit', () => {
    if (previewServers.get(projectPath)?.proc === proc) {
      previewServers.delete(projectPath);
    }
  });

  // Wait for it to answer rather than guessing at a delay. An old commit can
  // need packages that are not installed now, and that shows up as a server
  // that never comes up — so the failure has to be caught here and explained,
  // not left as a blank canvas.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (spawnState.error || proc.exitCode !== null || proc.killed) {
      break;
    }
    if (await serverAlive(url)) {
      return { url, ref, reused: false as const };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await stopPreview(projectPath);
  // The commonest real cause, said in those terms rather than as a stack trace.
  const missing = /Cannot find (?:module|package) ['"]?([^'"\s]+)/i.exec(log);
  throw new Error(
    missing
      ? `That version needs ${missing[1]}, which isn’t installed here. ` +
          'It can’t be shown without it.'
      : 'That version wouldn’t start. It may need packages that aren’t installed any more.',
  );
});

// The canvas's preview token (plan §9, step 7): a click on the canvas selects
// a node only while every file its rendering came from still holds the bytes
// the rendering's stamps name. Read from disk here, never from the watcher.
ipcMain.handle('preview:check', (_event, { projectPath, render }) =>
  checkPreviewRender(projectPath, render),
);

ipcMain.handle('preview:stop', async (_event, { projectPath }) => {
  await stopPreview(projectPath);
  return { ok: true as const };
});

// --- Reading history -------------------------------------------------------
//
// The panel gets files already described (see describeFile): "Home" rather
// than "src/pages/index.astro". Done here rather than in the renderer because
// this is the side that knows the project's shape, and because it keeps the
// panel about drawing rather than about interpreting paths.

async function readGitLog(payload: IpcPayloads['git:log']) {
  const result = await gitHistory.log(git, definedFields(payload));
  const commits = result.commits.map((commit) => ({
    ...commit,
    files: commit.files === undefined ? undefined : gitHistory.describeFiles(commit.files),
  }));
  return { ...result, commits };
}

ipcMain.handle('git:log', async (_event, payload) => readGitLog(payload));

ipcMain.handle('git:commitFiles', async (_event, { projectPath, ref }) =>
  gitHistory.describeFiles(await gitHistory.commitFiles(git, { projectPath, ref })),
);

// Every file in the project, with what has happened to each — the file
// browser's list, and the same status the commit picker reads.
ipcMain.handle('git:allFiles', async (_event, { projectPath }) =>
  gitHistory.describeFiles(await gitHistory.allFiles(git, { projectPath })),
);

ipcMain.handle('git:status', async (_event, { projectPath }) =>
  gitHistory.describeFiles(await gitHistory.status(git, { projectPath })),
);

ipcMain.handle('git:fileAt', async (_event, { projectPath, ref, path: filePath }) =>
  gitHistory.fileAt(git, { projectPath, ref, path: filePath }),
);

ipcMain.handle('git:worktrees', async (_event, { projectPath }) =>
  gitHistory.worktrees(git, { projectPath }),
);

// Setting work aside and picking it back up, on their own. The switch has done
// this internally for a while; a merge that finds unsaved work in its way needs
// the same two steps, and the user is the one deciding to take them.
ipcMain.handle('git:park', async (_event, { projectPath }) => {
  const branch = await currentBranch(projectPath);
  const parked = await parkBranch(projectPath, branch);
  return { ok: true as const, parked, branch: branch ?? undefined };
});

ipcMain.handle('git:unpark', async (_event, { projectPath }) => {
  const branch = await currentBranch(projectPath);
  return unparkBranch(projectPath, branch);
});

ipcMain.handle('git:merge', async (_event, { projectPath, branch }) =>
  mergeBranch(git, { projectPath, branch }),
);

// Finishing a merge the user has chosen their way through. The conflicting
// files come back from git:merge with both versions; this applies the answers.
ipcMain.handle('git:resolveMerge', async (_event, { projectPath, branch, choices }) =>
  resolveMerge(git, definedFields({ projectPath, branch, choices })),
);

ipcMain.handle('git:deleteBranch', async (_event, { projectPath, branch, force }) =>
  deleteBranch(git, definedFields({ projectPath, branch, force })),
);

ipcMain.handle('git:commit', async (_event, { projectPath, message, paths }) =>
  gitSnapshot.commit(git, definedFields({ projectPath, message, paths })),
);

ipcMain.handle('git:restoreFile', async (_event, { projectPath, ref, path: filePath }) =>
  gitSnapshot.restoreFile(git, { projectPath, ref, path: filePath }),
);

// `park` is handed in rather than imported: it lives here, over the stash, and
// is the reason going back to an old version cannot lose what is on disk now.
ipcMain.handle('git:restoreProject', async (_event, { projectPath, ref }) => {
  const branch = await currentBranch(projectPath);
  return gitSnapshot.restoreProject(git, {
    projectPath,
    ref,
    park: () => parkBranch(projectPath, branch),
  });
});

ipcMain.handle('git:push', async (_event, { projectPath, branch }) => {
  await git(projectPath, ['push', '-u', 'origin', branch], { timeout: 120000 });
  return { ok: true as const };
});

ipcMain.handle('git:publish', async (_event, { projectPath, repoName, isPrivate }) => {
  try {
    await run('gh', ['--version'], projectPath);
  } catch {
    throw new Error(
      'GitHub CLI (gh) is not installed. Install it from https://cli.github.com ' +
        'and run `gh auth login`.',
    );
  }
  const args = [
    'repo',
    'create',
    repoName,
    isPrivate ? '--private' : '--public',
    '--source',
    '.',
    '--remote',
    'origin',
    '--push',
  ];
  const result = await run('gh', args, projectPath, { timeout: 180000 });
  const output = result.stdout + result.stderr;
  // `gh` prints the new repo's URL; fall back to the remote it just set.
  let url = (output.match(/https:\/\/github\.com\/[^\s"']+/) || [])[0] || undefined;
  if (!url) {
    try {
      url = (await git(projectPath, ['remote', 'get-url', 'origin'])).stdout.trim() || undefined;
    } catch {
      /* no remote — caller just won't get a link */
    }
  }
  if (url) {
    url = url.replace(/[.,)]+$/, '').replace(/\.git$/, '');
  }
  return { ok: true as const, url, output };
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (/^https?:\/\//.test(url)) {
    openExternalLink(url);
  }
  return { ok: true as const };
});

function showMessageBox(parent: Window | undefined, options: MessageBoxOptions) {
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}
function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function capture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  assert(value !== undefined, `Missing required regex group ${index}`);
  return value;
}
function readJson(file: string): unknown {
  const input: unknown = JSON.parse(readSource(file));
  return input;
}
function parseDataList(input: unknown): unknown[] {
  const values = toArray(input);
  if (!values) {
    throw new Error('Expected collection array');
  }
  return values;
}

function buildViewMenu(): MenuItemConstructorOptions {
  return isDev
    ? {
        label: 'View',
        submenu: [
          { label: 'Reload All Code', accelerator: 'CmdOrCtrl+R', click: () => relaunchApp() },
          {
            label: 'Reload Window Only',
            accelerator: 'Shift+CmdOrCtrl+R',
            click: () => mainWindow?.webContents.reload(),
          },
          { type: 'separator' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      }
    : { role: 'viewMenu' };
}

function readCmsSource(
  full: string,
  entryRel: string,
  options: { readonly page: boolean },
): CmsFile[] {
  let source: string;
  try {
    if (fs.statSync(full).size > MAIN_LIMITS.cmsFileBytesMax) {
      return [];
    }
    source = readSource(full);
  } catch {
    return [];
  }
  if (options.page) {
    const body = frontmatterOf(source);
    if (!body) {
      return [];
    }
    source = body;
  } else if (!/export\s+const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*\[/.test(source)) {
    return [];
  }
  const scan = options.page ? PAGE_SCAN : undefined;
  const metadata = {
    dir: entryRel,
    abs: full,
    fromFile: true,
    ...(options.page ? { fromPage: true } : {}),
  };
  const general = readGeneral(source, scan);
  const files: CmsFile[] = general
    ? [{ ...metadata, rel: `${entryRel}#${GENERAL}`, name: 'General', data: general }]
    : [];
  for (const collection of findCollections(source, scan)) {
    if (collection.data) {
      files.push({
        ...metadata,
        rel: `${entryRel}#${collection.name}`,
        name: collection.name,
        data: collection.data,
      });
    }
  }
  return files;
}

function readCmsJson(full: string, entryRel: string, rel: string, name: string): CmsFile {
  let file: CmsFile = { rel: entryRel, name, dir: rel, abs: full };
  try {
    const stat = fs.statSync(full);
    file = { ...file, size: stat.size };
    if (stat.size > MAIN_LIMITS.cmsFileBytesMax) {
      return { ...file, error: 'This file is too large to edit here (over 2 MB).' };
    }
    return { ...file, data: parseData(readJson(full)) };
  } catch (error: unknown) {
    return {
      ...file,
      error: `Not valid JSON — ${errorMessage(error).replace(/\s+in JSON.*$/, '')}`,
    };
  }
}

function listAssetTree(
  root: string,
  rel: string,
  options: { readonly mediaOnly: boolean },
): AssetEntry[] {
  const entries: AssetEntry[] = [];
  // Folders are only worth showing when something is in them, which for src/
  // means "holds media somewhere below" — otherwise every component folder in
  // the project would show up as an empty asset folder.
  const checkDirectory = directoryBudget(root);
  const mediaOnly = options.mediaOnly;
  const walk = (directory: string, rel: string, depth: number): boolean => {
    let held = false;
    let names = [];
    try {
      names = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    checkDirectory(directory, names.length);
    assert(depth <= MAIN_LIMITS.directoryDepthMax, 'listAssetTree: the budget bounds depth');
    for (const entry of names) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const full = path.join(directory, entry.name);
      const entryRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        const at = entries.length;
        const placeholder: AssetEntry = {
          rel: entryRel,
          name: entry.name,
          parent: rel,
          isDir: true,
          root: rootOfRel(rel),
        };
        entries.push(placeholder);
        const any = walk(full, entryRel, depth + 1);
        if (any) {
          held = true;
        } else if (mediaOnly) {
          entries.splice(at, 1);
        } // nothing below it — not an asset folder
      } else {
        if (mediaOnly && !MEDIA_EXT.test(entry.name)) {
          continue;
        }
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* race */
        }
        held = true;
        entries.push({
          rel: entryRel,
          name: entry.name,
          parent: rel,
          isDir: false,
          size,
          abs: full,
          root: rootOfRel(rel),
        });
      }
    }
    return held;
  };

  walk(root, rel, 0);
  return entries;
}

async function spawnDevServerFailureDetail(projectPath: string, localBin: string) {
  let log = recentDevLog();
  try {
    const [logCmd, logArgs] = nodeCliCommand(localBin, ['dev', 'logs']);
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) =>
      execFile(
        logCmd,
        logArgs,
        { ...SHORT_COMMAND, cwd: projectPath, shell: commandNeedsShell(logCmd) },
        (error, so) => (error ? reject(error) : resolve({ stdout: so.toString() })),
      ),
    );
    const tail = stdout.trim().split('\n').slice(-12).join('\n');
    if (tail) {
      log += `\n\n— astro dev logs —\n${tail}`;
    }
  } catch {
    /* no daemon logs available */
  }
  return log;
}

async function doDevStartDependencies(projectPath: string, assertActive: () => void) {
  // Without this the failure is the shim's "env: node: No such file or
  // directory", which reads like a broken project rather than a missing tool.
  if (!resolveNodeBin()) {
    throw new Error(
      'Node.js could not be found. Install a current Node.js release, restart Stacki, and ' +
        'try again. Stacki checks standard installers and common version managers.',
    );
  }

  const binName = isWin ? 'astro.cmd' : 'astro';
  const localBin = path.join(projectPath, 'node_modules', '.bin', binName);
  if (!fs.existsSync(localBin)) {
    // Dependencies missing or incomplete — install with the right PM first.
    await installDependencies(projectPath);
    assertActive();
    send('progress', PROGRESS_CLEARED);
    if (!fs.existsSync(localBin)) {
      throw new Error(
        'astro is not installed in this project (no node_modules/.bin/astro after install). ' +
          'Is astro listed in package.json dependencies?',
      );
    }
  }

  return localBin;
}

function webpImageSize(buf: Buffer) {
  // WebP: VP8 (lossy), VP8L (lossless) and VP8X (extended) each differ.
  if (
    buf.length > 30 &&
    buf.toString('binary', 0, 4) === 'RIFF' &&
    buf.toString('binary', 8, 12) === 'WEBP'
  ) {
    const kind = buf.toString('binary', 12, 16);
    if (kind === 'VP8 ') {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { w: width, h: height };
    }
  }
  return undefined;
}

async function readGitIdentity(projectPath: string) {
  const identity: { branch: string; head: string | undefined; userEmail: string | undefined } = {
    branch: '',
    head: undefined,
    userEmail: undefined,
  };
  try {
    identity.branch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    identity.branch = '(no commits yet)';
  }
  try {
    // What HEAD actually points at. The history panel reloads when this moves,
    // which is how a commit made from the chip shows up in the timeline
    // without the panel having to know the chip exists.
    identity.head = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  } catch {
    identity.head = undefined; // no commits yet
  }
  try {
    // Whose commits are "yours". Git records an author on every commit, and on
    // your own machine that is nearly always you — "Timothy Ricks changed the
    // hero" reads oddly about yourself.
    identity.userEmail =
      (await git(projectPath, ['config', 'user.email'])).stdout.trim() || undefined;
  } catch {
    identity.userEmail = undefined;
  }
  return identity;
}

// Keep static generated source outside functions so the assembly stays reviewable.
const MARKER_CONFIG_PARTS = [
  `// Generated by Stacki (dev preview only) — do not edit.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
`,
  `

const require = createRequire(import.meta.url);
// Marking happens in electron/previewMarkers.js, in memory: it reads project
// files and returns strings, and nothing it returns is ever written back.
const { markSourceFile, markChunkFile } = require(`,
  `);
const { componentPreviewPlugin } = require(`,
  `);
const PROJECT_DIRS = `,
  `;

// Nothing this serves is a child of anything. Every marker is a comment —
// invisible to selectors, to layout and to the box model — and the patcher
// arrives through the module graph rather than as a tag in the page. The one
// node that could hold no attribute, a <Fragment slot="…">, carries its markers
// inside itself, where they travel into the slot with its own contents.
//
// The comments stay. They are the one thing on the page that says which node is
// which: the patcher that replaces a full reload matches the server's new
// rendering against the live document through them, and without them it would
// be guessing from tag names. A comment in devtools is a small price for not
// rebuilding an element that was only meant to change its text.
//
// There used to be a script here that removed the <template> markers this
// served. Nothing writes one now, so there is nothing to remove — and one fewer
// tag in a page whose whole point is to be the page.

// Must hook \`load\` (not \`transform\`): Astro's own compiler plugin is also
// enforce:'pre' and runs first, so a transform would receive compiled JS —
// and returning Astro source at that point breaks the module graph.
// Astro renders components on the server, so Vite cannot hot-swap one: any
// edit to a page or a component it uses ends in "reload the document". A
// reload restarts every CSS animation, rewinds every <video>, drops scroll
// position and closes whatever the user had open — which in an editor is the
// state you were looking at when you made the change.
//
// Everything else the dev server does is wanted, including stylesheet updates
// and invalidation, so none of it is touched here. Only the one message that
// throws the page away is caught, and turned into a request to patch the page
// instead. Vite reaches the browser through more than one object and which
// one Astro picks depends on its version, so every distinct channel is
// wrapped; identity dedupes the ones that are really the same object.
// What the <style> blocks of a file said the last time it was looked at.
// Comparing the source rather than the compiled output is deliberate: Astro's
// scope hash comes from the file's path, so identical style blocks compile to
// identical CSS, and reading the file cannot disturb the module graph.
const avbStyleText = new Map();
const avbReadFile = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const avbStyleTextOf = (src) => (src.match(/<style[^>]*>[\\s\\S]*?<\\/style>/gi) || []).join('\\n');
const avbIsStyleModule = (m) => {
  const u = m.url || m.id || '';
  return u.indexOf('type=style') !== -1 || u.indexOf('lang.css') !== -1 || /\\.css($|\\?)/.test(u);
};

const avbMorph = {
  name: 'avb-morph',
  resolveId(id) {
    if (id === 'virtual:avb-morph') return '\0virtual:avb-morph';
    return null;
  },
  load(id) {
    return id === '\0virtual:avb-morph' ? `,
  ` : null;
  },
  // Vite reapplies a page's extracted stylesheet whenever its .astro file
  // changes, whether or not a single character of that CSS is different. The
  // browser treats the rewritten <style> as a new stylesheet, so every
  // animation it defines starts over — once per keystroke while typing into a
  // text field, which is exactly the thing this feature exists to stop. When
  // the style blocks in the file are byte for byte what they were, the
  // stylesheet updates are dropped and only the page patch goes out. A real
  // CSS edit compares differently and takes Vite's own path, untouched.
  handleHotUpdate(ctx) {
    if (!/\\.(astro|md|mdx)$/i.test(ctx.file)) return;
    const before = avbStyleText.get(ctx.file);
    const now = avbStyleTextOf(avbReadFile(ctx.file));
    avbStyleText.set(ctx.file, now);
    if (before === undefined || before !== now) return;
    const rest = ctx.modules.filter((m) => !avbIsStyleModule(m));
    return rest.length === ctx.modules.length ? undefined : rest;
  },
  configureServer(server) {
    const seen = new Set();
    const channels = [server.hot, server.ws];
    for (const env of Object.values(server.environments || {})) channels.push(env && env.hot);
    for (const ch of channels) {
      if (!ch || typeof ch.send !== 'function' || seen.has(ch)) continue;
      seen.add(ch);
      const send = ch.send.bind(ch);
      ch.send = (...args) => {
        const payload = args[0];
        if (payload && payload.type === 'full-reload') {
          return send({ type: 'custom', event: 'avb:page-changed' });
        }
        return send(...args);
      };
    }
  },
};

const AVB_MORPH_TAG = `,
  `;

const avbMarkers = {
  name: 'avb-node-markers',
  enforce: 'pre',
  load(id) {
    const qi = id.indexOf('?');
    const file = qi === -1 ? id : id.slice(0, qi);
    const query = qi === -1 ? '' : id.slice(qi + 1);
    // A <Fragment set:html={x} /> renders from an imported HTML string, so
    // the page's own markers can't reach inside it. serializePageMarked tags
    // the ?raw import with the Fragment's key; mark the chunk here so its
    // nodes outline like any other. Runs before vite:asset's own ?raw load.
    if (query) {
      const m = /(?:^|&)avb=([^&]+)/.exec(query);
      if (!m) return null;
      try {
        const marked = markChunkFile(file, decodeURIComponent(m[1]), {
          group: /(?:^|&)avbg=1(?:&|$)/.test(query),
        });
        return marked == null ? null : 'export default ' + JSON.stringify(marked) + ';';
      } catch {
        return null;
      }
    }
    // Pages mark with bare paths, every other .astro under src with its own
    // namespace, and each marked file carries its stamp — the checksum of the
    // bytes it was marked from, which the canvas's preview token is made of.
    try {
      const marked = markSourceFile(file, PROJECT_DIRS);
      if (!marked) return null;
      // Seeded here so the very first edit already has something to compare
      // against, rather than spending one stylesheet rewrite learning it.
      if (!avbStyleText.has(file)) avbStyleText.set(file, avbStyleTextOf(marked.source));
      // The patcher rides along with a page — Astro hoists it into <head>,
      // so this adds a module to the page and no node to its markup.
      return marked.page ? marked.code + AVB_MORPH_TAG : marked.code;
    } catch {
      return null;
    }
  },
};

// Markdown can't use the load hook above: Astro's own \`astro:markdown\` plugin
// is enforce:'pre', owns load for .md, and reads the file off disk itself — so
// there is nothing to intercept. The document AST is the hook it does hand out,
// and it's the right place anyway.
//
// One marker pair per ROOT node, numbered to match that block's index in the
// app's tree. Frontmatter isn't in the tree so it isn't counted; an MDX import
// is (the app keeps it as a node) but isn't wrapped, because a template in the
// middle of the import block would be rendered content.
const AVB_BLOCK_TYPES = [
  'paragraph', 'heading', 'thematicBreak', 'blockquote', 'list', 'html', 'code',
  'definition', 'footnoteDefinition', 'table', 'math', 'containerDirective',
  'leafDirective', 'mdxJsxFlowElement', 'mdxFlowExpression',
];
const avbSatteriMarkers = () => {
  const plugin = { name: 'avb-node-markers' };
  const visit = (node, ctx) => {
    const parent = ctx.parent(node);
    if (!parent || parent.type !== 'root') return;
    const raw = ctx.indexOf(node);
    if (raw == null) return;
    // Frontmatter is a root child here but not a node in the app's tree, so
    // everything after it would be numbered one too high.
    const children = parent.children || [];
    let offset = 0;
    for (let i = 0; i < raw && i < children.length; i++) {
      if (children[i] && (children[i].type === 'yaml' || children[i].type === 'toml')) offset++;
    }
    const path = String(raw - offset);
    ctx.insertBefore(node, { type: 'html', value: '<!--avb-s:' + path + '-->' });
    ctx.insertAfter(node, { type: 'html', value: '<!--avb-e:' + path + '-->' });
  };
  for (const type of AVB_BLOCK_TYPES) plugin[type] = visit;
  return plugin;
};

// Only when the project is on the processor Astro ships by default, and only
// when it hasn't chosen its own. \`markdown.remarkPlugins\` is NOT a safe
// fallback: on Astro 7 it needs @astrojs/markdown-remark installed, and setting
// it without that fails config validation — the dev server wouldn't start at
// all. A project this can't reach simply gets no markdown outlines; editing
// through the navigator is unaffected.
let avbMarkdownProcessor = null;
try {
  const { satteri } = await import('@astrojs/markdown-satteri');
  avbMarkdownProcessor = satteri({ mdastPlugins: [avbSatteriMarkers] });
} catch {
  /* different Astro, different processor — skip the markers */
}

// Isolated component previews for the palette hover cards.
const avbPreviewRoute = {
  name: 'avb-preview-route',
  hooks: {
    // The app builds canvas URLs from page file paths, and \`trailingSlash\`
    // decides whether this server answers /de/hotel or /de/hotel/. Hand back
    // the resolved value — it has been through Astro's defaults, and it holds
    // however the project arrived at it, literal or not.
    'astro:config:done': ({ config }) => {
      try {
        writeFileSync(
          new URL('./resolved.json', import.meta.url),
          JSON.stringify({ trailingSlash: config.trailingSlash, base: config.base })
        );
      } catch {
        /* the app falls back to reading the config's text */
      }
    },
    // Every route this project will serve, as Astro resolved it — the files
    // under src/pages AND anything an integration injected. A site whose pages
    // come from a package has nothing on disk for the app to find (issue #7),
    // and this list is the only place they exist. Written beside resolved.json
    // rather than served: the app already reads that directory, and a file
    // needs no route of its own to fetch it through.
    'astro:routes:resolved': ({ routes }) => {
      try {
        writeFileSync(
          new URL('./routes.json', import.meta.url),
          JSON.stringify(
            (routes || [])
              .filter((r) => r && r.pattern && !String(r.pattern).startsWith('/__avb'))
              .map((r) => ({
                pattern: r.pattern,
                // 'project' is a file under src/pages, 'external' came from an
                // integration, 'internal' is Astro's own (404, and friends).
                origin: r.origin || null,
                entrypoint: r.entrypoint || null,
                params: r.params || [],
              }))
          )
        );
      } catch {
        /* an Astro without this hook simply never calls it */
      }
    },
    'astro:config:setup': ({ injectRoute }) => {
      injectRoute({ pattern: '/__avb/preview', entrypoint: `,
  ` });
      injectRoute({ pattern: '/__avb/paths', entrypoint: `,
  ` });
      injectRoute({ pattern: '/__avb/data', entrypoint: `,
  ` });
    },
  },
};

const base = userConfig || {};
export default {
  ...base,
  // The floating dev toolbar is viewport-fixed clutter in an editor canvas,
  // and it would sit on top of component thumbnails. Only this app's dev
  // server is affected — the project's own \`astro dev\` is untouched.
  devToolbar: { enabled: false },
  // Astro compresses HTML by default, and the marker <template>s above turn a
  // text node's boundary whitespace into whitespace between elements — which
  // the compressor is free to drop. "Be <Rotator />" then renders as
  // "BeFOUND." on the canvas while the real build keeps the space. Off here
  // so the canvas shows the spacing the source actually has; the project's
  // own dev server and build keep whatever it configured.
  compressHTML: false,
  integrations: [...(base.integrations || []), avbPreviewRoute],
  markdown: {
    ...(base.markdown || {}),
    ...(avbMarkdownProcessor && !(base.markdown && base.markdown.processor)
      ? { processor: avbMarkdownProcessor }
      : {}),
  },
  vite: {
    ...(base.vite || {}),
    plugins: [componentPreviewPlugin(PROJECT_DIRS), avbMarkers, avbMorph,
      ...((base.vite && base.vite.plugins) || [])],
  },
};
`,
] as const;

function renderMarkerConfig(values: readonly string[]): string {
  assert(values.length + 1 === MARKER_CONFIG_PARTS.length, 'Marker template interpolation count');
  const source = MARKER_CONFIG_PARTS.map((part, index) => part + (values[index] ?? '')).join('');
  assert(source.startsWith('// Generated by Stacki'), 'Marker config must retain its header');
  return source;
}

async function readGitParked(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await git(projectPath, ['stash', 'list', '--format=%gs']);
    const tag = /stacki:park:(.+)$/;
    return [
      ...new Set(
        stdout
          .split('\n')
          .map((line) => (line.match(tag) || [])[1])
          .filter((branch): branch is string => branch !== undefined)
          .map((branch) => branch.trim()),
      ),
    ];
  } catch {
    return []; // No stashes, or not a repository yet.
  }
}
