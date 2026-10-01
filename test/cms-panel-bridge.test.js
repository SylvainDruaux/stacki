// Goal: CmsPanel receives bounded file and content inventories from preload.
// Methodology: parse valid and malformed replies, then script each operation to
// distinguish expected transport failures from contract violations.
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('./renderer-module')('src/cmsPanelBridge.ts');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');

const file = {
  rel: 'data/posts.json',
  name: 'posts.json',
  dir: 'data',
  data: [{ title: 'Hello' }],
};
const content = {
  collections: [
    {
      name: 'posts',
      editable: true,
      loader: { kind: 'glob', base: 'src/content/posts' },
      hasSchema: true,
      freeform: false,
      error: undefined,
      count: 1,
    },
  ],
  covered: { files: [], dirs: ['src/content/posts'] },
  configPath: 'src/content.config.ts',
};

test('CMS panel parsers preserve the fields used by the panel', () => {
  assert.deepEqual(bridge.parseCmsFiles({ files: [file] }), [file]);
  assert.deepEqual(bridge.parseContentCollections(content), {
    collections: [
      {
        name: 'posts',
        editable: true,
        loader: { kind: 'glob', base: 'src/content/posts' },
        error: undefined,
        count: 1,
      },
    ],
    covered: content.covered,
    configPath: content.configPath,
  });
  assert.deepEqual(bridge.parseContentCollections({ collections: [], missing: true }), {
    collections: [],
    covered: { files: [], dirs: [] },
  });
});

test('CMS panel parsers reject malformed paths, counts, data, and bounds', () => {
  for (const value of [
    jsonNull,
    { files: jsonNull },
    { files: [{ ...file, rel: 'bad\0path' }] },
    { files: [{ ...file, data: Number.NaN }] },
    { files: Array(100_001).fill(file) },
  ]) {
    assert.throws(() => bridge.parseCmsFiles(value));
  }
  for (const value of [
    { ...content, collections: [{ ...content.collections[0], count: -1 }] },
    // Absence is `undefined` (AGENTS.md §6): main never sends a null error.
    { ...content, collections: [{ ...content.collections[0], error: jsonNull }] },
    { ...content, covered: { files: jsonNull, dirs: [] } },
    { collections: [{ ...content.collections[0] }] },
    { collections: [], missing: false },
    { ...content, collections: Array(100_001).fill(content.collections[0]) },
  ]) {
    assert.throws(() => bridge.parseContentCollections(value));
  }
});

test('CMS panel operations validate payloads and keep transport failures as values', async () => {
  const calls = [];
  global.window = {
    avb: {
      listCms: async (payload) => {
        calls.push(['list', payload]);
        return { files: [file] };
      },
      contentCollections: async (payload) => {
        calls.push(['content', payload]);
        return content;
      },
      createCms: async (payload) => {
        calls.push(['create', payload]);
        return { rel: 'data/news.json' };
      },
    },
  };
  assert.equal((await bridge.readCmsFiles('/project')).ok, true);
  assert.equal((await bridge.readContentCollections('/project')).ok, true);
  assert.deepEqual(await bridge.createCmsCollection('/project', 'News'), {
    ok: true,
    value: { rel: 'data/news.json' },
  });
  assert.deepEqual(calls, [
    ['list', '/project'],
    ['content', '/project'],
    ['create', { projectPath: '/project', name: 'News' }],
  ]);

  global.window.avb.listCms = async () => {
    throw new Error('disk offline');
  };
  assert.deepEqual(await bridge.readCmsFiles('/project'), {
    ok: false,
    error: 'disk offline',
  });
  global.window.avb.listCms = async () => ({ files: [{ ...file, rel: 'bad\0path' }] });
  await assert.rejects(() => bridge.readCmsFiles('/project'));
});
