// Parses .md / .mdx pages into the same editable tree model as .astro pages,
// with the source range of every node and of every attribute Markdown writes,
// and prints Markdown nodes: the new ones an edit adds, and a node before and
// after an edit, so the edit reaches disk as the difference between the two
// (electron/markdownEdits.ts; plan §3.4, §11 step 10). A Markdown page is
// never printed whole to be saved.
//
// The tree uses the node kinds the rest of the app already understands, so the
// navigator, the props panel, text editing, undo, copy/paste and the insert
// palette all work without knowing markdown exists:
//
//   heading      → element h1…h6      paragraph  → element p
//   list         → element ul / ol     list item  → element li
//   blockquote   → element blockquote  rule       → element hr
//   fenced code  → element pre (props.lang), one text child holding the code
//   image-only   → element img (props.src / props.alt)
//   anything else → raw-line, kept verbatim
//
// Inline formatting (**bold**, [links](…), `code`) stays as markdown inside the
// text node rather than becoming a tree of its own. That keeps a paragraph one
// editable field — the way a writer thinks about it — and, more importantly,
// makes printing exact: text this parser does not interpret is text it cannot
// corrupt.
//
// PRINTING IS EXACT. Every block records the source details that would
// otherwise be normalised away — the bullet character, the fence character and
// width, setext vs ATX headings, blank lines between items — so printing a
// node that was not edited reproduces its bytes, and printing the whole page
// reproduces the file (the round-trip tests pin it). An edit is written as the
// difference between the node printed before and after it, placed on the
// node's own bytes; anything this file cannot reproduce exactly belongs in a
// raw-line instead.
//
// SPANS (plan §3.2, step 10). Each container — a quote, a list item — reads
// its lines with its own syntax taken off the front, and every line remembers
// where its text starts in the file, so a node's range is exact however deep
// it sits: slicing the file at it gives the node as printed at its place, with
// the container's prefix on every line after the first. Offsets are UTF-16,
// into the text as read, a leading byte-order mark included.

import { assert } from '../shared/assert';
import { LIMITS } from '../shared/limits';
import type { Attr, AttrSpan } from '../shared/page-node';
import { toUtf16Span } from '../shared/span';
import { parseTemplate, serializeNodes } from './astroParser.js';

/** A line as one container sees it: its text with the container's own syntax
 * taken off the front (a quote's `>`, an item's indentation), and where that
 * text starts in the file. */
interface Line {
  readonly text: string;
  readonly start: number;
}

// The node bag this module builds. Mutable while a parse builds it — the block
// readers fill in the fields a node turns out to need, and the final pass
// writes the ids — and read-only once the model is returned. The md* fields
// exist only to make printing exact.
interface MdNode {
  id?: string;
  kind: string;
  name?: string;
  value?: string;
  inner?: string;
  props?: Record<string, Attr> | undefined;
  children?: MdNode[] | undefined;
  start?: number;
  end?: number;
  attrSpans?: readonly AttrSpan[];
  mdBlanksBefore?: number;
  mdIndent?: string;
  mdFence?: string;
  mdInfo?: string;
  mdUnclosed?: boolean;
  mdRaw?: string;
  mdGap?: string;
  mdTrail?: string;
  mdSetext?: string;
  mdImage?: boolean;
  mdNumbers?: readonly number[];
  mdLoose?: boolean;
  mdMarker?: string;
  mdSource?: string;
  mdEsm?: boolean;
}

// Trailing blank lines ride on the list itself (see the end of parseBlocks).
type MarkdownNodeList = MdNode[] & { mdTrailingBlanks?: number };

/** What the printer reads: a parsed node, or a new one an edit adds. */
export interface PrintNode {
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly inner?: string;
  readonly props?: Readonly<Record<string, Attr>> | undefined;
  readonly children?: readonly PrintNode[] | undefined;
  readonly mdBlanksBefore?: number;
  readonly mdIndent?: string;
  readonly mdFence?: string;
  readonly mdInfo?: string;
  readonly mdUnclosed?: boolean;
  readonly mdRaw?: string;
  readonly mdGap?: string;
  readonly mdTrail?: string;
  readonly mdSetext?: string;
  readonly mdNumbers?: readonly number[];
  readonly mdMarker?: string;
  readonly mdSource?: string;
}

/** Where a node is written: the prefix every line after its first carries
 * (a quote's `> `, an item's indentation, both when nested) and the file's
 * line break. */
export interface MarkdownLayout {
  readonly prefix: string;
  readonly eol: string;
}

// Nodes are built with this placeholder id; the final pass writes each node's
// structural path (`n0`, `n0.2`, `n0.2.1`), as the .astro parser does, so a
// parse is a pure function of its text (plan §4, §11.9).
const PENDING_ID = 'n0';

const ATX_RE = /^(\s{0,3})(#{1,6})(\s+)(.*?)(\s*#*\s*)$/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*(.*)$/;
const FENCE_CLOSE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*$/;
const RULE_RE = /^(\s{0,3})((?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const BULLET_RE = /^(\s*)([-*+])(\s+)(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
const QUOTE_RE = /^(\s{0,3})>(\s?)(.*)$/;
const SETEXT_RE = /^(\s{0,3})(=+|-+)\s*$/;
const MARKUP_RE = /^\s{0,3}</;
// A line that ends a quote's lazy continuation: the start of another block.
const LAZY_BREAK_RE = /^\s{0,3}(#|>|```|~~~|[-*+]\s|\d+[.)]\s)/;
// A line that is nothing but an image — the one inline construct promoted to a
// node of its own, so the asset picker can edit it like any other <img>.
const IMAGE_ONLY_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
const ESM_RE = /^(import|export)\s/;
const MDX_IMPORT_RE = /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/;

// A quote or list nested deeper than this is kept as one raw block: its
// blocks would need more tree depth than the wire model allows, and reading it
// would recurse once per level (AGENTS.md §10). Three levels are left for the
// deepest container's own children: an item, its paragraph, and the text.
const CONTAINER_DEPTH_MAX = LIMITS.treeDepthMax - 3;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

// Markdown frontmatter is YAML, not JS, so it is kept as text and handed to the
// same frontmatter editor .astro pages use. `layout:` is read back out by name
// because the layout picker needs it — see layoutFromFrontmatter.
function splitFrontmatter(source: string): {
  frontmatter: string | null;
  body: string;
  offset: number;
} {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) {
    return { frontmatter: null, body: source, offset: 0 };
  }
  const offset = m[0]?.length ?? 0;
  return { frontmatter: m[1] ?? null, body: source.slice(offset), offset };
}

// The `layout:` value from YAML frontmatter, unquoted. Markdown pages pick
// their layout here rather than by importing it, so the app's layout picker
// reads and writes this field.
function layoutFromFrontmatter(frontmatter: string | null | undefined): string | undefined {
  if (!frontmatter) {
    return undefined;
  }
  const m = frontmatter.match(/^[ \t]*layout[ \t]*:[ \t]*(.+?)[ \t]*$/m);
  if (!m) {
    return undefined;
  }
  return (m[1] ?? '').replace(/^['"]|['"]$/g, '') || undefined;
}

// ---------------------------------------------------------------------------
// Lines and offsets
// ---------------------------------------------------------------------------

// The body's lines, each with the file offset of its first character. A line
// break is `\n` or `\r\n` (the break itself belongs to no line), as
// `body.split(/\r?\n/)` splits it.
function splitLines(body: string, base: number): Line[] {
  const lines: Line[] = [];
  let from = 0;
  // Each pass consumes one line break, so the loop ends within the body.
  for (let at = body.indexOf('\n'); at !== -1; at = body.indexOf('\n', from)) {
    const end = at > from && body.charCodeAt(at - 1) === 0x0d ? at - 1 : at;
    lines.push({ text: body.slice(from, end), start: base + from });
    from = at + 1;
  }
  lines.push({ text: body.slice(from), start: base + from });
  assert(lines.length >= 1, 'A body has at least one line');
  return lines;
}

function lineAt(lines: readonly Line[], index: number): Line {
  const line = lines[index];
  assert(line !== undefined, 'A line index lies inside its container');
  return line;
}

function isBlank(line: Line): boolean {
  return line.text.trim() === '';
}

function lineEnd(line: Line): number {
  return line.start + line.text.length;
}

// Where the run of non-blank lines starting at `from` ends.
function nonBlankEnd(lines: readonly Line[], from: number): number {
  let at = from;
  while (at < lines.length) {
    if (isBlank(lineAt(lines, at))) {
      break;
    }
    at++;
  }
  return at;
}

// A new node's id and the range of lines `first` up to (not including) `next`.
function placed(
  lines: readonly Line[],
  first: number,
  next: number,
): { id: string; start: number; end: number } {
  assert(first < next, 'A node covers at least one line');
  const start = lineAt(lines, first).start;
  return { id: PENDING_ID, start, end: lineEnd(lineAt(lines, next - 1)) };
}

/** Lines joined with `\n`, as a block reads them, and the file offset of any
 * offset into that text: a position inside or at the end of a line is that
 * far into the line's own text in the file. */
interface Joined {
  readonly text: string;
  readonly at: (offset: number) => number;
}

function joinedLines(lines: readonly Line[]): Joined {
  assert(lines.length > 0, 'A block joins at least one line');
  const starts: number[] = [];
  let length = 0;
  for (const line of lines) {
    starts.push(length);
    length += line.text.length + 1;
  }
  const text = lines.map((line) => line.text).join('\n');
  const at = (offset: number): number => {
    assert(offset >= 0, 'A joined offset is not negative');
    assert(offset <= text.length, 'A joined offset lies inside the text');
    // The last line starting at or before the offset: binary search.
    let low = 0;
    let high = starts.length - 1;
    for (let pass = 0; pass <= 32; pass++) {
      if (low < high) {
        const middle = low + Math.ceil((high - low) / 2);
        if ((starts[middle] ?? 0) <= offset) {
          low = middle;
        } else {
          high = middle - 1;
        }
      } else {
        return lineAt(lines, low).start + (offset - (starts[low] ?? 0));
      }
    }
    throw new Error('Assertion failed: the line search ends within 32 passes');
  };
  return { text, at };
}

// Markup nodes parsed from a joined block carry offsets into that block; move
// them, and their attributes', to the file. Iterative: the depth bound is the
// template parser's, not the call stack's.
function relocate(roots: readonly MdNode[], at: (offset: number) => number): void {
  const pending = [...roots];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'Relocation stays inside the tree bound');
    const node = pending[visited];
    assert(node !== undefined, 'The visit index lies inside the pending list');
    assert(node.start !== undefined, 'A located template node has a start');
    assert(node.end !== undefined, 'A located template node has an end');
    node.start = at(node.start);
    node.end = at(node.end);
    if (node.attrSpans !== undefined) {
      node.attrSpans = node.attrSpans.map((entry) => relocatedAttr(entry, at));
    }
    pending.push(...(node.children ?? []));
  }
}

function relocatedAttr(entry: AttrSpan, at: (offset: number) => number): AttrSpan {
  const moved = (span: { readonly start: number; readonly end: number }) =>
    toUtf16Span(at(span.start), at(span.end));
  switch (entry.type) {
    case 'string':
    case 'expr':
      return {
        ...entry,
        span: moved(entry.span),
        nameSpan: moved(entry.nameSpan),
        valueSpan: moved(entry.valueSpan),
      };
    case 'bare':
      return { ...entry, span: moved(entry.span), nameSpan: moved(entry.nameSpan) };
    case 'spread':
    case 'markdown':
      return { ...entry, span: moved(entry.span), valueSpan: moved(entry.valueSpan) };
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

// An attribute Markdown writes in its own syntax: `span` includes its
// delimiters (the brackets around alt text, the quotes around a title), the
// value span is the value alone.
function markdownAttr(
  name: string,
  span: readonly [number, number],
  value: readonly [number, number],
): AttrSpan {
  return {
    type: 'markdown',
    name,
    span: toUtf16Span(span[0], span[1]),
    valueSpan: toUtf16Span(value[0], value[1]),
  };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

interface ParseEnv {
  readonly mdx: boolean;
  readonly imports: { name: string; path: string }[];
  readonly esm: string[];
}

/** What one block reader consumed: its nodes, and the first line after them. */
interface BlockRead {
  readonly nodes: readonly MdNode[];
  readonly next: number;
}

// Splits `lines` (already dedented to their container) into block nodes at
// `depth`. Blank lines are carried on the node that follows them, so the exact
// spacing of the source comes back when it is printed.
function parseBlocks(lines: readonly Line[], env: ParseEnv, depth: number): MarkdownNodeList {
  const nodes: MarkdownNodeList = [];
  let pendingBlanks = 0;
  let index = 0;
  // Every pass consumes at least one line.
  for (let pass = 0; index < lines.length; pass++) {
    assert(pass < lines.length, 'Each pass consumes a line');
    if (isBlank(lineAt(lines, index))) {
      pendingBlanks += 1;
      index += 1;
      continue;
    }
    const read = readBlock(lines, index, env, depth);
    assert(read.next > index, 'A block consumes at least one line');
    for (const node of read.nodes) {
      if (pendingBlanks) {
        node.mdBlanksBefore = pendingBlanks;
      }
      pendingBlanks = 0;
      nodes.push(node);
    }
    index = read.next;
  }
  // Trailing blank lines have no node to ride on, so they are recorded on the
  // list itself — otherwise printing would trim the end of the container.
  nodes.mdTrailingBlanks = pendingBlanks;
  return nodes;
}

// The first reader that recognises the line decides the block. The order is
// the parser's grammar: a thematic break before lists (`- - -` is a rule, not
// three bullets), a table before a paragraph.
function readBlock(lines: readonly Line[], index: number, env: ParseEnv, depth: number): BlockRead {
  return (
    readEsm(lines, index, env) ??
    readMarkup(lines, index, env) ??
    readFence(lines, index) ??
    readRule(lines, index) ??
    readHeading(lines, index) ??
    readQuote(lines, index, env, depth) ??
    readList(lines, index, env, depth) ??
    readTable(lines, index) ??
    readParagraph(lines, index)
  );
}

// MDX: ESM imports and exports. Hoisted into the same `imports` list an
// .astro page has, so the palette can tell which components this page can
// use; the block stays in the tree so the block order survives.
function readEsm(lines: readonly Line[], index: number, env: ParseEnv): BlockRead | undefined {
  if (!env.mdx) {
    return undefined;
  }
  if (!ESM_RE.test(lineAt(lines, index).text)) {
    return undefined;
  }
  const next = nonBlankEnd(lines, index);
  const text = joinedLines(lines.slice(index, next)).text;
  const im = text.match(MDX_IMPORT_RE);
  if (im) {
    env.imports.push({ name: im[1] ?? '', path: im[2] ?? '' });
  } else {
    env.esm.push(text);
  }
  const node: MdNode = {
    ...placed(lines, index, next),
    kind: 'raw-line',
    value: text,
    mdEsm: true,
  };
  return { nodes: [node], next };
}

// An HTML or JSX block. A component in MDX is exactly the JSX an .astro page
// holds, so it is parsed by the .astro parser and lands in the tree as the
// same node — which is what makes a component inside a post selectable and
// editable. It runs to the first blank line, which is how both markdown and
// MDX delimit an embedded block.
function readMarkup(lines: readonly Line[], index: number, env: ParseEnv): BlockRead | undefined {
  if (!MARKUP_RE.test(lineAt(lines, index).text)) {
    return undefined;
  }
  const next = nonBlankEnd(lines, index);
  const block = joinedLines(lines.slice(index, next));
  const raw: BlockRead = {
    nodes: [{ ...placed(lines, index, next), kind: 'raw-line', value: block.text }],
    next,
  };
  const parsed = parseTemplate(block.text, 0);
  // One node per block, not per element. The canvas numbers markdown blocks
  // by their index among the document's root nodes, and remark treats a run
  // of raw HTML as a single node however many tags it holds — so a block that
  // opens two sibling elements has to stay one node here too, or every block
  // after it would be numbered one too high. MDX is exempt: there each JSX
  // element really is its own root node.
  if (!env.mdx) {
    if (!parsed.clean || parsed.nodes.length !== 1) {
      return raw;
    }
  }
  if (!parsed.clean || parsed.nodes.length === 0) {
    return raw;
  }
  const nodes: MdNode[] = parsed.nodes;
  relocate(nodes, block.at);
  const [only] = nodes;
  if (only !== undefined && nodes.length === 1) {
    // The .astro printer reflows what it writes (a short component collapses
    // onto one line). Keeping the source lets the printer emit it verbatim for
    // as long as the node still means the same thing.
    only.mdSource = block.text;
  }
  return { nodes, next };
}

function readFence(lines: readonly Line[], index: number): BlockRead | undefined {
  const opening = lineAt(lines, index);
  const fence = opening.text.match(FENCE_RE);
  if (!fence) {
    return undefined;
  }
  const marker = fence[2] ?? '';
  const info = fence[3] ?? '';
  const close = closingFence(lines, index + 1, marker);
  const bodyEnd = close ?? lines.length;
  const next = close === undefined ? lines.length : close + 1;
  const body = lines.slice(index + 1, bodyEnd);
  const lang = info.trim();
  const node: MdNode = {
    ...placed(lines, index, next),
    kind: 'element',
    name: 'pre',
    props: lang ? { lang: { type: 'string', value: lang } } : {},
    children: body.length
      ? [{ ...placed(lines, index + 1, bodyEnd), kind: 'text', value: joinedLines(body).text }]
      : [],
    mdIndent: fence[1] ?? '',
    mdFence: marker,
    mdInfo: info,
  };
  if (lang) {
    // The info string runs to the end of the line; its language is its start.
    const from = lineEnd(opening) - info.length;
    node.attrSpans = [markdownAttr('lang', [from, from + lang.length], [from, from + lang.length])];
  }
  // Only a closed fence has the closing line re-emitted; the flag is omitted
  // when false, which keeps serialized JSON byte-identical.
  if (close === undefined) {
    node.mdUnclosed = true;
  }
  return { nodes: [node], next };
}

// The index of the line closing a fence opened with `marker`, if any.
function closingFence(lines: readonly Line[], from: number, marker: string): number | undefined {
  for (let at = from; at < lines.length; at++) {
    const close = lineAt(lines, at).text.match(FENCE_CLOSE_RE);
    const found = close?.[2] ?? '';
    if (close) {
      if (found.length >= marker.length) {
        if (found.charAt(0) === marker.charAt(0)) {
          return at;
        }
      }
    }
  }
  return undefined;
}

function readRule(lines: readonly Line[], index: number): BlockRead | undefined {
  const line = lineAt(lines, index);
  if (!RULE_RE.test(line.text)) {
    return undefined;
  }
  const node: MdNode = {
    ...placed(lines, index, index + 1),
    kind: 'element',
    name: 'hr',
    props: {},
    children: undefined,
    mdRaw: line.text,
  };
  return { nodes: [node], next: index + 1 };
}

function readHeading(lines: readonly Line[], index: number): BlockRead | undefined {
  const line = lineAt(lines, index);
  const atx = line.text.match(ATX_RE);
  if (!atx) {
    return undefined;
  }
  const indent = atx[1] ?? '';
  const hashes = atx[2] ?? '';
  const gap = atx[3] ?? '';
  const text = atx[4] ?? '';
  const from = line.start + indent.length + hashes.length + gap.length;
  const node: MdNode = {
    ...placed(lines, index, index + 1),
    kind: 'element',
    name: `h${hashes.length}`,
    props: {},
    children: text
      ? [{ id: PENDING_ID, kind: 'text', value: text, start: from, end: from + text.length }]
      : [],
    mdIndent: indent,
    mdGap: gap,
    mdTrail: atx[5] ?? '',
  };
  return { nodes: [node], next: index + 1 };
}

function readQuote(
  lines: readonly Line[],
  index: number,
  env: ParseEnv,
  depth: number,
): BlockRead | undefined {
  if (!QUOTE_RE.test(lineAt(lines, index).text)) {
    return undefined;
  }
  const inner: Line[] = [];
  let gap = ' ';
  let next = index;
  while (next < lines.length) {
    const line = lineAt(lines, next);
    const q = line.text.match(QUOTE_RE);
    if (!q) {
      // A lazy continuation line belongs to the quote's last paragraph.
      if (isBlank(line) || LAZY_BREAK_RE.test(line.text)) {
        break;
      }
      inner.push(line);
      next++;
      continue;
    }
    if (q[2]) {
      gap = q[2];
    }
    const taken = (q[1] ?? '').length + 1 + (q[2] ?? '').length;
    inner.push({ text: q[3] ?? '', start: line.start + taken });
    next++;
  }
  if (depth >= CONTAINER_DEPTH_MAX) {
    return rawBlock(lines, index, next);
  }
  const node: MdNode = {
    ...placed(lines, index, next),
    kind: 'element',
    name: 'blockquote',
    props: {},
    children: parseBlocks(inner, env, depth + 1),
    mdGap: gap,
  };
  return { nodes: [node], next };
}

// Lines kept verbatim as one block: a container nested past the bound.
function rawBlock(lines: readonly Line[], index: number, next: number): BlockRead {
  const text = joinedLines(lines.slice(index, next)).text;
  return { nodes: [{ ...placed(lines, index, next), kind: 'raw-line', value: text }], next };
}

/** One list's shape, read off its first line: what every item of it shares. */
interface ListShape {
  readonly ordered: boolean;
  readonly indent: string;
  readonly marker: string;
}

function readList(
  lines: readonly Line[],
  index: number,
  env: ParseEnv,
  depth: number,
): BlockRead | undefined {
  const first = lineAt(lines, index).text;
  const bullet = first.match(BULLET_RE);
  const ordered = first.match(ORDERED_RE);
  const opening = bullet ?? ordered;
  if (!opening) {
    return undefined;
  }
  const shape: ListShape = {
    ordered: ordered !== null,
    indent: opening[1] ?? '',
    marker: ordered ? (ordered[3] ?? '.') : (bullet?.[2] ?? '-'),
  };
  // The items' extents first: a list nested past the bound is kept raw
  // before any of its items is read into blocks.
  const reads: { readonly at: number; readonly item: ItemRead }[] = [];
  let next = index;
  while (next < lines.length) {
    const item = readItem(lines, next, shape);
    if (item === undefined) {
      break; // A different marker or indent starts a different list.
    }
    reads.push({ at: next, item });
    next = item.next;
  }
  assert(reads.length > 0, 'A list has the item its first line opened');
  if (depth >= CONTAINER_DEPTH_MAX) {
    return rawBlock(lines, index, next);
  }
  const items = reads.map(({ at, item }) => itemNode(lines, at, item, env, depth));
  const numbers = reads.flatMap(({ item }) => (item.number === undefined ? [] : [item.number]));
  const node = listNode(lines, index, next, { shape, items, numbers });
  if (reads.some(({ item }) => item.loose)) {
    node.mdLoose = true;
  }
  return { nodes: [node], next };
}

/** One item's lines: the text after its marker, then what is indented under it. */
interface ItemRead {
  readonly inner: readonly Line[];
  readonly gap: string;
  readonly number: number | undefined;
  readonly loose: boolean;
  /** The last line holding the item's content. */
  readonly last: number;
  readonly next: number;
}

function readItem(lines: readonly Line[], index: number, shape: ListShape): ItemRead | undefined {
  const line = lineAt(lines, index);
  const m = line.text.match(shape.ordered ? ORDERED_RE : BULLET_RE);
  if (!m) {
    return undefined;
  }
  if ((m[1] ?? '') !== shape.indent) {
    return undefined;
  }
  if ((shape.ordered ? m[3] : m[2]) !== shape.marker) {
    return undefined;
  }
  const gap = (shape.ordered ? m[4] : m[3]) ?? '';
  const content = (shape.ordered ? m[5] : m[4]) ?? '';
  const markerWidth = shape.ordered ? (m[2]?.length ?? 0) + 1 : 1;
  const contentIndent = shape.indent.length + markerWidth + gap.length;
  const inner: Line[] = [{ text: content, start: line.start + contentIndent }];
  const pad = ' '.repeat(contentIndent);
  let loose = false;
  let last = index;
  let next = index + 1;
  // Continuation lines: anything indented under the item, plus blank lines
  // that are followed by more of the item.
  while (next < lines.length) {
    const continued = lineAt(lines, next);
    if (isBlank(continued)) {
      const resumed = firstNonBlank(lines, next);
      if (resumed === undefined || !lineAt(lines, resumed).text.startsWith(pad)) {
        break;
      }
      loose = true;
      for (let blank = next; blank < resumed; blank++) {
        inner.push({ text: '', start: lineAt(lines, blank).start });
      }
      next = resumed;
      continue;
    }
    if (!continued.text.startsWith(pad)) {
      break;
    }
    const text = continued.text.slice(contentIndent);
    inner.push({ text, start: continued.start + contentIndent });
    last = next;
    next++;
  }
  const number = shape.ordered ? Number(m[2] ?? '') : undefined;
  return { inner, gap, number, loose, last, next };
}

function firstNonBlank(lines: readonly Line[], from: number): number | undefined {
  for (let at = from; at < lines.length; at++) {
    if (!isBlank(lineAt(lines, at))) {
      return at;
    }
  }
  return undefined;
}

// An item starts at its marker: the list's own indentation belongs to the
// list, whose first item starts one indentation later than it does.
function itemNode(
  lines: readonly Line[],
  index: number,
  item: ItemRead,
  env: ParseEnv,
  depth: number,
): MdNode {
  const line = lineAt(lines, index);
  const indent = (line.text.match(/^\s*/)?.[0] ?? '').length;
  return {
    id: PENDING_ID,
    kind: 'element',
    name: 'li',
    props: {},
    children: parseBlocks(item.inner, env, depth + 2),
    mdGap: item.gap,
    start: line.start + indent,
    end: lineEnd(lineAt(lines, item.last)),
  };
}

function listNode(
  lines: readonly Line[],
  index: number,
  next: number,
  read: {
    readonly shape: ListShape;
    readonly items: MdNode[];
    readonly numbers: readonly number[];
  },
): MdNode {
  const { shape, items } = read;
  const last = items[items.length - 1];
  assert(last?.end !== undefined, 'A list ends where its last item ends');
  const start = lineAt(lines, index).start;
  const node: MdNode = {
    id: PENDING_ID,
    kind: 'element',
    name: shape.ordered ? 'ol' : 'ul',
    props: {},
    children: items,
    mdIndent: shape.indent,
    mdMarker: shape.marker,
    start,
    end: last.end,
  };
  assert(next > index, 'A list consumes its first line');
  if (shape.ordered) {
    // Re-emitted exactly: a list written 1. 1. 1. must not become 1. 2. 3.
    node.mdNumbers = read.numbers;
    const first = read.numbers[0];
    assert(first !== undefined, 'An ordered list has its first number');
    if (first !== 1) {
      node.props = { start: { type: 'string', value: String(first) } };
      // The digits say the number; `07.` says it too, and then no span can
      // hold the value as the props record reports it, so none is recorded.
      const digits = lineAt(lines, index).text.slice(shape.indent.length).match(/^\d+/)?.[0];
      if (digits === String(first)) {
        const from = start + shape.indent.length;
        const range = [from, from + digits.length] as const;
        node.attrSpans = [markdownAttr('start', range, range)];
      }
    }
  }
  return node;
}

// A table's shape lives in its alignment row; nothing in the tree models
// that, so it stays source.
function readTable(lines: readonly Line[], index: number): BlockRead | undefined {
  if (!lineAt(lines, index).text.includes('|')) {
    return undefined;
  }
  if (index + 1 >= lines.length) {
    return undefined;
  }
  const alignment = lineAt(lines, index + 1).text;
  if (!/^[\s|:-]+$/.test(alignment) || !alignment.includes('-')) {
    return undefined;
  }
  return rawBlock(lines, index, nonBlankEnd(lines, index));
}

// A paragraph ends where another block begins.
function endsParagraph(text: string): boolean {
  return (
    ATX_RE.test(text) ||
    FENCE_RE.test(text) ||
    RULE_RE.test(text) ||
    QUOTE_RE.test(text) ||
    MARKUP_RE.test(text) ||
    SETEXT_RE.test(text)
  );
}

// A paragraph, and the setext heading or image it can turn out to be.
function readParagraph(lines: readonly Line[], index: number): BlockRead {
  let next = index + 1;
  while (next < lines.length) {
    const line = lineAt(lines, next);
    if (isBlank(line) || endsParagraph(line.text)) {
      break;
    }
    next++;
  }
  const text = joinedLines(lines.slice(index, next));
  const textNode: MdNode = { ...placed(lines, index, next), kind: 'text', value: text.text };
  // An underline directly under paragraph text makes it a heading. This is
  // decided here rather than by looking ahead, because `---` is both a setext
  // underline and a thematic break and only the paragraph above it tells them
  // apart: touching the text it's a heading, separated by a blank line it's a
  // rule (the blank ends the paragraph first).
  const underline = next < lines.length ? lineAt(lines, next).text : undefined;
  if (underline !== undefined && SETEXT_RE.test(underline)) {
    const node: MdNode = {
      ...placed(lines, index, next + 1),
      kind: 'element',
      name: underline.trim().charAt(0) === '=' ? 'h1' : 'h2',
      props: {},
      children: [textNode],
      mdSetext: underline,
    };
    return { nodes: [node], next: next + 1 };
  }
  const image = imageNode(lines, index, next, text);
  if (image !== undefined) {
    return { nodes: [image], next };
  }
  const node: MdNode = {
    ...placed(lines, index, next),
    kind: 'element',
    name: 'p',
    props: {},
    children: [textNode],
  };
  return { nodes: [node], next };
}

// `![alt](src "title")` alone: its alt, source and title as attributes, each
// with the range it is written in (the brackets and quotes around alt and
// title belong to the attribute, not the value).
function imageNode(
  lines: readonly Line[],
  index: number,
  next: number,
  text: Joined,
): MdNode | undefined {
  const img = text.text.match(IMAGE_ONLY_RE);
  if (!img) {
    return undefined;
  }
  const alt = img[1] ?? '';
  const src = img[2] ?? '';
  const title = img[3];
  const at = (offset: number): number => text.at(offset);
  const props: Record<string, Attr> = { src: { type: 'string', value: src } };
  const spans: AttrSpan[] = [];
  const altEnd = 2 + alt.length;
  if (alt) {
    props['alt'] = { type: 'string', value: alt };
    spans.push(markdownAttr('alt', [at(1), at(altEnd + 1)], [at(2), at(altEnd)]));
  }
  const srcStart = altEnd + 2;
  const srcRange = [at(srcStart), at(srcStart + src.length)] as const;
  spans.push(markdownAttr('src', srcRange, srcRange));
  if (title) {
    props['title'] = { type: 'string', value: title };
    const titleEnd = text.text.length - 2; // The closing quote, before `)`.
    const titleStart = titleEnd - title.length;
    spans.push(
      markdownAttr('title', [at(titleStart - 1), at(titleEnd + 1)], [at(titleStart), at(titleEnd)]),
    );
  }
  return {
    ...placed(lines, index, next),
    kind: 'element',
    name: 'img',
    props,
    children: undefined,
    mdImage: true,
    attrSpans: spans,
  };
}

// ---------------------------------------------------------------------------
// Ids and bounds
// ---------------------------------------------------------------------------

// Give every node of a finished tree its path id. The tree is the parse's
// own, just built, so this is the one place its ids are written; nodes the
// .astro parser built for a JSX block get paths in this tree. Iterative.
function assignPathIds(roots: readonly MdNode[]): { nodes: number; depth: number } {
  const pending: { readonly node: MdNode; readonly path: string; readonly depth: number }[] = [];
  roots.forEach((node, index) => pending.push({ node, path: String(index), depth: 0 }));
  let depth = 0;
  for (let visited = 0; visited < pending.length; visited++) {
    const entry = pending[visited];
    assert(entry !== undefined, 'The visit index lies inside the pending list');
    entry.node.id = `n${entry.path}`;
    depth = Math.max(depth, entry.depth);
    if (pending.length > LIMITS.treeNodesMax) {
      return { nodes: pending.length, depth };
    }
    (entry.node.children ?? []).forEach((child, index) =>
      pending.push({ node: child, path: `${entry.path}.${index}`, depth: entry.depth + 1 }),
    );
  }
  return { nodes: pending.length, depth };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function serializeBlocks(nodes: readonly PrintNode[] | undefined, out: string[]): void {
  for (const node of nodes ?? []) {
    pushBlanks(out, node.mdBlanksBefore ?? 0);
    serializeBlock(node, out);
  }
  // Only a parsed list carries the count; 'in' keeps the read cast-free.
  const trailing = nodes && 'mdTrailingBlanks' in nodes ? Number(nodes['mdTrailingBlanks']) : 0;
  pushBlanks(out, trailing);
}

function pushBlanks(out: string[], count: number): void {
  assert(count <= LIMITS.treeNodesMax, 'Blank runs are inside the parser bound');
  for (let b = 0; b < count; b++) {
    out.push('');
  }
}

function attrValue(attr: Attr | undefined): string | undefined {
  return attr !== undefined && 'value' in attr ? attr.value : undefined;
}

function textOf(node: PrintNode): string {
  return (node.children ?? [])
    .filter((child) => child.kind === 'text')
    .map((child) => child.value)
    .join('');
}

// A node the app created (from the insert palette, or by pasting) has none of
// the md* source details, so these defaults are also the "new block" format.
function serializeBlock(node: PrintNode, out: string[]): void {
  switch (node.kind) {
    case 'raw-line':
    case 'raw':
      out.push(...String(node.value ?? node.inner ?? '').split('\n'));
      return;
    case 'text':
      out.push(...String(node.value ?? '').split('\n'));
      return;
    case 'comment':
      out.push(`<!--${node.value}-->`);
      return;
    default:
      serializeElement(node, out);
  }
}

function serializeElement(node: PrintNode, out: string[]): void {
  const name = node.name || '';
  if (/^h[1-6]$/.test(name)) {
    serializeHeading(node, out);
  } else if (name === 'p') {
    out.push(...textOf(node).split('\n'));
  } else if (name === 'hr') {
    out.push(node.mdRaw ?? '---');
  } else if (name === 'img') {
    const val = (p: string): string => attrValue(node.props?.[p]) ?? '';
    const title = val('title') ? ` "${val('title')}"` : '';
    out.push(`![${val('alt')}](${val('src')}${title})`);
  } else if (name === 'pre') {
    serializeFence(node, out);
  } else if (name === 'blockquote') {
    serializeQuote(node, out);
  } else if (name === 'ul' || name === 'ol') {
    serializeList(node, out);
  } else {
    serializeMarkup(node, out);
  }
}

function serializeHeading(node: PrintNode, out: string[]): void {
  if (node.mdSetext) {
    out.push(textOf(node));
    out.push(node.mdSetext);
    return;
  }
  const hashes = '#'.repeat(Number((node.name ?? '').charAt(1)));
  const indent = node.mdIndent ?? '';
  out.push(`${indent}${hashes}${node.mdGap ?? ' '}${textOf(node)}${node.mdTrail ?? ''}`);
}

function serializeFence(node: PrintNode, out: string[]): void {
  const indent = node.mdIndent ?? '';
  const fence = node.mdFence ?? '```';
  const info = node.mdInfo ?? attrValue(node.props?.['lang']) ?? '';
  out.push(`${indent}${fence}${info}`);
  const lines = textOf(node).split('\n');
  if (lines.length !== 1 || lines[0] !== '') {
    out.push(...lines);
  }
  if (!node.mdUnclosed) {
    out.push(`${indent}${fence}`);
  }
}

function serializeQuote(node: PrintNode, out: string[]): void {
  const inner: string[] = [];
  serializeBlocks(node.children ?? [], inner);
  const gap = node.mdGap ?? ' ';
  for (const l of inner) {
    out.push(l ? `>${gap}${l}` : '>');
  }
}

function serializeList(node: PrintNode, out: string[]): void {
  const ordered = node.name === 'ol';
  const marker = node.mdMarker ?? (ordered ? '.' : '-');
  const start = Number(attrValue(node.props?.['start']) ?? 1) || 1;
  const indent = node.mdIndent ?? '';
  (node.children ?? []).forEach((item, index) => {
    pushBlanks(out, item.mdBlanksBefore ?? 0);
    const number = ordered ? (node.mdNumbers?.[index] ?? start + index) : undefined;
    serializeItem(item, { marker, number, indent }, out);
  });
}

/** How one item's marker is written: the list's marker character, the item's
 * number in an ordered list, and the list's own indentation. */
interface ItemMarker {
  readonly marker: string;
  readonly number: number | undefined;
  readonly indent: string;
}

// The first line carries the marker after the list's indentation; the rest
// are indented to the item's content.
function serializeItem(item: PrintNode, at: ItemMarker, out: string[]): void {
  const bullet = at.number === undefined ? at.marker : `${at.number}${at.marker}`;
  const gap = item.mdGap ?? ' ';
  const inner: string[] = [];
  serializeBlocks(item.children ?? [], inner);
  const pad = ' '.repeat(at.indent.length + bullet.length + gap.length);
  inner.forEach((l, k) => {
    if (k === 0) {
      out.push(`${at.indent}${bullet}${gap}${l}`);
    } else {
      out.push(l ? pad + l : '');
    }
  });
  if (!inner.length) {
    out.push(`${at.indent}${bullet}`);
  }
}

// Anything else came from JSX (a component in MDX, or an HTML block) — the
// .astro serializer owns those, and owns them exactly. It returns a string
// with a trailing newline; markdown works in lines, so drop it.
function serializeMarkup(node: PrintNode, out: string[]): void {
  const text = serializeNodes([node]).replace(/\n$/, '');
  // Untouched? Then write back what was there. The comparison is between two
  // serializations, not two source strings, so it answers "does this node
  // still say what the source said" rather than "is the text identical" —
  // formatting the .astro writer would normalise doesn't count as a change.
  if (node.mdSource !== undefined) {
    const original = parseTemplate(node.mdSource);
    if (original.clean && original.nodes.length === 1) {
      if (serializeNodes(original.nodes).replace(/\n$/, '') === text) {
        out.push(...node.mdSource.split('\n'));
        return;
      }
    }
  }
  out.push(...text.split('\n'));
}

// Lines a container reads, written at their place: every line after the first
// carries the prefix, and a blank one only the prefix's visible part (`>`).
function placedLines(lines: readonly string[], layout: MarkdownLayout): string {
  const blank = layout.prefix.trimEnd();
  return lines
    .map((line, index) => {
      if (index === 0) {
        return line;
      }
      return line === '' ? blank : `${layout.prefix}${line}`;
    })
    .join(layout.eol);
}

// ---------------------------------------------------------------------------
// Page API
// ---------------------------------------------------------------------------

export interface MarkdownModel {
  readonly format: 'md' | 'mdx';
  readonly imports: readonly { readonly name: string; readonly path: string }[];
  // The YAML block, shown in the frontmatter editor. `layout:` is also
  // surfaced separately so the layout picker can drive it.
  readonly extraFrontmatter: string;
  readonly frontmatterLang: 'yaml';
  readonly layoutPath: string | undefined;
  readonly nodes: MarkdownNodeList;
  readonly mdEol: string;
  readonly mdEndsWithNewline: boolean;
  readonly mdHasFrontmatter: boolean;
  /** Where the body starts, after the byte-order mark and the frontmatter. */
  readonly bodyStart: number;
}

export type MarkdownParse =
  | { readonly editable: true; readonly model: MarkdownModel }
  | { readonly editable: false; readonly reason: string; readonly bail: undefined };

/** Parse a Markdown or MDX page. Every node has its source range; a page whose
 * tree exceeds the wire model's bounds is not editable (the code panel still
 * is), never cut short. */
function parseMarkdownPage(
  source: string,
  { mdx = false }: { readonly mdx?: boolean } = {},
): MarkdownParse {
  if (source.length > LIMITS.ipcFieldCharsMax) {
    return { editable: false, reason: 'The page exceeds the source limit.', bail: undefined };
  }
  // A leading byte-order mark is not content (plan §3.2); it stays in the
  // file, and offsets count it.
  const bom = source.startsWith('﻿') ? 1 : 0;
  const text = source.slice(bom);
  const { frontmatter, body, offset } = splitFrontmatter(text);
  const env: ParseEnv = { mdx, imports: [], esm: [] };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(body, bom + offset);
  // A trailing newline shows up as one empty final line; it is the file's line
  // ending, not a blank line, so it is dropped here and printed back after.
  const endsWithNewline = lineAt(lines, lines.length - 1).text === '';
  if (endsWithNewline) {
    lines.pop();
  }
  const nodes = parseBlocks(lines, env, 0);
  const size = assignPathIds(nodes);
  if (size.nodes > LIMITS.treeNodesMax || size.depth > LIMITS.treeDepthMax) {
    return { editable: false, reason: 'The page exceeds the tree limits.', bail: undefined };
  }
  return {
    editable: true,
    model: {
      format: mdx ? 'mdx' : 'md',
      imports: env.imports,
      extraFrontmatter: frontmatter ?? '',
      frontmatterLang: 'yaml',
      layoutPath: layoutFromFrontmatter(frontmatter),
      nodes,
      mdEol: eol,
      mdEndsWithNewline: endsWithNewline,
      mdHasFrontmatter: frontmatter != null,
      bodyStart: bom + offset,
    },
  };
}

/** The page printed whole, from its model: the round-trip oracle the tests
 * hold the parser and printer to. Never a write path (plan §11 step 10): a
 * Markdown page reaches disk only as splices; the lint fence keeps this
 * printer to this module and the tests. */
function serializeMarkdownPage(
  model: Pick<
    MarkdownModel,
    'extraFrontmatter' | 'mdHasFrontmatter' | 'mdEol' | 'mdEndsWithNewline'
  > & { readonly nodes: readonly PrintNode[] },
): string {
  const out: string[] = [];
  const fm = model.extraFrontmatter;
  if (model.mdHasFrontmatter || fm.trim()) {
    out.push('---');
    if (fm !== '') {
      // The block keeps the file's own line breaks; splitting on LF alone left
      // each CR in place, so a CRLF page gained a CR per line (CR CR LF).
      out.push(...fm.split(/\r?\n/));
    }
    out.push('---');
  }
  serializeBlocks(model.nodes, out);
  const eol = model.mdEol || '\n';
  return out.join(eol) + (model.mdEndsWithNewline === false ? '' : eol);
}

/** A block, or the text of one, written at its place: the bytes its range
 * holds when it was parsed there and not edited since. A list item needs its
 * list's marker: printMarkdownItem. */
function printMarkdownNode(node: PrintNode, layout: MarkdownLayout): string {
  const out: string[] = [];
  serializeBlock(node, out);
  return placedLines(out, layout);
}

/** A list item written at its place: from its marker (the list's indentation
 * belongs to the list) to its last line. */
function printMarkdownItem(
  item: PrintNode,
  at: Pick<ItemMarker, 'marker' | 'number'> & { readonly indent: string },
  layout: MarkdownLayout,
): string {
  const out: string[] = [];
  serializeItem(item, at, out);
  const [first, ...rest] = out;
  assert(first !== undefined, 'An item prints at least its marker line');
  assert(first.startsWith(at.indent), 'An item line starts with its list indentation');
  return placedLines([first.slice(at.indent.length), ...rest], layout);
}

/** The frontmatter block a model describes, as it is written: `---`, the YAML,
 * `---`, in the file's line breaks, without the break after the closing
 * fence. */
function printMarkdownFrontmatter(yaml: string, eol: string): string {
  const lines = yaml === '' ? [] : yaml.split(/\r?\n/);
  return ['---', ...lines, '---'].join(eol);
}

export {
  layoutFromFrontmatter,
  parseMarkdownPage,
  printMarkdownFrontmatter,
  printMarkdownItem,
  printMarkdownNode,
  serializeMarkdownPage,
  splitFrontmatter,
};
