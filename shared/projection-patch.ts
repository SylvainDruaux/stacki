// The candidate projection of a value splice, derived from the current one
// instead of reparsing the whole file (step-4 latency experiment). A full
// reparse and reprojection costs 120–644 ms p50 on the named large fixtures;
// a value edit changes no structure, so the only thing that moves is every
// byte offset at or after the edited value.
//
// The claim this module rests on: replacing the bytes of a quoted attribute
// value with other bytes from VALUE_BYTES leaves the parser's tokenization
// unchanged, when the host element's ancestors are all markup (element or
// component). Why, from electron/astroParser.ts:
//
//   - The tag is read by TAG_RE and its attributes by ATTR_PATTERN; both take
//     a quoted value as `"[^"]*"` or `'[^']*'`, so any byte but the quote is
//     inert inside it. Quotes are refused in both values.
//   - findMatchingClose scans the markup between an open and its close tag as
//     raw text, and every alternative it matches starts with `<`. Refused.
//   - The nested-brace bail on a tag's attribute string and
//     findMatchingFragmentClose react to `{` and `}`. Refused.
//   - The JavaScript scanners (findMatchingDelimiter, topLevelOps, and the
//     string rule in skipStringOrComment) read markup only inside `{ … }`
//     expressions: conditions and loops. They react to quotes, backticks,
//     backslashes, line breaks, `/`, `*`, brackets, `?`, `:` and `&`, so a
//     host under a cond, branch or map is refused whole, not byte by byte.
//   - The frontmatter fence and the line-ending sniff need a line break;
//     control bytes are refused. `>` is refused too: inert by the argument
//     above, but excluding it costs nothing and needs no argument.
//
// Both the old and the new bytes must pass. A value the parser was fooled by
// (`</div>` inside one) produced the current projection; removing it changes
// the structure, so patching over it would copy the mistake.
//
// This is an argument, not a proof. The brute-force reference — a full reparse
// deep-equal to every patched projection — runs on every applied intent in the
// simulator and on the large fixtures (test/simulator/projection-patch.test.ts).
import { assert } from './assert';
import { LIMITS } from './limits';
import type { Splice } from './planner';
import type { ProjectedAttribute, ProjectedNode, Projection } from './source-projection';
import {
  byteStringsEqual,
  toByteSpan,
  toByteString,
  type ByteSpan,
  type ByteString,
} from './span';

type ValidProjection = Extract<Projection, { tag: 'valid' }>;

/** The projection of `bytes` with `splice` applied, or undefined when the
 * splice is not a value edit this module can prove structure-neutral — the
 * caller then reparses. `projection` must describe `bytes`. */
export function projectValueSplice(
  projection: Projection,
  bytes: ByteString,
  splice: Splice,
): Projection | undefined {
  assert(projection.byteLength === bytes.length, 'The projection describes these bytes');
  assert(splice.range.end <= bytes.length, 'The splice lies inside the bytes');
  const held = toByteString(bytes.subarray(splice.range.start, splice.range.end));
  assert(byteStringsEqual(held, splice.expectedBytes), 'The witness held: the caller checked');
  if (projection.tag !== 'valid') {
    return undefined;
  }
  if (!valueBytesNeutral(splice.expectedBytes)) {
    return undefined;
  }
  if (!valueBytesNeutral(splice.replacementBytes)) {
    return undefined;
  }
  if (splice.replacementBytes.length > LIMITS.attrCharsMax) {
    return undefined; // UTF-16 units never exceed bytes, so this bounds the parser's check.
  }
  const delta = splice.replacementBytes.length - splice.expectedBytes.length;
  const byteLength = bytes.length + delta;
  if (byteLength > LIMITS.sourceBytesMax) {
    return undefined;
  }
  // The parser bounds the text in UTF-16 units. The projection carries its
  // count, so only the two values are counted, never the file: walking 10 MB
  // twice was 45 ms of every edit on the largest fixture.
  const unitDelta = utf16Units(splice.replacementBytes) - utf16Units(splice.expectedBytes);
  const utf16Length = projection.utf16Length + unitDelta;
  assert(utf16Length <= byteLength, 'UTF-16 never takes more units than UTF-8 takes bytes');
  if (utf16Length > LIMITS.ipcFieldCharsMax) {
    return undefined;
  }
  if (!hostUnderMarkupOnly(projection, splice.range)) {
    return undefined;
  }
  const patched = shiftProjection(projection, splice.range, { bytes: delta, units: unitDelta });
  assert(patched.nodes.length === projection.nodes.length, 'A value edit keeps every node');
  assert(patched.byteLength === byteLength, 'The patch measures the spliced bytes');
  assert(patched.utf16Length === utf16Length, 'The patch counts the spliced units');
  return patched;
}

/** Bytes that are inert inside a quoted value (see the header): printable
 * ASCII except quotes, backtick, backslash, angle brackets and braces, and any
 * byte of a multi-byte UTF-8 sequence. */
export function valueBytesNeutral(bytes: ByteString): boolean {
  assert(bytes.length <= LIMITS.sourceBytesMax, 'Checked bytes are inside the file bound');
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    assert(byte !== undefined, 'The index lies inside the bytes');
    if (!VALUE_BYTES[byte]) {
      return false;
    }
  }
  return true;
}

// --- Internal ----------------------------------------------------------------

/** UTF-16 code units of valid UTF-8: one per lead byte, two for a 4-byte one. */
function utf16Units(bytes: ByteString): number {
  assert(bytes.length <= LIMITS.sourceBytesMax, 'Counted bytes are inside the file bound');
  let units = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] ?? 0;
    if ((byte & 0xc0) === 0x80) {
      continue; // A continuation byte adds nothing.
    }
    units += byte >= 0xf0 ? 2 : 1;
  }
  assert(units <= bytes.length, 'UTF-16 never takes more units than UTF-8 takes bytes');
  return units;
}

const REFUSED_ASCII = '"\'`\\<>{}';

const VALUE_BYTES: readonly boolean[] = Array.from({ length: 256 }, (_, byte) => {
  if (byte >= 0x80) {
    return true;
  }
  if (byte < 0x20) {
    return false;
  }
  if (byte === 0x7f) {
    return false;
  }
  return !REFUSED_ASCII.includes(String.fromCharCode(byte));
});

const MARKUP_KINDS: ReadonlySet<ProjectedNode['kind']> = new Set(['element', 'component']);

// The one string attribute whose value is exactly the range, and every node
// that contains it: the host and its ancestors. All must be markup.
function hostUnderMarkupOnly(projection: ValidProjection, range: ByteSpan): boolean {
  const containing = projection.nodes.filter((node) => contains(node.span, range));
  const host = containing.at(-1);
  if (host === undefined) {
    return false;
  }
  const values = host.attributes.filter((attribute) => isValueAt(attribute, range));
  if (values.length === 0) {
    return false; // Not a value edit: the caller reparses.
  }
  assert(values.length === 1, 'One attribute value occupies one range');
  // Preorder: every node containing the range is an ancestor of the next one.
  for (let index = 1; index < containing.length; index++) {
    const parent = containing[index - 1];
    const child = containing[index];
    assert(parent !== undefined, 'The parent lies inside the chain');
    assert(child !== undefined, 'The child lies inside the chain');
    assert(isPrefix(parent.path, child.path), 'Nodes containing a range form one chain');
  }
  return containing.every((node) => MARKUP_KINDS.has(node.kind));
}

function isValueAt(attribute: ProjectedAttribute, range: ByteSpan): boolean {
  if (attribute.type !== 'string') {
    return false;
  }
  const value = attribute.valueSpan;
  if (value === undefined) {
    return false;
  }
  return value.start === range.start && value.end === range.end;
}

function shiftProjection(
  projection: ValidProjection,
  range: ByteSpan,
  lengths: { readonly bytes: number; readonly units: number },
): ValidProjection {
  const delta = lengths.bytes;
  const frontmatter = projection.frontmatter;
  if (frontmatter !== undefined) {
    assert(frontmatter.end <= range.start, 'The frontmatter lies before every attribute value');
  }
  assert(projection.nodes.length <= LIMITS.treeNodesMax, 'The projection is inside its bound');
  const nodes = projection.nodes.map((node) => {
    if (node.span.end < range.start) {
      return node; // Wholly before the edit: nothing in it moves, so it is shared.
    }
    return shiftNode(node, range, delta);
  });
  const byteLength = projection.byteLength + delta;
  const utf16Length = projection.utf16Length + lengths.units;
  return { tag: 'valid', byteLength, utf16Length, frontmatter, nodes };
}

function shiftNode(node: ProjectedNode, range: ByteSpan, delta: number): ProjectedNode {
  const span = shiftSpan(node.span, range, delta);
  const attributes = node.attributes.map((attribute) => ({
    ...attribute,
    span: shiftSpan(attribute.span, range, delta),
    nameSpan: shiftOptional(attribute.nameSpan, range, delta),
    valueSpan: shiftOptional(attribute.valueSpan, range, delta),
  }));
  assert(attributes.length === node.attributes.length, 'A value edit keeps every attribute');
  const grown = contains(node.span, range) ? delta : 0;
  assert(span.end - span.start === node.span.end - node.span.start + grown, 'Only hosts resize');
  return { ...node, span, attributes };
}

function shiftOptional(
  span: ByteSpan | undefined,
  range: ByteSpan,
  delta: number,
): ByteSpan | undefined {
  return span === undefined ? undefined : shiftSpan(span, range, delta);
}

// A start at or before the value start stays; an end before the value end
// stays; everything at or after the value end moves by delta. Nothing but the
// value itself starts or ends strictly inside the replaced range.
function shiftSpan(span: ByteSpan, range: ByteSpan, delta: number): ByteSpan {
  const start = span.start <= range.start ? span.start : span.start + delta;
  const end = span.end < range.end ? span.end : span.end + delta;
  if (span.start > range.start) {
    assert(span.start >= range.end, 'No span starts inside a replaced value');
  }
  if (span.end < range.end) {
    assert(span.end <= range.start, 'No span ends inside a replaced value');
  }
  return toByteSpan(start, end);
}

function contains(outer: ByteSpan, inner: ByteSpan): boolean {
  if (outer.start <= inner.start) {
    return inner.end <= outer.end;
  }
  return false;
}

function isPrefix(prefix: readonly number[], path: readonly number[]): boolean {
  if (prefix.length < path.length) {
    return prefix.every((step, index) => step === path[index]);
  }
  return false;
}
