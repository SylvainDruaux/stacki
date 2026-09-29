const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createSerialQueue } = require('../dist/electron/serialQueue');
const { watchProject } = require('../dist/electron/projectWatcher');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function contentHarness(t) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-content-lifecycle-'));
  const config = path.join(projectPath, 'src', 'content.config.ts');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, 'export const collections = {};');
  const builds = [];
  const children = [];
  const timers = new Set();
  const sentinel = '<<<stacki:content-config>>>';
  const mocks = {
    module: { createRequire: () => () => ({
      build: () => {
        const build = deferred();
        builds.push(build);
        return build.promise.then(() => ({ metafile: { inputs: { 'src/content.config.ts': {} } } }));
      },
    }) },
    child_process: { spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.requests = [];
      child.stdin.write = (message, callback) => {
        child.requests.push(JSON.parse(message));
        callback?.();
      };
      child.kill = () => { child.killed = true; };
      child.reply = (value) => child.stdout.emit('data', sentinel + JSON.stringify(value) + '\n');
      children.push(child);
      return child;
    } },
  };
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'electron', 'contentConfig.js'),
    'utf8',
  );
  const runtimeRequire = createRequire(path.join(__dirname, '../dist/electron/main.js'));
  const mod = { exports: {} };
  const fn = vm.runInNewContext('(function(require, module, __dirname, exports) {' + source + '\n})', {
    process,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  });
  fn(
    (name) => mocks[name] || runtimeRequire(name),
    mod,
    path.join(__dirname, '..', 'dist', 'electron'),
    mod.exports,
  );
  t.after(() => {
    mod.exports.stopAllServices();
    assert.equal(timers.size, 0, 'stopping releases every timeout');
    fs.rmSync(projectPath, { recursive: true, force: true });
  });
  return {
    ...mod.exports, projectPath, config, builds, children, timers,
    async start() {
      const read = mod.exports.readContentConfig(projectPath);
      builds.at(-1).resolve();
      await tick();
      children.at(-1).reply({ type: 'manifest', value: { collections: [{ name: 'posts' }] } });
      return read;
    },
  };
}

test('content readers share a pending build and wait for the completed manifest', async (t) => {
  const h = contentHarness(t);
  const first = h.readContentConfig(h.projectPath);
  const second = h.readContentConfig(h.projectPath);
  assert.equal(h.builds.length, 1);
  h.builds[0].resolve();
  await tick();
  let resolved = false;
  const third = h.readContentConfig(h.projectPath).then((result) => { resolved = true; return result; });
  await tick();
  assert.equal(resolved, false, 'a spawned worker has not necessarily loaded its schema');
  h.children[0].reply({ type: 'manifest', value: { collections: [{ name: 'posts' }] } });
  const results = await Promise.all([first, second, third]);
  assert.equal(h.children.length, 1);
  for (const result of results) {assert.equal(result.collections[0].name, 'posts');}
});

test('an old content worker exiting cannot terminate its replacement', async (t) => {
  const h = contentHarness(t);
  await h.start();
  const oldChild = h.children[0];
  const next = h.readContentConfig(h.projectPath, { force: true });
  await tick();
  h.builds[1].resolve();
  await tick();
  const replacement = h.children[1];
  replacement.reply({ type: 'manifest', value: { collections: [{ name: 'new' }] } });
  await next;
  oldChild.emit('exit', 0);
  assert.equal(replacement.killed, undefined);
  assert.equal((await h.readContentConfig(h.projectPath)).collections[0].name, 'new');
  assert.equal(h.builds.length, 2);
});

test('closing a project during a content build prevents a late worker spawn', async (t) => {
  const h = contentHarness(t);
  const reading = h.readContentConfig(h.projectPath);
  h.stopAllServices();
  h.builds[0].resolve();
  const result = await reading;
  assert.match(result.error, /reloaded/);
  assert.equal(h.children.length, 0);
});

test('forcing a content reload waits for the old build before rewriting its bundle', async (t) => {
  const h = contentHarness(t);
  const first = h.readContentConfig(h.projectPath);
  const second = h.readContentConfig(h.projectPath, { force: true });
  assert.equal(h.builds.length, 1);
  h.builds[0].resolve();
  await tick();
  assert.match((await first).error, /reloaded/);
  assert.equal(h.builds.length, 2);
  assert.equal(h.children.length, 0);
  h.builds[1].resolve();
  await tick();
  h.children[0].reply({ type: 'manifest', value: { collections: [] } });
  assert.equal((await second).error, undefined);
});

test('validation clears completed requests and rejects pending requests when a worker exits', async (t) => {
  const h = contentHarness(t);
  await h.start();
  const child = h.children[0];
  const validation = h.validateEntry(h.projectPath, { collection: 'posts', data: {} });
  await tick();
  assert.equal(h.timers.size, 2, 'idle and current request timeouts only');
  child.reply({ type: 'reply', id: child.requests[0].id, value: { issues: [] } });
  assert.equal((await validation).issues.length, 0);
  assert.equal(h.timers.size, 1, 'the completed request timeout was cleared');
  const pending = h.validateEntry(h.projectPath, { collection: 'posts', data: {} });
  await tick();
  child.stderr.emit('data', 'invalid worker state');
  child.emit('exit', 1);
  assert.match((await pending).error, /invalid worker state/);
  assert.equal(h.timers.size, 0);
});

test('removing a content config closes its cached worker', async (t) => {
  const h = contentHarness(t);
  await h.start();
  fs.unlinkSync(h.config);
  assert.equal((await h.readContentConfig(h.projectPath)).missing, true);
  assert.equal(h.children[0].killed, true);
});

test('the serial queue never starts waiting captures together and continues after rejection', async () => {
  const queue = createSerialQueue();
  const release = deferred();
  const started = [];
  const first = queue(async () => { started.push(1); await release.promise; throw new Error('failed capture'); });
  const rejected = assert.rejects(first, /failed capture/);
  const second = queue(async () => { started.push(2); await tick(); started.push('done 2'); return 2; });
  const third = queue(() => { started.push(3); return 3; });
  await tick();
  assert.deepEqual(started, [1]);
  release.resolve();
  await rejected;
  assert.deepEqual(await Promise.all([second, third]), [2, 3]);
  assert.deepEqual(started, [1, 2, 'done 2', 3]);
});

test('project watchers route batched edits once and cancel all pending events on close', async (t) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-watch-lifecycle-'));
  fs.mkdirSync(path.join(projectPath, 'public'));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  const handlers = new Map();
  const closed = [];
  const events = [];
  const checks = [];
  const pokes = [];
  const hints = [];
  const watcher = watchProject({
    projectPath,
    watch: (dir, _options, handler) => { handlers.set(path.basename(dir), handler); return { close: () => closed.push(dir) }; },
    send: (channel, payload) => events.push({ channel, payload }),
    isSelfWrite: (file) => { checks.push(file); return file.endsWith('ours.astro'); },
    noteExternalChange: (file) => hints.push(path.basename(file)),
    notePageMayHaveChanged: (external) => pokes.push(external),
    scheduleThumb: () => {},
    mediaPattern: /\.png$/,
  });
  const emit = (name, root = 'src') => handlers.get(root)('change', name);
  for (const name of ['page.astro', 'page.astro', 'ours.astro', 'info.json', 'hero.png', 'style.css', 'code.ts']) {emit(name);}
  await sleep(250);
  assert.equal(checks.length, 7, 'each event reads its self-write contents at most once');
  assert.equal(pokes.length, 6, 'every external source type nudges preview recovery');
  // The document actors hear every outside change as a hint to re-read (plan §7);
  // the app's own write is not one.
  assert.deepEqual(hints, ['page.astro', 'page.astro', 'info.json', 'hero.png', 'style.css', 'code.ts']);
  assert.equal(events.length, 4);
  assert.deepEqual(events.find((event) => event.channel === 'fs:changed').payload.files, [path.join(projectPath, 'src', 'page.astro')]);
  for (const name of ['next.astro', 'next.json', 'next.png', 'next.css']) {emit(name);}
  emit('public.png', 'public');
  watcher.close();
  emit('late.astro');
  emit('late.png', 'public');
  await sleep(250);
  assert.equal(events.length, 4, 'the next project receives no old notifications');
  assert.equal(closed.length, 2, 'both watched directories close together');
});

test('dev starts share a result only for the same project and serialize different projects', async () => {
  const { createKeyedQueue } = require('../dist/electron/serialQueue');
  const queue = createKeyedQueue();
  const release = deferred();
  const started = [];
  const first = queue.run('one', async () => { started.push('one'); await release.promise; return 'one-url'; });
  const duplicate = queue.run('one', () => { throw new Error('duplicate start'); });
  const next = queue.run('two', () => { started.push('two'); return 'two-url'; });
  assert.equal(first, duplicate);
  await tick();
  assert.deepEqual(started, ['one']);
  release.resolve();
  assert.deepEqual(await Promise.all([first, duplicate, next]), ['one-url', 'one-url', 'two-url']);
  assert.deepEqual(started, ['one', 'two']);
});

test('closing a project cancels active and queued starts without poisoning the next start', async () => {
  const { createKeyedQueue } = require('../dist/electron/serialQueue');
  const queue = createKeyedQueue();
  const release = deferred();
  const active = queue.run('one', async (assertActive) => { await release.promise; assertActive(); });
  const waiting = queue.run('two', () => { throw new Error('must not start'); });
  const rejected = [assert.rejects(active, /cancelled/), assert.rejects(waiting, /cancelled/)];
  await tick();
  queue.cancel();
  const reopened = queue.run('one', () => 'new-url');
  release.resolve();
  await Promise.all(rejected);
  assert.equal(await reopened, 'new-url');
});

function loadThumbs(BrowserWindow) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'electron', 'thumbs.js'),
    'utf8',
  );
  const runtimeRequire = createRequire(path.join(__dirname, '../dist/electron/main.js'));
  const mod = { exports: {} };
  vm.runInNewContext('(function(require, module, exports) {' + source + '\n})', {
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 5)),
    clearTimeout,
  })((name) => name === 'electron' ? { BrowserWindow } : runtimeRequire(name), mod, mod.exports);
  return mod.exports;
}

function thumbFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-thumb-lifecycle-'));
  const project = path.join(root, 'project');
  const userData = path.join(root, 'user');
  const source = path.join(project, 'src', 'index.astro');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '<h1>Before</h1>');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project, userData, source };
}

test('thumbnail fingerprints notice edits hidden by a newer file and path-only renames', (t) => {
  const h = thumbFixture(t);
  const thumbs = loadThumbs();
  const newest = path.join(h.project, 'src', 'newest.astro');
  fs.writeFileSync(newest, '<h1>Future</h1>');
  const future = new Date('2099-01-01');
  fs.utimesSync(newest, future, future);
  const before = thumbs.fingerprint(h.project);
  fs.writeFileSync(h.source, '<h1>Changed</h1>');
  const changed = thumbs.fingerprint(h.project);
  assert.notEqual(changed, before);
  fs.renameSync(h.source, path.join(h.project, 'src', 'renamed.astro'));
  assert.notEqual(thumbs.fingerprint(h.project), changed);
});

test('a stalled thumbnail navigation times out and destroys its window', async (t) => {
  const h = thumbFixture(t);
  let destroyed = false;
  const thumbs = loadThumbs(class {
    loadURL() { return new Promise(() => {}); }
    isDestroyed() { return destroyed; }
    destroy() { destroyed = true; }
  });
  const result = await thumbs.capture(h.userData, h.project, 'http://example.invalid');
  assert.equal(result.ok, false);
  assert.match(result.error, /did not finish loading/);
  assert.equal(destroyed, true);
});

test('an edit during thumbnail rendering remains stale and a missing image is regenerated', async (t) => {
  const h = thumbFixture(t);
  const thumbs = loadThumbs(class {
    constructor() {
      this.webContents = {
        executeJavaScript: async () => {},
        capturePage: async () => {
          fs.writeFileSync(h.source, '<h1>Edited while rendering</h1>');
          return { isEmpty: () => false, resize: () => ({ toPNG: () => Buffer.from('image') }) };
        },
      };
    }
    async loadURL() {}
    isDestroyed() { return false; }
    destroy() {}
  });
  assert.equal((await thumbs.capture(h.userData, h.project, 'http://example.invalid')).ok, true);
  assert.equal(thumbs.isStale(h.userData, h.project), true);
  const file = thumbs.thumbPathFor(h.userData, h.project);
  fs.writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify({ fingerprint: thumbs.fingerprint(h.project) }));
  assert.equal(thumbs.isStale(h.userData, h.project), false);
  fs.unlinkSync(file);
  assert.equal(thumbs.isStale(h.userData, h.project), true);
});


test('legacy schema conversion resolves Astro private dependencies without root hoisting', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-schema-resolution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modules = path.join(root, 'project', 'node_modules');
  const storeModules = path.join(root, 'store', 'astro-version', 'node_modules');
  const astro = path.join(storeModules, 'astro');
  const converter = path.join(storeModules, 'zod-to-json-schema');
  const staging = path.join(modules, '.stacki');
  for (const dir of [astro, converter, staging]) {fs.mkdirSync(dir, { recursive: true });}
  fs.writeFileSync(path.join(astro, 'package.json'), JSON.stringify({
    name: 'astro', type: 'module', exports: { './package.json': './package.json', './zod': './zod.mjs' },
  }));
  fs.writeFileSync(path.join(astro, 'zod.mjs'), 'export const z = {};');
  fs.writeFileSync(path.join(converter, 'package.json'), JSON.stringify({ name: 'zod-to-json-schema', main: 'index.cjs' }));
  fs.writeFileSync(path.join(converter, 'index.cjs'),
    "exports.zodToJsonSchema = (schema, options) => ({ source: schema.source, strategy: options.effectStrategy });");
  fs.symlinkSync(astro, path.join(modules, 'astro'), process.platform === 'win32' ? 'junction' : 'dir');
  const staged = path.join(staging, 'schemaTools.mjs');
  fs.copyFileSync(
    path.join(__dirname, '..', 'dist', 'electron', 'content', 'schemaTools.mjs'),
    staged,
  );
  assert.equal(fs.existsSync(path.join(modules, 'zod-to-json-schema')), false);
  const { toJsonSchema } = await import(require('node:url').pathToFileURL(staged).href);
  assert.deepEqual(toJsonSchema({ source: 'private Astro dependency' }), {
    source: 'private Astro dependency', strategy: 'input',
  });
});
