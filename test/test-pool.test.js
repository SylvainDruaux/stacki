// Goal: the gate's test pool never runs more commands at once than asked,
// reports every outcome in input order, keeps a failure's output, bounds what it
// keeps, and rejects job counts outside its limits.
// Method: run tiny `node -e` commands through the real pool. Each command marks
// itself running with a file in a shared directory and records how many marks
// it saw, so the highest count observed is the concurrency actually reached.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJobs, runTestPool, POOL_LIMITS } = require('../dist/scripts/test-pool.js');

const node = JSON.stringify(process.execPath);
const options = (jobs) => ({ jobs, cwd: process.cwd(), environment: process.env });

test('the pool never exceeds its job count and keeps input order', async () => {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-pool-'));
  try {
    const script = [
      "const fs = require('fs'); const path = require('path');",
      `const dir = ${JSON.stringify(marks)}; const me = path.join(dir, String(process.pid));`,
      "fs.writeFileSync(me, '');",
      "const seen = fs.readdirSync(dir).filter((n) => !n.endsWith('.seen')).length;",
      "fs.writeFileSync(me + '.seen', String(seen));",
      'setTimeout(() => fs.rmSync(me), 150);',
    ].join(' ');
    const commands = Array.from({ length: 8 }, (_, index) => ({
      name: `mark-${index}`,
      command: `${node} -e ${JSON.stringify(script)}`,
    }));
    const heard = [];
    const outcomes = await runTestPool(commands, options(3), (outcome) => heard.push(outcome.name));
    const names = commands.map((command) => command.name);
    assert.deepEqual(outcomes.map((outcome) => outcome.name), names);
    assert.equal(heard.length, 8);
    assert.ok(outcomes.every((outcome) => outcome.passed));
    const seen = fs.readdirSync(marks).filter((name) => name.endsWith('.seen'))
      .map((name) => Number(fs.readFileSync(path.join(marks, name), 'utf8')));
    assert.equal(seen.length, 8);
    assert.ok(Math.max(...seen) <= 3, `saw ${Math.max(...seen)} running at once`);
    assert.ok(Math.max(...seen) >= 2, 'the pool actually ran commands side by side');
  } finally {
    fs.rmSync(marks, { recursive: true, force: true });
  }
});

test('a failing command reports failure with its output; arguments skip the shell', async () => {
  const [failing, direct] = await runTestPool(
    [
      { name: 'fails', command: `${node} -e "console.log('why'); process.exit(3)"` },
      { name: 'direct', command: process.execPath, argumentsList: ['-e', 'console.log("a b")'] },
    ],
    options(2),
    () => {},
  );
  assert.equal(failing.passed, false);
  assert.match(failing.output, /why/);
  assert.equal(direct.passed, true);
  assert.equal(direct.output, 'a b\n');
});

test('kept output is bounded to the tail', async () => {
  const size = POOL_LIMITS.outputBytesMax + 1024 * 1024;
  const [outcome] = await runTestPool(
    [{
      name: 'loud',
      command: process.execPath,
      argumentsList: ['-e', `process.stdout.write('x'.repeat(${size})); console.log('END')`],
    }],
    options(1),
    () => {},
  );
  assert.equal(outcome.passed, true);
  assert.match(outcome.output, /^\[… \d+ earlier bytes dropped …\]\n/);
  assert.match(outcome.output, /END\n$/);
  assert.ok(Buffer.byteLength(outcome.output) <= POOL_LIMITS.outputBytesMax + 128 * 1024);
});

test('job counts default to one fewer than the CPUs and are bounded', () => {
  assert.equal(parseJobs(undefined, 8), 7);
  assert.equal(parseJobs(undefined, 1), 1);
  assert.equal(parseJobs(undefined, 64), POOL_LIMITS.jobsMax);
  assert.equal(parseJobs('4', 8), 4);
  assert.throws(() => parseJobs('0', 8), /--jobs must be at least 1, got 0/);
  assert.throws(() => parseJobs('17', 8), /--jobs must be at most 16, got 17/);
  assert.throws(() => parseJobs('two', 8), /--jobs expects a whole number/);
  assert.throws(() => parseJobs('1.5', 8), /--jobs expects a whole number/);
});
