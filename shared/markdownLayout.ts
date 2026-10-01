// Where a Markdown node is written (plan §11 step 10). Markdown's containers
// put syntax at the front of every line inside them — a quote its `> `, a list
// item the indentation that lines its content up after the marker — so a
// node's lines after its first carry a prefix that is not the node's own. It
// is read off the bytes of the node's first line, before the node: the
// planner separates Markdown blocks with it, and main prints a node's new
// text with it, so a line added to a paragraph inside a quote stays inside
// the quote. Pure: bytes in, a string out.
import { assert } from './core/assert';
import type { ByteString } from './core/span';

const NEWLINE = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const QUOTE_MARK = 0x3e; // `>`
const ZERO = 0x30;
const NINE = 0x39;
// An ordered item's number has at most nine digits (the parser's grammar).
const ORDINAL_DIGITS_MAX = 9;

/** The prefix every line of the node starting at `offset` carries after its
 * first: the bytes before it on its line, with each list marker there turned
 * into as many spaces (an item's lines are indented to its content, not
 * marked again). Undefined when those bytes are not container syntax alone —
 * then the node does not begin its line's content, and has no Markdown
 * prefix. */
export function markdownPrefix(bytes: ByteString, offset: number): string | undefined {
  assert(offset <= bytes.length, 'The offset lies inside the bytes');
  let lineStart = offset;
  while (lineStart > 0) {
    if (bytes[lineStart - 1] === NEWLINE) {
      break;
    }
    lineStart--;
  }
  // A byte-order mark opens the file, not a line's content: never a prefix.
  if (lineStart === 0) {
    lineStart = bomLength(bytes);
    assert(lineStart <= offset, 'A node starts after the byte-order mark');
  }
  const parts: string[] = [];
  let at = lineStart;
  // Every pass consumes at least one byte of the prefix.
  while (at < offset) {
    const byte = bytes[at];
    assert(byte !== undefined, 'The prefix lies inside the bytes');
    if (isGap(byte) || byte === QUOTE_MARK) {
      parts.push(String.fromCharCode(byte));
      at += 1;
      continue;
    }
    const marker = markerLength(bytes, at, offset);
    if (marker === 0) {
      return undefined;
    }
    parts.push(' '.repeat(marker));
    at += marker;
  }
  const prefix = parts.join('');
  assert(prefix.length === offset - lineStart, 'A prefix is as wide as the bytes it reads');
  return prefix;
}

function bomLength(bytes: ByteString): number {
  if (bytes[0] === 0xef) {
    if (bytes[1] === 0xbb) {
      return bytes[2] === 0xbf ? 3 : 0;
    }
  }
  return 0;
}

/** The visible part of a prefix, which a blank line inside the container
 * carries: a quote's `>`, nothing for an item's indentation. */
export function blankLinePrefix(prefix: string): string {
  return prefix.trimEnd();
}

// A list marker at `at` — `-`, `*`, `+`, or up to nine digits and `.` or `)` —
// followed by a space or a tab before `end`: its length, or 0.
function markerLength(bytes: ByteString, at: number, end: number): number {
  const first = bytes[at];
  assert(first !== undefined, 'A marker starts inside the bytes');
  const length = bulletLength(first) ?? ordinalLength(bytes, at, end);
  if (length === 0) {
    return 0;
  }
  if (at + length < end) {
    const after = bytes[at + length];
    assert(after !== undefined, 'The byte after a marker lies inside the prefix');
    return isGap(after) ? length : 0;
  }
  return 0;
}

function bulletLength(byte: number): number | undefined {
  switch (byte) {
    case 0x2d: // `-`
    case 0x2a: // `*`
    case 0x2b: // `+`
      return 1;
    default:
      return undefined;
  }
}

function ordinalLength(bytes: ByteString, at: number, end: number): number {
  let digits = 0;
  while (digits < ORDINAL_DIGITS_MAX) {
    if (at + digits < end) {
      if (isDigit(bytes[at + digits])) {
        digits++;
        continue;
      }
    }
    break;
  }
  if (digits === 0) {
    return 0;
  }
  const close = bytes[at + digits] ?? 0;
  switch (close) {
    case 0x2e: // `.`
    case 0x29: // `)`
      return digits + 1;
    default:
      return 0;
  }
}

function isDigit(byte: number | undefined): boolean {
  if (byte === undefined) {
    return false;
  }
  return ZERO <= byte && byte <= NINE;
}

function isGap(byte: number): boolean {
  switch (byte) {
    case SPACE:
    case TAB:
      return true;
    default:
      return false;
  }
}
