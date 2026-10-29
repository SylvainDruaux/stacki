// Reuse the scan's bounded source reads so titles require no additional disk access.
import { parsePage } from '../parse/astroParser';
import { layoutPageTitle } from '../../shared/page/pageTitle';
import type { ScanPage } from '../../shared/properties/projectScan';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { resolveSpec, type Alias } from '../content/cmsRefs';

export type PageTitleSource = { readonly specifier: string | undefined } & (
  { readonly kind: 'inherit' } | { readonly kind: 'override'; readonly title: string | undefined }
);

// Cyclic or unusually deep wrapper chains fall back to filenames without running site code.
const WRAPPERS_MAX = 32;

export function scanPageTitles(
  pages: readonly ScanPage[],
  sources: readonly { readonly file: string; readonly text: string }[],
  aliases: readonly Alias[] = [],
): readonly ScanPage[] {
  assert(pages.length <= LIMITS.scanEntriesMax, 'Page titles: page count is bounded');
  assert(sources.length <= LIMITS.scanEntriesMax, 'Page titles: source count is bounded');
  const sourceByPath = new Map(sources.map(({ file, text }) => [file, text]));
  // Keep only small title summaries, not every parsed page tree, during a scan.
  const cache = new Map<string, PageTitleSource | undefined>();
  const read = (file: string): PageTitleSource | undefined => {
    if (!cache.has(file)) {
      const text = sourceByPath.get(file);
      cache.set(file, text === undefined ? undefined : scanPageTitleSource(text));
    }
    return cache.get(file);
  };
  return resolvePageTitles(pages, aliases, read);
}

export function resolvePageTitles(
  pages: readonly ScanPage[],
  aliases: readonly Alias[],
  read: (file: string) => PageTitleSource | undefined,
): readonly ScanPage[] {
  assert(pages.length <= LIMITS.scanEntriesMax, 'Page titles: page count is bounded');
  const wrapperOf = (file: string, source: PageTitleSource): string | undefined => {
    const candidates =
      source.specifier === undefined ? [] : resolveSpec(source.specifier, file, aliases);
    return candidates.find((candidate) => read(candidate) !== undefined);
  };
  return pages.map((page) => {
    if (!page.path.toLowerCase().endsWith('.astro')) {
      return page;
    }
    const source = read(page.path);
    if (source === undefined) {
      return page;
    }
    const inheritedTitle = scanInheritedTitle(wrapperOf(page.path, source), wrapperOf, read);
    const title = source.kind === 'override' ? source.title : inheritedTitle;
    return title === undefined && inheritedTitle === undefined
      ? page
      : { ...page, title, inheritedTitle };
  });
}

export function scanPageTitleSource(text: string): PageTitleSource | undefined {
  const parsed = parsePage(text);
  if (!parsed.editable) {
    return undefined;
  }
  const layout = parsed.model.nodes.find((node) => node.id === 'layout');
  if (layout?.kind !== 'component') {
    return undefined;
  }
  const imported = parsed.model.imports.find((entry) => entry.name === layout.name);
  return layout.props?.['title'] === undefined
    ? { kind: 'inherit', specifier: imported?.path }
    : { kind: 'override', title: layoutPageTitle(parsed.model.nodes), specifier: imported?.path };
}

function scanInheritedTitle(
  wrapper: string | undefined,
  wrapperOf: (file: string, source: PageTitleSource) => string | undefined,
  read: (file: string) => PageTitleSource | undefined,
): string | undefined {
  const visited = new Set<string>();
  let current = wrapper;
  for (let depth = 0; depth < WRAPPERS_MAX; depth++) {
    if (current === undefined || visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    const source = read(current);
    if (source?.kind === 'override') {
      return source.title;
    }
    current = source === undefined ? undefined : wrapperOf(current, source);
  }
  return undefined;
}
