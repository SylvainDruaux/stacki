// Editing JSON without reformatting it.
//
// The obvious way — parse, change, JSON.stringify — rewrites the whole file:
// every line becomes a candidate for the diff, arrays that were written on one
// line get exploded, and a key nobody touched moves. In a repo that is
// Prettier-formatted and reviewed by humans, that turns a one-word content edit
// into a forty-line diff and hides what actually changed.
//
// So the file is parsed into spans instead, and only the span of the value that
// changed is replaced. Everything else — key order, indentation, blank lines,
// the `$schema` key Astro ignores but the editor must keep — is untouched
// because it is never rewritten.

import { assert } from '../../shared/assert.js';

const WS = /\s/;

export interface ScalarNode {
  readonly type: 'scalar';
  readonly start: number;
  readonly end: number;
}

export interface Member {
  readonly key: string;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly start: number;
  readonly end: number;
  readonly value: JsonNode;
}

export interface ObjectNode {
  readonly type: 'object';
  readonly start: number;
  readonly end: number;
  readonly members: Member[];
}

export interface ArrayNode {
  readonly type: 'array';
  readonly start: number;
  readonly end: number;
  readonly items: JsonNode[];
}

export type JsonNode = ScalarNode | ObjectNode | ArrayNode;

// Where every value in the document starts and ends.
function parse(text: string): JsonNode {
  let i = 0;

  const fail = (message: string): never => {
    const line = text.slice(0, i).split('\n').length;
    throw new Error(`${message} (line ${line})`);
  };

  const skip = (): void => {
    while (i < text.length && WS.test(text.charAt(i))) {
      i++;
    }
  };

  const string = (): { start: number; end: number } => {
    const start = i;
    i++; // opening quote
    while (i < text.length) {
      if (text.charAt(i) === '\\') {
        i += 2;
      } else if (text.charAt(i) === '"') {
        i++;
        return { start, end: i };
      } else {
        i++;
      }
    }
    return fail('Unterminated string');
  };

  const value = (): JsonNode => {
    skip();
    const start = i;
    const ch = text.charAt(i);
    if (ch === '{') {
      i++;
      const members: Member[] = [];
      skip();
      if (text.charAt(i) === '}') {
        return { type: 'object', start, end: ++i, members };
      }
      // Every pass consumes a key and its value, so the text length bounds it.
      for (let pass = 0; pass <= text.length; pass++) {
        skip();
        if (text.charAt(i) !== '"') {
          return fail('Expected a key');
        }
        const keySpan = string();
        // The span is a quoted string, so this parses to one; the guard is
        // unreachable but keeps the boundary honest.
        const parsedKey: unknown = JSON.parse(text.slice(keySpan.start, keySpan.end));
        if (typeof parsedKey !== 'string') {
          return fail('Expected a key');
        }
        const key = parsedKey;
        skip();
        if (text.charAt(i) !== ':') {
          return fail('Expected ":"');
        }
        i++;
        const v = value();
        members.push({ key, keyStart: keySpan.start, keyEnd: keySpan.end, start: keySpan.start, end: v.end, value: v });
        skip();
        if (text.charAt(i) === ',') {
          i++;
          continue;
        }
        if (text.charAt(i) === '}') {
          return { type: 'object', start, end: ++i, members };
        }
        return fail('Expected "," or "}"');
      }
      assert(false, 'An object ends within its text');
    }
    if (ch === '[') {
      i++;
      const items: JsonNode[] = [];
      skip();
      if (text.charAt(i) === ']') {
        return { type: 'array', start, end: ++i, items };
      }
      // Every pass consumes a value, so the text length bounds it.
      for (let pass = 0; pass <= text.length; pass++) {
        items.push(value());
        skip();
        if (text.charAt(i) === ',') {
          i++;
          continue;
        }
        if (text.charAt(i) === ']') {
          return { type: 'array', start, end: ++i, items };
        }
        return fail('Expected "," or "]"');
      }
      assert(false, 'An array ends within its text');
    }
    if (ch === '"') {
      const s = string();
      return { type: 'scalar', start: s.start, end: s.end };
    }
    while (i < text.length && !WS.test(text.charAt(i)) && !',}]'.includes(text.charAt(i))) {
      i++;
    }
    if (i === start) {
      return fail('Expected a value');
    }
    return { type: 'scalar', start, end: i };
  };

  const root = value();
  skip();
  return root;
}

const parseData = (text: string): unknown => {
  const data: unknown = JSON.parse(text);
  return data;
};

// The indentation of the line a position sits on, so an inserted or replaced
// value lines up with what is around it.
function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const m = text.slice(lineStart, pos).match(/^[ \t]*/);
  return m ? m[0] : '';
}

// One indent level, as the file writes it.
function indentUnit(text: string): string {
  const m = text.match(/\n([ \t]+)\S/);
  const unit = m?.[1];
  if (unit === undefined) {
    return '  ';
  }
  return unit.charAt(0) === '\t' ? '\t' : unit;
}

// A value, printed the way the surrounding file would have printed it.
function print(value: unknown, baseIndent: string, unit: string): string {
  const body = JSON.stringify(value, null, unit);
  if (body === undefined) {
    return 'null';
  }
  return body.split('\n').join(`\n${baseIndent}`);
}

// A located member: the pair shape for object members (with key spans), the
// item shape for array elements, and the bare span when the root itself lands.
type Child =
  | Member
  | { readonly key: number; readonly start: number; readonly end: number; readonly value: JsonNode }
  | { readonly start: number; readonly end: number; readonly value: JsonNode };

function childAt(node: JsonNode | null, key: string | number | undefined): Child | null {
  if (!node) {
    return null;
  }
  if (node.type === 'object') {
    return node.members.find((m) => m.key === String(key)) ?? null;
  }
  if (node.type === 'array') {
    const item = node.items[Number(key)];
    return item ? { key: Number(key), start: item.start, end: item.end, value: item } : null;
  }
  return null;
}

interface Located {
  readonly parent: JsonNode | null;
  readonly key: string | number | null;
  readonly member: Child | null;
}

// The member a path names, plus the container it lives in — which is what an
// insert needs when the member is not there yet.
function locate(root: JsonNode, path: readonly (string | number)[]): Located | null {
  let node: JsonNode = root;
  for (let d = 0; d < path.length; d++) {
    const member = childAt(node, path[d]);
    if (!member) {
      return d === path.length - 1 ? { parent: node, key: path[d] ?? null, member: null } : null;
    }
    if (d === path.length - 1) {
      return { parent: node, key: path[d] ?? null, member };
    }
    node = member.value;
  }
  return { parent: null, key: null, member: { start: node.start, end: node.end, value: node } };
}

// Where a new member goes, and what has to be written around it: after the last
// one (with a comma), or on its own line inside an empty container.
function insertion(
  text: string,
  container: JsonNode,
  unit: string,
): { at: number; before: string; after: string; inner: string } {
  const parts: readonly { start: number; end: number }[] =
    container.type === 'object' ? container.members : container.type === 'array' ? container.items : [];
  const openIndent = indentAt(text, container.start);
  const inner = openIndent + unit;
  if (!parts.length) {
    // `{}` or `[]` — open it up rather than writing on one line, which is what
    // the rest of the file looks like.
    return { at: container.start + 1, before: `\n${inner}`, after: `\n${openIndent}`, inner };
  }
  const last = parts[parts.length - 1];
  const lastIndent = indentAt(text, last?.start ?? container.start);
  return { at: last?.end ?? container.end - 1, before: `,\n${lastIndent}`, after: '', inner: lastIndent };
}

const DELETE = Symbol('delete');

export interface Edit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly rename?: string;
}

/**
 * Applies edits to JSON source text, changing only the spans that changed.
 * Each edit is { path: [key | index, ...], value } — `DELETE` as the value
 * removes the member. Paths that name something inside a value that does not
 * exist yet create the intermediate objects.
 */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const unit = indentUnit(text);
  let out = text;

  for (const edit of edits) {
    const root = parse(out);
    const path = edit.path;

    // Renaming a key is not the same as removing one and adding another: the
    // record keeps its place in the file, and its value is never rewritten.
    if (edit.rename !== undefined) {
      const found = locate(root, path);
      const member = found?.member;
      if (member && 'keyEnd' in member) {
        out = out.slice(0, member.keyStart) + JSON.stringify(String(edit.rename)) + out.slice(member.keyEnd);
      }
      continue;
    }
    if (!path.length) {
      out = print(edit.value, '', unit) + (out.endsWith('\n') ? '\n' : '');
      continue;
    }

    // Walk as far as the document goes; anything missing below that is written
    // as one nested value rather than a series of empty containers.
    let node: JsonNode = root;
    let depth = 0;
    while (depth < path.length - 1) {
      const member = childAt(node, path[depth]);
      if (!member) {
        break;
      }
      node = member.value;
      depth++;
    }

    const remaining = path.slice(depth);
    const target = childAt(node, remaining[0]);

    if (edit.value === DELETE) {
      if (remaining.length > 1 || !target) {
        continue; // nothing to remove
      }
      out = removeMember(out, node, target);
      continue;
    }

    // Everything below the deepest existing container, wrapped up.
    let value = edit.value;
    for (let d = path.length - 1; d > depth; d--) {
      const key = path[d];
      if (key === undefined) {
        continue; // unreachable: d < path.length
      }
      value = typeof key === 'number' ? [value] : { [key]: value };
    }

    if (remaining.length === 1 && target) {
      const baseIndent = indentAt(out, target.value.start);
      out = out.slice(0, target.value.start) + print(value, baseIndent, unit) + out.slice(target.value.end);
      continue;
    }

    const spot = insertion(out, node, unit);
    const written =
      node.type === 'object'
        ? `${JSON.stringify(String(remaining[0]))}: ${print(value, spot.inner, unit)}`
        : print(value, spot.inner, unit);
    out = out.slice(0, spot.at) + spot.before + written + spot.after + out.slice(spot.at);
  }

  return out;
}

// Removing a member takes its separator with it — the comma before it when it
// is last, the one after it otherwise — so the file stays valid JSON and the
// diff stays limited to those lines.
function removeMember(text: string, container: JsonNode, member: Child): string {
  const parts: readonly Child[] | readonly { start: number; end: number }[] =
    container.type === 'object' ? container.members : container.type === 'array' ? container.items : [];
  const index = parts.findIndex((p) => p.start === member.start);
  const only = parts.length === 1;
  let from = member.start;
  let to = member.end;

  if (only) {
    // Leave the container empty, on one line.
    from = container.start + 1;
    to = container.end - 1;
    return text.slice(0, from) + text.slice(to);
  }
  if (index === parts.length - 1) {
    from = parts[index - 1]?.end ?? from; // the comma and newline before it go too
  } else {
    to = parts[index + 1]?.start ?? to; // as does the comma, newline and indent after
  }
  return text.slice(0, from) + text.slice(to);
}

export { parse, parseData, applyEdits, indentUnit, DELETE };
