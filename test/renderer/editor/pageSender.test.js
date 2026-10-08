// Goal: src/editor/pageSender.ts shows each queue entry's outcome on the page as plan
// §7 and §11.9 require: an applied gesture moves the origin on — and, when
// nothing more is owed, the page is the reply itself, clean, every handle
// carried; a gesture refused over unchanged bytes (no form the engine can plan)
// is taken back and said out loud, never saved some other way; one refused
// over changed bytes is the conflict notice with its reason; a write that
// may have landed is never sent again blind — the disk decides; and a preview
// of the queue (the reviewed version of a conflicted page) is those gestures
// planned as splices of the bytes they were stated on, nothing written.
// Method: a real page parsed by the real parser, replies made by main's real
// translation and planner (so their inverse hunks are main's), and the page
// state held in a plain object the sender updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const load = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { parsePageResult } = require('#dist/shared/page/pageNode.js');
const { NODE_PROJECTOR } = require('#dist/electron/documents/documentDisk.js');
const { buildEditIntent } = require('#dist/electron/documents/editRequests.js');
const { toIntent } = require('#dist/shared/engine/intent.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { applySplices, inverseEdits } = require('#dist/shared/engine/splice.js');
const { createEntrySender, previewGestures } = load('src/editor/pageSender.ts');
const edits = load('src/editor/pageEdits.ts');
const editGestures = load('src/editor/editGestures.ts');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const PATH = '/project/src/pages/index.astro';
const PAGE = '<main>\n  <h1 class="t">Title</h1>\n  <p>One</p>\n</main>\n';
const HEADING_TITLED = PAGE.replace('class="t"', 'class="t" title="a"');
const BOTH_TITLED = HEADING_TITLED.replace('<p>', '<p title="b">');
const titled = (value) => ({ title: { type: 'string', value } });

function read(source) {
  const parsed = parsePageResult(parsePage(source, { locs: true }));
  return { ...parsed, source, checksum: sha256(source) };
}

// The page as the app shows it after reading `source`.
function pageState(source) {
  const page = read(source);
  assert.ok(page.editable);
  const origin = { checksum: page.checksum, source, model: page.model };
  return {
    editable: true,
    model: page.model,
    source,
    parsedFrom: source,
    save: { tag: 'dirty', baseChecksum: page.checksum },
    origin,
  };
}

// Main's page:edit, on a disk the test holds.
function engine(disk) {
  return async ({ authoredChecksum, edit }) => {
    const snapshot = NODE_PROJECTOR.snapshot(PATH, Buffer.from(disk.text));
    if (snapshot.checksum !== authoredChecksum) {
      const reason = 'region-externally-modified';
      const error = { code: 'rejected', reason, message: 'x', diskChecksum: snapshot.checksum };
      return { ok: false, error };
    }
    const draft = buildEditIntent(edit, snapshot);
    if (!draft.ok) {
      const reason = draft.error;
      const error = { code: 'rejected', reason, message: reason, diskChecksum: snapshot.checksum };
      return { ok: false, error };
    }
    const intent = toIntent({ id: 't', file: PATH, authoredChecksum, ...draft.value });
    const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
    assert.ok(planned.ok, `planned (${planned.ok ? '' : planned.error})`);
    disk.text = Buffer.from(applySplices(snapshot.bytes, planned.value.splices)).toString('utf8');
    const inverse = inverseEdits(planned.value.splices);
    return { ok: true, value: { ...read(disk.text), inverse } };
  };
}

function harness(source, overrides = {}) {
  const disk = { text: source };
  const box = { state: pageState(source), notices: [], conflicts: [] };
  const queue = new edits.EditDrafts();
  const send = createEntrySender({
    queue,
    state: () => box.state,
    update: (_path, change) => {
      box.state = change(box.state);
    },
    conflict: (reason) => box.conflicts.push(reason),
    notice: (message) => box.notices.push(message),
    edit: engine(disk),
    writeWhole: async () => {
      throw new Error('an .astro page is never saved whole');
    },
    read: async () => read(disk.text),
    ...overrides,
  });
  return { disk, box, queue, send };
}

const step = () => ({ outcome: { tag: 'applied', applied: [] } });

test('an applied gesture: the page is the reply, clean, with every handle carried', async () => {
  const { disk, box, queue, send } = harness(PAGE);
  const heading = box.state.model.nodes[0].children[0];
  const record = step();
  const big = { class: { type: 'string', value: 'big' } };
  const retitle = editGestures.propsGesture(heading.id, big, {
    coalesceKey: undefined,
    urgency: true,
  });
  queue.addGesture(PATH, retitle, record);
  box.state = { ...box.state, model: retitle.apply(box.state.model) };
  const outcome = await send(PATH, queue.shift(PATH));
  assert.deepEqual(outcome, { tag: 'sent' });
  assert.equal(disk.text, PAGE.replace('class="t"', 'class="big"'));
  assert.deepEqual(box.state.save, { tag: 'clean', checksum: sha256(disk.text) });
  assert.equal(box.state.origin.checksum, sha256(disk.text), 'the origin moved on');
  assert.equal(box.state.model.nodes[0].children[0].id, heading.id, 'the handle was carried');
  assert.equal(record.outcome.tag, 'applied');
});

test('a confirmed discrete edit cues the canvas after disk changes', async () => {
  const seen = [];
  const { disk, box, queue, send } = harness(PAGE, {
    onAppliedUrgentEdit: () => seen.push(disk.text),
  });
  const heading = box.state.model.nodes[0].children[0];
  const clone = { ...heading, id: `g${'a'.repeat(32)}` };
  const duplicate = editGestures.duplicateGesture(heading.id, clone, { urgency: true });
  queue.addGesture(PATH, duplicate, step());
  box.state = { ...box.state, model: duplicate.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /<h1 class="t">Title<\/h1>[\s\S]*<h1 class="t">Title<\/h1>/);

  const remove = editGestures.removalGesture([clone.id], { urgency: true });
  queue.addGesture(PATH, remove, step());
  box.state = { ...box.state, model: remove.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(seen.length, 2);
  assert.equal(disk.text, PAGE);

  const retitle = editGestures.propsGesture(heading.id, titled('later'), {
    coalesceKey: undefined,
    urgency: false,
  });
  queue.addGesture(PATH, retitle, step());
  box.state = { ...box.state, model: retitle.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(seen.length, 2, 'batched typing still relies on HMR');
});

test('with more queued, only the origin moves on; the model shows the newer edit', async () => {
  const { disk, box, queue, send } = harness(PAGE);
  const [heading, paragraph] = box.state.model.nodes[0].children;
  const options = { coalesceKey: undefined, urgency: true };
  const first = editGestures.propsGesture(heading.id, titled('a'), options);
  const second = editGestures.propsGesture(paragraph.id, titled('b'), options);
  queue.addGesture(PATH, first, step());
  queue.addGesture(PATH, second, step());
  box.state = { ...box.state, model: second.apply(first.apply(box.state.model)) };
  await send(PATH, queue.shift(PATH));
  assert.equal(box.state.save.tag, 'dirty');
  assert.equal(box.state.save.baseChecksum, sha256(disk.text), 'the next request names these');
  assert.equal(box.state.model.nodes[0].children[1].props.title.value, 'b', 'the newer edit shows');
  await send(PATH, queue.shift(PATH));
  assert.equal(disk.text, BOTH_TITLED);
  assert.equal(box.state.save.tag, 'clean');
});

test('a gesture the engine cannot plan is taken back and said, never saved otherwise', async () => {
  const { disk, box, queue, send } = harness(PAGE);
  const record = step();
  const unplannable = {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: () => undefined, // Its node is another file's: nothing to state.
    apply: (model) => ({ ...model, nodes: [] }),
  };
  queue.addGesture(PATH, unplannable, record);
  box.state = { ...box.state, model: unplannable.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(disk.text, PAGE, 'nothing written');
  assert.deepEqual(record.outcome, { tag: 'dropped' });
  assert.equal(box.notices.length, 1);
  assert.equal(box.state.model.nodes.length, 1, 'the shown model is the origin again');
  assert.deepEqual(box.state.save, { tag: 'clean', checksum: sha256(PAGE) });
});

test('refused over changed bytes: the conflict notice with the reason', async () => {
  let previewCues = 0;
  const { disk, box, queue, send } = harness(PAGE, {
    onAppliedUrgentEdit: () => {
      previewCues += 1;
    },
  });
  const heading = box.state.model.nodes[0].children[0];
  const options = { coalesceKey: undefined, urgency: true };
  const untitle = editGestures.propsGesture(heading.id, { title: undefined }, options);
  queue.addGesture(PATH, untitle, step());
  disk.text = PAGE.replace('Title', 'Outside');
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'conflicted' });
  assert.deepEqual(box.conflicts, ['region-externally-modified']);
  assert.equal(box.state.save.tag, 'conflicted');
  assert.equal(box.state.save.diskChecksum, sha256(disk.text));
  assert.equal(previewCues, 0, 'a refused edit cannot announce a new preview');
});

test('a write that may have landed is never sent again blind: the disk decides', async () => {
  const uncertain = async () => ({ ok: false, error: { code: 'uncertain', message: 'rename?' } });
  const untouched = harness(PAGE, { edit: uncertain });
  const heading = untouched.box.state.model.nodes[0].children[0];
  const options = { coalesceKey: undefined, urgency: true };
  const drop = editGestures.propsGesture(heading.id, { class: undefined }, options);
  untouched.queue.addGesture(PATH, drop, step());
  const again = await untouched.send(PATH, untouched.queue.shift(PATH));
  assert.equal(again.tag, 'failed', 'the disk holds the bytes it was stated against: send again');
  const moved = harness(PAGE, { edit: uncertain });
  moved.queue.addGesture(PATH, drop, step());
  moved.disk.text = PAGE.replace(' class="t"', '');
  assert.deepEqual(await moved.send(PATH, moved.queue.shift(PATH)), { tag: 'conflicted' });
  assert.deepEqual(moved.box.conflicts, ['write-race'], 'it changed: the user decides');
});

test('a preview plans every queued gesture as splices, chained, and writes nothing', async () => {
  const disk = { text: PAGE.replace('One', 'Outside') }; // The disk moved on.
  const origin = pageState(PAGE).origin;
  const [heading, paragraph] = origin.model.nodes[0].children;
  const options = { coalesceKey: undefined, urgency: true };
  const unplannable = {
    ...options,
    stream: undefined,
    request: () => undefined,
    apply: (model) => model,
  };
  const queued = [
    editGestures.propsGesture(heading.id, titled('a'), options),
    unplannable,
    editGestures.propsGesture(paragraph.id, titled('b'), options),
  ];
  const planned = [];
  const preview = async (request, source) => {
    planned.push(request.authoredChecksum);
    const held = { text: source };
    return engine(held)(request); // Planned against the bytes sent, never the disk.
  };
  const shown = await previewGestures({ path: PATH, origin, gestures: queued, preview });
  assert.equal(shown.tag, 'previewed');
  assert.equal(shown.withdrawn, 1, 'the gesture a save would take back is left out');
  assert.equal(shown.origin.source, BOTH_TITLED);
  assert.equal(shown.origin.checksum, sha256(BOTH_TITLED));
  assert.deepEqual(planned, [sha256(PAGE), sha256(HEADING_TITLED)]);
  assert.equal(disk.text, PAGE.replace('One', 'Outside'), 'nothing written');
  assert.equal(shown.origin.model.nodes[0].children[1].id, paragraph.id, 'handles carried');
});
