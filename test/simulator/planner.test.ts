// Goal: shared/planner.ts plans `set-attribute` at exactly the right bytes when
// the file changed after the intent was authored, and rejects with the right
// reason everywhere it cannot be sure — never re-targeting a sibling with
// identical bytes (plan §3.4, §4, §5.2).
// Method: (1) the oracle scenarios that set an attribute: the planner produces
// the hand-derived splices exactly, through the identity fast path and through
// the diff. (2) The wrong-site fixture (hero, footer, two identical cards; the
// intent retitles the second card) against hand-edited current files: each
// expected output below is written out by hand, and the splice offset is
// counted by hand. (3) Every rejection reason the step can produce, pinned.
// (4) A sweep over every `.astro` fixture: for each editable node with a
// string attribute, the identity fast path agrees with the step-1 reference
// planner and with planning through the diff (plan §10), and after an
// unrelated insertion above the body every plan moves by exactly the inserted
// length. (5) A wrong-site application the step-3 spike found, pinned as a
// known failure: it must keep failing until the planner is fixed, and then
// this test goes red and is rewritten as a rejection.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { toFilePath, toIntentId } from '../../dist/shared/brand.js';
import { toIntent, type Intent, type Operation } from '../../dist/shared/intent.js';
import { planIntent, planIntentThroughDiff, type PlanningBase } from '../../dist/shared/planner.js';
import type { AnchorRef } from '../../dist/shared/ref.js';
import type { Snapshot } from '../../dist/shared/snapshot.js';
import type { ProjectedNode } from '../../dist/shared/source-projection.js';
import { decodeUtf8, encodeUtf8, toByteSpan, type ByteString } from '../../dist/shared/span.js';
import { anchorAt, oracleIntent, oracleSplices } from './oracle-intent.ts';
import { ORACLE_SCENARIOS } from './oracles.ts';
import { snapshotOf } from './project.ts';
import { referenceMapSpan, referenceTables } from './reference-diff.ts';
import { planByIdentity } from './reference-planner.ts';
import { applySplices } from './splice.ts';

const FIXTURES = path.resolve('test/fixtures/editor-core');
const DIRECTORIES = ['test/corpus', 'test/fixtures/round-trip', 'test/fixtures/editor-core'];
const PAGE = toFilePath('/project/page.astro');

const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const snapshotText = (text: string, file = PAGE): Snapshot => snapshotOf(file, encodeUtf8(text));

function setAttribute(name: string, value: string): Operation {
  return { tag: 'set-attribute', name, value: { type: 'string', value } };
}

function intentOn(authored: Snapshot, anchor: AnchorRef, operation: Operation): Intent {
  return toIntent({
    id: toIntentId('planner-test'),
    file: authored.path,
    authoredChecksum: authored.checksum,
    anchor,
    operation,
  });
}

/** Plan through both paths; they must agree; return the result bytes or the reason. */
function planned(base: PlanningBase, intent: Intent): string {
  const fast = planIntent(base, intent);
  assert.deepEqual(planIntentThroughDiff(base, intent), fast, 'fast path and diff path agree');
  if (!fast.ok) {
    return `rejected: ${fast.error}`;
  }
  const bytes = applySplices(base.current.bytes, fast.value.splices);
  const text = decodeUtf8(bytes);
  assert.ok(text.ok);
  return text.value;
}

function spliceStarts(base: PlanningBase, intent: Intent): readonly number[] {
  const result = planIntent(base, intent);
  assert.ok(result.ok, 'the intent plans');
  return result.value.splices.map((splice) => splice.range.start);
}

test('oracle set-attribute scenarios: exact splices, fast path and diff path alike', () => {
  let checked = 0;
  for (const step of ORACLE_SCENARIOS.flatMap((scenario) => scenario.steps)) {
    const input = snapshotOf(
      toFilePath(`/project/${step.file}`),
      encodeUtf8(readFixture(step.file)),
    );
    const intent = oracleIntent(step, input, toIntentId(`oracle-${checked}`));
    if (intent.operation.tag !== 'set-attribute') {
      continue;
    }
    checked += 1;
    const base = { authored: input, current: input };
    const fast = planIntent(base, intent);
    assert.ok(fast.ok, `${step.file} plans`);
    assert.deepEqual(fast.value.splices, oracleSplices(step), `${step.file}: exact splices`);
    assert.deepEqual(planIntentThroughDiff(base, intent), fast, `${step.file}: through the diff`);
    assert.deepEqual(planByIdentity(input, intent), fast, `${step.file}: the step-1 reference`);
    assert.equal(planned(base, intent), readFixture(step.expectedFile));
  }
  assert.equal(checked, 3, 'the multi-file, wrong-site and encoding oracles set attributes');
});

// duplicate-siblings.astro, one element per line:
//   [0, 21) `<Hero title="Old" />`   [21, 44) `<Footer title="Old" />`
//   [44, 65) `<Card title="Old" />`  [65, 86) `<Card title="Old" />`
// The intent retitles the second card: its `Old` is [78, 81).
const HERO = '<Hero title="Old" />\n';
const FOOTER = '<Footer title="Old" />\n';
const CARD = '<Card title="Old" />\n';
const SIBLINGS = `${HERO}${FOOTER}${CARD}${CARD}`;

function secondCardIntent(): { readonly authored: Snapshot; readonly intent: Intent } {
  const authored = snapshotText(SIBLINGS);
  assert.equal(
    readFixture('duplicate-siblings.astro'),
    SIBLINGS,
    'the fixture is the one described',
  );
  return {
    authored,
    intent: intentOn(authored, anchorAt(authored, [3]), setAttribute('title', 'New')),
  };
}

function againstCurrent(current: string): { readonly result: string; readonly base: PlanningBase } {
  const { authored, intent } = secondCardIntent();
  const base = { authored, current: snapshotText(current) };
  return { result: planned(base, intent), base };
}

test('stale intent, edit elsewhere: the second card is retitled at its new offset', () => {
  // A nav line above: 8 bytes down, the splice at 86.
  const nav = againstCurrent(`<Nav />\n${SIBLINGS}`);
  assert.equal(
    nav.result,
    '<Nav />\n<Hero title="Old" />\n<Footer title="Old" />\n' +
      '<Card title="Old" />\n<Card title="New" />\n',
  );
  assert.deepEqual(spliceStarts(nav.base, secondCardIntent().intent), [86]);
  // The hero deleted: 21 bytes up, the splice at 57.
  const noHero = againstCurrent(`${FOOTER}${CARD}${CARD}`);
  assert.equal(
    noHero.result,
    '<Footer title="Old" />\n<Card title="Old" />\n<Card title="New" />\n',
  );
  assert.deepEqual(spliceStarts(noHero.base, secondCardIntent().intent), [57]);
  // The first card retitled outside Stacki: same length, the splice stays at 78.
  const mid = againstCurrent(`${HERO}${FOOTER}<Card title="Mid" />\n${CARD}`);
  assert.equal(
    mid.result,
    '<Hero title="Old" />\n<Footer title="Old" />\n<Card title="Mid" />\n<Card title="New" />\n',
  );
  assert.deepEqual(spliceStarts(mid.base, secondCardIntent().intent), [78]);
  // A sibling inserted directly above the target, sharing its `<` and `/>`.
  const between = againstCurrent(`${HERO}${FOOTER}${CARD}<hr />\n${CARD}`);
  assert.equal(
    between.result,
    '<Hero title="Old" />\n<Footer title="Old" />\n' +
      '<Card title="Old" />\n<hr />\n<Card title="New" />\n',
  );
  // Wrapped and re-indented: `<main>\n` 7 bytes, then two spaces per line.
  const wrapped = againstCurrent(`<main>\n  ${HERO}  ${FOOTER}  ${CARD}  ${CARD}</main>\n`);
  assert.equal(
    wrapped.result,
    '<main>\n  <Hero title="Old" />\n  <Footer title="Old" />\n' +
      '  <Card title="Old" />\n  <Card title="New" />\n</main>\n',
  );
  assert.deepEqual(spliceStarts(wrapped.base, secondCardIntent().intent), [93]);
});

test('stale intent, the target itself in question: typed rejections, never another card', () => {
  // One card deleted: which one survived is a guess.
  assert.equal(againstCurrent(`${HERO}${FOOTER}${CARD}`).result, 'rejected: anchor-ambiguous');
  // A third identical card: which two are the originals is a guess.
  assert.equal(againstCurrent(`${SIBLINGS}${CARD}`).result, 'rejected: anchor-ambiguous');
  // Its title changed outside Stacki: the tag the edit lives in is gone.
  assert.equal(
    againstCurrent(`${HERO}${FOOTER}${CARD}<Card title="Ext" />\n`).result,
    'rejected: anchor-moved',
  );
  // An attribute added inside its name-to-last-attribute region.
  assert.equal(
    againstCurrent(`${HERO}${FOOTER}${CARD}<Card data-x="1" title="Old" />\n`).result,
    'rejected: anchor-moved',
  );
  // An attribute appended after the title: the closing quote could be either.
  assert.equal(
    againstCurrent(`${HERO}${FOOTER}${CARD}<Card title="Old" data-x="1" />\n`).result,
    'rejected: anchor-ambiguous',
  );
  // Commented out: the bytes survive, the element does not.
  assert.equal(
    againstCurrent(`${HERO}${FOOTER}${CARD}<!-- <Card title="Old" /> -->\n`).result,
    'rejected: anchor-moved',
  );
  // Moved into a loop: one source node, many rendered cards.
  assert.equal(
    againstCurrent(`${HERO}${FOOTER}${CARD}{[1, 2].map(() => <Card title="Old" />)}\n`).result,
    'rejected: unsupported-operation',
  );
  // The whole file deleted.
  assert.equal(againstCurrent('').result, 'rejected: anchor-moved');
});

// Found by the step-3 spike (seeds 36 and 240 of 400; tracker Step 3). The
// history: the hero is retitled `Old` → `New`, then someone pastes a copy of the
// footer line below it. The authored intent retitles the footer — the original,
// the first footer, whose `Old` is now [36, 39). The true history costs 29 byte
// edits (6 for the retitle, 23 for the paste); inserting the 23 bytes
// `New" />\n<Footer title="` after `<Hero title="` explains the same bytes for
// 23, and that script is the only minimum one — so the mapper, which only
// refuses ties, resolves the footer onto the pasted copy, and the planner
// splices at 59. Byte-identical copies are the wrong-site case plan §4 exists
// for; the minimum edit script is not the edit history.
test('KNOWN WRONG SITE: an edit above plus a pasted copy maps the target onto the copy', () => {
  const { authored } = secondCardIntent();
  const footer = intentOn(authored, anchorAt(authored, [1]), setAttribute('title', 'New'));
  const current = snapshotText(`<Hero title="New" />\n${FOOTER}${FOOTER}${CARD}${CARD}`);
  const base = { authored, current };
  assert.deepEqual(spliceStarts(base, footer), [59], 'known wrong: the pasted copy is edited');
  // The brute-force reference agrees: 23 is the distance, and every minimum
  // script keeps the footer's region `Footer title="Old"` [22, 40) whole at 45.
  const tables = referenceTables(authored.bytes, current.bytes);
  assert.equal(tables.distance, 23);
  assert.deepEqual(referenceMapSpan(tables, toByteSpan(22, 40)), {
    tag: 'resolved',
    span: toByteSpan(45, 63),
  });
  assert.equal(
    planned(base, footer),
    '<Hero title="New" />\n<Footer title="Old" />\n<Footer title="New" />\n' + `${CARD}${CARD}`,
  );
  // With nothing edited above, the paste alone is a tie, and the mapper refuses.
  const pasteOnly = { authored, current: snapshotText(`${HERO}${FOOTER}${FOOTER}${CARD}${CARD}`) };
  assert.equal(planned(pasteOnly, footer), 'rejected: anchor-ambiguous');
});

test('stale intent past the diff bound, or into a file that no longer parses', () => {
  // 3 000 bytes appended exceed LIMITS.diffDistanceMax (2 048) by size alone.
  const appended = `${SIBLINGS}<p>${'x'.repeat(2_993)}</p>`;
  assert.equal(againstCurrent(appended).result, 'rejected: resource-limit');
  // Same size, 1 100 bytes rewritten: distance 2 200, found only by searching.
  const authored = snapshotText(`${SIBLINGS}<p>${'a'.repeat(1_100)}</p>\n`);
  const rewritten = snapshotText(`${SIBLINGS}<p>${'b'.repeat(1_100)}</p>\n`);
  const cardIntent = intentOn(authored, anchorAt(authored, [3]), setAttribute('title', 'New'));
  assert.deepEqual(planIntent({ authored, current: rewritten }, cardIntent), {
    ok: false,
    error: 'resource-limit',
  });
  assert.equal(againstCurrent(`${SIBLINGS}<div`).result, 'rejected: source-invalid');
  const { intent } = secondCardIntent();
  const broken = snapshotText('<div');
  const unchanged = { authored: broken, current: broken };
  assert.deepEqual(planIntent(unchanged, { ...intent, authoredChecksum: broken.checksum }), {
    ok: false,
    error: 'source-invalid',
  });
});

test('rejections that need no diff: the anchor, the attribute, the value, the operation', () => {
  const { authored, intent } = secondCardIntent();
  const base = { authored, current: authored };
  const plan = (operation: Operation, anchor: AnchorRef = intent.anchor) =>
    planIntent(base, intentOn(authored, anchor, operation));
  // The anchor must name, in the authored bytes, a node at that path with that span and kind.
  const hero = anchorAt(authored, [0]);
  assert.deepEqual(plan(setAttribute('title', 'x'), { ...intent.anchor, span: hero.span }), {
    ok: false,
    error: 'anchor-moved',
  });
  assert.deepEqual(
    plan(setAttribute('title', 'x'), { ...intent.anchor, expectedKind: 'element' }),
    {
      ok: false,
      error: 'anchor-moved',
    },
  );
  assert.deepEqual(plan(setAttribute('data-missing', 'x')), {
    ok: false,
    error: 'unsupported-operation',
  });
  assert.deepEqual(
    plan({ tag: 'set-attribute', name: 'title', value: { type: 'expr', value: 'x' } }),
    {
      ok: false,
      error: 'unsupported-operation',
    },
  );
  assert.deepEqual(plan({ tag: 'set-attribute', name: 'title', value: { type: 'bare' } }), {
    ok: false,
    error: 'unsupported-operation',
  });
  // A double quote would close the double-quoted value early.
  assert.deepEqual(plan(setAttribute('title', 'say "hi"')), {
    ok: false,
    error: 'unsupported-operation',
  });
  assert.ok(plan(setAttribute('title', "it's")).ok, 'the other quote is fine inside double quotes');
  const others: readonly Operation[] = [
    { tag: 'remove-attribute', name: 'title' },
    { tag: 'insert-node', placement: 'after', source: '<p />' },
    { tag: 'move-node', destination: hero, placement: 'after' },
    { tag: 'set-inline-style', property: 'color', declaration: { tag: 'set', value: 'red' } },
  ];
  for (const operation of others) {
    assert.deepEqual(plan(operation), { ok: false, error: 'unsupported-operation' }, operation.tag);
  }
});

test('duplicate attributes, expression attributes and loop bodies are refused', () => {
  const page = snapshotText(readFixture('conditional-template.astro'));
  const projection = page.projection;
  assert.equal(projection.tag, 'valid');
  if (projection.tag !== 'valid') {
    return;
  }
  const base = { authored: page, current: page };
  const nodeWith = (predicate: (node: ProjectedNode) => boolean) => {
    const node = projection.nodes.find(predicate);
    assert.ok(node !== undefined);
    return anchorAt(page, node.path);
  };
  const classCount = (node: ProjectedNode) =>
    node.attributes.filter((a) => a.name === 'class').length;
  const duplicated = nodeWith((node) => {
    if (node.capability === 'editable') {
      return classCount(node) > 1;
    }
    return false;
  });
  assert.deepEqual(planIntent(base, intentOn(page, duplicated, setAttribute('class', 'c'))), {
    ok: false,
    error: 'anchor-ambiguous',
  });
  const expression = nodeWith((node) => node.attributes.some((a) => a.name === 'data-x'));
  assert.deepEqual(planIntent(base, intentOn(page, expression, setAttribute('data-x', '3'))), {
    ok: false,
    error: 'unsupported-operation',
  });
  const repeated = nodeWith((node) => {
    if (node.capability === 'repeated-source-node') {
      return node.kind === 'element';
    }
    return false;
  });
  assert.deepEqual(planIntent(base, intentOn(page, repeated, setAttribute('class', 'b'))), {
    ok: false,
    error: 'unsupported-operation',
  });
});

test("preconditions assert: the authored snapshot and the file are the intent's own", () => {
  const { authored, intent } = secondCardIntent();
  const other = snapshotText(`${SIBLINGS}\n`);
  assert.throws(
    () => planIntent({ authored: other, current: other }, intent),
    /Assertion failed: The authored snapshot is the one the intent names/,
  );
  const elsewhere = snapshotText(SIBLINGS, toFilePath('/project/other.astro'));
  assert.throws(
    () => planIntent({ authored, current: elsewhere }, intent),
    /Assertion failed: The current snapshot is of the intent file/,
  );
});

// --- The corpus sweep --------------------------------------------------------

const INSERTED = '<!-- 0 -->\n';

function corpusFiles(): readonly { readonly name: string; readonly text: string }[] {
  return DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.astro'))
      .sort()
      .map((name) => ({
        name: `${directory}/${name}`,
        text: fs.readFileSync(path.join(directory, name), 'utf8'),
      })),
  );
}

/** The file with INSERTED at the start of the body: after the frontmatter, or
 * after a leading byte-order mark. Returns the byte offset it went in at. */
function withInsertion(
  snapshot: Snapshot,
  text: string,
): { readonly text: string; readonly at: number } {
  assert.equal(snapshot.projection.tag, 'valid');
  const frontmatter =
    snapshot.projection.tag === 'valid' ? snapshot.projection.frontmatter : undefined;
  const at = frontmatter === undefined ? (text.startsWith('﻿') ? 3 : 0) : frontmatter.end;
  const bytes: ByteString = snapshot.bytes;
  const joined = Buffer.concat([bytes.subarray(0, at), Buffer.from(INSERTED), bytes.subarray(at)]);
  return { text: joined.toString('utf8'), at };
}

test('corpus sweep: fast = reference = diff path; an insertion above shifts every plan', (t) => {
  let plannedCount = 0;
  let shiftedCount = 0;
  let fileCount = 0;
  for (const file of corpusFiles()) {
    const authored = snapshotText(file.text, toFilePath(`/project/${path.basename(file.name)}`));
    if (authored.projection.tag !== 'valid') {
      continue;
    }
    fileCount += 1;
    const insertion = withInsertion(authored, file.text);
    const current = snapshotText(insertion.text, authored.path);
    for (const node of authored.projection.nodes) {
      for (const attribute of node.attributes.filter((a) => a.type === 'string')) {
        if (!['element', 'component', 'raw'].includes(node.kind)) {
          continue;
        }
        const intent = intentOn(
          authored,
          anchorAt(authored, node.path),
          setAttribute(attribute.name, 'x'),
        );
        const same = { authored, current: authored };
        const fast = planIntent(same, intent);
        assert.deepEqual(
          planByIdentity(authored, intent),
          fast,
          `${file.name} ${node.path.join('/')}: reference`,
        );
        assert.deepEqual(planIntentThroughDiff(same, intent), fast, `${file.name}: diff path`);
        const stale = planIntent({ authored, current }, intent);
        if (fast.ok) {
          plannedCount += 1;
          assert.ok(
            stale.ok,
            `${file.name} ${node.path.join('/')} ${attribute.name}: plans after the insertion`,
          );
          const [before] = fast.value.splices;
          const [after] = stale.value.splices;
          assert.ok(before !== undefined, 'the identity plan has a splice');
          assert.ok(after !== undefined, 'the stale plan has a splice');
          const shift = before.range.start >= insertion.at ? INSERTED.length : 0;
          assert.equal(
            after.range.start,
            before.range.start + shift,
            `${file.name}: exact shifted range`,
          );
          assert.equal(after.range.end, before.range.end + shift);
          assert.deepEqual(after.expectedBytes, before.expectedBytes);
          shiftedCount += shift > 0 ? 1 : 0;
        } else {
          assert.deepEqual(stale, fast, `${file.name} ${node.path.join('/')}: the same rejection`);
        }
      }
    }
  }
  t.diagnostic(`${fileCount} files, ${plannedCount} attributes planned, ${shiftedCount} shifted`);
  assert.ok(plannedCount > 60, `the sweep plans many real attributes (${plannedCount})`);
  assert.ok(shiftedCount > 60, `most of them sit below the insertion (${shiftedCount})`);
});
