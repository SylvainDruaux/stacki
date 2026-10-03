// The parser's ground floor: element kinds, node ids and path ids, and the
// attributes of a tag — scanned with their spans, read as props, and written
// back in the order and spelling they came in.

import type { Attr, AttrSpan } from '../../shared/page/pageNode';
import { toUtf16Span } from '../../shared/core/span';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ParserNode } from './astroParserTypes';

export const VOID_ELEMENTS = new Set([
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
export const RAW_ELEMENTS = new Set(['style', 'script']);

// Node ids are structural paths — `n0`, `n0.2`, `n0.2.1` — assigned in one
// pass once a tree is complete (assignPathIds), so a parse is a pure function
// of its text: no counter survives between parses, and nothing can key on
// parse order (plan §4, §11.9). Nodes are built with this placeholder; the
// parser itself never reads an id.
const PENDING_ID = 'n0';
export const makeId = (): string => PENDING_ID;

// Give every node of a finished tree its path id; the layout wrapper keeps its
// well-known `layout`. The tree is the parser's own, just built, so this is
// the one place its ids are written. Depth is the tree's bound (asserted).
export function assignPathIds(nodes: readonly ParserNode[], prefix: string, depth: number): void {
  assert(depth <= LIMITS.treeDepthMax, 'Path ids are assigned within the depth bound');
  for (const [index, node] of nodes.entries()) {
    const path = prefix === '' ? String(index) : `${prefix}.${index}`;
    if (node.id !== 'layout') {
      node.id = `n${path}`;
    }
    if (Array.isArray(node.children)) {
      assignPathIds(node.children, path, depth + 1);
    }
  }
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
export function parseAttrs(attrString: string): Record<string, Attr> {
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
  let match;
  while ((match = re.exec(attrString)) !== null) {
    if (!match[0].trim()) {
      continue;
    }
    assert(found.length <= attrString.length, 'Each attribute consumes at least one character');
    found.push(scanAttr(match));
  }
  return found;
}

function scanAttr(match: RegExpExecArray): ScannedAttr {
  const indices = required(match.indices, 'Attribute match indices');
  const from = match.index;
  const to = from + match[0].length;
  const trimmed = (group: number): readonly [number, number] => {
    const [start] = required(indices[group], 'Attribute value indices');
    const raw = required(match[group], 'Attribute value capture');
    const lead = raw.length - raw.trimStart().length;
    return [start + lead, start + lead + raw.trim().length];
  };
  if (match[1] !== undefined) {
    // Keyed by the spread's own text, so two different spreads on one tag
    // stay separate and the order round-trips.
    const expr = match[1].trim();
    const attr: Attr = { type: 'spread', value: expr };
    return { name: `...${expr}`, attr, from, to, nameAt: undefined, valueAt: trimmed(1) };
  }
  const name = required(match[2], 'Attribute name capture');
  const nameAt = required(indices[2], 'Attribute name indices');
  if (match[3] !== undefined || match[4] !== undefined) {
    const group = match[3] !== undefined ? 3 : 4;
    const valueAt = required(indices[group], 'Quoted attribute indices');
    const attr: Attr = {
      type: 'string',
      value: required(match[group], 'Quoted attribute capture'),
    };
    return { name, attr, from, to, nameAt, valueAt };
  }
  if (match[5] !== undefined) {
    const attr: Attr = { type: 'expr', value: match[5].trim() };
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
export function attrsAsWritten(node: ParserNode): string | undefined {
  if (!node.attrSource) {
    return undefined;
  }
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  return flat(node.attrSource) === flat(serializeAttrs(node.props, node.attrOrder))
    ? node.attrSource
    : undefined;
}

// A tag's attributes and the order the file wrote them in. An object remembers
// the order its keys were added, which is the file's order right up until a
// prop is taken out and put back — clearing a field and typing into it again is
// exactly that — and then it returns at the end, behind everything it used to
// sit in front of. One line reordered against the four like it underneath is a
// diff about nothing. So the order is written down when the file is read.
//
// `attrsAt` is where the attribute string starts in the file, or undefined when no
// offsets were asked for; with it, every attribute also reports its spans.
export function tagProps(
  attrs: string,
  attrsAt: number | undefined,
): { props: Record<string, Attr>; attrOrder?: string[]; attrSpans?: AttrSpan[] } {
  // One scan serves both the props and their spans: scanning twice doubled the
  // cost of every tag with attributes.
  const scanned = scanAttrs(attrs);
  const props = propsOf(scanned);
  const attrOrder = Object.keys(props);
  const spans = attrsAt === undefined ? {} : { attrSpans: attrSpansOf(scanned, attrsAt) };
  // The props are always present — even empty — because writers mutate node.props
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
  for (const [name, attr] of entries) {
    if (!known.has(name)) {
      out.push([name, attr]);
    }
  }
  return out;
}

export function serializeAttrs(
  props: Readonly<Record<string, Attr>> | undefined,
  order?: readonly string[],
): string {
  const parts = [];
  for (const [name, attr] of orderedProps(props, order)) {
    if (attr?.type === 'spread') {
      parts.push(`{...${attr.value}}`);
    } else if (attr === undefined || attr.type === 'bare') {
      parts.push(name);
    } else if (attr.type === 'expr') {
      parts.push(`${name}={${attr.value}}`);
    } else {
      parts.push(`${name}="${String(attr.value).replace(/"/g, '&quot;')}"`);
    }
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

// Regex captures and bounded array accesses are producer invariants, not user
// errors. A violated assumption must identify the failing parser operation.
export function required<T>(value: T | undefined, message: string): T {
  assert(value !== undefined, message);
  return value;
}
