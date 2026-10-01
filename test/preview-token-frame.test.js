// Goal: the canvas frame announces the token the app and main compute (plan §9,
// step 7). The sandboxed preload cannot require shared/preview-token.ts, so it
// carries its own copy of the manifest rules; this pins the copy to the
// original: the same stamps — wherever the page put them, before <html>, in
// <head>, in the body, once per rendered copy — give the same token, and every
// located event carries it. A page whose stamps cannot form one manifest (one
// file stamped with two checksums) announces no token, so its events are
// refused rather than vouched for.
// Method: run the real built preload in jsdom as a canvas frame, with the
// parent's postMessage captured; compare its `avb:render` announcement with
// shared/preview-token.ts's manifestOf + canonicalManifest + SHA-256.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { repoPath } = require('./helpers/sources.js');
const {
  canonicalManifest,
  manifestOf,
  stampComment,
  parsePreviewRender,
} = require('#dist/shared/preview-token.js');

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const FIRST_CHECKSUM = 'a'.repeat(64);
const SECOND_CHECKSUM = 'b'.repeat(64);
const page = { file: 'src/pages/index.astro', checksum: FIRST_CHECKSUM };
const card = { file: 'src/components/Card.astro', checksum: SECOND_CHECKSUM };
const head = { file: 'src/components/Seo.astro', checksum: FIRST_CHECKSUM };

async function frame(html) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:4321/#avb-design',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // `jsdom` lays nothing out; the frame measures, so every box is a fixed one.
  const BOX = { x: 0, y: 0, width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
  window.Element.prototype.getBoundingClientRect = () => BOX;
  window.Range.prototype.getBoundingClientRect = () => BOX;
  window.Range.prototype.getClientRects = () => [BOX];
  const sent = [];
  const globals = {
    window,
    document: window.document,
    location: window.location,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    Element: window.Element,
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
  // Node has its own getter-only `navigator`; the frame's globals replace it.
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  window.parent = { postMessage: (message) => sent.push(message) };
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} },
    webUtils: {},
  };
  const realRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    return id === 'electron' ? electron : realRequire.apply(this, arguments);
  };
  process.isMainFrame = false;
  const entry = repoPath('dist/electron/preload.js');
  delete require.cache[entry];
  try {
    require(entry);
  } finally {
    Module.prototype.require = realRequire;
  }
  await settle();
  // The app turns the frame into a canvas by tracking paths in it; only then
  // does a click select instead of following a link.
  const track = new window.MessageEvent('message', {
    data: { type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 },
  });
  Object.defineProperty(track, 'source', { value: window.parent });
  window.dispatchEvent(track);
  await settle();
  return { window, sent };
}

function expectedToken(stamps) {
  const manifest = manifestOf(stamps);
  assert.ok(manifest.ok);
  return createHash('sha256').update(canonicalManifest(manifest.value)).digest('hex');
}

test('the frame announces the token shared computes; events carry it', async () => {
  const { window, sent } = await frame(
    `${stampComment(page)}<!doctype html><html><head>${stampComment(head)}</head><body>
      <!--avb-s:0--><section id="s">${stampComment(card)}<p>One</p></section><!--avb-e:0-->
      <!--avb-s:1--><section>${stampComment(card)}<p>Two</p></section><!--avb-e:1-->
      <!-- a comment of the page's own -->
    </body></html>`,
  );
  const renders = sent.filter((message) => message.type === 'avb:render');
  assert.equal(renders.length, 1, 'one rendering, announced once');
  const [announced] = renders;
  assert.equal(announced.token, expectedToken([page, head, card, card]));
  // What the frame sends is what the renderer's boundary accepts.
  assert.deepEqual(parsePreviewRender(announced), {
    token: announced.token,
    stamps: [card, head, page],
  });
  window.document
    .querySelector('p')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const click = sent.find((message) => message.type === 'avb:click-node');
  assert.ok(click, 'the click is reported');
  assert.equal(click.token, announced.token, 'the click names the rendering it landed on');
});

test('a patched page announces again; a forged second version, never', async () => {
  const { window, sent } = await frame(
    '<!doctype html><html><body><!--avb-s:0--><p>x</p><!--avb-e:0-->' +
      `${stampComment(page)}</body></html>`,
  );
  const first = sent.filter((message) => message.type === 'avb:render');
  assert.equal(first.length, 1);
  // The patcher gathers the new rendering's stamps at the document's end and
  // says so; the frame reads them again.
  for (const comment of [...window.document.body.childNodes].filter(
    (node) => node.nodeType === 8,
  )) {
    if (comment.data.startsWith('avb-d:')) {
      comment.remove();
    }
  }
  window.document.appendChild(
    window.document.createComment(
      stampComment({ ...page, checksum: SECOND_CHECKSUM }).slice(4, -3),
    ),
  );
  window.document.dispatchEvent(new window.CustomEvent('avb:morphed'));
  await settle();
  const second = sent.filter((message) => message.type === 'avb:render');
  assert.equal(second.length, 2, 'the patched rendering is announced');
  assert.equal(second[1].token, expectedToken([{ ...page, checksum: SECOND_CHECKSUM }]));
  assert.notEqual(second[1].token, second[0].token);
  // Page code adds a stamp for the same file with other bytes: no manifest can
  // name that rendering, so the frame announces nothing and its events carry
  // no token.
  window.document.body.appendChild(window.document.createComment(stampComment(page).slice(4, -3)));
  window.document.dispatchEvent(new window.CustomEvent('avb:morphed'));
  await settle();
  assert.equal(sent.filter((message) => message.type === 'avb:render').length, 2);
  window.document
    .querySelector('p')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const clicks = sent.filter((message) => message.type === 'avb:click-node');
  const lastClick = clicks.at(-1);
  assert.ok(lastClick !== undefined, 'the click is still reported');
  // The key is sent, and it names no rendering: absent, as the protocol spells it.
  assert.ok('token' in lastClick, 'the click states its token');
  assert.ok(lastClick.token === undefined, 'a rendering with no token vouches for no click');
});
