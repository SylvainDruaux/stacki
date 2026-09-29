// Disk and dev-server data are untrusted, even when a previous app run wrote
// them. Keep bounds and parsing separate from handlers so failures are testable.
import {
  boolean,
  count,
  data,
  dictionary,
  list,
  nullable,
  object,
  optional,
  pathText,
  record,
  text,
} from '../shared/boundary.js';
import { toRecord } from '../shared/record.js';
import type { Data } from '../shared/boundary.js';
import type { ContentCollection } from './contentEntries.js';
import type { DynamicEntry } from './main.types.js';

export { data as parseData, record as parseRecord, text as parseString };
export const parseOptionalString = optional(text);
export const parseSettings = object({ sound: boolean });
export const parseRecents = list(object({ path: pathText, name: text, openedAt: count }));
export const parseAstroLock = object({ url: text });

export function parseAliases(input: unknown): readonly (readonly [string, readonly string[]])[] {
  const paths = toRecord(toRecord(toRecord(input)?.['compilerOptions'])?.['paths']);
  if (!paths) {
    return [];
  }
  return Object.entries(
    dictionary((value) => list(text)(typeof value === 'string' ? [value] : value))(paths),
  ).map(
    ([key, values]) =>
      [key.replace(/\*$/, ''), values.map((value) => value.replace(/\*$/, ''))] as const,
  );
}

export interface Collection extends ContentCollection {
  readonly loader?: NonNullable<ContentCollection['loader']> & { readonly kind: string };
  readonly extensions?: readonly string[];
  readonly hasBody?: boolean;
  readonly idFromFile?: boolean;
  readonly crossFieldChecks?: boolean;
  readonly freeform?: boolean | undefined;
  readonly error?: string | undefined;
}

export interface ContentConfig {
  readonly collections: readonly Collection[];
  readonly missing?: true;
  readonly error?: string;
  readonly configPath?: string;
}

export function parseContentConfig(input: unknown): ContentConfig {
  const source = record(input);
  const collections = list(parseCollection)(source['collections']);
  const configPath = optional(text)(source['configPath']);
  const error = optional(text)(source['error']);
  return {
    collections,
    ...(source['missing'] === true ? { missing: true } : {}),
    ...(configPath === undefined ? {} : { configPath }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseCollection(input: unknown): Collection {
  // Preserve extension metadata after bounding its JSON shape. Known fields
  // receive their own parsers because renderer panels rely on their types.
  const source = record(data(input));
  const metadata = object({
    name: text,
    editable: optional(boolean),
    freeform: optional(boolean),
    error: optional(text),
    extensions: optional(list(text)),
    hasBody: optional(boolean),
    idFromFile: optional(boolean),
    crossFieldChecks: optional(boolean),
    schema: data,
  })(source);
  const loader = source['loader'] === undefined ? undefined : parseLoader(source['loader']);
  return { ...source, ...metadata, ...(loader === undefined ? {} : { loader }) };
}

function parseLoader(input: unknown): NonNullable<Collection['loader']> {
  const source = record(data(input));
  const parsed = object({
    kind: text,
    base: optional(text),
    file: optional(text),
    pattern: optional((value) => (typeof value === 'string' ? text(value) : list(text)(value))),
    generateId: optional(boolean),
    parser: optional(boolean),
    name: optional(nullable(text)),
  })(source);
  return { ...source, ...parsed };
}

export function parseDynamicPaths(input: unknown): {
  readonly entries: readonly DynamicEntry[];
  readonly error: string | null;
} {
  const source = record(input);
  return {
    entries: list(parseDynamicEntry)(source['entries'] ?? []),
    error: nullable(text)(source['error'] ?? null),
  };
}

function parseDynamicEntry(input: unknown): DynamicEntry {
  const source = record(input);
  // Older marker servers returned bare params. Preserve that supported wire shape.
  return {
    params: dictionary(data)(source['params'] ?? source),
    props: data(source['props'] ?? null),
  };
}

export function parseSampleEntry(input: unknown): {
  readonly entry: Data;
  readonly error?: string | null;
} {
  const source = record(input);
  const error = optional(nullable(text))(source['error']);
  return { entry: data(source['entry'] ?? null), ...(error === undefined ? {} : { error }) };
}

export const parseValidationResult = object({
  issues: list(
    object({
      path: list((input): string | number =>
        typeof input === 'number' ? count(input) : text(input),
      ),
      message: text,
      code: text,
    }),
  ),
  unchecked: optional(boolean),
  error: optional(text),
});
