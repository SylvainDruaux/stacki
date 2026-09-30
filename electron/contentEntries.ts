import fs from 'fs';
import path from 'path';

import { toRecord, toArray } from '../shared/record.js';
import { MAIN_LIMITS } from './main.bounds.js';
import { writeProjectText } from './documentWrites.js';
import * as frontmatter from './formats/frontmatter.js';
import * as jsonFormat from './formats/json.js';
import * as yamlFormat from './formats/yaml.js';
import * as tomlFormat from './formats/toml.js';
import * as csvFormat from './formats/csv.js';
import * as ndjsonFormat from './formats/ndjson.js';

// Finding, reading and writing the entries of a content collection.
//
// Where an entry lives depends on the loader (see contentConfig.js): a glob
// collection keeps one file per entry, a file collection keeps all of them
// inside one data file. What an entry *is* depends on the format that file is
// written in, and no two of those are edited the same way — so every write goes
// through ./formats, which patches the file rather than re-serializing it.
//
// The id is the other half of the problem. Astro derives it differently per
// collection — from the file path, from a field, from the key an object sits
// under — and an id is what every reference() in the project points at. So it
// is computed here, once, and the rules are named rather than assumed.

interface FormatEdit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly rename?: string;
}

interface FormatModule {
  readonly parseData: (text: string) => unknown;
  readonly applyEdits: (
    text: string,
    edits: readonly FormatEdit[],
    opts?: { readonly body?: string },
  ) => string;
  readonly DELETE: symbol;
}

const FORMATS: Record<string, FormatModule> = {
  md: frontmatter,
  mdx: frontmatter,
  mdoc: frontmatter,
  markdown: frontmatter,
  json: jsonFormat,
  yaml: yamlFormat,
  yml: yamlFormat,
  toml: tomlFormat,
  csv: csvFormat,
  ndjson: ndjsonFormat,
};

const extensionOf = (file: string): string => (file.split('.').pop() || '').toLowerCase();
const formatFor = (file: string): FormatModule | null => FORMATS[extensionOf(file)] ?? null;
const formatName = (file: string): string => {
  const ext = extensionOf(file);
  return FORMATS[ext] === frontmatter ? 'frontmatter' : ext;
};

const toPosix = (p: string): string => p.split(path.sep).join('/');
const isPlainObject = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

// A glob pattern as a regular expression: `**` crosses folders, `*` does not,
// and `{a,b}` is a choice. Enough for the patterns a content config writes.
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        out += pattern.charAt(i + 2) === '/' ? '(?:.*\\/)?' : '.*';
        i += pattern.charAt(i + 2) === '/' ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i);
      out += `(?:${pattern
        .slice(i + 1, close)
        .split(',')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`;
      i = close;
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, base, out);
    } else {
      out.push(toPosix(path.relative(base, full)));
    }
  }
  return out;
}

// The title an entry shows in a list. Its own name if it has one, its id
// otherwise — an id is always something, which is more than can be said for a
// record whose fields are all optional.
const TITLE_KEYS = ['title', 'name', 'label', 'heading', 'question', 'siteName', 'quote'] as const;
function titleOf(data: unknown, id: string): string {
  const record = toRecord(data);
  if (record) {
    for (const key of TITLE_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  return id;
}

export interface LoaderInfo {
  readonly kind?: string;
  readonly base?: string;
  readonly pattern?: string | readonly string[];
  readonly file?: string;
  readonly generateId?: unknown;
  readonly parser?: unknown;
}

export interface ContentCollection {
  readonly name: string;
  readonly loader?: LoaderInfo;
  readonly editable?: boolean;
  readonly schema?: unknown;
}

export interface Entry {
  readonly id: string;
  readonly file: string;
  readonly format: string;
  /** The path to the record inside its file; empty for one file per entry. */
  readonly locator: readonly (string | number)[];
  readonly data: unknown;
  readonly title: string;
  readonly body?: string;
  readonly hasBody?: boolean;
  readonly error?: string;
  readonly keyed?: boolean;
}

export interface EntryEdit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly rename?: string;
}

export interface ListResult {
  readonly entries: Entry[];
  readonly readOnly: boolean;
  readonly reason?: string | undefined;
  readonly idsAreGuesses?: boolean;
  readonly idNote?: string | undefined;
  readonly shape?: string;
  readonly parsed?: boolean;
  readonly parserNote?: string | undefined;
}

/**
 * Every entry of one collection, as { id, file, format, locator, data, body }.
 */
function listEntries(projectPath: string, collection: ContentCollection): ListResult {
  const loader = collection.loader ?? {};
  if (loader.kind === 'glob') {
    return globEntries(projectPath, collection);
  }
  if (loader.kind === 'file') {
    return fileEntries(projectPath, collection);
  }
  return { entries: [], readOnly: true, reason: readOnlyReason(collection) };
}

function readOnlyReason(collection: ContentCollection): string | undefined {
  const loader = collection.loader ?? {};
  if (loader.kind === 'custom') {
    return (
      `${collection.name} is built by a loader in this project, not stored in a file. ` +
      'Its entries are rebuilt from scratch on every sync, so anything written here would be ' +
      'overwritten.'
    );
  }
  return undefined;
}

const patternsOf = (pattern: LoaderInfo['pattern']): RegExp[] => {
  const list = Array.isArray(pattern) ? pattern : pattern !== undefined ? [pattern] : [];
  return list.map(globToRegExp);
};

function globEntries(projectPath: string, collection: ContentCollection): ListResult {
  const loader = collection.loader ?? {};
  const root = path.resolve(projectPath, String(loader.base ?? '').replace(/^\.\//, ''));
  const matchers = patternsOf(loader.pattern);
  const files = walkFiles(root).filter((rel) => matchers.some((re) => re.test(rel)));
  files.sort();

  const entries: Entry[] = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const format = formatFor(rel);
    if (!format) {
      continue;
    }
    let text = '';
    try {
      if (fs.statSync(abs).size > MAIN_LIMITS.contentEntryBytesMax) {
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // Astro's own rule for the id: the path under the base, without its
    // extension.
    const base: Pick<Entry, 'id' | 'file' | 'format' | 'locator'> = {
      id: rel.replace(/\.[^./]+$/, ''),
      file: toPosix(path.relative(projectPath, abs)),
      format: formatName(rel),
      locator: [],
    };
    let entry: Omit<Entry, 'title'>;
    try {
      if (format === frontmatter) {
        const parsed = frontmatter.parse(text);
        entry = { ...base, data: parsed.data || {}, body: parsed.body, hasBody: true };
      } else {
        entry = { ...base, data: format.parseData(text) };
      }
    } catch (err) {
      entry = { ...base, error: String(err instanceof Error ? err.message : err), data: {} };
    }
    entries.push({ ...entry, title: titleOf(entry.data, entry.id) });
  }

  const generated = loader.generateId;
  return {
    entries,
    readOnly: false,
    // The id is not the file path, and nothing outside the loader knows the
    // rule it uses — so an id shown here is a guess, and renaming the file is
    // not what renames the entry.
    idsAreGuesses: !!generated,
    idNote: generated
      ? `${collection.name} builds its ids in the loader, from the entry's own fields. ` +
        'The ids shown are the file paths, which is not what other collections reference.'
      : undefined,
  };
}

interface RawRecord {
  readonly id: string;
  readonly idKey: string | null;
  readonly keyed?: boolean;
  readonly locator: readonly (string | number)[];
  readonly record: Record<string, unknown>;
}

// Where the records are inside a data file, and what identifies each one.
//   [ { id: … } ]        → the id field, addressed by position
//   { key: { … } }       → the key itself
//   anything else        → any object with an id, wherever it sits, which is
//                          what a parser-shaped file looks like
function locateRecords(data: unknown): { shape: string; records: RawRecord[] } {
  const list = toArray(data);
  if (list) {
    if (!list.length || !list.every(isPlainObject)) {
      return { shape: 'array', records: [] };
    }
    return {
      shape: 'array',
      records: list.map((record, index) => {
        const rec = toRecord(record) ?? {};
        const id = rec['id'];
        return {
          id: typeof id === 'string' ? id : String(index),
          idKey: typeof id === 'string' ? 'id' : null,
          locator: [index],
          record: rec,
        };
      }),
    };
  }
  const top = toRecord(data);
  if (!top) {
    return { shape: 'unknown', records: [] };
  }

  const keys = Object.keys(top).filter((k) => k !== '$schema');
  if (keys.length && keys.every((k) => isPlainObject(top[k]))) {
    return {
      shape: 'keyed',
      records: keys.map((key) => ({
        id: key,
        idKey: null,
        keyed: true,
        locator: [key],
        record: toRecord(top[key]) ?? {},
      })),
    };
  }

  // Nested: the file groups its records under something. Every object with a
  // string id counts, wherever it is — which is how a grouped file (categories
  // holding questions) comes apart without knowing what the grouping means.
  const records: RawRecord[] = [];
  const visit = (node: unknown, locator: readonly (string | number)[]): void => {
    const items = toArray(node);
    if (items) {
      items.forEach((item, index) => visit(item, [...locator, index]));
      return;
    }
    const record = toRecord(node);
    if (!record) {
      return;
    }
    const id = record['id'];
    if (typeof id === 'string' && locator.length) {
      records.push({ id, idKey: 'id', locator, record });
      return;
    }
    for (const [key, value] of Object.entries(record)) {
      visit(value, [...locator, key]);
    }
  };
  visit(data, []);
  return { shape: records.length ? 'nested' : 'single', records };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function fileEntries(projectPath: string, collection: ContentCollection): ListResult {
  const loader = collection.loader ?? {};
  const rel = toPosix(String(loader.file ?? '')).replace(/^\.\//, '');
  const abs = path.resolve(projectPath, rel);
  const format = formatFor(rel);
  if (!format) {
    return {
      entries: [],
      readOnly: true,
      reason: `Stacki cannot read ${path.extname(rel)} data files yet.`,
    };
  }
  let text = '';
  try {
    if (fs.statSync(abs).size > MAIN_LIMITS.contentEntryBytesMax) {
      return { entries: [], readOnly: true, reason: 'This file is too large to edit here.' };
    }
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return { entries: [], readOnly: true, reason: `Could not read ${rel} — ${errorMessage(err)}` };
  }

  let data: unknown;
  try {
    data = format.parseData(text);
  } catch (err) {
    return {
      entries: [],
      readOnly: true,
      reason: `${rel} could not be parsed — ${errorMessage(err)}`,
    };
  }

  const { shape, records } = locateRecords(data);
  const entries: Entry[] = records.map(({ id, locator, record, keyed }) => ({
    id,
    file: rel,
    format: formatName(rel),
    locator,
    keyed: !!keyed,
    data: record,
    title: titleOf(record, id),
  }));

  return {
    entries,
    readOnly: false,
    shape,
    // A parser stands between the file and the entries, so some of what an
    // entry holds was never in the file — and the fields it invented cannot be
    // written back through it.
    parsed: !!loader.parser,
    parserNote: loader.parser
      ? `${collection.name} is parsed by a function in the content config before Astro sees it. ` +
        'Fields that are not in the file itself were made by that parser: they are shown, ' +
        'but editing one here would have nowhere to go.'
      : undefined,
  };
}

/**
 * Applies edits to one entry. `edits` are { path, value } against the entry's
 * own data — the locator that puts it inside its file is added here — plus an
 * optional `body` for the formats that have one.
 */
function writeEntry(
  projectPath: string,
  entry: { readonly file: string; readonly locator?: readonly (string | number)[] },
  edits: readonly EntryEdit[],
  { body }: { readonly body?: string } = {},
): { ok: true; changed: boolean } {
  const abs = path.resolve(projectPath, entry.file);
  const format = formatFor(entry.file);
  if (!format) {
    throw new Error(`Stacki cannot write ${path.extname(entry.file)} files.`);
  }
  // The same bound the reader applies: a file can grow between listing and edit.
  if (fs.statSync(abs).size > MAIN_LIMITS.contentEntryBytesMax) {
    throw new Error('This file is too large to edit here.');
  }
  const text = fs.readFileSync(abs, 'utf8');

  const locator = entry.locator ?? [];
  const prefixed: FormatEdit[] = edits.map((edit) =>
    // A rename names a key rather than setting a value, so it carries no value
    // at all — and must not be read as one being cleared.
    edit.rename !== undefined
      ? { path: [...locator, ...edit.path], rename: edit.rename }
      : {
          path: [...locator, ...edit.path],
          value: edit.value === undefined ? format.DELETE : edit.value,
        },
  );

  const next =
    format === frontmatter
      ? frontmatter.applyEdits(text, prefixed, { body })
      : format.applyEdits(text, prefixed);
  if (next === text) {
    return { ok: true, changed: false };
  }
  writeProjectText(abs, next);
  return { ok: true, changed: true };
}

/**
 * How many entries a collection has, without reading them. The panel shows a
 * count next to every collection, and parsing a hundred markdown files to draw
 * a number is a cost with nothing to show for it.
 */
function countEntries(projectPath: string, collection: ContentCollection): number {
  const loader = collection.loader ?? {};
  if (loader.kind === 'glob') {
    const root = path.resolve(projectPath, String(loader.base ?? '').replace(/^\.\//, ''));
    const matchers = patternsOf(loader.pattern);
    return walkFiles(root).filter((rel) => matchers.some((re) => re.test(rel))).length;
  }
  if (loader.kind === 'file') {
    try {
      return listEntries(projectPath, collection).entries.length;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * The files a content collection already owns. They are edited through their
 * schema, not as loose JSON, so the file-based editor leaves them alone rather
 * than offering a second way in with different rules.
 */
function coveredPaths(collections: readonly ContentCollection[]): {
  files: string[];
  dirs: string[];
} {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const collection of collections) {
    const loader = collection.loader ?? {};
    if (loader.kind === 'file' && loader.file) {
      files.push(toPosix(loader.file).replace(/^\.\//, ''));
    }
    if (loader.kind === 'glob' && loader.base) {
      dirs.push(toPosix(loader.base).replace(/^\.\//, '').replace(/\/$/, ''));
    }
  }
  return { files, dirs };
}

export {
  listEntries,
  writeEntry,
  countEntries,
  coveredPaths,
  locateRecords,
  globToRegExp,
  formatFor,
  formatName,
};
