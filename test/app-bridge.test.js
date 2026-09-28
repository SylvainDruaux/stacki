// Goal: App's renderer boundary validates the lifecycle, write, and event
// values it receives from preload before the root component can use them.
//
// Methodology: bundle the real TypeScript bridge, drive representative valid
// operations through a preload stub, then corrupt one field in each shape and
// pin the boundary failure. The calls also prove payloads reach preload intact.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('./renderer-module');

const bridgeModule = loadRenderer('appBridge.ts');

test('App bridge preserves validated lifecycle and write operations', async () => {
  const calls = [];
  global.window = {
    avb: {
      settings: async () => ({ sound: true }),
      startDevServer: async (payload) => {
        calls.push(['start', payload]);
        return { url: 'http://localhost:4321' };
      },
      openProjectDialog: async () => null,
      copySelection: async (payload) => {
        calls.push(['copy', payload]);
        return { ok: true, count: 2 };
      },
      writeSourceText: async (payload) => {
        calls.push(['source', payload]);
        return { ok: true };
      },
      writeAssetText: async (payload) => {
        calls.push(['asset', payload]);
        return { ok: true };
      },
    },
  };

  assert.deepEqual(await bridgeModule.readAppSettings(), { sound: true });
  assert.deepEqual(await bridgeModule.startProjectPreview('/project'), {
    trailingSlash: '',
    url: 'http://localhost:4321',
  });
  assert.deepEqual(await bridgeModule.openProject(), { canceled: true });
  assert.equal(await bridgeModule.copyEditorSelection('/project', ['page|n1']), true);
  await bridgeModule.writeProjectFile('src', '/project', 'src/data.ts', 'export {};');
  await bridgeModule.writeProjectFile('public', '/project', 'data.txt', 'value');

  assert.deepEqual(calls, [
    ['start', '/project'],
    ['copy', { projectPath: '/project', keys: ['page|n1'] }],
    ['source', { projectPath: '/project', rel: 'src/data.ts', text: 'export {};' }],
    ['asset', { projectPath: '/project', rel: 'data.txt', text: 'value' }],
  ]);
});

test('App bridge rejects malformed replies and event values', async () => {
  let pageCallback;
  let soundCallback;
  global.window = {
    avb: {
      settings: async () => ({ sound: 'yes' }),
      dynamicPaths: async () => ({
        entries: [{ params: {}, props: false, route: '/bad', label: 'Bad' }],
      }),
      writePageRaw: async () => ({ ok: false }),
      onPageMaybeChanged: (callback) => {
        pageCallback = callback;
        return () => {};
      },
      onMenu: (_channel, callback) => {
        soundCallback = callback;
        return () => {};
      },
    },
  };

  await assert.rejects(bridgeModule.readAppSettings(), /Expected boolean/);
  await assert.rejects(
    bridgeModule.readDynamicPaths('/project', '/project/src/pages/[id].astro', ''),
    /Dynamic route props have an invalid value/,
  );
  await assert.rejects(
    bridgeModule.writeProjectPageRaw('/project/src/pages/index.astro', 'Hello', 'a'.repeat(64)),
    /PageWriteError: expected object/,
  );
  // A malformed base checksum is caught before anything crosses to main.
  assert.throws(
    () =>
      bridgeModule.writeProjectPageRaw('/project/src/pages/index.astro', 'Hello', 'A'.repeat(64)),
    /Digest: expected 64 lowercase hex characters/,
  );

  let external = false;
  bridgeModule.onPageMaybeChanged((event) => {
    external = event.external;
  });
  pageCallback({ external: true });
  assert.equal(external, true);

  bridgeModule.onSoundSettingChanged(() => {});
  assert.throws(() => soundCallback('yes'), /Expected boolean/);
});
