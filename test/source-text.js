// Layout-tolerant reading of source files, for tests that check source as text.
//
// Goal: a few tests guard wiring they can only see in the source — a handler
// bound in App.tsx, an early return, a selector in the stylesheet — and search
// the file's text for it. Those searches used to spell out one line layout, so
// a formatter pass (Prettier's wrapping, braces around one-line bodies, added
// semicolons and trailing commas) or a line-length sweep (long string literals
// split into 'a' + 'b') broke them without the code meaning anything else.
//
// Method: bring both the source and the snippet being looked for to one compact
// form that keeps the tokens and drops only what a formatter is free to change:
//   - adjacent string literals joined with + are merged back into one literal;
//   - all whitespace goes;
//   - a semicolon right before a closing brace goes (the brace ends the
//     statement either way);
//   - a trailing comma right before a closing bracket goes.
// Everything else — names, operators, literals, parentheses, the order of
// statements — must still match exactly, so removing the guarded code still
// fails the check. The compact form is for comparison only; it is not code.
//
// Known blind spots, accepted because the snippets tests look for avoid them:
// whitespace inside string literals is dropped too, and a string whose own
// content is ` + ` between quotes would be read as a join. sourceBlock counts
// braces without skipping strings or comments, so a brace inside a literal in
// the block would end it early or late.

const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('./helpers/sources.js');

// The largest source a test reads. App.tsx is well under a megabyte; the bound
// keeps the brace walk in sourceBlock finite by construction.
const SOURCE_CHARACTERS_MAX = 4 * 1024 * 1024;

// Reads a file relative to the repository root, with line endings normalized.
function readSource(relativePath) {
  const text = fs.readFileSync(repoPath(relativePath), 'utf8');
  if (text.length > SOURCE_CHARACTERS_MAX) {
    throw new Error(`source-text: ${relativePath} exceeds ${SOURCE_CHARACTERS_MAX} characters`);
  }
  return text.replace(/\r\n/g, '\n');
}

// The compact form described above.
function compactSource(text) {
  return text
    .replace(/'\s*\+\s*'/g, '')
    .replace(/"\s*\+\s*"/g, '')
    .replace(/\s+/g, '')
    .replace(/;\}/g, '}')
    .replace(/,([)\]}])/g, '$1');
}

// Whether the source contains the snippet, once both are in compact form.
function containsCode(source, snippet) {
  const needle = compactSource(snippet);
  if (needle.length === 0) {
    throw new Error('source-text: an empty snippet matches everything');
  }
  return compactSource(source).includes(needle);
}

// The text from `start` through the end of the first brace-balanced block that
// follows it: an `if` with its whole body, whatever its line layout. Returns ''
// when `start` is not a position in the source or no balanced block follows, so
// a check built on it fails rather than reading past the block.
function sourceBlock(source, start) {
  if (start < 0) {
    return '';
  }
  const open = source.indexOf('{', start);
  if (open < 0) {
    return '';
  }
  if (source.length > SOURCE_CHARACTERS_MAX) {
    throw new Error(`source-text: source exceeds ${SOURCE_CHARACTERS_MAX} characters`);
  }
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return '';
}

module.exports = { compactSource, containsCode, readSource, sourceBlock };
