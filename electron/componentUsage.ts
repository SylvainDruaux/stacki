// Where a component is used.
//
// The palette says "23 instances" — a number the panel works out by counting
// `<Name` across every .astro file under src. That count is the interesting
// half of a question it doesn't answer: 23 instances WHERE. Same count, same
// regex, now with the files it came from, so the number can be opened.
//
// Matched the way the count is matched, deliberately: if the two disagreed, the
// list would be missing something the number promised, and nothing would say
// which of them was lying.

import fs from 'fs';
import path from 'path';

import { aliasMap, boundNames, resolveSpec } from './content/cmsRefs';
import type { Alias } from './content/cmsRefs';
import { MAIN_LIMITS } from './lib/mainLimits';
import { sameFilesystemPath } from './lib/platform';

const toPosix = (filePath: string): string => filePath.split(path.sep).join('/');

/** Every file that can hold an instance: .astro anywhere, and markdown pages,
 *  which render components too. The same set the palette's own count walks. */
function astroFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    // A project's folders are not ours to trust: a tree deeper than any real one stops the
    // walk there, before it can exhaust the stack.
    if (depth > MAIN_LIMITS.directoryDepthMax) {
      return;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (
        entry.name.endsWith('.astro') ||
        (current.includes(`${path.sep}pages`) && /\.mdx?$/i.test(entry.name))
      ) {
        out.push(full);
      }
    }
  };
  walk(directory, 0);
  return out;
}

/**
 * The markup, without the frontmatter above it — where instances actually are.
 *
 * A component's own code talks about itself: Lumos's Card.astro carries three
 * `console.warn('[lumos] <Card variant="…">…')` lines, and counting the file's
 * text as a whole read those as three more cards on the page. The number in the
 * palette was the number of times the name appeared, which is not the same
 * thing as the number of times the component is used.
 */
function templateOf(source: unknown): string {
  return String(source ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
}

/** How many times `source` uses `<Name …>`. Closing tags and frontmatter code
 *  don't count. */
function countIn(source: unknown, name: unknown): number {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(String(name || ''))) {
    return 0;
  }
  return (templateOf(source).match(new RegExp(`<${String(name)}[\\s/>]`, 'g')) || []).length;
}

const IMPORT_RE = /^[ \t]*import\s+([^;'"]*?)\s+from\s*['"]([^'"]+)['"]/gm;

export interface FileImport {
  readonly names: readonly string[];
  readonly candidates: ReadonlySet<string>;
}

/**
 * What each import in a file brings in, as `{ names, candidates }`.
 *
 * A tag is a local binding, not a filename. Every page in a Lumos project says
 *
 *   import Layout from "@/layouts/BaseLayout.astro";
 *   <Layout> … </Layout>
 *
 * so counting `<BaseLayout` found nothing and the palette reported 0 instances
 * of a layout on every page in the project. The name to count is whatever THAT
 * file calls it.
 */
function importsOf(source: unknown, file: string, aliases: readonly Alias[]): FileImport[] {
  const out: FileImport[] = [];
  IMPORT_RE.lastIndex = 0;
  let match;
  while ((match = IMPORT_RE.exec(String(source))) !== null) {
    const clause = match[1];
    const spec = match[2];
    if (clause === undefined || spec === undefined) {
      continue;
    }
    const names = boundNames(clause);
    if (!names.length) {
      continue;
    }
    const candidates = new Set<string>();
    for (const base of resolveSpec(spec, file, aliases)) {
      candidates.add(base);
      // A specifier can leave the extension off; components are .astro.
      if (!/\.[a-z]+$/i.test(base)) {
        candidates.add(`${base}.astro`);
      }
    }
    if (candidates.size) {
      out.push({ names, candidates });
    }
  }
  return out;
}

interface InstanceArgs {
  readonly file: string;
  readonly targetPath?: string | undefined;
  readonly name: string;
  readonly aliases?: readonly Alias[];
}

/**
 * How many instances of one component a file holds — counted under the name
 * that file imports it as. A file that doesn't import it falls back to the
 * component's own name: markdown pages and auto-import integrations render
 * components they never name in an import.
 */
function instancesIn(
  source: unknown,
  { file, targetPath, name, aliases = [] }: InstanceArgs,
): number {
  const target = targetPath ? path.resolve(targetPath) : undefined;
  if (target) {
    const imports = importsOf(source, file, aliases);
    const local: string[] = [];
    for (const imp of imports) {
      if ([...imp.candidates].some((candidate) => sameFilesystemPath(candidate, target))) {
        local.push(...imp.names);
      }
    }
    if (local.length) {
      return local.reduce((total, alias) => total + countIn(source, alias), 0);
    }
    // The name is taken by something else here. `import Section from
    // './ui/Section.astro'` in a file that doesn't use OURS means every
    // `<Section>` on the page belongs to that one, not to this component.
    if (imports.some((imp) => imp.names.includes(name))) {
      return 0;
    }
  }
  return countIn(source, name);
}

export interface UsageFile {
  readonly rel: string;
  readonly path: string;
  readonly kind: 'page' | 'layout' | 'component' | 'file';
  readonly count: number;
}

/**
 * The files that hold instances of `name`, most-used first, each as
 * `{ rel, path, kind, count }`. `kind` is where the file lives — a page, a
 * layout, or another component — which is how the caller knows whether opening
 * it means going to a page or drilling into a component.
 *
 * The component's own file is left out: a file is not one of its own users, and
 * a recursive component would otherwise list itself above everything else.
 */
function componentUsage({
  projectPath,
  name,
  exclude,
}: {
  readonly projectPath: string;
  readonly name: string;
  readonly exclude?: string;
}): { files: UsageFile[]; total: number } {
  const sourceFolder = path.join(projectPath, 'src');
  const skip = exclude ? path.resolve(exclude) : undefined;
  // `exclude` is the component's own file, which is also the file every other
  // file's import has to resolve to for its local name to count.
  const aliases = aliasMap(projectPath);
  const kindOf = (file: string): UsageFile['kind'] => {
    const rel = toPosix(path.relative(sourceFolder, file));
    if (rel.startsWith('pages/')) {
      return 'page';
    }
    if (rel.startsWith('layouts/')) {
      return 'layout';
    }
    if (rel.startsWith('components/')) {
      return 'component';
    }
    return 'file';
  };

  const files: UsageFile[] = [];
  for (const file of astroFiles(sourceFolder)) {
    if (skip && sameFilesystemPath(file, skip)) {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const count = instancesIn(text, { file, targetPath: exclude, name, aliases });
    if (!count) {
      continue;
    }
    files.push({
      rel: toPosix(path.relative(projectPath, file)),
      path: file,
      kind: kindOf(file),
      count,
    });
  }
  // Most instances first, then by name — the file it's really "in" leads.
  files.sort((left, right) => right.count - left.count || left.rel.localeCompare(right.rel));
  return { files, total: files.reduce((total, usage) => total + usage.count, 0) };
}

export { componentUsage, countIn, instancesIn, importsOf, templateOf, astroFiles };
