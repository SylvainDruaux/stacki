// Scanning .astro source without parsing it: strings and comments skipped,
// matching braces, parentheses and close tags found, and loop and statement
// heads split, all within the bounds the parser states.

import { assert } from '../../shared/core/assert';
import { RAW_ELEMENTS, required } from './astroAttrs';

// ---------------------------------------------------------------------------
// Template parsing
// ---------------------------------------------------------------------------

export const TAG_RE =
  /<([A-Za-z][\w.-]*)((?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/y;

// Index just past the string/comment starting at `i`, or `i` itself when
// nothing starts there. Comments matter as much as strings: `{/* the button's
// background */}` is an ordinary JSX comment, and without this the apostrophe
// opens a "string" that never closes, so the scan runs off the end of the file
// and the whole page is declared unrepresentable.
export function skipStringOrComment(code: string, start: number): number {
  const ch = code.charAt(start);
  // A template literal is the one quote that spans lines, so it is followed
  // wherever it goes.
  if (ch === '`') {
    let position = start + 1;
    while (position < code.length && code.charAt(position) !== ch) {
      if (code.charAt(position) === '\\') {
        position++;
      }
      position++;
    }
    return position + 1;
  }
  if (ch === '"' || ch === "'") {
    // A quote that does not close on its own line is not a string. What it
    // usually is, is an apostrophe: `<Heading>We're here for you</Heading>`.
    // Read as a string opener, it swallowed everything up to the next
    // apostrophe — three hundred lines later, in a CSS comment — and with it
    // the braces that closed the expression it sat inside. The page fell back
    // to code view saying "an unclosed { … } expression", which is exactly what
    // it looked like from in here.
    //
    // Nothing is lost by the rule: a JavaScript string cannot contain a raw
    // line break, and neither can an HTML attribute value in any markup this
    // has to read.
    let j = start + 1;
    while (j < code.length && code.charAt(j) !== ch && code.charAt(j) !== '\n') {
      j += code.charAt(j) === '\\' ? 2 : 1;
    }
    return code.charAt(j) === ch ? j + 1 : start;
  }
  if (ch === '/' && code.charAt(start + 1) === '/') {
    // `https://…` is not a comment, wherever it is written.
    if (code.charAt(start - 1) === ':') {
      return start;
    }
    const nl = code.indexOf('\n', start + 2);
    return nl === -1 ? code.length : nl; // leave the newline itself unconsumed
  }
  if (ch === '/' && code.charAt(start + 1) === '*') {
    const end = code.indexOf('*/', start + 2);
    return end === -1 ? code.length : end + 2;
  }
  return start;
}

// Match either kind of delimiter using the same string/comment rules.
function findMatchingDelimiter(code: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const skipped = skipStringOrComment(code, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = code.charAt(i);
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

export const findMatchingBrace = (code: string, start: number) =>
  findMatchingDelimiter(code, start, '{', '}');
export const findMatchingParen = (code: string, start: number) =>
  findMatchingDelimiter(code, start, '(', ')');

// Recognizes {items.map((item) => ( <JSX/> ))} and turns it into a 'map'
// node whose JSX body is a parsed child tree (editable in the navigator).
// Returns undefined when the expression doesn't fit the pattern.
// The head as one line, for the Loop panel's field and for comparing an edited
// head against the source it came from.
export const normalizeHead = (text: string) => text.replace(/\s+/g, ' ').trim();

// The head's own lines with their shared indentation removed, so the serializer
// can lay them back out under whatever indent the node ends up at.
export function dedentHead(text: string): string {
  const lines = text.split('\n');
  while (lines.length && !required(lines[0], 'First line exists').trim()) {
    lines.shift();
  }
  if (lines.length < 2) {
    return normalizeHead(text);
  }
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => (line.match(/^[ \t]*/)?.[0] ?? '').length);
  const common = Math.min(...indents);
  return lines
    .map((line) => (line.trim() ? line.slice(common) : ''))
    .join('\n')
    .trimEnd();
}

// Splits a statement block on the semicolons that actually end statements —
// not the ones inside strings, template literals, parens, braces, brackets, or
// comments. A comment is skipped whole: prose is allowed a semicolon in it, and
// an apostrophe in it is an apostrophe.
// Each piece says where in `src` it began, so what is found inside it can be
// pointed back at the file it came from.
function topLevelStatements(source: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  const push = (end: number) => out.push({ text: source.slice(start, end), at: start });
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const skipped = skipStringOrComment(source, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const character = source.charAt(i);
    if ('([{'.includes(character)) {
      depth++;
    } else if (')]}'.includes(character)) {
      depth--;
    } else if (character === ';' && depth === 0) {
      push(i);
      start = i + 1;
    } else if (character === '\n' && depth === 0) {
      // Semicolons are optional. A newline ends the statement when what
      // follows starts a new one — the same call JavaScript's own insertion
      // makes, without pretending to be a parser.
      if (/^\s*(const|let|return)\b/.test(source.slice(i))) {
        push(i);
        start = i + 1;
      }
    }
  }
  if (source.slice(start).trim()) {
    push(source.length);
  }
  return out;
}

// Where the code in a statement starts — past any comments in front of it, or
// undefined if a `/*` is left open. A comment is not a statement; it is someone
// telling the next reader why. Reading it as one turned a loop that says why it
// exists into a loop this file refused to open.
function afterComments(text: string): number | undefined {
  let i = 0;
  // Every pass returns or skips a comment of at least two characters.
  for (let pass = 0; pass <= text.length; pass++) {
    while (i < text.length && /\s/.test(text.charAt(i))) {
      i++;
    }
    if (i >= text.length) {
      return text.length;
    }
    if (!(text.charAt(i) === '/' && (text.charAt(i + 1) === '*' || text.charAt(i + 1) === '/'))) {
      return i;
    }
    if (text.charAt(i + 1) === '*' && text.indexOf('*/', i + 2) === -1) {
      return undefined;
    }
    const skipped = skipStringOrComment(text, i);
    if (skipped === i) {
      return i;
    }
    i = skipped;
  }
  assert(false, 'Comments in front of a statement end within its text');
}

// Whether a statement's last word is a comment — a `;` written after one would
// be written inside it.
function endsInComment(text: string): boolean {
  let inside = false;
  for (let i = 0; i < text.length; i++) {
    const skipped = skipStringOrComment(text, i);
    if (skipped !== i) {
      // A string ends a statement as well as any other word does; only a
      // comment swallows what is written after it.
      inside = text.charAt(i) === '/' && !text.slice(skipped).trim();
      i = skipped - 1;
    } else if (text.charAt(i).trim()) {
      inside = false;
    }
  }
  return inside;
}

// `(item) => { const x = …; return ( <jsx/> ); }` — the block form of a loop
// body. It's a loop like any other as long as the statements before the
// `return` are plain declarations: they're kept verbatim on the node and
// written back out, while the returned markup becomes the loop's children.
// Anything else in there (an if, a side effect, more than one return) can't be
// represented, so the whole expression stays code.
// A comment counts as none of that. It rides on the statement it introduces —
// including the `return` — so what it says is still there when the loop is
// written back.
// Returns { body: string[], markup: string, at: number } or undefined, where `at`
// is where the markup starts in `block` — the returned tree is a tree of the
// file, and every node in it has to be able to say which lines are its own.
export function splitBlockLoopBody(
  block: string,
): { body: string[]; markup: string; at: number } | undefined {
  const statements = topLevelStatements(block);
  if (!statements.length) {
    return undefined;
  }
  const body = [];
  for (let i = 0; i < statements.length; i++) {
    const statement = required(statements[i], 'Statement index is in bounds');
    const lead = statement.text.length - statement.text.trimStart().length;
    const raw = statement.text.trim();
    const rawAt = statement.at + lead;
    if (!raw) {
      continue;
    }
    const at = afterComments(raw);
    if (at === undefined) {
      return undefined;
    }
    const after = raw.slice(at);
    const text = after.trim();
    if (!text) {
      // A line of prose standing on its own, between the declarations.
      body.push(raw);
      continue;
    }
    if (/^return\b/.test(text)) {
      // The return must be the last thing in the block.
      if (statements.slice(i + 1).some((rest) => rest.text.trim())) {
        return undefined;
      }
      let markup = text.slice('return'.length);
      let markupAt = rawAt + at + (after.length - after.trimStart().length) + 'return'.length;
      const trimLeft = () => {
        const space = markup.length - markup.trimStart().length;
        markup = markup.trim();
        markupAt += space;
      };
      trimLeft();
      while (markup.startsWith('(') && findMatchingParen(markup, 0) === markup.length - 1) {
        markup = markup.slice(1, -1);
        markupAt += 1;
        trimLeft();
      }
      if (!markup.startsWith('<')) {
        return undefined;
      }
      if (at) {
        body.push(raw.slice(0, at).trim());
      }
      return { body, markup, at: markupAt };
    }
    if (!/^(const|let)\s/.test(text)) {
      return undefined;
    }
    body.push(endsInComment(raw) ? raw : raw.replace(/;*$/, ';'));
  }
  return undefined; // no return statement — nothing is rendered
}

// `data.map((i) => (` → `data.map((i) => {`, for writing a loop that carries
// declarations back out in the shape it was written in.
export const blockHead = (head: string) => head.replace(/\($/, '{');

// ---------------------------------------------------------------------------
// Conditional markup
// ---------------------------------------------------------------------------

// Top-level `?`, `:` and `&&` in a JS expression — the ones that actually
// split it, not the ones nested in a call, an object, a string, or a JSX tag.
// `?.` and `??` are single tokens, and `client:load` is an attribute name, so
// none of those count.
export function topLevelOps(source: string): { op: '?' | ':' | '&&'; at: number }[] {
  const out: { op: '?' | ':' | '&&'; at: number }[] = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const skipped = skipStringOrComment(source, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = source.charAt(i);
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      continue;
    }
    // A JSX tag's own attributes are not part of the expression around it.
    if (ch === '<' && /[A-Za-z/]/.test(source.charAt(i + 1) || '')) {
      let j = i + 1;
      while (j < source.length) {
        const afterSkip = skipStringOrComment(source, j);
        if (afterSkip !== j) {
          j = afterSkip;
          continue;
        }
        if (source.charAt(j) === '>') {
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (ch === '?') {
      if (source.charAt(i + 1) === '?' || source.charAt(i + 1) === '.') {
        i++;
      } // ?? and ?. aren't ternaries
      else {
        out.push({ op: '?', at: i });
      }
    } else if (ch === ':') {
      out.push({ op: ':', at: i });
    } else if (ch === '&' && source.charAt(i + 1) === '&') {
      out.push({ op: '&&', at: i });
      i++;
    }
  }
  return out;
}

// Where the next `<` and `{` are at or after a position, and the nearer of the
// two; -1 for none.
interface Delimiters {
  readonly lt: number;
  readonly br: number;
  readonly next: number;
}

const NOT_SEARCHED = -2;
export const NOT_YET_FOUND: Delimiters = { lt: NOT_SEARCHED, br: NOT_SEARCHED, next: NOT_SEARCHED };

// The delimiters at or after `from`, reusing the previous answer: the parse
// position only moves forward, so a found index stays valid until the position
// passes it, and "none" (-1) stays none.
export function nextDelimiters(template: string, from: number, previous: Delimiters): Delimiters {
  const lt = nextIndexOf(template, '<', from, previous.lt);
  const br = nextIndexOf(template, '{', from, previous.br);
  if (lt === -1) {
    return { lt, br, next: br };
  }
  if (br === -1) {
    return { lt, br, next: lt };
  }
  return { lt, br, next: Math.min(lt, br) };
}

// `template.indexOf(needle, from)`, reusing `previous` — the answer for an earlier
// `from` — while it is still at or after `from`.
function nextIndexOf(template: string, needle: string, from: number, previous: number): number {
  assert(previous >= NOT_SEARCHED, 'A cached index is a position, -1, or not searched');
  if (previous === -1) {
    return -1;
  }
  if (previous >= from) {
    assert(template.charAt(previous) === needle, 'A cached index still names its needle');
    return previous;
  }
  return template.indexOf(needle, from);
}

// Index of the close tag matching an already-consumed open tag, handling
// nested same-name tags.
//
// Text inside a <script>, a <style> or a comment is not markup, and counting
// it as markup loses the whole page. A Webflow export had a script with
// `/* Find the closest parent <section> for hover events */` in it: seven
// `<section`s to this scan and six closes, so the section that really did
// close never balanced, and a page with nothing wrong with it opened as code
// with "an unclosed <section> tag" over it. The same words in an HTML comment
// did the same thing.
//
// So those three are stepped over rather than read. A run that never ends is
// not treated as fatal here — it is only text this scan can't use — so the
// scan carries on past the opener and whatever is really wrong with the page
// is reported by the parse itself.
export function findMatchingClose(template: string, from: number, name: string): number {
  const re = closeTagPattern(name);
  re.lastIndex = from;
  let depth = 1;
  let match;
  while ((match = re.exec(template)) !== null) {
    const [full, raw, selfClose] = match;
    if (full === '<!--') {
      const end = template.indexOf('-->', match.index + 4);
      re.lastIndex = end === -1 ? match.index + 4 : end + 3;
      continue;
    }
    if (raw) {
      const end = template.indexOf(`</${raw}`, match.index + full.length);
      const after = end === -1 ? -1 : template.indexOf('>', end);
      re.lastIndex = after === -1 ? match.index + full.length : after + 1;
      continue;
    }
    if (full.startsWith('</')) {
      depth--;
      if (depth === 0) {
        return match.index;
      }
    } else if (selfClose !== '/') {
      depth++;
    }
  }
  return -1;
}

// A page names few distinct tags, so their close-tag patterns are compiled once
// per parse process instead of once per element (with escapeRe run each time).
// The cache is bounded: past the cap a pattern is compiled and not kept. A
// cached pattern is shared, which is safe because findMatchingClose runs each
// scan to completion — it never recurses — and resets lastIndex first.
const CLOSE_TAG_PATTERNS_MAX = 512;
const closeTagPatterns = new Map<string, RegExp>();

function closeTagPattern(name: string): RegExp {
  const cached = closeTagPatterns.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const tag = escapeRe(name);
  const re = new RegExp(
    `<!--|<(script|style)(?=[\\s/>])|<${tag}(?=[\\s/>])` +
      `(?:[^>"']|"[^"]*"|'[^']*')*?(/?)>|</${tag}\\s*>`,
    'g',
  );
  if (closeTagPatterns.size < CLOSE_TAG_PATTERNS_MAX) {
    closeTagPatterns.set(name, re);
  } else {
    assert(
      closeTagPatterns.size === CLOSE_TAG_PATTERNS_MAX,
      'The pattern cache never exceeds its cap',
    );
  }
  return re;
}

// Fragment delimiters can also occur in quoted attributes, expressions and
// raw scripts. Skip those regions before counting nested <>…</> pairs.
export function findMatchingFragmentClose(template: string, from: number): number {
  let depth = 1;
  for (let position = from; position < template.length;) {
    if (template.charAt(position) === '{') {
      const end = findMatchingBrace(template, position);
      if (end === -1) {
        return -1;
      }
      position = end + 1;
    } else if (template.startsWith('<!--', position)) {
      const end = template.indexOf('-->', position + 4);
      if (end === -1) {
        return -1;
      }
      position = end + 3;
    } else if (template.startsWith('</>', position)) {
      if (--depth === 0) {
        return position;
      }
      position += 3;
    } else if (template.startsWith('<>', position)) {
      depth++;
      position += 2;
    } else if (template.charAt(position) === '<') {
      TAG_RE.lastIndex = position;
      const tag = TAG_RE.exec(template);
      if (!tag) {
        position++;
        continue;
      }
      position += tag[0].length;
      if (RAW_ELEMENTS.has(required(tag[1], 'Raw tag name capture')) && tag[3] !== '/') {
        const close = template.indexOf(`</${tag[1]}`, position);
        const end = close === -1 ? -1 : template.indexOf('>', close);
        if (end === -1) {
          return -1;
        }
        position = end + 1;
      }
    } else {
      position++;
    }
  }
  return -1;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
