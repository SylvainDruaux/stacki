import fs from 'fs';
import path from 'path';

import { toRecord, toArray } from '../shared/record.js';

// Finds the files that import a JSON collection, and rewrites them to stop:
// `import clients from '../data/clients.json'` becomes `const clients = []`,
// so a page that loops over the deleted data still renders — empty — instead
// of failing to build.

const CODE_EXT = /\.(astro|[cm]?[jt]sx?)$/i;
// `import <clause> from '<spec>'` — the only form that binds a name to JSON.
// The clause can't hold a quote or a semicolon, so a side-effect import above
// it (`import './styles.css';`) can't be swallowed into this one's clause.
const IMPORT_RE = /^([ \t]*)import\s+([^;'"]*?)\s+from\s*['"]([^'"]+)['"]\s*;?[ \t]*\r?\n?/gm;

// tsconfig/jsconfig allow comments and trailing commas, which JSON.parse won't.
function readJsonc(file: string): unknown {
  try {
    const raw = fs
      .readFileSync(file, 'utf8')
      .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*$|\/\*[\s\S]*?\*\/)/gm, (m, comment) =>
        comment ? '' : m,
      )
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface Alias {
  readonly prefix: string;
  readonly wildcard: boolean;
  readonly targets: readonly string[];
}

// Path aliases from tsconfig ("@/*": ["src/*"]), so an aliased import of a
// collection is recognised as the same file a relative one points at.
function aliasMap(projectPath: string): Alias[] {
  const config =
    readJsonc(path.join(projectPath, 'tsconfig.json')) ??
    readJsonc(path.join(projectPath, 'jsconfig.json'));
  const compilerOptions = toRecord(toRecord(config)?.['compilerOptions']);
  const paths = toRecord(compilerOptions?.['paths']);
  if (!compilerOptions || !paths) {
    return [];
  }
  const base = path.resolve(projectPath, String(compilerOptions['baseUrl'] ?? '.'));
  return Object.entries(paths).map(([pattern, targets]) => ({
    prefix: pattern.replace(/\*$/, ''),
    wildcard: pattern.endsWith('*'),
    targets: (toArray(targets) ?? []).map((t) => path.resolve(base, String(t).replace(/\*$/, ''))),
  }));
}

function resolveSpec(spec: string, fromFile: string, aliases: readonly Alias[]): string[] {
  if (spec.startsWith('.')) {
    return [path.resolve(path.dirname(fromFile), spec)];
  }
  for (const alias of aliases) {
    if (alias.wildcard ? spec.startsWith(alias.prefix) : spec === alias.prefix) {
      const rest = spec.slice(alias.prefix.length);
      return alias.targets.map((t) => path.resolve(t, rest));
    }
  }
  return []; // a bare package specifier — not a project file
}

// The names an import clause binds: default, namespace and named alike. All
// of them stand in for part of the deleted file, so all of them become [].
function boundNames(clause: string): string[] {
  const names: string[] = [];
  const body = clause.replace(/^type\s+/, ''); // `import type { X } from` binds nothing at runtime
  const braces = body.match(/\{([\s\S]*)\}/);
  const outside = body.replace(/\{[\s\S]*\}/, '');
  const add = (raw: string): void => {
    const name = raw
      .trim()
      .replace(/^type\s+/, '')
      .replace(/^\*\s+as\s+/, '')
      .split(/\s+as\s+/)
      .pop()
      ?.trim();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
      names.push(name);
    }
  };
  for (const part of outside.split(',')) {
    add(part);
  }
  const braced = braces?.[1];
  if (braced !== undefined) {
    for (const part of braced.split(',')) {
      add(part);
    }
  }
  return names;
}

function walkCodeFiles(dir: string, out: string[] = []): string[] {
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
      walkCodeFiles(full, out);
    } else if (CODE_EXT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export interface Importer {
  readonly file: string;
  readonly rel: string;
  readonly names: readonly string[];
  readonly next: string;
}

// Every file that imports `targetAbs`, with the rewritten source that drops
// the import in favour of empty arrays.
function importersOf(projectPath: string, targetAbs: string): Importer[] {
  const aliases = aliasMap(projectPath);
  const target = path.resolve(targetAbs);
  const hits: Importer[] = [];
  for (const file of walkCodeFiles(path.join(projectPath, 'src'))) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('import')) {
      continue;
    }
    const names: string[] = [];
    const next = text.replace(IMPORT_RE, (match, indent: string, clause: string, spec: string) => {
      const resolved = resolveSpec(spec, file, aliases);
      if (!resolved.some((r) => r === target)) {
        return match;
      }
      const bound = boundNames(clause);
      names.push(...bound);
      if (!bound.length) {
        return ''; // side-effect import — just drop it
      }
      return bound.map((n) => `${indent}const ${n} = [];\n`).join('');
    });
    if (names.length || next !== text) {
      hits.push({ file, rel: path.relative(path.join(projectPath, 'src'), file), names, next });
    }
  }
  return hits;
}

// The file an import specifier points at, or null. Extensionless specifiers
// get the usual candidates tried, the way a bundler would.
const IMPORT_EXTS = ['', '.astro', '.jsx', '.tsx', '.js', '.ts', '.vue', '.svelte', '.md', '.mdx'];

function resolveImport(projectPath: string, fromFile: string, spec: string): string | null {
  for (const base of resolveSpec(spec, fromFile, aliasMap(projectPath))) {
    for (const ext of IMPORT_EXTS) {
      const candidate = base + ext;
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* keep looking */
      }
    }
    for (const ext of IMPORT_EXTS.slice(1)) {
      const candidate = path.join(base, `index${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export { importersOf, boundNames, resolveSpec, resolveImport, aliasMap };
