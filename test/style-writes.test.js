// Goal: the style panel's writes into a page's own <style> block reach disk,
// and a committed edit never reports a refusal after it succeeded. Two defects
// made nearly every such edit show "That edit can't be made visually": the
// projection classed a <style> as opaque code, so the planner refused every
// rewrite of it; and the panel's commit restates the CSS its live writes
// already put in the model, a request that changes nothing, which the planner
// refuses too.
// Method: the real App in jsdom with stub panels (test/helpers/appGestures.js), over
// a bridge whose edits go through main's own translation and a real document
// host. The style panel's callback is driven exactly as the panel drives it:
// live writes while a value is typed, then the commit of the same CSS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, nodeAt, select } = require('./helpers/appGestures.js');

const PAGE = [
  '<h1 class="hero">Hi</h1>',
  '<style>',
  '  .hero {',
  '    font-size: 48px;',
  '  }',
  '</style>',
  '',
].join('\n');

const refusals = () =>
  [...document.querySelectorAll('.toast')]
    .map((toast) => toast.textContent ?? '')
    .filter((text) => text.includes('can’t be made visually'));

const TITLE = "the style panel's writes to a page's <style> land; a commit reports none refused";

test(TITLE, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-style-writes-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const file = path.join(root, 'src', 'pages', 'index.astro');
  fs.writeFileSync(file, PAGE);
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [],
    layouts: [],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan }, 'style-writes');
  context.after(app.unmount);
  await select(app, [0]);
  const style = nodeAt([1]);
  assert.equal(style.kind, 'raw');
  assert.equal(style.name, 'style');
  const write = (css, immediate) => __panels.StylePanel.onWriteStyleNode(style.id, css, immediate);
  const typed = style.inner.replace('48px', '30px');

  // Typing: live writes as the value changes, then Enter commits the value.
  await gesture(app, async () => {
    assert.notEqual(write(style.inner.replace('48px', '3px'), false), false);
    assert.notEqual(write(typed, false), false);
  });
  await gesture(app, async () => {
    assert.notEqual(write(typed, true), false, 'the commit names a node of the open file');
  });
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE.replace('48px', '30px'), 'the rule changed');
  assert.deepEqual(refusals(), [], 'no refusal is reported for an edit that applied');

  // Re-entering the value the rule already has changes nothing and says nothing.
  await gesture(app, async () => {
    write(typed, true);
  });
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE.replace('48px', '30px'));
  assert.deepEqual(refusals(), [], 'a value left as it was is not a refused edit');
});
