// Goal: a Markdown page's gestures in the app reach disk as edit requests
// (plan §11 step 10), exactly as an .astro page's do: typing a heading's text,
// changing its level, removing a list item and picking a layout each write
// only their own bytes — the layout a new YAML frontmatter block at the top of
// a post without one — and undoing every gesture restores the file byte for
// byte. No whole-model save exists to fall back on.
// Method: the real App in jsdom (test/helpers/appGestures.js): stub panels capture
// their props, the bridge parses the real file with the Markdown parser, and
// each request goes through main's own translation (editRequests.ts,
// markdownEdits.ts) and a real document host. Undo is the ⌘Z the user presses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, nodeAt, select, undo } = require('./helpers/appGestures.js');

const POST = ['# Title', '', 'Some text.', '', '- one', '- two', ''].join('\n');

test('Markdown gestures write only their bytes; undo restores every byte', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-markdown-gestures-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/layouts'), { recursive: true });
  const file = path.join(root, 'src/pages/post.md');
  const layout = path.join(root, 'src/layouts/Post.astro');
  fs.writeFileSync(file, POST);
  fs.writeFileSync(layout, '<slot />\n');
  const scan = {
    pages: [{ name: 'post.md', path: file, route: '/post' }],
    components: [],
    layouts: [{ name: 'Post', path: layout, folder: 'layouts' }],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan }, 'markdown-gestures');
  context.after(app.unmount);
  const disk = () => fs.readFileSync(file, 'utf8');

  // The heading's text, typed: its words only.
  await select(app, [0, 0]);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetText('New title');
  });
  assert.equal(disk(), POST.replace('# Title', '# New title'), 'the text is retyped in place');
  // Its level: one `#` more.
  await select(app, [0]);
  await gesture(app, async () => {
    await __panels.PropsPanel.onChangeTag('h2');
  });
  assert.equal(disk(), POST.replace('# Title', '## New title'), 'the level changes its marker');
  // The second item removed: its line only.
  await gesture(app, async () => {
    __panels.StructurePanel.onRemoveNode(nodeAt([2, 1]).id);
  });
  const trimmed = POST.replace('# Title', '## New title').replace('- two\n', '');
  assert.equal(disk(), trimmed, 'the item and its line break go');
  // A layout picked for a post without frontmatter: a new block at its top.
  await gesture(app, async () => {
    await __panels.StructurePanel.onChangeLayout('Post');
  });
  assert.equal(disk(), `---\nlayout: ../layouts/Post.astro\n---\n${trimmed}`, 'a new block');
  assert.ok(app.calls.edits.length >= 4, 'every gesture went out as edit requests');
  // Undo every gesture, newest first: the file comes back byte for byte.
  for (let step = 0; step < 4; step++) {
    await undo(app);
  }
  assert.equal(disk(), POST, 'undo restores every byte');
});
