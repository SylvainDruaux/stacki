// The loop's data field: a source you can type past.
//
//   node test/loop-source.js
//
// Choosing a list used to replace the whole field with a purple button, which
// said what the source was and left nowhere to say anything else about it. A
// loop is over a list, but it is very often over part of one — `.filter(…)`,
// `.slice(0, 3)`, `[0]` — and none of that could be written without first
// switching the field to a different mode.
//
// So the source is a chip drawn inside the expression, over ordinary text: the
// value is exactly what the field holds, everything after the chip is code, and
// picking a different list swaps the chip while leaving that code alone.

const path = require('path');
const { pathToFileURL } = require('url');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// Test the implementation itself so source-selection rules cannot drift into copied fixtures.
const { sourceChip, withSource, parseMapHead } = require('./helpers/rendererModule')(
  'src/panels/propNodeEditors.tsx',
);
const assert = require('node:assert/strict');
const { repoPath } = require('./helpers/sources.js');
assert.deepEqual(parseMapHead('posts.map((post, index) => ('), {
  data: 'posts',
  item: 'post',
  index: 'index',
});
assert.deepEqual(parseMapHead('posts.filter(p => p.live).map(post => ('), {
  data: 'posts.filter(p => p.live)',
  item: 'post',
  index: '',
});
assert.equal(parseMapHead('posts.map(({title}) => ('), undefined);
assert.equal(parseMapHead(''), undefined);
assert.throws(() => parseMapHead('x'.repeat(1_000_001)), /head limit exceeded/);
assert.throws(() => sourceChip('x'.repeat(1_000_001)), /source limit exceeded/);
assert.throws(() => withSource('posts', 'x'.repeat(1_000_001)), /path limit exceeded/);

(async () => {
  // The panel's own copies, so a change there fails here rather than drifting.
  const source =
    require('fs').readFileSync(repoPath('src/panels/propNodeEditors.tsx'), 'utf8') +
    require('fs').readFileSync(repoPath('src/panels/propBindings.tsx'), 'utf8');
  check('the panel still derives the source the same way', source.includes('function sourceChip('));
  check('and still swaps it in place', source.includes('function withSource('));
  check(
    'the field is the expression, not a button',
    /chip=\{sourceChip\(fields\.data\)\}/.test(source),
    'the Data field no longer passes its source as a chip',
  );

  // What counts as the source.
  check('a lone name is the whole of it', sourceChip('legalEntries') === 'legalEntries');
  check('a path is too', sourceChip('post.data.tags') === 'post.data.tags');
  check('what follows it is not', sourceChip('posts.filter(p => !p.draft)') === 'posts');
  check('an index is not', sourceChip('posts[0]') === 'posts');
  check('nor is a call on it', sourceChip('posts.slice(0, 3)') === 'posts');
  check('no source is no chip', sourceChip('[]') === '');
  check('an empty field is no chip', sourceChip('') === '');
  check('a literal is no chip', sourceChip('[1, 2, 3]') === '');
  check('a function call is no chip', sourceChip('getPosts()') === '', sourceChip('getPosts()'));

  // Choosing a different list keeps the code around it.
  check('picking replaces the source', withSource('posts', 'authors') === 'authors');
  check(
    'and keeps what was done to it',
    withSource('posts.filter(p => !p.draft)', 'authors') === 'authors.filter(p => !p.draft)',
    withSource('posts.filter(p => !p.draft)', 'authors'),
  );
  check(
    'including an index',
    withSource('post.data.tags[0]', 'legalEntries') === 'legalEntries[0]',
    withSource('post.data.tags[0]', 'legalEntries'),
  );
  check('picking into an empty field just sets it', withSource('', 'authors') === 'authors');
  check('and into a literal replaces it', withSource('[1, 2]', 'authors') === 'authors');

  // The chip is the control. A second button beside it opening the same picker
  // was two affordances for one job.
  const chipToggle =
    'onChipClick={() => (sourceMenu ? setSourceMenu(undefined) : openSourceMenu())}';
  check('the chip opens the picker', source.includes(chipToggle));
  check(
    'and nothing else has to',
    !source.includes('prop-source-open'),
    'the chevron beside the Data field is back',
  );
  check(
    'and the press that opens it does not also close it',
    /\.bind-menu, \.bind-handle, \.dd-source, \.cm-chip/.test(source),
    'the picker treats the chip as outside itself, so a chip press opens and closes in one go',
  );

  // Data goes into the expression as well as choosing it: a slice needs its
  // length from somewhere.
  check('the Data field takes an insert', /apiRef=\{dataApiRef\}/.test(source));
  check('and so does the Code field', /apiRef=\{codeApiRef\}/.test(source));
  check(
    'both have a handle to open it with',
    (source.match(/<BindHandle\s+active=\{insertAt\?\.field ===/g) || []).length === 2,
  );

  // Renaming the item is about the source, not the expression: typing a filter
  // after a list — or dropping a value into one — must not rename the item out
  // from under the children that reference it.
  const renames = (before, after) => sourceChip(before) !== sourceChip(after);
  check('a different list renames the item', renames('posts', 'authors'));
  check('a filter typed after it does not', !renames('posts', 'posts.filter(p => !p.draft)'));
  check(
    'nor does a value dropped into one',
    !renames('posts.slice(0, 3)', 'posts.slice(0, count)'),
  );
  check('and a first list still does', renames('[]', 'posts'));

  // The chip is a mark over text, so the value never contains anything but the
  // expression itself.
  const expr = require('fs').readFileSync(repoPath('src/ui/ExprInput.tsx'), 'utf8');
  check(
    'the chip is a mark, not a widget',
    /Decoration\.mark\(\{ class: 'cm-chip' \}\)/.test(expr),
  );
  check('and clicking it is handled', /closest\('\.cm-chip, \.expr-chip'\)/.test(expr));
  check(
    'a chip whose text is edited away stops being one',
    /stops being a chip/.test(expr),
    'the decoration is mapped through edits instead of re-found',
  );

  if (failures.length) {
    console.error(
      `\nloop-source: ${failures.length} failed, ${checked - failures.length} passed\n`,
    );
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`loop-source: ${checked} passed`);
})();
