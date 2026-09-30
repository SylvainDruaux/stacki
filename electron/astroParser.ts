// Parses .astro pages into an editable tree model and serializes the model
// back to clean .astro source.
//
// Node kinds:
//   component — <Hero .../> or <Section>...</Section>; <> uses name Fragment
//   element   — <div>, <img/>, any lowercase tag
//   text      — text content between tags (may contain {expressions})
//   comment   — <!-- ... -->
//   raw       — <style>/<script> blocks whose inner content is kept verbatim
//
// children: null = self-closing, [] = paired-but-empty, [nodes] otherwise.
//
// Pages whose template can't be represented (stray '<', unclosed tags) are
// reported as not editable so the UI falls back to code view.

import fs from 'node:fs';
import { parseSerializeNodes, parseSerializePage } from './astroParser.validation.js';
import path from 'node:path';
import { collapseText, encodeText, textValue } from '../shared/htmlText.js';
import { readFrontmatter, writeFrontmatter } from './frontmatter.js';
import type { FrontmatterModel, ImportMember } from './frontmatter.js';
import { assertTreeInvariants } from '../shared/page-node.js';
import type { Attr, AttrSpan } from '../shared/page-node.js';
import { toUtf16Span } from '../shared/span.js';
import { assert } from '../shared/assert.js';
import { LIMITS } from '../shared/limits.js';
import type {
  ParserNode,
  MapNode,
  CondNode,
  BranchNode,
  ValueNode,
  ParseBail,
  ParsedTemplate,
  ParserPageModel,
  ParsedPage,
  NumberRules,
  DefaultRule,
  StatedDefault,
  PropUnion,
  NormalizedType,
  SchemaField,
  RenderTag,
  SourceLocation,
} from './astroParser.types.js';

export {
  parsePage,
  locateSelection,
  serializePage,
  serializePageMarked,
  parseTemplate,
  serializeNodes,
  resolveChunks,
  markChunkHtml,
  parsePropSchema,
  parseExtendsTag,
  parseSlots,
  defaultSlotInline,
  rootTag,
  numberRules,
  parseAttrs,
  serializeAttrs,
};

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const RAW_ELEMENTS = new Set(['style', 'script']);

// Node ids are structural paths — `n0`, `n0.2`, `n0.2.1` — assigned in one
// pass once a tree is complete (assignPathIds), so a parse is a pure function
// of its text: no counter survives between parses, and nothing can key on
// parse order (plan §4, §11.9). Nodes are built with this placeholder; the
// parser itself never reads an id.
const PENDING_ID = 'n0';
const makeId = (): string => PENDING_ID;

// Give every node of a finished tree its path id; the layout wrapper keeps its
// well-known `layout`. The tree is the parser's own, just built, so this is
// the one place its ids are written. Depth is the tree's bound (asserted).
function assignPathIds(nodes: readonly ParserNode[], prefix: string, depth: number): void {
  assert(depth <= LIMITS.treeDepthMax, 'Path ids are assigned within the depth bound');
  nodes.forEach((node, index) => {
    const path = prefix === '' ? String(index) : `${prefix}.${index}`;
    if (node.id !== 'layout') {
      node.id = `n${path}`;
    }
    if (Array.isArray(node.children)) {
      assignPathIds(node.children, path, depth + 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Attribute (prop) parsing
// ---------------------------------------------------------------------------

// Values: {type:'string'|'expr'|'bare'|'spread', value}
// Expression values may contain one level of nested braces (attrs={{ a: 1 }}).
//
// `{...rest}` is matched first and kept as its own kind. Without that the name
// pattern claims `...rest` as a bare attribute — `.` is a legal attribute
// character — and it is written back WITHOUT its braces, turning
// `<Foo {...rest} />` into `<Foo ...rest />`, which does not compile. Spreads
// are everywhere in Astro, so this corrupts real components.
function parseAttrs(attrString: string): Record<string, Attr> {
  return propsOf(scanAttrs(attrString));
}

function propsOf(scanned: readonly ScannedAttr[]): Record<string, Attr> {
  // Object.fromEntries treats __proto__ as an ordinary attribute. Assigning
  // it on an object invokes the inherited setter and silently drops it.
  return Object.fromEntries(scanned.map((found) => [found.name, found.attr]));
}

// One attribute as written: its props entry plus where each part sits in the
// attribute string. The positions are relative to that string; attrSpansOf
// moves them into file offsets.
interface ScannedAttr {
  readonly name: string;
  readonly attr: Attr;
  readonly from: number;
  readonly to: number;
  readonly nameAt: readonly [number, number] | undefined;
  readonly valueAt: readonly [number, number] | undefined;
}

// The spread body takes one level of nested braces, the same depth the value
// form allows — `{...cond ? { href } : { type: "button" }}` is ordinary Astro,
// and stopping at the first inner brace would truncate it. The `d` flag reports
// where each group matched, which is what the attribute spans are built from:
// one pattern answers both "what does this tag say" and "where does it say it".
const ATTR_PATTERN =
  '\\{\\s*\\.\\.\\.((?:[^{}]|\\{[^{}]*\\})*)\\}|([\\w@:.-]+)' +
  '(?:\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|\\{((?:[^{}]|\\{[' +
  '^{}]*\\})*)\\}))?';

// Compiled once: the `d` flag makes every match report its group indices, and
// building the pattern per tag cost a compile-cache lookup on every element.
// Only scanAttrs uses it, and it runs each scan to completion before returning,
// so the shared lastIndex never interleaves.
const ATTR_RE = new RegExp(ATTR_PATTERN, 'dg');

function scanAttrs(attrString: string): readonly ScannedAttr[] {
  const found: ScannedAttr[] = [];
  const re = ATTR_RE;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    if (!m[0].trim()) {
      continue;
    }
    assert(found.length <= attrString.length, 'Each attribute consumes at least one character');
    found.push(scanAttr(m));
  }
  return found;
}

function scanAttr(m: RegExpExecArray): ScannedAttr {
  const indices = required(m.indices, 'Attribute match indices');
  const from = m.index;
  const to = from + m[0].length;
  const trimmed = (group: number): readonly [number, number] => {
    const [start] = required(indices[group], 'Attribute value indices');
    const raw = required(m[group], 'Attribute value capture');
    const lead = raw.length - raw.trimStart().length;
    return [start + lead, start + lead + raw.trim().length];
  };
  if (m[1] !== undefined) {
    // Keyed by the spread's own text, so two different spreads on one tag
    // stay separate and the order round-trips.
    const expr = m[1].trim();
    const attr: Attr = { type: 'spread', value: expr };
    return { name: `...${expr}`, attr, from, to, nameAt: undefined, valueAt: trimmed(1) };
  }
  const name = required(m[2], 'Attribute name capture');
  const nameAt = required(indices[2], 'Attribute name indices');
  if (m[3] !== undefined || m[4] !== undefined) {
    const group = m[3] !== undefined ? 3 : 4;
    const valueAt = required(indices[group], 'Quoted attribute indices');
    const attr: Attr = { type: 'string', value: required(m[group], 'Quoted attribute capture') };
    return { name, attr, from, to, nameAt, valueAt };
  }
  if (m[5] !== undefined) {
    const attr: Attr = { type: 'expr', value: m[5].trim() };
    return { name, attr, from, to, nameAt, valueAt: trimmed(5) };
  }
  return { name, attr: { type: 'bare' }, from, to, nameAt, valueAt: undefined };
}

// File offsets for every attribute of a tag whose attribute string starts at
// `base`. Built from the same scan as the props, so the two cannot disagree.
function attrSpansOf(scanned: readonly ScannedAttr[], base: number): AttrSpan[] {
  const at = ([start, end]: readonly [number, number]) => toUtf16Span(base + start, base + end);
  return scanned.map((found): AttrSpan => {
    const span = toUtf16Span(base + found.from, base + found.to);
    const { name, attr } = found;
    switch (attr.type) {
      case 'string':
      case 'expr':
        return {
          type: attr.type,
          name,
          span,
          nameSpan: at(required(found.nameAt, 'Named attribute has a name')),
          valueSpan: at(required(found.valueAt, 'Valued attribute has a value')),
        };
      case 'bare':
        return { type: 'bare', name, span, nameSpan: at(required(found.nameAt, 'Bare name')) };
      case 'spread':
        return {
          type: 'spread',
          name,
          span,
          valueSpan: at(required(found.valueAt, 'Spread body')),
        };
    }
  });
}

// A tag whose attributes were written across several lines keeps them there,
// as long as none of them has been edited. Compared with the whitespace taken
// out, so the question asked is "do these say the same thing", not "were they
// laid out the same way". Editing one attribute reflows the tag onto a line,
// which is the same bargain struck everywhere else here.
function attrsAsWritten(node: ParserNode): string | null {
  if (!node.attrSource) {
    return null;
  }
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
  return flat(node.attrSource) === flat(serializeAttrs(node.props, node.attrOrder))
    ? node.attrSource
    : null;
}

// A tag's attributes and the order the file wrote them in. An object remembers
// the order its keys were added, which is the file's order right up until a
// prop is taken out and put back — clearing a field and typing into it again is
// exactly that — and then it returns at the end, behind everything it used to
// sit in front of. One line reordered against the four like it underneath is a
// diff about nothing. So the order is written down when the file is read.
//
// `attrsAt` is where the attribute string starts in the file, or null when no
// offsets were asked for; with it, every attribute also reports its spans.
function tagProps(
  attrs: string,
  attrsAt: number | null,
): { props: Record<string, Attr>; attrOrder?: string[]; attrSpans?: AttrSpan[] } {
  // One scan serves both the props and their spans: scanning twice doubled the
  // cost of every tag with attributes.
  const scanned = scanAttrs(attrs);
  const props = propsOf(scanned);
  const attrOrder = Object.keys(props);
  const spans = attrsAt === null ? {} : { attrSpans: attrSpansOf(scanned, attrsAt) };
  // props is always present — even empty — because writers mutate node.props
  // in place (e.g. fragment tests and panel edits). attrOrder only exists
  // when there is something to order.
  return attrOrder.length ? { props, attrOrder, ...spans } : { props, ...spans };
}

// What the file had, where it had it, then anything added since.
function orderedProps(
  props: Readonly<Record<string, Attr>> | undefined,
  order?: readonly string[],
): ReadonlyArray<readonly [string, Attr]> {
  const entries = Object.entries(props || {});
  if (!order || !order.length) {
    return entries;
  }
  const held = new Map(entries);
  const out: [string, Attr][] = [];
  for (const name of order) {
    if (held.has(name)) {
      out.push([name, required(held.get(name), 'Ordered attribute exists')]);
    }
  }
  const known = new Set(order);
  for (const [name, v] of entries) {
    if (!known.has(name)) {
      out.push([name, v]);
    }
  }
  return out;
}

function serializeAttrs(
  props: Readonly<Record<string, Attr>> | undefined,
  order?: readonly string[],
): string {
  const parts = [];
  for (const [name, v] of orderedProps(props, order)) {
    if (v?.type === 'spread') {
      parts.push(`{...${v.value}}`);
    } else if (v == null || v.type === 'bare') {
      parts.push(name);
    } else if (v.type === 'expr') {
      parts.push(`${name}={${v.value}}`);
    } else {
      parts.push(`${name}="${String(v.value).replace(/"/g, '&quot;')}"`);
    }
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

// ---------------------------------------------------------------------------
// Template parsing
// ---------------------------------------------------------------------------

const TAG_RE = /<([A-Za-z][\w.-]*)((?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/y;

// Index just past the string/comment starting at `i`, or `i` itself when
// nothing starts there. Comments matter as much as strings: `{/* the button's
// background */}` is an ordinary JSX comment, and without this the apostrophe
// opens a "string" that never closes, so the scan runs off the end of the file
// and the whole page is declared unrepresentable.
function skipStringOrComment(str: string, i: number): number {
  const ch = str.charAt(i);
  // A template literal is the one quote that spans lines, so it is followed
  // wherever it goes.
  if (ch === '`') {
    i++;
    while (i < str.length && str.charAt(i) !== ch) {
      if (str.charAt(i) === '\\') {
        i++;
      }
      i++;
    }
    return i + 1;
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
    let j = i + 1;
    while (j < str.length && str.charAt(j) !== ch && str.charAt(j) !== '\n') {
      j += str.charAt(j) === '\\' ? 2 : 1;
    }
    return str.charAt(j) === ch ? j + 1 : i;
  }
  if (ch === '/' && str.charAt(i + 1) === '/') {
    // `https://…` is not a comment, wherever it is written.
    if (str.charAt(i - 1) === ':') {
      return i;
    }
    const nl = str.indexOf('\n', i + 2);
    return nl === -1 ? str.length : nl; // leave the newline itself unconsumed
  }
  if (ch === '/' && str.charAt(i + 1) === '*') {
    const end = str.indexOf('*/', i + 2);
    return end === -1 ? str.length : end + 2;
  }
  return i;
}

// Match either kind of delimiter using the same string/comment rules.
function findMatchingDelimiter(str: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const skipped = skipStringOrComment(str, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = str.charAt(i);
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

const findMatchingBrace = (str: string, start: number) =>
  findMatchingDelimiter(str, start, '{', '}');
const findMatchingParen = (str: string, start: number) =>
  findMatchingDelimiter(str, start, '(', ')');

// Recognizes {items.map((item) => ( <JSX/> ))} and turns it into a 'map'
// node whose JSX body is a parsed child tree (editable in the navigator).
// Returns null when the expression doesn't fit the pattern.
// The head as one line, for the Loop panel's field and for comparing an edited
// head against the source it came from.
const normalizeHead = (text: string) => text.replace(/\s+/g, ' ').trim();

// The head's own lines with their shared indentation removed, so the serializer
// can lay them back out under whatever indent the node ends up at.
function dedentHead(text: string): string {
  const lines = text.split('\n');
  while (lines.length && !required(lines[0], 'First line exists').trim()) {
    lines.shift();
  }
  if (lines.length < 2) {
    return normalizeHead(text);
  }
  const indents = lines.filter((l) => l.trim()).map((l) => (l.match(/^[ \t]*/)?.[0] ?? '').length);
  const common = Math.min(...indents);
  return lines
    .map((l) => (l.trim() ? l.slice(common) : ''))
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
    const c = source.charAt(i);
    if ('([{'.includes(c)) {
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
    } else if (c === ';' && depth === 0) {
      push(i);
      start = i + 1;
    } else if (c === '\n' && depth === 0) {
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
// null if a `/*` is left open. A comment is not a statement; it is someone
// telling the next reader why. Reading it as one turned a loop that says why it
// exists into a loop this file refused to open.
function afterComments(text: string): number | null {
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
      return null;
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
// Returns { body: string[], markup: string, at: number } or null, where `at`
// is where the markup starts in `block` — the returned tree is a tree of the
// file, and every node in it has to be able to say which lines are its own.
function splitBlockLoopBody(block: string): { body: string[]; markup: string; at: number } | null {
  const statements = topLevelStatements(block);
  if (!statements.length) {
    return null;
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
    if (at === null) {
      return null;
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
        return null;
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
        return null;
      }
      if (at) {
        body.push(raw.slice(0, at).trim());
      }
      return { body, markup, at: markupAt };
    }
    if (!/^(const|let)\s/.test(text)) {
      return null;
    }
    body.push(endsInComment(raw) ? raw : raw.replace(/;*$/, ';'));
  }
  return null; // no return statement — nothing is rendered
}

// `data.map((i) => (` → `data.map((i) => {`, for writing a loop that carries
// declarations back out in the shape it was written in.
const blockHead = (head: string) => head.replace(/\($/, '{');

function tryParseMap(exprText: string, base: number | null = null): MapNode | null {
  const inner = exprText.slice(1, -1); // strip the outer { }
  // Every form is tried: the concise matcher's lazy prefix can run past a
  // block body's `=> {`, or past a bare body's `=> <`, and match a NESTED
  // `.map((t) => (` in its markup, so its failure says nothing about whether
  // this is a block-bodied or paren-less loop.
  const inBase = base === null ? null : base + 1;
  return (
    tryParseConciseMap(inner, inBase) ||
    tryParseBareMap(inner, inBase) ||
    tryParseBlockMap(inner, inBase)
  );
}

function tryParseConciseMap(inner: string, base: number | null = null): MapNode | null {
  // The callback's parameter list may be parenthesized — `(post)`, `(post, i)`,
  // `([k, v])` — or a bare name, which is how many people write a one-argument
  // arrow. Both are the same loop; only the first used to be recognized.
  const arrow = inner.match(/^([\s\S]*?\.map\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\()/);
  if (!arrow) {
    return null;
  }
  const headRaw = required(arrow[1], 'Loop header capture');
  const openIdx = arrow[0].length - 1; // the arrow-body '('
  const closeIdx = findMatchingParen(inner, openIdx);
  if (closeIdx === -1) {
    return null;
  }
  // After the body must come only the .map() close paren.
  if (!/^\s*\)\s*$/.test(inner.slice(closeIdx + 1))) {
    return null;
  }
  const body = inner.slice(openIdx + 1, closeIdx);
  // inner starts one char into exprText, and body one char past the arrow '('.
  const parsed = parseTemplate(body, base === null ? null : base + openIdx + 1);
  if (!parsed.clean) {
    return null;
  }
  return {
    id: makeId(),
    kind: 'map',
    head: normalizeHead(headRaw), // e.g. "stats.map((stat) => ("
    // A chain written across several lines — `posts` / `.sort(…)` / `.map(…)` —
    // is one line once normalized, and writing that back would flatten how the
    // page was written. Keep the original layout to re-emit while the head
    // still says the same thing; see serializeNode's 'map' case.
    headSource: dedentHead(headRaw),
    children: parsed.nodes,
  };
}

// The same loop with no parentheses around its body — `.map((x) => <Tag/>)`,
// the shape an arrow function returning a single element is usually written in.
// The body runs to the `)` that closes `.map(`, so that paren is found rather
// than assumed. Normalized to the same node the parenthesized form produces,
// with `bare` remembering how it was written.
function tryParseBareMap(inner: string, base: number | null = null): MapNode | null {
  const arrow = inner.match(/^([\s\S]*?\.map\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*)</);
  if (!arrow) {
    return null;
  }
  const headRaw = required(arrow[1], 'Loop header capture');
  const mapOpen = headRaw.lastIndexOf('.map(') + '.map'.length;
  const mapClose = findMatchingParen(inner, mapOpen);
  if (mapClose === -1) {
    return null;
  }
  // After the body must come only the .map() close paren.
  if (inner.slice(mapClose + 1).trim()) {
    return null;
  }
  const parsed = parseTemplate(
    inner.slice(headRaw.length, mapClose),
    base === null ? null : base + headRaw.length,
  );
  if (!parsed.clean) {
    return null;
  }
  return {
    id: makeId(),
    kind: 'map',
    head: normalizeHead(headRaw + '('), // the Loop editor reads one shape
    bare: true,
    children: parsed.nodes,
  };
}

// The same loop, written with a statement body. Normalized to the same node
// the concise form produces — head ending in `=> (` so the Loop editor reads
// it unchanged — with the declarations parked in `body` for serializing back.
function tryParseBlockMap(inner: string, base: number | null = null): MapNode | null {
  const arrow = inner.match(/^([\s\S]*?\.map\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*)\{/);
  if (!arrow) {
    return null;
  }
  const headRaw = required(arrow[1], 'Loop header capture');
  const openIdx = arrow[0].length - 1; // the arrow-body '{'
  const closeIdx = findMatchingBrace(inner, openIdx);
  if (closeIdx === -1) {
    return null;
  }
  // After the block must come only the .map() close paren.
  if (!/^\s*\)\s*$/.test(inner.slice(closeIdx + 1))) {
    return null;
  }
  const split = splitBlockLoopBody(inner.slice(openIdx + 1, closeIdx));
  if (!split) {
    return null;
  }
  const parsed = parseTemplate(split.markup, base === null ? null : base + openIdx + 1 + split.at);
  if (!parsed.clean) {
    return null;
  }
  return {
    id: makeId(),
    kind: 'map',
    head: normalizeHead(headRaw + '('),
    body: split.body,
    children: parsed.nodes,
  };
}

// ---------------------------------------------------------------------------
// Conditional markup
// ---------------------------------------------------------------------------

// Top-level `?`, `:` and `&&` in a JS expression — the ones that actually
// split it, not the ones nested in a call, an object, a string, or a JSX tag.
// `?.` and `??` are single tokens, and `client:load` is an attribute name, so
// none of those count.
function topLevelOps(source: string): { op: '?' | ':' | '&&'; at: number }[] {
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
        const s = skipStringOrComment(source, j);
        if (s !== j) {
          j = s;
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

// One side of a conditional, as child nodes. `null` means "this isn't markup",
// which sends the whole expression back to being opaque code.
// `base` is where `raw` starts in the file, or null when nobody is asking for
// offsets. Trimming and peeling move that start, so it is advanced as they go —
// without it every node inside a conditional came back unplaced, and a
// component written as `{render && ( … )}` (which is most of them) could not
// turn a selection into a line range at all.
function branchNodes(raw: string, base: number | null = null): ParserNode[] | null {
  const text = String(raw);
  let t = text.trimStart();
  let at = base === null ? null : base + (text.length - t.length);
  t = t.trimEnd();
  // Peel the wrapping parens the JSX convention adds: `? ( <img/> ) :`.
  while (t.startsWith('(') && findMatchingParen(t, 0) === t.length - 1) {
    const inner = t.slice(1, -1);
    const trimmed = inner.trimStart();
    if (at !== null) {
      at += 1 + (inner.length - trimmed.length);
    }
    t = trimmed.trimEnd();
  }
  // The ways of writing "render nothing here".
  if (t === '' || /^(null|undefined|false|''|"")$/.test(t)) {
    return [];
  }
  if (t.startsWith('<')) {
    // A failed probe must not claim the page's bail message — the caller
    // falls back to an expression node and the page still parses.
    const saved = parseState.lastBail;
    const parsed = parseTemplate(t, at);
    if (parsed.clean) {
      return parsed.nodes;
    }
    parseState.lastBail = saved;
    return null;
  }
  // `a ? (…) : b ? (…) : (…)` — an else-if chain, which reads as a condition
  // nested in the else branch.
  const nested = parseCondSource(t, at);
  if (nested && at !== null) {
    nested.start = at;
    nested.end = at + t.length;
  }
  return nested ? [nested] : null;
}

// A branch spans its side of the conditional as written, whitespace trimmed:
// `( <p/> )` after the `?`, or the markup after the `&&`.
function makeBranch(
  name: 'then' | 'else',
  children: ParserNode[],
  raw: string,
  base: number | null,
): BranchNode {
  const branch: BranchNode = { id: makeId(), kind: 'branch', name, children };
  if (base !== null) {
    const start = base + (raw.length - raw.trimStart().length);
    branch.start = start;
    branch.end = Math.max(start, base + raw.trimEnd().length);
  }
  return branch;
}

// Whether a branch renders markup, as opposed to a value.
const branchIsMarkup = (kids: readonly ParserNode[] | null) =>
  (kids || []).some((k) => k.kind !== 'expr' && k.kind !== 'text');

// The other side of a conditional whose one side is markup: a plain value, as
// an expression child.
//
// `{href ? (<a …>{heading}</a>) : (heading)}` — the LinkCard pattern — used to
// be code in the navigator, whole, because one of its branches was a bare name
// rather than a tag. Which meant a conditional around an anchor read as a wall
// of JSX, and neither the anchor nor the fallback could be selected.
//
// Written with braces, like every other expression node: it lands in JSX
// context on the canvas (inside the branch's Fragment). The writer takes them
// off again for the file, where a branch's parens are JS.
function exprBranch(raw: string, base: number | null = null): ParserNode[] | null {
  const text = String(raw);
  let t = text.trimStart();
  let at = base === null ? null : base + (text.length - t.length);
  t = t.trimEnd();
  while (t.startsWith('(') && findMatchingParen(t, 0) === t.length - 1) {
    const inner = t.slice(1, -1);
    const trimmed = inner.trimStart();
    if (at !== null) {
      at += 1 + (inner.length - trimmed.length);
    }
    t = trimmed.trimEnd();
  }
  // Markup that failed to parse is not a value — sending it back as an opaque
  // expression would hide a real bail behind a node that looks fine.
  if (!t || t.startsWith('<')) {
    return null;
  }
  const node: ParserNode = { id: makeId(), kind: 'expr', value: `{${t}}` };
  if (at !== null) {
    node.start = at;
    node.end = at + t.length;
  }
  return [node];
}

// `test ? ( … ) : ( … )` and `test && ( … )` as a structural node. Returns null
// for anything whose branches aren't markup (a ternary picking between two
// strings, say) — those stay code.
function parseCondSource(source: string, base: number | null = null): CondNode | null {
  if (parseState.conditions >= LIMITS.treeDepthMax) {
    return null;
  }
  parseState.conditions++;
  try {
    return parseCondSourceBody(source, base);
  } finally {
    parseState.conditions--;
    assert(parseState.conditions >= 0, 'Conditional recursion unwinds to its caller');
  }
}

function parseCondSourceBody(source: string, base: number | null): CondNode | null {
  const raw = String(source);
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const from = base === null ? null : base + (raw.length - raw.trimStart().length);
  const ops = topLevelOps(text);
  const ternary = ops.find((o) => o.op === '?');
  if (ternary) {
    const colon = ops.find((o) => o.op === ':' && o.at > ternary.at);
    if (!colon) {
      return null;
    }
    const test = text.slice(0, ternary.at).trim();
    if (!test) {
      return null;
    }
    const thenRaw = text.slice(ternary.at + 1, colon.at);
    const elseRaw = text.slice(colon.at + 1);
    let thenKids = branchNodes(thenRaw, from === null ? null : from + ternary.at + 1);
    let elseKids = branchNodes(elseRaw, from === null ? null : from + colon.at + 1);
    // One side is markup and the other is a value — the common shape of "wrap
    // this in a link when there's somewhere to go". The value side becomes an
    // expression child rather than sending the whole conditional back to code.
    // Both sides being values (`a ? "x" : "y"`) is a value, not markup, and
    // stays as it was.
    if (thenKids && !elseKids && branchIsMarkup(thenKids)) {
      elseKids = exprBranch(elseRaw, from === null ? null : from + colon.at + 1);
    } else if (elseKids && !thenKids && branchIsMarkup(elseKids)) {
      thenKids = exprBranch(thenRaw, from === null ? null : from + ternary.at + 1);
    }
    if (!thenKids || !elseKids) {
      return null;
    }
    return {
      id: makeId(),
      kind: 'cond',
      op: '?',
      test,
      children: [
        makeBranch('then', thenKids, thenRaw, from === null ? null : from + ternary.at + 1),
        makeBranch('else', elseKids, elseRaw, from === null ? null : from + colon.at + 1),
      ],
    };
  }
  // `a && b && (<x/>)`: everything up to the LAST && is the test.
  const ands = ops.filter((o) => o.op === '&&');
  const and = ands[ands.length - 1];
  if (!and) {
    return null;
  }
  const test = text.slice(0, and.at).trim();
  if (!test) {
    return null;
  }
  const thenRaw = text.slice(and.at + 2);
  const thenAt = from === null ? null : from + and.at + 2;
  const kids = branchNodes(thenRaw, thenAt);
  if (!kids || !kids.length) {
    return null;
  } // `x && null` is not worth a node
  return {
    id: makeId(),
    kind: 'cond',
    op: '&&',
    test,
    children: [makeBranch('then', kids, thenRaw, thenAt)],
  };
}

// Recognizes conditional markup — {cond ? ( … ) : ( … )}, {cond && ( … )} —
// and turns it into a 'cond' node whose branches are parsed child trees, so
// each side is navigable and editable instead of a wall of code.
function tryParseMapWithSource(exprText: string, base: number | null = null): MapNode | null {
  const node = tryParseMap(exprText, base);
  if (node) {
    node.source = exprText;
  }
  return node;
}

function tryParseCond(exprText: string, base: number | null = null): CondNode | null {
  const node = parseCondSource(exprText.slice(1, -1), base === null ? null : base + 1);
  // The text it was written as. A condition that has not been edited is
  // written back exactly, rather than reflowed onto the shape this file would
  // choose — `{x && <p/>}` is not improved by becoming four lines.
  if (node) {
    node.source = exprText;
  }
  return node;
}

// What made the last parse give up, so the code-view banner can name the
// construct and point at it instead of listing everything it might have been.
// parseTemplate recurses into children, and the innermost frame is the one that
// actually found the problem — so only the first bail of a run is kept, and
// parsePage clears it before starting.
const parseState: { lastBail: ParseBail | null; depth: number; nodes: number; conditions: number } =
  {
    lastBail: null,
    depth: 0,
    nodes: 0,
    conditions: 0,
  };
function bail(nodes: ParserNode[], str: string, at: number, what: string): ParsedTemplate {
  if (!parseState.lastBail) {
    parseState.lastBail = { what, near: str.slice(at, at + 60) };
  }
  return { nodes, clean: false };
}

// Parses a template string into a node tree.
// Returns {nodes, clean}; clean=false means unrepresentable content was found.
//
// `base` is the offset of `str` within the file it was read from; pass a
// number and every node comes back tagged with `start`/`end` source offsets
// (what locateSelection turns into line numbers). The editor's own parse
// leaves it null on purpose: offsets describe the file as it was on disk and
// go stale the moment the model is mutated, so only a fresh parse may use them.
function parseTemplate(str: string, base: number | null = null): ParsedTemplate {
  if (typeof str !== 'string') {
    return bail([], '', 0, 'a non-string template');
  }
  if (str.length > LIMITS.ipcFieldCharsMax) {
    return bail([], '', 0, 'a template exceeding the source limit');
  }
  if (parseState.depth > LIMITS.treeDepthMax) {
    return bail([], str, 0, 'markup exceeding the nesting limit');
  }
  if (parseState.depth === 0) {
    parseState.nodes = 0;
  }
  parseState.depth++;
  try {
    const result = parseTemplateBody(str, base);
    if (parseState.depth === 1 && result.clean && !parseTemplateWithinBounds(result.nodes)) {
      return bail([], str, 0, 'markup exceeding the tree limits');
    }
    if (parseState.depth === 1) {
      assignPathIds(result.nodes, '', 0); // A template on its own is a tree too.
    }
    return result;
  } finally {
    parseState.depth--;
    assert(parseState.depth >= 0, 'Template recursion unwinds to its caller');
  }
}

function parseTemplateBody(str: string, base: number | null): ParsedTemplate {
  const nodes: ParserNode[] = [];
  let pos = 0;
  // Blank lines between nodes are the author's paragraphing. They are not
  // nodes themselves — the whitespace they live in is dropped — so they are
  // counted here and carried on whatever comes next, to be written back out
  // in front of it. Without this a save closed up every gap in the file.
  let pendingBlank = 0;
  // Where whitespace-only text sat between two nodes. It carries no words, so
  // it is no node — except in an inline run, where the newline and indent
  // between `</a>` and `<span>` is the space the page shows between them. The
  // run's shape isn't known until every sibling is in, so the positions are
  // noted here and the spaces put back at the end.
  const gaps: { readonly index: number; readonly from: number; readonly to: number }[] = [];
  const emit = (node: ParserNode) => {
    if (pendingBlank) {
      node.blankBefore = pendingBlank;
      pendingBlank = 0;
    }
    nodes.push(node);
    parseState.nodes++;
    return node;
  };

  // Tags a node with its source range and returns it — a no-op when offsets
  // weren't asked for.
  const at = (node: ParserNode, from: number, to: number): ParserNode =>
    parseTemplateAt(node, base, from, to);

  // Searching afresh every iteration rescanned the same text once per tag
  // whenever the next brace was far away — quadratic in a brace-free region.
  let found = NOT_YET_FOUND;
  while (pos < str.length) {
    if (parseState.nodes >= LIMITS.treeNodesMax) {
      return bail(nodes, str, pos, 'markup exceeding the node limit');
    }
    found = nextDelimiters(str, pos, found);
    const { lt, br, next } = found;

    // Trailing / inter-tag text. Boundary whitespace collapses to a single
    // space rather than vanishing — "people <strong>" must keep its space
    // (HTML renders a newline+indent boundary as one space too).
    const textEnd = next === -1 ? str.length : next;
    const text = str.slice(pos, textEnd);
    if (!text.trim() && text) {
      // Whitespace only: no node, but remember any blank line inside it.
      const breaks = (text.match(/\n/g) || []).length;
      if (breaks > 1) {
        pendingBlank = Math.max(pendingBlank, breaks - 1);
      }
      if (nodes.length) {
        gaps.push({ index: nodes.length, from: pos, to: textEnd });
      }
    }
    if (text.trim()) {
      // `source` when the collapsed value isn't the whole truth: a slice that
      // spans lines (the serializer hands those lines back if nothing has
      // edited the node since), and one written with entities in it — `&copy;`
      // and `©` are the same character to a reader and not to a diff, and the
      // file's own spelling is the file's to keep.
      const node: ParserNode = { id: makeId(), kind: 'text', value: textValue(text) };
      if (text.includes('\n') || /&[#a-zA-Z]/.test(text)) {
        node.source = text;
      }
      emit(at(node, pos, textEnd));
    }
    if (next === -1) {
      break;
    }

    // {expression} — a recognized .map() becomes a structural loop node and a
    // recognized ternary/&& becomes a condition; anything else is kept
    // verbatim as an opaque node (may contain JSX).
    if (next === br && (lt === -1 || br < lt)) {
      const close = findMatchingBrace(str, br);
      if (close === -1) {
        return bail(nodes, str, br, 'an unclosed { … } expression');
      }
      const exprText = str.slice(br, close + 1);
      // `{/* … */}` is a comment that happens to be written the way markup
      // requires inside JSX. It is the same thing as `<!-- … -->` to everyone
      // reading the file — and to this app, where a comment above a node is
      // that node's note — so it is one here too, remembering which of the two
      // forms it was written in so it goes back the same way.
      const node = parseTemplateExpression(exprText, base === null ? null : base + br);
      emit(at(node, br, close + 1));
      pos = close + 1;
      continue;
    }

    const tag = parseTemplateMarkup(str, lt, base);
    switch (tag.kind) {
      case 'bail':
        return bail(nodes, str, lt, tag.what);
      case 'child-bail':
        return { nodes, clean: false };
      case 'tag':
        emit(tag.node);
        pos = tag.end;
        break;
    }
  }

  // The gaps that turned out to be inside an inline run become the single
  // space a browser renders them as. Without this, editing anything in
  // `<a>Docs</a> <span>/</span>` — which the serializer writes back as one
  // line — closed the words up into `Docs/`, on the page as well as in the
  // panel. A gap after the last node is the indent before the closing tag and
  // renders as nothing, so it is left out.
  parseTemplateGaps(nodes, gaps, base);
  return { nodes, clean: true, trailingBlank: pendingBlank };
}

// Where the next `<` and `{` are at or after a position, and the nearer of the
// two; -1 for none.
interface Delimiters {
  readonly lt: number;
  readonly br: number;
  readonly next: number;
}

const NOT_SEARCHED = -2;
const NOT_YET_FOUND: Delimiters = { lt: NOT_SEARCHED, br: NOT_SEARCHED, next: NOT_SEARCHED };

// The delimiters at or after `from`, reusing the previous answer: the parse
// position only moves forward, so a found index stays valid until the position
// passes it, and "none" (-1) stays none.
function nextDelimiters(str: string, from: number, previous: Delimiters): Delimiters {
  const lt = nextIndexOf(str, '<', from, previous.lt);
  const br = nextIndexOf(str, '{', from, previous.br);
  if (lt === -1) {
    return { lt, br, next: br };
  }
  if (br === -1) {
    return { lt, br, next: lt };
  }
  return { lt, br, next: Math.min(lt, br) };
}

// `str.indexOf(needle, from)`, reusing `previous` — the answer for an earlier
// `from` — while it is still at or after `from`.
function nextIndexOf(str: string, needle: string, from: number, previous: number): number {
  assert(previous >= NOT_SEARCHED, 'A cached index is a position, -1, or not searched');
  if (previous === -1) {
    return -1;
  }
  if (previous >= from) {
    assert(str.charAt(previous) === needle, 'A cached index still names its needle');
    return previous;
  }
  return str.indexOf(needle, from);
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
function findMatchingClose(str: string, from: number, name: string): number {
  const re = closeTagPattern(name);
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(str)) !== null) {
    const [full, raw, selfClose] = m;
    if (full === '<!--') {
      const end = str.indexOf('-->', m.index + 4);
      re.lastIndex = end === -1 ? m.index + 4 : end + 3;
      continue;
    }
    if (raw) {
      const end = str.indexOf(`</${raw}`, m.index + full.length);
      const after = end === -1 ? -1 : str.indexOf('>', end);
      re.lastIndex = after === -1 ? m.index + full.length : after + 1;
      continue;
    }
    if (full.startsWith('</')) {
      depth--;
      if (depth === 0) {
        return m.index;
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
function findMatchingFragmentClose(str: string, from: number): number {
  let depth = 1;
  for (let pos = from; pos < str.length;) {
    if (str.charAt(pos) === '{') {
      const end = findMatchingBrace(str, pos);
      if (end === -1) {
        return -1;
      }
      pos = end + 1;
    } else if (str.startsWith('<!--', pos)) {
      const end = str.indexOf('-->', pos + 4);
      if (end === -1) {
        return -1;
      }
      pos = end + 3;
    } else if (str.startsWith('</>', pos)) {
      if (--depth === 0) {
        return pos;
      }
      pos += 3;
    } else if (str.startsWith('<>', pos)) {
      depth++;
      pos += 2;
    } else if (str.charAt(pos) === '<') {
      TAG_RE.lastIndex = pos;
      const tag = TAG_RE.exec(str);
      if (!tag) {
        pos++;
        continue;
      }
      pos += tag[0].length;
      if (RAW_ELEMENTS.has(required(tag[1], 'Raw tag name capture')) && tag[3] !== '/') {
        const close = str.indexOf(`</${tag[1]}`, pos);
        const end = close === -1 ? -1 : str.indexOf('>', close);
        if (end === -1) {
          return -1;
        }
        pos = end + 1;
      }
    } else {
      pos++;
    }
  }
  return -1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Page parse / serialize
// ---------------------------------------------------------------------------

// Returns {editable: true, model} or {editable: false, reason}.
// model = {imports, extraFrontmatter, nodes: tree}. The page's layout wrapper
// (if any) stays in the tree as a regular node with the well-known id
// 'layout', so nodes can live before/after it at the top level.
// `opts.locs` records source offsets on every node and the body's own start
// offset on the model — for reading a location out of the file on disk, not
// for the editor's live model (see parseTemplate).
function parsePage(source: string, opts: { readonly locs?: boolean } = {}): ParsedPage {
  if (typeof source !== 'string' || source.length > LIMITS.ipcFieldCharsMax) {
    return {
      editable: false,
      reason: 'Page source is invalid or exceeds the size limit.',
      bail: null,
    };
  }
  // Try the empty block first.
  // Otherwise `---\n---\n--- prose` consumes the real close as code and
  // mistakes the start of the prose for a second closing fence.
  // A leading byte-order mark is an encoding signal, not content (plan §3.2):
  // the fences are matched past it, and offsets still count it so they index
  // the file as read. No write touches it: an edit is splices of other bytes.
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const fm = source.slice(bom).match(/^---\r?\n(?:---|([\s\S]*?\r?\n)---)\r?\n?/);
  const frontmatter = fm ? fm[1] || '' : '';
  const hadFrontmatter = !!fm;
  const bodyStart = bom + (fm ? fm[0].length : 0);
  const body = source.slice(bodyStart);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  const frontmatterModel = readFrontmatter(frontmatter);
  const { imports } = frontmatterModel;

  resetParseBail();
  const {
    nodes: topNodes,
    clean,
    trailingBlank,
  } = parseTemplate(body, opts.locs ? bodyStart : null);
  // A newline at the very start of the body is a blank line, because the
  // frontmatter's closing --- already ended its own line. Everywhere else a
  // leading newline is just the break after the tag before it, which is why
  // parseTemplate counts one fewer — so the first node is told directly.
  if (topNodes.length) {
    const lead = (body.match(/^(?:[ \t]*\r?\n)+/) || [''])[0];
    const blanks = (lead.match(/\n/g) || []).length;
    const first = required(topNodes[0], 'First top-level node exists');
    if (blanks) {
      first.blankBefore = blanks;
    } else {
      delete first.blankBefore;
    }
  }
  if (!clean) {
    // Name the construct and point at it. The bail records the text it stopped
    // on, so find that text back in the file for a line number — far more
    // actionable than "something in this page".
    let where = '';
    if (parseState.lastBail) {
      const at = source.indexOf(parseState.lastBail.near);
      const line = at === -1 ? 0 : source.slice(0, at).split('\n').length;
      where = ` Found ${parseState.lastBail.what}${line ? ` on line ${line}` : ''}.`;
    }
    return {
      editable: false,
      reason: `Page contains markup the visual editor cannot represent.${where}`,
      bail: parseState.lastBail
        ? { what: parseState.lastBail.what, near: parseState.lastBail.near }
        : null,
    };
  }

  // Type-only specifiers name types, not values, so nothing on the page can be
  // one of them — they must not count as "this component is imported".
  const importsByName = Object.fromEntries(
    imports.filter((i) => !i.typeOnly).map((i) => [i.name, i]),
  );

  // Layout detection: a single top-level component wrapping the whole page,
  // or — when siblings live outside it — exactly one top-level component
  // whose import path mentions "layout". The wrapper keeps its place in the
  // tree; it's just tagged with the well-known id 'layout'. A lone top-level
  // component the page never imported is content (a component used as a tag,
  // e.g. a snippet page), not a layout: only an import makes it a layout.
  parsePageLayout(topNodes, importsByName);

  // A capitalized tag that isn't imported is a dynamic tag, not a component:
  // `const Tag = tag` then `<Tag>` is how an Astro component renders a
  // caller-chosen element. Flag those so the UI treats them as elements —
  // they have no file to open and no props of their own.
  parsePageMarkDynamic(topNodes, importsByName);

  assignPathIds(topNodes, '', 0);
  // Producer-side invariant check (paired with parsePageResult at the IPC
  // boundary): a tree that violates this never leaves the parser.
  assertTreeInvariants(topNodes);

  return {
    editable: true,
    model: {
      ...frontmatterModel,
      hadFrontmatter,
      trailingBlank,
      eol,
      nodes: topNodes,
      // Only when offsets were asked for: it describes the file on disk, and
      // the live model is edited out from under it.
      ...(opts.locs ? { bodyStart } : {}),
    },
  };
}

// A shared source-aware writer keeps the preview, file and code editor in
// agreement. The surrounding page writer supplies the last line break.
function serializeFrontmatter(
  model: FrontmatterModel,
  lines: string[],
  specFor?: (imp: ImportMember) => string,
): void {
  const text = writeFrontmatter(model, specFor);
  if (text) {
    lines.push(text.replace(/\r?\n$/, ''));
  }
}

function serializePage(input: unknown): string {
  const model = parseSerializePage(input);
  // A file that never had a frontmatter block does not acquire one. Writing
  // `---` twice at the top of a component that had none is a change to every
  // line number in it, for nothing.
  const fmLines: string[] = [];
  serializeFrontmatter(model, fmLines);
  const lines: string[] = [];
  if (fmLines.length || model.hadFrontmatter !== false) {
    lines.push('---', ...fmLines, '---');
  }

  for (const node of model.nodes) {
    serializeNode(node, '', lines);
  }
  // Blank lines the file ended on.
  for (let i = 0; i < (model.trailingBlank || 0); i++) {
    lines.push('');
  }
  const source = lines.join('\n') + '\n';
  return model.eol === '\r\n' ? source.replace(/\r?\n/g, '\r\n') : source.replace(/\r\n/g, '\n');
}

// Inline runs (text + simple tags like <strong>/<em>) serialize on a single
// line so the exact spacing between words and tags survives the round trip.
const INLINE_TAGS = new Set([
  'strong',
  'em',
  'b',
  'i',
  'sup',
  'sub',
  'code',
  'a',
  'span',
  'br',
  'small',
  'mark',
  'u',
  's',
]);

// Simple {expr} interpolations (single braces, no JSX) count as inline.
function isSimpleExpr(n: ParserNode): boolean {
  return n.kind === 'expr' && /^\{[^{}]*\}$/.test(n.value) && !n.value.includes('<');
}

function isInlineRun(nodes: readonly ParserNode[]): boolean {
  return (
    nodes.length > 0 &&
    nodes.every(
      (n) =>
        n.kind === 'text' ||
        isSimpleExpr(n) ||
        (n.kind === 'element' &&
          INLINE_TAGS.has(n.name.toLowerCase()) &&
          (n.children === null || n.children.length === 0 || isInlineRun(n.children))),
    )
  );
}

function inlineString(nodes: readonly ParserNode[]): string {
  let out = '';
  for (const n of nodes) {
    // Same rule as a text node on its own (see the 'text' case in
    // serializeNode): the file keeps its own spelling of a character until
    // somebody edits the words, and then the characters are what there is.
    if (n.kind === 'text') {
      out += textOut(n);
    } else if (n.kind === 'expr') {
      out += n.value;
    } else if (n.kind !== 'element') {
      assert(false, 'Inline runs contain only text, expressions, and elements');
    } else if (n.children === null) {
      out += n.name === 'br' ? '<br />' : `<${n.name}${serializeAttrs(n.props, n.attrOrder)} />`;
    } else if (n.children.length === 0) {
      // Written as a pair with nothing between them. Closing it as `<span />`
      // says the same thing to a browser and a different thing to a diff.
      out += `<${n.name}${serializeAttrs(n.props, n.attrOrder)}></${n.name}>`;
    } else {
      out +=
        `<${n.name}${serializeAttrs(n.props, n.attrOrder)}>` +
        inlineString(n.children) +
        `</${n.name}>`;
    }
  }
  return out;
}

// Paths for the nodes inside an inline run, written onto the tags themselves.
// A marker pair can't go there — the serializer puts each marker on its own
// line, and those newlines render as spaces, which moves the words — so until
// now nothing inside a run could be outlined or reported as rendered, and a
// link in a sentence read as a node that wasn't on the page at all. The
// collector already resolves a path from `data-avb-p` (it is how a slotted
// element is addressed), so the attribute does the whole job and adds nothing
// to the DOM. The stored `source` goes: it would put the run back verbatim,
// tags and all, without them.
function tagInlineRun(nodes: readonly ParserNode[], path: string, atRoot = false): ParserNode[] {
  return nodes.map((n, i) => {
    if (n.kind !== 'element') {
      return n;
    }
    const childPath = `${path}.${i}`;
    const forwards = Object.keys(n.props || {}).some((key) => key.startsWith('...'));
    const pathProp: Attr =
      atRoot || forwards
        ? {
            type: 'expr',
            value:
              `[${JSON.stringify(childPath)}, Astro.props["data-avb-p"]]` +
              '.filter(Boolean).join(" ")',
          }
        : { type: 'string', value: childPath };
    const tagged: ParserNode = {
      ...n,
      source: undefined,
      // As on a block element, the explicit marker precedes a spread: HTML
      // keeps the first duplicate attribute, which must name this child too.
      props: forwards
        ? { 'data-avb-p': pathProp, ...n.props }
        : { ...n.props, 'data-avb-p': pathProp },
      attrOrder: forwards && n.attrOrder ? ['data-avb-p', ...n.attrOrder] : n.attrOrder,
    };
    if (Array.isArray(n.children) && n.children.length > 0) {
      tagged.children = tagInlineRun(n.children, childPath);
    }
    return tagged;
  });
}

// A node still saying exactly what the file said keeps the lines it was
// written on — the same bargain `headSource` strikes for a loop head. A text
// node with no `source` never had lines to lose, so its value is the original.
function textAsWritten(node: ValueNode): string | null {
  if (!node.source) {
    return node.value;
  }
  return textValue(node.source) === node.value ? node.source : null;
}

// A text node on its way into the file. Untouched, the file keeps its own
// spelling of a character — `&copy;` goes back as `&copy;`, not as the © it was
// read as, which would be the editor rewriting a page it was only asked to
// open. Edited (or never read from a file at all), the characters are what
// there is, and the three that would otherwise be markup — plus the spaces a
// source file cannot show — become entities again.
function textOut(node: ValueNode): string {
  const source = node.source;
  return source != null && textValue(source) === node.value
    ? collapseText(source)
    : encodeText(node.value);
}

// Whitespace inside an inline run is collapsed by the renderer, so the run can
// be shifted to a new indent without changing a thing about the page. Worth
// doing: an element that has been moved, or whose ancestor was re-indented,
// would otherwise hold the indentation of wherever it used to live. The last
// line of the stored inner is the whitespace before the closing tag, which is
// the indent the element was written at.
function reindentRun(source: string, indent: string): string {
  const lines = source.split('\n');
  const base = required(lines[lines.length - 1], 'Split source has a final line');
  if (lines.length < 2 || !/^[ \t]*$/.test(base) || base === indent) {
    return source;
  }
  let shift: (line: string) => string;
  if (indent.startsWith(base)) {
    const add = indent.slice(base.length);
    shift = (line) => (line.trim() ? add + line : line);
  } else if (base.startsWith(indent)) {
    const drop = base.slice(indent.length);
    shift = (line) => (line.startsWith(drop) ? line.slice(drop.length) : line);
  } else {
    return source; // tabs against spaces — no shift that isn't a guess
  }
  return [lines[0], ...lines.slice(1, -1).map(shift), indent].join('\n');
}

// Whitespace between two inline tags lives in text nodes the tree drops, so
// comparing runs has to ignore it entirely rather than merely collapse it.
const squash = (t: string) => t.replace(/\s+/g, '');

// Does an element's stored inner still describe the run hanging off it? Both
// sides collapse to the same words when nothing has been edited: a changed
// word, an added child or a rewritten inline tag all break the match, and the
// run is reflowed onto one line as before. Compared trimmed because the
// whitespace-only tail before a closing tag is in the source and not in the
// tree — which is the whole reason the source is kept.
function inlineRunUnchanged(node: ParserNode): boolean {
  return (
    !!node.source &&
    node.source.includes('\n') &&
    // Compared in the file's own spelling on both sides: inlineString writes
    // `&rsquo;` back as `&rsquo;` for a node nobody has touched, and decoding
    // one side would call every hand-wrapped run with an entity in it changed
    // — reflowing the paragraph onto one line for having been looked at.
    squash(collapseText(node.source)) === squash(inlineString(node.children ?? []))
  );
}

// A block — a condition, a loop — as the file wrote it, or null once anything
// inside it has changed. It is rebuilt the way this file would write it from
// scratch and the two are compared with whitespace and this file's own
// brackets taken out, so the question is whether they say the same thing
// rather than whether they were laid out the same way. Rebuilding by running
// the serializer over a copy with the source removed means there is only one
// description of how these are written, and this cannot drift from it.
function blockAsWritten(node: ParserNode, indent: string): string[] | null {
  if (!node.source) {
    return null;
  }
  const probe = { ...node, source: undefined, blankBefore: 0, blankAfter: 0 };
  const rebuilt: string[] = [];
  serializeNode(probe, '', rebuilt);
  const flat = (t: string) => t.replace(/[\s(){}]+/g, '').trim();
  if (flat(rebuilt.join('\n')) !== flat(node.source)) {
    return null;
  }
  const sourceLines = node.source.split('\n');
  const finalLine = required(sourceLines[sourceLines.length - 1], 'Source has a final line');
  const base = (finalLine.match(/^[ \t]*/) || [''])[0];
  return sourceLines.map((line, i) =>
    i === 0 ? indent + line : line.startsWith(base) ? indent + line.slice(base.length) : line,
  );
}

// A conditional without the { } that put it in markup context. An else-if
// chain is one of these directly inside another's else — writing the braces
// there would make it an object literal, not a nested condition.
function serializeCondBody(node: CondNode, indent: string, lines: string[]): void {
  const kidsOf = (i: number) => node.children?.[i]?.children || [];
  const thenKids = kidsOf(0);
  const elseKids = node.op === '&&' ? null : kidsOf(1);
  const chained =
    elseKids && elseKids.length === 1 && elseKids[0]?.kind === 'cond' ? elseKids[0] : null;
  // `()` is a syntax error, so a branch holding nothing is written as `null` —
  // the same thing a hand-written conditional does.
  const tail = elseKids === null ? '' : chained ? ' :' : elseKids.length ? ' : (' : ' : null';
  const head = `${node.test} ${node.op === '&&' ? '&&' : '?'} `;
  // A branch's parens are JS, not JSX: an expression goes in there as itself.
  // `{heading}` would be a block, and `{ a: 1 }` an object — neither is what
  // the author wrote.
  const branchOut = (kids: readonly ParserNode[], at: string) => {
    if (kids.length === 1 && kids[0]?.kind === 'expr') {
      const raw = String(kids[0].value ?? '')
        .trim()
        .replace(/^\{/, '')
        .replace(/\}$/, '');
      raw.split('\n').forEach((line, i) => lines.push(i === 0 ? at + line : line));
      return;
    }
    for (const child of kids) {
      serializeNode(child, at, lines);
    }
  };
  if (thenKids.length) {
    lines.push(indent + head + '(');
    branchOut(thenKids, indent + '  ');
    lines.push(indent + ')' + tail);
  } else {
    lines.push(indent + head + 'null' + tail);
  }
  if (chained) {
    serializeCondBody(chained, indent, lines);
  } else if (elseKids && elseKids.length) {
    branchOut(elseKids, indent + '  ');
    lines.push(indent + ')');
  }
}

function serializeNode(node: ParserNode, indent: string, lines: string[]): void {
  // Chunk containers: children live in external .html files (set:html),
  // never in the page — emit the component self-closing, skip the subtree.
  if (node.kind === 'chunk-group') {
    return;
  } // synthetic, not in page source
  // The gap the author left in front of this node.
  for (let i = 0; i < (node.blankBefore || 0); i++) {
    lines.push('');
  }
  if (node.chunkFile || node.chunkAggregate) {
    lines.push(`${indent}<${node.name}${serializeAttrs(node.props, node.attrOrder)} />`);
    return;
  }
  switch (node.kind) {
    case 'text':
      return serializeNodeText(node, indent, lines);
    case 'expr': {
      // Verbatim, multi-line safe: only the first line gets the tree indent
      // (subsequent lines carry their original indentation).
      const exprLines = node.value.split('\n');
      lines.push(indent + exprLines[0]);
      for (let i = 1; i < exprLines.length; i++) {
        lines.push(required(exprLines[i], 'Expression line index is in bounds'));
      }
      return;
    }
    case 'map':
      return serializeNodeMap(node, indent, lines);
    case 'cond': {
      const kept = blockAsWritten(node, indent);
      if (kept) {
        for (const line of kept) {
          lines.push(line);
        }
        return;
      }
      lines.push(indent + '{');
      serializeCondBody(node, indent + '  ', lines);
      lines.push(indent + '}');
      return;
    }
    case 'branch':
      // Written by the condition above; standing on its own it is just its
      // contents.
      for (const child of node.children || []) {
        serializeNode(child, indent, lines);
      }
      return;
    case 'comment':
      lines.push(node.jsx ? `${indent}{/*${node.value}*/}` : `${indent}<!--${node.value}-->`);
      return;
    case 'raw-line':
      lines.push(indent + node.value);
      return;
    case 'raw':
      return serializeNodeRaw(node, indent, lines);
    case 'component':
    case 'element':
      return serializeNodeElement(node, indent, lines);
  }
}

// Dev-preview variant used by the marker Vite plugin: wraps every node in
// <!--avb-s:path--> / <!--avb-e:path--> boundary comments (path = index trail,
// e.g. "0.2.1") so the preview iframe can map rendered DOM back to model nodes.
//
// Comments, not elements. A <template> is an element like any other as far as
// the tree is concerned: it counts for :nth-child, :first-child, + and ~, so
// every marker shifted the page's own structural selectors by one for as long
// as it was in the DOM — which is until the preview strips them, i.e. through
// first paint. A comment node is invisible to all of those, so the page a
// marked build renders is the page the real build renders.
// Children of {…map} loops render once per item and are left unmarked.
// Chunk subtrees can't be marked here — they render from an imported HTML
// string, not from page markup — so the ?raw import carries the Fragment's
// path and the dev plugin marks the chunk module itself. Passing it through
// the id (rather than a side map) also keys Vite's cache: move the Fragment
// and the chunk module's id changes with it.
// `prefix` namespaces every path so a component file’s markers cannot collide
// with the page’s. A page marks as "0.1"; src/components/Card.astro marks as
// "src/components/Card.astro|0.1", and the app asks for that namespace while
// that component is the file being edited.
function serializePageMarked(input: unknown, prefix = ''): string {
  const model = parseSerializePage(input);
  const marks = chunkImportMarks(model);
  const lines = ['---'];
  // Through the same writer as a real save: `frontmatterLead` is ordinary
  // frontmatter that happens to sit above the imports, and a preview that
  // dropped it would be missing whatever it declares.
  serializeFrontmatter(model, lines, (imp) => {
    const mark = /\.html\?raw$/i.test(imp.path) ? marks.get(imp.name) : null;
    return mark ? `${imp.path}&avb=${mark.path}${mark.group ? '&avbg=1' : ''}` : imp.path;
  });
  lines.push('---');
  // The file's own roots: what a caller sees of this file is whatever these
  // put on the page, so they are where a caller's name for this instance
  // belongs (see `atRoot`).
  model.nodes.forEach((node, i) =>
    serializeNodeMarked(node, '', lines, `${prefix}${i}`, false, true),
  );
  return lines.join('\n') + '\n';
}

// A marker that survives wherever it's put.
//
// A comment is the ideal marker — invisible to :nth-child and friends — but
// Astro's compiler DROPS html comments that are direct children of a
// component, which on a page wrapped in a layout is the entire tree. Verified
// against @astrojs/compiler: kept at the top level and inside elements,
// stripped in slot content. Where a plain comment wouldn't survive, the same
// comment goes in as raw html through a Fragment, which renders nothing of
// its own — so what lands in the DOM is still just a comment.
//
// A marker for a node in a NAMED slot has to carry the `slot` attribute, or it
// lands in the default slot while the node it marks renders in the named one —
// and an attribute needs something to sit on. A <template> was that something
// for a while, and a <template> is an element: it counts for :nth-child,
// :first-child, + and ~, and it sits in the page between the slot's real
// children until the canvas takes it out again. Which is the whole thing
// comments were chosen to avoid, reintroduced in the one place nobody looks.
//
// A <Fragment> takes attributes and renders no element of its own, so it can
// carry both the slot and the comment: what lands in that slot is a comment
// and nothing else.
const markerFor = (path: string, kind: 's' | 'e', inSlotContent: boolean, slotAttr = '') =>
  inSlotContent || slotAttr
    ? `<Fragment${slotAttr} set:html={${JSON.stringify(`<!--avb-${kind}:${path}-->`)}} />`
    : `<!--avb-${kind}:${path}-->`;

// `inSlot` says this node is a direct child of a component, i.e. slot content —
// which decides how the marker has to be written, since Astro's compiler drops
// a plain html comment there.
//
// Every element and component also carries its path as an attribute, which is
// the marker that survives what happens to the page after Astro is done with
// it. A component doesn't have to render `<slot />` and leave it at that: it
// can render the slot to a string and put the string back with `set:html`,
// which is how it asks "did my slot render anything?" — and the usual way to
// answer is to drop html comments before looking, since a comment is content
// that isn't:
//
//   const content = await slots.render('default');
//   return content.replace(/<!--[\s\S]*?-->/g, '').trim();  // ← markers gone
//
// Nothing on the page then answers to those paths. The navigator reported
// every row inside such a component as rendering nothing, on a page where they
// were plainly on screen, and nothing in there could be clicked or outlined.
//
// It can't be narrowed to slot content, either: what is being scrubbed is
// everything the slot rendered, which includes the output of every component
// inside it. <Tabs> written at the top of its own file, its markers a page
// away from any slot, still lost every one of them for being placed inside a
// <Section>. So the path rides on the markup everywhere — as the same
// `data-avb-p` the collector writes at runtime, and invisible to :nth-child,
// :first-child, + and ~ in a way a marker node could never be.
//
// On a component the attribute is a prop, and reaching the DOM is then up to
// that component — which is why every file's own ROOT elements carry whatever
// name they were called by, alongside their own (`atRoot`). Waiting for the
// author to spread `{...rest}` was not good enough: a slider written without
// one, placed in a <Section> that scrubs comments, had no marker left and no
// attribute either, so nothing on the page answered to it. The navigator
// showed it as rendering nothing while it was plainly on screen, it drew no
// outline, and it could not be clicked.
//
// The markers stay either way: they are what works when nothing interferes,
// they say where a node ENDS, and they carry the nodes an attribute can't
// (text, a loop, a branch).
function serializeNodeMarked(
  node: ParserNode,
  indent: string,
  lines: string[],
  path: string,
  inSlot = false,
  atRoot = false,
): void {
  if (node.kind === 'chunk-group') {
    return;
  } // synthetic, not in page source
  // A slotted node can't simply be wrapped: a marker beside it lands in the
  // default slot while the node itself renders in the named one, so the pair
  // ends up around nothing. Its markers travel with it by carrying the same
  // `slot`, and an attribute needs something to sit on.
  //
  // An element doesn't need wrapping at all: tag it with its path directly,
  // which is the same attribute the collector writes onto every element it
  // records. No extra node, nothing for a selector to trip over.
  //
  // Everything else that can hold an attribute — a component — gets the comment
  // form: a <Fragment slot="…" set:html> carries the slot and renders no
  // element, so what lands in that slot is a comment and the node. In a project
  // whose components read a slot by rendering it to a string and scrubbing the
  // comments out (a common way to ask "did my slot render anything?"), that
  // comment is scrubbed with them — and the path still arrives, because the
  // instance carries it as a prop and its own root writes it onto the DOM.
  //
  // Which leaves the node that can hold no attribute at all: <Fragment
  // slot="…">, which puts nothing of its own on the page and takes no props
  // this could ride on. Its markers go INSIDE it, as its first and last
  // children — the Fragment renders nothing but its contents, so they travel
  // into the named slot with them and need no `slot` of their own. Nothing is
  // added to the slot but two comments.
  //
  // That was a <template> pair, and a <template> is an element: it is a child,
  // it is counted by :nth-child and :last-child, and it is matched by `> *`.
  // CSS written for the children a component is given — which is most CSS
  // written for a component — sees one child that isn't there in the real
  // build. Nothing this writes may be a child.
  const { tagInPlace, markWithin, slotAttr, carryPath, markedProps, attrOrder } =
    serializeNodeMarkedRoute(node, path, atRoot);
  if (!tagInPlace && !markWithin) {
    lines.push(indent + markerFor(path, 's', inSlot, slotAttr));
  }
  // Serialized with the path attribute already on it (see above). <Fragment>
  // and <slot> are left out: neither puts an element on the page, so there is
  // nothing for the attribute to ride on.
  if (
    (node.kind === 'component' || node.kind === 'element') &&
    !node.chunkFile &&
    !node.chunkAggregate &&
    Array.isArray(node.children) &&
    // Inline runs serialize as one line — markers between words would break
    // spacing (each marker's surrounding newlines render as a space).
    !(node.children.length > 0 && isInlineRun(node.children))
  ) {
    const attrs = serializeAttrs(markedProps, attrOrder);
    lines.push(`${indent}<${node.name}${attrs}>`);
    // A slotted Fragment's own markers, riding inside it (see markWithin).
    // Inside a component, which is what a Fragment is, a plain comment is
    // dropped by the compiler — so they go in the way slot content does.
    if (markWithin) {
      lines.push(indent + '  ' + markerFor(path, 's', true));
    }
    node.children.forEach((child, i) =>
      serializeNodeMarked(
        child,
        indent + '  ',
        lines,
        `${path}.${i}`,
        node.kind === 'component',
        node.name === 'Fragment' && atRoot,
      ),
    );
    if (markWithin) {
      lines.push(indent + '  ' + markerFor(path, 'e', true));
    }
    lines.push(`${indent}</${node.name}>`);
  } else if (node.kind === 'map') {
    if (serializeNodeMarkedMap(node, indent, lines, path, atRoot) === 'complete') {
      return;
    }
  } else if (node.kind === 'cond') {
    serializeNodeMarkedCond(node, indent, lines, path, atRoot);
  } else if (node.kind === 'branch') {
    // No markup of its own — just its contents, wrapped by the marker pair
    // this function already emits around every node.
    (node.children || []).forEach((child, i) =>
      serializeNodeMarked(child, indent, lines, `${path}.${i}`, inSlot, atRoot),
    );
  } else {
    const base = carryPath ? { ...node, props: markedProps, attrOrder } : node;
    serializeNodeMarkedInline(base, indent, lines, path, atRoot);
  }
  if (!tagInPlace && !markWithin) {
    lines.push(indent + markerFor(path, 'e', inSlot, slotAttr));
  }
}

// ---------------------------------------------------------------------------
// Component prop schema extraction
// ---------------------------------------------------------------------------

// Returns [{name, type: 'string'|'number'|'boolean'|'other', optional, default}]
// Splits a type expression on a top-level operator, ignoring ones inside
// braces, parens, brackets or strings.
function splitTypeTop(expr: string, op: string): string[] {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const skipped = skipStringOrComment(expr, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const c = expr.charAt(i);
    if ('([{<'.includes(c)) {
      depth++;
    } else if (')]}>'.includes(c)) {
      depth--;
    } else if (c === op && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

// A member block written on one line (`{ variant: "fixed"; sizes?: never }`)
// holds several members between semicolons. Both walkers below read one member
// per line, so the top-level semicolons become newlines first — nested ones
// (inside a nested object or a generic) are left alone.
function explodeMembers(block: string): string {
  return splitTypeTop(block, ';').join('\n');
}

// `prelude` carries type declarations this file imports from elsewhere. A
// component is free to write `type Props = SeoProps` with SeoProps in
// types.ts, and without the declaration text there is nothing to read — the
// panel would show a component with no props at all. The caller (which has
// What a doc comment promises about a prop's fallback. Returns a value when it
// names exactly one, a hint when it names several, and nothing when it is
// prose. Used twice: once for the field itself, and once per union branch,
// where a prop written in several branches has a different answer in each.
function statedDefault(doc: string | undefined): StatedDefault {
  if (!doc) {
    return {};
  }
  const stated =
    doc.match(/defaults?\s*(?:to|:)\s*\`([^\`]+)\`/i) ||
    doc.match(/defaults?\s*(?:to|:)\s*([^\`.,;]+)/i);
  if (!stated) {
    return {};
  }

  // "Defaults to `webp`, or `svg` for SVG sources" is TWO answers, and which
  // one applies depends on a prop only the component can weigh. Asserting the
  // first would have the panel show `webp` while the build emits `svg`.
  //
  // Naming a second value is the tell, whatever word joins them. Asking for
  // "for", "when", "if" or "on" as well let "Defaults to `Play`, or `Pause`
  // while pressed" through as a plain default of Play, and the panel offered
  // Play on a close button. A list of joining words is always one word short;
  // two backticked values in one clause cannot be anything but two answers.
  // Prose still needs those words, having no second value to count.
  const clause = (doc.match(/defaults?\s*(?:to|:)\s*((?:`[^`]*`|[^.])+)/i) || [])[1] || '';
  const named = clause.match(/`[^`]+`/g) || [];
  const conditional =
    named.length > 1 ||
    (/\bor\b/i.test(clause) &&
      /\b(?:for|when|if|on|while|unless|with|without|depending)\b/i.test(clause));
  if (conditional) {
    const hint = clause
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*passthrough\s*/i, ' ')
      .trim();

    // A clause that names the prop it turns on can be answered rather than
    // only reported: "Defaults to `Next`, or `Previous` when direction is
    // `back`" is a rule the panel can weigh, because direction is a prop it
    // already has. The bare form — "or `Pause` when pressed" — reads a
    // boolean prop being true.
    const rule =
      clause.match(
        new RegExp(
          '^\\s*`([^`]+)`.*?\\bor\\b\\s*`([^`]+)`\\s*(?:when|whi' +
            'le|if)\\s+([A-Za-z_$][\\w$]*)\\s+(?:is|=|===)\\s*`?(' +
            '[^`\\s.,]+)`?',
          'i',
        ),
      ) ||
      clause.match(
        /^\s*`([^`]+)`.*?\bor\b\s*`([^`]+)`\s*(?:when|while|if)\s+([A-Za-z_$][\w$]*)\s*$/i,
      );
    if (rule) {
      return {
        hint,
        when: {
          prop: required(rule[3], 'Default condition prop capture'),
          is: rule[4] === undefined ? 'true' : String(rule[4]),
          then: required(rule[2], 'Conditional default capture'),
          otherwise: required(rule[1], 'Fallback default capture'),
        },
      };
    }
    return hint ? { hint } : {};
  }

  const text = required(stated[1], 'Stated default capture')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (text && text.length <= 24 && !/\s(the|a|an|whatever|sensible)\s/i.test(` ${text} `)) {
    return { value: /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text };
  }
  return {};
}

// file access; this doesn't) resolves and reads them.
function parsePropSchema(source: string, prelude = ''): SchemaField[] {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = (prelude ? prelude + '\n' : '') + (fm ? fm[1] : '');
  const aliases = parsePropSchemaAliases(frontmatter);

  // Which type describes the props. `Astro.props as X` names it outright;
  // otherwise it's Props. Both are consulted when both exist — a component can
  // export a strict discriminated `Props` and destructure through a widened
  // alias, and between them they hold the whole picture.
  const asType = frontmatter.match(/Astro\.props\s+as\s+([A-Za-z_$][\w$]*)/);
  const propsDecl = frontmatter.match(
    new RegExp(
      '(?:export\\s+)?(?:interface|type)\\s+Props\\b\\s*(?:' +
        'extends\\s+([^{=]+))?(?:=)?\\s*([\\s\\S]*?)(?=\\n(?:e' +
        'xport\\s+)?(?:type|interface|const|let|function|\\' +
        '/\\/|\\/\\*)|\\n---|$)',
      '',
    ),
  );
  const blocks = parsePropSchemaBlocks(aliases, propsDecl, asType);
  const unions = parsePropSchemaUnions(aliases, propsDecl, asType);
  const sharedDoc = parsePropSchemaSharedDoc(unions);
  const { rawTypes, noted } = parsePropSchemaRawTypes(aliases, blocks);
  const schema = parsePropSchemaFields(aliases, rawTypes, noted, sharedDoc, unions);
  parsePropSchemaDestructure(frontmatter, schema);
  const splitFallback = parsePropSchemaSplitFallback(unions);
  parsePropSchemaFallbacks(frontmatter, schema, splitFallback);
  return [...schema.values()];
}

function parsePropSchemaExpandAlias(
  aliases: ReadonlyMap<string, string>,
  part: string,
  seen = new Set<string>(),
): string[] {
  const body = aliases.get(part);
  if (!body || seen.has(part) || /[{}]/.test(body) || seen.size >= LIMITS.treeDepthMax) {
    return [part];
  }
  seen.add(part);
  return splitTypeTop(body, '|').flatMap((p) =>
    parsePropSchemaExpandAlias(aliases, p.trim(), seen),
  );
}

function parsePropSchemaMemberBlocks(
  aliases: ReadonlyMap<string, string>,
  expr: string | undefined,
  seen = new Set<string>(),
  out: string[] = [],
): string[] {
  if (!expr || seen.size > 12) {
    return out;
  }
  let i = 0;
  while (i < expr.length) {
    if (expr.charAt(i) === '{') {
      const close = findMatchingBrace(expr, i);
      if (close === -1) {
        break;
      }
      out.push(expr.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
    if (id) {
      if (aliases.has(id[0]) && !seen.has(id[0])) {
        seen.add(id[0]);
        parsePropSchemaMemberBlocks(aliases, aliases.get(id[0]), seen, out);
      }
      i += id[0].length;
      continue;
    }
    i++;
  }
  return out;
}

function parsePropSchemaCollectUnions(
  aliases: ReadonlyMap<string, string>,
  unionTables: string[][],
  expr: string | null | undefined,
  seen = new Set<string>(),
): void {
  if (!expr || seen.size >= LIMITS.treeDepthMax) {
    return;
  }
  for (const part of splitTypeTop(expr, '&')) {
    // The declaration's own semicolon rides along on the last part.
    const inner = part.replace(/;\s*$/, '').replace(/^\(([\s\S]*)\)$/, '$1');
    const arms = splitTypeTop(inner, '|');
    if (arms.length >= 2) {
      // An arm is an object literal, a named alias, or an intersection of
      // them — resolve each to the members it contributes.
      const branches = arms.map((a) => parsePropSchemaMemberBlocks(aliases, a, new Set(), []));
      if (branches.every((b) => b.length)) {
        unionTables.push(branches.map((blocks) => blocks.join('\n')));
        continue;
      }
    }
    const id = inner.match(/^[A-Za-z_$][\w$]*$/);
    if (id && aliases.has(id[0]) && !seen.has(id[0])) {
      seen.add(id[0]);
      parsePropSchemaCollectUnions(aliases, unionTables, aliases.get(id[0]), seen);
    }
  }
}

function parsePropSchemaShapeOf(aliases: ReadonlyMap<string, string>, parts: readonly string[]) {
  // A union of two different shapes has no one shape to offer.
  if (parts.length !== 1) {
    return null;
  }
  const only = required(parts[0], 'Shape has exactly one type').trim();
  const arr = only.match(/^([\s\S]*)\[\]$/) || only.match(/^Array<([\s\S]*)>$/);
  const inner = (arr ? required(arr[1], 'Array element type capture') : only)
    .trim()
    .replace(/^\((.*)\)$/s, '$1')
    .trim();
  const body = inner.startsWith('{') ? inner : aliases.get(inner);
  if (!body || !body.trim().startsWith('{')) {
    return null;
  }
  // Inside the braces: a member's `;` is only a separator out here, and with
  // the braces still on, a whole one-line type reads as a single member whose
  // type is the rest of the interface.
  const inside = body.trim().replace(/^\{/, '').replace(/\}$/, '');
  const members = [...parsePropSchemaMemberEntries(inside)].map(([memberName, memberType]) => ({
    name: memberName,
    type: normalizeType(memberType).type,
  }));
  if (!members.length) {
    return null;
  }
  return { list: !!arr, members };
}

function parsePropSchemaMemberEntries(block: string) {
  const out = new Map<string, string>();
  // Line by line first — that reads members written one per line, including
  // several separated by commas rather than semicolons.
  for (const line of explodeMembers(block).split('\n')) {
    // The separator this member ended with, if any — explodeMembers has
    // already cut the top-level ones, so whatever is left inside the type is
    // the type's own. Refusing a `;` there cost every prop written the way
    // TypeScript writes an object: `items?: { title: string; text: string }[]`
    // matched nothing at all, so the prop fell through to the destructuring
    // — where it has no type — and a list of rows came out as raw code.
    const text = line.trim().replace(/[;,]\s*$/, '');
    const m = text.match(/^(?:readonly\s+)?([\w$]+)\??\s*:\s*([\s\S]+)$/);
    if (m) {
      out.set(required(m[1], 'Member name capture'), required(m[2], 'Member type capture').trim());
    }
  }
  // …then whole members, for a type that spans lines:
  //   variant?:
  //     | "stack"
  //     | "card";
  // No single line of that is a member, so the scan above sees nothing and
  // the prop vanishes from its branch — which is how a six-option variant
  // came out as a text field instead of a dropdown.
  for (const raw of splitTypeTop(block, ';')) {
    const flat = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/[{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!flat.includes('\n') && out.size && !/\|/.test(flat)) {
      continue;
    }
    const m = flat.match(/^(?:readonly\s+)?([\w$]+)\??\s*:\s*(.+?),?$/);
    if (m && !out.has(required(m[1], 'Member name capture'))) {
      out.set(required(m[1], 'Member name capture'), required(m[2], 'Member type capture').trim());
    }
  }
  return out;
}

function parsePropSchemaMemberDocs(block: string) {
  const out = new Map<string, string>();
  let doc: string[] = [];
  let inBlock = false;
  for (const raw of explodeMembers(block).split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      doc.push((end === -1 ? line : line.slice(0, end)).replace(/^\*+\s?/, ''));
      if (end !== -1) {
        inBlock = false;
      }
      continue;
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/');
      doc.push((end === -1 ? line.slice(2) : line.slice(2, end)).replace(/^\*+\s?/, ''));
      inBlock = end === -1;
      continue;
    }
    if (line.startsWith('//')) {
      doc.push(line.slice(2).trim());
      continue;
    }
    if (!line) {
      doc = [];
      continue;
    }
    const m = line.match(/^(?:readonly\s+)?([\w$]+)\??\s*:\s*([^;\n]+?)[;,]?\s*$/);
    if (m) {
      const text = doc.join(' ').replace(/\s+/g, ' ').trim();
      if (text) {
        out.set(required(m[1], 'Member name capture'), text);
      }
      doc = [];
    }
  }
  return out;
}

function parsePropSchemaAliases(frontmatter: string): Map<string, string> {
  // Collect local type aliases (type HeadingTag = "h1" | "h2" | ...) so props
  // referencing them resolve to their union options.
  //
  // The declaration ends at the semicolon that closes it, which has to be
  // found by scanning: stopping at the first `;` truncates any alias whose
  // body is an object, because every member ends in one — `type Base = { a:
  // string; b: number }` would come back as `{ a: string`.
  const aliases = new Map<string, string>();
  const declRe = /(?:^|\n)\s*(?:export\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)\s*/g;
  let dm;
  while ((dm = declRe.exec(frontmatter)) !== null) {
    const after = declRe.lastIndex;
    let body;
    if (dm[1] === 'interface') {
      // `interface X extends Y { … }` — the braces are the body.
      const open = frontmatter.indexOf('{', after);
      if (open === -1) {
        continue;
      }
      const close = findMatchingBrace(frontmatter, open);
      if (close === -1) {
        continue;
      }
      const heritage = frontmatter.slice(after, open).replace(/^\s*extends\s+/, '');
      body = `${heritage} ${frontmatter.slice(open, close + 1)}`;
    } else {
      const eq = frontmatter.indexOf('=', after);
      if (eq === -1) {
        continue;
      }
      let i = eq + 1;
      let depth = 0;
      for (; i < frontmatter.length; i++) {
        const skipped = skipStringOrComment(frontmatter, i);
        if (skipped !== i) {
          i = skipped - 1;
          continue;
        }
        const c = frontmatter.charAt(i);
        if ('([{'.includes(c)) {
          depth++;
        } else if (')]}'.includes(c)) {
          depth--;
        } else if (c === ';' && depth === 0) {
          break;
        }
      }
      body = frontmatter.slice(eq + 1, i);
    }
    aliases.set(required(dm[2], 'Type alias name capture'), body.trim());
  }
  return aliases;
}

function parsePropSchemaBlocks(
  aliases: ReadonlyMap<string, string>,
  propsDecl: RegExpMatchArray | null,
  asType: RegExpMatchArray | null,
): string[] {
  const blocks: string[] = [];
  if (propsDecl) {
    // `interface Props extends HTMLAttributes<"button">` — the extended type
    // is part of the shape too.
    if (propsDecl[1]) {
      parsePropSchemaMemberBlocks(aliases, propsDecl[1], new Set(), blocks);
    }
    parsePropSchemaMemberBlocks(aliases, propsDecl[2], new Set(), blocks);
  }
  if (asType && aliases.has(required(asType[1], 'Asserted props type capture'))) {
    parsePropSchemaMemberBlocks(
      aliases,
      aliases.get(required(asType[1], 'Asserted props type capture')),
      new Set(),
      blocks,
    );
  }
  return blocks;
}

function parsePropSchemaUnions(
  aliases: ReadonlyMap<string, string>,
  propsDecl: RegExpMatchArray | null,
  asType: RegExpMatchArray | null,
): PropUnion[] {
  const unionTables: string[][] = [];
  parsePropSchemaCollectUnions(aliases, unionTables, propsDecl && propsDecl[2]);
  parsePropSchemaCollectUnions(
    aliases,
    unionTables,
    asType && aliases.get(required(asType[1], 'Asserted props type capture')),
  );
  const unions: PropUnion[] = [];

  for (const branchBlocks of unionTables) {
    const maps = branchBlocks.map(parsePropSchemaMemberEntries);
    const docMaps = branchBlocks.map(parsePropSchemaMemberDocs);
    const names = new Set(maps.flatMap((m) => [...m.keys()]));
    const branches = maps.map((m, at) => {
      const forbids = [];
      const pins: Record<string, string[]> = {};
      // What this branch's own doc comments say a prop falls back to. A label
      // that reads Play in the play branch and Close in the close one has no
      // single answer for the field, but it has one per branch — and the
      // branch is decided by props the panel already knows.
      const defaults: Record<string, string | number> = {};
      const rules: Record<string, DefaultRule> = {};
      const docs: Record<string, string> = {};
      for (const [name, doc] of required(docMaps[at], 'Union branch documentation exists')) {
        docs[name] = doc;
        const said = statedDefault(doc);
        if (said.value !== undefined) {
          defaults[name] = said.value;
        }
        if (said.when) {
          rules[name] = said.when;
        }
      }
      for (const name of names) {
        const t = m.get(name);
        if (!t) {
          continue;
        }
        // A branch PINS a prop when it fixes it to a known set of values —
        // one (`variant: "autofit"`) or several (`variant: "autofit" |
        // "autofill"`), which is still a discriminant, just a wider one.
        // Anything with a non-literal member (string, number, an alias like
        // GridColumns) fixes nothing and pins nothing. Split first: a naive
        // literal test on the whole type reads `"a" | "b"` as one string,
        // because it does start and end with a quote.
        if (t === 'never') {
          forbids.push(name);
          continue;
        }
        const parts = splitTypeTop(t, '|')
          .flatMap((x) => parsePropSchemaExpandAlias(aliases, x.trim()))
          .map((x) => x.trim())
          .filter((x) => x && x !== 'undefined' && x !== 'null');
        const isLiteral = (x: string) =>
          /^(['"`]).*\1$/.test(x) || /^(true|false|-?\d+(\.\d+)?)$/.test(x);
        if (parts.length && parts.every(isLiteral)) {
          pins[name] = parts.map((x) => (/^['"`]/.test(x) ? x.slice(1, -1) : x));
        }
      }
      return { forbids, pins, defaults, rules, docs };
    });
    // A union that forbids nothing and pins nothing tells the panel nothing.
    if (
      branches.some(
        (b) =>
          b.forbids.length ||
          Object.keys(b.pins).length ||
          Object.keys(b.defaults).length ||
          Object.keys(b.rules).length,
      )
    ) {
      unions.push({ names: [...names], branches });
    }
  }
  return unions;
}

function parsePropSchemaSharedDoc(unions: readonly PropUnion[]): Map<string, string> {
  // A prop written in several branches has a doc in each, and they differ
  // exactly where the branches do — the play control's label falls back to
  // Play, the close one's to Close. The schema keeps the first it meets, so
  // the tip beside a close button's label read "Defaults to Play".
  //
  // What every branch says is what is true of the prop itself, so the tip
  // shows their common opening and stops at the last sentence they share.
  // Where they part is the fallback, which the field already answers with a
  // placeholder for the branch in force.
  const sharedDoc = new Map<string, string>();
  {
    const perName = new Map<string, Set<string>>();
    for (const u of unions) {
      for (const b of u.branches) {
        for (const [name, doc] of Object.entries(b.docs || {})) {
          if (!perName.has(name)) {
            perName.set(name, new Set());
          }
          required(perName.get(name), 'Documentation set was initialized').add(doc);
        }
      }
    }
    for (const [name, docs] of perName) {
      if (docs.size < 2) {
        continue;
      }
      const all = [...docs];
      const first = required(all[0], 'Shared documentation has an entry');
      let i = 0;
      while (i < first.length && all.every((d) => d[i] === first[i])) {
        i++;
      }
      const cut = first.slice(0, i).lastIndexOf('.');
      const common = cut === -1 ? '' : first.slice(0, cut + 1).trim();
      if (common) {
        sharedDoc.set(name, common);
      }
    }
  }
  return sharedDoc;
}

function parsePropSchemaRawTypes(
  aliases: ReadonlyMap<string, string>,
  blocks: readonly string[],
): {
  rawTypes: Map<string, { parts: string[]; optional: boolean }>;
  noted: Map<string, string>;
} {
  // Raw type strings per prop, gathered across every block, so a prop split
  // over a discriminated union comes back as the union of what it can be —
  // `"responsive"` here and `"fixed"` there is one three-option enum, not
  // three separate one-option ones.
  const rawTypes = new Map<string, { parts: string[]; optional: boolean }>();
  const noted = new Map<string, string>();

  // An alias standing in for a union of literals, expanded to those literals.
  // Only for alias bodies that are plain unions — one holding an object shape
  // describes members, not values, and exploding it would be nonsense.

  for (const block of blocks) {
    parsePropSchemaRawBlock(block, aliases, rawTypes, noted);
  }
  return { rawTypes, noted };
}

function parsePropSchemaFields(
  aliases: ReadonlyMap<string, string>,
  rawTypes: ReadonlyMap<string, { parts: string[]; optional: boolean }>,
  noted: ReadonlyMap<string, string>,
  sharedDoc: ReadonlyMap<string, string>,
  unions: readonly PropUnion[],
): Map<string, SchemaField> {
  const schema = new Map<string, SchemaField>();

  for (const [name, rec] of rawTypes) {
    const { type, options, numeric } = normalizeType(rec.parts.join(' | '));
    const shape = parsePropSchemaShapeOf(aliases, rec.parts);
    schema.set(name, {
      name,
      type,
      options,
      numeric,
      optional: rec.optional,
      // What one of these is made of, when the type says. `list` distinguishes
      // `ServiceTime[]` (a loop over it hands you one) from a plain object.
      ...(shape ? { shape: shape.members, shapeIsList: shape.list } : {}),
      default: undefined,
      doc: sharedDoc.get(name) ?? noted.get(name),
      // Range and step, for the fields that can be typed into freely. A list
      // of literals already can't take a wrong value.
      ...(type === 'number' ? numberRules(noted.get(name)) : {}),
      // The union shapes this component declares, so the panel can show only
      // the branch that matches what's currently set. Same table on every
      // field — it describes the type, not the prop.
      unions: unions.length ? unions : undefined,
    });
  }
  return schema;
}

function parsePropSchemaDestructure(frontmatter: string, schema: Map<string, SchemaField>): void {
  const destructure = frontmatter.match(/(?:const|let)\s*\{([\s\S]*?)\}\s*=\s*Astro\.props/);
  if (destructure) {
    // Rest params (...rest) aren't real props, and renames (class: className)
    // should register under the real prop name only.
    destructure[1] = required(destructure[1], 'Props destructure capture')
      .replace(/\.\.\.\s*\w+/g, '')
      .replace(/(\w+)\s*:\s*\w+/g, '$1');
    // Defaults can be quoted strings, shallow object/array literals ({} or
    // { a: 1 }), or plain expressions — the literal alternatives come first
    // so `= {}` isn't truncated at the closing brace.
    const entryRe = new RegExp(
      '(\\w+)(?:\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.' +
        ")*'|`(?:[^`\\\\]|\\\\.)*`|\\{[^{}]*\\}|\\[[^\\][]*\\]|[^," +
        '\\n}]+))?',
      'g',
    );
    let m;
    while ((m = entryRe.exec(destructure[1])) !== null) {
      if (!m[1]) {
        continue;
      }
      const existing = schema.get(m[1]) || {
        name: m[1],
        type: 'other',
        optional: true,
        default: undefined,
      };
      if (m[2] !== undefined) {
        let def = m[2].trim();
        if (/^["'`]/.test(def)) {
          existing.default = def.slice(1, -1);
          if (existing.type === 'other') {
            existing.type = 'string';
          }
        } else if (/^(true|false)$/.test(def)) {
          existing.default = def === 'true';
          if (existing.type === 'other') {
            existing.type = 'boolean';
          }
        } else if (/^-?\d+(\.\d+)?$/.test(def)) {
          existing.default = Number(def);
          if (existing.type === 'other') {
            existing.type = 'number';
          }
        } else {
          // Not a literal — an identifier or expression (e.g. SITE_TITLE).
          // Flag it so the scanner can try resolving it to a real value.
          existing.default = def;
          existing.defaultExpr = true;
          // An object-literal default marks an attributes-object prop.
          if (existing.type === 'other' && /^\{/.test(def)) {
            existing.type = 'attrs';
          }
        }
        existing.optional = true;
      }
      schema.set(m[1], existing);
    }
  }
}

function parsePropSchemaSplitFallback(unions: readonly PropUnion[]): Set<string> {
  // A prop written in several branches can promise a different fallback in
  // each. There is no single answer for the field, and reading the first
  // branch's doc would have it claim Play on a close button — the same lie
  // the conditional clause above refuses to tell. The branch tables carry
  // the per-branch answers; the field claims none.
  const splitFallback = new Set<string>();
  for (const u of unions) {
    for (const name of u.names) {
      const seen = new Set();
      for (const b of u.branches) {
        if (b.defaults?.[name] !== undefined) {
          seen.add(b.defaults[name]);
        }
        if (b.rules?.[name]) {
          seen.add(`rule:${name}`);
        }
      }
      if (seen.size > 1) {
        splitFallback.add(name);
      }
    }
  }
  return splitFallback;
}

function parsePropSchemaFallbacks(
  frontmatter: string,
  schema: Map<string, SchemaField>,
  splitFallback: ReadonlySet<string>,
): void {
  // A prop's fallback isn't always a destructure default. Two more places it
  // is stated plainly, both worth showing as a field's placeholder so the
  // panel can say what happens when you leave it alone:
  //
  //   const alt = altProp ?? "";                     a renamed prop's fallback
  //   /** Output format. Defaults to `webp`. */      the doc comment
  //
  // Only literal values are taken. "Defaults to whatever Astro picks" is prose
  // and stays prose — a placeholder that isn't a real value would be a lie
  // about what the component does.
  for (const field of schema.values()) {
    if (field.default !== undefined) {
      continue;
    }

    // `const x = xProp ?? <literal>` / `const x = props.x ?? <literal>`
    const nullish = frontmatter.match(
      new RegExp(
        `(?:const|let)\\s+${field.name}\\s*=\\s*[\\w.]+\\s*\\?\\?\\s*` +
          `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`[^\`]*\`|true|false|-?\\d+(?:\\.\\d+)?)`,
      ),
    );
    if (nullish) {
      const lit = required(nullish[1], 'Nullish default literal capture');
      field.default = /^["'\`]/.test(lit)
        ? lit.slice(1, -1)
        : /^(true|false)$/.test(lit)
          ? lit === 'true'
          : Number(lit);
      continue;
    }

    // "Defaults to `webp`", "Default: 2", "Defaults to `[1, 2]`". The
    // backticked form is tried first and taken whole — a value like `[1, 2]`
    // contains the comma the bare form has to stop at.
    if (splitFallback.has(field.name)) {
      continue;
    }

    const said = statedDefault(field.doc);
    if (said.value !== undefined) {
      field.default = said.value;
      continue;
    }
    if (said.hint) {
      field.hint = said.hint;
      continue;
    }

    // Some fallbacks are a behaviour rather than a value — "it is inferred",
    // "Astro picks sensible ones". There is nothing to prefill, but a field
    // that says `inferred` still answers "what happens if I leave this?".
    // Kept as `hint`, not `default`: it is not a value, so nothing may treat
    // it as one (the enum's unset-shows-default logic, for instance).
    const phrase =
      field.doc &&
      field.doc.match(
        new RegExp(
          '\\b(?:is|are)\\s+(inferred|automatic|calculated)\\b' +
            '|\\b(inferred|automatic)\\s+from\\b|\\b([A-Z][\\w ]{0' +
            ',24}?picks[\\w ]{0,20}?)\\s+by default\\b|\\bdefault' +
            's?\\s*(?:to|:)\\s*([^.]+)',
          'i',
        ),
      );
    if (phrase) {
      // To the end of the sentence, not a fixed number of word characters —
      // "the image service's own default" was coming back as "the image
      // service", which reads like a value rather than the shrug it is.
      const text = (phrase[1] || phrase[2] || phrase[3] || phrase[4] || '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text && text.length <= 48) {
        field.hint = text;
      }
    }
  }
}

// The slot a use of `Astro.slots` is about, and the const it was read into.
//
// A component does not have to render `<slot />` to take slot content. It can
// read the slot itself — which is the only way to ask whether the slot
// rendered anything, and so the usual shape for a component that draws nothing
// when it is empty:
//
//   const content = await Astro.slots.render('default');
//   const column2 = await slotContent(Astro.slots, 'column2');
//
// Read from the call around it: `.render(x)` / `.has(x)` name their slot
// outright, and where `Astro.slots` is handed to a helper the string beside it
// is the name. No string means the default slot — which is also the answer for
// `render(someVariable)`, where nothing in the file says which slot it is.
//
// Scans forward from the reference to the end of the call it sits in, so a
// second call further down the file can't lend it a name.
function slotApiUses(source: string): { slot: string; varName: string | null }[] {
  const text = withoutComments(source);
  const uses = [];
  const re = /Astro\s*\.\s*slots\b(\s*\.\s*(?:render|has)\s*\()?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Either we just consumed the opening paren of `.render(` / `.has(`, or
    // the reference is an argument in a call whose paren is behind us. Both
    // are one level in, and both end at the ')' that closes it.
    let depth = 1;
    let name = null;
    for (let i = m.index + m[0].length; i < text.length; i++) {
      const c = text.charAt(i);
      if (c === '"' || c === "'" || c === '`') {
        const close = text.indexOf(c, i + 1);
        const quoted = text.slice(i + 1, close === -1 ? text.length : close);
        if (name === null && /^[\w-]*$/.test(quoted)) {
          name = quoted;
        }
        if (close === -1) {
          break;
        }
        i = close;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        depth++;
      } else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          break;
        }
      } else if (depth === 1 && c === ';') {
        break;
      }
    }
    // `const content = await slotContent(...)` — the name that now holds it,
    // which is what the template puts back with `set:html`.
    const decl = text
      .slice(0, m.index)
      .match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[^;\n]*$/);
    uses.push({
      slot: name || 'default',
      varName: decl ? required(decl[1], 'Slot variable capture') : null,
    });
  }
  return uses;
}

// The source with what it says ABOUT itself blanked out, character for
// character so every index still points where it did. A frontmatter comment
// explaining how the component consumes its slots reads exactly like code
// that consumes them — three files in two projects grew a slot called "0"
// from a sentence about `Astro.slots.render()`.
//
// Only frontmatter takes `//` and `/* */`: in the template body a `//` is far
// more likely to be the middle of a URL than the start of a comment. Html
// comments are blanked wherever they are.
function withoutComments(source: string): string {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const chars = [...source];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') {
        chars[i] = ' ';
      }
    }
  };
  const end = fm ? fm[0].length : 0;
  for (let i = 0; i < end; i++) {
    const skipped = skipStringOrComment(source, i);
    if (skipped === i) {
      continue;
    }
    if (source[i] === '/') {
      blank(i, skipped);
    }
    i = skipped - 1;
  }
  for (const m of source.matchAll(/<!--[\s\S]*?-->/g)) {
    blank(m.index, m.index + m[0].length);
  }
  return chars.join('');
}

// Slot names a component's template exposes: 'default' for <slot>/<slot />,
// plus any <slot name="x">, plus any slot the frontmatter reads through
// `Astro.slots` (see slotApiUses). Default first, then named in appearance
// order.
function parseSlots(source: string): string[] {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const body = fm ? source.slice(fm[0].length) : source;
  const found = new Set<string>();
  const re = /<slot\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)\/?>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const nameMatch = required(m[1], 'Slot attributes capture').match(
      /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/,
    );
    found.add(nameMatch ? required(nameMatch[1] ?? nameMatch[2], 'Slot name capture') : 'default');
  }
  for (const use of slotApiUses(source)) {
    found.add(use.slot);
  }
  const named = [...found].filter((s) => s !== 'default');
  return found.has('default') ? ['default', ...named] : named;
}

// Tags that hold a line of text rather than a place to put blocks. What
// wraps a component's default <slot /> says what the component is for: a
// <slot> inside a <p> or a heading wants words, one inside a <div> wants
// other components.
const TEXT_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'button',
  'caption',
  'cite',
  'code',
  'dd',
  'dt',
  'em',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'label',
  'legend',
  'li',
  'option',
  'p',
  'q',
  'small',
  'span',
  'strong',
  'summary',
  'td',
  'th',
  'title',
]);

// A tag name written as `<Tag>` is a variable — resolve it back to the literal
// it holds. `const Tag = tag;` with `tag = "h2"` in the props destructure is
// the common shape; `const Tag = isLink ? "a" : "button"` names its options
// outright. Returns every tag it could be, or [] when that can't be told.
function dynamicTagLiterals(frontmatter: string, name: string): string[] {
  const decl = frontmatter.match(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`));
  if (!decl) {
    return [];
  }
  const literals = [
    ...required(decl[1], 'Dynamic tag expression capture').matchAll(/["'`]([A-Za-z][\w-]*)["'`]/g),
  ].map((m) => required(m[1], 'Tag literal capture'));
  if (literals.length) {
    return literals;
  }
  const ident = required(decl[1], 'Dynamic tag expression capture')
    .trim()
    .match(/^([A-Za-z_$][\w$]*)$/);
  if (!ident) {
    return [];
  }
  // `const Tag = tag` — the default sits in the destructure or its own const.
  const viaDefault = frontmatter.match(
    new RegExp(`\\b${ident[1]}\\s*=\\s*["'\`]([A-Za-z][\\w-]*)["'\`]`),
  );
  return viaDefault ? [required(viaDefault[1], 'Dynamic tag default capture')] : [];
}

// The HTML tag a component renders as, so nesting rules can reach through it:
// a <Paragraph> is a <p>, and a <p> can't go inside an <h1> however the
// component is named. Returns { tag } when it's fixed, { prop, fallback,
// options } when a prop decides it (`<Tag>` from `const Tag = tag`, with
// `tag = "h2"` in the destructure), or null when it can't be told.
function rootTag(source: string): RenderTag | null {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[0] : '';
  const body = fm ? source.slice(fm[0].length) : source;
  // The first element of the template that isn't a wrapper Astro strips.
  const re = /<(\/?)([A-Za-z][\w.-]*)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)(\/?)>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const closing = m[1];
    const name = required(m[2], 'Root tag name capture');
    if (closing) {
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === 'fragment' || lower === 'slot' || lower === 'style' || lower === 'script') {
      continue;
    }
    if (!/^[A-Z]/.test(name)) {
      return { tag: lower };
    }
    // A capitalised name is either another component — whose own tag this
    // file can't know — or a variable holding one.
    const decl = frontmatter.match(
      new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`),
    );
    if (!decl) {
      return null;
    }
    const expr = required(decl[1], 'Dynamic tag expression capture').trim();
    // `const Tag = tag` — the prop decides, so report it along with the
    // default, and an instance that sets the prop overrides the default.
    const ident = expr.match(/^([A-Za-z_$][\w$]*)$/);
    if (ident) {
      const prop = required(ident[1], 'Dynamic tag prop capture');
      const dflt = frontmatter.match(
        new RegExp(`\\b${prop}\\s*=\\s*["'\`]([A-Za-z][\\w-]*)["'\`]`),
      );
      return dflt
        ? { prop, tag: required(dflt[1], 'Root tag default capture').toLowerCase() }
        : { prop };
    }
    // `const Tag = isLink ? "a" : "button"` — it's one of these, and which
    // one depends on values only the page knows.
    const lits = [...expr.matchAll(/["'`]([A-Za-z][\w-]*)["'`]/g)].map((x) =>
      required(x[1], 'Root tag literal capture').toLowerCase(),
    );
    if (lits.length === 1) {
      return { tag: required(lits[0], 'Root has exactly one literal tag') };
    }
    if (lits.length > 1) {
      return { options: lits };
    }
    return null;
  }
  return null;
}

// Whether a component's default <slot /> sits somewhere text belongs, so a
// freshly inserted one can arrive with a word in it instead of empty. False
// for a slot that isn't wrapped at all, or wrapped in something structural.
//
// A component that read its slot itself puts it back with `set:html`, and that
// is the same placeholder under another name — `<Fragment set:html={content}/>`
// inside a <Tag> is where the default slot renders. Which const holds it comes
// from slotApiUses.
function defaultSlotInline(source: string): boolean {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[0] : '';
  const body = fm ? source.slice(fm[0].length) : source;
  const heldBy = new Set(
    slotApiUses(source)
      .filter((u) => u.slot === 'default' && u.varName)
      .map((u) => u.varName),
  );
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)(\/?)>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const closing = m[1];
    const tag = required(m[2], 'Slot parent tag capture');
    const attrs = required(m[3], 'Slot parent attributes capture');
    const selfClosing = m[4];
    const html = !closing && attrs.match(/\bset:html\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/);
    const isSlot = tag.toLowerCase() === 'slot' && !closing && !/\bname\s*=/.test(attrs);
    // A <Fragment> renders nothing of its own, so what wraps the content is
    // the tag above it. Anything else IS the wrapper.
    const placeholder =
      isSlot || (html && heldBy.has(required(html[1], 'Slot content variable capture')));
    if (placeholder) {
      const parent = isSlot || tag === 'Fragment' ? stack[stack.length - 1] : tag;
      if (!parent) {
        return false;
      }
      if (TEXT_TAGS.has(parent.toLowerCase())) {
        return true;
      }
      if (!/^[A-Z]/.test(parent)) {
        return false;
      }
      const options = dynamicTagLiterals(frontmatter, parent);
      return options.length > 0 && options.every((t) => TEXT_TAGS.has(t.toLowerCase()));
    }
    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at !== -1) {
        stack.length = at;
      }
    } else if (!selfClosing && !VOID_ELEMENTS.has(tag.toLowerCase())) {
      stack.push(tag);
    }
  }
  return false;
}

// Extracts the tag from `interface Props extends HTMLAttributes<"button">`
// so the UI can offer that element's built-in attributes (type, disabled, …).
function parseExtendsTag(source: string): string | null {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? required(fm[1], 'Frontmatter capture') : '';
  const m = frontmatter.match(
    new RegExp(
      'interface\\s+Props\\s+extends\\s+(?:astroHTML\\.JSX\\' +
        '.)?HTMLAttributes\\s*<\\s*[\'"](\\w+)[\'"]\\s*>',
      '',
    ),
  );
  return m ? required(m[1], 'Extended HTML tag capture') : null;
}

// What a number prop will actually accept. TypeScript can't say "greater than
// zero", so components say it in the doc comment — either as a tag, which is
// exact, or in the sentence a human reads, which is a guess and can be
// overridden by a tag. Returns {} when the doc says nothing about a range.
const NUMBER_RE = String.raw`-?\d+(?:\.\d+)?`;
function numberRules(doc: string | undefined): NumberRules {
  if (!doc) {
    return {};
  }
  const rules = numberRulesTags(doc);
  // Prose, for the props that were written before any of that existed. Only
  // phrases that state a bound outright — "Defaults to 12" is not one, and
  // neither is "Columns from 30rem up". Each match is struck out as it is
  // read, so "no more than 8" can't be picked up a second time by the bare
  // "more than" pattern underneath it and turned into a minimum.
  let prose = doc.replace(/@\w+\s+-?[\d.]+/g, ' ');
  const take = (re: RegExp, apply: (a: number, b: number) => void) => {
    const m = prose.match(re);
    if (!m) {
      return;
    }
    apply(Number.parseFloat(m[1] ?? ''), Number.parseFloat(m[2] ?? ''));
    prose = prose.replace(m[0], ' ');
  };
  take(new RegExp(`between\\s+(${NUMBER_RE})\\s+and\\s+(${NUMBER_RE})`, 'i'), (a, b) => {
    if (rules.min === undefined) {
      rules.min = a;
    }
    if (rules.max === undefined) {
      rules.max = b;
    }
  });
  // Inclusive bounds first: they contain the words the exclusive ones use.
  take(
    new RegExp(
      `(?:no more than|not more than|at most|maximum(?: of)?|up to)\\s+(${NUMBER_RE})`,
      'i',
    ),
    (n) => {
      if (rules.max === undefined) {
        rules.max = n;
      }
    },
  );
  take(
    new RegExp(`(?:no less than|not less than|at least|minimum(?: of)?)\\s+(${NUMBER_RE})`, 'i'),
    (n) => {
      if (rules.min === undefined) {
        rules.min = n;
      }
    },
  );
  take(new RegExp(`(?:greater than|more than|above)\\s+(${NUMBER_RE})`, 'i'), (n) => {
    if (rules.min !== undefined) {
      return;
    }
    rules.min = n;
    rules.minExclusive = true;
  });
  take(new RegExp(`(?:less than|below|under)\\s+(${NUMBER_RE})`, 'i'), (n) => {
    if (rules.max !== undefined) {
      return;
    }
    rules.max = n;
    rules.maxExclusive = true;
  });
  if (rules.step === undefined && /\b(whole numbers?|integers?|no decimals?)\b/i.test(prose)) {
    rules.step = 1;
  }
  return rules;
}

function normalizeType(t: string): NormalizedType {
  // Union of string literals ('primary' | 'secondary') → enum with options.
  const parts = t
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const literals = parts.filter((p) => /^(['"`]).*\1$/.test(p));
    const rest = parts.filter((p) => !/^(['"`]).*\1$/.test(p));
    if (literals.length >= 2 && rest.every((p) => p === 'undefined' || p === 'null')) {
      return { type: 'enum', options: literals.map((p) => p.slice(1, -1)) };
    }
    // The same thing written with numbers — `1 | 2 | … | 12` for a column
    // count. A free number field would take -1, 0 and 1.5, none of which the
    // type allows, so this is a list too. `numeric` tells the panel to write
    // `cols={3}` rather than `cols="3"`; the component is typed for a number.
    const nums = parts.filter((p) => /^-?\d+(?:\.\d+)?$/.test(p));
    const notNums = parts.filter((p) => !/^-?\d+(?:\.\d+)?$/.test(p));
    if (nums.length >= 2 && notNums.every((p) => p === 'undefined' || p === 'null')) {
      return { type: 'enum', numeric: true, options: nums };
    }
  }
  // Arrays, tuples and object literals are values only JS can express —
  // `number[]`, `(number | \`${number}x\`)[]`, `{ a: 1 }`. They must be checked
  // BEFORE the primitive prefixes, or `number[]` reads as a plain number and
  // the field writes `widths="400"` where the component wants `widths={[400]}`.
  // A text field here produces a string, and the component does .map on it.
  const arrayish = /\[\s*\]\s*$/.test(t) || /^Array\s*</.test(t) || /^\[[\s\S]*\]$/.test(t);
  // A plain bag of attributes still edits as name/value rows — that reads far
  // better than a JS literal. Only when it can also be an ARRAY does it have
  // to become code, since rows cannot express one.
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(t) && !arrayish) {
    return { type: 'attrs' };
  }
  if (arrayish || /^\{[\s\S]*\}$/.test(t)) {
    return { type: 'code' };
  }
  if (/^string\b/.test(t)) {
    return { type: 'string' };
  }
  if (/^number\b/.test(t)) {
    return { type: 'number' };
  }
  if (/^boolean\b/.test(t)) {
    return { type: 'boolean' };
  }
  if (/^(['"`]).*\1$/.test(t)) {
    return { type: 'string' };
  }
  // Objects of attributes (HTMLAttributes<"div">, Record<string, …>) edit
  // as name/value rows.
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(t)) {
    return { type: 'attrs' };
  }
  return { type: 'other' };
}

// Serializes a plain node list (used for standalone HTML chunk files).
function serializeNodes(input: readonly unknown[]): string {
  const nodes = parseSerializeNodes(input);
  const lines: string[] = [];
  for (const node of nodes) {
    serializeNode(node, '', lines);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// HTML chunks
// ---------------------------------------------------------------------------
// Pages built as <Fragment set:html={x} /> where x is an import of
// "chunks/foo.html?raw" (or a joined array of them). The chunk files' markup
// is parsed into the Fragment's children so it's editable in the navigator;
// edits are written back to the chunk file, never the page.

function resolveChunks(
  model: ParserPageModel,
  pagePath: string,
  opts: { readonly locs?: boolean } = {},
): void {
  // ident -> absolute chunk file path
  const rawImports = new Map<string, string>();
  for (const imp of model.imports) {
    if (/\.html\?raw$/i.test(imp.path) && imp.path.startsWith('.')) {
      rawImports.set(
        imp.name,
        path.resolve(path.dirname(pagePath), imp.path.replace(/\?raw$/i, '')),
      );
    }
  }
  if (!rawImports.size) {
    return;
  }

  // const main = [a, b, c].join("") aggregations in the frontmatter.
  const aggregates = resolveChunksAggregates(model.extraFrontmatter);

  const walk = (list: readonly ParserNode[]) => {
    for (const node of list) {
      if (
        node.kind === 'component' &&
        node.props?.['set:html']?.type === 'expr' &&
        node.children == null
      ) {
        const ref = node.props['set:html'].value.trim();
        if (rawImports.has(ref)) {
          const file = required(rawImports.get(ref), 'Chunk import exists');
          const children = resolveChunksParseFile(file, opts);
          if (children) {
            node.chunkFile = file;
            node.children = children;
          }
          continue;
        }
        if (aggregates.has(ref)) {
          const groups: ParserNode[] = [];
          for (const ident of required(aggregates.get(ref), 'Chunk aggregate exists')) {
            if (!rawImports.has(ident)) {
              continue;
            }
            const file = required(rawImports.get(ident), 'Aggregate chunk import exists');
            const children = resolveChunksParseFile(file, opts);
            if (children) {
              groups.push({
                id: makeId(),
                kind: 'chunk-group',
                name: ident,
                chunkFile: file,
                children,
              });
            }
          }
          if (groups.length) {
            node.children = groups;
            node.chunkAggregate = true;
          }
          continue;
        }
      }
      if (Array.isArray(node.children)) {
        walk(node.children);
      }
    }
  };
  walk(model.nodes);
  assignPathIds(model.nodes, '', 0); // The chunks' nodes joined the tree.
}

// Marker path each chunk import's content occupies in the tree, keyed by the
// import's identifier: the Fragment's own path for a lone chunk, the
// chunk-group's path for each member of a joined aggregate. Requires a model
// that's been through resolveChunks.
function chunkImportMarks(model: ParserPageModel): Map<string, { path: string; group: boolean }> {
  const marks = new Map<string, { path: string; group: boolean }>();
  const walk = (list: readonly ParserNode[], prefix: string) => {
    list.forEach((node, i) => {
      const p = prefix ? `${prefix}.${i}` : String(i);
      if (node.chunkFile) {
        const group = node.kind === 'chunk-group';
        const html = node.props?.['set:html'];
        const ident = group
          ? node.name
          : html && html.type !== 'bare'
            ? html.value.trim()
            : undefined;
        if (ident) {
          marks.set(ident, { path: p, group });
        }
      }
      if (Array.isArray(node.children)) {
        walk(node.children, p);
      }
    });
  };
  walk(model.nodes, '');
  return marks;
}

// Dev-preview only: the chunk's markup with the same boundary markers the
// page serializer emits, numbered from the Fragment's (or group's) key so
// chunk nodes address identically to the app's tree. `prefix` is a full
// "<file>#<path>" key — the file half rides along untouched. A group also gets
// a marker pair of its own — nothing in the page wraps it. Returns null when
// the chunk isn't representable, so the caller can serve it unmarked.
function markChunkHtml(source: string, prefix: string, group: boolean): string | null {
  const { nodes, clean } = parseTemplate(source);
  if (!clean) {
    return null;
  }
  const lines: string[] = [];
  if (group) {
    lines.push(`<!--avb-s:${prefix}-->`);
  }
  nodes.forEach((node, i) => serializeNodeMarked(node, '', lines, `${prefix}.${i}`));
  if (group) {
    lines.push(`<!--avb-e:${prefix}-->`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Selection → source location
// ---------------------------------------------------------------------------

// 1-based line number of a source offset.
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
    }
  }
  return line;
}

// Where a canvas selection sits in source. `indexPath` is the "0.2.1" half of
// a "<file>#<path>" node key — '' for the file itself, 'frontmatter' for the
// frontmatter block. Reads the file from disk and parses it fresh, so the
// answer describes what an agent opening that file would actually see.
//
// The file returned isn't always the one asked for: chunk children are written
// in the imported .html, not in the page that pulls it in. A node with no
// range of its own (an unrepresentable file, a synthetic chunk group, a path
// that no longer resolves) comes back as a bare file.
function locateSelection(absPath: string, indexPath: string): SourceLocation | null {
  let source;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const bare = { file: absPath };
  if (!indexPath) {
    return bare;
  }

  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    return bare;
  }
  if (indexPath === 'frontmatter') {
    return parsed.model.bodyStart
      ? { file: absPath, startLine: 1, endLine: lineOf(source, parsed.model.bodyStart - 1) }
      : bare;
  }
  resolveChunks(parsed.model, absPath, { locs: true });

  let file = absPath;
  let list: ParserNode[] | null | undefined = parsed.model.nodes;
  let node = null;
  for (const part of indexPath.split('.')) {
    // Stepping past a chunk boundary: everything below it is written in the
    // chunk file, while the boundary node itself belongs to the page.
    if (node?.chunkFile) {
      file = node.chunkFile;
    }
    node = Array.isArray(list) ? list[Number(part)] : null;
    if (!node) {
      return { file };
    }
    list = node.children;
  }
  // A branch has no markup of its own. `{render && ( … )}` writes one brace, a
  // condition and then the contents — so nothing in the file is the branch, and
  // it was the one kind of node a selection could not be turned into a line
  // range. What it stands for is what is inside it.
  if (!node) {
    return { file };
  }
  let span: { readonly start?: number | undefined; readonly end?: number | undefined } = node;
  if (typeof span.start !== 'number' && Array.isArray(node.children)) {
    const placed = node.children.filter((c) => typeof c.start === 'number');
    if (placed.length) {
      span = {
        start: required(placed[0], 'First placed child exists').start,
        end: required(placed[placed.length - 1], 'Last placed child exists').end,
      };
    }
  }
  if (typeof span.start !== 'number') {
    return { file };
  }

  let text = source;
  if (file !== absPath) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { file };
    }
  }
  // Text nodes run from the end of the previous tag, so their range starts and
  // ends in whitespace on lines that hold nothing else. Tighten it to the
  // lines the content is actually on.
  let start = span.start;
  let end = Math.min(required(span.end, 'Placed node has an end offset'), text.length);
  while (start < end && /\s/.test(text.charAt(start))) {
    start++;
  }
  while (end > start && /\s/.test(text.charAt(end - 1))) {
    end--;
  }
  return { file, startLine: lineOf(text, start), endLine: lineOf(text, end - 1) };
}

// Regex captures and bounded array accesses are producer invariants, not user
// errors. A violated assumption must identify the failing parser operation.
function required<T>(value: T | undefined, message: string): T {
  assert(value !== undefined, message);
  return value;
}

function resetParseBail(): void {
  parseState.lastBail = null;
}

function serializeNodeText(node: ValueNode, indent: string, lines: string[]): void {
  // Prose the author wrapped by hand comes back on the lines they wrapped
  // it on. Each line already carries its own indentation; only the first
  // takes the tree's, the way a multi-line expression does.
  const written = textAsWritten(node);
  if (written === null || !written.includes('\n')) {
    // The space at either end of the value is the boundary space — the one
    // a browser renders where the source had any whitespace. On a line of
    // its own the line breaks either side already ARE that whitespace, and
    // writing it as well made saving twice differ from saving once: the
    // first save moved `>Join our Discord <svg` onto separate lines with
    // the space still on the words' line, and the second save, reading its
    // own output, dropped it. The value is unchanged either way — that is
    // what makes the space the layout's to draw rather than the text's.
    lines.push(indent + textOut(node).replace(/^ +| +$/g, ''));
    return;
  }
  const body = written.replace(/^[ \t]*\r?\n/, '').replace(/\s+$/, '');
  const [first, ...more] = body.split('\n');
  lines.push(indent + required(first, 'Split text has a first line').replace(/^[ \t]+/, ''));
  for (const line of more) {
    lines.push(line);
  }
  return;
}

function serializeNodeMap(node: MapNode, indent: string, lines: string[]): void {
  const keptMap = blockAsWritten(node, indent);
  if (keptMap) {
    for (const line of keptMap) {
      lines.push(line);
    }
    return;
  }
  lines.push(indent + '{');
  // A loop whose body declares things keeps the statement form: the
  // declarations, then the markup inside `return ( … )`.
  if (node.body && node.body.length) {
    lines.push(indent + '  ' + blockHead(node.head));
    for (const line of node.body) {
      lines.push(indent + '    ' + line);
    }
    lines.push(indent + '    return (');
    for (const child of node.children || []) {
      serializeNode(child, indent + '      ', lines);
    }
    lines.push(indent + '    );');
    lines.push(indent + '  })');
    lines.push(indent + '}');
    return;
  }
  // A loop written without parens around its body keeps that shape —
  // adding them would rewrite a line the user never edited.
  if (node.bare) {
    lines.push(indent + '  ' + node.head.replace(/\($/, '').trimEnd());
    for (const child of node.children || []) {
      serializeNode(child, indent + '    ', lines);
    }
    lines.push(indent + '  )');
    lines.push(indent + '}');
    return;
  }
  // Untouched heads keep the lines they were written on; an edited one is
  // written as the single line the Loop field holds.
  const kept =
    node.headSource && normalizeHead(node.headSource) === node.head ? node.headSource : null;
  // The body belongs under `.map(`, which on a chain written across lines
  // is indented past the head's own first line — so the loop's contents
  // hang off the LAST head line, not off the node.
  let inner = '';
  if (kept) {
    const headLines = kept.split('\n');
    for (const line of headLines) {
      lines.push(line ? indent + '  ' + line : '');
    }
    inner =
      required(headLines[headLines.length - 1], 'Loop head has a final line').match(
        /^[ \t]*/,
      )?.[0] ?? '';
  } else {
    lines.push(indent + '  ' + node.head);
  }
  for (const child of node.children || []) {
    serializeNode(child, indent + '  ' + inner + '  ', lines);
  }
  lines.push(indent + '  ' + inner + '))');
  lines.push(indent + '}');
  return;
}

function serializeNodeRaw(
  node: Extract<ParserNode, { kind: 'raw' }>,
  indent: string,
  lines: string[],
): void {
  const open = `${indent}<${node.name}${serializeAttrs(node.props, node.attrOrder)}>`;
  // Keep raw inner verbatim. Only the line break that ends the last line
  // goes, since the closing tag supplies its own — trimming all trailing
  // whitespace also took away a blank line the author left in the CSS.
  const inner = node.inner.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  // A block with nothing in it is one tag: `<script src="…"></script>`.
  // Putting the close on its own line made the block a line taller on
  // every save — the next parse reads that line as content, keeps it, and
  // adds another — so a Webflow export's three library <script>s grew by
  // three lines each time the page was opened and saved.
  if (!inner.trim()) {
    lines.push(`${open}</${node.name}>`);
    return;
  }
  lines.push(open);
  for (const line of inner.split('\n')) {
    lines.push(line);
  }
  lines.push(`${indent}</${node.name}>`);
  return;
}

function serializeNodeElement(
  node: Extract<ParserNode, { kind: 'element' | 'component' }>,
  indent: string,
  lines: string[],
): void {
  const kept = attrsAsWritten(node);
  const attrs = kept === null ? serializeAttrs(node.props, node.attrOrder) : kept;
  // A shorthand fragment has no attributes. If the editor adds one (for
  // example slot), use the equivalent named form that can carry it.
  const tagName = node.shorthand && node.name === 'Fragment' && !attrs ? '' : node.name;
  // The closing tag as written, when it was written across lines. Only
  // trusted while it still names this element: renaming the tag rebuilds
  // it the ordinary way.
  const closeTag =
    node.closeSource && node.closeSource.startsWith(`</${tagName}`)
      ? node.closeSource
      : `</${tagName}>`;
  const openTag = (close: string) => {
    // Preserved attributes carry their own trailing whitespace — the line
    // break before the closing bracket — so the usual leading space would
    // be one too many.
    const tail = kept !== null && /\s$/.test(attrs) ? close.replace(/^ /, '') : close;
    const text = `${indent}<${tagName}${attrs}${tail}`;
    for (const line of text.split('\n')) {
      lines.push(line);
    }
  };
  if (node.children === null) {
    openTag(node.tightClose ? '/>' : ' />');
    return;
  }
  // Inline runs stay on one line: <p>We're <strong>Acme</strong>.</p>
  if (node.children.length > 0 && isInlineRun(node.children)) {
    // Unless the file already wrote the run across several lines and
    // nothing has touched it since. Re-flowing a hand-wrapped paragraph
    // onto one long line is a diff on a page that was only opened, and
    // the stored inner puts the tag back whole — its line breaks, its
    // indentation, and the break before the closing tag.
    if (inlineRunUnchanged(node)) {
      openTag(
        `>${reindentRun(required(node.source, 'Unchanged inline run has source'), indent)}` +
          closeTag,
      );
      return;
    }
    // The run's boundary spaces are content, not layout. A text node on a
    // line of its own can trim them — the file's indent hands the boundary
    // whitespace back on reparse (see serializeNodeText) — but a run written
    // on one line has nothing but the value itself to hold them, and the
    // parse keeps exactly one space where the source had any (collapseText).
    // Trimming here made parse∘serialize lossy: a word typed followed by a
    // space came back from the save without it, and the Content field, seeing
    // its own edit echo back different, reset the caret to the start of the
    // line.
    openTag(`>${inlineString(node.children)}${closeTag}`);
    return;
  }
  // No children: the stored inner keeps `<div>\n</div>` as written — but only
  // while it is whitespace. An element whose last child was taken out still
  // carries the inner it was read with, and writing that back put the removed
  // child back (found by the step-6 gesture parity sweep: a deleted element's
  // only child stayed, a moved one appeared twice).
  if (node.children.length === 0) {
    const inner = node.source !== undefined && node.source.trim() === '' ? node.source : '';
    openTag(`>${inner ? reindentRun(inner, indent) : ''}${closeTag}`);
    return;
  }
  openTag('>');
  for (const child of node.children) {
    serializeNode(child, indent + '  ', lines);
  }
  for (let i = 0; i < (node.blankAfter || 0); i++) {
    lines.push('');
  }
  for (const line of `${indent}${closeTag}`.split('\n')) {
    lines.push(line);
  }
}

function parsePageMarkDynamic(
  list: readonly ParserNode[],
  importsByName: Readonly<Record<string, ImportMember>>,
): void {
  for (const n of list) {
    if (n.kind === 'component' && n.name !== 'Fragment') {
      const imp = importsByName[n.name];
      if (!imp) {
        n.dynamicTag = true;
      }
      // Astro's own <Image>/<Picture>, identified by where the name came
      // from rather than by the name itself — a project is perfectly
      // entitled to its own component called Image, and several have one.
      else if (imp.path === 'astro:assets') {
        n.astroAsset = true;
      }
    }
    if (Array.isArray(n.children)) {
      parsePageMarkDynamic(n.children, importsByName);
    }
  }
}

function resolveChunksParseFile(
  filePath: string,
  opts: { readonly locs?: boolean },
): ParserNode[] | null {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  // Only disk failures are caught. Broken parser invariants must stay loud.
  const { nodes, clean } = parseTemplate(source, opts.locs ? 0 : null);
  return clean ? nodes : null;
}

type TemplateTagResult =
  | { readonly kind: 'tag'; readonly node: ParserNode; readonly end: number }
  | { readonly kind: 'bail'; readonly what: string }
  | { readonly kind: 'child-bail' };

function parseTemplateTag(str: string, lt: number, base: number | null): TemplateTagResult {
  const shorthand = str.startsWith('<>', lt);
  TAG_RE.lastIndex = lt;
  const m = shorthand ? ['<>', 'Fragment', '', ''] : TAG_RE.exec(str);
  if (!m) {
    return { kind: 'bail', what: 'a stray <' };
  }

  const full = required(m[0], 'Tag match');
  const name = required(m[1], 'Tag name capture');
  const attrs = required(m[2], 'Tag attributes capture');
  const selfClose = m[3];
  // One level of nested braces in an attribute ({{ a: 1 }}) is supported;
  // anything deeper would be corrupted by the attr parser — bail to code
  // view instead.
  if (/=\s*\{[^{}]*\{[^{}]*\{/.test(attrs) || /\{\s*\.\.\.[^{}]*\{[^{}]*\{/.test(attrs)) {
    return { kind: 'bail', what: 'an attribute with deeply nested { } braces' };
  }
  const isComponent = /^[A-Z]/.test(name);
  const kind = isComponent ? 'component' : 'element';
  const afterOpen = lt + full.length;

  if (selfClose === '/' || (!isComponent && VOID_ELEMENTS.has(name.toLowerCase()))) {
    return {
      kind: 'tag',
      node: parseTemplateAt(
        {
          id: makeId(),
          kind,
          name,
          ...tagProps(attrs, base === null ? null : base + lt + 1 + name.length),
          ...(attrs && attrs.includes('\n') ? { attrSource: attrs } : {}),
          // `<x/>` and `<x />` mean the same thing and are not the same text.
          ...(selfClose === '/' && !/\s\/>$/.test(full) ? { tightClose: true } : {}),
          children: null,
        },
        base,
        lt,
        afterOpen,
      ),
      end: afterOpen,
    };
  }

  // <style>/<script>: capture inner verbatim, no parsing.
  if (!isComponent && RAW_ELEMENTS.has(name.toLowerCase())) {
    const close = str.indexOf(`</${name}`, afterOpen);
    if (close === -1) {
      return { kind: 'bail', what: `an unclosed <${name}> block` };
    }
    const closeEnd = str.indexOf('>', close);
    if (closeEnd === -1) {
      return { kind: 'bail', what: `an unclosed <${name}> block` };
    }
    return {
      kind: 'tag',
      node: parseTemplateAt(
        {
          id: makeId(),
          kind: 'raw',
          name,
          ...tagProps(attrs, base === null ? null : base + lt + 1 + name.length),
          ...(attrs && attrs.includes('\n') ? { attrSource: attrs } : {}),
          inner: str.slice(afterOpen, close),
        },
        base,
        lt,
        closeEnd + 1,
      ),
      end: closeEnd + 1,
    };
  }

  return parseTemplateTagPaired({ str, lt, base, name, attrs, afterOpen, shorthand, kind });
}

function parseTemplateAt(
  node: ParserNode,
  base: number | null,
  from: number,
  to: number,
): ParserNode {
  if (base !== null) {
    node.start = base + from;
    node.end = base + to;
  }
  return node;
}

function parseTemplateExpression(exprText: string, base: number | null): ParserNode {
  const jsxComment = exprText.match(/^\{\s*\/\*([\s\S]*?)\*\/\s*\}$/);
  if (jsxComment) {
    return {
      id: makeId(),
      kind: 'comment',
      value: required(jsxComment[1], 'JSX comment capture'),
      jsx: true,
    };
  }
  const structural = tryParseMapWithSource(exprText, base) || tryParseCond(exprText, base);
  return structural || { id: makeId(), kind: 'expr', value: exprText };
}

function parsePropSchemaAccumulate(
  aliases: ReadonlyMap<string, string>,
  rawTypes: Map<string, { parts: string[]; optional: boolean }>,
  m: RegExpMatchArray,
): string {
  const name = required(m[1], 'Schema member name capture');
  let typeStr = required(m[3], 'Schema member type capture').trim();
  if (aliases.has(typeStr)) {
    typeStr = required(aliases.get(typeStr), 'Type alias exists');
  }
  // `never` is how a union branch says "not in this shape" — it describes
  // the branch, not the prop, so it contributes no type and no
  // optionality. It DOES fix the prop's position though: a component that
  // writes `href?: never` above `type` is saying where href belongs, and
  // skipping the line outright would only register href in a later branch
  // and sort it to the bottom.
  if (typeStr === 'never') {
    if (!rawTypes.has(name)) {
      rawTypes.set(name, { parts: [], optional: false });
    }
  } else {
    if (!rawTypes.has(name)) {
      rawTypes.set(name, { parts: [], optional: false });
    }
    const rec = required(rawTypes.get(name), 'Prop type accumulator was initialized');
    for (const part of typeStr
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean)) {
      // `variant?: PlainVariant | ReversibleVariant` names two aliases
      // rather than being one, so the substitution above doesn't reach it
      // — and an unexpanded name among the literals is a non-literal, so
      // the whole thing stops reading as a fixed set of options.
      for (const piece of parsePropSchemaExpandAlias(aliases, part)) {
        if (piece !== 'never' && !rec.parts.includes(piece)) {
          rec.parts.push(piece);
        }
      }
    }
    if (m[2]) {
      rec.optional = true;
    }
  }

  return name;
}

function serializeNodeMarkedMap(
  node: MapNode,
  indent: string,
  lines: string[],
  path: string,
  atRoot: boolean,
): 'complete' | 'continue' {
  // Loop children render once per item, so their marker pairs repeat in
  // the DOM — the collector unions every instance into one region.
  //
  // The body goes inside a <Fragment>, for the same reason the branches of
  // a `cond` do: what an iteration returns is a marker, the child, and
  // another marker, and `(a b c)` is a list where one expression is wanted.
  // Astro's own compiler accepts it — it reads the children as one template
  // — but Astro 7's Rust compiler (@astrojs/compiler-rs) does not, and the
  // page fails to build with a bare "Unexpected token".
  //
  // Inside that Fragment the children are slot content, where a plain html
  // comment is dropped by both compilers, so the markers have to go in as
  // `set:html` — hence inSlot. Missing that is silent: the page builds and
  // the loop renders, but nothing inside it can be outlined.
  lines.push(indent + '{');
  const loopBody = (bodyIndent: string) => {
    lines.push(bodyIndent + '<Fragment>');
    (node.children || []).forEach((child, i) =>
      serializeNodeMarked(child, bodyIndent + '  ', lines, `${path}.${i}`, true, atRoot),
    );
    lines.push(bodyIndent + '</Fragment>');
  };
  if (node.body && node.body.length) {
    lines.push(indent + '  ' + blockHead(node.head));
    for (const line of node.body) {
      lines.push(indent + '    ' + line);
    }
    lines.push(indent + '    return (');
    loopBody(indent + '      ');
    lines.push(indent + '    );');
    lines.push(indent + '  })');
    lines.push(indent + '}');
    return 'complete';
  }
  lines.push(indent + '  ' + node.head);
  loopBody(indent + '    ');
  lines.push(indent + '  ))');
  lines.push(indent + '}');

  return 'continue';
}

function serializeNodeMarkedCond(
  node: CondNode,
  indent: string,
  lines: string[],
  path: string,
  atRoot: boolean,
): void {
  // Both branches keep their parens here whether or not they hold anything:
  // the branch's own marker templates are inside them, so they're never the
  // empty `()` the plain writer has to avoid.
  //
  // …and inside those parens goes a <Fragment>. A branch always emits at
  // least three things — its opening marker, its contents, its closing
  // marker — and `cond && ( a b c )` is not valid JSX: the parens hold one
  // expression, not a list. Without the wrapper the compiler stops at the
  // first token after the markers ("Expected `,` or `)` but found `{`") and
  // the page won't build. Fragment renders no element, so the markers stay
  // siblings of the content in the DOM, which is what the canvas needs.
  const branches = node.children || [];
  const inner = indent + '    ';
  const branchOut = (branch: ParserNode | undefined, i: number) => {
    lines.push(inner + '<Fragment>');
    // Slot content of that Fragment, so the markers must be the `set:html`
    // form — a plain comment directly inside a component is dropped, which
    // left everything in a branch unoutlinable.
    // A root written as a condition — `{render && (<div/>)}` — is still the
    // root: what the branch renders is what the caller placed.
    if (branch) {
      serializeNodeMarked(branch, inner + '  ', lines, `${path}.${i}`, true, atRoot);
    }
    lines.push(inner + '</Fragment>');
  };
  lines.push(indent + '{');
  lines.push(indent + '  ' + node.test + (node.op === '&&' ? ' && (' : ' ? ('));
  branchOut(branches[0], 0);
  if (node.op === '&&') {
    lines.push(indent + '  )');
  } else {
    lines.push(indent + '  ) : (');
    branchOut(branches[1], 1);
    lines.push(indent + '  )');
  }
  lines.push(indent + '}');
}

function parseTemplateMarkup(str: string, lt: number, base: number | null): TemplateTagResult {
  if (str.startsWith('<!--', lt)) {
    const end = str.indexOf('-->', lt + 4);
    if (end === -1) {
      return { kind: 'bail', what: 'an unclosed <!-- comment' };
    }
    return {
      kind: 'tag',
      end: end + 3,
      node: parseTemplateAt(
        {
          id: makeId(),
          kind: 'comment',
          value: str.slice(lt + 4, end),
        },
        base,
        lt,
        end + 3,
      ),
    };
  }
  if (/^<!doctype/i.test(str.slice(lt))) {
    const end = str.indexOf('>', lt);
    if (end === -1) {
      return { kind: 'bail', what: 'an unclosed <!doctype>' };
    }
    return {
      kind: 'tag',
      end: end + 1,
      node: parseTemplateAt(
        {
          id: makeId(),
          kind: 'raw-line',
          value: str.slice(lt, end + 1),
        },
        base,
        lt,
        end + 1,
      ),
    };
  }
  return parseTemplateTag(str, lt, base);
}

// Each gap keeps the whitespace it stands for as its source range, so a
// located parse places it like any other node.
function parseTemplateGaps(
  nodes: ParserNode[],
  gaps: readonly { readonly index: number; readonly from: number; readonly to: number }[],
  base: number | null,
): void {
  if (gaps.length && isInlineRun(nodes)) {
    for (let i = gaps.length - 1; i >= 0; i--) {
      const gap = required(gaps[i], 'Inline gap index is in bounds');
      if (gap.index >= nodes.length) {
        continue;
      }
      const space: ParserNode = { id: makeId(), kind: 'text', value: ' ' };
      nodes.splice(gap.index, 0, parseTemplateAt(space, base, gap.from, gap.to));
    }
  }
}

function parsePageLayout(
  topNodes: readonly ParserNode[],
  importsByName: Readonly<Record<string, ImportMember>>,
): void {
  const significant = topNodes.filter((n) => n.kind !== 'comment');
  let wrapper: ParserNode | undefined;
  const significantFirst = significant[0];
  if (
    significant.length === 1 &&
    significantFirst !== undefined &&
    significantFirst.kind === 'component' &&
    significantFirst.name !== 'Fragment' &&
    significantFirst.children !== null &&
    !!importsByName[significantFirst.name]
  ) {
    wrapper = significantFirst;
  } else if (significant.length > 1) {
    const layoutish = significant.filter(
      (n) =>
        n.kind === 'component' &&
        n.children !== null &&
        /layout/i.test(importsByName[n.name]?.path || ''),
    );
    if (layoutish.length === 1) {
      wrapper = layoutish[0];
    }
  }
  if (wrapper) {
    wrapper.id = 'layout';
  }
}

function resolveChunksAggregates(extraFrontmatter: string): Map<string, string[]> {
  const aggregates = new Map<string, string[]>();
  const aggRe = /(?:const|let)\s+(\w+)\s*=\s*\[([^\]]*)\]\s*\.join\(/g;
  let am;
  while ((am = aggRe.exec(extraFrontmatter)) !== null) {
    const idents = required(am[2], 'Chunk aggregate members capture')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (idents.length && idents.every((i) => /^\w+$/.test(i))) {
      aggregates.set(required(am[1], 'Chunk aggregate name capture'), idents);
    }
  }

  return aggregates;
}

interface TemplateTagOpen {
  readonly str: string;
  readonly lt: number;
  readonly base: number | null;
  readonly name: string;
  readonly attrs: string;
  readonly afterOpen: number;
  readonly shorthand: boolean;
  readonly kind: 'component' | 'element';
}
function parseTemplateTagPaired(open: TemplateTagOpen): TemplateTagResult {
  const { str, lt, base, name, attrs, afterOpen, shorthand, kind } = open;
  const closeIdx = shorthand
    ? findMatchingFragmentClose(str, afterOpen)
    : findMatchingClose(str, afterOpen, name);
  if (closeIdx === -1) {
    return { kind: 'bail', what: `an unclosed <${shorthand ? '' : name}> tag` };
  }
  const inner = str.slice(afterOpen, closeIdx);
  const innerResult = parseTemplate(inner, base === null ? null : base + afterOpen);
  if (!innerResult.clean) {
    return { kind: 'child-bail' };
  } // the inner frame recorded the cause
  // A run written across several lines keeps its raw inner. The tree can't
  // hold it: whitespace-only text between the tags is dropped, so the break
  // before a closing tag exists nowhere else, and the serializer needs it to
  // put a hand-wrapped paragraph back the way it found it.
  const source =
    inner.includes('\n') && (isInlineRun(innerResult.nodes) || innerResult.nodes.length === 0)
      ? inner
      : undefined;
  const blankAfter = innerResult.trailingBlank || 0;
  // The close tag may contain whitespace: </Name >
  const closeEnd = str.indexOf('>', closeIdx) + 1;
  // Kept when it is written across lines — the style that hangs the bracket
  // on its own line, which several formatters produce and which is not this
  // file's to undo.
  const closeText = str.slice(closeIdx, closeEnd);
  return {
    kind: 'tag',
    node: parseTemplateAt(
      {
        id: makeId(),
        kind,
        name,
        ...(shorthand ? { shorthand: true } : {}),
        ...(source === undefined ? {} : { source }),
        ...(blankAfter ? { blankAfter } : {}),
        ...tagProps(attrs, base === null || shorthand ? null : base + lt + 1 + name.length),
        ...(attrs && attrs.includes('\n') ? { attrSource: attrs } : {}),
        ...(closeText.includes('\n') ? { closeSource: closeText } : {}),
        children: innerResult.nodes,
      },
      base,
      lt,
      closeEnd,
    ),
    end: closeEnd,
  };
}

function numberRulesTags(doc: string): NumberRules {
  const rules: NumberRules = {};
  const tag = (name: string) => {
    const m = doc.match(new RegExp(`@${name}\\s+(${NUMBER_RE})`, 'i'));
    return m ? parseFloat(required(m[1], 'Number rule capture')) : undefined;
  };
  const min = tag('min');
  const max = tag('max');
  const step = tag('step');
  if (min !== undefined) {
    rules.min = min;
  }
  if (max !== undefined) {
    rules.max = max;
  }
  if (step !== undefined) {
    rules.step = step;
  }
  if (/@(?:int|integer)\b/i.test(doc) && rules.step === undefined) {
    rules.step = 1;
  }

  return rules;
}

function parsePropSchemaRawBlock(
  block: string,
  aliases: ReadonlyMap<string, string>,
  rawTypes: Map<string, { parts: string[]; optional: boolean }>,
  noted: Map<string, string>,
): void {
  // Walked line by line rather than matched in one pass, so the comment
  // above a prop can be carried onto it — that's the prop's documentation,
  // and the panel shows it as the field's help text.
  // The type runs to the end of the member — explodeMembers has already cut
  // the top-level semicolons, so a `;` still in there belongs to the type.
  // Refusing one cost every prop written the way TypeScript writes an object:
  // `items?: { title: string; text: string }[]` matched nothing at all, the
  // prop fell through to the destructuring — where it has no type — and a
  // list of rows came out as a code field instead of the list control.
  const entryRe = /^\s*(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*([\s\S]+?)[;,]?\s*$/;
  let doc: string[] = [];
  let inBlock = false;
  const lines = explodeMembers(block).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = required(lines[i], 'Schema line index is in bounds').trim();
    if (inBlock) {
      // Closing a block that opened on an earlier line.
      const end = line.indexOf('*/');
      doc.push((end === -1 ? line : line.slice(0, end)).replace(/^\*+\s?/, ''));
      if (end !== -1) {
        inBlock = false;
      }
      continue;
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/');
      doc.push((end === -1 ? line.slice(2) : line.slice(2, end)).replace(/^\*+\s?/, ''));
      inBlock = end === -1;
      continue;
    }
    if (line.startsWith('//')) {
      doc.push(line.slice(2).trim());
      continue;
    }
    // A blank line ends a comment's reach — otherwise a note about the
    // interface itself would land on whatever prop happens to come next.
    if (!line) {
      doc = [];
      continue;
    }
    let m = line.match(entryRe);
    // A member whose type is written across lines —
    //   variant?:
    //     | "stack"
    //     | "card"
    // — has no single line that reads as a declaration, so the scan above
    // sees nothing and the prop disappears from the schema entirely. When a
    // line opens one, take the rest of the member with it. (explodeMembers
    // already ended the member at its `;`, so what follows belongs to it.)
    if (!m && /^(?:readonly\s+)?[\w$]+\??\s*:\s*$/.test(line)) {
      const rest = [];
      while (i + 1 < lines.length) {
        const next = required(lines[i + 1], 'Following schema line exists').trim();
        if (!next || next.startsWith('/*') || next.startsWith('//')) {
          break;
        }
        if (entryRe.test(next) || /^(?:readonly\s+)?[\w$]+\??\s*:\s*$/.test(next)) {
          break;
        }
        rest.push(next);
        i += 1;
      }
      if (rest.length) {
        m = (line + ' ' + rest.join(' '))
          .replace(/\s+/g, ' ')
          .match(/^(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*(.+?)[;,]?\s*$/);
      }
    }
    if (!m) {
      doc = [];
      continue;
    }
    const name = parsePropSchemaAccumulate(aliases, rawTypes, m);
    const text = doc.join(' ').replace(/\s+/g, ' ').trim();
    if (text && !noted.has(name)) {
      noted.set(name, text);
    }
    doc = [];
  }
}

function serializeNodeMarkedRoute(node: ParserNode, path: string, atRoot: boolean) {
  const slotVal = node.props?.['slot'];
  const slotted = slotVal && slotVal.type === 'string' && !!slotVal.value;
  const tagInPlace = slotted && node.kind === 'element';
  const slotAttr = slotted ? ` slot="${slotVal.value}"` : '';
  // A slotted node with no element and no props of its own — its markers can
  // only ride inside it, which needs children to ride in.
  const markWithin =
    slotted &&
    (node.name === 'Fragment' || node.name === 'slot') &&
    Array.isArray(node.children) &&
    node.children.length > 0 &&
    !isInlineRun(node.children);
  const carryPath =
    (node.kind === 'element' || node.kind === 'component') &&
    node.name !== 'Fragment' &&
    node.name !== 'slot';
  // Where the node forwards its rest props, the caller's path for this
  // instance arrives inside the spread, and both want the same attribute. So
  // the one written here names BOTH — its own path and whatever came in on
  // Astro.props — and then has to be the one that survives.
  //
  // Which side of the spread that is depends on what the spread is. An
  // element's attributes are text: two `data-avb-p=` land in the tag and an
  // html parser keeps the FIRST, so this one goes before the spread. A
  // component's are an object: the later key overwrites, so this one goes
  // after it. Getting that backwards is silent — the tag is there, holding
  // the wrong file's path. With <Tabs> open, its root div kept the page's
  // path and a click on it resolved to nothing, which is how the canvas says
  // "you're done in here": the component closed itself the moment you clicked
  // inside it.
  const forwards = Object.keys(node.props || {}).some((k) => k.startsWith('...'));
  // A root carries its caller's name whether or not the author asked for it:
  // this element IS what the caller placed, so the caller's path for it has
  // nowhere better to be. On a page the same expression reads undefined and
  // falls away, since a page has no caller.
  const carriesCaller = forwards || atRoot;
  const pathProp: Attr = carriesCaller
    ? {
        type: 'expr',
        value: `[${JSON.stringify(path)}, Astro.props["data-avb-p"]].filter(Boolean).join(" ")`,
      }
    : { type: 'string', value: path };
  // The path attribute is put where this function decided to put it, not where
  // the file's order would have it — it was never in the file.
  const markedOrder = (n: ParserNode, carry: boolean, fwd: boolean) =>
    !carry || !n.attrOrder
      ? n.attrOrder
      : fwd && n.kind === 'element'
        ? ['data-avb-p', ...n.attrOrder]
        : [...n.attrOrder, 'data-avb-p'];
  const markedProps = !carryPath
    ? node.props
    : forwards && node.kind === 'element'
      ? { 'data-avb-p': pathProp, ...node.props }
      : { ...node.props, 'data-avb-p': pathProp };
  return {
    tagInPlace,
    markWithin,
    slotAttr,
    carryPath,
    markedProps,
    attrOrder: markedOrder(node, carryPath, forwards),
  };
}

function serializeNodeMarkedInline(
  base: ParserNode,
  indent: string,
  lines: string[],
  path: string,
  atRoot: boolean,
): void {
  const inlineKids =
    (base.kind === 'component' || base.kind === 'element') &&
    !base.chunkFile &&
    !base.chunkAggregate &&
    Array.isArray(base.children) &&
    base.children.length > 0 &&
    isInlineRun(base.children);
  if (inlineKids && (base.kind === 'element' || base.kind === 'component')) {
    assert(base.children !== null, 'Inline run has children');
    serializeNode(
      {
        ...base,
        source: undefined,
        children: tagInlineRun(base.children, path, base.name === 'Fragment' && atRoot),
      },
      indent,
      lines,
    );
  } else {
    serializeNode(base, indent, lines);
  }
}

// Conditional branch wrappers and inserted inline spaces count as real nodes,
// even though they do not advance the source scanner's emission counter.
function parseTemplateWithinBounds(nodes: readonly ParserNode[]): boolean {
  if (nodes.length > LIMITS.treeNodesMax) {
    return false;
  }
  const pending = nodes.map((node) => ({ node, depth: 0 }));
  for (let index = 0; index < pending.length; index++) {
    const entry = required(pending[index], 'Template traversal index is in bounds');
    if (entry.depth > LIMITS.treeDepthMax) {
      return false;
    }
    if (entry.node.children) {
      if (pending.length + entry.node.children.length > LIMITS.treeNodesMax) {
        return false;
      }
      for (const node of entry.node.children) {
        pending.push({ node, depth: entry.depth + 1 });
      }
    }
  }
  return true;
}
