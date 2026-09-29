// The app's own write, and somebody else's.
//
//   node test/self-writes.js
//
// The watcher is there to notice edits made outside the app, and the app writes
// the same files itself all day. Every event has to be asked which it is.
//
// It was asked as a stopwatch — anything within a second of an app write was
// that write — and a second is a long time at a keyboard. Save a page in the
// app, save the same file in an editor a moment later, and the editor's change
// landed inside the window and was discarded: the model never reloaded, the
// canvas was never told, and the file went on looking unchanged. "Sometimes I
// don't see the latest changes unless I manually refresh" is that.
//
// A page with a <style> block was worse: the app writes it again 150ms later to
// make the dev server re-extract the styles, and each write restarts the
// stopwatch — about a second and a fifth of blindness after every save.
//
// The question is answerable exactly, because the app knows what it wrote.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);}
};

const { createSelfWrites } = require('../dist/electron/selfWrites.js');

// A filesystem that says what the test wants it to say, and a clock the test
// moves by hand.
const disk = new Map();
let clock = 1000;
const writes = createSelfWrites({
  read: (p) => {
    if (!disk.has(p)) {throw new Error('ENOENT');}
    return disk.get(p);
  },
  now: () => clock,
  windowMs: 1000,
});

const PAGE = '/p/src/pages/index.astro';

// --- the app writes, and hears itself -----------------------------------------
disk.set(PAGE, 'const a = 1;');
writes.note(PAGE, 'const a = 1;');
check('a write the app made is its own echo', writes.isEcho(PAGE) === true);
clock += 5000;
check('however long ago it was — the bytes are still ours', writes.isEcho(PAGE) === true);

// The second write a styled page gets, 150ms later, is the same text again.
clock += 150;
writes.note(PAGE, 'const a = 1;');
check('and the nudge that follows it is too', writes.isEcho(PAGE) === true);

// --- somebody else writes ------------------------------------------------------
disk.set(PAGE, 'const a = 2;');
check('an edit from outside is not our write', writes.isEcho(PAGE) === false, 'the change would be discarded');
// The case the stopwatch could never get right: one millisecond later.
clock = 1000;
disk.set(PAGE, 'const a = 1;');
writes.note(PAGE, 'const a = 1;');
clock += 1;
disk.set(PAGE, 'const a = 3;');
check(
  'even a millisecond after the app wrote the same file',
  writes.isEcho(PAGE) === false,
  'a save in an editor right after one in the app is thrown away'
);

// --- and files the app never wrote ----------------------------------------------
check('a file the app never wrote is nobody’s echo', writes.isEcho('/p/src/other.astro') === false);

// --- what has no text to compare ------------------------------------------------
// A move, a rename, a delete: there is no "what we wrote" to check, so those
// keep the stopwatch. What they changed is that the file is gone or newly
// there, which no comparison of contents can answer.
const MOVED = '/p/public/logo.svg';
clock = 5000;
writes.note(MOVED); // no text
check('a move is ours while it is still happening', writes.isEcho(MOVED) === true);
clock += 1500;
check('and not once the moment has passed', writes.isEcho(MOVED) === false);

// A file the app wrote and something then deleted is not an echo: it cannot be
// read, and what happened to it was not our write.
clock = 8000;
disk.set(PAGE, 'x');
writes.note(PAGE, 'x');
disk.delete(PAGE);
check('a file that has since gone is not our write either', writes.isEcho(PAGE) === false);

// --- the watcher asks it ---------------------------------------------------------
const main = fs.readFileSync(path.join(__dirname, '..', 'dist', 'electron', 'main.js'), 'utf8');
check(
  'the watcher asks about every kind of file it hears about',
  /watchProject\(\{[\s\S]*?isSelfWrite/.test(main) &&
    /if \(isSelfWrite\(changed\)\) \{\s*return;\s*\}/.test(
      fs.readFileSync(path.join(__dirname, '..', 'dist', 'electron', 'projectWatcher.js'), 'utf8'),
    ),
  'the watcher must receive the self-write guard before routing events'
);
check(
  'no stopwatch is left behind anywhere',
  !/Date\.now\(\) - (?:wrote|mine) < 1000/.test(main),
  'a path still decides by elapsed time'
);
{
  // The one that matters most: a page save. Both of its writes — the save and
  // the nudge 150ms later that makes the dev server re-read the styles — have
  // to record what they put there, or the comparison has nothing to compare.
  const writer = main.slice(main.indexOf('function writePageText'), main.indexOf("ipcMain.handle('page:write'"));
  check(
    'a page write says what it wrote',
    (writer.match(/markSelfWrite\(pagePath, text\)/g) || []).length === 2,
    `${(writer.match(/markSelfWrite\(pagePath[^)]*\)/g) || []).join(' , ')}`
  );
  // Step 6: a visual edit writes splices through the page's actor, and says
  // what the file now holds as well.
  const edit = main.slice(main.indexOf("ipcMain.handle('page:edit'"), main.indexOf('function pageEditError'));
  check(
    'a visual edit says what it wrote',
    (edit.match(/markSelfWrite\(pagePath, text\)/g) || []).length === 1,
    edit.slice(0, 200)
  );
}

if (failures.length) {
  console.error(`\nself-writes: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`self-writes: ${checked} passed  [our own write, and somebody else's]`);
