// Project-backed replacement for the Webflow Designer integration.
//
// The panel above this module is unchanged from moden: it asks for "embeds"
// that contribute page-global CSS, for the selected element's identity, and
// for the element tree around it. Only the answers differ.
//
//   Webflow                          Astro project
//   ─────────────────────────────    ────────────────────────────────────────
//   HtmlEmbed containing <style>  →  a stylesheet in the project, or a
//                                    <style> block on the page / in a chunk
//   Designer element              →  a node in the page model
//   element.getStyles() classes   →  the node's class attribute
//   native (class) styles         →  none: here every style IS css text
//   Designer variables            →  CSS custom properties found in the css
//
// The EmbedSource/EmbedDoc shapes are kept exactly, so css.ts, cascade.ts,
// resolved.ts and every section component work untouched: an embed's code is
// just text with CSS regions in it, and a stylesheet is that with one region
// covering the whole file.

import { collectRules, parseRegion, renderEmbed, splitEmbed } from './css';
import { assert } from '../../../shared/assert';
import postcss from 'postcss';
import type { CanvasAnswer } from '../../canvasReply';
import { findNode, getHost, onHostChange, propText, walkNodes, type HostNode } from './host';
import type { StateKey } from './resolved';
import type {
  BreakpointId,
  ElementSnapshot,
  NativeModel,
  NativeStyle,
  ParsedRule,
  StyleRegion,
} from './types';
import type { MatchTarget, TreeView } from './selectors';
import { hasCanvas, queryCanvas } from '../../canvasQuery.js';
import { listAssetEntries } from '../../assetBridge';
import { readAstroStyleFiles, readStyleFiles } from '../../stylePanelBridge';
import { variableEdit } from '../../panels/variableEdits';
import type { NativeStyleOptions } from './native-styles';

type AnyElement = unknown;

// ───────────────────────────── Identity helpers ─────────────────────────────

export function serializeElementId(id: unknown): string {
  if (id === undefined) {
    return '';
  }
  // An element id handed through the Designer-shaped API may spell "none" as null.
  if (id === null) {
    return '';
  }
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id === 'object' && 'id' in id && typeof id.id === 'string') {
    return id.id;
  }
  try {
    return JSON.stringify(id);
  } catch {
    return String(id);
  }
}

// Kept from the Webflow build so a name typed in the class field compiles the
// same way it would there — lowercased, spaces to hyphens, digits prefixed.
export function webflowClassToCss(name: string): string {
  const compiled = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, '')
    .replace(/\s+/g, '-');
  return /^[0-9]/.test(compiled) ? `_${compiled}` : compiled;
}

// The panel drives itself off two Designer events: which element is selected
// and which breakpoint is active. Both come from the app, so this exposes just
// those — enough for the panel to run, and nothing that implies a Designer is
// present (native styling still reports unavailable further down).
type Unsub = () => void;

export function webflowApi() {
  return {
    getSelectedElement: async (): Promise<AnyElement> => nodeById(getHost().selectedId),
    subscribe: (event: string, callback: (value: unknown) => void): Unsub => {
      if (event === 'selectedelement') {
        let last = getHost().selectedId;
        return onHostChange(() => {
          const now = getHost().selectedId;
          if (now === last) {
            return;
          }
          last = now;
          callback(nodeById(now));
        });
      }
      if (event === 'mediaquery') {
        let last = getHost().device;
        return onHostChange(() => {
          const now = getHost().device;
          if (now === last) {
            return;
          }
          last = now;
          void getCurrentBreakpoint().then(callback);
        });
      }
      return () => {};
    },
  };
}

const nodeById = (id: string | undefined): HostNode | undefined =>
  id ? findNode(getHost().nodes, id) : undefined;

// A node's classes. `class="a b"` is readable straight from the source, but
// `class:list={[…]}` / `class={expr}` are expressions with no class text at
// all — for those the only truth is what the page rendered. The preview reports
// that for the selected element, so merge it in: a static class inside a
// class:list shows up, and a computed one (`gap-${gap}`) shows the value THIS
// instance resolved to. Source order first, then anything only the DOM knows.
// The string literals in an expression-valued class attribute. `class:list={[
// "container", gap !== "8" && `gap-${gap}`, ...rest ]}` yields `container` — a
// literal is a class this element always has, so it can be shown straight away
// instead of waiting on the canvas. Template literals with a `${}` hole are
// skipped: only the rendered element knows what they became. Values that aren't
// class-shaped (selectors, URLs, sentences) are dropped.
const CLASS_RE = /^[A-Za-z_-][A-Za-z0-9_-]*$/;
const literalClasses = (node: HostNode | undefined, name: string): string[] => {
  const prop = node?.props?.[name];
  if (!prop || prop.type !== 'expr') {
    return [];
  }
  const out: string[] = [];
  for (const [, quote, body] of String(prop.value ?? '').matchAll(/(['"`])([^'"`]*)\1/g)) {
    const literalBody = body ?? '';
    if (quote === '`' && literalBody.includes('${')) {
      continue;
    }
    for (const tok of literalBody.split(/\s+/)) {
      if (CLASS_RE.test(tok)) {
        out.push(tok);
      }
    }
  }
  return out;
};

const classTokens = (node: HostNode | undefined): string[] => {
  // A class can be named in more than one place (`class` plus `class:list`, or
  // twice within one list) — the element still carries it once.
  const authored = [
    ...new Set([
      ...propText(node, 'class').split(/\s+/).filter(Boolean),
      // `class:list={[…]}`, and `class={…}` when it's an expression.
      ...literalClasses(node, 'class:list'),
      ...literalClasses(node, 'class'),
    ]),
  ];
  const host = getHost();
  // Rendered classes describe the selected element only — attributing them to
  // any other node (an ancestor being matched, say) would be wrong.
  if (!node || node.id !== host.selectedId) {
    return authored;
  }
  const out = [...authored];
  for (const cls of host.renderedClasses || []) {
    if (cls && !out.includes(cls)) {
      out.push(cls);
    }
  }
  return out;
};

// Elements reach the panel through the Designer-shaped API as `unknown`; one is
// read as a node only when it carries a node's identity.
function isHostNode(value: unknown): value is HostNode {
  if (typeof value === 'object' && value !== null) {
    if ('id' in value && 'kind' in value) {
      return typeof value.id === 'string' && typeof value.kind === 'string';
    }
  }
  return false;
}

export async function buildSnapshot(element: AnyElement): Promise<ElementSnapshot> {
  const node =
    typeof element === 'string' ? nodeById(element) : isHostNode(element) ? element : undefined;
  const classes = classTokens(node);
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(node?.props || {})) {
    if (value && value.type === 'string') {
      attributes[key] = String(value.value ?? '');
    } else if (value && value.type === 'bare') {
      attributes[key] = '';
    }
  }
  const id = propText(node, 'id');
  if (id) {
    attributes['id'] = id;
  }
  if (classes.length) {
    attributes['class'] = classes.join(' ');
  }
  return {
    // A component instance renders markup we can't see from here, so it has
    // no tag of its own — selectors match it by class only.
    tag: node?.kind === 'element' ? String(node.name || '').toLowerCase() : undefined,
    webflowType: node?.kind === 'component' ? 'Component' : node?.kind || 'Element',
    id: id || undefined,
    classes,
    classList: classes,
    attributes,
  };
}

export async function resolveIdentityElement(selected: AnyElement): Promise<AnyElement> {
  return selected;
}

// ───────────────────────────── Style sources ─────────────────────────────

export type EmbedSource = {
  key: string;
  label: string;
  classNames: string[];
  fromComponent: boolean;
  componentName: string | undefined;
  order: number;
  element: AnyElement;
  instance?: AnyElement;
  /** Where the CSS lives — the panel writes back through this. `astro` is a
   *  component file whose `<style is:global>` blocks are edited in place. */
  origin:
    | { kind: 'file'; path: string }
    | { kind: 'node'; nodeId: string }
    | { kind: 'astro'; path: string };
};

/** One source's CSS, parsed into live regions. Its code advances only through its own
 *  methods: a write records what the source now holds, and a reload replaces the
 *  regions with a fresh read. The regions' postcss roots are edited in place. */
export class EmbedDocument {
  readonly source: EmbedSource;
  #code: string;
  #segments: string[];
  #regions: StyleRegion[];

  constructor(source: EmbedSource, code: string, segments: string[], regions: StyleRegion[]) {
    // Segments interleave the regions: one before each, and one after the last.
    assert(segments.length === regions.length + 1, 'EmbedDocument: segments around regions');
    this.source = source;
    this.#code = code;
    this.#segments = segments;
    this.#regions = regions;
  }

  /** What the source held when last read or written. */
  get code(): string {
    return this.#code;
  }

  get segments(): string[] {
    return this.#segments;
  }

  get regions(): StyleRegion[] {
    return this.#regions;
  }

  /** The source now holds `code`, serialized from these regions. */
  recordWritten(code: string): void {
    this.#code = code;
  }

  /** Take on a fresh read of the same source. */
  replaceWith(fresh: EmbedDocument): void {
    assert(fresh.source.key === this.source.key, 'EmbedDocument: reload of the same source');
    this.#segments = fresh.segments;
    this.#regions = fresh.regions;
    this.#code = fresh.code;
  }
}

export type EmbedScan = {
  parentByKey: Map<string, string>;
  childrenByKey: Map<string, string[]>;
  elementByKey: Map<string, HostNode>;
  embeds: EmbedSource[];
  inComponentContext: boolean;
};

export type PageScan = {
  parentByKey: Map<string, string>;
  childrenByKey: Map<string, string[]>;
  elementByKey: Map<string, HostNode>;
  pageEmbeds: EmbedSource[];
  instances: AnyElement[];
  inComponentContext: boolean;
};

export function dedupeByKey(sources: EmbedSource[]): EmbedSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.key)) {
      return false;
    }
    seen.add(source.key);
    return true;
  });
}

// Webflow appended a suffix so two embeds couldn't scaffold the same class
// name. Sources here are files and nodes with distinct identities already.
export function embedSourceClassSuffix(_source?: EmbedSource): string {
  return '';
}

// Every source of CSS that reaches this page, in cascade order: stylesheets
// first (they're linked in <head>), then the page's own <style> blocks, which
// come later in the document and so win ties.
function styleSources(): EmbedSource[] {
  const host = getHost();
  const out: EmbedSource[] = [];
  let order = 0;
  const openComponentName =
    host.openFileKind === 'component'
      ? host.openFilePath
          ?.split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, '')
      : undefined;

  for (const file of host.files) {
    out.push({
      key: `file:${file.path}`,
      label: file.rel,
      classNames: [],
      fromComponent: false,
      componentName: undefined,
      order: order++,
      element: file.path,
      origin: { kind: 'file', path: file.path },
    });
  }

  // Every OTHER component's `<style is:global>`. Those rules are unhashed, so
  // they style what the page renders no matter which file the selection came
  // from — without this, styling a component instance from a page shows an
  // empty panel even though the element is clearly styled on the canvas. The
  // open file is skipped: its own <style> blocks come from the model below,
  // and reading it twice would let the two copies write over each other.
  for (const file of host.astroFiles) {
    if (host.openFilePath && file.path === host.openFilePath) {
      continue;
    }
    out.push({
      key: `astro:${file.path}`,
      label: file.name,
      classNames: [],
      fromComponent: true,
      componentName: file.name.replace(/\.astro$/i, ''),
      order: order++,
      element: file.path,
      origin: { kind: 'astro', path: file.path },
    });
  }

  walkNodes(host.nodes, (node) => {
    if (node.kind !== 'raw' || node.name !== 'style') {
      return;
    }
    const isGlobal = !!node.props?.['is:global'];
    out.push({
      key: `node:${node.id}`,
      label: isGlobal ? '<style is:global>' : '<style>',
      classNames: [],
      fromComponent: host.openFileKind === 'component',
      componentName: openComponentName,
      order: order++,
      element: node.id,
      origin: { kind: 'node', nodeId: node.id },
    });
  });

  return out;
}

// Both scans return the same thing: this app has no page/component boundary
// to cross — opening a component swaps the model, and the sources are read
// from whatever is open.
export async function scanPage(): Promise<PageScan> {
  const { parentByKey, childrenByKey, elementByKey } = buildTreeMaps();
  return {
    parentByKey,
    childrenByKey,
    elementByKey,
    pageEmbeds: styleSources(),
    instances: [],
    inComponentContext: false,
  };
}

export async function scanAllComponents(
  onEmbeds?: (embeds: EmbedSource[]) => void | Promise<void>,
): Promise<EmbedSource[]> {
  const embeds = styleSources();
  if (onEmbeds) {
    await onEmbeds(embeds);
  }
  return embeds;
}

export function scanHasElement(scan: EmbedScan, selected: AnyElement): boolean {
  return scan.elementByKey.has(serializeElementId(selected));
}

// Model kinds that render exactly one element (so CSS counts them as a child),
// and kinds whose element count can't be known without running the page.
// Everything else (text, comment, raw-line) renders no element at all.
// A custom property's group is the selector of the rule declaring it; one set
// at the root of a sheet (or inside an at-rule) has none.
function ruleSelectorOf(parent: unknown): string {
  if (typeof parent === 'object' && parent !== null) {
    if ('selector' in parent) {
      return typeof parent.selector === 'string' ? parent.selector : '';
    }
  }
  return '';
}

const ELEMENT_KINDS = new Set(['element', 'component', 'raw']);
const OPAQUE_COUNT_KINDS = new Set(['map', 'expr', 'chunk-group', 'cond', 'branch']);

function buildTreeMaps() {
  const parentByKey = new Map<string, string>();
  const childrenByKey = new Map<string, string[]>();
  const elementByKey = new Map<string, HostNode>();
  walkNodes(getHost().nodes, (node, parent) => {
    elementByKey.set(node.id, node);
    if (parent) {
      parentByKey.set(node.id, parent.id);
      const kids = childrenByKey.get(parent.id) || [];
      kids.push(node.id);
      childrenByKey.set(parent.id, kids);
    }
  });
  return { parentByKey, childrenByKey, elementByKey };
}

// ───────────────────────────── Reading & writing ─────────────────────────────

// Both kinds are raw CSS: a stylesheet is a file of it, and a <style> node
// holds only its inner text — the app keeps the tag itself in the model. So
// each is one region spanning the whole text. (A Webflow embed was HTML with
// <style> blocks inside it, which is why the original had to split it.)
/** Is this `<style>` block global — i.e. does it style the page rather than
 *  only its own component? A block with no opening tag recorded (a stylesheet)
 *  is global by definition. */
function isGlobalRegion(region: StyleRegion): boolean {
  return region.openTag === undefined || /\bis:global\b/.test(region.openTag);
}

function documentForSource(source: EmbedSource, code: string): EmbedDocument {
  // A component file is markup with <style> blocks in it — the shape the embed
  // model was built for. Only its global blocks are parsed; a scoped block is
  // left as untouched text, so renderEmbed writes it back verbatim and
  // rebuildRules (which skips a region without a root) never offers its rules for
  // an element in another component.
  if (source.origin.kind === 'astro') {
    const { segments, regions } = splitEmbed(code);
    const parsed = regions.map((region) => (isGlobalRegion(region) ? parseRegion(region) : region));
    return new EmbedDocument(source, code, segments, parsed);
  }
  const region = parseRegion({ start: 0, end: code.length, css: code, root: undefined });
  return new EmbedDocument(source, code, ['', ''], [region]);
}

async function readSource(source: EmbedSource): Promise<string> {
  if (source.origin.kind === 'file' || source.origin.kind === 'astro') {
    const result = await variableEdit('readStyleFile', source.origin.path);
    return result.ok ? (result.css ?? '') : '';
  }
  const node = nodeById(source.origin.nodeId);
  return String(node?.inner ?? '');
}

/** The text this doc's source file should now hold. A stylesheet or a <style>
 *  node is all CSS; a component file is its markup with only the edited
 *  regions re-stringified. */
function serializeDocument(embedDocument: EmbedDocument): string {
  if (embedDocument.source.origin.kind === 'astro') {
    return renderEmbed(embedDocument.segments, embedDocument.regions);
  }
  return embedDocument.regions[0]?.root?.toString() ?? embedDocument.regions[0]?.css ?? '';
}

/**
 * Read each source's code and parse it into live regions. The reads run
 * concurrently — each is an IPC round trip to the main process, and waiting
 * for one before starting the next made the scan linear in the number of
 * stylesheets and global-style components the project has. `onDoc` fires as
 * each lands so callers can stream; the returned arrays stay in source order,
 * which is cascade order.
 */
export async function loadEmbedDocs(
  sources: EmbedSource[],
  onDocument?: (doc: EmbedDocument) => void,
): Promise<{ docs: EmbedDocument[]; errors: Array<{ label: string; message: string }> }> {
  const loaded = await Promise.all(
    sources.map(async (source) => {
      try {
        const embedDocument = documentForSource(source, await readSource(source));
        onDocument?.(embedDocument);
        return { doc: embedDocument, error: undefined };
      } catch (error: unknown) {
        return {
          doc: undefined,
          error: {
            label: source.label,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
  const docs: EmbedDocument[] = [];
  const errors: Array<{ label: string; message: string }> = [];
  for (const entry of loaded) {
    if (entry.doc) {
      docs.push(entry.doc);
    }
    if (entry.error) {
      errors.push(entry.error);
    }
  }
  return { docs, errors };
}

export async function writeEmbedDocument(
  embedDocument: EmbedDocument,
  /** A live (scrubbing / mid-typing) write — for a <style> node it coalesces with the
   *  ones around it instead of saving the page per tick. A committed edit saves at once,
   *  so the canvas doesn't wait out a typing debounce for a single click. */
  live = false,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const code = serializeDocument(embedDocument);
  // What the file held before this write — the undo target, captured before
  // doc.code is advanced below.
  const before = embedDocument.code;
  try {
    if (
      embedDocument.source.origin.kind === 'file' ||
      embedDocument.source.origin.kind === 'astro'
    ) {
      const { path } = embedDocument.source.origin;
      await window.avb.writeStyleFile({ filePath: path, css: code });
      // A <style> node's write goes through the page model, which the app
      // already snapshots — only stylesheets need their own history entry.
      if (before !== code) {
        getHost().recordUndo?.({
          label: `styles in ${embedDocument.source.label}`,
          // One step per file per burst: a slider drag writes on every tick.
          coalesceKey: `css:${path}`,
          undo: () => writeStyleFileAndReload(embedDocument, path, before),
          redo: () => writeStyleFileAndReload(embedDocument, path, code),
        });
      }
    } else {
      const write = getHost().writeStyleNode;
      if (!write) {
        return { ok: false, error: 'No page open to write into.' };
      }
      // A <style> block belonging to the page, while a component is open: there
      // is no such node in the model being edited. The write used to find
      // nothing and quietly do nothing, leaving the panel to report a save the
      // canvas would never show.
      if (write(embedDocument.source.origin.nodeId, code, !live) === false) {
        return { ok: false, error: "Couldn't find that <style> block in the open file." };
      }
    }
    embedDocument.recordWritten(code);
    return { ok: true, code };
  } catch (error: unknown) {
    // An empty message says nothing, so it falls back to the thrown value itself.
    const message = error instanceof Error ? error.message : '';
    return { ok: false, error: message || String(error) };
  }
}

// Undo/redo rewrites a stylesheet behind the panel's back, so the doc it will
// write from next has to be brought back in step — otherwise the next edit
// would serialize the stale AST and quietly resurrect what was just undone.
const docsReloaded = new Set<() => void>();
export function onDocsReloaded(listener: () => void): () => void {
  docsReloaded.add(listener);
  return () => {
    docsReloaded.delete(listener);
  };
}

async function writeStyleFileAndReload(
  embedDocument: EmbedDocument,
  path: string,
  text: string,
): Promise<void> {
  await window.avb.writeStyleFile({ filePath: path, css: text });
  // Re-derive the doc from what the file now holds, the same way it was first
  // read — for a component file that means re-splitting its markup, not
  // treating the whole file as one region of CSS.
  embedDocument.replaceWith(documentForSource(embedDocument.source, text));
  for (const listener of docsReloaded) {
    listener();
  }
}

export function rebuildRules(docs: EmbedDocument[]): ParsedRule[] {
  const rules: ParsedRule[] = [];
  // One running counter across every source, so document order — and with it
  // the cascade — is comparable between a stylesheet and a <style> block.
  const order = { n: 0 };
  const ordered = [...docs].sort((left, right) => left.source.order - right.source.order);

  for (const embedDocument of ordered) {
    embedDocument.regions.forEach((region, regionIndex) => {
      if (!region.root) {
        return;
      }
      rules.push(
        ...collectRules(region, {
          embedKey: embedDocument.source.key,
          embedLabel: embedDocument.source.label,
          fromComponent: embedDocument.source.fromComponent,
          componentName: embedDocument.source.componentName,
          regionIndex,
          idSeed: embedDocument.source.key,
          order,
        }),
      );
    });
  }
  return rules;
}

// Selecting the <style> node a rule lives in; a stylesheet isn't in the tree,
// so there is nothing to navigate to.
export async function navigateToEmbed(
  source: EmbedSource,
  _pageInstances?: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (source.origin.kind === 'astro') {
    return {
      ok: false,
      error: `These styles live in ${source.label} — open that component to see them in the tree.`,
    };
  }
  if (source.origin.kind !== 'node') {
    return { ok: false, error: `${source.label} is a stylesheet — open it from the Assets panel.` };
  }
  const select = getHost().selectNode;
  if (!select) {
    return { ok: false, error: 'Nothing to select.' };
  }
  select(source.origin.nodeId);
  return { ok: true };
}

// ───────────────────────── Asking the rendered page ─────────────────────────

// State pseudo-classes describe a moment, not an element: `.card:hover` only
// matches while the pointer is there, but the panel is asking "does this rule
// target this element", which it does whether or not it's hovered right now.
// Stripped before asking, and the answer stored under the original text.
// Longest name first, and `(?![\w-])` rather than `\b` to close the trap that
// `-` is a non-word character: `:focus\b` happily matches inside
// `:focus-visible`, leaving the nonsense selector `a-visible`.
// The names are plain letters and hyphens, so they join into an alternation unescaped; the list
// order is the alternation order.
const STATE_PSEUDO_NAMES = [
  'focus-visible',
  'focus-within',
  'focus',
  'hover',
  'active',
  'visited',
  'target',
  'checked',
  'indeterminate',
  'default',
  'disabled',
  'enabled',
  'placeholder-shown',
  'autofill',
  'user-invalid',
  'user-valid',
  'read-only',
  'read-write',
  'open',
] as const;
const STATE_PSEUDO_RE = new RegExp(`:(?:${STATE_PSEUDO_NAMES.join('|')})(?![\\w-])`, 'g');
const PSEUDO_ELEMENT_NAMES = [
  'before',
  'after',
  'first-line',
  'first-letter',
  'selection',
  'placeholder',
  'marker',
  'backdrop',
  'file-selector-button',
] as const;
const PSEUDO_ELEMENT_RE = new RegExp(
  `::?(?:${PSEUDO_ELEMENT_NAMES.join('|')})(?![\\w-])|::(?:part|slotted)\\([^)]*\\)`,
  'g',
);

function askableForm(text: string): string | undefined {
  const bare = text.replace(PSEUDO_ELEMENT_RE, '').replace(STATE_PSEUDO_RE, '').trim();
  // What's left has to still be a selector: `:hover {}` on its own strips to
  // nothing, and `.a > :hover` to a dangling combinator.
  if (!bare || /[>+~]\s*$/.test(bare) || bare.startsWith('>')) {
    return undefined;
  }
  return bare;
}

/** The selectors worth asking the DOM about, mapped back to the rule texts
 *  that asked for them. */
function askableSelectors(rules: ParsedRule[]): Map<string, string[]> {
  // One entry per distinct selector, mapped back to every text that asked for
  // it — `.a:hover` and `.a` ask the same question of the DOM.
  const askedFor = new Map<string, string[]>();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      const ask = askableForm(selector.text);
      if (!ask) {
        continue;
      }
      const list = askedFor.get(ask);
      if (list) {
        list.push(selector.text);
      } else {
        askedFor.set(ask, [selector.text]);
      }
    }
  }
  return askedFor;
}

/** What the page said about one element: what it renders as, and which of the
 *  asked-for selectors target it. */
export type CanvasIdentity = {
  tag: string;
  id?: string | undefined;
  classes: string[];
  attributes: Record<string, string>;
};
/** One round trip's worth of answers. `unasked` means there was nothing to ask (no
 *  path for the node, or no canvas), which callers pass straight through so they
 *  don't ask again; an `asked` answer is undefined when the canvas didn't reply. */
export type CanvasAsk =
  | { readonly kind: 'unasked' }
  | {
      readonly kind: 'asked';
      readonly answer:
        | {
            readonly identity: CanvasIdentity | undefined;
            readonly matched: Readonly<Record<string, boolean>>;
          }
        | undefined;
      readonly askedFor: Map<string, string[]>;
    };

// The panel's identity of the element the canvas described. An element without
// an id carries no `id` key, as the page's own element does.
function canvasIdentityOf(identity: CanvasAnswer['identity']): CanvasIdentity | undefined {
  if (identity === undefined) {
    return undefined;
  }
  const { id, ...rest } = identity;
  return id === undefined ? rest : { ...rest, id };
}

// Only a yes or a no is an answer; a selector the engine refused (absent) falls
// back to the source matcher.
function matchedAnswers(matched: CanvasAnswer['matched']): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [selector, hit] of Object.entries(matched)) {
    if (typeof hit === 'boolean') {
      out[selector] = hit;
    }
  }
  return out;
}

/**
 * Ask the page everything the panel needs about the selected element, in ONE
 * round trip. Identity and selector matching used to be asked separately —
 * two questions about the same element at the same moment, each bounded by
 * its own 1.5s timeout, and the second couldn't start until the first came
 * back. The chips stayed blank for the sum of the two.
 *
 * Returns `unasked` when there's nothing to ask (no path for the node, or no
 * canvas), which callers pass straight through so they don't ask again.
 */
export async function askCanvasAbout(rootKey: string, rules: ParsedRule[]): Promise<CanvasAsk> {
  const path = getHost().pathOf?.(rootKey);
  if (!path || !hasCanvas()) {
    return { kind: 'unasked' };
  }
  const askedFor = askableSelectors(rules);
  const answer = await queryCanvas(path, [...askedFor.keys()]);
  return {
    kind: 'asked',
    answer:
      answer === undefined
        ? undefined
        : {
            identity: canvasIdentityOf(answer.identity),
            matched: matchedAnswers(answer.matched),
          },
    askedFor,
  };
}

/**
 * Fill `target.domMatched` from what the canvas said about these selectors.
 *
 * This is the whole point of the exercise: the rendered DOM knows what every
 * component renders, what every loop produced, and what classes a script or a
 * `class:list` expression put there — none of which the source tree can see.
 * Selectors the engine can't be asked about (or a canvas that doesn't answer)
 * are simply left out of the map, so they fall back to the source matcher.
 *
 * Pass `asked` (including `unasked`) to reuse an answer already in hand; omit it
 * and this asks on its own.
 */
export async function primeDomMatches(
  /** The match target to fill in place: the matcher reads it after this resolves. */
  target: MatchTarget,
  rules: ParsedRule[],
  asked?: CanvasAsk,
): Promise<void> {
  const ask = asked ?? (await askCanvasAbout(target.rootKey, rules));
  if (ask.kind === 'unasked') {
    return;
  }
  if (!ask.answer) {
    return;
  }
  const matched = new Map<string, boolean>();
  for (const [text, hit] of matchedTexts(ask)) {
    matched.set(text, hit);
  }
  // The target's identity is the cache key (EmbedEditor's primedRef compares it),
  // so its match cache is filled in place rather than copied.
  // eslint-disable-next-line no-param-reassign -- fills the matcher's cache slot by design
  target.domMatched = matched;
}

function* matchedTexts(ask: Extract<CanvasAsk, { kind: 'asked' }>): Generator<[string, boolean]> {
  for (const [selector, texts] of ask.askedFor) {
    const hit = ask.answer?.matched[selector];
    if (typeof hit !== 'boolean') {
      continue;
    } // the engine refused it — fall back
    for (const text of texts) {
      yield [text, hit];
    }
  }
}

// ───────────────────────────── Match target ─────────────────────────────

export async function resolveTarget(
  selected: AnyElement,
  scan: EmbedScan,
  /** An answer already in hand (see askCanvasAbout) — including `unasked`, which
   *  means "there was nothing to ask". Omit it and this asks the page itself. */
  asked?: CanvasAsk,
): Promise<{ target: MatchTarget; rootSnapshot: ElementSnapshot }> {
  const rootKey = serializeElementId(selected);
  const snapshots = new Map<string, ElementSnapshot | undefined>();
  const view: TreeView = {
    // The whole page model is in hand, so ancestors are never unknown.
    truncated: false,
    parentKey: (key) => scan.parentByKey.get(key),
    childKeys: (key) => scan.childrenByKey.get(key) ?? [],
    elementChildKeys: (key) => {
      const kids = scan.childrenByKey.get(key) ?? [];
      const nodes = kids.map((childKey) => scan.elementByKey.get(childKey));
      // A loop or a bare expression renders any number of elements (including
      // none), so positions around one can't be pinned down — say "unknown"
      // rather than count it as a single sibling.
      if (nodes.some((node) => node && OPAQUE_COUNT_KINDS.has(node.kind))) {
        return undefined;
      }
      return kids.filter((_, i) => ELEMENT_KINDS.has(nodes[i]?.kind ?? ''));
    },
    snapshot: async (key) => {
      if (snapshots.has(key)) {
        return snapshots.get(key);
      }
      const element = scan.elementByKey.get(key);
      const snap = element ? await buildSnapshot(element) : undefined;
      snapshots.set(key, snap);
      return snap;
    },
  };
  const target: MatchTarget = { rootKey, view };
  let rootSnapshot = await buildSnapshot(selected);
  // What the selected node actually renders as. A component instance has no
  // tag or classes of its own — `<Section>` says nothing about the
  // `<section class="section">` it produces — so the header, the chips, and
  // every selector composed from them were describing the call site rather
  // than the element on the page. The canvas knows the difference.
  let identity = asked?.kind === 'asked' ? asked.answer?.identity : undefined;
  if (asked === undefined) {
    const path = getHost().pathOf?.(rootKey);
    if (path && hasCanvas()) {
      identity = canvasIdentityOf((await queryCanvas(path, []))?.identity);
    }
  }
  if (identity) {
    const attributes = { ...identity.attributes };
    delete attributes['class'];
    if (identity.classes.length) {
      attributes['class'] = identity.classes.join(' ');
    }
    rootSnapshot = {
      ...rootSnapshot,
      tag: identity.tag,
      id: identity.id ?? rootSnapshot.id,
      classes: identity.classes,
      classList: identity.classes,
      attributes,
    };
  }
  // What the header shows is also what the MATCHER should match against. The
  // view builds its snapshots from the source tree, where a component instance
  // or a layout has no tag of its own — and the matcher rejects a type selector
  // (and `:root`) it cannot verify. So `html { … }` and `:root { … }` silently
  // failed to target the very element the panel was calling `html.theme-dark`,
  // while the class and attribute selectors beside them matched. Seed the cache
  // with the resolved snapshot so the selected element is matched as rendered.
  snapshots.set(rootKey, rootSnapshot);
  return { target, rootSnapshot };
}

// ───────────────────────────── Breakpoints ─────────────────────────────

// The canvas has three widths; they map onto the scale the panel already
// speaks so its breakpoint controls need no changes.
export async function getCurrentBreakpoint(): Promise<BreakpointId> {
  const device = getHost().device;
  if (device === 'tablet') {
    return 'medium';
  }
  if (device === 'phone') {
    return 'small';
  }
  return 'main';
}

// ───────────────────────── Native styles: not applicable ─────────────────────
//
// Webflow's class styles are a second styling system alongside CSS. Here there
// is only CSS, so the panel is told there are none — every value it shows and
// writes comes from a stylesheet or a <style> block.

// Whether a second, non-CSS styling system exists to write into. In the
// Designer that is Webflow's class styles; here there is none, so every
// property must be authored as CSS. The panel consults this before routing an
// edit away from the stylesheet.
export function nativeStylingAvailable(): boolean {
  return false;
}

const EMPTY_NATIVE: NativeModel = { styles: [], read: false };

export type NativeWriteTarget = { namePath: string[]; index: number | undefined };

export async function readNativeStyles(
  _element: AnyElement,
  _states: readonly StateKey[],
  onPhase?: (model: NativeModel) => void,
): Promise<NativeModel> {
  onPhase?.(EMPTY_NATIVE);
  return EMPTY_NATIVE;
}

export async function readNativeStyleByName(
  _className: string,
  _states: readonly StateKey[],
): Promise<NativeModel> {
  return EMPTY_NATIVE;
}

const NO_NATIVE: {
  readonly ok: false;
  readonly applied: false;
  readonly error: string;
} = {
  ok: false,
  applied: false,
  error: 'This project styles with CSS — write to a stylesheet.',
};

export async function applyNativePropertyAt(
  _element: AnyElement,
  _target: NativeWriteTarget,
  _prop: string,
  _value: string,
  _options?: NativeStyleOptions,
): Promise<typeof NO_NATIVE> {
  return NO_NATIVE;
}

export async function removeNativePropertyAt(
  _element: AnyElement,
  _target: NativeWriteTarget,
  _props: readonly string[],
  _options?: NativeStyleOptions,
): Promise<typeof NO_NATIVE> {
  return NO_NATIVE;
}

export async function applyNativeToNewBaseClass(
  _element: AnyElement,
  _className: string,
  _prop: string,
  _value: string,
  _options?: NativeStyleOptions,
): Promise<typeof NO_NATIVE> {
  return NO_NATIVE;
}

export async function liveSetNativeProperty(
  _handle: unknown,
  _prop: string,
  _value: string,
  _options?: NativeStyleOptions,
): Promise<typeof NO_NATIVE> {
  return NO_NATIVE;
}

// ───────────────────────── Variables, fonts, assets ─────────────────────────

export type ProjectVariable = {
  collection: string;
  group: string;
  name: string;
  value: string;
  binding: string;
  type: string;
};

// The panel filters the picker by variable type, and it speaks Webflow's
// vocabulary — notably 'Color' and 'FontFamily', which it treats specially
// (a colour field offers only Color variables, font-family only FontFamily).
// A custom property has no declared type, so infer one; CSS.supports is the
// accurate test, with a regex fallback for non-DOM contexts.
const supports = (prop: string, value: string): boolean => {
  try {
    return typeof CSS !== 'undefined' && CSS.supports(prop, value);
  } catch {
    return false;
  }
};

// The CSS-wide keywords are valid for EVERY property, so CSS.supports() types them as
// whatever it's asked about first (Color). They're keywords — treat them as such.
const CSS_WIDE_RE = /^(inherit|initial|unset|revert|revert-layer)$/i;

const varKind = (name: string, value: string): string => {
  const trimmed = value.trim();
  if (CSS_WIDE_RE.test(trimmed)) {
    return 'String';
  }
  // A value that still carries a var() reference (an alias into CSS we never read, or a
  // fallback chain) is untyped as far as CSS.supports() goes: an unresolved reference
  // parses as valid for EVERY property, so `--h6-font-family: var(--primary-family)`
  // came back as a Color — and then the font field's picker, which shows only
  // FontFamily, had nothing to show. Ask CSS.supports only about resolved values and
  // leave the rest to the literal-syntax regexes, which need real syntax to match.
  const unresolved = /var\(/i.test(trimmed);
  if (
    (!unresolved && supports('color', trimmed)) ||
    /^#|^rgba?\(|^hsla?\(|^color(-mix)?\(/i.test(trimmed)
  ) {
    return 'Color';
  }
  // Fluid sizing — `clamp(var(--space-5-min) / 16 * 1rem, …)` — keeps var() references
  // inside it that we can't resolve, but math functions only ever produce a length or a
  // number, so the wrapper alone is enough to call it a Size.
  if (/^(calc|clamp|min|max)\(/i.test(trimmed)) {
    return 'Size';
  }
  if (
    (!unresolved && supports('width', trimmed)) ||
    /^-?[\d.]+(px|rem|em|%|vw|vh|vmin|vmax|ch|ex|pt|cm|mm|in)$/i.test(trimmed)
  ) {
    return 'Size';
  }
  if (/^-?[\d.]+$/.test(trimmed)) {
    return 'Number';
  }
  // Nothing in the value to go on — a font stack has no distinguishing syntax, so the
  // last hint is the name it was given.
  if (/font-?family/i.test(name)) {
    return 'FontFamily';
  }
  return 'String';
};

// Follow a variable that is nothing but a reference to another one
// (`--h6-letter-spacing: var(--letter-spacing-tight)`) to the literal value at the end
// of the chain, so varKind has real syntax to read. Falls back to the var()'s own
// fallback, then gives up and returns what it was handed.
const ALIAS_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([\s\S]*))?\)$/;
// Hops followed before giving up: a chain this long is a cycle, not a design.
const ALIAS_LIMITS = { depthMax: 8 } as const;
function resolveAlias(value: string, values: Map<string, string>, depth = 0): string {
  const trimmed = value.trim();
  if (depth > ALIAS_LIMITS.depthMax) {
    return trimmed;
  }
  const match = ALIAS_RE.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const target = values.get((match[1] ?? '').slice(2));
  if (target !== undefined) {
    return resolveAlias(target, values, depth + 1);
  }
  const fallback = match[2]?.trim();
  return fallback ? resolveAlias(fallback, values, depth + 1) : trimmed;
}

// Custom properties declared anywhere in the project's CSS. The rule they sit
// in is the closest thing to Webflow's collection, so it groups them.
async function readAllProjectCss(): Promise<Array<{ label: string; css: string }>> {
  const host = getHost();
  const out: Array<{ label: string; css: string }> = [];
  // Ask for the stylesheet list rather than trusting host.files: the variable
  // scan is kicked off once and its result is cached for the session, so if it
  // happened to run before the async file list arrived it would cache "no
  // variables" forever.
  let files = host.files;
  if (!files.length && host.projectPath) {
    try {
      const result = await readStyleFiles(host.projectPath);
      files = result.ok ? [...result.value] : [];
    } catch {
      files = [];
    }
  }
  // All at once. These were read one after another, which on a project with a
  // dozen stylesheets is a dozen round trips end to end — and this runs while the
  // panel is doing its own cold scan, so the two were queueing behind each other.
  // Promise.all keeps the order, so the cascade still reads as it does on disk.
  const read = await Promise.all(
    files.map(async (file) => {
      try {
        const result = await variableEdit('readStyleFile', file.path);
        return { label: file.rel, css: result.ok ? (result.css ?? '') : '' };
      } catch {
        return undefined; // unreadable — skip it rather than fail the whole scan
      }
    }),
  );
  for (const entry of read) {
    if (entry) {
      out.push(entry);
    }
  }
  // Variables are just as often declared in a component's global block as in a
  // stylesheet, so the picker has to read those too.
  let astro = host.astroFiles;
  if (!astro.length && host.projectPath) {
    try {
      const result = await readAstroStyleFiles(host.projectPath);
      astro = result.ok ? [...result.value] : [];
    } catch {
      astro = [];
    }
  }
  const readAstro = await Promise.all(
    astro.map(async (file) => {
      try {
        const result = await variableEdit('readStyleFile', file.path);
        return { name: file.name, css: result.ok ? (result.css ?? '') : '' };
      } catch {
        return undefined; // unreadable — skip it rather than fail the whole scan
      }
    }),
  );
  for (const entry of readAstro) {
    if (!entry) {
      continue;
    }
    for (const region of splitEmbed(entry.css).regions) {
      if (isGlobalRegion(region)) {
        out.push({ label: entry.name, css: region.css });
      }
    }
  }
  walkNodes(host.nodes, (node) => {
    if (node.kind === 'raw' && node.name === 'style') {
      out.push({ label: '<style>', css: String(node.inner ?? '') });
    }
  });
  return out;
}

// The panel kicks the variable scan off once and caches the result for the
// session, so an early call that found nothing would leave the picker empty
// for good. Wait for the host to actually have a project before scanning.
function whenProjectReady(timeoutMs = 4000): Promise<void> {
  if (getHost().projectPath) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = onHostChange(() => {
      if (getHost().projectPath) {
        done();
      }
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

export async function streamProjectVariables(
  onAdd: (v: ProjectVariable) => void,
  isCancelled: () => boolean = () => false,
): Promise<ProjectVariable[]> {
  await whenProjectReady();
  const all: ProjectVariable[] = [];
  const seen = new Set<string>();
  // Parse everything up front and index every custom property by name: a variable's type
  // often lives in the variable it aliases (`--h6-font-family: var(--font-display)`),
  // which may be declared in a file we haven't reached yet, so the whole map has to exist
  // before the first type is inferred.
  const parsed: Array<{ label: string; root: ReturnType<typeof postcss.parse> }> = [];
  const values = new Map<string, string>();
  for (const { label, css } of await readAllProjectCss()) {
    if (isCancelled()) {
      break;
    }
    let root;
    try {
      root = postcss.parse(css);
    } catch {
      continue;
    }
    parsed.push({ label, root });
    root.walkDecls((decl) => {
      const key = decl.prop.startsWith('--') ? decl.prop.slice(2) : undefined;
      if (key && !values.has(key)) {
        values.set(key, decl.value.trim());
      }
    });
  }
  for (const { label, root } of parsed) {
    if (isCancelled()) {
      break;
    }
    root.walkDecls((decl) => {
      if (!decl.prop.startsWith('--')) {
        return;
      }
      const name = decl.prop.slice(2);
      if (seen.has(name)) {
        return;
      }
      seen.add(name);
      const variable: ProjectVariable = {
        collection: label,
        group: ruleSelectorOf(decl.parent) || ':root',
        name,
        value: decl.value.trim(),
        binding: `var(${decl.prop})`,
        type: varKind(name, resolveAlias(decl.value, values)),
      };
      all.push(variable);
      onAdd(variable);
    });
  }
  return all;
}

export async function getProjectFontFamilies(): Promise<string[]> {
  await whenProjectReady();
  const families = new Set<string>();
  for (const { css } of await readAllProjectCss()) {
    let root;
    try {
      root = postcss.parse(css);
    } catch {
      continue;
    }
    root.walkDecls(/^font-family$/i, (decl) => {
      for (const part of decl.value.split(',')) {
        const name = part.trim().replace(/^['"]|['"]$/g, '');
        if (name && !name.startsWith('var(')) {
          families.add(name);
        }
      }
    });
    root.walkAtRules(/^font-face$/i, (rule) => {
      rule.walkDecls(/^font-family$/i, (decl) => {
        const name = decl.value.trim().replace(/^['"]|['"]$/g, '');
        if (name) {
          families.add(name);
        }
      });
    });
  }
  return [...families].sort((left, right) => left.localeCompare(right));
}

export type ImageAsset = { id: string; name: string; url: string };

export async function getImageAssets(): Promise<ImageAsset[]> {
  const host = getHost();
  if (!host.projectPath) {
    return [];
  }
  try {
    const result = await listAssetEntries(host.projectPath);
    if (!result.ok) {
      return [];
    }
    return result.value
      .filter((entry) => !entry.isDir && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(entry.name))
      .map((entry) => ({ id: entry.rel, name: entry.name, url: `/${entry.rel}` }));
  } catch {
    return [];
  }
}

// ───────────────────────────── Pure helpers ─────────────────────────────

function isFlexNumber(token: string): boolean {
  return /^-?(\d+\.?\d*|\.\d+)$/.test(token);
}

export function parseFlexShorthand(value: string): Record<string, string> | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none') {
    return { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' };
  }
  if (normalized === 'auto') {
    return { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': 'auto' };
  }
  if (normalized === 'initial') {
    return { 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto' };
  }
  if (normalized === '' || /^(inherit|unset|revert|revert-layer)$/.test(normalized)) {
    return undefined;
  }
  if (/[a-z-]+\(/i.test(normalized)) {
    return undefined;
  }
  const tokens = normalized.split(/\s+/);
  if (tokens.length > 3) {
    return undefined;
  }
  let grow: string, shrink: string, basis: string;
  if (tokens.length === 1) {
    const first = tokens[0] ?? '';
    if (isFlexNumber(first)) {
      grow = first;
      shrink = '1';
      basis = '0';
    } else {
      grow = '1';
      shrink = '1';
      basis = first;
    }
  } else if (tokens.length === 2) {
    grow = tokens[0] ?? '';
    const second = tokens[1] ?? '';
    if (isFlexNumber(second)) {
      shrink = second;
      basis = '0';
    } else {
      shrink = '1';
      basis = second;
    }
  } else {
    grow = tokens[0] ?? '';
    shrink = tokens[1] ?? '';
    basis = tokens[2] ?? '';
  }
  if (!isFlexNumber(grow) || !isFlexNumber(shrink)) {
    return undefined;
  }
  return { 'flex-grow': grow, 'flex-shrink': shrink, 'flex-basis': basis };
}

export type { NativeStyle };
