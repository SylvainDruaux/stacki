// Goal: the visual edit contract (plan §11 step 6) holds end to end. A request
// states a gesture against the checksum of the page the renderer shows; main
// checks its node references against its own projection, plans the intent,
// and writes splices — every byte outside them untouched. An edit authored
// before the app's own previous edit is rebased exactly (the host's commit
// log), one authored before an outside write is mapped through the diff (the
// retained snapshot), and one whose bytes are gone or that names a node the
// page does not have is refused with the disk untouched. The reply's inverse,
// sent back as a revert, is Undo: it restores the bytes, and after an outside
// edit it maps or is refused — it never reverts that edit.
// Method: the wire parsers get known-good and known-bad shapes; the real
// main-process handlers run in the windowless harness on temporary files, with
// outside edits made directly on disk between requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from './main-harness.ts';
import { parseEditRequest, type Edit, type NodeRef } from '../../dist/shared/edit-request.js';
import {
  parsePageDiskRead,
  parsePageEditResult,
  type PageDiskRead,
} from '../../dist/shared/page-save.js';
import { parsePageNode, type PageNode } from '../../dist/shared/page-node.js';
import { toUtf16Span } from '../../dist/shared/span.js';

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const DIGEST = 'a'.repeat(64);
// A node a gesture created: the renderer's own handle (shared/brand.ts).
const GESTURE_ID = `g${'1'.repeat(32)}`;
const REF = { path: [0], kind: 'element', span: { start: 0, end: 4 } };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-edit-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(path.join(root, 'user'));
  return {
    root,
    ...harness,
    dispose: () => {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Harness = ReturnType<typeof fixture>;

type PageEdited = Extract<ReturnType<typeof parsePageEditResult>, { ok: true }>['value'];
type PageEditInverse = PageEdited['inverse'];

/** The node at `at` in the renderer's parse. */
function nodeAt(read: PageDiskRead, at: readonly number[]): PageNode {
  assert.ok(read.editable, 'the page parses');
  let list: readonly PageNode[] = read.model.nodes;
  let node: PageNode | undefined;
  for (const step of at) {
    node = list[step];
    assert.ok(node !== undefined, `a node at ${at.join('/')}`);
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  assert.ok(node !== undefined, 'the path names a node');
  return node;
}

/** The reference the renderer sends for the node at `at` in its parse. */
function refAt(read: PageDiskRead, at: readonly number[]): NodeRef {
  assert.ok(read.editable, 'the page parses');
  let list: readonly PageNode[] = read.model.nodes;
  let node: PageNode | undefined;
  for (const step of at) {
    node = list[step];
    assert.ok(node !== undefined, `a node at ${at.join('/')}`);
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  assert.ok(node?.start !== undefined && node.end !== undefined, 'the parse carries source ranges');
  return { path: at, kind: node.kind, span: { start: node.start, end: node.end } };
}

async function read(harness: Harness, file: string): Promise<PageDiskRead> {
  return parsePageDiskRead(await harness.invoke('page:read', file));
}

async function edit(harness: Harness, file: string, authoredChecksum: string, request: Edit) {
  return parsePageEditResult(
    await harness.invoke('page:edit', { pagePath: file, authoredChecksum, edit: request }),
  );
}

const title = (target: NodeRef, value: string): Edit => ({
  tag: 'set-attribute',
  target,
  name: 'title',
  value: { type: 'string', value },
});

// --- Wire ---------------------------------------------------------------------------

test('parseEditRequest takes every edit and refuses each malformed shape', () => {
  const good: readonly unknown[] = [
    { tag: 'set-attribute', target: REF, name: 'title', value: { type: 'string', value: 'x' } },
    { tag: 'set-attribute', target: REF, name: 'disabled', value: { type: 'bare' } },
    { tag: 'remove-attribute', target: REF, name: 'title' },
    { tag: 'set-inline-style', target: REF, property: 'color', declaration: { tag: 'remove' } },
    { tag: 'insert-node', target: REF, placement: 'after', content: { tag: 'copy', source: REF } },
    {
      tag: 'insert-node',
      target: REF,
      placement: 'first-child',
      content: { tag: 'nodes', nodes: [{ id: GESTURE_ID, kind: 'text', value: 'Hi' }] },
    },
    { tag: 'remove-node', target: REF },
    { tag: 'move-node', target: REF, destination: REF, placement: 'before' },
    { tag: 'rename-binding', target: { ...REF, kind: 'map' }, from: 'item', to: 'entry' },
    { tag: 'revert', hunks: [{ span: { start: 1, end: 2 }, text: 'x' }] },
    { tag: 'rename-tag', target: REF, to: 'Icons.Arrow' },
    { tag: 'rename-attribute', target: REF, from: 'title', to: 'aria-label' },
    { tag: 'replace-node', target: REF, node: { id: GESTURE_ID, kind: 'text', value: 'Hi' } },
    { tag: 'append-body', nodes: [{ id: GESTURE_ID, kind: 'text', value: 'Hi' }] },
  ];
  for (const request of good) {
    assert.doesNotThrow(() =>
      parseEditRequest({ pagePath: '/p.astro', authoredChecksum: DIGEST, edit: request }),
    );
  }
  const bad: readonly (readonly [unknown, RegExp])[] = [
    [{ tag: 'paint' }, /unknown edit/],
    [{ tag: 'remove-node', target: { ...REF, path: [] } }, /at least one step/],
    [{ tag: 'remove-node', target: { ...REF, path: [-1] } }, /child index/],
    [{ tag: 'remove-node', target: { ...REF, kind: 'frontmatter' } }, /unknown node kind/],
    [{ tag: 'remove-attribute', target: REF, name: 'a b' }, /attribute name/],
    [
      { tag: 'set-inline-style', target: REF, property: 'Color!', declaration: { tag: 'remove' } },
      /CSS property/,
    ],
    [{ tag: 'rename-binding', target: REF, from: 'a', to: 'a' }, /must change/],
    [
      { tag: 'insert-node', target: REF, placement: 'after', content: { tag: 'nodes', nodes: [] } },
      /at least one/,
    ],
    [
      {
        tag: 'insert-node',
        target: REF,
        placement: 'inside',
        content: { tag: 'copy', source: REF },
      },
      /placement/,
    ],
    [{ tag: 'revert', hunks: [{ span: { start: 2, end: 1 }, text: '' }] }, /end must not precede/],
    [{ tag: 'rename-tag', target: REF, to: 'my card' }, /tag name/],
    [{ tag: 'rename-tag', target: REF, to: '1div' }, /tag name/],
    [{ tag: 'rename-tag', target: REF, to: 'x'.repeat(129) }, /exceeds 128/],
    [{ tag: 'rename-attribute', target: REF, from: 'title', to: 'title' }, /must change/],
    [{ tag: 'rename-attribute', target: REF, from: 'a b', to: 'c' }, /attribute name/],
    [{ tag: 'replace-node', target: REF }, /Edit.node/],
    [{ tag: 'replace-node', target: REF, node: { id: GESTURE_ID, kind: 'paint' } }, /kind/],
  ];
  for (const [request, message] of bad) {
    assert.throws(
      () => parseEditRequest({ pagePath: '/p.astro', authoredChecksum: DIGEST, edit: request }),
      message,
    );
  }
  assert.throws(() =>
    parseEditRequest({ pagePath: '/p.astro', authoredChecksum: 'x', edit: good[0] }),
  );
});

test('parsePageEditResult: an applied edit carries its inverse; a refusal is a rejection', () => {
  const page = { source: 'x', editable: false, reason: 'r', bail: null, checksum: DIGEST };
  const applied = parsePageEditResult({
    ok: true,
    ...page,
    inverse: [{ span: { start: 0, end: 1 }, text: 'y' }],
  });
  assert.ok(applied.ok);
  assert.deepEqual(applied.value.inverse, [{ span: { start: 0, end: 1 }, text: 'y' }]);
  const rejected = parsePageEditResult({
    ok: false,
    error: { code: 'rejected', reason: 'anchor-moved', message: 'm', diskChecksum: null },
  });
  assert.deepEqual(rejected, {
    ok: false,
    error: { code: 'rejected', reason: 'anchor-moved', message: 'm', diskChecksum: undefined },
  });
  assert.throws(
    () =>
      parsePageEditResult({
        ok: true,
        ...page,
        inverse: [
          { span: { start: 1, end: 2 }, text: 'a' },
          { span: { start: 0, end: 1 }, text: 'b' },
        ],
      }),
    /ascending/,
  );
  assert.throws(
    () =>
      parsePageEditResult({
        ok: false,
        error: { code: 'rejected', reason: 'nope', message: 'm', diskChecksum: null },
      }),
    /rejection reason/,
  );
  assert.throws(
    () =>
      parsePageEditResult({
        ok: false,
        error: { code: 'conflict', message: 'm', diskChecksum: DIGEST },
      }),
    // Step 10: no save is refused as a whole-file conflict any more.
    /PageWriteFailure\.code: unknown value/,
  );
});

// --- End to end --------------------------------------------------------------------------

const SIBLINGS = '<Hero title="Old" />\n<Card title="Old" />\n<Card title="Old" />\n';

test('an edit writes only its splice; its inverse restores every byte', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, SIBLINGS);
  const page = await read(harness, file);
  const applied = await edit(harness, file, page.checksum, title(refAt(page, [2]), 'New'));
  assert.ok(applied.ok, 'the edit applies');
  const after = '<Hero title="Old" />\n<Card title="Old" />\n<Card title="New" />\n';
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  assert.equal(applied.value.checksum, sha256(after));
  assert.equal(applied.value.source, after, 'the reply is the page as written');
  const undone = await edit(harness, file, applied.value.checksum, {
    tag: 'revert',
    hunks: applied.value.inverse,
  });
  assert.ok(undone.ok, 'the inverse applies');
  assert.equal(fs.readFileSync(file, 'utf8'), SIBLINGS);
});

test('renames and node rewrites write only their bytes; inverses restore them', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  const before =
    '<section title="a">\n    <p>Hello   <b>world</b></p>\n  <!-- note -->\n</section>\n';
  fs.writeFileSync(file, before);
  const steps: readonly ((page: PageDiskRead) => Edit)[] = [
    (page) => ({ tag: 'rename-tag', target: refAt(page, [0]), to: 'article' }),
    (page) => ({
      tag: 'rename-attribute',
      target: refAt(page, [0]),
      from: 'title',
      to: 'aria-label',
    }),
    (page) => {
      const target = refAt(page, [0, 0, 0]);
      return { tag: 'replace-node', target, node: { ...nodeAt(page, [0, 0, 0]), value: 'Hi' } };
    },
    (page) => {
      const note = nodeAt(page, [0, 1]);
      assert.ok(note.kind === 'comment', 'the note is a comment');
      // The parsed value keeps its own spaces: `<!-- note -->` reads ' note '.
      const value = note.value?.replace('note', 'kept');
      return { tag: 'replace-node', target: refAt(page, [0, 1]), node: { ...note, value } };
    },
  ];
  const expected = [
    '<article title="a">\n    <p>Hello   <b>world</b></p>\n  <!-- note -->\n</article>\n',
    '<article aria-label="a">\n    <p>Hello   <b>world</b></p>\n  <!-- note -->\n</article>\n',
    // The text's own trailing spaces are kept: only what the printer says
    // changed is written, placed on the node's bytes.
    '<article aria-label="a">\n    <p>Hi   <b>world</b></p>\n  <!-- note -->\n</article>\n',
    '<article aria-label="a">\n    <p>Hi   <b>world</b></p>\n  <!-- kept -->\n</article>\n',
  ];
  const inverses: { readonly checksum: string; readonly hunks: PageEditInverse }[] = [];
  for (const [index, step] of steps.entries()) {
    const page = await read(harness, file);
    const applied = await edit(harness, file, page.checksum, step(page));
    assert.ok(applied.ok, `step ${index} applies`);
    assert.equal(fs.readFileSync(file, 'utf8'), expected[index], `step ${index}`);
    inverses.push({ checksum: applied.value.checksum, hunks: applied.value.inverse });
  }
  for (const inverse of [...inverses].reverse()) {
    const revert: Edit = { tag: 'revert', hunks: inverse.hunks };
    const undone = await edit(harness, file, inverse.checksum, revert);
    assert.ok(undone.ok, 'every inverse applies in turn');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'undo restores every byte');
  // Refusals leave the disk untouched: a void tag has no closing tag to rename
  // with it, and renaming onto a name the tag has would leave two.
  fs.writeFileSync(file, '<img src="a" alt="b">\n');
  const image = await read(harness, file);
  const renamed = await edit(harness, file, image.checksum, {
    tag: 'rename-tag',
    target: refAt(image, [0]),
    to: 'picture',
  });
  assert.equal(renamed.ok ? 'applied' : renamed.error.code, 'rejected');
  const clash = await edit(harness, file, image.checksum, {
    tag: 'rename-attribute',
    target: refAt(image, [0]),
    from: 'src',
    to: 'alt',
  });
  assert.equal(clash.ok ? 'applied' : clash.error.code, 'rejected');
  assert.equal(fs.readFileSync(file, 'utf8'), '<img src="a" alt="b">\n');
});

test('a layout picked wraps the page; removed, its tags go and the page stays', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  const body = '<main>\n  <p>m</p>\n</main>\n<footer>f</footer>\n';
  fs.writeFileSync(file, body);
  const page = await read(harness, file);
  const wrapped = await edit(harness, file, page.checksum, {
    tag: 'wrap-nodes',
    target: refAt(page, [0]),
    last: refAt(page, [1]),
    name: 'Base',
  });
  assert.ok(wrapped.ok, 'the wrap applies');
  const inside = '<Base>\n<main>\n  <p>m</p>\n</main>\n<footer>f</footer>\n</Base>\n';
  assert.equal(fs.readFileSync(file, 'utf8'), inside);
  const again = await read(harness, file);
  const unwrapped = await edit(harness, file, again.checksum, {
    tag: 'unwrap-node',
    target: refAt(again, [0]),
  });
  assert.ok(unwrapped.ok, 'the unwrap applies');
  assert.equal(fs.readFileSync(file, 'utf8'), body, 'the page is as it was');
  // An indented wrapper whose closing tag shares a line with content keeps it.
  fs.writeFileSync(file, '<Base title="x">\n  <p>a</p></Base>\n');
  const inline = await read(harness, file);
  const kept = await edit(harness, file, inline.checksum, {
    tag: 'unwrap-node',
    target: refAt(inline, [0]),
  });
  assert.ok(kept.ok, 'the unwrap applies');
  assert.equal(fs.readFileSync(file, 'utf8'), '  <p>a</p>\n');
});

test("an edit authored before the app's own last edit is rebased exactly", async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, SIBLINGS);
  const page = await read(harness, file);
  // Both authored against the same read. The second card's bytes repeat, so a
  // diff could not tell the cards apart; the commit log knows what moved.
  const first = await edit(
    harness,
    file,
    page.checksum,
    title(refAt(page, [0]), 'A much longer hero title'),
  );
  assert.ok(first.ok);
  const second = await edit(harness, file, page.checksum, title(refAt(page, [2]), 'Second'));
  assert.ok(second.ok, 'rebased through the first edit');
  const third = await edit(harness, file, page.checksum, title(refAt(page, [0]), 'Hero again'));
  assert.ok(third.ok, 'the same attribute again: the latest word wins');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '<Hero title="Hero again" />\n<Card title="Old" />\n<Card title="Second" />\n',
  );
});

test('an outside edit elsewhere maps; one on the same value is refused', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  const text = '<h1 title="Heading">Hi</h1>\n<p class="lead">Words</p>\n';
  fs.writeFileSync(file, text);
  const page = await read(harness, file);
  const lead = refAt(page, [1]);
  // The editor has not seen this read's outcome yet: the actor retains the
  // bytes it read, so the edit maps through the outside write.
  fs.writeFileSync(file, text.replace('Hi', 'Hello there'));
  const mapped = await edit(harness, file, page.checksum, {
    tag: 'set-attribute',
    target: lead,
    name: 'class',
    value: { type: 'string', value: 'intro' },
  });
  assert.ok(mapped.ok, `mapped (${mapped.ok ? '' : mapped.error.code})`);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '<h1 title="Heading">Hello there</h1>\n<p class="intro">Words</p>\n',
  );
  const now = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, now.replace('class="intro"', 'class="theirs"'));
  const refused = await edit(harness, file, mapped.value.checksum, {
    tag: 'set-attribute',
    target: refAt(mapped.value, [1]),
    name: 'class',
    value: { type: 'string', value: 'mine' },
  });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error.code, 'rejected');
  assert.ok(fs.readFileSync(file, 'utf8').includes('class="theirs"'), 'the outside edit stays');
});

test('unknown bytes, or a node the page lacks, are refused', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, SIBLINGS);
  const page = await read(harness, file);
  const unknown = await edit(harness, file, DIGEST, title(refAt(page, [0]), 'x'));
  assert.deepEqual(
    !unknown.ok && [unknown.error.code, unknown.error.code === 'rejected' && unknown.error.reason],
    ['rejected', 'anchor-moved'],
  );
  const wrong = await edit(
    harness,
    file,
    page.checksum,
    title({ ...refAt(page, [0]), span: toUtf16Span(1, 5) }, 'x'),
  );
  assert.equal(!wrong.ok && wrong.error.code === 'rejected' && wrong.error.reason, 'anchor-moved');
  assert.equal(fs.readFileSync(file, 'utf8'), SIBLINGS, 'nothing was written');
});

test('a preview plans against the bytes it is sent and writes nothing', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, SIBLINGS);
  const page = await read(harness, file);
  // The disk moves on: a preview is of the bytes the gestures were stated on.
  const outside = SIBLINGS.replace('<Hero', '<Hero id="x"');
  fs.writeFileSync(file, outside);
  const preview = (authoredChecksum: string, source: string, request: Edit) =>
    harness.invoke('page:previewEdit', { pagePath: file, authoredChecksum, edit: request, source });
  const first = parsePageEditResult(
    await preview(page.checksum, SIBLINGS, title(refAt(page, [2]), 'New')),
  );
  assert.ok(first.ok, 'the preview plans');
  const after = '<Hero title="Old" />\n<Card title="Old" />\n<Card title="New" />\n';
  assert.equal(first.value.source, after, 'the bytes the edit would write: a splice');
  assert.equal(first.value.checksum, sha256(after));
  assert.equal(fs.readFileSync(file, 'utf8'), outside, 'nothing was written');
  // The next request names the reply, as it would after a write.
  const next = parsePageDiskRead(first.value);
  const second = parsePageEditResult(
    await preview(first.value.checksum, after, title(refAt(next, [0]), 'Top')),
  );
  assert.ok(second.ok, 'a preview chains on the one before');
  assert.equal(second.value.source, after.replace('Old', 'Top'));
  const moved = { ...refAt(page, [0]), span: toUtf16Span(1, 5) };
  const gone = parsePageEditResult(await preview(page.checksum, SIBLINGS, title(moved, 'x')));
  assert.equal(!gone.ok && gone.error.code === 'rejected' && gone.error.reason, 'anchor-moved');
  await assert.rejects(
    preview(DIGEST, SIBLINGS, title(refAt(page, [0]), 'x')),
    /A preview names the bytes it is sent/,
    'a request naming other bytes than it sends is a broken caller',
  );
  await assert.rejects(
    harness.invoke('page:previewEdit', { pagePath: file, authoredChecksum: page.checksum }),
    /./,
    'a preview without its bytes or its edit never reaches the planner',
  );
  // Step 10: a Markdown page's gestures are previewed as splices too.
  const markdown = path.join(harness.root, 'src/pages/notes.md');
  fs.writeFileSync(markdown, '# Notes\n');
  const notes = parsePageDiskRead(await harness.invoke('page:read', markdown));
  const heading: Edit = { tag: 'rename-tag', target: refAt(notes, [0]), to: 'h2' };
  const previewed = parsePageEditResult(
    await harness.invoke('page:previewEdit', {
      pagePath: markdown,
      authoredChecksum: sha256('# Notes\n'),
      edit: heading,
      source: '# Notes\n',
    }),
  );
  assert.equal(previewed.ok && previewed.value.source, '## Notes\n', 'planned, not written');
  assert.equal(fs.readFileSync(markdown, 'utf8'), '# Notes\n');
});

test('new nodes print where they land; the frontmatter changes its slot', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  const text =
    "---\nimport Hero from '../components/Hero.astro';\nconst title = 'T';\n---\n" +
    '<main>\n  <Hero />\n</main>\n';
  fs.writeFileSync(file, text);
  const page = await read(harness, file);
  assert.ok(page.editable);
  // As it crosses the wire: validated by the same parser main uses.
  const card = parsePageNode({
    id: GESTURE_ID,
    kind: 'component',
    name: 'Card',
    props: {},
    children: null,
  });
  const inserted = await edit(harness, file, page.checksum, {
    tag: 'insert-node',
    target: refAt(page, [0, 0]),
    placement: 'after',
    content: { tag: 'nodes', nodes: [card] },
  });
  assert.ok(inserted.ok, 'the node inserts');
  const imports = [
    ...page.model.imports,
    { name: 'Card', path: '../components/Card.astro', quote: "'" },
  ];
  const withImport = await edit(harness, file, page.checksum, {
    tag: 'set-frontmatter',
    model: { ...page.model, imports, nodes: [] },
  });
  assert.ok(
    withImport.ok,
    `the import lands (${withImport.ok ? '' : JSON.stringify(withImport.error)})`,
  );
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    [
      '---',
      "import Hero from '../components/Hero.astro';",
      "import Card from '../components/Card.astro';",
      "const title = 'T';",
      '---',
      '<main>',
      '  <Hero />',
      '  <Card />',
      '</main>',
      '',
    ].join('\n'),
  );
});

test('undo after an outside edit maps through it and never reverts it', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  const filler =
    '<p>A paragraph long enough to keep the two edits out of each other’s context.</p>\n';
  fs.writeFileSync(file, `<h1 title="One">Hi</h1>\n${filler}<footer>Old</footer>\n`);
  const page = await read(harness, file);
  const applied = await edit(harness, file, page.checksum, title(refAt(page, [0]), 'Two'));
  assert.ok(applied.ok);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Old', 'Theirs'));
  const undone = await edit(harness, file, applied.value.checksum, {
    tag: 'revert',
    hunks: applied.value.inverse,
  });
  assert.ok(undone.ok, `undo maps (${undone.ok ? '' : JSON.stringify(undone.error)})`);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    `<h1 title="One">Hi</h1>\n${filler}<footer>Theirs</footer>\n`,
  );
});

test('an edit authored before more commits than the host retains is refused', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, SIBLINGS);
  const page = await read(harness, file);
  const hero = refAt(page, [0]);
  // Every edit is authored against the first read; each commit pushes that
  // snapshot one place further back. Sixteen earlier snapshots are kept
  // (LIMITS.authoredSnapshotsMax), and the log holds sixteen commits, so the
  // seventeenth edit still rebases and the eighteenth has nothing to map from.
  for (let round = 1; round <= 17; round++) {
    const applied = await edit(harness, file, page.checksum, title(hero, `Round ${round}`));
    assert.ok(applied.ok, `round ${round} is rebased`);
  }
  const late = await edit(harness, file, page.checksum, title(hero, 'Too late'));
  assert.equal(!late.ok && late.error.code === 'rejected' && late.error.reason, 'anchor-moved');
  assert.ok(fs.readFileSync(file, 'utf8').includes('Round 17'), 'the refusal wrote nothing');
});

test('two frontmatter requests against one read add each import once', async (context) => {
  // The second request's model already holds the first import: after the
  // app's own commit, main compares it with the block on disk now, or it would
  // write that import a second time.
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, "---\nimport A from './A.astro';\n---\n<A />\n");
  const page = await read(harness, file);
  assert.ok(page.editable);
  const B = { name: 'B', path: './B.astro', quote: "'" };
  const C = { name: 'C', path: './C.astro', quote: "'" };
  for (const imports of [
    [...page.model.imports, B],
    [...page.model.imports, B, C],
  ]) {
    const applied = await edit(harness, file, page.checksum, {
      tag: 'set-frontmatter',
      model: { ...page.model, imports, nodes: [] },
    });
    assert.ok(applied.ok, 'each request applies');
  }
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    "---\nimport A from './A.astro';\nimport B from './B.astro';\n" +
      "import C from './C.astro';\n---\n<A />\n",
  );
});
