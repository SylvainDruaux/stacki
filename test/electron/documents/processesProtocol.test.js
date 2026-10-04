// Goal: the write protocol across real processes (plan §5.2, §3.5, §10).
// (1) Cooperating writers — several Stacki processes saving one file at once —
// never lose an update: every applied write was based on the bytes it
// replaced, so the file ends with exactly one line per applied write; the
// losers are refused, never silently overwritten. (2) A process killed between
// the atomic replace and its verifying read leaves no outcome behind; the
// survivor holds the deterministic candidate checksum, and reconciliation by
// comparison (`reconcileUncertain`) answers "applied", "not applied" or
// "changed again" — no intent journal. (3) The lock file a killed writer left
// is broken by the next one, because its owner is gone, and the temporary file
// a crash before the rename leaves behind is inert: the target is untouched
// and the watcher ignores it.
// Method: test/helpers/platformChild.js runs a real host in a child process; the crash
// jobs kill themselves with SIGKILL at the rename. Real files in the OS temp
// directory; nothing is faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reconcileUncertain } = require('#dist/shared/engine/documentActor.js');
const { isAtomicTemporary } = require('#dist/electron/documents/atomicWrite.js');
const {
  protocolLeftovers,
  realHost,
  runChild,
  scratch,
  sha256,
} = require('../../helpers/platformSupport.js');

const WRITERS = 4;
const ROUNDS = 40;

test('cooperating writers in separate processes never lose an update', async (context) => {
  await scratch(os.tmpdir(), async (root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, '');
    const runs = await Promise.all(
      Array.from({ length: WRITERS }, (_, id) =>
        runChild({ mode: 'cooperate', file, id: `w${id}`, rounds: ROUNDS }),
      ),
    );
    const events = runs.flatMap((run) => {
      assert.equal(run.code, 0, 'each writer exits cleanly');
      return run.lines.map((line) => JSON.parse(line));
    });
    assert.equal(events.length, WRITERS * ROUNDS, 'one outcome per round');
    const applied = events.filter((event) => event.tag === 'applied').length;
    const refused = events.filter((event) => event.tag === 'rejected');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, applied, 'every applied write is in the file: no lost update');
    assert.equal(new Set(lines).size, lines.length, 'and none was written twice');
    for (const event of refused) {
      assert.ok(
        ['region-externally-modified', 'write-race', 'write-failed'].includes(event.reason),
        `a refusal names the race: ${event.reason}`,
      );
      if (process.platform !== 'win32') {
        assert.notEqual(event.reason, 'write-failed', 'no writer failed outright');
      }
    }
    // The actor never retries, so how many rounds win depends on the scheduler:
    // under contention most are refused (a held lock is a write-race). Progress
    // is all the protocol promises; the count is logged for the record.
    assert.ok(applied > 0, 'the writers made progress');
    assert.ok(refused.length > 0, 'the writers really contended');
    context.diagnostic(`applied ${applied}, refused ${refused.length} of ${events.length}`);
    assert.deepEqual(protocolLeftovers(root), [], 'no lock or temporary file is left');
  });
});

for (const at of ['after-rename', 'before-rename']) {
  test(`a writer killed ${at.replace('-', ' ')} is reconciled by comparison`, async () => {
    await scratch(os.tmpdir(), async (root) => {
      const file = path.join(root, 'page.astro');
      fs.writeFileSync(file, 'authored\n');
      const run = await runChild({ mode: 'crash', file, text: 'candidate\n', at });
      assertKilled(run);
      const [staged, ...rest] = run.lines.map((line) => JSON.parse(line));
      assert.deepEqual(rest, [], 'it reported nothing after staging: no outcome was delivered');
      assert.equal(
        staged.candidate,
        sha256('candidate\n'),
        'the candidate checksum is deterministic',
      );
      const verdict = reconcileUncertain({
        baseChecksum: staged.base,
        candidateChecksum: staged.candidate,
        currentChecksum: sha256(fs.readFileSync(file)),
      });
      assert.equal(verdict, at === 'after-rename' ? 'applied' : 'not-applied');
      const leftovers = protocolLeftovers(root);
      assert.ok(
        leftovers.some((name) => name.startsWith('.stacki-lock-')),
        'its lock is left',
      );
      assert.ok(leftovers.every(isAtomicTemporary), 'everything left is ignored by the watcher');
      // The next writer breaks the dead writer's lock and saves normally.
      const documents = realHost();
      const current = documents.current(file);
      const report = documents.writeText(file, 'next\n', current.value.checksum);
      assert.equal(report.tag, 'applied');
      assert.equal(fs.readFileSync(file, 'utf8'), 'next\n');
      assert.ok(
        protocolLeftovers(root).every((name) => name.startsWith('.stacki-write-')),
        'the stale lock is gone; only an inert temporary from a crash before the rename remains',
      );
    });
  });
}

test('a crash, then another writer: reconciliation says the file changed again', async () => {
  await scratch(os.tmpdir(), async (root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    const run = await runChild({ mode: 'crash', file, text: 'candidate\n', at: 'after-rename' });
    assertKilled(run);
    const staged = JSON.parse(run.lines[0]);
    fs.writeFileSync(file, 'an editor saved over it\n');
    const verdict = reconcileUncertain({
      baseChecksum: staged.base,
      candidateChecksum: staged.candidate,
      currentChecksum: sha256(fs.readFileSync(file)),
    });
    assert.equal(verdict, 'changed-again', 'review required, never a guess');
  });
});

function assertKilled(run) {
  if (process.platform === 'win32') {
    assert.equal(
      run.signal ?? undefined,
      undefined,
      'Windows reports forced termination as an exit code',
    );
    assert.notEqual(run.code, 0, 'the writer died inside the write');
  } else {
    assert.equal(run.signal, 'SIGKILL', 'the writer died inside the write');
  }
}
