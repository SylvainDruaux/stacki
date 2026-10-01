import { usePropertySaveGuard } from './usePropertySaveGuard';
import ComponentPropertiesPanel from './panels/ComponentPropertiesPanel';
import { revertComponentProperties } from './componentPropertiesBridge';
import type { ClassOutcome } from './style-panel/lib/host';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import type { Attr, ImportDecl, PageModel, PageNode, PairedNode } from '../shared/page-node';
import type { ScanComponent, ScanPage, ScanResult } from '../shared/scan';
import type { WireCommitInfo, WireInjectedRoute } from '../shared/ipc-results';
import WelcomeScreen from './features/welcome/WelcomeScreen';
import PagesPanel from './panels/PagesPanel';
import PalettePanel from './panels/PalettePanel';
import StructurePanel from './panels/StructurePanel';
import {
  findWithParent,
  isInlineRun,
  noteIndexAbove,
  noteText,
  noteValue,
  selectionAfterDelete,
} from './editor/treeSelection';
import { canvasClickAction } from './editor/canvasClick';
import {
  isFragmentNode,
  liveClassesById as classesByNodeId,
  rendersOwnElement,
} from './editor/liveClasses';
import { setSoundEnabled } from './ui/sound';
import { createPreviewWatch } from './previewRecovery';
import { tellCanvas } from './editor/canvasQuery';
import {
  parsePageSource as parseSourcePage,
  readPage,
  readSymbol,
  scanProject,
} from './ipc/bridge';
import { checkoutGitBranch, readGitInfo } from './features/git/gitChipBridge';
import { LIMITS } from '../shared/limits';
import { assert } from '../shared/assert';
import PreviewPane from './panels/PreviewPane';
import GitChip from './features/git/GitChip';
import HistoryPanel, { relativeTime } from './panels/HistoryPanel';
import { ConfirmHost, confirmDialog } from './ui/ConfirmDialog';
import { mergeBranchAction, deleteBranchAction } from './features/git/gitActions';
import LeftRail from './ui/LeftRail';
import { lazyPanel } from './ui/lazyPanel';
import PageSwitcher from './ui/PageSwitcher';
import DynamicPicker from './ui/DynamicPicker';
import {
  ASTRO_ASSETS,
  ASTRO_ASSETS_MODULE,
  PLACEHOLDER_PROPS,
  astroAsset as astroAssetDef,
} from './astroAssets';
import InsertSearch from './ui/InsertSearch';
import AssetsPanel from './panels/AssetsPanel';
import { getElementSchema, GLOBAL_ATTRS, HTML_TAGS, VOID_TAGS } from './editor/elementSchemas';
import { insertTargetFor as placeInsert } from './editor/insertTarget';
import { isInlineOnly } from './ui/RichContent';
import { onAssetRequest, clearAssetRequest } from './ui/assetPick';
import { isDataBound } from './editor/bindings';
import { thenBranch } from './editor/branches';
import { keepsSlot as keepsSlotAttribute } from './editor/slotAttr';
import {
  createFileSaver,
  createPageSaver,
  scanContainsFile,
  type PageSaver,
} from './editor/pagePersistence';
import { createEntrySender, previewGestures } from './editor/pageSender';
import { createCoalescedRun } from './lib/coalescedRun';
import { carryHandles, seedOf } from './editor/nodeHandles';
import {
  EditDrafts,
  nodeRefIn,
  type AppliedEdit,
  type PageOrigin,
  type EditGesture,
  type EditsRecord,
  type QueueEntry,
} from './editor/pageEdits';
import { describeRejection, type RejectionReason } from '../shared/intent';
import {
  type InsertPlace,
  attributeRenameGesture,
  duplicateGesture,
  frontmatterGesture,
  inlineStyleGesture,
  insertGesture,
  loopRenameGesture,
  moveGesture,
  nodeGesture,
  propsGesture,
  removalGesture,
  sequence,
  tagRenameGesture,
  unwrapGesture,
  withChildren,
  wrapGesture,
} from './editor/editGestures';
import {
  saveStateAccepted,
  saveStateBase,
  saveStateEdited,
  saveStateRefused,
} from './editor/saveState';
import SaveConflictNotice from './panels/SaveConflictNotice';
import CapabilityNotice from './panels/CapabilityNotice';
import { nodeCapability } from './editor/nodeCapability';
import type { PageEdited } from '../shared/page-save';
import type { Digest, NodeId } from '../shared/brand';
import { ancestorChain, createTreeIndex, nodeAtPath, pathOfNode } from './editor/editorTree';
import { readFrontmatter, writeFrontmatter } from '../electron/frontmatter';
import {
  renamedLoopVar,
  parseLoopHead,
  disconnectedLoops,
  loopVarsAt,
  strippedBindings,
} from './editor/loopBindings';
import {
  namesUsedIn,
  neededFrontmatter,
  unusedDeclarations,
  withStatements,
  withoutDeclarations,
} from './editor/frontmatterMove';
import { hasClass, namesIn, withClass } from './editor/classAttr';
import { toComponentName } from './componentName';
import { resolveInstanceProps } from './editor/instanceProps';
import { propsForExtraction } from './editor/extractProps';
import TerminalDock from './features/terminal/TerminalDock';
import { cleanError, stripAnsi } from './lib/cleanError';
import { elementLabel } from './editor/classNames';
import {
  autoQueryName,
  collectionsInScope,
  findImportOf,
  markedQueries,
  namesInScope,
  queriesInScope,
  QUERY_MARK,
  referencesInScope,
  removeMarkedQuery,
} from './editor/dataSuggest';
import {
  PreviewIcon,
  RefreshIcon,
  ExternalIcon,
  ChevronLeftIcon,
  ElementComponentIcon,
  TerminalIcon,
} from './ui/Icons';
import type { PickedAsset } from './ui/AssetField';
import type { HistoryCommit, HistoryCommitFile, HistoryFile } from './historyBridge';
import type { InlineNode } from './ui/RichContent';
import type { Rename, TagOption } from './panels/propNodeEditors';
import type { FieldDefinition, PropValues } from './panels/propRules';
import type { OverlayInfo } from './panels/PreviewOverlays';
import type { PreviewCrumb } from './panels/PreviewToolbar';
import type { AstroAsset } from './astroAssets';
import type { ComponentCreationSource } from './panels/PaletteDialogs';
import type { DevDiagnosis } from './panels/DevOffline';
import type { PreviewDevice } from './panels/PreviewToolbar';
import type { SpacingHover } from './panels/PreviewOverlays';
import type { VariableSelection } from './variablesBridge';
import type { InsertTarget } from './editor/insertTarget';
import type { InsertItem } from './ui/InsertSearch';
import { toRecord } from '../shared/record';
import { projectRelativePath } from './lib/projectPath';
import { currentDesktopPlatform, shortcutLabel } from './lib/shortcutLabel';
import { sourceNodeAtOffset } from './codePanelModel';
import {
  codeWindowFor,
  FRONTMATTER_SUBJECT,
  type CodeSubject,
  type CodeWindowState,
  type FrontmatterSubject,
} from './codeWindowTarget';
import {
  type AppHistory,
  type AssetPick,
  type CollectionSamples,
  type DevStatus,
  type DynamicEntry,
  type EditsEntry,
  type HistoryEntry,
  type GitInfo,
  type InjectedRoute,
  type ItemIndexes,
  type LeftTab,
  type NodeStates,
  type NodeClipboard,
  type PreviewCommitInfo,
  type ProjectIdentity,
  type RightTab,
  type RightTabIndicator,
  type ProjectScans,
  type ToastKind,
  type ToastMessage,
  type UndoCommand,
} from './appTypes';
import {
  findEditorNodeById as findNodeById,
  findEditorParentList as findParentList,
  toEditorPageState,
  carriedParse,
  type CurrentPage,
  type EditablePageState,
  type EditorPageState,
  type OpenFile,
  type PageStateSnapshot,
  type TrailingSlash,
  isOpenFile,
} from './editor/pageState';
import { nodeId, type EditorModel, type EditorNode } from './editor/pageView';
import {
  addRecentProject,
  closeProject,
  copyEditorSelection,
  diagnoseProject,
  createProjectPage,
  createProjectPageFolder,
  createProjectComponent,
  deleteProjectPage,
  deleteProjectPageFolder,
  findImportPath,
  installProjectDependencies,
  moveProjectPage,
  onAppProgress,
  onCmsInventoryChanged,
  onDevExit,
  onDevLog,
  onFilesChanged,
  onPageMaybeChanged,
  onSoundSettingChanged,
  openExternalURL,
  openProject,
  pendingProject,
  previewProjectCommit,
  probeProjectPreview,
  projectHasNodeModules,
  readProjectClasses,
  readContentCollections,
  readDynamicPaths,
  readInjectedRoutes,
  readProjectAsset,
  readSampleEntry,
  readComponentUsage,
  readAppSettings,
  rebaseProjectImport,
  renameProjectPageFolder,
  resolveProjectImport,
  restoreProjectFile,
  restoreProjectVersion,
  runNativeEdit,
  startProjectPreview,
  stopProjectCommitPreview,
  watchProject,
  writeProjectFile,
  previewProjectPageEdit,
  editProjectPage,
  checkPreviewRender,
  type AppCollection,
  type ImportPaths,
} from './ipc/appBridge';
import { judgeCanvasEvent, type CheckRender, type ShownFile } from './previewGate';
import { describePreviewStale, type PreviewVerdict } from '../shared/preview-token';
import type { JudgeCanvasEvent } from './panels/previewRuntime';
import {
  describePreviewReload,
  parseShortcutMessage,
  type PreviewReloadReason,
} from './previewMessages';

// Each optional editor owns its loading boundary so opening it keeps the
// canvas and neighboring panels visible and interactive.
const PropsPanel = lazyPanel(() => import('./panels/PropsPanel'));
const StylePanel = lazyPanel(() => import('./panels/StylePanel'));
const CodeWindow = lazyPanel(() => import('./ui/CodeWindow'));
const CmsPanel = lazyPanel(() => import('./panels/CmsPanel'));
const CmsView = lazyPanel(() => import('./panels/CmsView'));
const ContentView = lazyPanel(() => import('./panels/ContentView'));
const VariablesPanel = lazyPanel(() => import('./panels/VariablesPanel'));
const VariablesView = lazyPanel(() => import('./panels/VariablesView'));
const CodePanel = lazyPanel(() => import('./panels/CodePanel'));

// A node a gesture creates has no parse yet to name it: its handle is random,
// unique without a counter, and carried onto the reply that first contains it
// (src/editor/nodeHandles.ts). It never reaches main.
const newId = () => nodeId(`g${crypto.randomUUID().replace(/-/g, '')}`);

// A copy of `node` in which it and every node below it take fresh ids: a
// pasted or duplicated node is a new node, and must never answer to the
// handle of the one it was copied from.
function withNewIds(node: EditorNode, depth = 0): EditorNode {
  // A copied node came from a parse, which caps nesting.
  assert(depth <= LIMITS.treeDepthMax, `withNewIds: depth ${depth} exceeds the tree cap`);
  const id = newId();
  assert(id !== node.id, 'A copy never keeps the handle it was copied from');
  const children = node.children;
  if (children === undefined) {
    return { ...node, id };
  }
  // Object.assign keeps the node's own variant, where a spread would widen it.
  const copies = children.map((child) => withNewIds(child, depth + 1));
  return Object.assign({}, node, { id, children: copies });
}

// Inline nodes from the rich Content field, which arrive without ids: each takes
// a fresh one, and an element keeps only the attributes that have a value.
function inlineWithIds(list: readonly InlineNode[], depth: number): EditorNode[] {
  // Inline content is nested markup of a parsed page, bounded like any tree.
  assert(depth <= LIMITS.treeDepthMax, 'inlineWithIds: depth exceeds the tree cap');
  return list.map((node): EditorNode => {
    if (node.kind === 'text' || node.kind === 'expr') {
      return { ...node, id: newId() };
    }
    const props = Object.fromEntries(
      Object.entries(node.props ?? {}).filter(
        (entry): entry is [string, Attr] => entry[1] !== undefined,
      ),
    );
    return {
      id: newId(),
      kind: 'element',
      name: node.name,
      props,
      children: node.children === undefined ? undefined : inlineWithIds(node.children, depth + 1),
    };
  });
}

// Placeholder copy for newly inserted text elements, so they're visible on the
// canvas straight away instead of collapsing to a zero-height box.
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius ' +
  'enim in eros elementum tristique. Duis cursus, mi quis viverra ornare, eros ' +
  'dolor interdum nulla, ut commodo diam libero vitae erat. Aenean faucibus nibh ' +
  'et justo cursus id rutrum lorem imperdiet. Nunc ut sem vitae risus tristique ' +
  'posuere.';
const DEFAULT_TEXT = {
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  p: LOREM,
};

function defaultText(tag: string): string | undefined {
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'p':
      return DEFAULT_TEXT[tag];
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tree helpers (model.nodes is a tree of {id, kind, name?, props?, children?})
// ---------------------------------------------------------------------------

// Whether a subtree reads anything from the file it currently sits in — an
// expression, a conditional, a loop, or a prop written as code. Moved into a
// component, those names aren't in scope any more: `{title}` in a page reads
// the page's `title`, and in Card.astro it reads nothing at all. Not something
// to refuse over (the fix is a prop, and only the author knows its name) but
// very much something to say out loud.
function usesPageScope(node: PageNode | undefined): boolean {
  if (!node) {
    return false;
  }
  if (['expr', 'cond', 'map', 'branch'].includes(node.kind)) {
    return true;
  }
  const props = 'props' in node ? node.props : undefined;
  for (const value of Object.values(props || {})) {
    if (value && value.type === 'expr') {
      return true;
    }
  }
  const children = 'children' in node ? node.children : undefined;
  return (children || []).some(usesPageScope);
}

// Loops and conditionals render their children straight through, so a `slot`
// under one is still read by whatever component sits above it.
const SLOT_TRANSPARENT = new Set(['map', 'cond', 'branch', 'chunk-group']);

// The component (or layout) whose slots a node's `slot` attribute names,
// looking past those pass-through wrappers. Null when the node lands in a
// plain element or at the page root — nothing there reads a slot name.
function slotHostOf(model: Pick<PageModel, 'nodes'>, id: string): PairedNode | undefined {
  const parents = (ancestorChain(model.nodes, id) || []).slice(0, -1);
  const node = parents.reverse().find((parent) => !SLOT_TRANSPARENT.has(parent.kind));
  return node?.kind === 'component' ? node : undefined;
}

// What we know about a placed component, which may be imported under a local
// name of its own (`import Layout from '../layouts/BaseLayout.astro'`) — so
// fall back to the file the import points at. Null means "no definition
// scanned", which is never the same answer as "has no slots".
function definitionOf(
  model: Pick<PageModel, 'imports'>,
  node: Pick<PairedNode, 'name'>,
  insertables: readonly ScanComponent[],
): ScanComponent | undefined {
  const byName = insertables.find((component) => component.name === node.name);
  if (byName) {
    return byName;
  }
  const imp = (model.imports || []).find((i) => i.name === node.name);
  const base = imp?.path
    .split('/')
    .pop()
    ?.replace(/\.astro$/i, '');
  return (base && insertables.find((component) => component.name === base)) || undefined;
}

// First element with this tag, depth-first. Used to land the selection on a
// layout's <body> when it is opened: the html/head wrapper above it is not
// what anyone came to edit, and <body> is the page's real root.
function findElementByTag(
  nodes: readonly PageNode[] | undefined,
  tag: string,
  depth = 0,
): PairedNode | undefined {
  // A parsed tree is bounded by the page-tree depth cap.
  assert(depth <= LIMITS.treeDepthMax, 'findElementByTag: depth exceeds the tree cap');
  for (const node of nodes || []) {
    if (node.kind === 'element' && String(node.name).toLowerCase() === tag) {
      return node;
    }
    if ('children' in node && Array.isArray(node.children)) {
      const found = findElementByTag(node.children, tag, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

// Start a component on its rendered markup, looking through control flow and
// fragments because those wrappers have no element to style. Layouts keep
// their <body> selection; files without rendered markup still get a fallback.
function openingSelection(nodes: readonly PageNode[] | undefined): PageNode | undefined {
  const list = Array.isArray(nodes) ? nodes : [];
  const firstRendered = (
    children: readonly PageNode[] | undefined,
    depth: number,
  ): PageNode | undefined => {
    assert(depth <= LIMITS.treeDepthMax, 'openingSelection: depth exceeds the tree cap');
    for (const node of children || []) {
      const markup = node.kind === 'element' || node.kind === 'component';
      if (SLOT_TRANSPARENT.has(node.kind) || (markup && ['Fragment', 'slot'].includes(node.name))) {
        const child = firstRendered('children' in node ? node.children : undefined, depth + 1);
        if (child) {
          return child;
        }
      } else if (
        markup &&
        !['head', 'script', 'style', 'link', 'meta', 'title', 'base', 'template'].includes(
          node.name,
        )
      ) {
        return node;
      }
    }
    return undefined;
  };
  return findElementByTag(list, 'body') || firstRendered(list, 0) || outermostNode(list);
}

// The outermost thing a page renders: its layout wrapper when it has one,
// otherwise the first real node. A doctype line, a leading comment or stray
// whitespace isn't what the page is about, so those are skipped — but any
// node beats selecting nothing.
function outermostNode(nodes: readonly PageNode[] | undefined): PageNode | undefined {
  const list: readonly PageNode[] = nodes ?? [];
  return (
    list.find((node) => node.kind === 'element' || node.kind === 'component') ||
    list[0] ||
    undefined
  );
}

interface OpenFileOptions {
  readonly nextStack: SetStateAction<readonly OpenFile[]>;
  readonly selectionPath: string | undefined;
}

// Returning from a component should land on the instance that opened it. The
// path is stored with the child stack entry because node ids can change when
// the parent file is parsed again during the return trip.
function openFileSelection(
  entry: OpenFile,
  result: EditorPageState,
  selectionPath: string | undefined,
): PageNode | undefined {
  if (!result.editable) {
    return undefined;
  }
  if (selectionPath) {
    const localPath = selectionPath.split('|').at(-1);
    assert(localPath !== undefined, 'A stored component path must have a local path');
    const selected = nodeAtPath(result.model.nodes, localPath.split('.').map(Number));
    if (selected) {
      return selected;
    }
  }
  return entry.kind === 'component'
    ? openingSelection(result.model.nodes)
    : outermostNode(result.model.nodes);
}

function collectUsedNames(model: PageModel): Set<string> {
  const used = new Set<string>();
  const walk = (list: readonly PageNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'collectUsedNames: depth exceeds the tree cap');
    for (const node of list) {
      if ('name' in node && node.name) {
        used.add(node.name);
      }
      if ('children' in node && Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(model.nodes, 0);
  return used;
}

// Comments in the frontmatter are prose about the page, and prose names the
// things the page is built from — `// Hero copy` is talk about <Hero>, not a
// use of it. Only whole-line `//` comments go: a trailing one can't be told
// from the `//` inside a URL without really parsing, and cutting a string in
// half there would hide a reference that is real.
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// Everything in the file that is code rather than markup: the frontmatter, a
// loop's head, a condition's test, an expression node, and any prop whose
// value is an expression. An imported name can be used in any of them without
// ever appearing as a tag.
//
// <style> and <script> bodies are pointedly not code for this purpose. Both
// are their own scope in Astro — CSS never sees a frontmatter binding, and a
// <script> is a separate module — so a name inside one is a coincidence, not
// a use. Reading them meant a `.Hero` class or a `/* Hero */` note pinned
// <Hero>'s import in place for good. What those blocks genuinely share comes
// in through `define:vars`, which is a prop expression and is still read.
function codeText(model: PageModel): string {
  const parts = [stripComments(model.extraFrontmatter || '')];
  const walk = (list: readonly PageNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'codeText: depth exceeds the tree cap');
    for (const node of list) {
      if (node.kind === 'expr' || node.kind === 'raw-line') {
        parts.push(node.value || '');
      }
      if (node.kind === 'map') {
        parts.push(node.head || '');
      }
      if (node.kind === 'cond') {
        parts.push(node.test || '');
      }
      const props = 'props' in node ? node.props : undefined;
      for (const value of Object.values(props || {})) {
        if (value && (value.type === 'expr' || value.type === 'spread')) {
          parts.push(String(value.value ?? ''));
        }
      }
      if ('children' in node && Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(model.nodes, 0);
  return parts.join('\n');
}

type BranchNode = Extract<EditorNode, { readonly kind: 'branch' }>;

/** A tag's new name and kind, and the attributes the new name does not keep. */
interface TagChange {
  readonly kind: 'element' | 'component';
  readonly name: string;
  readonly asset: boolean;
  readonly dropped: readonly string[];
}

// A tag renamed (step 9): the attributes the new name does not keep removed
// first — removals anchor on the node as authored, and a rename may change
// its kind, which the next request's anchor would no longer match — then the
// name, then the imports the new name needs and the old one leaves unused, all
// one undo step. Void tags keep no children: `<img>` holds none.
function tagChangeGesture(
  model: EditorModel,
  node: EditorNode,
  change: TagChange,
  imports: (model: EditorModel) => EditorModel,
): EditGesture {
  const options = { coalesceKey: undefined, urgency: true };
  const patch = Object.fromEntries(change.dropped.map((attr) => [attr, undefined]));
  const removal = propsGesture(node.id, patch, options);
  const kept = change.dropped.length > 0 ? removal.apply(model) : model;
  const before = findNodeById(kept.nodes, node.id);
  assert(before !== undefined, 'The renamed node survives its attribute removals');
  const children = VOID_TAGS.has(change.name) ? undefined : before.children;
  // A fresh copy, so taking the old tag's flags off it edits nothing shown.
  const next: EditorNode = Object.assign({}, before, {
    kind: change.kind,
    name: change.name,
    children,
  });
  Reflect.deleteProperty(next, 'dynamicTag');
  Reflect.deleteProperty(next, 'astroAsset');
  if (change.asset) {
    Object.assign(next, { astroAsset: true });
  }
  const rename = tagRenameGesture(node, next, options);
  const renamed = rename.apply(kept);
  const named = change.dropped.length > 0 ? sequence(removal, rename) : rename;
  if (frontmatterOf(imports(renamed)) === frontmatterOf(renamed)) {
    return named;
  }
  return sequence(named, frontmatterGesture(renamed, options, imports));
}

// The unsaved version of a conflicted page as text, for review (plan §7). The
// page's queued gestures are planned as the splices they would write, against
// the bytes they were stated on (page:previewEdit) — never printed whole, on
// any page since step 10.
type Reviewed =
  | { readonly tag: 'shown'; readonly source: string; readonly withdrawn: number }
  | { readonly tag: 'failed'; readonly message: string };

async function reviewedSource(
  path: string,
  state: EditablePageState,
  queued: readonly QueueEntry[],
): Promise<Reviewed> {
  // Only typed code leaves a page without an origin, and typed code is
  // reviewed as it was typed (the caller's branch).
  assert(state.origin !== undefined, 'A page with only gestures queued has an origin');
  const gestures = queued.flatMap((entry) => (entry.tag === 'gesture' ? [entry.gesture] : []));
  assert(gestures.length === queued.length, 'Typed code is reviewed as it was typed');
  const shown = await previewGestures({
    path,
    origin: state.origin,
    gestures,
    preview: previewProjectPageEdit,
  });
  switch (shown.tag) {
    case 'previewed':
      return { tag: 'shown', source: shown.origin.source, withdrawn: shown.withdrawn };
    case 'failed':
      return shown;
    default: {
      const exhaustive: never = shown;
      return exhaustive;
    }
  }
}

// The node as a text field states it (step 9): a loop's head — the renames
// followed below it, and loops reading an item whose data changed disconnected
// — a condition's test, a style or script body, or the value of a text, an
// expression or a note. A new node; the shown one is left as it was, and the
// loop helpers edit a private copy of the loop only.
function restatedText(
  node: EditorNode,
  value: string,
  renames: readonly Rename[] | undefined,
): EditorNode | undefined {
  switch (node.kind) {
    case 'map': {
      const renamed = (renames || []).reduce(
        (children, { from, to }) =>
          from && to && from !== to ? renamedLoopVar(children, from, to) : children,
        node.children,
      );
      // Renames above already re-pointed the children, so compare the data
      // sources and orphan-proof what reads from this item.
      const before = parseLoopHead(node.head);
      const after = parseLoopHead(value);
      const vars = after ? [after.item, after.index].filter(Boolean) : [];
      const moved = before && after && before.data !== after.data && vars.length > 0;
      const children = moved ? disconnectedLoops(renamed, vars) : renamed;
      return { ...node, head: value, children };
    }
    case 'cond':
      return { ...node, test: value };
    case 'raw':
      return { ...node, inner: value };
    case 'text':
    case 'expr':
    case 'comment':
      return { ...node, value };
    case 'element':
    case 'component':
    case 'branch':
    case 'raw-line':
    case 'chunk-group':
      return undefined; // No text field states these.
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// The text a node's field states, as restatedText writes it back: undefined
// for a node no text field states.
function statedText(node: EditorNode): string | undefined {
  switch (node.kind) {
    case 'map':
      return node.head;
    case 'cond':
      return node.test;
    case 'raw':
      return node.inner;
    case 'text':
    case 'expr':
    case 'comment':
      return node.value;
    case 'element':
    case 'component':
    case 'branch':
    case 'raw-line':
    case 'chunk-group':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// An undo step with nothing of its own to undo.
function voided(outcome: EditsRecord['outcome']): boolean {
  switch (outcome.tag) {
    case 'folded':
    case 'dropped':
      return true;
    case 'applied':
      return outcome.applied.every((write) => write.inverse.length === 0);
    case 'pending':
      return false;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// The origin after an Undo's revert: its reply, carried from the origin
// through the revert's own splices (an .astro page; undefined otherwise).
function revertedOrigin(origin: PageOrigin | undefined, reply: PageEdited): PageOrigin | undefined {
  if (origin === undefined || !reply.editable) {
    return undefined;
  }
  const after = { source: reply.source, seed: seedOf(reply.checksum), model: reply.model };
  const model = carryHandles({ before: origin, after, own: reply.inverse, predicted: undefined });
  return { checksum: reply.checksum, source: reply.source, model };
}

// How long a pending save waits, by urgency. See scheduleSave.
function saveDelay({ urgency }: { readonly urgency: boolean | 'live' }): number {
  if (urgency === true) {
    return 0;
  }
  if (urgency === 'live') {
    return 120;
  }
  return 300;
}

// A route is stored the way it identifies a page — slashless, so /de/hotel
// and /de/hotel/ are the same entry however a link was typed. A URL is a
// different thing: Astro's dev server serves exactly one of those spellings,
// and answers the other with a 404 help page. So the project's trailingSlash
// is applied on the way from one to the other, never before.
function routeToPath(route: string, trailingSlash: TrailingSlash): string {
  if (!route || route === '/') {
    return route || '/';
  }
  // An extension means a file, not a directory-style route: /rss.xml keeps
  // its shape under every setting, which is also how Astro checks it.
  if (trailingSlash === 'always') {
    return /\.[^/]+$/.test(route) ? route : route + '/';
  }
  if (trailingSlash === 'never') {
    return route.replace(/\/$/, '');
  }
  return route; // 'ignore' — the default, and it serves either
}

function parseTrailingSlash(value: string): TrailingSlash {
  if (value === 'always' || value === 'never' || value === 'ignore') {
    return value;
  }
  throw new Error(`Unknown trailing-slash mode: ${value}`);
}

// Imports the app is willing to remove once nothing refers to them: a
// component file of any flavour Astro renders, an image, and Astro's own
// <Image>/<Picture>. All three are reachable only as a tag or from an
// expression, both of which the check below reads in full. A stylesheet, a
// data module or a utility is left alone — those get imported for effects
// this file can't see, and dropping one that is still doing its job breaks
// the page.
const COMPONENT_IMPORT_RE = /\.(astro|jsx|tsx|vue|svelte)$/i;
const ASSET_IMPORT_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

function prunableImport(i: ImportDecl): boolean {
  return (
    COMPONENT_IMPORT_RE.test(i.path) ||
    ASSET_IMPORT_RE.test(i.path) ||
    i.path === ASTRO_ASSETS_MODULE
  );
}

function withPrunedImports(model: EditorModel): EditorModel {
  const used = collectUsedNames(model);
  // A name can be referenced as code rather than as a tag — inside a
  // `<Fragment set:html>` chunk, a frontmatter const, a prop expression. The
  // test is deliberately loose (a bare word anywhere in the code counts),
  // because the cost of a false positive is a stray import and the cost of a
  // false negative is deleting something the page still needs.
  const code = codeText(model);
  const mentioned = (name: string): boolean =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
  const imports = model.imports.filter(
    (i) => !prunableImport(i) || used.has(i.name) || mentioned(i.name),
  );
  return imports.length === model.imports.length ? model : { ...model, imports };
}

// Chooses an import path matching the page's existing style: if it already
// imports via a src alias (e.g. "@/components/X.astro"), reuse that alias
// root for the new import; otherwise fall back to a relative path.
function chooseImportPath(
  model: Pick<PageModel, 'imports'>,
  paths: { readonly relative: string; readonly srcRelative: string | undefined },
): string {
  const { relative, srcRelative: sourceRelative } = paths;
  if (sourceRelative) {
    for (const imp of model.imports) {
      if (imp.path.startsWith('.')) {
        continue;
      }
      for (const marker of ['/components/', '/layouts/']) {
        const index = imp.path.indexOf(marker);
        if (index > 0) {
          return imp.path.slice(0, index + 1) + sourceRelative;
        }
      }
    }
  }
  return relative;
}

// Whether the props panel would offer this node a Content field — the rich
// inline editor over its words. The same test PropsPanel makes: children that
// are all text and simple inline tags, or an element still empty and able to
// hold text. Kept in step with it by hand; the two disagreeing would mean a
// double-click that focuses a field which isn't there.
function holdsInlineText(node: PageNode | undefined): boolean {
  if (!node || node.kind !== 'element') {
    return false;
  }
  if (VOID_TAGS.has(String(node.name).toLowerCase())) {
    return false;
  }
  const kids = node.children;
  return isInlineOnly(kids) || !Array.isArray(kids) || kids.length === 0;
}

// Pass over the steps with nothing of their own to undo (folded into a
// newer step's write, dropped before they were sent): bounded by the history.
const effective = (list: HistoryEntry[]): HistoryEntry | undefined => {
  let entry = list.pop();
  while (entry?.kind === 'edits' && voided(entry.record.outcome)) {
    entry = list.pop();
  }
  return entry;
};

// The welcome screen's thumbnails are taken in the main process now, from
// the project's home page rendered in a window of its own (see
// electron/thumbs.js). Photographing this window was what put the editor's
// own panels — and whatever page and scroll position the user left — into
// the picture that is supposed to show the site.

// The comment sitting directly above a node. The navigator folds it into
// that node's row rather than giving it one of its own, and the props panel
// edits it there — so a section's label and its note stay together.
const commentAbove = (
  model: EditorModel | undefined,
  nodeId: string | undefined,
): EditorNode | undefined => {
  if (!model || !nodeId) {
    return undefined;
  }
  const found = findParentList(model, nodeId);
  if (!found || found.index === 0) {
    return undefined;
  }
  const previous = found.list[found.index - 1];
  return previous && previous.kind === 'comment' ? previous : undefined;
};

// Set/replace/remove the `layout:` key in a markdown page's YAML
// frontmatter, leaving every other key and its formatting alone. The
// frontmatter text stays the single source of truth — editing it by hand in
// the frontmatter editor and picking a layout here write to the same place.
const withLayoutField = (frontmatter: string, layoutPath: string | undefined): string => {
  const fm = frontmatter ?? '';
  if (/^[ \t]*layout[ \t]*:/m.test(fm)) {
    return layoutPath
      ? fm.replace(/^[ \t]*layout[ \t]*:.*$/m, `layout: ${layoutPath}`)
      : fm.replace(/^[ \t]*layout[ \t]*:.*(\n|$)/m, '');
  }
  if (!layoutPath) {
    return fm;
  }
  // First, so it reads as the page's frame rather than one field among many.
  return fm ? `layout: ${layoutPath}\n${fm}` : `layout: ${layoutPath}`;
};

// A component whose Props extends HTMLAttributes<"tag"> also accepts that
// element's built-in attributes — merge them in after its own props.
const schemaFor = (entry: ScanComponent | AstroAsset | undefined): readonly FieldDefinition[] => {
  if (!entry) {
    return [];
  }
  const own = entry.schema || [];
  const ownNames = new Set(own.map((field) => field.name));
  const extendsTag = 'extendsTag' in entry ? entry.extendsTag : undefined;
  const inherited = extendsTag
    ? getElementSchema(extendsTag).filter((field) => !ownNames.has(field.name))
    : [];
  // A component that spreads `...rest` passes class straight through to
  // whatever it renders, so styling one is a normal thing to want — give it
  // the same class field an element has rather than making the user add it
  // by hand in Attributes.
  const passesClass =
    entry.hasRest &&
    !own.some((field) => /^class(Name|es)?$/i.test(field.name)) &&
    !inherited.some((field) => field.name === 'class');
  return [
    ...own,
    ...(passesClass ? [{ name: 'class', type: 'string', optional: true }] : []),
    ...inherited,
  ];
};

// Every element takes a class, and it's the field people reach for most —
// but it lives in the global attributes, not in any tag's own schema, so it
// only appeared once something had already set one. Given first place, right
// under the tag, on anything that renders an element.
const withClassField = (fields: readonly FieldDefinition[]): readonly FieldDefinition[] =>
  fields.some((field) => field.name === 'class')
    ? fields
    : [{ name: 'class', type: 'string', optional: true }, ...fields];

// A marker path may arrive namespaced (src/…/Card.astro|0.1). The index trail
// after the pipe is what addresses a node in the open file's tree.
const trailOf = (path: string): number[] => (path.split('|').pop() ?? '').split('.').map(Number);

// The stack entry for a component opened from `host` (an instance in the file on screen).
function componentEntry(
  stack: readonly OpenFile[],
  nodes: readonly EditorNode[],
  component: { readonly name: string; readonly path: string },
  host: { readonly path: string | undefined; readonly occurrence: number },
): OpenFile {
  // The canvas keeps showing the page, so remember which instance was
  // opened — that region stays lit while the rest dims. Drilling deeper
  // keeps the outermost instance as the focus: a nested component's
  // internals aren't addressable in the page's own markers.
  //
  // Which copy of it, too: a component rendered inside a loop is on the
  // page once per item, and opening one card means that card. Without the
  // occurrence every instance stayed lit, and editing one looked like
  // editing all of them.
  //
  // A layout is the exception: it wraps <html>, so the instance IS the
  // page and there is nothing around it to dim. Its path still names the
  // focus — clicks route by it, and one in the page's own content still
  // means "I'm done in here" — but the lit region would be the page's slot
  // content, which is the one part of the canvas the layout does NOT own.
  // Dimming the header, the sidebar and the footer while lighting the page
  // body said the opposite of what opening a layout does.
  const top = stack[stack.length - 1];
  const hostPath = host.path;
  const hostNode = hostPath
    ? nodeAtPath(nodes, (String(hostPath).split('|').at(-1) ?? '').split('.').map(Number))
    : undefined;
  const focusPath = top?.focusPath ?? hostPath ?? undefined;
  const nested = top?.focusPath !== undefined;
  const focusOcc = nested ? (top.focusOcc ?? 0) : host.occurrence;
  const focusWhole = nested ? !!top.focusWhole : hostNode?.id === 'layout';
  return {
    kind: 'component',
    name: component.name,
    path: component.path,
    focusPath,
    focusOcc,
    focusWhole,
    hostKey: hostPath ?? undefined,
  };
}

// The markup a new component took, replaced in the page by an instance of it: the
// instance goes in before the markup, the markup comes out, and the import follows —
// one undo step, the markup's bytes moved to the new file rather than reprinted.
function extractionGesture(
  shown: EditorModel,
  nodeId: string,
  extracted: {
    readonly id: NodeId;
    readonly name: string;
    readonly props: readonly string[];
    readonly place: InsertPlace;
    readonly paths: ImportPaths;
  },
): EditGesture {
  const { id, name, props, place, paths } = extracted;
  // The instance passes each value straight back in under its own name.
  // That's what reconnects it: `title` meant the page's title where this
  // markup used to sit, and it still does, one level out.
  const instance: EditorNode = {
    id,
    kind: 'component',
    name,
    props: Object.fromEntries(props.map((prop) => [prop, { type: 'expr', value: prop }])),
    children: undefined,
  };
  const urgent = { coalesceKey: undefined, urgency: true };
  const replaced = sequence(
    insertGesture(shown, instance, place, urgent),
    removalGesture([nodeId], urgent),
  );
  const after = replaced.apply(shown);
  const imports = (pageModel: EditorModel): EditorModel =>
    pageModel.imports.some((i) => i.name === name)
      ? pageModel
      : {
          ...pageModel,
          imports: [
            ...pageModel.imports,
            { name, path: chooseImportPath(pageModel, paths), quote: "'" },
          ],
        };
  return frontmatterOf(imports(after)) === frontmatterOf(after)
    ? replaced
    : sequence(replaced, frontmatterGesture(after, urgent, imports));
}

// What creating a component says it did.
function createdComponentMessage(
  rel: string,
  propCount: number,
  { stranded }: { readonly stranded: boolean },
): string {
  if (stranded) {
    return `Created ${rel} — it reads page data, so it will need props.`;
  }
  if (propCount > 0) {
    return `Created ${rel} with ${propCount} prop${propCount === 1 ? '' : 's'}.`;
  }
  return `Created ${rel}`;
}

// What a pasted subtree needs from its new page: project components to import from
// where they live, and the imports and declarations it read on the page it came from.
async function pasteNeeds(
  clip: NodeClipboard,
  model: EditorModel,
  context: {
    readonly insertables: readonly ScanComponent[];
    readonly resolveImportPath: (targetPath: string) => Promise<ImportPaths>;
    readonly currentPath: () => string | undefined;
  },
): Promise<PasteNeeds> {
  // Everything the subtree reads: the components it renders and every name in
  // the code hanging off it — `options={jobs}`, a loop's `posts.map`, a
  // condition's test.
  const names = namesUsedIn([clip.node]);
  const knows = (nm: string): boolean =>
    model.imports.some((i) => i.name === nm) ||
    new RegExp(`\\b${nm.replace(/\$/g, '\\$')}\\b`).test(model.extraFrontmatter || '');
  const missing = [...names].filter((nm) => !knows(nm));
  // A component this project has is imported from where it actually lives,
  // whatever the page it was copied from called it.
  const resolved: {
    readonly name: string;
    readonly paths: Awaited<ReturnType<typeof findImportPath>>;
  }[] = [];
  const byScan = new Set<string>();
  for (const nm of missing) {
    const target = context.insertables.find((component) => component.name === nm);
    if (target) {
      byScan.add(nm);
      resolved.push({
        name: nm,
        paths: await context.resolveImportPath(target.path),
      });
    }
  }

  // And what is left is the page's own code: an import of something that is
  // not a component (an image, `getCollection`), or a `const` it declared.
  // Both come across, and a declaration brings whatever it reads in turn.
  const carried = neededFrontmatter({
    names: missing.filter((nm) => !byScan.has(nm)),
    frontmatter: clip.frontmatter || '',
    imports: clip.imports || [],
    has: knows,
  });
  const carriedImports: ImportDecl[] = [];
  for (const imp of carried.imports) {
    // A relative path means something different from another page's folder.
    const rebased =
      clip.pagePath && String(imp.path || '').startsWith('.')
        ? await rebaseProjectImport(clip.pagePath, context.currentPath(), imp.path)
        : { path: imp.path };
    carriedImports.push({
      name: imp.name,
      path: rebased.path || imp.path,
      quote: "'",
    });
  }

  return { resolved, carried, carriedImports };
}

interface PasteNeeds {
  readonly resolved: readonly { readonly name: string; readonly paths: ImportPaths }[];
  readonly carried: ReturnType<typeof neededFrontmatter>;
  readonly carriedImports: readonly ImportDecl[];
}

// The page's imports and frontmatter with what a paste needs added.
function pastedImports(needs: PasteNeeds): (model: EditorModel) => EditorModel {
  const { resolved, carried, carriedImports } = needs;
  return (model) => {
    let imports = model.imports;
    for (const entry of resolved) {
      if (!imports.some((i) => i.name === entry.name)) {
        const spec = chooseImportPath(model, entry.paths);
        imports = [...imports, { name: entry.name, path: spec, quote: "'" }];
      }
    }
    for (const imp of carriedImports) {
      if (!imports.some((i) => i.name === imp.name)) {
        imports = [...imports, imp];
      }
    }
    const extraFrontmatter = carried.statements.length
      ? withStatements(model.extraFrontmatter, carried.statements)
      : model.extraFrontmatter;
    return { ...model, imports, extraFrontmatter };
  };
}

// Pastes into the selection when it can host children (a non-void element, or a
// component with a default slot), otherwise after it, or at the end of the page.
function pastePlace(
  model: EditorModel,
  selectionId: string | undefined,
  insertables: readonly ScanComponent[],
): InsertPlace {
  const acceptsChildren = (node: EditorNode): boolean => {
    if (node.id === 'layout') {
      return true;
    }
    if (node.kind === 'element') {
      return !VOID_TAGS.has(String(node.name).toLowerCase());
    }
    if (node.kind === 'component') {
      return (insertables.find((component) => component.name === node.name)?.slots || []).includes(
        'default',
      );
    }
    return false;
  };
  const selection = selectionId ? findNodeById(model.nodes, selectionId) : undefined;
  const found = selectionId ? findWithParent(model.nodes, selectionId) : undefined;
  if (selection && acceptsChildren(selection)) {
    const index = Array.isArray(selection.children) ? selection.children.length : 0;
    return { parentId: selection.id, index };
  }
  if (found) {
    return { parentId: found.parent?.id ?? undefined, index: found.index + 1 };
  }
  return { parentId: undefined, index: model.nodes.length };
}

// An Astro asset component, placed with the named import it needs when the page lacks it.
function astroAssetGesture(
  model: EditorModel,
  asset: { readonly id: NodeId; readonly name: string },
  target: Parameters<typeof insertGesture>[2],
): EditGesture {
  // Self-closing, and already valid: Astro throws on an <Image> with no
  // src, so a bare one would swap the canvas for a stack trace the
  // moment it landed. See PLACEHOLDER_PROPS.
  const node: EditorNode = {
    id: asset.id,
    kind: 'component',
    name: asset.name,
    props: { ...PLACEHOLDER_PROPS },
    children: undefined,
  };
  // Step 6, insert and frontmatter: the import when the page lacks it,
  // then the node.
  const insert = insertGesture(model, node, target, { urgency: true });
  if (model.imports.some((i) => i.name === asset.name && !i.typeOnly)) {
    return insert;
  } else {
    const named = {
      name: asset.name,
      imported: asset.name,
      path: ASTRO_ASSETS_MODULE,
      named: true,
      quote: "'",
    };
    const imported = (pageModel: EditorModel): EditorModel => ({
      ...pageModel,
      imports: [...pageModel.imports, named],
    });
    const options = { coalesceKey: undefined, urgency: true };
    return sequence(frontmatterGesture(model, options, imported), insert);
  }
}

// A new node for an insert-palette item that needs no import, or undefined for one
// that is not inserted as a node here.
function insertedNode(item: InsertItem, id: NodeId): EditorNode | undefined {
  let node: EditorNode | undefined = undefined;
  if (item.type === 'element') {
    const placeholder = defaultText(item.tag);
    node = {
      id,
      kind: 'element',
      name: item.tag,
      props: {},
      children: VOID_TAGS.has(item.tag)
        ? undefined
        : placeholder
          ? [{ id: newId(), kind: 'text', value: placeholder }]
          : [],
    };
  } else if (item.type === 'map') {
    // No source until one is picked in the props panel. An empty literal
    // renders nothing; a placeholder name would throw "x is not defined"
    // and take the preview down the moment the loop lands on the page.
    node = { id, kind: 'map', head: '[].map((item) => (', children: [] };
  } else if (item.type === 'cond') {
    // `true` until a real test is typed: the then branch renders, so the
    // condition is visible on the canvas the moment it lands.
    //
    // Just the then. Most conditions never want an else, and one that does
    // is a switch away in the props panel — where turning it back off
    // brings the markup home rather than dropping it. Until then there is
    // nothing to choose between, so the tree shows what is inside the
    // condition directly (see branches.js) instead of a row saying "then".
    node = {
      id,
      kind: 'cond',
      op: '&&',
      test: 'true',
      children: [{ id: newId(), kind: 'branch', name: 'then', children: [] }],
    };
  } else if (item.type === 'comment') {
    node = { id, kind: 'comment', value: ' Comment ' };
  } else if (item.type === 'text') {
    node = { id, kind: 'text', value: 'Text' };
  } else if (item.type === 'expr') {
    node = { id, kind: 'expr', value: '{/* code */}' };
  } else if (item.type === 'doctype') {
    node = { id, kind: 'raw-line', value: '<!doctype html>' };
  } else if (item.type === 'style' || item.type === 'script') {
    node = { id, kind: 'raw', name: item.type, props: {}, inner: '' };
  }
  return node;
}

// The app's own keys, read through refs at keypress time: see the keydown effect in App.
interface AppKeys {
  readonly historyRef: React.MutableRefObject<AppHistory>;
  readonly pageStateRef: React.MutableRefObject<PageStateSnapshot>;
  readonly selectedIdRef: React.MutableRefObject<string | undefined>;
  readonly openCodeWindowRef: React.MutableRefObject<(() => boolean) | undefined>;
  readonly nodeClipboardRef: React.MutableRefObject<NodeClipboard | undefined>;
  readonly cmsOpenRef: React.MutableRefObject<boolean>;
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
  readonly setInsertOpen: (open: boolean) => void;
  readonly setLeftTab: (tab: LeftTab) => void;
  readonly setCreateRequest: React.Dispatch<React.SetStateAction<number>>;
  readonly setRightTab: (tab: RightTab) => void;
  readonly setClassFocus: React.Dispatch<React.SetStateAction<number>>;
  readonly removeNode: (nodeId: string) => void;
  readonly copyNode: (nodeId: string) => void;
  readonly duplicateNode: (nodeId: string) => void;
  readonly pasteNode: () => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
}

function handleAppKeyDown(event: KeyboardEvent, keys: AppKeys): void {
  if (handleHistoryKey(event, keys)) {
    return;
  }
  if (keys.cmsOpenRef.current) {
    return;
  }
  if (handleCommandKey(event, keys)) {
    return;
  }
  handleSelectionKey(event, keys);
}

// ⌘Z undoes, ⇧⌘Z / ⌘Y redoes. True when the key was one of those.
function handleHistoryKey(event: KeyboardEvent, keys: AppKeys): boolean {
  const mod = event.metaKey || event.ctrlKey;
  // Undo/redo take priority over native field undo so history stays
  // consistent no matter where focus is. Handled before the CMS check
  // below and without requiring an open page: the stack also holds CSS,
  // CMS and asset changes, which are undoable from anywhere.
  if (mod && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
    const history = keys.historyRef.current;
    const wantsRedo = event.key.toLowerCase() === 'y' || event.shiftKey;
    if (!(wantsRedo ? history.future : history.past).length) {
      return true;
    } // let the field's own undo have it
    event.preventDefault();
    // Undo and redo report their own failures.
    if (wantsRedo) {
      void keys.redo();
    } else {
      void keys.undo();
    }
    return true;
  }
  return false;
}

// ⌘F / ⌘E, ⌘⇧A and ⌘Enter, which work from inside fields too. True when the key was one.
function handleCommandKey(event: KeyboardEvent, keys: AppKeys): boolean {
  const mod = event.metaKey || event.ctrlKey;
  // ⌘F / ⌘E open the insert palette (works from anywhere except the
  // code editor, which keeps its own find).
  if (mod && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'e')) {
    if (!keys.pageStateRef.current.pageState?.editable) {
      return true;
    }
    const element = event.target;
    if (element instanceof HTMLElement && element.closest('.cm-editor')) {
      return true;
    }
    event.preventDefault();
    keys.setInsertOpen(true);
    return true;
  }

  // ⌘⇧A makes a component out of the selection: the Components panel opens
  // with the naming dialog up, the same thing its create button does.
  // Before the "am I typing" guard, so it works wherever focus happens to
  // be — it acts on the selected element, not on the field.
  if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') {
    if (!keys.pageStateRef.current.pageState?.editable) {
      return true;
    }
    if (!keys.selectedIdRef.current || keys.selectedIdRef.current === 'frontmatter') {
      return true;
    }
    const element = event.target;
    if (element instanceof HTMLElement && element.closest('.cm-editor')) {
      return true;
    }
    event.preventDefault();
    keys.setLeftTab('components');
    keys.setCreateRequest((count) => count + 1);
    return true;
  }

  // ⌘Enter goes straight to the class field: Settings tab, Settings group
  // open, caret in the class input. Before the "am I typing" guard below,
  // so it also works from another field in the panel.
  if (mod && !event.altKey && !event.shiftKey && event.key === 'Enter') {
    if (!keys.selectedIdRef.current) {
      return true;
    }
    const element = event.target;
    if (element instanceof HTMLElement && element.closest('.cm-editor')) {
      return true;
    }
    event.preventDefault();
    keys.setRightTab('settings');
    keys.setClassFocus((count) => count + 1);
    return true;
  }
  return false;
}

// The keys that act on the selection, outside fields: Enter, S / D, Delete, ⌘C, ⌘D, ⌘V.
function handleSelectionKey(event: KeyboardEvent, keys: AppKeys): void {
  const mod = event.metaKey || event.ctrlKey;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.closest('input, textarea, select, [contenteditable="true"]') ||
      target.isContentEditable)
  ) {
    return;
  }
  const state = keys.pageStateRef.current.pageState;
  if (!state?.editable) {
    return;
  }
  const selectionId = keys.selectedIdRef.current;
  const hasNodeSelection = !!selectionId && selectionId !== 'frontmatter';

  // Enter opens the floating editor for a selection that has one
  // (frontmatter, <style>, <script>) — same as its "Edit code" button.
  // Not gated on hasNodeSel: frontmatter is exactly one of these.
  if (!mod && !event.altKey && !event.shiftKey && event.key === 'Enter') {
    // On a focused control Enter means "activate this", not "open the
    // selection" — leave those alone (including the Edit code button
    // itself, which would otherwise fire twice).
    if (target instanceof HTMLElement && target.closest('button, a, [role="button"]')) {
      return;
    }
    if (keys.openCodeWindowRef.current?.()) {
      event.preventDefault();
    }
    return;
  }

  // S / D swap the right panel — plain keys, so they only fire outside
  // fields (the check above) and never collide with ⌘D (duplicate).
  if (!mod && !event.altKey && (event.key === 's' || event.key === 'S')) {
    event.preventDefault();
    keys.setRightTab('style');
    return;
  }
  if (!mod && !event.altKey && (event.key === 'd' || event.key === 'D')) {
    event.preventDefault();
    keys.setRightTab('settings');
    return;
  }

  if (!mod && (event.key === 'Delete' || event.key === 'Backspace')) {
    if (!hasNodeSelection) {
      return;
    }
    event.preventDefault();
    keys.removeNode(selectionId);
  } else if (mod && event.key.toLowerCase() === 'c') {
    // Let native copy win when actual text is selected.
    if (!hasNodeSelection || String(window.getSelection() || '')) {
      return;
    }
    event.preventDefault();
    keys.copyNode(selectionId);
  } else if (mod && event.key.toLowerCase() === 'd') {
    if (!hasNodeSelection) {
      return;
    }
    event.preventDefault();
    keys.duplicateNode(selectionId);
  } else if (mod && event.key.toLowerCase() === 'v') {
    if (!keys.nodeClipboardRef.current) {
      return;
    }
    event.preventDefault();
    void keys.pasteNode().catch(keys.reportFailure);
  }
}

// Sends one undo step's inverses as reverts, newest first, each against the
// checksum it came back with; stops at the first refusal and says why.
async function revertedSteps(
  path: string,
  applied: readonly AppliedEdit[],
  startOrigin: PageOrigin | undefined,
): Promise<{
  readonly done: readonly AppliedEdit[];
  readonly written: PageEdited | undefined;
  readonly origin: PageOrigin | undefined;
  readonly refusal: string | undefined;
}> {
  const done: AppliedEdit[] = [];
  let origin = startOrigin;
  let written: PageEdited | undefined;
  for (const step of [...applied].reverse()) {
    const hunks = step.inverse;
    if (hunks.length === 0) {
      continue; // A write that changed nothing has nothing to revert.
    }
    const answer = await editProjectPage({
      pagePath: path,
      authoredChecksum: step.checksum,
      edit: { tag: 'revert', hunks },
    });
    if (!answer.ok) {
      const error = answer.error;
      const why = error.code === 'rejected' ? describeRejection(error.reason) : error.message;
      return { done, written, origin, refusal: why };
    }
    done.push({ checksum: answer.value.checksum, inverse: answer.value.inverse });
    written = answer.value;
    origin = revertedOrigin(origin, answer.value);
  }
  return { done, written, origin, refusal: undefined };
}

// A clean open page whose file changed outside the app, read again and shown
// with its handles carried; a page with unsaved edits surfaces the conflict instead.
async function reloadChangedPage(
  context: {
    readonly pageStateRef: React.MutableRefObject<PageStateSnapshot>;
    readonly surfaceOutsideEdit: (pagePath: string) => Promise<void>;
    readonly setPageState: (state: EditorPageState) => void;
    readonly dropPageHistory: () => void;
  },
  changed: { readonly path: string; readonly state: EditorPageState; readonly chunk: boolean },
  closed: () => boolean,
): Promise<void> {
  // Hot-reload only a clean page. Unsaved edits are never overwritten by
  // the disk, nor the disk by them: a dirty page surfaces a conflict, and
  // a saving or conflicted one already has main's verdict coming or shown.
  if (changed.state.save.tag !== 'clean') {
    void context.surfaceOutsideEdit(changed.path);
    return;
  }
  let parsed;
  try {
    parsed = await readPage(changed.path);
  } catch {
    return;
  }
  // Only the page itself changed and the read holds the bytes this clean
  // page already shows: the app's own write heard late (its actor was
  // dropped past LIMITS.documentActorsMax), or an outside save of the same
  // bytes. Nothing changed, so nothing reloads and Undo keeps its entries.
  if (!changed.chunk && parsed.checksum === changed.state.save.checksum) {
    return;
  }
  // The read may finish after another page opened or a fresh edit. Neither
  // may be overwritten by the disk read requested before it: only the same
  // page, still clean, takes it.
  const latest = context.pageStateRef.current;
  const shownPage = latest.pageState;
  if (closed() || latest.currentPage?.path !== changed.path || shownPage?.save.tag !== 'clean') {
    return;
  }
  // The nodes the outside edit left alone keep their handles — the
  // selection with them — by the byte diff (plan §4, src/editor/nodeHandles.ts).
  context.setPageState(toEditorPageState(carriedParse(shownPage, parsed)));
  // Undo steps keep their inverses: after an outside edit they map
  // through it or are refused — they never revert it (plan §11).
  context.dropPageHistory();
}

// ⇧⌘C — the selection's file:line trail, for pasting into an AI chat.
async function copySelectionTrail(context: {
  readonly flushSave: () => Promise<void>;
  readonly showToast: (message: string, kind?: ToastKind) => void;
  readonly projectRef: React.MutableRefObject<ProjectIdentity | undefined>;
  readonly selectionKeysRef: React.MutableRefObject<readonly string[]>;
}): Promise<void> {
  // The lines are read off the file on disk, and typing is saved on a
  // 300 ms debounce — land the pending edit first or they're one edit old.
  try {
    await context.flushSave();
  } catch (error: unknown) {
    context.showToast(`Couldn’t copy the selection: ${cleanError(error)}`, 'error');
    return;
  }
  const projectPath = context.projectRef.current?.path;
  if (!projectPath) {
    return;
  }
  const copied = await copyEditorSelection(projectPath, [...context.selectionKeysRef.current]);
  if (copied) {
    context.showToast('Selection copied — paste it into your AI chat.');
  } else {
    context.showToast('Nothing selected to copy.', 'error');
  }
}

// A markdown page's layout, written into its `layout:` frontmatter key.
function markdownLayoutGesture(model: EditorModel, rel: string | undefined): EditGesture {
  const framed = (pageModel: EditorModel): EditorModel => ({
    ...pageModel,
    extraFrontmatter: withLayoutField(pageModel.extraFrontmatter, rel),
    layoutPath: rel,
  });
  return frontmatterGesture(model, { coalesceKey: undefined, urgency: true }, framed);
}

// The imports a wrapper change needs, and those it leaves unused, as the same
// undo step (step 9: a frontmatter slot).
function withImportsGesture(
  model: EditorModel,
  gesture: EditGesture,
  imports: (pageModel: EditorModel) => EditorModel,
): EditGesture {
  const after = gesture.apply(model);
  const options = { coalesceKey: undefined, urgency: true };
  return frontmatterOf(imports(after)) === frontmatterOf(after)
    ? gesture
    : sequence(gesture, frontmatterGesture(after, options, imports));
}

// The page's layout wrapper renamed to `layout`, or the page wrapped in it when it has
// none; undefined when the wrapper already is that layout or is not a tag.
function layoutWrapperGesture(
  model: EditorModel,
  wrapper: EditorNode | undefined,
  layout: { readonly name: string; readonly paths: ImportPaths },
): EditGesture | undefined {
  const { name, paths } = layout;
  const imports = (pageModel: EditorModel): EditorModel =>
    withPrunedImports(
      pageModel.imports.some((i) => i.name === name)
        ? pageModel
        : {
            ...pageModel,
            imports: [
              ...pageModel.imports,
              { name, path: chooseImportPath(pageModel, paths), quote: "'" },
            ],
          },
    );
  if (wrapper) {
    if (wrapper.kind !== 'component' && wrapper.kind !== 'element') {
      return undefined;
    }
    if (wrapper.name === name) {
      return undefined;
    }
    const renamed: EditorNode = { ...wrapper, name };
    const options = { coalesceKey: undefined, urgency: true };
    return withImportsGesture(model, tagRenameGesture(wrapper, renamed, options), imports);
  }
  // No wrapper yet — wrap the whole page in the new layout.
  const created: EditorNode = {
    id: nodeId('layout'),
    kind: 'component',
    name,
    props: {},
    children: [],
  };
  return withImportsGesture(model, wrapGesture(model, created), imports);
}

// Saves what is pending before a navigation goes on. False when the save failed —
// said only while this navigation is still the latest — or a newer one took over.
async function savedForNavigation(
  flushSave: () => Promise<void>,
  latestRequest: () => boolean,
  showToast: (message: string, kind?: ToastKind) => void,
): Promise<boolean> {
  try {
    await flushSave();
  } catch (error: unknown) {
    if (latestRequest()) {
      showToast(`Save failed: ${cleanError(error)}`, 'error');
    }
    return false;
  }
  return latestRequest();
}

// Whether a text field, a box or anything a caret is in has focus.
function inEditable(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
  );
}

// The component file a caller already named: the instances popup names a component by
// where it lives, and two folders can hold the same basename.
function componentAtPath(
  scan: ScanResult,
  name: string,
  filePath: string,
): { readonly name: string; readonly path: string } {
  return (
    scan.components.find((component) => component.path === filePath) ||
    scan.layouts.find((layout) => layout.path === filePath) || { name, path: filePath }
  );
}

// The scanned component or layout with this name.
function componentNamed(scan: ScanResult, name: string): ScanComponent | undefined {
  return (
    scan.components.find((component) => component.name === name) ||
    scan.layouts.find((layout) => layout.name === name)
  );
}

// The drill-down stack with `entry` on top, unless the file is already open in it.
function stackWith(entry: OpenFile): (stack: readonly OpenFile[]) => readonly OpenFile[] {
  return (stack) => (stack.some((open) => open.path === entry.path) ? stack : [...stack, entry]);
}

// A pasted node without the bindings of loops it no longer sits in: pasted outside
// the loop it was copied from, they would throw.
function pastedInScope(
  model: EditorModel,
  clone: EditorNode,
  place: InsertPlace,
  vars: readonly string[],
): { readonly pasted: EditorNode; readonly removed: number; readonly lost: readonly string[] } {
  const landed = insertGesture(model, clone, place, { urgency: true }).apply(model);
  const inScope = loopVarsAt(landed.nodes, clone.id);
  const lost = vars.filter((variable) => !inScope.includes(variable));
  const { node: pasted, removed } = strippedBindings(clone, lost);
  return { pasted, removed, lost };
}

// What a paste brought across from the page it was copied from, if anything.
function broughtMessage(needs: PasteNeeds): string | undefined {
  const brought = [
    ...needs.carriedImports.map((i) => i.name),
    ...needs.carried.statements.map((statement) => statement.name),
  ];
  if (!brought.length) {
    return undefined;
  }
  return (
    `Brought ${brought.map((name) => `\`${name}\``).join(', ')} ` +
    'across from the page it was copied from.'
  );
}

// What the menu's Copy and Paste act on when no field has focus: see the menu effect in App.
interface MenuEdits {
  readonly selectedIdRef: React.MutableRefObject<string | undefined>;
  readonly pageStateRef: React.MutableRefObject<PageStateSnapshot>;
  readonly cmsOpenRef: React.MutableRefObject<boolean>;
  readonly nodeClipboardRef: React.MutableRefObject<NodeClipboard | undefined>;
  readonly copyNode: (nodeId: string) => void;
  readonly pasteNode: () => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
}

// The menu's Copy: the field's own, selected text, or else the selected node.
function menuCopy(menu: MenuEdits): void {
  if (inEditable() || String(window.getSelection() || '')) {
    runNativeEdit('copy');
    return;
  }
  const selectionId = menu.selectedIdRef.current;
  if (selectionId && menu.pageStateRef.current.pageState?.editable && !menu.cmsOpenRef.current) {
    menu.copyNode(selectionId);
  }
}

// The menu's Paste: into the focused field, or else the copied node.
function menuPaste(menu: MenuEdits): void {
  if (inEditable()) {
    runNativeEdit('paste');
    return;
  }
  if (
    menu.nodeClipboardRef.current &&
    menu.pageStateRef.current.pageState?.editable &&
    !menu.cmsOpenRef.current
  ) {
    void menu.pasteNode().catch(menu.reportFailure);
  }
}

export default function App() {
  const scope = useAppScope();
  const actions = useUiActions(scope);
  const app: AppView = { ...scope, ...actions };
  const { project } = app;
  if (!project) {
    return <WelcomeView app={app} />;
  }
  const route = canvasRouteOf(app);
  // The preview's callbacks read the canvas path when they run.
  app.livePathRef.current = route.pageUrlPath;
  const shell: ShellView = { ...app, ...route, bindContext: bindContextOf(app, route), project };
  return <AppShell app={shell} />;
}

type AppScope = ReturnType<typeof useAppScope>;
type AppView = AppScope & ReturnType<typeof useUiActions>;
type CanvasRoute = ReturnType<typeof canvasRouteOf>;
type ShellView = AppView &
  CanvasRoute & {
    readonly bindContext: ReturnType<typeof bindContextOf>;
    readonly project: ProjectIdentity;
  };

// A void callback over an async action, for props typed to return nothing: the child
// never reads the promise, so a failure the action did not handle itself is reported.
function useVoidAction<Args extends readonly unknown[]>(
  report: (error: unknown) => void,
  action: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return useCallback(
    (...args: Args) => {
      void action(...args).catch(report);
    },
    [report, action],
  );
}

// The async actions the panels call as plain callbacks, each as stable as the action.
function useUiActions(scope: AppScope) {
  const { reportFailure: report } = scope;
  const onOpenProject = useVoidAction(report, scope.loadProject);
  const onSelectPage = useVoidAction(report, scope.selectPage);
  const onSelectRoute = useVoidAction(report, scope.selectRoute);
  const onCreatePage = useVoidAction(report, scope.createPage);
  const onDeletePage = useVoidAction(report, scope.deletePage);
  const onMovePage = useVoidAction(report, scope.movePageTo);
  const onRenamePageFolder = useVoidAction(report, scope.renamePageFolder);
  const onDeletePageFolder = useVoidAction(report, scope.deletePageFolder);
  const onChangeLayout = useVoidAction(report, scope.changeLayout);
  const onDropComponent = useVoidAction(report, scope.addComponent);
  const onPasteNode = useVoidAction(report, scope.pasteNode);
  const onCodeChange = useVoidAction(report, scope.changeCodeSource);
  const onCreateComponent = useVoidAction(report, scope.createComponentFromSelection);
  const onPreviewCommit = useVoidAction(report, scope.previewCommit);
  const onExitCommitPreview = useVoidAction(report, scope.exitCommitPreview);
  const onOpenAssetFile = useVoidAction(report, scope.openAssetFile);
  const onOpenSymbol = useVoidAction(report, scope.openSymbolFile);
  return {
    onOpenProject,
    onSelectPage,
    onSelectRoute,
    onCreatePage,
    onDeletePage,
    onMovePage,
    onRenamePageFolder,
    onDeletePageFolder,
    onChangeLayout,
    onDropComponent,
    onPasteNode,
    onCodeChange,
    onCreateComponent,
    onPreviewCommit,
    onExitCommitPreview,
    onOpenAssetFile,
    onOpenSymbol,
  };
}

// Where the canvas is pointed, and what the titlebar says about it.
function canvasRouteOf(app: AppView) {
  // The canvas always renders the page — editing a component just dims
  // everything outside the instance being worked on.
  const pageEntry = app.editStack[0] || app.currentPage;
  const patternRoute = pageEntry?.route;
  const component = app.currentPage?.kind === 'component' ? app.currentPage : undefined;
  const focusPath = component?.focusPath ?? undefined;
  const focusOcc = component ? (component.focusOcc ?? 0) : 0;
  // The focus routes clicks either way; this says whether it also draws.
  const focusWhole = !!component?.focusWhole;
  // A dynamic page's route is a pattern, not a URL — /posts/[slug] is a 404.
  // Preview one of the entries it actually stands for; `dynamicEntry` is which.
  const dynamicEntry = app.dynamicPaths[app.dynamicIndex] || undefined;
  // With no page selected and none to select — a project whose routes all come
  // from an integration, before one is picked — the dev server is still serving
  // a site. Show its root rather than an empty canvas: something running should
  // look like it is running.
  const rootFallback =
    !patternRoute && !app.scan.pages.length && app.devStatus === 'on' ? '/' : undefined;
  const pageRoute = dynamicEntry ? dynamicEntry.route : patternRoute || rootFallback;
  const pageUrlPath = pageRoute ? routeToPath(pageRoute, app.trailingSlash) : undefined;
  const liveUrl = app.devUrl && pageUrlPath ? app.devUrl + pageUrlPath : undefined;
  // The old version is served by its own dev server, on the same route the
  // editor is on, so switching in and out is a like-for-like comparison.
  const oldVersionUrl =
    app.previewInfo && pageUrlPath ? app.previewInfo.url + pageUrlPath : undefined;
  const openPath = app.currentPage?.path;
  const currentScanPage =
    openPath === undefined ? undefined : app.scan.pages.find((page) => page.path === openPath);
  const repository = app.gitInfo?.isRepo ? app.gitInfo : undefined;
  return {
    patternRoute,
    focusPath,
    focusOcc,
    focusWhole,
    dynamicEntry,
    pageUrlPath,
    liveUrl,
    oldVersionUrl,
    currentScanPage,
    repository,
  };
}

// What the binding picker shows: the names in scope, plus the DATA behind
// them wherever the app can see it. Two sources, and between them a designer
// gets real values rather than a list of identifiers:
//   the entry on the canvas — getStaticPaths' props ARE Astro.props for a
//     dynamic route, so `post.data.title` shows this post's actual title
//   this file's own `interface Props` — no values, but every prop still says
//     what it is, which is all a component outside a page can offer.
function bindContextOf(app: AppView, route: CanvasRoute) {
  const { dynamicEntry } = route;
  const editedEntry = app.insertables.find((component) => {
    return component.path === app.currentPage?.path;
  });
  return (
    app.loopContext && {
      ...app.loopContext,
      // Which item of a loop's list the picker reads the item's values as. A loop
      // hands `service` one entry of `times`, and the picker showed the first one
      // forever — so the fields under it were one service's, and the others could
      // only be taken on trust. Keyed by the item's own name, so two loops on a
      // page are two places.
      itemIndex: app.itemIndex,
      onStepItem: (name: string, step: number, count: number) =>
        app.setItemIndex((current) => ({
          ...current,
          [name]: ((((current[name] ?? 0) + step) % count) + count) % count,
        })),
      // A component's frontmatter is not the page's, so the page's entry is not
      // its data. What it does have is the instance it was opened from, whose
      // props are its Astro.props — the values it is rendering with right now.
      propsSample:
        app.currentPage?.kind === 'component'
          ? app.instanceProps
          : dynamicEntry?.props || undefined,
      propsSchema: schemaFor(editedEntry),
      collectionSamples: app.collectionSamples,
      collections: app.collections,
      // Opening a collection in the picker asks for one entry of it; nothing is
      // fetched for collections nobody looks at.
      onNeedSample: app.requestCollectionSample,
      // Picking from a collection this page doesn't read yet writes the query
      // that fetches it, and answers with the name it ended up under.
      ensureQuery: app.ensureCollectionQuery,
      entryNav: entryNavOf(app, dynamicEntry),
    }
  );
}

// Stepping through a dynamic route's entries from inside the picker. It is the SAME
// index the canvas renders against, so moving it previews the page against other
// content and re-reads the sample values at once — which is the point: you are
// checking a layout against real data, not one post.
function entryNavOf(app: AppView, dynamicEntry: DynamicEntry | undefined) {
  const count = app.dynamicPaths.length;
  if (count <= 1) {
    return undefined;
  }
  return {
    index: app.dynamicIndex,
    count,
    label: dynamicEntry?.label || '',
    onStep: (step: number) => app.setDynamicIndex((i) => (i + step + count) % count),
  };
}

// The start screen, before a project is open.
function WelcomeView({ app }: { readonly app: AppView }) {
  // The welcome mode floats the title bar over the start screen so the
  // interactive backdrop runs edge to edge, behind the window controls.
  return (
    <div className="app welcome-mode">
      <div className="titlebar">
        <span className="spacer" />
      </div>
      <WelcomeScreen onOpen={app.onOpenProject} showToast={app.showToast} />
      {app.busy && <BusyOverlay message={app.busy} />}
      {app.toast && <Toast toast={app.toast} />}
      <ConfirmHost />
    </div>
  );
}

// The editor around an open project.
function AppShell({ app }: { readonly app: ShellView }) {
  return (
    <div className="app">
      {app.propertySave.phase === 'saving' && (
        <div className="property-saving-overlay" role="status">
          Saving component properties…
        </div>
      )}
      <TitleBar app={app} />
      <div className="main">
        <LeftRail
          active={app.leftTab}
          componentOpen={app.componentPropertiesOpen}
          onSelect={(id) => app.setLeftTab((tab) => (tab === id ? undefined : id))}
        />
        {app.leftTab && <LeftPanel app={app} tab={app.leftTab} />}
        <div className="center">
          <CanvasPane app={app} />
          <CanvasCovers app={app} />
        </div>
        {app.inPreview && app.previewSource && (
          <div className="preview-mode">
            <iframe
              ref={app.previewIframeRef}
              src={app.previewSource}
              title="Site preview (interactive)"
            />
          </div>
        )}
        <OldVersionCover app={app} />
        {app.pageState?.editable && !app.previewRef && <RightPanel app={app} />}
      </div>
      <AppOverlays app={app} />
    </div>
  );
}

// What floats over the editor: the terminal, the code window, the insert palette,
// the conflict notice, the busy overlay and the toast.
function AppOverlays({ app }: { readonly app: ShellView }) {
  return (
    <>
      {/* Below `.main`, so it spans the full window rather than being boxed in
          by the panels. Always mounted but inert until opened: it spawns no
          shell until then, and once open it hides rather than unmounting, so
          toggling it doesn't discard the scrollback — see TerminalDock. */}
      <TerminalDock
        projectPath={app.project.path}
        open={app.termOpen}
        onClose={() => app.setTermOpen(false)}
      />
      <CodeWindowHost app={app} />
      {app.insertOpen && (
        <InsertSearch
          components={app.insertables}
          allowSlot={app.currentPage?.kind === 'component'}
          onInsert={app.insertItem}
          onClose={() => app.setInsertOpen(false)}
        />
      )}
      <ConflictNotice app={app} />
      {app.busy && <BusyOverlay message={app.busy} />}
      {app.toast && <Toast toast={app.toast} />}
      <ConfirmHost />
    </>
  );
}

function TitleBar({ app }: { readonly app: ShellView }) {
  return (
    <div className="titlebar">
      <button
        className="app-title project-back"
        title="Back to all projects"
        aria-label="Back to all projects"
        disabled={app.propertySave.phase === 'saving'}
        onClick={() => {
          void app.leaveProject().catch((error: unknown) => {
            app.showToast(`Could not return to projects: ${cleanError(error)}`, 'error');
          });
        }}
      >
        <ChevronLeftIcon size={13} />
        <span>{app.project.name}</span>
      </button>
      <span className="spacer" />
      {app.editStack.length > 1 ? (
        <button
          className="page-switch-btn comp-back"
          title="Back (Esc)"
          onClick={() => {
            // Opening the parent file reports its own failures.
            void app.closeComponent();
          }}
        >
          <ChevronLeftIcon size={13} />
          <span className="comp-back-sep" />
          <ElementComponentIcon size={13} />
          <span className="page-switch-label">{app.currentPage?.name}</span>
        </button>
      ) : (
        <PageSwitcher
          pages={app.scan.pages}
          currentPage={app.currentScanPage}
          onSelect={app.onSelectPage}
        />
      )}
      <UrlGroup app={app} />
      <span className="spacer" />
      <TitleActions app={app} />
      <GitChip
        project={app.project}
        showToast={app.showToast}
        flushSave={app.flushSave}
        onWorktreeChanged={app.reloadFromDisk}
      />
    </div>
  );
}

function UrlGroup({ app }: { readonly app: ShellView }) {
  const { liveUrl, patternRoute } = app;
  return (
    <div className="url-group">
      <span
        className={`status-dot ${
          app.devStatus === 'on' ? 'on' : app.devStatus === 'starting' ? 'starting' : 'off'
        }`}
        title={`Dev server: ${app.devStatus}`}
      />
      <button
        className="ghost"
        title="Reload preview"
        disabled={!liveUrl}
        onClick={() => app.setRefreshKey((count) => count + 1)}
      >
        <RefreshIcon size={13} />
      </button>
      {/* A real input, not a label: the URL is something you copy out and
          something you type a route into. Focus selects it all, so one
          click and ⌘C gets the whole thing. */}
      <input
        className="url"
        spellCheck={false}
        value={app.urlDraft ?? liveUrl ?? ''}
        placeholder={
          app.devStatus === 'starting' ? 'Starting Astro dev server…' : 'Preview offline'
        }
        readOnly={!liveUrl}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => app.setUrlDraft(event.target.value)}
        onBlur={() => app.setUrlDraft(undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            app.setUrlDraft(undefined);
            event.currentTarget.blur();
            return;
          }
          if (event.key !== 'Enter') {
            return;
          }
          event.currentTarget.blur();
          app.goToUrl(event.currentTarget.value);
        }}
      />
      {/* Which entry of a dynamic route the canvas is showing. The template
          is what gets edited either way — this only changes the data it's
          rendered against. */}
      {patternRoute?.includes('[') && (
        <DynamicPicker
          entries={app.dynamicPaths}
          index={app.dynamicIndex}
          onPick={app.setDynamicIndex}
          error={app.dynamicError}
          pattern={patternRoute}
        />
      )}
    </div>
  );
}

// Both ways of viewing the site, kept together.
function TitleActions({ app }: { readonly app: ShellView }) {
  const { liveUrl } = app;
  const terminalKey = shortcutLabel('J', 'primary', currentDesktopPlatform());
  return (
    <div className="titlebar-actions">
      <button
        className={`titlebar-btn ${app.termOpen ? 'on' : ''}`}
        title={`${app.termOpen ? 'Hide' : 'Show'} terminal (${terminalKey})`}
        onClick={() => app.setTermOpen((open) => !open)}
      >
        <TerminalIcon size={14} />
      </button>
      <button
        className="titlebar-btn"
        title="Open in browser"
        disabled={!liveUrl}
        onClick={() => {
          if (liveUrl) {
            void openExternalURL(liveUrl);
          }
        }}
      >
        <ExternalIcon size={14} />
      </button>
      {/* Two things put the canvas into a state you are looking at rather
          than working in — the interactive preview, and an older version —
          and this button is where both of them end. Lit for either, so it
          is never on while the only button that turns it off looks idle. */}
      <button
        className={`titlebar-btn preview-btn ${app.inPreview || app.previewRef ? 'on' : ''}`}
        title={
          app.previewRef
            ? 'Back to now (Esc)'
            : app.inPreview
              ? 'Exit preview (Esc)'
              : 'Preview the site'
        }
        disabled={!app.devUrl}
        onClick={() => togglePreview(app)}
      >
        <PreviewIcon size={15} />
      </button>
    </div>
  );
}

// The preview button: back from an older version, out of the preview, or into it.
function togglePreview(app: ShellView): void {
  if (app.previewRef) {
    app.onExitCommitPreview();
    return;
  }
  if (app.inPreview) {
    app.exitPreview();
    return;
  }
  app.enterPreview();
}

function LeftPanel({ app, tab }: { readonly app: ShellView; readonly tab: LeftTabName }) {
  return (
    <div className={`panel left ${tab === 'code' ? 'code-panel-shell' : ''}`}>
      {tab === 'properties' && <PropertiesTab app={app} />}
      {tab === 'pages' && <PagesTab app={app} />}
      {tab === 'navigator' && <NavigatorTab app={app} />}
      {tab === 'components' && <PaletteTab app={app} />}
      {tab === 'cms' && <CmsTab app={app} />}
      {tab === 'variables' && (
        <VariablesPanel
          project={app.project}
          selected={app.varsGroup}
          onSelect={app.setVarsGroup}
        />
      )}
      {tab === 'code' && <CodeTab app={app} />}
      {tab === 'history' && <HistoryTab app={app} />}
      {tab === 'assets' && (
        <AssetsPanel
          project={app.project}
          showToast={app.showToast}
          onOpenFile={app.onOpenAssetFile}
          pick={app.assetPick}
          onPickCancel={() => app.endAssetPick(false)}
          onRecordUndo={app.pushCommand}
        />
      )}
    </div>
  );
}

type LeftTabName = NonNullable<LeftTab>;

function PropertiesTab({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  if (page?.kind !== 'component') {
    return undefined;
  }
  return (
    <ComponentPropertiesPanel
      key={page.path}
      projectPath={app.project.path}
      file={page.path}
      name={page.name}
      flushSave={app.flushSave}
      onSavePhase={app.propertySave.changePhase}
      onSaved={app.completePropertySave}
      onRecordUndo={app.recordPropertyUndo}
    />
  );
}

function PagesTab({ app }: { readonly app: ShellView }) {
  return (
    <PagesPanel
      scan={app.scan}
      currentPage={app.currentScanPage}
      injectedRoutes={app.injectedRoutes}
      onSelectRoute={app.onSelectRoute}
      onSelect={app.onSelectPage}
      onCreate={app.onCreatePage}
      onDelete={app.onDeletePage}
      onRescan={() => {
        void app.rescan(app.project.path).catch(app.reportFailure);
      }}
      onMovePage={app.onMovePage}
      onCreateFolder={app.createPageFolder}
      onRenameFolder={app.onRenamePageFolder}
      onDeleteFolder={app.onDeletePageFolder}
    />
  );
}

function NavigatorTab({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  return (
    <StructurePanel
      pageState={app.pageState}
      currentPage={page?.kind === 'route' ? { kind: 'route', route: page.route } : page}
      layouts={app.scan.layouts}
      currentLayoutName={app.currentLayoutName}
      selectedId={app.selectedId}
      emptyNodeIds={app.emptyNodeIds ?? new Set<string>()}
      hiddenNodeIds={app.stateIds.hidden}
      inertNodeIds={app.stateIds.inert}
      liveClassesById={app.liveClassesById ?? new Map<string, readonly string[]>()}
      revealTick={app.revealTick}
      onSelect={app.setSelectedId}
      onHoverNode={app.setHoverNodeId}
      onOpenComponent={(name, id) => {
        void app.openComponent(name, app.pathFor(id)).catch(app.reportFailure);
      }}
      onOpenCode={app.openCodeWindowById}
      onChangeLayout={app.onChangeLayout}
      onDropComponent={app.onDropComponent}
      onMoveNode={app.moveNode}
      onRemoveNode={app.removeNode}
      onCopyNode={app.copyNode}
      onDuplicateNode={app.duplicateNode}
      onPasteNode={app.onPasteNode}
      hasClipboard={() => !!app.nodeClipboardRef.current}
      onCodeChange={app.onCodeChange}
      onOpenCodePanel={() => app.setLeftTab('code')}
      devLog={app.devLog}
    />
  );
}

function PaletteTab({ app }: { readonly app: ShellView }) {
  return (
    <PalettePanel
      components={app.insertables}
      devUrl={app.devUrl}
      trailingSlash={app.trailingSlash}
      onInsert={(name) => {
        void app.addComponent(name, undefined).catch(app.reportFailure);
      }}
      onDragBegin={() => app.setLeftTab('navigator')}
      createFrom={app.createFrom}
      createRequest={app.createRequest}
      onCreateComponent={app.onCreateComponent}
      onUsage={app.componentUsage}
      pageInstances={app.pageInstancesOf}
      onSelectInstance={(id) => {
        app.setLeftTab('navigator');
        app.setSelectedId(id);
      }}
      onOpenUsage={(entry) => openUsage(app, entry)}
    />
  );
}

// A page is opened as a page; a component or layout is drilled into, the same as
// opening one from the canvas.
function openUsage(app: ShellView, entry: { readonly path: string; readonly rel: string }): void {
  const page = app.scan.pages.find((candidate) => candidate.path === entry.path);
  if (page) {
    app.onSelectPage(page);
    return;
  }
  const name = entry.rel
    .split('/')
    .pop()
    ?.replace(/\.astro$/, '');
  if (name) {
    void app.openComponent(name, undefined, 0, entry.path).catch(app.reportFailure);
  }
}

function CmsTab({ app }: { readonly app: ShellView }) {
  return (
    <CmsPanel
      project={app.project}
      selectedRel={app.cmsRel}
      selectedContent={app.contentName}
      onSelectContent={(name) => {
        app.setContentName(name);
        if (name) {
          app.setCmsRel(undefined);
          app.setCmsSettings(false);
        }
      }}
      currentFile={app.openFileSourceRel}
      refreshKey={app.cmsTick}
      onSelect={(rel) => {
        app.setCmsRel(rel);
        app.setCmsSettings(false);
        if (rel) {
          app.setContentName(undefined);
        }
        // Closing a collection leaves nothing selected anywhere, so
        // the right-hand panels show their empty state rather than
        // the node that happened to be picked before.
        if (!rel) {
          app.setSelectedId(undefined);
        }
      }}
      onOpenSettings={(rel) => {
        app.setCmsRel(rel);
        app.setCmsSettings(true);
      }}
      showToast={app.showToast}
    />
  );
}

function CodeTab({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  const state = app.pageState;
  if (!page || page.kind === 'route' || !state) {
    return undefined;
  }
  return (
    <CodePanel
      source={state.source}
      relativePath={app.openRel ?? page.name}
      model={app.model}
      selectedId={app.selectedId}
      onChange={app.onCodeChange}
      onSelect={app.setSelectedId}
      onOpenComponent={(name, id) => {
        void app.openComponent(name, app.pathFor(id)).catch(app.reportFailure);
      }}
    />
  );
}

function HistoryTab({ app }: { readonly app: ShellView }) {
  return (
    <HistoryPanel
      project={app.project}
      gitInfo={app.gitInfo}
      previewRef={app.previewRef}
      onOpenFile={(file) => openHistoryFile(app, file)}
      onPreviewCommit={app.onPreviewCommit}
      onExitPreview={app.onExitCommitPreview}
      onRestoreFile={(commit, file) => {
        // Restoring reports its own failures.
        void restoreHistoryFile(app, commit, file);
      }}
      onRestoreProject={(commit) => {
        // Restoring reports its own failures.
        void restoreHistoryProject(app, commit);
      }}
      onSwitchBranch={(branch) => {
        // Switching reports its own failures.
        void switchHistoryBranch(app, branch);
      }}
      onMergeBranch={(branch) => {
        void mergeHistoryBranch(app, branch).catch(app.reportFailure);
      }}
      onDeleteBranch={(branch) => {
        void deleteHistoryBranch(app, branch).catch(app.reportFailure);
      }}
    />
  );
}

// A page opens in the editor. Anything else has no canvas to show it on, so the
// row says where it is and does nothing — better than opening an empty editor
// onto a stylesheet.
function openHistoryFile(app: ShellView, file: HistoryFile): void {
  const page = app.scan.pages.find((candidate) => candidate.path.endsWith(file.path));
  if (page) {
    app.onSelectPage(page);
  } else {
    app.showToast(`${file.path} isn’t a page — nothing to open on the canvas.`, 'info');
  }
}

async function restoreHistoryFile(
  app: ShellView,
  commit: HistoryCommit,
  file: HistoryCommitFile,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Put ${file.label} back?`,
    body:
      `It goes back to how it was in “${commit.subject}”, ` +
      'and lands as an unsaved change — ' +
      'so you can look at it and undo it like any other edit.',
    confirmLabel: 'Put it back',
  });
  if (!confirmed) {
    return;
  }
  try {
    if (!commit.hash) {
      throw new Error('History commit has no hash');
    }
    const restored = await restoreProjectFile(app.project.path, commit.hash, file.path);
    if (restored.missing) {
      app.showToast(restored.message ?? 'That version no longer contains the file.', 'error');
      return;
    }
    await app.refreshGit();
    await app.reloadFromDisk();
    app.showToast(`${file.label} is back to how it was`, 'success');
  } catch (error: unknown) {
    app.showToast(cleanError(error), 'error');
  }
}

async function restoreHistoryProject(app: ShellView, commit: HistoryCommit): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Take everything back to “${commit.subject}”?`,
    body:
      'Anything you haven’t saved is put aside first, so nothing is lost. ' +
      'Your saved history stays exactly as it is — ' +
      'this lands as a set of unsaved changes you can look over, keep, or undo.',
    confirmLabel: 'Take it back',
  });
  if (!confirmed) {
    return;
  }
  app.setBusy('Going back…');
  try {
    if (!commit.hash) {
      throw new Error('History commit has no hash');
    }
    const restored = await restoreProjectVersion(app.project.path, commit.hash);
    await app.refreshGit();
    await app.reloadFromDisk();
    app.showToast(
      restored?.parked
        ? 'The project is back — your unsaved work is waiting on this branch'
        : 'The project is back to how it was',
      'success',
    );
  } catch (error: unknown) {
    app.showToast(cleanError(error), 'error');
  } finally {
    app.setBusy(undefined);
  }
}

// Same as the chip: try it, and only say something if git could not carry the work
// across. Parking is what the chip's dialog offers after that, not a thing done
// pre-emptively.
async function switchHistoryBranch(app: ShellView, branch: string): Promise<void> {
  try {
    const result = await checkoutGitBranch(app.project.path, branch, { kind: 'switch' });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const checkout = result.value;
    if (!checkout.ok) {
      app.showToast(
        `${app.repository?.branch ?? 'This branch'} and ${branch} ` +
          `have different versions of ${checkout.files[0] || 'a file'} ` +
          'you have unsaved work in — ' +
          'switch from the branch button to decide what to do with it.',
        'error',
      );
      return;
    }
    await app.refreshGit();
    await app.reloadFromDisk();
    app.showToast(
      checkout.restored ? `Picked your changes back up on ${branch}` : `Switched to ${branch}`,
      'success',
    );
  } catch (error: unknown) {
    app.showToast(cleanError(error), 'error');
  }
}

function mergeHistoryBranch(app: ShellView, branch: string): Promise<void> {
  const { repository } = app;
  return mergeBranchAction({
    projectPath: app.project.path,
    branch: branch,
    into: repository?.branch ?? '',
    ...(repository?.trunk === undefined ? {} : { trunk: repository.trunk }),
    run: (work) => {
      void work()
        .then(async () => {
          await app.refreshGit();
          await app.reloadFromDisk();
        })
        .catch((error: unknown) => app.showToast(cleanError(error), 'error'));
    },
    showToast: app.showToast,
    // Both branches changed the same files. The chooser lives
    // on the branch chip, so this points there rather than
    // being a second, different answer to the same question.
    onConflict: (conflict) =>
      app.showToast(
        `${conflict.from} and ${conflict.branch} both changed ` +
          `${
            conflict.files.length === 1
              ? (conflict.files[0]?.path ?? 'a file')
              : `${conflict.files.length} files`
          }. ` +
          'Open the branch button to choose which versions to keep.',
        'info',
      ),
  });
}

function deleteHistoryBranch(app: ShellView, branch: string): Promise<void> {
  return deleteBranchAction({
    projectPath: app.project.path,
    branch: branch,
    parked: (app.repository?.parked || []).includes(branch),
    run: (work) => {
      void work()
        .then(app.refreshGit)
        .catch((error: unknown) => app.showToast(cleanError(error), 'error'));
    },
    showToast: app.showToast,
  });
}

function CanvasPane({ app }: { readonly app: ShellView }) {
  return (
    <PreviewPane
      spacingHover={app.spacingHover}
      devUrl={app.devUrl}
      devStatus={app.devStatus}
      devLog={app.devLog}
      devDiag={app.devDiag}
      route={app.pageUrlPath}
      refreshKey={app.refreshKey}
      crumbs={app.crumbs}
      onCrumb={(id) => app.setSelectedId(id)}
      onRefresh={() => app.setRefreshKey((count) => count + 1)}
      onRestart={() => {
        // Starting the dev server reports its own failure in the preview area.
        void app.startPreview(app.project.path);
      }}
      pathScope={app.editedRel ? `${app.editedRel}|` : ''}
      selPath={app.pathFor(app.selectedId)}
      navHoverPath={app.pathFor(app.hoverNodeId)}
      overlayInfo={app.overlayInfo}
      focusPath={app.focusPath}
      focusOcc={app.focusOcc}
      focusWhole={app.focusWhole}
      device={app.device}
      onDevice={app.setDevice}
      judgeEvent={app.judgeEvent}
      onStaleEvent={app.onStaleEvent}
      onPreviewReload={app.onPreviewReload}
      onSelectPath={(path, info) => selectCanvasPath(app, path ?? undefined, info)}
      onSelectedClasses={app.receiveClasses}
      onRenderedPaths={app.setRenderedPaths}
      onNodeStates={app.setNodeStates}
      onNodeClasses={app.setNodeClasses}
      onOpenPath={(path, occurrence) => openCanvasPath(app, path ?? undefined, occurrence)}
    />
  );
}

// What a click on the canvas MEANT — see canvasClick.js. The canvas answers with a
// path or with nothing, and nothing has two causes that want opposite things: a click
// the open file doesn't own, and a click on something inside it the canvas couldn't
// name.
function selectCanvasPath(
  app: ShellView,
  path: string | undefined,
  info: { readonly outside: boolean } | undefined,
): void {
  const reveal = (node: EditorNode | undefined) => {
    if (!node) {
      return;
    }
    app.setSelectedId(node.id);
    // Code and canvas are two views of the same selection. Keep
    // code open when it is already in use; every other panel gives
    // way to the navigator so the selected row is visible.
    app.setLeftTab((tab) => (tab === 'code' ? tab : 'navigator'));
    app.setRevealTick((count) => count + 1);
  };
  const { kind } = canvasClickAction({
    path: path ?? undefined,
    outside: !!info?.outside,
    focusPath: app.focusPath,
    scope: app.editedRel ? `${app.editedRel}|` : '',
  });
  if (kind === 'nothing') {
    return;
  }
  if (kind === 'close') {
    // Opening the parent file reports its own failures.
    void app.closeComponent();
    return;
  }
  const { model } = app;
  if (kind === 'layout') {
    reveal(model && findNodeById(model.nodes, 'layout'));
    return;
  }
  reveal(model && path ? nodeAtPath(model.nodes, trailOf(path)) : undefined);
}

// Double-clicking a component on the canvas drills into it. With no path the click
// landed on chrome the layout renders itself (nav, footer) — that markup belongs to
// the layout, so open the layout, matching what a single click there selects.
function openCanvasPath(app: ShellView, path: string | undefined, occurrence: number): void {
  if (!path) {
    if (app.layoutNode?.name) {
      void app.openComponent(app.layoutNode.name, app.pathFor('layout')).catch(app.reportFailure);
    }
    return;
  }
  const node = app.model && nodeAtPath(app.model.nodes, trailOf(path));
  if (!node) {
    return;
  }
  // Astro built-ins have no project component file to open.
  if (node.kind === 'component' && !node.astroAsset && node.name !== 'Fragment') {
    void app.openComponent(node.name, path, occurrence).catch(app.reportFailure);
    return;
  }
  // Nothing to drill into. But a double-click on a paragraph asks
  // to edit its words — that's what the gesture means everywhere
  // else — so it goes where the words are: Settings, caret in
  // Content. Only where that field exists; on a wrapper full of
  // elements the double-click has nothing to offer and does
  // nothing, rather than opening a panel to say so.
  if (holdsInlineText(node)) {
    app.setRightTab('settings');
    app.setContentFocus((count) => count + 1);
  }
}

// The CMS edits content, not layout — it covers the canvas rather than replacing it,
// so the preview keeps its loaded page.
function CanvasCovers({ app }: { readonly app: ShellView }) {
  return (
    <>
      {app.varsGroup && app.leftTab === 'variables' && (
        <VariablesView
          project={app.project}
          selected={app.varsGroup}
          hidden={app.leftTab !== 'variables'}
          showToast={app.showToast}
          onRecordUndo={app.pushCommand}
          onClose={() => app.setVarsGroup(undefined)}
        />
      )}
      {app.contentName && (
        <ContentView
          project={app.project}
          name={app.contentName}
          hidden={app.leftTab !== 'cms'}
          showToast={app.showToast}
          onSaved={() => app.setCmsTick((count) => count + 1)}
          onClose={() => app.setContentName(undefined)}
        />
      )}
      {app.cmsRel && (
        <CmsView
          project={app.project}
          rel={app.cmsRel}
          hidden={app.leftTab !== 'cms'}
          settings={app.cmsSettings}
          showToast={app.showToast}
          onRecordUndo={app.pushCommand}
          onSaved={() => app.setCmsTick((count) => count + 1)}
          onCloseSettings={() => app.setCmsSettings(false)}
          onDeleted={() => {
            app.setCmsRel(undefined);
            app.setCmsSettings(false);
          }}
          onClose={() => app.setCmsRel(undefined)}
        />
      )}
    </>
  );
}

// An old version covers the canvas rather than replacing what it points at. The
// editing canvas draws outlines from the model, and the model is read from the files
// on disk — which are the CURRENT ones. Pointed at an old server it would draw this
// version's boxes over that version's page: every outline in the wrong place, and every
// click editing a file that isn't what's on screen. An overlay cannot do that, because
// there is nothing to click.
function OldVersionCover({ app }: { readonly app: ShellView }) {
  const { oldVersionUrl, previewInfo } = app;
  if (!oldVersionUrl || !previewInfo) {
    return undefined;
  }
  return (
    <div className="preview-mode old-version">
      <div className="preview-banner">
        <span className="preview-banner-text">
          You’re looking at <strong>{previewInfo.subject}</strong> — how the site was{' '}
          {relativeTime(previewInfo.when ?? '')}. This is a look, not a place to work.
        </span>
        <button className="preview-banner-exit" onClick={app.onExitCommitPreview}>
          Back to now
        </button>
      </div>
      <iframe src={oldVersionUrl} title="An earlier version of the site" />
    </div>
  );
}

function RightPanel({ app }: { readonly app: ShellView }) {
  const { model, selectedId } = app;
  return (
    <div className="panel right">
      <RightTabs app={app} />
      <CapabilityNotice
        capability={
          model && selectedId && selectedId !== 'frontmatter'
            ? nodeCapability(model, selectedId)
            : undefined
        }
      />
      {app.rightTab === 'style' && <StyleTab app={app} />}
      <div style={{ display: app.rightTab === 'settings' ? 'contents' : 'none' }}>
        <PropsPanel {...settingsValues(app)} {...settingsHandlers(app)} />
      </div>
    </div>
  );
}

function RightTabs({ app }: { readonly app: ShellView }) {
  const tabs = [
    { id: 'style', label: 'Style' },
    { id: 'settings', label: 'Settings' },
  ] as const;
  const { rightTabRefs } = app;
  return (
    <div className="right-tabs">
      {app.rightTabInd && <span className="right-tabs-indicator" style={app.rightTabInd} />}
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(button) => {
            // React hands a detached button back as null.
            rightTabRefs.current[tab.id] = button ?? undefined;
          }}
          className={app.rightTab === tab.id ? 'on' : ''}
          onClick={() => app.setRightTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function StyleTab({ app }: { readonly app: ShellView }) {
  const { selectedId } = app;
  return (
    <StylePanel
      project={app.project}
      model={app.model}
      node={app.selectedNode}
      device={app.device}
      onWriteStyleNode={(nodeId, css, immediate) => {
        // Editing a component: a <style> block of the PAGE is not in
        // the model this writes into, and mutating nothing would look
        // like a save. Report it instead — the panel holds the edit
        // and writes it when the component closes.
        const state = app.pageStateRef.current.pageState;
        if (!state?.editable || !findNodeById(state.model.nodes, nodeId)) {
          return false;
        }
        app.setNodeText(nodeId, css, undefined, immediate || 'live');
        return true;
      }}
      onSelectNode={app.setSelectedId}
      onRecordUndo={app.pushCommand}
      onAddClass={(name) =>
        selectedId
          ? app.addClassToNode(selectedId, name)
          : Promise.resolve({ tag: 'refused', message: 'no element is selected' })
      }
      onSpacingHover={app.setSpacingHover}
      pathOf={app.pathFor}
      renderedClasses={app.selectedClasses}
      projectClasses={app.projectClasses}
      historyTick={app.historyTick}
      openFilePath={app.openEditableFile?.path ?? undefined}
      openFileKind={app.openEditableFile?.kind ?? undefined}
    />
  );
}

// What the Settings tab shows about the selection.
function settingsValues(app: ShellView) {
  const { selectedNode, selectedId } = app;
  const component =
    selectedNode?.kind === 'component'
      ? app.insertables.find((entry) => entry.name === selectedNode.name)
      : undefined;
  return {
    node: selectedNode,
    focusClass: app.classFocus,
    focusContent: app.contentFocus,
    isLayout: selectedId === 'layout',
    layouts: app.scan.layouts,
    currentLayoutName: app.currentLayoutName,
    schema: app.selectedSchema,
    slotOptions: app.slotOptions,
    // Whether this component takes default slot content — the same
    // test used to decide what an insert or paste can go inside.
    takesSlotText: (component?.slots || []).includes('default'),
    loopContext: app.loopContext,
    bindContext: app.bindContext,
    linkContext: app.linkContext,
    projectClasses: app.projectClasses,
    allowAttrs:
      selectedNode?.kind === 'element' ||
      // A dynamic tag renders a real element, so it takes attributes
      // even though it has no component file behind it.
      (selectedNode !== undefined &&
        selectedNode.kind !== 'frontmatter' &&
        !!selectedNode.dynamicTag) ||
      !!component?.hasRest,
    comment: noteText(commentAbove(app.model, selectedId)?.value),
    tagOptions: app.tagOptions,
    frontmatterSource: app.frontmatterCode,
    projectPath: app.project.path,
    filePath: app.editStack[app.editStack.length - 1]?.path || app.currentPage?.path || undefined,
  };
}

// What the Settings tab's fields write, each to the selection.
function settingsHandlers(app: ShellView) {
  const { selectedId } = app;
  return {
    ...settingsTextHandlers(app),
    onChangeLayout: app.onChangeLayout,
    onSetComment: (text: string) => {
      if (selectedId) {
        app.setComment(selectedId, text);
      }
    },
    onSetProp: (propName: string, value: Attr | undefined, immediate?: boolean) => {
      if (selectedId) {
        app.setProp(selectedId, propName, value, immediate);
      }
    },
    onSetProps: (nodeId: string, patch: PropValues) => app.setProps(nodeId, patch),
    onSetAssetProp: (nodeId: string, propName: string, picked: PickedAsset) => {
      void app.setAssetProp(nodeId, propName, picked).catch(app.reportFailure);
    },
    onRenameProp: (oldName: string, newName: string) => {
      if (selectedId) {
        app.renameProp(selectedId, oldName, newName);
      }
    },
    // A capital is a component name; anything else is a tag. The
    // component path answers whether the name resolves, so the
    // field can put the old value back when it doesn't.
    onChangeTag: (tag: string) => {
      if (!selectedId) {
        return undefined;
      }
      return /^[A-Z]/.test(tag)
        ? app.changeNodeKind(selectedId, tag)
        : app.changeElementTag(selectedId, tag);
    },
    onOpenCode: app.openCodeWindow,
    onSetFrontmatter: app.setExtraFrontmatter,
    onOpenSymbol: app.onOpenSymbol,
    onToggleElse: (want: boolean) => {
      if (selectedId) {
        app.toggleElseBranch(selectedId, want);
      }
    },
  };
}

// What the Settings tab's text fields write: the node's text, its content, its words.
function settingsTextHandlers(app: ShellView) {
  const { selectedId } = app;
  return {
    onSetText: (value: string, renames?: readonly Rename[]) => {
      if (selectedId === 'frontmatter') {
        app.setFrontmatter(value);
      } else if (selectedId) {
        app.setNodeText(selectedId, value, renames);
      }
    },
    onSetContent: (value: string) => {
      if (selectedId) {
        app.setNodeContent(selectedId, value);
      }
    },
    onSetInline: (kids: readonly InlineNode[]) => {
      if (selectedId) {
        app.setNodeInline(selectedId, kids);
      }
    },
  };
}

// The floating code window: page frontmatter, a raw node's inner content, or a text
// file.
function CodeWindowHost({ app }: { readonly app: ShellView }) {
  const { codeWin, codeWinValue, isFileWin } = app;
  if (!codeWin || codeWinValue === undefined) {
    return undefined;
  }
  const targetId = codeWin.targetId;
  return (
    <CodeWindow
      title={codeWin.title}
      language={codeWin.language}
      value={codeWinValue}
      editorKey={isFileWin ? `file:${codeWin.rel}` : targetId}
      revealLine={codeWin.revealLine}
      onChange={(value) => {
        if (isFileWin) {
          app.setAssetFileText(value);
        } else if (targetId === 'frontmatter') {
          app.setFrontmatter(value);
        } else if (targetId) {
          app.setNodeText(targetId, value);
        }
      }}
      onClose={() => app.setCodeWin(undefined)}
    />
  );
}

function ConflictNotice({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  if (app.pageState?.save.tag !== 'conflicted' || !page?.path) {
    return undefined;
  }
  return (
    <SaveConflictNotice
      fileName={page.name}
      reason={app.conflictReason}
      reviewing={app.leftTab === 'code'}
      onReload={() => {
        void app.reloadFromDisk();
      }}
      onReview={() => {
        void app.reviewConflictInCode();
      }}
      onKeep={app.keepLocalVersion}
    />
  );
}

// Every piece of the app's state and behaviour, in the order its hooks run.
function useAppScope() {
  const coreState = useCoreState();
  const lifecycle = useLifecycle(coreState);
  const navigation = useNavigation(coreState, lifecycle);
  const history = useHistory(coreState, lifecycle, navigation);
  const nodeEdits = useNodeEdits(coreState, lifecycle, history);
  const shortcuts = useShortcuts(coreState, lifecycle, navigation, history, nodeEdits);
  const propertyEdits = usePropertyEdits(coreState, lifecycle, history, nodeEdits);
  const pageOps = usePageOps(coreState, lifecycle, navigation, history, nodeEdits, shortcuts);
  const viewModel = useViewModel(coreState, lifecycle, shortcuts, pageOps);
  return {
    ...coreState,
    ...lifecycle,
    ...navigation,
    ...history,
    ...nodeEdits,
    ...shortcuts,
    ...propertyEdits,
    ...pageOps,
    ...viewModel,
  };
}

// The app’s state.
function useCoreState() {
  const projectState = useProjectState();
  const canvasReportState = useCanvasReportState();
  const devState = useDevState();
  const dataState = useDataState();
  const panelState = usePanelState(canvasReportState, projectState);
  const windowState = useWindowState();
  const sessionRefs = useSessionRefs(projectState);
  const typedCodeRefs = useTypedCodeRefs(sessionRefs, projectState, canvasReportState, panelState);
  return {
    ...projectState,
    ...canvasReportState,
    ...devState,
    ...dataState,
    ...panelState,
    ...windowState,
    ...sessionRefs,
    ...typedCodeRefs,
  };
}

// Notices, the dev server and the project’s lifecycle.
function useLifecycle(coreState: ReturnType<typeof useCoreState>) {
  const assetPickScope = useAssetPick(coreState);
  const toasts = useToasts(coreState);
  useDevEvents(coreState, assetPickScope);
  const scans = useScans(coreState);
  const previewStart = usePreviewStart(coreState, toasts, assetPickScope);
  const savers = useSavers(toasts, coreState);
  const flushing = useFlushing(savers, coreState, toasts);
  const openFileScope = useOpenFile(flushing, toasts, coreState);
  return {
    ...assetPickScope,
    ...toasts,
    ...scans,
    ...previewStart,
    ...savers,
    ...flushing,
    ...openFileScope,
  };
}

// Opening files, pages and components.
function useNavigation(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const selectPageScope = useSelectPage(lifecycle, coreState);
  const projectMenu = useProjectMenu(coreState, lifecycle, selectPageScope);
  const goToUrlScope = useGoToUrl(selectPageScope, coreState, lifecycle);
  const reload = useReload(coreState, lifecycle);
  const openComponentScope = useOpenComponent(coreState, lifecycle);
  const commitPreview = useCommitPreview(coreState, lifecycle);
  const gitInfoScope = useGitInfo(coreState, lifecycle);
  return {
    ...selectPageScope,
    ...projectMenu,
    ...goToUrlScope,
    ...reload,
    ...openComponentScope,
    ...commitPreview,
    ...gitInfoScope,
  };
}

// Undo, saving and file events.
function useHistory(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const historyPush = useHistoryPush(coreState, lifecycle);
  const propertyUndo = usePropertyUndo(navigation, historyPush);
  const typedParse = useTypedParse(coreState, lifecycle);
  const stepEditsScope = useStepEdits(lifecycle, coreState);
  const undoRedo = useUndoRedo(coreState, typedParse, lifecycle, stepEditsScope);
  const scheduleSaveScope = useScheduleSave(coreState, lifecycle, typedParse, historyPush);
  const commitEditScope = useCommitEdit(lifecycle, coreState, scheduleSaveScope, historyPush);
  const codeSource = useCodeSource(
    coreState,
    historyPush,
    lifecycle,
    scheduleSaveScope,
    typedParse,
  );
  const outsideEdit = useOutsideEdit(lifecycle, coreState);
  useFileEvents(coreState, lifecycle, outsideEdit);
  return {
    ...historyPush,
    ...propertyUndo,
    ...typedParse,
    ...stepEditsScope,
    ...undoRedo,
    ...scheduleSaveScope,
    ...commitEditScope,
    ...codeSource,
    ...outsideEdit,
  };
}

// Editing nodes from the navigator and the palette.
function useNodeEdits(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const addComponentScope = useAddComponent(coreState, history);
  const componentQueries = useComponentQueries(coreState);
  const createComponent = useCreateComponent(coreState, componentQueries, lifecycle, history);
  const moveNodeScope = useMoveNode(coreState, history, lifecycle);
  const removeNodeScope = useRemoveNode(coreState, lifecycle, history);
  const copyNodeScope = useCopyNode(coreState, removeNodeScope, lifecycle, history);
  const pasteNodeScope = usePasteNode(
    removeNodeScope,
    coreState,
    addComponentScope,
    lifecycle,
    history,
  );
  const insertPalette = useInsertPalette(coreState);
  useCanvasMessages(coreState, insertPalette);
  return {
    ...addComponentScope,
    ...componentQueries,
    ...createComponent,
    ...moveNodeScope,
    ...removeNodeScope,
    ...copyNodeScope,
    ...pasteNodeScope,
    ...insertPalette,
  };
}

// Shortcuts, previews and the data the page reads.
function useShortcuts(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
  history: ReturnType<typeof useHistory>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
) {
  const insertItemScope = useInsertItem(coreState, nodeEdits, lifecycle, history);
  useKeyboard(lifecycle, coreState, nodeEdits, insertItemScope, history);
  useMenuShortcuts(lifecycle, coreState, insertItemScope, nodeEdits, history);
  const interactivePreview = useInteractivePreview(coreState, navigation);
  useEscapeKeys(coreState, navigation, interactivePreview);
  const routes = useRoutes(coreState);
  useCollections(coreState);
  useSampleEntries(coreState, routes);
  useQueryCleanup(routes, history);
  return { ...insertItemScope, ...interactivePreview, ...routes };
}

// Editing a node’s properties.
function usePropertyEdits(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
) {
  const comment = useComment(coreState, history);
  const classEdits = useClassEdits(coreState, lifecycle, history);
  const assetProp = useAssetProp(coreState, classEdits, history);
  const renamePropScope = useRenameProp(coreState, history);
  const nodeKind = useNodeKind(coreState, nodeEdits, history);
  const elementTag = useElementTag(coreState, history);
  const nodeText = useNodeText(coreState, history);
  const branchEdits = useBranchEdits(coreState, history);
  const contentEdits = useContentEdits(coreState, history);
  return {
    ...comment,
    ...classEdits,
    ...assetProp,
    ...renamePropScope,
    ...nodeKind,
    ...elementTag,
    ...nodeText,
    ...branchEdits,
    ...contentEdits,
  };
}

// The page’s layout, pages and folders, and the selection.
function usePageOps(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
  history: ReturnType<typeof useHistory>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  shortcuts: ReturnType<typeof useShortcuts>,
) {
  const layoutChange = useLayoutChange(coreState, nodeEdits, history);
  const pageCreation = usePageCreation(coreState, lifecycle, navigation);
  const pageMoves = usePageMoves(coreState, lifecycle, navigation);
  const renamePageFolderScope = useRenamePageFolder(coreState, lifecycle, navigation);
  const deletePageFolderScope = useDeletePageFolder(coreState, lifecycle, navigation);
  const selectionModel = useSelectionModel(shortcuts, coreState, history);
  const createFromScope = useCreateFrom(shortcuts, coreState, selectionModel, nodeEdits);
  const selectedSchemaScope = useSelectedSchema(
    selectionModel,
    layoutChange,
    shortcuts,
    coreState,
    createFromScope,
  );
  return {
    ...layoutChange,
    ...pageCreation,
    ...pageMoves,
    ...renamePageFolderScope,
    ...deletePageFolderScope,
    ...selectionModel,
    ...createFromScope,
    ...selectedSchemaScope,
  };
}

// What the panels and the canvas show.
function useViewModel(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
) {
  const scopeContext = useScopeContext(shortcuts, pageOps, coreState);
  useInstanceProps(scopeContext, coreState);
  const tagOptionsScope = useTagOptions(coreState, pageOps, shortcuts);
  const codeWindow = useCodeWindow(coreState, shortcuts, pageOps, lifecycle);
  const symbolFile = useSymbolFile(coreState, pageOps, lifecycle);
  const canvasGate = useCanvasGate(coreState, lifecycle, codeWindow);
  const canvasNotices = useCanvasNotices(lifecycle, coreState, shortcuts);
  const crumbLabels = useCrumbLabels(pageOps, canvasNotices, coreState, shortcuts);
  const canvasMarks = useCanvasMarks(coreState, shortcuts, pageOps, crumbLabels, canvasNotices);
  const selectionPaths = useSelectionPaths(shortcuts, pageOps, canvasNotices, coreState);
  const overlayInfoScope = useOverlayInfo(shortcuts, pageOps, crumbLabels);
  return {
    ...scopeContext,
    ...tagOptionsScope,
    ...codeWindow,
    ...symbolFile,
    ...canvasGate,
    ...canvasNotices,
    ...crumbLabels,
    ...canvasMarks,
    ...selectionPaths,
    ...overlayInfoScope,
  };
}

// The open project, its scan, and the page and selection being edited.
function useProjectState() {
  const propertySave = usePropertySaveGuard();
  const [project, setProject] = useState<ProjectIdentity | undefined>(undefined);

  // ----------------------------------------------------------------
  // Model operations
  // ----------------------------------------------------------------

  const projectRef = useRef<ProjectIdentity | undefined>(undefined);
  projectRef.current = project;
  const [scan, setScan] = useState<ScanResult>({
    pages: [],
    pageFolders: [],
    layouts: [],
    components: [],
  });
  const [projectClasses, setProjectClasses] = useState<readonly string[]>([]);
  const [currentPage, setCurrentPage] = useState<CurrentPage | undefined>(undefined);
  // Drill-down trail: [page, component, nested component, …]. The last entry
  // is what's on screen; anything before it is what Back/Escape returns to.
  const [editStack, setEditStack] = useState<readonly OpenFile[]>([]);
  const [pageState, setPageState] = useState<EditorPageState | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  return {
    currentPage,
    editStack,
    pageState,
    project,
    projectClasses,
    projectRef,
    propertySave,
    scan,
    selectedId,
    setCurrentPage,
    setEditStack,
    setPageState,
    setProject,
    setProjectClasses,
    setScan,
    setSelectedId,
  };
}

// What the canvas reports about the selection and the rendered page.
function useCanvasReportState() {
  // Classes the selected element actually carries on the page, reported by the
  // preview. An expression-valued class attribute (`class:list={[…]}`,
  // `class={x}`) has no readable text in the source, so this is what lets the
  // style panel show the classes this instance resolved to.
  const [selectedClasses, setSelectedClasses] = useState<readonly string[]>([]);
  // Which selection the classes above describe, and a counter that lets the
  // effect below re-check the moment a report lands rather than on a timer.
  const classesForRef = useRef<string | undefined>(undefined);
  const [classesTick, setClassesTick] = useState(0);
  const [hoverNodeId, setHoverNodeId] = useState<string | undefined>(undefined);
  // Paths the page reports as having actually rendered something. Null until
  // the page has said anything, which is not the same as "nothing rendered".
  const [renderedPaths, setRenderedPaths] = useState<readonly string[] | undefined>(undefined);
  // Nodes the page says are there but taking no part: display:none, and
  // pointer-events:none. Marked in the navigator (see StructurePanel).
  const [nodeStates, setNodeStates] = useState<NodeStates | undefined>(undefined);
  // Path to the classes that node rendered with, for labelling rows whose
  // class is an expression the source can't resolve.
  const [nodeClasses, setNodeClasses] = useState<
    Readonly<Record<string, readonly string[]>> | undefined
  >(undefined);
  return {
    classesForRef,
    classesTick,
    hoverNodeId,
    nodeClasses,
    nodeStates,
    renderedPaths,
    selectedClasses,
    setClassesTick,
    setHoverNodeId,
    setNodeClasses,
    setNodeStates,
    setRenderedPaths,
    setSelectedClasses,
  };
}

// The dev server, the busy overlay and the toast.
function useDevState() {
  const [devUrl, setDevUrl] = useState<string | undefined>(undefined);
  const [trailingSlash, setTrailingSlash] = useState<TrailingSlash>('ignore');
  const [devStatus, setDevStatus] = useState<DevStatus>('off');
  const [devLog, setDevLog] = useState('');
  const [devDiag, setDevDiag] = useState<DevDiagnosis | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [toast, setToast] = useState<ToastMessage | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  return {
    busy,
    devDiag,
    devLog,
    devStatus,
    devUrl,
    refreshKey,
    setBusy,
    setDevDiag,
    setDevLog,
    setDevStatus,
    setDevUrl,
    setRefreshKey,
    setToast,
    setTrailingSlash,
    toast,
    trailingSlash,
  };
}

// Dynamic routes, injected routes and the data the binding picker samples.
function useDataState() {
  // Concrete paths behind a dynamic route, and which one the canvas is showing.
  const [dynamicPaths, setDynamicPaths] = useState<readonly DynamicEntry[]>([]);
  // Routes the dev server serves that aren't files here — pages an integration
  // injected. A project can consist entirely of these (a site whose pages ship
  // in a package), in which case they are the only pages there are to show.
  const [injectedRoutes, setInjectedRoutes] = useState<readonly InjectedRoute[]>([]);
  // One sampled entry per collection the open file reads by name, for the
  // binding picker. Keyed by collection; a name present with no value has
  // been asked for and has no answer, which stops it being asked again.
  const [collectionSamples, setCollectionSamples] = useState<CollectionSamples>({});
  // Every collection the project has, so data anywhere in the site is
  // reachable from the picker — not only what this page already reads.
  const [collections, setCollections] = useState<readonly AppCollection[]>([]);
  const sampleAskedRef = useRef(new Set<string>());
  const [dynamicIndex, setDynamicIndex] = useState(0);
  // Which item of each loop's list the data picker reads as `service`, `post`,
  // … — keyed by the item's own name. See bindContext below.
  const [itemIndex, setItemIndex] = useState<ItemIndexes>({});
  const [dynamicError, setDynamicError] = useState<string | undefined>(undefined);
  return {
    collectionSamples,
    collections,
    dynamicError,
    dynamicIndex,
    dynamicPaths,
    injectedRoutes,
    itemIndex,
    sampleAskedRef,
    setCollectionSamples,
    setCollections,
    setDynamicError,
    setDynamicIndex,
    setDynamicPaths,
    setInjectedRoutes,
    setItemIndex,
  };
}

// The left panel, the CMS views and the interactive preview.
function usePanelState(
  canvasReportState: ReturnType<typeof useCanvasReportState>,
  projectState: ReturnType<typeof useProjectState>,
) {
  const { setHoverNodeId } = canvasReportState;
  const { currentPage } = projectState;

  const [leftTab, setLeftTab] = useState<LeftTab>('navigator');
  useEffect(() => {
    if (leftTab !== 'navigator') {
      setHoverNodeId(undefined);
    }
  }, [leftTab, setHoverNodeId]);
  const componentPropertiesOpen = currentPage?.kind === 'component';
  useEffect(() => {
    if (!componentPropertiesOpen) {
      setLeftTab((tab) => (tab === 'properties' ? 'navigator' : tab));
    }
  }, [componentPropertiesOpen]);
  const [cmsRel, setCmsRel] = useState<string | undefined>(undefined);
  // Content collection open in the schema-driven editor. Only one of the two
  // is ever open: they edit the same kind of thing in two different ways.
  const [contentName, setContentName] = useState<string | undefined>(undefined);
  // Which stylesheet group the variables sheet is showing: { file, index }.
  const [varsGroup, setVarsGroup] = useState<VariableSelection | undefined>(undefined);
  const [cmsTick, setCmsTick] = useState(0); // bumped on save, refreshes counts
  const [cmsSettings, setCmsSettings] = useState(false); // editing that collection's fields
  const [inPreview, setInPreview] = useState(false); // interactive full-site preview
  const [previewSource, setPreviewSource] = useState<string | undefined>(undefined);
  return {
    cmsRel,
    cmsSettings,
    cmsTick,
    componentPropertiesOpen,
    contentName,
    inPreview,
    leftTab,
    previewSource,
    setCmsRel,
    setCmsSettings,
    setCmsTick,
    setContentName,
    setInPreview,
    setLeftTab,
    setPreviewSource,
    setVarsGroup,
    varsGroup,
  };
}

// The canvas route, the code window, the breakpoint and the right panel.
function useWindowState() {
  // The path the canvas is on, kept where the preview toggle can read it: it's
  // derived at the bottom of this component (a dynamic page's entry is picked
  // there), long after the callbacks up here are defined.
  const livePathRef = useRef<string | undefined>(undefined);
  const [termOpen, setTermOpen] = useState(false); // bottom terminal dock
  const [codeWin, setCodeWin] = useState<CodeWindowState | undefined>(undefined);
  const openCodeWindowRef = useRef<(() => boolean) | undefined>(undefined);
  const selectionKeysRef = useRef<readonly string[]>([]);
  const [fileText, setFileText] = useState(''); // loaded text for kind:'file'
  // Breakpoint lives here, not in PreviewPane: a re-mount of that pane must
  // not silently drop the user out of the view they picked (which would
  // reload every preview iframe and flash the canvas white).
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  // Bumped every time the page itself makes the selection, so the navigator
  // scrolls the row into view — a counter, not the id, so clicking the same
  // element twice still reveals it.
  const [revealTick, setRevealTick] = useState(0);
  const [rightTab, setRightTab] = useState<RightTab>('style');
  // ⌘Enter asks the props panel to open Settings and take the caret into the
  // class field — a counter, so pressing it again re-focuses.
  // Git state, read here so the History panel and the title-bar chip cannot
  // disagree about which branch is checked out. The chip still refreshes it on
  // its own schedule; this is the copy the panel reads.
  const [gitInfo, setGitInfo] = useState<GitInfo | undefined>(undefined);
  // The commit being previewed, or undefined for the working tree. See phase 4:
  // while this is set the canvas points at a separate server and the editor is
  // read-only.
  const [previewRef, setPreviewRef] = useState<string | undefined>(undefined);
  const [previewInfo, setPreviewInfo] = useState<PreviewCommitInfo | undefined>(undefined);
  const [classFocus, setClassFocus] = useState(0);
  const [contentFocus, setContentFocus] = useState(0);
  // Sliding highlight behind the active Style/Settings tab, measured from the
  // buttons so it tracks their real geometry (and any panel resize).
  const rightTabRefs = useRef<Record<string, HTMLButtonElement | undefined>>({});
  const [rightTabInd, setRightTabInd] = useState<RightTabIndicator | undefined>(undefined);
  // The asset request a field is waiting on, and the tab to go back to once
  // it's answered — "Choose Image…" borrows the left panel rather than
  // opening a window over the canvas.
  const [assetPick, setAssetPick] = useState<AssetPick | undefined>(undefined);
  const tabBeforePick = useRef<LeftTab>(undefined);
  // Bumped by ⌘⇧A: the Components panel opens its naming dialog when it changes.
  const [createRequest, setCreateRequest] = useState(0);
  return {
    assetPick,
    classFocus,
    codeWin,
    contentFocus,
    createRequest,
    device,
    fileText,
    gitInfo,
    livePathRef,
    openCodeWindowRef,
    previewInfo,
    previewRef,
    revealTick,
    rightTab,
    rightTabInd,
    rightTabRefs,
    selectionKeysRef,
    setAssetPick,
    setClassFocus,
    setCodeWin,
    setContentFocus,
    setCreateRequest,
    setDevice,
    setFileText,
    setGitInfo,
    setPreviewInfo,
    setPreviewRef,
    setRevealTick,
    setRightTab,
    setRightTabInd,
    setTermOpen,
    tabBeforePick,
    termOpen,
  };
}

// Components, the page snapshot refs, and the selection that follows its node.
function useSessionRefs(projectState: ReturnType<typeof useProjectState>) {
  const { currentPage, pageState, scan, setSelectedId } = projectState;

  // A layout is just a component that lives in src/layouts — it can be
  // placed on a page like any other. Every lookup that answers "what do we
  // know about the component named X" has to search both lists, or a placed
  // layout would come back with no props, no slots and no rest support.
  // Components win a name collision: they're the more likely intent.
  const insertables = useMemo(
    () => [...scan.components, ...scan.layouts],
    [scan.components, scan.layouts],
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const devLogRef = useRef('');
  const pageStateRef = useRef<PageStateSnapshot>({ currentPage: undefined, pageState: undefined });
  pageStateRef.current = { currentPage, pageState };

  // The selection follows the node it names across every model the page
  // shows: by its handle, which parses carry by span mapping (plan §4). A
  // selected node whose own bytes changed has no handle left to carry, and the
  // selection moves to the node at the same place, of the same kind. Selection
  // is interaction state, and never names a node to main.
  const shownModelRef = useRef<EditorModel | undefined>(undefined);
  useEffect(() => {
    const model = pageState?.editable ? pageState.model : undefined;
    const before = shownModelRef.current;
    shownModelRef.current = model;
    if (!model || !before || before === model) {
      return;
    }
    setSelectedId((id) => {
      if (!id || id === 'layout' || id === 'frontmatter' || findNodeById(model.nodes, id)) {
        return id;
      }
      const was = findNodeById(before.nodes, id);
      const trail = pathOfNode(before.nodes, id);
      const now = trail ? nodeAtPath(model.nodes, trail) : undefined;
      return now && was && now.kind === was.kind ? now.id : undefined;
    });
  }, [pageState, setSelectedId]);
  return { devLogRef, insertables, pageStateRef, saveTimer };
}

// Typed code awaiting its parse, and the refs event handlers read.
function useTypedCodeRefs(
  sessionRefs: ReturnType<typeof useSessionRefs>,
  projectState: ReturnType<typeof useProjectState>,
  canvasReportState: ReturnType<typeof useCanvasReportState>,
  panelState: ReturnType<typeof usePanelState>,
) {
  const { pageStateRef } = sessionRefs;
  const { editStack, selectedId } = projectState;
  const { classesForRef, setClassesTick, setSelectedClasses } = canvasReportState;
  const { inPreview } = panelState;

  // Typed code waiting for its parse (step 8). While the page shows that text,
  // its model is the parse of older text, and a gesture on it would save that
  // model over the typing: gestures wait until the parse lands.
  const typedSourceRef = useRef<string | undefined>(undefined);
  const typedCodeUnparsed = useCallback((): boolean => {
    const typed = typedSourceRef.current;
    return typed !== undefined && typed === pageStateRef.current.pageState?.source;
  }, [pageStateRef]);
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = selectedId;

  // A report from the canvas about what the selected element's classes really
  // are. It is always about whatever is selected right now — the canvas is
  // asked for the tracked path — so this records which element it answered
  // for, which is what lets the panel tell a fresh answer from a stale one.
  const receiveClasses = useCallback(
    (list: readonly string[]) => {
      classesForRef.current = selectedIdRef.current;
      setSelectedClasses(list);
      setClassesTick((count) => count + 1);
    },
    [classesForRef, setClassesTick, setSelectedClasses],
  );
  const editStackRef = useRef<readonly OpenFile[]>([]);
  editStackRef.current = editStack;
  const inPreviewRef = useRef(false);
  inPreviewRef.current = inPreview;
  const previewPathRef = useRef<string | undefined>(undefined);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  return {
    editStackRef,
    inPreviewRef,
    previewIframeRef,
    previewPathRef,
    receiveClasses,
    selectedIdRef,
    typedCodeUnparsed,
    typedSourceRef,
  };
}

// Why the dev server is down, and the asset picker errand.
function useAssetPick(coreState: ReturnType<typeof useCoreState>) {
  const { projectRef, setAssetPick, setDevDiag, setLeftTab, setRevealTick } = coreState;
  const { tabBeforePick } = coreState;

  // ----------------------------------------------------------------
  // Toasts & events
  // ----------------------------------------------------------------

  // Why the dev server isn't running (missing Node, a Node too old for the
  // project's Astro, uninstalled deps). Only asked for once it has failed —
  // the answer is what the offline pane explains instead of a raw log.
  // projectRef is declared further down, but this only reads it when called.
  const diagnose = useCallback(() => {
    const projectPath = projectRef.current?.path;
    if (!projectPath) {
      return;
    }
    diagnoseProject(projectPath)
      .then((diagnosis) => setDevDiag(diagnosis))
      .catch(() => setDevDiag(undefined));
  }, [projectRef, setDevDiag]);

  // `picked` is passed as literal true by the pick itself — the Cancel button
  // hands this its click event, which must not read as a pick.
  const endAssetPick = useCallback(
    (picked: unknown) => {
      clearAssetRequest();
      setAssetPick(undefined);
      setLeftTab((tab) => {
        if (tab !== 'assets') {
          return tab;
        }
        // Answering the field ends the errand: show the element it belongs to
        // rather than leaving the user parked in the asset browser — including
        // when the browser is where they started, which used to strand them.
        // Cancelling changed nothing, so that goes back where they came from.
        return picked === true ? 'navigator' : tabBeforePick.current || 'navigator';
      });
      tabBeforePick.current = undefined;
      // The navigator opens on the element that was just given an asset, not
      // wherever it happened to be scrolled.
      if (picked === true) {
        setRevealTick((count) => count + 1);
      }
    },
    [setAssetPick, setLeftTab, setRevealTick, tabBeforePick],
  );

  useEffect(() => {
    return onAssetRequest((request) => {
      if (!request) {
        return;
      } // cleared from this side already
      setAssetPick({
        ...request,
        // The entry rides along: which root it came from decides whether the
        // field writes a URL, an import, or a path relative to its own file.
        onPick: (rel, entry) => {
          request.onPick(rel, entry);
          endAssetPick(true);
        },
      });
      setLeftTab((tab) => {
        if (tab !== 'assets') {
          tabBeforePick.current = tab;
        }
        return 'assets';
      });
    });
  }, [endAssetPick, setAssetPick, setLeftTab, tabBeforePick]);
  return { diagnose, endAssetPick };
}

// Toasts, and failures said the way the app says any failure.
function useToasts(coreState: ReturnType<typeof useCoreState>) {
  const { setToast } = coreState;

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      setToast({ msg: message, kind });
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(undefined), 5000);
    },
    [setToast],
  );
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  // A failure no other handler caught, said the way the app says any failure.
  const reportFailure = useCallback(
    (error: unknown) => showToast(cleanError(error), 'error'),
    [showToast],
  );
  return { reportFailure, showToast };
}

// Progress, dev server output, and recovering the preview after an error.
function useDevEvents(
  coreState: ReturnType<typeof useCoreState>,
  assetPickScope: ReturnType<typeof useAssetPick>,
) {
  const { devLogRef, devUrl, livePathRef, setBusy, setDevLog, setDevStatus, setDevUrl } = coreState;
  const { setRefreshKey } = coreState;
  const { diagnose } = assetPickScope;

  useEffect(() => {
    const offProgress = onAppProgress((message) => setBusy(message));
    const offExit = onDevExit((log) => {
      setDevStatus('off');
      setDevUrl(undefined);
      if (log) {
        devLogRef.current = log;
        setDevLog(log);
      }
      diagnose();
    });
    const offLog = onDevLog((chunk) => {
      devLogRef.current = stripAnsi(devLogRef.current + chunk).slice(-4000);
      setDevLog(devLogRef.current);
    });
    return () => {
      offProgress();
      offExit();
      offLog();
    };
  }, [diagnose, devLogRef, setBusy, setDevLog, setDevStatus, setDevUrl]);

  // ----------------------------------------------------------------
  // Recovering the preview after a compile error
  // ----------------------------------------------------------------
  //
  // See src/previewRecovery.js for what this is for and why it asks the server
  // rather than reading the error screen or the log.
  //
  // The route is read through `livePathRef` rather than named as a dependency:
  // it is assigned far below this hook, so a dep array mentioning it reads it
  // before its declaration and the whole app throws (see test/app-renders.js,
  // which is here because that has happened before). The ref is current by the
  // time a probe actually runs, and the watch has no reason to be rebuilt just
  // because the route changed.
  useEffect(() => {
    if (!devUrl) {
      return undefined;
    }
    // Both of these arrive with the main process, which does not reload when the
    // renderer does (see VITE_DEV_SERVER_URL): a renderer newer than the bridge
    // would call undefined and take the app down with it. Absent means there is
    // nothing to ask, which is the same answer as having no dev server.
    if (
      typeof window.avb.probeDevPage !== 'function' ||
      typeof window.avb.onPageMaybeChanged !== 'function'
    ) {
      return undefined;
    }
    const watch = createPreviewWatch({
      probe: () => probeProjectPreview(devUrl + (livePathRef.current || '/')),
      onRecover: () => setRefreshKey((count) => count + 1),
    });
    // Every write the app makes, plus every change made outside it.
    const offWrite = onPageMaybeChanged((event) => {
      watch.poke();
      // A change from outside the app — an editor, a script, a checkout. The
      // canvas normally hears about it over the dev server's HMR socket, and
      // when that socket has gone quiet (a dev server restarted under a canvas
      // that stayed open, a machine that slept) nothing says so: the page just
      // stops updating and the only way to see an edit is the refresh button.
      // The app's own watcher saw this change, so it says it directly too.
      if (event.external) {
        tellCanvas({ type: 'avb:patch-now' });
      }
    });
    return () => {
      offWrite();
      watch.stop();
    };
  }, [devUrl, livePathRef, setRefreshKey]);
}

// Project scans: one in flight, at most one waiting.
function useScans(coreState: ReturnType<typeof useCoreState>) {
  const { setProjectClasses, setScan, setTrailingSlash } = coreState;

  // ----------------------------------------------------------------
  // Project lifecycle
  // ----------------------------------------------------------------

  // One scan in flight per project and at most one waiting (src/lib/coalescedRun.ts):
  // mutations and watcher events that ask together share the scan after them,
  // so every caller — above all one deciding a file was deleted — sees a scan
  // that began after it asked. A scan is applied only when nothing newer waits
  // behind it, and never for a project closed since.
  const projectScansRef = useRef<ProjectScans | undefined>(undefined);
  const rescan = useCallback(
    (projectPath: string): Promise<ScanResult> => {
      let scans = projectScansRef.current;
      if (scans?.projectPath !== projectPath) {
        const opened: ProjectScans = {
          projectPath,
          // The bridge parses the payload against the scan contract before any of
          // this code sees it.
          scans: createCoalescedRun(async () => {
            const result = await scanProject(projectPath);
            if (projectScansRef.current === opened && !opened.scans.superseded()) {
              setScan(result);
              if (result.trailingSlash) {
                setTrailingSlash(parseTrailingSlash(result.trailingSlash));
              }
              readProjectClasses(projectPath)
                .then((classes) => {
                  if (projectScansRef.current === opened) {
                    setProjectClasses(classes || []);
                  }
                })
                .catch(() => {});
            }
            return result;
          }),
        };
        scans = opened;
        projectScansRef.current = opened;
      }
      assert(scans.projectPath === projectPath, 'A rescan asks its own project');
      return scans.scans.request();
    },
    [setProjectClasses, setScan, setTrailingSlash],
  );
  return { rescan };
}

// Starting the project’s dev server.
function usePreviewStart(
  coreState: ReturnType<typeof useCoreState>,
  toasts: ReturnType<typeof useToasts>,
  assetPickScope: ReturnType<typeof useAssetPick>,
) {
  const { devLogRef, setBusy, setDevDiag, setDevLog, setDevStatus, setDevUrl } = coreState;
  const { setTrailingSlash } = coreState;
  const { showToast } = toasts;
  const { diagnose } = assetPickScope;

  const startPreview = useCallback(
    async (projectPath: string) => {
      setDevStatus('starting');
      try {
        const started = await startProjectPreview(projectPath);
        const { url, trailingSlash: resolved } = started;
        setDevUrl(url);
        if (resolved) {
          setTrailingSlash(parseTrailingSlash(resolved));
        }
        setDevStatus('on');
        setDevDiag(undefined);
        if ('external' in started && started.external) {
          showToast(
            `Reusing the dev server already running for this project (${url}) — ` +
              "canvas outlines need the app's own server, so stop that one to enable them.",
            'info',
          );
        }
      } catch (error: unknown) {
        setDevStatus('off');
        setBusy(undefined);
        showToast(`Preview failed to start — see the log in the preview area.`, 'error');
        const message = cleanError(error);
        devLogRef.current = message;
        setDevLog(message);
        diagnose();
      }
    },
    [
      showToast,
      diagnose,
      devLogRef,
      setBusy,
      setDevDiag,
      setDevLog,
      setDevStatus,
      setDevUrl,
      setTrailingSlash,
    ],
  );
  return { startPreview };
}

// The page and file savers, and the page’s unsent edit requests.
function useSavers(
  toasts: ReturnType<typeof useToasts>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { showToast } = toasts;
  const { pageStateRef, setPageState } = coreState;

  // ----------------------------------------------------------------
  // Page loading & saving
  // ----------------------------------------------------------------

  const fileSaverRef = useRef<ReturnType<typeof createFileSaver> | undefined>(undefined);
  if (!fileSaverRef.current) {
    fileSaverRef.current = createFileSaver({
      onError: (error) => showToast(`Save failed: ${cleanError(error)}`, 'error'),
    });
  }
  // The open page's unsent edit requests (step 6, pageEdits.ts).
  const editDraftsRef = useRef<EditDrafts | undefined>(undefined);
  editDraftsRef.current ??= new EditDrafts();
  const editDrafts = editDraftsRef.current;
  // Why the last edit request was refused, for the conflict notice (plan §7).
  const [conflictReason, setConflictReason] = useState<RejectionReason | undefined>(undefined);
  const pageSaverRef = useRef<PageSaver | undefined>(undefined);
  if (!pageSaverRef.current) {
    // A change to the open page's state from the saver: seen at once through
    // the ref (the next entry is stated against the origin it installs), and
    // applied to whatever React holds by then.
    const updatePage = (
      path: string,
      change: (current: EditorPageState) => EditorPageState,
    ): void => {
      const now = pageStateRef.current;
      if (now.currentPage?.path !== path || !now.pageState) {
        return; // Another page opened meanwhile: this one's outcome is not shown.
      }
      pageStateRef.current = { currentPage: now.currentPage, pageState: change(now.pageState) };
      setPageState((current) => (current ? change(current) : current));
    };
    pageSaverRef.current = createPageSaver({
      queue: editDrafts,
      currentPath: () => pageStateRef.current.currentPage?.path,
      conflicted: () => pageStateRef.current.pageState?.save.tag === 'conflicted',
      send: createEntrySender({
        queue: editDrafts,
        state: () => pageStateRef.current.pageState,
        update: updatePage,
        conflict: (reason) => setConflictReason(reason),
        notice: (message) => showToast(message, 'error'),
        edit: editProjectPage,
        read: readPage,
      }),
    });
  }
  const fileSaver = fileSaverRef.current;
  const pageSaver = pageSaverRef.current;
  return {
    conflictReason,
    editDrafts,
    fileSaver,
    fileSaverRef,
    pageSaver,
    pageSaverRef,
    setConflictReason,
  };
}

// Saving before moving on, the page history’s owner, and leaving the project.
function useFlushing(
  savers: ReturnType<typeof useSavers>,
  coreState: ReturnType<typeof useCoreState>,
  toasts: ReturnType<typeof useToasts>,
) {
  const { fileSaver, pageSaver } = savers;
  const { pageStateRef, saveTimer } = coreState;
  const { showToast } = toasts;

  // Autosave: a conflicted page simply stays unsaved (plan §7).
  const autosave = useCallback(
    () => Promise.all([pageSaver.flush(), fileSaver.flush()]),
    [fileSaver, pageSaver],
  );
  // Everything else that flushes needs the edits on disk before it goes on:
  // navigating away, committing, reading lines back off the file. A conflicted
  // page's edits are not there, so the caller must stop rather than discard or
  // ignore them — they are only ever given up by "Reload from disk".
  const flushSave = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const [page] = await autosave();
    if (page === 'conflicted') {
      const name = pageStateRef.current.currentPage?.name ?? 'This page';
      throw new Error(
        `${name} has unsaved edits that conflict with a change on disk. ` +
          'Reload it or review it in code first.',
      );
    }
  }, [autosave, pageStateRef, saveTimer]);

  // Only the most recent navigation is allowed to install its read result.
  // The latest navigation, as an identity token: a read that finds another
  // token here was superseded, and installs nothing. No counter is kept.
  const pageLoadRef = useRef<object>({});

  const historyRef = useRef<AppHistory>({ past: [], future: [], lastPush: 0, lastKey: undefined });

  // Snapshots belong to one page, so they're dropped when that page closes;
  // commands carry their own inverse and stay, and so do applied edits: their
  // inverses name the checksums they apply to, so after an outside edit they
  // map through it or are refused — they never revert it (step 6).
  const dropPageHistory = useCallback(() => {
    const history = historyRef.current;
    history.past = history.past.filter(keepsAcrossPages);
    history.future = history.future.filter(keepsAcrossPages);
    history.lastKey = undefined;
    history.lastPush = 0;
  }, []);

  // Leaving a project. Main lets go of everything the project had running and
  // starts the window over — forty pieces of state, an undo stack, a canvas
  // holding a page, a watcher and a dev server all belong to the project that
  // was open, and a fresh renderer is the only way to be certain none of it is
  // still here when the next one opens. `next` is the project to open after,
  // which main holds for the window that comes back: a choice made before a
  // reload has to survive it. Anything unsaved goes to disk first.
  const leaveProject = useCallback(
    async (next: string | undefined = undefined) => {
      try {
        await flushSave();
      } catch (error: unknown) {
        showToast(`Couldn’t close the project: ${cleanError(error)}`, 'error');
        return;
      }
      await closeProject(next);
    },
    [flushSave, showToast],
  );
  return { autosave, dropPageHistory, flushSave, historyRef, leaveProject, pageLoadRef };
}

// Opening a page or a component file for editing.
function useOpenFile(
  flushing: ReturnType<typeof useFlushing>,
  toasts: ReturnType<typeof useToasts>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { dropPageHistory, flushSave, pageLoadRef } = flushing;
  const { showToast } = toasts;
  const { pageStateRef, setCurrentPage, setEditStack, setHoverNodeId, setPageState } = coreState;
  const { setSelectedId } = coreState;

  // Opens any .astro file for editing — a page, or a component drilled into.
  // `currentPage` is simply whatever is being edited, so saving, undo, the
  // navigator, and the props panel all follow without special cases.
  const openFile = useCallback(
    async (entry: OpenFile, options: OpenFileOptions) => {
      const request = {};
      pageLoadRef.current = request;
      const latestRequest = () => request === pageLoadRef.current;
      if (!(await savedForNavigation(flushSave, latestRequest, showToast))) {
        return;
      }
      const beforeRead = pageStateRef.current;
      let result: EditorPageState;
      try {
        const read = await readPage(entry.path);
        result = toEditorPageState(read);
      } catch (error: unknown) {
        if (request === pageLoadRef.current) {
          showToast(`Couldn’t open ${entry.name}: ${cleanError(error)}`, 'error');
        }
        return;
      }
      if (request !== pageLoadRef.current) {
        return;
      }
      // The existing editor stays mounted while reading. Save anything typed
      // in that interval before handing the editor to the destination file.
      if (!(await savedForNavigation(flushSave, latestRequest, showToast))) {
        return;
      }
      const latest = pageStateRef.current;
      // Reopening the same file must not replace an edit made during the read
      // with the older snapshot that read returned.
      if (
        latest.currentPage?.path === entry.path &&
        latest.pageState &&
        latest.pageState !== beforeRead.pageState
      ) {
        result = latest.pageState;
      }
      const nextState = result;
      // Publish path, model and stack together. Clearing the model first would
      // unmount the inspector and resize the whole preview during every drill.
      pageStateRef.current = { currentPage: entry, pageState: nextState };
      setEditStack(options.nextStack);
      setCurrentPage(entry);
      setPageState(nextState);
      setHoverNodeId(undefined);
      const start = openFileSelection(entry, result, options.selectionPath);
      setSelectedId(start?.id ?? undefined);
      dropPageHistory(); // page snapshots don't apply to another page; commands stay
    },
    [
      flushSave,
      showToast,
      dropPageHistory,
      pageLoadRef,
      pageStateRef,
      setCurrentPage,
      setEditStack,
      setHoverNodeId,
      setPageState,
      setSelectedId,
    ],
  );
  return { openFile };
}

// Opening a page, and opening a project.
function useSelectPage(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { openFile, rescan, showToast, startPreview } = lifecycle;
  const { setBusy, setDevice, setLeftTab, setProject } = coreState;

  // What's typed in the URL bar while it's being edited; undefined means "show the
  // real one". Kept separate so the bar keeps tracking the canvas until you
  // actually start typing.
  const [urlDraft, setUrlDraft] = useState<string | undefined>(undefined);

  const selectPage = useCallback(
    async (page: ScanResult['pages'][number]) => {
      // Opening a page from the switcher leaves any component drill-down.
      const entry: OpenFile = { ...page, kind: 'page' };
      await openFile(entry, { nextStack: [entry], selectionPath: undefined });
    },
    [openFile],
  );

  const loadProject = useCallback(
    async (projectPath: string) => {
      const name = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
      setProject({ path: projectPath, name });
      setLeftTab('navigator');
      // Every project opens on desktop — a breakpoint left over from the
      // last project isn't a choice the user made about this one.
      setDevice('desktop');
      void addRecentProject(projectPath).catch(() => {});
      const result = await rescan(projectPath);

      const hasDeps = await projectHasNodeModules(projectPath);
      if (!hasDeps) {
        try {
          await installProjectDependencies(projectPath);
        } catch (error: unknown) {
          showToast(cleanError(error), 'error');
        }
        setBusy(undefined);
      }
      // startPreview reports its own failure in the preview area.
      void startPreview(projectPath);
      void watchProject(projectPath).catch(() => {});

      const first =
        result.pages.find((page) => page.name === 'index.astro') || result.pages[0] || undefined;
      if (first) {
        // Opening a page reports its own failures as toasts.
        void selectPage(first);
      }
    },
    [rescan, startPreview, selectPage, showToast, setBusy, setDevice, setLeftTab, setProject],
  );

  // A window can come up owing a project: one was picked from the menu and the
  // window reloaded to let go of the last one, or (in dev) the code was reloaded
  // under a project that was open. Nothing on a cold start and after a window
  // somebody closed, both of which belong on the welcome screen.
  const reopenedRef = useRef(false);
  useEffect(() => {
    if (reopenedRef.current || !window.avb.pendingProject) {
      return;
    }
    reopenedRef.current = true;
    pendingProject()
      .then((path) => {
        if (path) {
          return loadProject(path);
        }
        return undefined;
      })
      .catch(() => {});
  }, [loadProject]);
  return { loadProject, selectPage, setUrlDraft, urlDraft };
}

// The project menu, and pointing the canvas at an injected route.
function useProjectMenu(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  selectPageScope: ReturnType<typeof useSelectPage>,
) {
  const { projectRef, setCurrentPage, setEditStack, setHoverNodeId, setPageState } = coreState;
  const { setSelectedId } = coreState;
  const { flushSave, leaveProject, pageLoadRef, reportFailure, showToast } = lifecycle;
  const { loadProject } = selectPageScope;

  useEffect(() => {
    const offClose = window.avb.onMenu('closeProject', () => {
      if (projectRef.current) {
        void leaveProject();
      }
    });
    const openFromMenu = async (): Promise<void> => {
      const picked = await openProject();
      const next = !picked.canceled && 'projectPath' in picked ? picked.projectPath : undefined;
      if (!next) {
        return;
      }
      // Nothing open yet: this IS the welcome screen's own button.
      if (!projectRef.current) {
        await loadProject(next);
        return;
      }
      await leaveProject(next);
    };
    const offOpen = window.avb.onMenu('openProject', () => {
      void openFromMenu().catch(reportFailure);
    });
    return () => {
      offClose?.();
      offOpen?.();
    };
  }, [leaveProject, loadProject, reportFailure, projectRef]);

  // An injected route has no file in this project to open — its source lives
  // in a dependency — so this points the canvas at it and leaves the editor
  // empty rather than pretending there is a model behind it.
  const selectRoute = useCallback(
    async (entry: WireInjectedRoute) => {
      const request = {};
      pageLoadRef.current = request;
      const latestRequest = () => request === pageLoadRef.current;
      if (!(await savedForNavigation(flushSave, latestRequest, showToast))) {
        return;
      }
      setEditStack([]);
      setCurrentPage({ kind: 'route', name: entry.route, route: entry.route, from: entry.from });
      setPageState(undefined);
      setSelectedId(undefined);
      setHoverNodeId(undefined);
    },
    [
      flushSave,
      showToast,
      pageLoadRef,
      setCurrentPage,
      setEditStack,
      setHoverNodeId,
      setPageState,
      setSelectedId,
    ],
  );
  return { selectRoute };
}

// Enter in the URL bar.
function useGoToUrl(
  selectPageScope: ReturnType<typeof useSelectPage>,
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { selectPage, setUrlDraft } = selectPageScope;
  const { scan } = coreState;
  const { showToast } = lifecycle;

  // Enter in the URL bar. A route names a page file, so this switches the
  // editor to it rather than pointing the canvas somewhere the panels know
  // nothing about — the model and the canvas showing different pages is the
  // one state the app can't represent.
  const goToUrl = useCallback(
    (typed: string) => {
      setUrlDraft(undefined);
      const raw = String(typed || '').trim();
      if (!raw) {
        return;
      }
      // Accept a full URL or a bare path.
      let route = raw;
      const match = raw.match(/^https?:\/\/[^/]+(\/.*)?$/i);
      if (match) {
        route = match[1] || '/';
      }
      if (!route.startsWith('/')) {
        route = '/' + route;
      }
      route = route.replace(/\?.*$|#.*$/, '');
      const norm = (value: string): string => (value !== '/' ? value.replace(/\/$/, '') : value);
      const page = (scan.pages || []).find((candidate) => norm(candidate.route) === norm(route));
      if (page) {
        // Opening a page reports its own failures.
        void selectPage(page);
        return;
      }
      showToast(`No page matches ${route}`, 'error');
    },
    [scan.pages, showToast, selectPage, setUrlDraft],
  );
  return { goToUrl };
}

// Reading the open file again from disk.
function useReload(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { pageStateRef, projectRef, setCodeWin, setCurrentPage, setEditStack } = coreState;
  const { setPageState, setRefreshKey, setSelectedId } = coreState;
  const { dropPageHistory, editDrafts, openFile, pageLoadRef, rescan } = lifecycle;
  const { setConflictReason } = lifecycle;

  // Re-reads whatever is open straight from disk. A git checkout rewrites the
  // working tree wholesale, and the file watcher can't be relied on for it:
  // events for files the app itself wrote moments earlier are suppressed (so
  // its own save isn't echoed back), which is exactly the case when you edit,
  // switch branch, and expect to see the other branch's content.
  const reloadFromDisk = useCallback(async () => {
    const proj = projectRef.current;
    const { currentPage: open, pageState: state } = pageStateRef.current;
    const request = pageLoadRef.current;
    const stillCurrent = () =>
      request === pageLoadRef.current &&
      pageStateRef.current.currentPage === open &&
      pageStateRef.current.pageState === state;
    if (!proj) {
      return;
    }
    const result = await rescan(proj.path);
    if (!open || open.kind === 'route' || !stillCurrent()) {
      return;
    }
    // The open file may not exist on the branch just switched to.
    const stillThere = scanContainsFile(result, open.path);
    if (stillThere) {
      const read = await readPage(open.path);
      if (!stillCurrent()) {
        return;
      }
      // Deliberate: this discards local edits, including a conflicted page's.
      // Handles still carry where the bytes allow, so the selection stays.
      editDrafts.discard(open.path);
      setConflictReason(undefined);
      setPageState((current) => toEditorPageState(carriedParse(current, read)));
      dropPageHistory(); // page snapshots don't apply to another page; commands stay
    } else {
      const next = result.pages[0] || undefined;
      if (next) {
        const entry: OpenFile = { ...next, kind: 'page' };
        await openFile(entry, { nextStack: [entry], selectionPath: undefined });
      } else {
        setEditStack([]);
        setCurrentPage(undefined);
        setPageState(undefined);
        setSelectedId(undefined);
      }
    }
    setRefreshKey((count) => count + 1); // the preview is showing the old branch too
  }, [
    rescan,
    openFile,
    editDrafts,
    dropPageHistory,
    pageLoadRef,
    pageStateRef,
    projectRef,
    setConflictReason,
    setCurrentPage,
    setEditStack,
    setPageState,
    setRefreshKey,
    setSelectedId,
  ]);

  const completePropertySave = useCallback(async () => {
    // A floating source window may hold a pre-rename consumer. It was flushed
    // before the transaction; close it so later typing cannot restore stale source.
    setCodeWin(undefined);
    await reloadFromDisk();
  }, [reloadFromDisk, setCodeWin]);
  return { completePropertySave, reloadFromDisk };
}

// Drilling into a component.
function useOpenComponent(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { editStackRef, pageStateRef, projectRef, scan } = coreState;
  const { openFile, pageLoadRef, showToast } = lifecycle;

  // Drill into a component: its own file becomes the edited document, and the
  // stack remembers what to come back to (pages and components alike, so
  // nesting works to any depth).
  const openComponent = useCallback(
    async (
      name: string,
      hostPath: string | undefined,
      hostOcc = 0,
      filePath: string | undefined = undefined,
    ) => {
      // A tag is only a local binding — `import Layout from
      // '@/layouts/BaseLayout.astro'` renders as <Layout> — so follow the
      // page's own import first, and fall back to matching by filename.
      const { currentPage: host, pageState: state } = pageStateRef.current;
      const request = pageLoadRef.current;
      const spec = (state?.editable ? state.model.imports : []).find(
        (item) => item.name === name,
      )?.path;
      let comp = undefined;
      // A caller that already knows the file means THAT file — the instances
      // popup names a component by where it lives, and two folders can hold
      // the same basename.
      if (filePath) {
        comp = componentAtPath(scan, name, filePath);
      }
      if (!comp && spec && host?.path) {
        const projectPath = projectRef.current?.path;
        if (!projectPath) {
          return;
        }
        const file = await resolveProjectImport(projectPath, host.path, spec);
        if (request !== pageLoadRef.current || pageStateRef.current.currentPage !== host) {
          return;
        }
        if (file && /\.astro$/i.test(file)) {
          const fileName = file.split('/').pop();
          assert(fileName !== undefined, 'Resolved component path has a filename');
          comp = { name: fileName.replace(/\.astro$/i, ''), path: file };
        } else if (file) {
          // A framework island (.jsx/.svelte/…) has no Astro tree to show.
          showToast(
            `<${name}> is a ${file.split('.').pop()} component — edit it in code.`,
            'error',
          );
          return;
        }
      }
      comp = comp || componentNamed(scan, name);
      if (!comp) {
        showToast(`Can't find a file for <${name}>.`, 'error');
        return;
      }
      const nodes = state?.editable ? state.model.nodes : [];
      const instance = { path: hostPath, occurrence: hostOcc };
      const entry = componentEntry(editStackRef.current, nodes, comp, instance);
      await openFile(entry, { nextStack: stackWith(entry), selectionPath: undefined });
    },
    [scan, openFile, showToast, editStackRef, pageLoadRef, pageStateRef, projectRef],
  );
  return { openComponent };
}

// Backing out of a component, and previewing an earlier version.
function useCommitPreview(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { editStackRef, project, setBusy, setPreviewInfo, setPreviewRef } = coreState;
  const { openFile, showToast } = lifecycle;

  // Back out one level: to the parent component if nested, else to the page.
  const closeComponent = useCallback(async () => {
    const stack = editStackRef.current;
    if (stack.length < 2) {
      return;
    }
    const closing = stack.at(-1);
    assert(closing, 'Component stack must contain the component being closed');
    const next = stack.slice(0, -1);
    const parent = next.at(-1);
    assert(parent, 'Component stack must retain its parent');
    await openFile(parent, {
      nextStack: next,
      selectionPath: closing.hostKey ?? undefined,
    });
  }, [openFile, editStackRef]);

  // ----------------------------------------------------------------
  // Undo / redo
  //
  // One stack for the whole app, so ⌘Z means "undo the last thing I did"
  // wherever focus happens to be. Two kinds of entry live in it:
  //
  //   snapshot — the page model (or raw source) before an edit. Cheap to take
  //              and restores structure exactly, but only meaningful for the
  //              page it came from, so these are dropped when a page closes.
  //   command  — an {undo, redo} pair for anything outside the page model:
  //              a CSS file, a CMS entry, an asset rename. Each records how to
  //              put things back, so these survive page switches.
  // ----------------------------------------------------------------

  // Previewing an old version points the canvas at a second dev server running
  // against a checkout of that commit, and makes the editor read-only. The
  // read-only part is not decoration: the files behind that server are a
  // disposable checkout, so anything typed into them would be thrown away the
  // moment the preview ends, with nothing to say it had happened.
  const previewCommit = useCallback(
    async (commit: WireCommitInfo) => {
      if (!project) {
        return;
      }
      assert(commit.hash, 'Previewed commit must have a hash');
      setBusy('Getting that version ready…');
      try {
        const preview = await previewProjectCommit(project.path, commit.hash);
        setPreviewRef(commit.hash);
        setPreviewInfo({ url: preview.url, subject: commit.subject, when: commit.when });
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      } finally {
        setBusy(undefined);
      }
    },
    [project, showToast, setBusy, setPreviewInfo, setPreviewRef],
  );

  // Named apart from exitPreview below, which is the app's own interactive
  // preview mode — a different thing entirely.
  const exitCommitPreview = useCallback(async () => {
    setPreviewRef(undefined);
    setPreviewInfo(undefined);
    if (project) {
      await stopProjectCommitPreview(project.path).catch(() => {});
    }
  }, [project, setPreviewInfo, setPreviewRef]);

  // Leaving the project (or closing it) must not leave a second server and a
  // checkout behind inside it.
  const openProjectPath = project?.path;
  useEffect(() => {
    if (openProjectPath === undefined) {
      return undefined;
    }
    return () => {
      void stopProjectCommitPreview(openProjectPath).catch(() => {});
    };
  }, [openProjectPath]);
  return { closeComponent, exitCommitPreview, previewCommit };
}

// The git state the History panel and the branch chip share.
function useGitInfo(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { project, refreshKey, setGitInfo } = coreState;
  const { showToast } = lifecycle;

  const refreshGit = useCallback(async () => {
    if (!project) {
      return undefined;
    }
    const result = await readGitInfo(project.path);
    if (!result.ok) {
      showToast(result.error, 'error');
      return undefined;
    }
    setGitInfo(result.value);
    return result.value;
  }, [project, showToast, setGitInfo]);

  useEffect(() => {
    // A failed read is reported by refreshGit itself.
    void refreshGit();
  }, [refreshGit, refreshKey]);
  return { refreshGit };
}

// Recording undo steps.
function useHistoryPush(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { pageStateRef } = coreState;
  const { historyRef } = lifecycle;

  // The undo step of an edit of the open page (step 9: undo is inverse
  // splices only): its record collects each applied write's inverse.
  // Consecutive edits with the same coalesceKey within 800 ms share one step
  // (typing bursts, dropdown hover-scrubs); structural edits (no key) always
  // get their own.
  const pushEditHistory = useCallback(
    (coalesceKey: string | undefined): EditsRecord => {
      const record: EditsRecord = { outcome: { tag: 'applied', applied: [] } };
      if (!pageStateRef.current.pageState) {
        record.outcome = { tag: 'dropped' };
        return record;
      }
      const history = historyRef.current;
      const now = Date.now();
      const previous = history.past[history.past.length - 1];
      const coalesce =
        coalesceKey !== undefined &&
        coalesceKey === history.lastKey &&
        now - history.lastPush < 800;
      history.future = [];
      history.lastKey = coalesceKey;
      history.lastPush = now;
      if (coalesce && previous?.kind === 'edits') {
        return previous.record;
      }
      history.past.push({ kind: 'edits', record });
      if (history.past.length > LIMITS.undoEntriesMax) {
        history.past.shift();
      }
      return record;
    },
    [historyRef, pageStateRef],
  );

  // Records an already-performed change from outside the page model. `undo`
  // and `redo` are async and do the work themselves (rewrite the file, restore
  // the entry, rename back). Consecutive commands sharing a coalesceKey inside
  // the same burst collapse into one step, so a slider drag or a run of live
  // CSS writes is a single ⌘Z — the first one's `undo` (the oldest state) is
  // kept and the newest `redo` replaces the previous.
  const pushCommand = useCallback(
    (cmd: Omit<UndoCommand, 'kind'>) => {
      const history = historyRef.current;
      const now = Date.now();
      const previous = history.past[history.past.length - 1];
      const coalesce =
        cmd.coalesceKey !== undefined &&
        cmd.coalesceKey === history.lastKey &&
        now - history.lastPush < 800 &&
        previous?.kind === 'cmd' &&
        previous.coalesceKey === cmd.coalesceKey;
      if (coalesce) {
        previous.redo = cmd.redo;
        if (cmd.label !== undefined) {
          previous.label = cmd.label;
        }
      } else {
        history.past.push({ kind: 'cmd', ...cmd });
        if (history.past.length > LIMITS.undoEntriesMax) {
          history.past.shift();
        }
      }
      history.future = [];
      history.lastKey = cmd.coalesceKey ?? undefined;
      history.lastPush = now;
    },
    [historyRef],
  );
  const pushCommandRef = useRef<((command: Omit<UndoCommand, 'kind'>) => void) | undefined>(
    undefined,
  );
  pushCommandRef.current = pushCommand;
  return { pushCommand, pushEditHistory };
}

// Undoing a component property batch.
function usePropertyUndo(
  navigation: ReturnType<typeof useNavigation>,
  historyPush: ReturnType<typeof useHistoryPush>,
) {
  const { completePropertySave } = navigation;
  const { pushCommand } = historyPush;

  // Step 6: a property batch's undo is its inverse batch, held by main under a
  // token; applying one returns the token of the batch that redoes it. A file
  // changed since refuses the whole undo, naming it (componentProperties.ts).
  const recordPropertyUndo = useCallback(
    (token: string) => {
      let next = token;
      const step = async (): Promise<void> => {
        const reverted = await revertComponentProperties(next);
        if (!reverted.ok) {
          throw new Error(reverted.error.message);
        }
        next = reverted.value.undo;
        // As after the edit itself: the panel, the page and the scan re-read.
        await completePropertySave();
      };
      pushCommand({ label: 'the property change', undo: step, redo: step });
    },
    [pushCommand, completePropertySave],
  );
  return { recordPropertyUndo };
}

// Installing the parse of typed code.
function useTypedParse(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { pageStateRef, setPageState, setSelectedId, typedSourceRef } = coreState;
  const { showToast } = lifecycle;

  // The typed text's parse: a model to show when it parses, the parse-error
  // panel when it does not (plan §3.6). Installed only over the same text: the
  // text orders parses, so no counter does — a parse of text typed over since
  // is dropped, and the parse of the newest text is on its way.
  const parseTypedCode = useCallback(
    async (pagePath: string, source: string, position: number): Promise<void> => {
      let parsed: Awaited<ReturnType<typeof parseSourcePage>>;
      try {
        parsed = await parseSourcePage(pagePath, source);
      } catch (error: unknown) {
        if (typedSourceRef.current === source) {
          typedSourceRef.current = undefined;
          showToast(`Couldn’t update code: ${cleanError(error)}`, 'error');
        }
        return;
      }
      if (pageStateRef.current.currentPage?.path !== pagePath) {
        return;
      }
      if (typedSourceRef.current === source) {
        typedSourceRef.current = undefined;
      }
      // The ref may not show the typed text yet (a fast parse beats the render);
      // the page it shows is what handles are carried from, and whether this
      // parse is still of the page's text is decided when it is installed.
      const local = pageStateRef.current.pageState;
      if (!local) {
        return;
      }
      // Handles carried from the page shown by the text diff, so the editors it
      // feeds keep their keys and focus per keystroke (issue #29). Typed text is
      // no bytes on disk: the origin stays the last one a save left.
      const carried = carriedParse(local, parsed);
      const installed = (current: EditorPageState): EditorPageState => {
        if (!carried.editable) {
          const { reason, bail } = carried;
          return { editable: false, reason, bail, source, save: current.save };
        }
        const origin = current.editable ? current.origin : undefined;
        const model: EditorModel = carried.model;
        return { editable: true, model, source, parsedFrom: source, save: current.save, origin };
      };
      if (carried.editable) {
        const inFrontmatter =
          carried.model.bodyStart !== undefined && position < carried.model.bodyStart;
        const selected = sourceNodeAtOffset(carried.model.nodes, position);
        setSelectedId(inFrontmatter ? 'frontmatter' : (selected?.id ?? undefined));
      } else {
        setSelectedId(undefined);
      }
      // The save state is whatever is current when this lands: a conflicted
      // page stays conflicted, and a save that landed meanwhile keeps its base.
      setPageState((current) =>
        current && current.source === source ? installed(current) : current,
      );
    },
    [showToast, pageStateRef, setPageState, setSelectedId, typedSourceRef],
  );

  const scheduleSaveRef = useRef<((urgency?: boolean | 'live') => void) | undefined>(undefined);

  // Undo and redo rewrite files and the page model under whatever is reading
  // them; bumping this tells the style panel to re-read rather than wait for
  // its own polling to notice.
  const [historyTick, setHistoryTick] = useState(0);
  return { historyTick, parseTypedCode, scheduleSaveRef, setHistoryTick };
}

// Undoing or redoing one step of page edits.
function useStepEdits(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { autosave, editDrafts, historyRef, showToast } = lifecycle;
  const { pageStateRef, setPageState, setSelectedId } = coreState;

  // Undo or redo one gesture sent as edit requests (step 6): its inverses go
  // out as reverts, newest first, each against the checksum it came back with,
  // so an outside edit since is mapped through or refused — never reverted.
  // What was undone becomes the step in the other direction; a refusal stops
  // there, keeps what is left where it was, and says why (plan §7).
  const stepEdits = useCallback(
    async (entry: EditsEntry, direction: 'undo' | 'redo') => {
      const history = historyRef.current;
      const back = (next: EditsEntry) =>
        (direction === 'undo' ? history.past : history.future).push(next);
      const forth = (next: HistoryEntry) =>
        (direction === 'undo' ? history.future : history.past).push(next);
      try {
        await autosave(); // Its own writes' answers first.
      } catch {
        /* reported by the save itself; the checks below decide */
      }
      const path = pageStateRef.current.currentPage?.path;
      const state = pageStateRef.current.pageState;
      if (!path || !state) {
        return;
      } // its page is gone — nothing to restore onto
      const outcome = entry.record.outcome;
      if (outcome.tag !== 'applied' || !editDrafts.empty(path) || state.save.tag !== 'clean') {
        // Edits that have not reached disk (refused, or failing) come first:
        // an inverse names the bytes its write left, and the page is not there.
        back(entry);
        showToast(`Couldn’t ${direction}: this page has edits that are not saved yet.`, 'error');
        return;
      }
      const startOrigin = state.editable ? state.origin : undefined;
      const reverted = await revertedSteps(path, outcome.applied, startOrigin);
      if (reverted.refusal !== undefined) {
        showToast(`Couldn’t ${direction}: ${reverted.refusal}`, 'error');
      }
      const { done, written, origin } = reverted;
      const left = outcome.applied.slice(0, outcome.applied.length - done.length);
      if (left.length > 0) {
        back({ kind: 'edits', record: { outcome: { tag: 'applied', applied: left } } });
      }
      if (written === undefined) {
        return;
      }
      forth({ kind: 'edits', record: { outcome: { tag: 'applied', applied: done } } });
      const reply = written;
      const shown =
        origin === undefined
          ? toEditorPageState(carriedParse(state, reply))
          : toEditorPageState({ ...reply, editable: true, model: origin.model });
      // Installed only over the state the undo started from: a newer edit
      // made meanwhile keeps its model, and main rebases it past the revert.
      setPageState((current) => (current === state ? shown : current));
      if (shown.editable) {
        const model = shown.model;
        const named = (id: string) => id === 'layout' || id === 'frontmatter';
        const gone = (id: string) => !named(id) && !findNodeById(model.nodes, id);
        setSelectedId((id) => (id && gone(id) ? undefined : id));
      }
    },
    [autosave, editDrafts, showToast, historyRef, pageStateRef, setPageState, setSelectedId],
  );
  return { stepEdits };
}

// Undo and redo.
function useUndoRedo(
  coreState: ReturnType<typeof useCoreState>,
  typedParse: ReturnType<typeof useTypedParse>,
  lifecycle: ReturnType<typeof useLifecycle>,
  stepEditsScope: ReturnType<typeof useStepEdits>,
) {
  const { propertySave } = coreState;
  const { setHistoryTick } = typedParse;
  const { historyRef, showToast } = lifecycle;
  const { stepEdits } = stepEditsScope;

  const undo = useCallback(async () => {
    if (propertySave.saving.current) {
      return;
    }
    setHistoryTick((count) => count + 1);
    const history = historyRef.current;
    history.lastKey = undefined;
    history.lastPush = 0;
    const entry = effective(history.past);
    if (!entry) {
      return;
    }
    if (entry.kind === 'cmd') {
      history.future.push(entry);
      try {
        await entry.undo();
      } catch (error: unknown) {
        showToast(
          `Couldn’t undo${entry.label ? ` ${entry.label}` : ''}: ${cleanError(error)}`,
          'error',
        );
      }
      return;
    }
    await stepEdits(entry, 'undo');
  }, [showToast, propertySave.saving, stepEdits, historyRef, setHistoryTick]);

  const redo = useCallback(async () => {
    if (propertySave.saving.current) {
      return;
    }
    setHistoryTick((count) => count + 1);
    const history = historyRef.current;
    history.lastKey = undefined;
    history.lastPush = 0;
    const entry = effective(history.future);
    if (!entry) {
      return;
    }
    if (entry.kind === 'cmd') {
      history.past.push(entry);
      try {
        await entry.redo();
      } catch (error: unknown) {
        showToast(
          `Couldn’t redo${entry.label ? ` ${entry.label}` : ''}: ${cleanError(error)}`,
          'error',
        );
      }
      return;
    }
    await stepEdits(entry, 'redo');
  }, [showToast, propertySave.saving, stepEdits, historyRef, setHistoryTick]);
  return { redo, undo };
}

// Scheduling saves, and reviewing a conflict in code.
function useScheduleSave(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  typedParse: ReturnType<typeof useTypedParse>,
  historyPush: ReturnType<typeof useHistoryPush>,
) {
  const { pageStateRef, saveTimer, setLeftTab, setPageState } = coreState;
  const { autosave, editDrafts, showToast } = lifecycle;
  const { scheduleSaveRef } = typedParse;
  const { pushEditHistory } = historyPush;

  // Discrete edits (dropdown, checkbox, drag, delete) save immediately;
  // typing batches keystrokes for 300 ms so the preview doesn't rebuild
  // per character. The timeout-0 for immediate saves lets React commit the
  // state update first so flushSave sees the new model.
  //
  // 'live' is the third case: a style-panel scrub or mid-typing write, which
  // arrives already debounced (100 ms at the field) and is watched on the
  // canvas as it happens. Making it wait out the typing pause too put nearly
  // half a second between the drag and the result. It still coalesces, just
  // over the gap between two ticks rather than the gap between two words.
  const scheduleSave = useCallback(
    (immediate: boolean | 'live' = false) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => {
          autosave().catch((error: unknown) =>
            showToast(`Save failed: ${cleanError(error)}`, 'error'),
          );
        },
        saveDelay({ urgency: immediate }),
      );
    },
    [autosave, showToast, saveTimer],
  );
  scheduleSaveRef.current = scheduleSave;

  // The conflict notice's actions (plan §7). Reload lives in reloadFromDisk.
  // Review shows the unsaved version as text. Typed code already is text;
  // unsaved gestures are a model, printed for the review, and from then on the
  // page's edits are that text — kept, it is saved as a patch of whatever the
  // disk holds (plan §3.6), never as a whole model.
  const reviewConflictInCode = useCallback(async () => {
    const { currentPage: open, pageState: state } = pageStateRef.current;
    if (!open?.path || state?.save.tag !== 'conflicted') {
      return;
    }
    const typed = editDrafts.entries(open.path).some((entry) => entry.tag === 'code');
    if (state.editable && !typed) {
      let source: string;
      try {
        const shown = await reviewedSource(open.path, state, editDrafts.entries(open.path));
        if (shown.tag === 'failed') {
          showToast(`Couldn’t show your version: ${shown.message}`, 'error');
          return;
        }
        source = shown.source;
        if (shown.withdrawn > 0) {
          const edits = shown.withdrawn === 1 ? 'One edit' : `${shown.withdrawn} edits`;
          const verb = shown.withdrawn === 1 ? 'is' : 'are';
          showToast(`${edits} can’t be made visually and ${verb} left out.`, 'info');
        }
      } catch (error: unknown) {
        showToast(`Couldn’t show your version: ${cleanError(error)}`, 'error');
        return;
      }
      const latest = pageStateRef.current.pageState;
      if (latest?.editable && latest.model === state.model) {
        const record = pushEditHistory('code-source');
        const typed = { save: latest.save, source, origin: latest.origin };
        editDrafts.typeCode(open.path, typed, record);
        setPageState((current) =>
          current?.editable && current.model === state.model ? { ...current, source } : current,
        );
      }
    }
    setLeftTab('code');
  }, [editDrafts, pushEditHistory, showToast, pageStateRef, setLeftTab, setPageState]);
  return { reviewConflictInCode, scheduleSave };
}

// Committing a gesture, and keeping the local version of a conflict.
function useCommitEdit(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
  scheduleSaveScope: ReturnType<typeof useScheduleSave>,
  historyPush: ReturnType<typeof useHistoryPush>,
) {
  const { editDrafts, setConflictReason, showToast } = lifecycle;
  const { pageStateRef, propertySave, setPageState, typedCodeUnparsed } = coreState;
  const { scheduleSave } = scheduleSaveScope;
  const { pushEditHistory } = historyPush;

  // Deliberate: the user saw the conflict and keeps the local text, so it now
  // saves over what is on disk (and conflicts again if the disk moves again).
  const keepLocalVersion = useCallback(() => {
    setConflictReason(undefined);
    const path = pageStateRef.current.currentPage?.path;
    if (path) {
      editDrafts.acceptDisk(path);
    } // typed code now patches the disk's text
    setPageState((current) =>
      current?.save.tag === 'conflicted'
        ? { ...current, save: saveStateAccepted(current.save) }
        : current,
    );
    scheduleSave(true);
  }, [scheduleSave, editDrafts, pageStateRef, setConflictReason, setPageState]);

  // A gesture (step 9: every gesture has an intent form, editGestures.ts): its
  // effect shows at once, and it is queued to go to disk as edit requests,
  // stated when sent against the page the app's last reply left — so a node a
  // gesture just created is there to name. A Markdown or MDX page saves its
  // whole model until step 10. Past the queue's bound a gesture is refused,
  // never queued (plan §8); one the engine cannot reach at all (a node another
  // file holds) is refused before it shows.
  const commitEdit = useCallback(
    (gesture: EditGesture) => {
      if (propertySave.saving.current) {
        return;
      }
      const { currentPage, pageState: state } = pageStateRef.current;
      const path = currentPage?.path;
      if (!path || !state?.editable || typedCodeUnparsed()) {
        return;
      }
      // Every page's gestures are edit requests (step 10: Markdown and MDX
      // too). Without an origin — typed code made the page parse and is not
      // saved yet — no node can be named until that save replies.
      const origin = state.origin;
      const unreachable =
        origin === undefined || gesture.request((id) => nodeRefIn(origin, id)) === undefined;
      if (editDrafts.empty(path) && unreachable) {
        // Nothing queued could have made its node: it is out of reach.
        showToast('That edit can’t be made visually here — edit it in the code panel.', 'error');
        return;
      }
      if (editDrafts.entries(path).length >= LIMITS.intentsPendingMax) {
        showToast('Too many edits are waiting to be saved — try again in a moment.', 'error');
        return;
      }
      const record = pushEditHistory(gesture.coalesceKey);
      const queued = editDrafts.addGesture(path, gesture, record);
      assert(queued === 'queued', 'A gesture inside the bound is queued');
      setPageState((current) =>
        current?.editable
          ? { ...current, model: gesture.apply(current.model), save: saveStateEdited(current.save) }
          : current,
      );
      scheduleSave(gesture.urgency);
    },
    [
      scheduleSave,
      pushEditHistory,
      propertySave.saving,
      editDrafts,
      typedCodeUnparsed,
      showToast,
      pageStateRef,
      setPageState,
    ],
  );
  return { commitEdit, keepLocalVersion };
}

// Typed code.
function useCodeSource(
  coreState: ReturnType<typeof useCoreState>,
  historyPush: ReturnType<typeof useHistoryPush>,
  lifecycle: ReturnType<typeof useLifecycle>,
  scheduleSaveScope: ReturnType<typeof useScheduleSave>,
  typedParse: ReturnType<typeof useTypedParse>,
) {
  const { pageStateRef, setPageState, typedSourceRef } = coreState;
  const { pushEditHistory } = historyPush;
  const { editDrafts } = lifecycle;
  const { scheduleSave } = scheduleSaveScope;
  const { parseTypedCode } = typedParse;

  // Typed code (step 8). The text is the page's edit: it is set at once, so a
  // save sends exactly what the editor holds and a save's reply can never be
  // installed over a newer keystroke. The model follows when main has parsed
  // the text; until then a gesture would edit a model the text has left, so
  // gestures wait (typedCodeUnparsed) — a window of one IPC round trip.
  // Returns the parse, for a caller that needs the model to have followed.
  const changeCodeSource = useCallback(
    (source: string, position: number): Promise<void> => {
      // No property-save guard, as before: the editor already shows the text,
      // so refusing it here would leave typing on screen that never saves.
      const { currentPage: open, pageState: shown } = pageStateRef.current;
      if (!open || open.kind === 'route' || !shown) {
        return Promise.resolve();
      }
      const record = pushEditHistory('code-source');
      const origin = shown.editable ? shown.origin : undefined;
      editDrafts.typeCode(open.path, { save: shown.save, source: shown.source, origin }, record);
      typedSourceRef.current = source;
      // The origin stays: typed text is no bytes on disk, and the code save's
      // reply moves the origin on.
      setPageState((current) =>
        current ? { ...current, source, save: saveStateEdited(current.save) } : current,
      );
      scheduleSave('live');
      return parseTypedCode(open.path, source, position);
    },
    [
      pushEditHistory,
      scheduleSave,
      editDrafts,
      parseTypedCode,
      pageStateRef,
      setPageState,
      typedSourceRef,
    ],
  );
  return { changeCodeSource };
}

// An edit made outside the app to a page with unsaved edits.
function useOutsideEdit(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { editDrafts, pageSaverRef, setConflictReason } = lifecycle;
  const { pageStateRef, setPageState } = coreState;

  // ----------------------------------------------------------------
  // External file changes → refresh panels
  // ----------------------------------------------------------------

  // An outside edit to a page with unsaved edits. Dropping it (the old
  // behaviour) let the pending save overwrite it; reloading would discard the
  // user's input. Neither is ours to decide, so it becomes a conflict and the
  // notice asks (plan §7). A write in flight is left to main's own guard.
  const surfaceOutsideEdit = useCallback(
    async (pagePath: string): Promise<void> => {
      const saver = pageSaverRef.current;
      const before = pageStateRef.current.pageState;
      assert(saver !== undefined, 'The page saver exists before any file event');
      if (!before || before.save.tag !== 'dirty' || saver.writing()) {
        return;
      }
      // Unsaved edits that are all requests map through an outside change or
      // are refused one by one, each with its reason (step 6): no page-wide
      // conflict for them.
      // Typed code is a patch too (step 8): it merges with the outside change
      // or comes back `merge-conflict` — also not a page-wide conflict here.
      if (!editDrafts.empty(pagePath)) {
        return;
      }
      const baseBefore = saveStateBase(before.save);
      let diskChecksum: Digest;
      try {
        diskChecksum = (await readPage(pagePath)).checksum;
      } catch {
        return; // gone or unreadable: the next save reports it
      }
      const latest = pageStateRef.current;
      if (latest.currentPage?.path !== pagePath || latest.pageState?.save.tag !== 'dirty') {
        return;
      }
      // A save that started or finished during the read moved the base, and its
      // own guard in main compares against the disk authoritatively.
      const base = saveStateBase(latest.pageState.save);
      if (saver.writing() || base !== baseBefore || diskChecksum === base) {
        return;
      }
      setConflictReason(undefined);
      setPageState((current) =>
        current?.save.tag === 'dirty'
          ? { ...current, save: saveStateRefused(current.save, base, diskChecksum) }
          : current,
      );
    },
    [editDrafts, pageSaverRef, pageStateRef, setConflictReason, setPageState],
  );
  return { surfaceOutsideEdit };
}

// Reconciling the open page with file changes.
function useFileEvents(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  outsideEdit: ReturnType<typeof useOutsideEdit>,
) {
  const { pageStateRef, projectRef, setCurrentPage, setPageState, setSelectedId } = coreState;
  const { dropPageHistory, pageLoadRef, rescan } = lifecycle;
  const { surfaceOutsideEdit } = outsideEdit;

  useEffect(() => {
    // Every file an event named since the last reconcile read them. A burst
    // of events shares one reconcile after it (src/lib/coalescedRun.ts): one scan
    // and one read per tick, and a reconcile begun after the last event sees
    // every file — no counter decides which answer wins.
    const pendingFiles = new Set<string>();
    let closed = false;
    const reconcile = createCoalescedRun(async (): Promise<void> => {
      const proj = projectRef.current;
      if (closed || !proj) {
        return;
      }
      let scanResult;
      try {
        scanResult = await rescan(proj.path);
      } catch {
        return;
      }
      // A newer event waits behind this run: its reconcile scans again, and
      // decides on every file named so far — a superseded scan never decides
      // that a page was deleted.
      if (reconcile.superseded()) {
        return;
      }
      const files = new Set(pendingFiles);
      pendingFiles.clear();
      const { currentPage: page, pageState: state } = pageStateRef.current;
      if (closed || !page || page.kind === 'route') {
        return;
      }
      // Chunk .html files feed the open page's Fragment subtrees — treat a
      // change to any of them like a change to the page itself.
      const chunk = [...files].some((file) => file.toLowerCase().endsWith('.html'));
      if (!files.has(page.path) && !chunk) {
        return;
      }
      // Current page deleted externally.
      if (!scanContainsFile(scanResult, page.path)) {
        pageLoadRef.current = {};
        setCurrentPage(undefined);
        setPageState(undefined);
        setSelectedId(undefined);
        return;
      }
      if (!state) {
        return;
      }
      const reload = { pageStateRef, surfaceOutsideEdit, setPageState, dropPageHistory };
      await reloadChangedPage(reload, { path: page.path, state, chunk }, () => closed);
    });
    const off = onFilesChanged(({ files }) => {
      for (const file of files) {
        pendingFiles.add(file);
      }
      // A reconcile gives up quietly on a read that fails; the next event retries it.
      void reconcile.request();
    });
    return () => {
      closed = true;
      off();
    };
  }, [
    rescan,
    surfaceOutsideEdit,
    dropPageHistory,
    pageLoadRef,
    pageStateRef,
    projectRef,
    setCurrentPage,
    setPageState,
    setSelectedId,
  ]);
}

// Placing a project component.
function useAddComponent(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { insertables, pageStateRef, projectRef, setSelectedId } = coreState;
  const { commitEdit } = history;

  const resolveImportPath = useCallback(
    async (targetPath: string) => {
      const page = pageStateRef.current.currentPage;
      const projectPath = projectRef.current?.path;
      if (!page?.path || !projectPath) {
        throw new Error('An open project page is required to resolve an import');
      }
      return findImportPath(projectPath, page.path, targetPath);
    },
    [pageStateRef, projectRef],
  );

  // target: {parentId: string | undefined, index: number} | undefined (append at end)
  const addComponent = useCallback(
    async (componentName: string, target: InsertTarget | undefined) => {
      const comp = insertables.find((component) => component.name === componentName);
      const page = pageStateRef.current.currentPage;
      if (!comp || !page) {
        return;
      }
      const paths = await resolveImportPath(comp.path);
      const id = newId();
      // A component whose default slot sits in a text context arrives with a
      // word in it, the way an inserted <h1> or <p> does — something on the
      // canvas to aim at. A wrapper whose slot holds blocks (ButtonWrapper,
      // Section) comes in empty: a stray "Text" there is only ever deleted.
      const takesText = (comp.slots || []).includes('default') && !!comp.slotText;
      const node: EditorNode = {
        id,
        kind: 'component',
        name: comp.name,
        props: {},
        children: takesText ? [{ id: newId(), kind: 'text', value: 'Text' }] : undefined,
      };
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      // Step 6, insert and frontmatter: the import when the page lacks it,
      // then the node — two requests, one undo step.
      const insert = insertGesture(state.model, node, target, { urgency: true });
      if (state.model.imports.some((i) => i.name === comp.name)) {
        commitEdit(insert);
      } else {
        const imported = (model: EditorModel): EditorModel => ({
          ...model,
          imports: [
            ...model.imports,
            { name: comp.name, path: chooseImportPath(model, paths), quote: "'" },
          ],
        });
        const options = { coalesceKey: undefined, urgency: true };
        commitEdit(sequence(frontmatterGesture(state.model, options, imported), insert));
      }
      setSelectedId(id);
    },
    [insertables, commitEdit, resolveImportPath, pageStateRef, setSelectedId],
  );
  return { addComponent, resolveImportPath };
}

// What a component would take as props, and where components are used.
function useComponentQueries(coreState: ReturnType<typeof useCoreState>) {
  const { pageStateRef, projectRef } = coreState;

  // The page values a subtree reads — the props it would need once it's a file
  // of its own. Asked twice (once to show in the dialog, once to act on) and
  // both times of the live model, so nothing can drift between them.
  const propsNeededFor = useCallback((model: EditorModel, node: EditorNode) => {
    if (!model || !node) {
      return [];
    }
    const scope = namesInScope(model.extraFrontmatter || '', model.imports || []);
    for (const variable of loopVarsAt(model.nodes, node.id)) {
      scope.add(variable);
    }
    // An imported component is carried across as an import, not passed as a prop.
    for (const imp of model.imports || []) {
      scope.delete(imp.name);
    }
    return propsForExtraction(node, scope);
  }, []);

  // Where a component is used, for the palette's instance count. Asked of the
  // project (not the open file) so it covers pages and components alike; the
  // component's own file is left out — a file is not one of its own users.
  const componentUsage = useCallback(
    async (comp: ScanComponent) => {
      if (!projectRef.current?.path) {
        return { files: [] };
      }
      try {
        return await readComponentUsage(projectRef.current.path, comp.name, comp.path);
      } catch (error: unknown) {
        // Reported, never swallowed into an empty list: "we couldn't look" and
        // "it isn't used anywhere" are opposite answers, and the second one is
        // the sort of thing somebody acts on.
        return { error: cleanError(error) };
      }
    },
    [projectRef],
  );

  // The instances in the file that's already open — those a click can select
  // rather than navigate to.
  const pageInstancesOf = useCallback(
    (name: string) => {
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      if (!model) {
        return [];
      }
      const out: { readonly id: string }[] = [];
      const walk = (list: readonly EditorNode[], depth: number): void => {
        assert(depth <= LIMITS.treeDepthMax, 'pageInstancesOf: depth exceeds the tree cap');
        for (const node of list || []) {
          if (node.kind === 'component' && node.name === name) {
            out.push({ id: node.id });
          }
          if (Array.isArray(node.children)) {
            walk(node.children, depth + 1);
          }
        }
      };
      walk(model.nodes, 0);
      return out;
    },
    [pageStateRef],
  );
  return { componentUsage, pageInstancesOf, propsNeededFor };
}

// Turning the selection into a component.
function useCreateComponent(
  coreState: ReturnType<typeof useCoreState>,
  componentQueries: ReturnType<typeof useComponentQueries>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef, projectRef, selectedIdRef, setSelectedId } = coreState;
  const { propsNeededFor } = componentQueries;
  const { rescan, showToast } = lifecycle;
  const { commitEdit } = history;

  // Turn what's selected into a component of its own: write the file, then
  // replace the element in the page with an instance of it. The markup MOVES —
  // the page ends up with `<Card />` where the element was — so this is one
  // edit to two files, and the component file is written first: a page that
  // imports a file that isn't there yet is a broken page, however briefly.
  const createComponentFromSelection = useCallback(
    async (name: string, options: { readonly withProps?: boolean } = {}) => {
      const { withProps = true } = options;
      const page = pageStateRef.current.currentPage;
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      const node =
        model && selectedIdRef.current
          ? findNodeById(model.nodes, selectedIdRef.current)
          : undefined;
      const projectPath = projectRef.current?.path;
      if (!page?.path || !model || !node || !projectPath) {
        return;
      }
      const props = withProps ? propsNeededFor(model, node) : [];
      let created;
      try {
        created = await createProjectComponent({
          projectPath,
          pagePath: page.path,
          name,
          nodes: node,
          imports: model.imports || [],
          props,
        });
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
        return;
      }
      const paths = await findImportPath(projectPath, page.path, created.path);
      const id = newId();
      // Step 9: the instance goes in before the markup, the markup comes out,
      // and the import follows — one undo step, the markup's bytes moved to
      // the new file rather than reprinted in the page.
      const now = pageStateRef.current.pageState;
      const shown = now?.editable ? now.model : undefined;
      const found = shown ? findWithParent(shown.nodes, node.id) : undefined;
      if (!shown || !found) {
        return;
      }
      const place = { parentId: found.parent?.id ?? undefined, index: found.index };
      const extracted = { id, name, props, place, paths };
      commitEdit(extractionGesture(shown, node.id, extracted));
      setSelectedId(id);
      await rescan(projectPath);
      // Anything left reading the page's scope can't be reconnected on its own
      // — an expression naming something that isn't a value the page holds, or
      // props turned off. The person who just moved it knows what it needs.
      const stranded = usesPageScope(node) && !props.length;
      showToast(createdComponentMessage(created.rel, props.length, { stranded }));
    },
    [
      commitEdit,
      propsNeededFor,
      rescan,
      showToast,
      pageStateRef,
      projectRef,
      selectedIdRef,
      setSelectedId,
    ],
  );
  return { createComponentFromSelection };
}

// Moving a node.
function useMoveNode(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { insertables, pageStateRef } = coreState;
  const { commitEdit } = history;
  const { showToast } = lifecycle;

  // Step 6, move: the node's own bytes are relocated, its note with it; a
  // `slot` that means nothing where it lands is dropped, and leaving a loop,
  // what read the loop's item becomes placeholder text (editGestures.ts).
  const moveNode = useCallback(
    (nodeId: string, target: InsertTarget | undefined) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      // `slot` is a word addressed to the component the node sat inside, and
      // means nothing anywhere else (src/editor/slotAttr.ts).
      const rules = {
        keepsSlot: (model: EditorModel, id: string): boolean => {
          const slot = findNodeById(model.nodes, id)?.props?.['slot'];
          const slotName = slot?.type === 'string' ? slot.value : undefined;
          const host = slotHostOf(model, id);
          const definition = host ? definitionOf(model, host, insertables) : undefined;
          return keepsSlotAttribute({ slotName, host, definition });
        },
      };
      const gesture = moveGesture(state.model, nodeId, target, rules, { urgency: true });
      if (!gesture) {
        return;
      }
      // Left a loop? Anything still reading its item would throw; say what
      // the move replaced.
      const before = loopVarsAt(state.model.nodes, nodeId);
      const after = loopVarsAt(gesture.apply(state.model).nodes, nodeId);
      const lost = before.filter((variable) => !after.includes(variable));
      const node = findNodeById(state.model.nodes, nodeId);
      const removed = node && lost.length ? strippedBindings(node, lost).removed : 0;
      commitEdit(gesture);
      if (removed) {
        showToast(
          `Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(
            ', ',
          )}.`,
          'info',
        );
      }
    },
    [insertables, commitEdit, showToast, pageStateRef],
  );
  return { moveNode };
}

// Removing a node.
function useRemoveNode(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef, setSelectedId } = coreState;
  const { showToast } = lifecycle;
  const { commitEdit } = history;

  const removeNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const target = findNodeById(state.model.nodes, nodeId);
      if (target?.kind === 'chunk-group') {
        showToast(
          'This section comes from the page frontmatter — remove it from the code instead.',
          'error',
        );
        return;
      }
      // Worked out against the tree as it stands, before the node is gone.
      const nextId = selectionAfterDelete(state.model, nodeId) ?? undefined;
      // Delete the node's note with it, or it would re-attach to whatever now
      // follows and read as that element's description. The note goes first.
      const found = findParentList(state.model, nodeId);
      const noteAt = found ? noteIndexAbove(found.list, found.index) : -1;
      const note = found && noteAt !== -1 ? found.list[noteAt] : undefined;
      const ids = note ? [note.id, nodeId] : [nodeId];
      const removal = removalGesture(ids, { urgency: true });
      const afterRemoval = removal.apply(state.model);
      const removed = prunedAfterRemoval(afterRemoval);
      // Step 6: the nodes go as requests, and what they leave unused in the
      // frontmatter as a frontmatter request after them (one undo step).
      const changed = frontmatterOf(removed.model) !== frontmatterOf(state.model);
      const prune = (model: EditorModel): EditorModel => prunedAfterRemoval(model).model;
      const options = { coalesceKey: undefined, urgency: true };
      const pruning = frontmatterGesture(afterRemoval, options, prune);
      commitEdit(changed ? sequence(removal, pruning) : removal);
      if (removed.dropped.length) {
        const names = removed.dropped;
        showToast(
          `Also removed ${names.map((name) => `\`${name}\``).join(', ')} from the frontmatter — ` +
            `nothing was reading ${names.length === 1 ? 'it' : 'them'} any more.`,
          'info',
        );
      }
      // Only the selection that just vanished moves — deleting some other row
      // (navigator menu, canvas) leaves what you were working on alone.
      setSelectedId((id) => (id === nodeId ? nextId : id));
    },
    [commitEdit, showToast, pageStateRef, setSelectedId],
  );

  // ----------------------------------------------------------------
  // Clipboard: copy / paste / duplicate nodes
  // ----------------------------------------------------------------

  const nodeClipboardRef = useRef<NodeClipboard | undefined>(undefined);
  return { nodeClipboardRef, removeNode };
}

// Copying and duplicating nodes.
function useCopyNode(
  coreState: ReturnType<typeof useCoreState>,
  removeNodeScope: ReturnType<typeof useRemoveNode>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef, setSelectedId } = coreState;
  const { nodeClipboardRef } = removeNodeScope;
  const { showToast } = lifecycle;
  const { commitEdit } = history;

  const copyNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const node = findNodeById(state.model.nodes, nodeId);
      if (!node) {
        return;
      }
      nodeClipboardRef.current = {
        node, // Readonly: later edits build new nodes and leave this one as copied.
        // The loop variables this subtree may reference; pasting somewhere
        // they don't exist has to drop those bindings.
        vars: loopVarsAt(state.model.nodes, nodeId),
        // And the code behind it. A `<Card options={jobs}/>` is not just its
        // markup: `jobs` is a const on the page it was copied from, and pasted
        // into another page it names nothing at all. Taken now rather than at
        // paste time, because by then this page may not even be open.
        frontmatter: state.model.extraFrontmatter || '',
        imports: (state.model.imports || []).map((i) => ({
          name: i.name,
          path: i.path,
        })),
        pagePath: pageStateRef.current.currentPage?.path || undefined,
      };
      showToast(`Copied ${node.name || 'text'}`, 'success');
    },
    [showToast, nodeClipboardRef, pageStateRef],
  );

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const sourceNode = findNodeById(state.model.nodes, nodeId);
      if (!sourceNode) {
        return;
      }
      if (sourceNode.kind === 'chunk-group' || sourceNode.chunkFile) {
        showToast(
          'Chunk sections are defined in the page frontmatter and cannot be duplicated here.',
          'error',
        );
        return;
      }
      const clone = withNewIds(sourceNode);
      // Step 6, insert: the copy is the node's own bytes, spliced after it.
      commitEdit(duplicateGesture(nodeId, clone, { urgency: true }));
      setSelectedId(clone.id);
    },
    [commitEdit, showToast, pageStateRef, setSelectedId],
  );
  return { copyNode, duplicateNode };
}

// Pasting a node.
function usePasteNode(
  removeNodeScope: ReturnType<typeof useRemoveNode>,
  coreState: ReturnType<typeof useCoreState>,
  addComponentScope: ReturnType<typeof useAddComponent>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { nodeClipboardRef } = removeNodeScope;
  const { insertables, pageStateRef, selectedIdRef, setSelectedId } = coreState;
  const { resolveImportPath } = addComponentScope;
  const { showToast } = lifecycle;
  const { commitEdit } = history;

  // Pastes into the current selection when it can host children (a non-void
  // element, or a component with a default slot), otherwise after it (same
  // parent), or at the end of the page. Imports for components in the pasted
  // subtree are added if the target page is missing them (cross-page paste).
  const pasteNode = useCallback(async () => {
    const clip = nodeClipboardRef.current;
    const state = pageStateRef.current.pageState;
    if (!clip || !state?.editable) {
      return;
    }

    const needs = await pasteNeeds(clip, state.model, {
      insertables,
      resolveImportPath,
      currentPath: () => pageStateRef.current.currentPage?.path,
    });
    const clone = withNewIds(clip.node);
    const selectionId = selectedIdRef.current;
    // Step 9: the imports and declarations it needs, then the node itself —
    // one undo step. The model is the one shown now: the lookups above
    // awaited, and edits made meanwhile are part of it.
    const now = pageStateRef.current.pageState;
    if (!now?.editable) {
      return;
    }
    const shown = now.model;
    const imported = pastedImports(needs);
    const withImports = imported(shown);
    const place = pastePlace(withImports, selectionId, insertables);
    const { pasted, removed, lost } = pastedInScope(withImports, clone, place, clip.vars || []);
    if (removed) {
      showToast(
        `Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(', ')}.`,
        'info',
      );
    }
    const insert = insertGesture(withImports, pasted, place, { urgency: true });
    const options = { coalesceKey: undefined, urgency: true };
    commitEdit(
      frontmatterOf(withImports) === frontmatterOf(shown)
        ? insert
        : sequence(frontmatterGesture(shown, options, imported), insert),
    );
    setSelectedId(clone.id);
    const brought = broughtMessage(needs);
    if (brought !== undefined) {
      showToast(brought, 'info');
    }
  }, [
    commitEdit,
    insertables,
    resolveImportPath,
    showToast,
    nodeClipboardRef,
    pageStateRef,
    selectedIdRef,
    setSelectedId,
  ]);
  return { pasteNode };
}

// The terminal key, interface sound and the insert palette.
function useInsertPalette(coreState: ReturnType<typeof useCoreState>) {
  const { setTermOpen } = coreState;

  // ----------------------------------------------------------------
  // Insert palette (⌘F / ⌘E) — quick-add components, tags, loops, …
  // ----------------------------------------------------------------

  // ⌘J / ⌃` toggle the terminal dock, the two bindings people already have in
  // their fingers. Both carry a modifier, so they still work while a text field
  // or the terminal itself has focus — unlike the rail's bare-letter shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      const isToggle =
        (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') ||
        (event.ctrlKey && !event.metaKey && !event.altKey && event.key === '`');
      if (!isToggle) {
        return;
      }
      event.preventDefault();
      setTermOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTermOpen]);

  const [insertOpen, setInsertOpen] = useState(false);

  // Interface sound. The menu owns the setting, so the app reads it once on
  // load and takes the menu's word for it afterwards; nothing in here decides
  // to make a noise on its own.
  useEffect(() => {
    let live = true;
    readAppSettings()
      .then((settings) => {
        if (live) {
          setSoundEnabled(settings.sound);
        }
      })
      .catch(() => {});
    const off = onSoundSettingChanged((enabled) => setSoundEnabled(enabled));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return { insertOpen, setInsertOpen };
}

// Shortcuts forwarded from the canvas.
function useCanvasMessages(
  coreState: ReturnType<typeof useCoreState>,
  insertPalette: ReturnType<typeof useInsertPalette>,
) {
  const { inPreviewRef, pageStateRef } = coreState;
  const { setInsertOpen } = insertPalette;

  // Open requests from the app menu (⌘E accelerator) and from canvas iframes
  // (which forward ⌘F/⌘E when they hold keyboard focus).
  useEffect(() => {
    const openIfEditable = () => {
      if (pageStateRef.current.pageState?.editable && !inPreviewRef.current) {
        setInsertOpen(true);
      }
    };
    const offMenu = window.avb.onMenu('insert', openIfEditable);
    const onMessage = (event: MessageEvent<unknown>): void => {
      // Only a frame this document embeds may replay keys into the app: a
      // shortcut from any other window is not a keypress the person made here.
      const fromOwnFrame = Array.from(document.querySelectorAll('iframe')).some(
        (frame) => frame.contentWindow === event.source,
      );
      if (!fromOwnFrame) {
        return;
      }
      const message = parseShortcutMessage(event.data);
      if (message === undefined) {
        return;
      }
      switch (message.name) {
        case 'insert':
          openIfEditable();
          return;
        // Arrow keys pressed while the canvas iframe holds focus: replay them
        // on the app window so tree navigation behaves the same whether the
        // selection was made on the canvas or in the navigator.
        case 'arrow':
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: message.key, bubbles: true, cancelable: true }),
          );
          return;
        // Delete / ⌘D from the canvas. Replayed on the document rather than
        // handled here so they go through the same guards as a keypress in the
        // app — one definition of what those keys do, and the handler's own
        // "am I typing in a field" check still sees a non-field target.
        case 'key':
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: message.key,
              metaKey: message.meta,
              ctrlKey: message.meta,
              bubbles: true,
              cancelable: true,
            }),
          );
          return;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      offMenu();
      window.removeEventListener('message', onMessage);
    };
  }, [inPreviewRef, pageStateRef, setInsertOpen]);
}

// Inserting what the palette picked.
function useInsertItem(
  coreState: ReturnType<typeof useCoreState>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { cmsRel, contentName, insertables, leftTab, pageStateRef, selectedIdRef } = coreState;
  const { setSelectedId } = coreState;
  const { addComponent, setInsertOpen } = nodeEdits;
  const { reportFailure } = lifecycle;
  const { commitEdit } = history;

  // Where a new node goes — see insertTarget.js. The rule lives there so the
  // "why did that land next to the section instead of in it?" answer can be
  // read, and tested, without a running app.
  const insertTargetFor = useCallback(
    (model: EditorModel, selectionId: string | undefined, item: InsertItem) =>
      placeInsert(model, selectionId, item, insertables),
    [insertables],
  );

  const insertItem = useCallback(
    (item: InsertItem) => {
      setInsertOpen(false);
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const target = insertTargetFor(state.model, selectedIdRef.current, item);

      if (item.type === 'component') {
        void addComponent(item.name, target).catch(reportFailure);
        return;
      }

      // <Image>/<Picture> need `import { … } from 'astro:assets'` — a named
      // import of a virtual module, so there is no file path to resolve the
      // way a project component's is.
      if (item.type === 'astroAsset') {
        const assetId = newId();
        commitEdit(astroAssetGesture(state.model, { id: assetId, name: item.name }, target));
        setSelectedId(assetId);
        return;
      }

      const id = newId();
      const node = insertedNode(item, id);
      if (!node) {
        return;
      }
      // Step 6, insert: a new node needs no import, so it is one request.
      commitEdit(insertGesture(state.model, node, target, { urgency: true }));
      setSelectedId(id);
    },
    [
      insertTargetFor,
      addComponent,
      commitEdit,
      reportFailure,
      pageStateRef,
      selectedIdRef,
      setInsertOpen,
      setSelectedId,
    ],
  );

  // True while the CMS covers the canvas: the page-editing shortcuts below
  // would act on a selection the user can't see.
  const cmsOpenRef = useRef(false);
  cmsOpenRef.current = leftTab === 'cms' && (!!cmsRel || !!contentName);
  return { cmsOpenRef, insertItem };
}

// The app’s keyboard shortcuts.
function useKeyboard(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  insertItemScope: ReturnType<typeof useInsertItem>,
  history: ReturnType<typeof useHistory>,
) {
  const { historyRef, reportFailure } = lifecycle;
  const { openCodeWindowRef, pageStateRef, selectedIdRef, setClassFocus } = coreState;
  const { setCreateRequest, setLeftTab, setRightTab } = coreState;
  const { copyNode, duplicateNode, nodeClipboardRef, pasteNode, removeNode } = nodeEdits;
  const { setInsertOpen } = nodeEdits;
  const { cmsOpenRef } = insertItemScope;
  const { redo, undo } = history;

  // Keyboard: ⌘Z undoes, ⇧⌘Z / ⌘Y redoes (app-wide, even inside fields —
  // field edits live in the same history); Delete/Backspace removes, ⌘C
  // copies, ⌘D duplicates, ⌘V pastes — unless the user is typing in a field.
  useEffect(() => {
    const keys: AppKeys = {
      historyRef,
      pageStateRef,
      selectedIdRef,
      openCodeWindowRef,
      nodeClipboardRef,
      cmsOpenRef,
      undo,
      redo,
      setInsertOpen,
      setLeftTab,
      setCreateRequest,
      setRightTab,
      setClassFocus,
      removeNode,
      copyNode,
      duplicateNode,
      pasteNode,
      reportFailure,
    };
    const onKeyDown = (event: KeyboardEvent): void => handleAppKeyDown(event, keys);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    removeNode,
    copyNode,
    duplicateNode,
    pasteNode,
    undo,
    redo,
    reportFailure,
    cmsOpenRef,
    historyRef,
    nodeClipboardRef,
    openCodeWindowRef,
    pageStateRef,
    selectedIdRef,
    setClassFocus,
    setCreateRequest,
    setInsertOpen,
    setLeftTab,
    setRightTab,
  ]);
}

// Application-menu shortcuts.
function useMenuShortcuts(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
  insertItemScope: ReturnType<typeof useInsertItem>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  history: ReturnType<typeof useHistory>,
) {
  const { flushSave, reportFailure, showToast } = lifecycle;
  const { pageStateRef, projectRef, selectedIdRef, selectionKeysRef } = coreState;
  const { cmsOpenRef } = insertItemScope;
  const { copyNode, nodeClipboardRef, pasteNode } = nodeEdits;
  const { redo, undo } = history;

  // Application-menu shortcuts: on macOS the native menu consumes ⌘Z/⌘C/⌘V
  // before the DOM sees them, so those arrive here via IPC instead. Copy and
  // paste route to the focused text field when one is active, otherwise to
  // the selected node.
  useEffect(() => {
    const copying = { flushSave, showToast, projectRef, selectionKeysRef };
    const copySelection = (): Promise<void> => copySelectionTrail(copying);
    const menu: MenuEdits = {
      selectedIdRef,
      pageStateRef,
      cmsOpenRef,
      nodeClipboardRef,
      copyNode,
      pasteNode,
      reportFailure,
    };
    const offs = [
      // ⌘Z is a menu accelerator, so the key never reaches the page: whatever
      // this decides is the only undo there is.
      //
      // Typing has its own, and the field is the only thing that knows what was
      // typed — a rename half-finished in a text box is not an entry on the
      // app's stack. So a field gets its own undo handed back to it.
      //
      // Everything else is the app's. It used to run only while a page was open
      // and the CMS was closed, which left every view that ISN'T a page unable
      // to undo anything it had recorded: the variables panel, the assets
      // panel, the CMS itself. A command carries its own inverse and needs no
      // page — and a snapshot without one is dropped rather than applied, which
      // undo already does.
      window.avb.onMenu('undo', () => {
        if (inEditable()) {
          runNativeEdit('undo');
          return;
        }
        // Undo reports its own failures.
        void undo();
      }),
      window.avb.onMenu('redo', () => {
        if (inEditable()) {
          runNativeEdit('redo');
          return;
        }
        // Redo reports its own failures.
        void redo();
      }),
      window.avb.onMenu('copy', () => menuCopy(menu)),
      window.avb.onMenu('paste', () => menuPaste(menu)),
      // ⇧⌘C — the selection's file:line trail, for pasting into an AI chat.
      // Copies markup coordinates, not markup: ⌘C already does the node.
      window.avb.onMenu('copySelection', () => {
        void copySelection().catch(reportFailure);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [
    undo,
    redo,
    copyNode,
    pasteNode,
    flushSave,
    showToast,
    reportFailure,
    cmsOpenRef,
    nodeClipboardRef,
    pageStateRef,
    projectRef,
    selectedIdRef,
    selectionKeysRef,
  ]);
}

// The interactive preview mode.
function useInteractivePreview(
  coreState: ReturnType<typeof useCoreState>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { devUrl, inPreviewRef, livePathRef, pageStateRef, previewIframeRef } = coreState;
  const { previewPathRef, scan, setInPreview, setPreviewSource, trailingSlash } = coreState;
  const { selectPage } = navigation;

  // ----------------------------------------------------------------
  // Interactive preview mode — browse the site inside the app; on exit,
  // the editor follows whichever page was navigated to.
  // ----------------------------------------------------------------

  const enterPreview = useCallback(() => {
    if (!devUrl) {
      return;
    }
    // Whatever the canvas is showing — which for a dynamic page is one entry's
    // URL, not its pattern. Opening /blog/[...id] asks the dev server for a
    // route no page produces, and it answers with the site's 404, while the
    // URL field (built from the same entry) went on claiming otherwise.
    const path =
      livePathRef.current ||
      routeToPath(pageStateRef.current.currentPage?.route || '/', trailingSlash);
    previewPathRef.current = path;
    setPreviewSource(devUrl + path);
    setInPreview(true);
  }, [
    devUrl,
    trailingSlash,
    livePathRef,
    pageStateRef,
    previewPathRef,
    setInPreview,
    setPreviewSource,
  ]);

  const exitPreview = useCallback(() => {
    setInPreview(false);
    const raw = previewPathRef.current;
    if (!raw) {
      return;
    }
    let path = raw.split('?')[0]?.split('#')[0] ?? '';
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    const page = scan.pages.find((pg) => pg.route === (path || '/'));
    if (page && page.path !== pageStateRef.current.currentPage?.path) {
      // Opening a page reports its own failures.
      void selectPage(page);
    }
  }, [scan.pages, selectPage, pageStateRef, previewPathRef, setInPreview]);

  // Track navigation inside the preview iframe (the preload posts
  // avb:navigated from every loaded frame).
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const message = toRecord(event.data);
      if (message?.['type'] !== 'avb:navigated' || !inPreviewRef.current) {
        return;
      }
      const ifr = previewIframeRef.current;
      if (ifr && event.source === ifr.contentWindow) {
        const path = message['path'];
        if (typeof path === 'string') {
          previewPathRef.current = path;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inPreviewRef, previewIframeRef, previewPathRef]);
  return { enterPreview, exitPreview };
}

// Escape out of a preview or a component.
function useEscapeKeys(
  coreState: ReturnType<typeof useCoreState>,
  navigation: ReturnType<typeof useNavigation>,
  interactivePreview: ReturnType<typeof useInteractivePreview>,
) {
  const { editStack, inPreview, previewRef } = coreState;
  const { closeComponent, exitCommitPreview } = navigation;
  const { exitPreview } = interactivePreview;

  // Escape exits preview mode.
  useEffect(() => {
    // Escape leaves either kind of looking-not-working. An older version takes
    // precedence: it is the one covering everything, so it is the one Escape
    // is about while it is up.
    if (!inPreview && !previewRef) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (previewRef) {
          // Leaving the old version cannot fail: a server that will not stop is ignored.
          void exitCommitPreview();
        } else {
          exitPreview();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, exitPreview, previewRef, exitCommitPreview]);

  // Escape backs out of a drilled-into component, one level at a time.
  useEffect(() => {
    if (inPreview || editStack.length < 2) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      const target = event.target;
      // Let fields, menus, and dialogs consume their own Escape first.
      if (
        target instanceof HTMLElement &&
        (target.closest('input, textarea, select, [contenteditable="true"]') ||
          target.closest('.modal-overlay, .dd-popup, .insert-overlay, .code-window'))
      ) {
        return;
      }
      event.preventDefault();
      // Opening the parent file reports its own failures.
      void closeComponent();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, editStack.length, closeComponent]);
}

// Injected routes and a dynamic page’s entries.
function useRoutes(coreState: ReturnType<typeof useCoreState>) {
  const { currentPage, devStatus, devUrl, editStack, pageState, project, scan } = coreState;
  const { setDynamicError, setDynamicIndex, setDynamicPaths, setInjectedRoutes } = coreState;

  // The route list is written by the dev server as it resolves its routes, so
  // it is read once the server is up — and again after a rescan, since adding
  // a page of your own changes what the list holds.
  useEffect(() => {
    if (!project || devStatus !== 'on') {
      setInjectedRoutes([]);
      return;
    }
    let live = true;
    readInjectedRoutes(project.path)
      .then((routes) => live && setInjectedRoutes(routes))
      .catch(() => live && setInjectedRoutes([]));
    return () => {
      live = false;
    };
  }, [project, devStatus, scan.pages.length, setInjectedRoutes]);

  // The open page's model, when it has one, and the frontmatter it declares.
  const model = pageState?.editable ? pageState.model : undefined;
  const pageFrontmatter = model?.extraFrontmatter;

  // A dynamic page ([slug].astro) has a route pattern, not a URL. Ask the dev
  // server which concrete paths its getStaticPaths produces, so the canvas can
  // show one of them instead of a 404. Static pages never reach the fetch.
  useEffect(() => {
    const entry = editStack[0] || currentPage;
    const route = entry?.route;
    if (!project || !entry || !route?.includes('[') || devStatus !== 'on' || !devUrl) {
      setDynamicPaths([]);
      return undefined;
    }
    let live = true;
    if (!entry.path) {
      return undefined;
    }
    readDynamicPaths(project.path, entry.path, devUrl)
      .then((result) => {
        if (!live) {
          return;
        }
        setDynamicPaths(result?.entries || []);
        // Keep showing the same entry across reloads where we can — the
        // params are what identify it, not its position in the list.
        setDynamicIndex((i) => (i < (result?.entries || []).length ? i : 0));
        if (result?.error) {
          setDynamicError(result.error);
        } else {
          setDynamicError(undefined);
        }
      })
      .catch(() => live && setDynamicPaths([]));
    return () => {
      live = false;
    };
    // Frontmatter rather than the whole pageState: getStaticPaths lives there,
    // and depending on the model would re-run a collection query on every
    // keystroke in the page body.
  }, [
    project,
    editStack,
    currentPage,
    devStatus,
    devUrl,
    pageFrontmatter,
    setDynamicError,
    setDynamicIndex,
    setDynamicPaths,
  ]);
  return { model, pageFrontmatter };
}

// The project’s collections.
function useCollections(coreState: ReturnType<typeof useCoreState>) {
  const { project, sampleAskedRef, setCollectionSamples, setCollections } = coreState;

  // What one entry of each collection this file reads actually holds — the
  // sample values the binding picker shows beside a field's name. Only the dev
  // server can run the project's loaders, so without one the picker falls back
  // to whatever the source alone says.
  useEffect(() => {
    setCollectionSamples({});
    sampleAskedRef.current = new Set();
  }, [project?.path, sampleAskedRef, setCollectionSamples]);
  useEffect(() => {
    if (!project?.path) {
      return undefined;
    }
    let live = true;
    readContentCollections(project.path)
      .then((value) => live && setCollections(value))
      .catch(() => {});
    const off = onCmsInventoryChanged(() => {
      readContentCollections(project.path)
        .then((value) => live && setCollections(value))
        .catch(() => {});
    });
    return () => {
      live = false;
      off?.();
    };
  }, [project?.path, setCollections]);
}

// Sample entries for the collections the open file reads.
function useSampleEntries(
  coreState: ReturnType<typeof useCoreState>,
  routes: ReturnType<typeof useRoutes>,
) {
  const { collectionSamples, currentPage, devStatus, devUrl, dynamicIndex } = coreState;
  const { dynamicPaths, setCollectionSamples } = coreState;
  const { pageFrontmatter } = routes;

  useEffect(() => {
    if (!devUrl || devStatus !== 'on') {
      return undefined;
    }
    const frontmatter = pageFrontmatter ?? '';
    // The entry on the canvas, which is what a reference in this file resolves
    // AGAINST — this post's author, not the collection's first.
    const props =
      currentPage?.kind === 'component'
        ? undefined
        : dynamicPaths[dynamicIndex]?.props || undefined;
    const wanted: { readonly key: string; readonly name: string; readonly id?: string }[] = [
      ...collectionsInScope(frontmatter).map((name) => ({ key: name, name })),
      ...referencesInScope(frontmatter, props).map((reference) => ({
        key: reference.key,
        name: reference.collection,
        id: reference.id,
      })),
    ].filter((want) => !(want.key in collectionSamples));
    if (!wanted.length) {
      return undefined;
    }
    let live = true;
    Promise.all(
      wanted.map((want) =>
        readSampleEntry(devUrl, want.name, want.id).then((entry) => [want.key, entry] as const),
      ),
    )
      .then((pairs) => {
        if (live) {
          setCollectionSamples((previous) => ({ ...previous, ...Object.fromEntries(pairs) }));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [
    pageFrontmatter,
    devUrl,
    devStatus,
    collectionSamples,
    dynamicPaths,
    dynamicIndex,
    currentPage,
    setCollectionSamples,
  ]);
}

// Taking back queries the page stopped using.
function useQueryCleanup(
  routes: ReturnType<typeof useRoutes>,
  history: ReturnType<typeof useHistory>,
) {
  const { model } = routes;
  const { commitEdit } = history;

  // Takes back the queries it wrote, once the page stops using them: delete the
  // last chip reading a collection and its `const … = await getCollection(…)`
  // goes too, rather than leaving a query fetching content for nobody.
  //
  // Three things keep this safe. Only queries carrying Stacki's own marker are
  // considered, so a hand-written one is never touched. "Used" is tested
  // against the whole node tree as text, which over-detects rather than
  // under-detects — the wrong answer here is deleting something live. And it
  // waits for a pause in typing, because a half-typed name reads as unused.
  useEffect(() => {
    const current = model;
    if (!current?.extraFrontmatter?.includes(QUERY_MARK)) {
      return undefined;
    }
    const timer = setTimeout(() => {
      const focused = document.activeElement;
      if (
        focused?.closest?.('.props-field, .rich-content, .bind-input, .expr-input, .attr-editor')
      ) {
        return;
      }
      const fm = current.extraFrontmatter || '';
      const markup = JSON.stringify(current.nodes || []);
      const dead = markedQueries(fm).filter((query) => {
        const word = new RegExp(`\\b${query.name}\\b`);
        const elsewhere = fm.slice(0, query.start) + fm.slice(query.end);
        return !word.test(elsewhere) && !word.test(markup);
      });
      if (!dead.length) {
        return;
      }
      // Step 6, frontmatter: the dead queries, and the import only they needed.
      const cleaned = (pageModel: EditorModel): EditorModel => {
        let next = pageModel.extraFrontmatter || '';
        for (const query of dead) {
          next = removeMarkedQuery(next, query.name);
        }
        // The import goes with the last query that needed it — but only when
        // nothing else in the file mentions it, so an import someone else put
        // there and still uses stays put.
        const mentions = (text: string) => /\bgetCollection\b/.test(text);
        let imports = pageModel.imports;
        if (!mentions(next)) {
          if (!mentions(JSON.stringify(pageModel.nodes || []))) {
            const needed = (i: ImportDecl) =>
              !(i.name === 'getCollection' && i.path === 'astro:content');
            imports = pageModel.imports.filter(needed);
          }
        }
        return { ...pageModel, extraFrontmatter: next, imports };
      };
      commitEdit(frontmatterGesture(current, { coalesceKey: undefined, urgency: false }, cleaned));
    }, 2000);
    return () => clearTimeout(timer);
  }, [model, commitEdit]);
}

// The note above a node.
function useComment(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Write (or clear) that comment. Empty text removes the node entirely, so
  // clearing the field doesn't leave `<!---->` behind.
  const setComment = useCallback(
    (nodeId: string, text: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const found = findWithParent(state.model.nodes, nodeId);
      if (!found) {
        return;
      }
      const previous = found.index > 0 ? found.siblings[found.index - 1] : undefined;
      const existing = previous && previous.kind === 'comment' ? previous : undefined;
      const body = String(text ?? '').trim();
      if (!body) {
        if (existing) {
          // Step 6, remove: clearing the field takes the note out.
          commitEdit(removalGesture([existing.id], { urgency: false }));
        }
        return;
      }
      // The parser keeps the raw text between the delimiters, so it is padded
      // to serialize as `<!-- text -->` the way a hand-written one reads — and
      // a note written as a divider keeps its rule, to the same width, so a
      // column of them stays lined up.
      const value = noteValue(existing?.value, body);
      assert(value !== undefined, 'A nonempty comment produces a serialized value');
      if (!existing) {
        // Step 6, insert: a new note, right above its node.
        const note: EditorNode = { id: newId(), kind: 'comment', value };
        const place = { parentId: found.parent?.id ?? undefined, index: found.index };
        commitEdit(insertGesture(state.model, note, place, { urgency: false }));
        return;
      }
      // Step 9, rewording: the note restated, its new words placed on its bytes.
      const note = findNodeById(state.model.nodes, existing.id);
      if (note?.kind !== 'comment') {
        return;
      }
      const options = { coalesceKey: `comment:${nodeId}`, urgency: false };
      commitEdit(nodeGesture(note.id, { ...note, value }, options));
    },
    [commitEdit, pageStateRef],
  );
  return { setComment };
}

// Classes and props.
function useClassEdits(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef } = coreState;
  const { flushSave, showToast } = lifecycle;
  const { commitEdit } = history;

  // Typing a bare class in the style panel's selector box puts it on the
  // element too — a rule for a class the element doesn't carry would never
  // apply. Where it goes depends on how the element's classes are written: a
  // plain `class`, a `class:list`, a template literal (see classAttr.js). An
  // element whose class is some other expression is code we would have to
  // understand to extend, so that one is said out loud rather than dropped.
  // Resolves with the page edit's outcome, once it reached disk or was
  // refused: the style panel writes the class's rule only after it applied
  // (step 6, plan §3.3 — outcome-gated, never a fabricated atomicity).
  const addClassToNode = useCallback(
    async (nodeId: string, className: string): Promise<ClassOutcome> => {
      const clean = String(className || '').trim();
      const state = pageStateRef.current.pageState;
      if (!nodeId || !clean || !state?.editable) {
        return { tag: 'refused', message: 'no element is selected' };
      }
      const node = findNodeById(state.model.nodes, nodeId);
      if (!node) {
        return { tag: 'refused', message: 'the element is gone' };
      }
      if (hasClass(node.props, clean)) {
        return { tag: 'applied' };
      }
      const edit = withClass(node.props, clean);
      if (!edit) {
        showToast(
          `Add ${clean} to this element yourself — ` +
            "its class comes from code Stacki can't edit safely.",
        );
        return { tag: 'refused', message: 'its class comes from code' };
      }
      // Step 6, attribute: the class attribute, as its own edit request.
      const patch = { [edit.key]: edit.value };
      commitEdit(propsGesture(nodeId, patch, { coalesceKey: undefined, urgency: true }));
      try {
        await flushSave();
        return { tag: 'applied' };
      } catch (error: unknown) {
        return { tag: 'refused', message: cleanError(error) };
      }
    },
    [commitEdit, flushSave, showToast, pageStateRef],
  );

  // Step 6, attribute: set or remove one prop, as an edit request when it has
  // an intent form (editGestures.ts), else as a whole-model save.
  const setProp = useCallback(
    (nodeId: string, propName: string, value: Attr | undefined, immediate = false) => {
      const coalesceKey = `prop:${nodeId}:${propName}`;
      const options = { coalesceKey, urgency: immediate };
      const state = pageStateRef.current.pageState;
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      const previous = propName === 'style' ? node?.props?.['style'] : undefined;
      if (previous?.type === 'string' && value?.type === 'string') {
        // Step 6, inline CSS: one declaration changed is one declaration edited.
        const styles = { before: previous.value, after: value.value };
        commitEdit(inlineStyleGesture(nodeId, styles, options));
        return;
      }
      commitEdit(propsGesture(nodeId, { [propName]: value }, options));
    },
    [commitEdit, pageStateRef],
  );

  // Several props in one edit, so picking an image and getting its width and
  // height back is a single undo rather than three.
  const setProps = useCallback(
    (nodeId: string, patch: PropValues, immediate = true) => {
      const coalesceKey = `props:${nodeId}:${Object.keys(patch).join(',')}`;
      commitEdit(propsGesture(nodeId, patch, { coalesceKey, urgency: immediate }));
    },
    [commitEdit],
  );
  return { addClassToNode, setProp, setProps };
}

// Writing an asset pick into a prop.
function useAssetProp(
  coreState: ReturnType<typeof useCoreState>,
  classEdits: ReturnType<typeof useClassEdits>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef, projectRef } = coreState;
  const { setProp } = classEdits;
  const { commitEdit } = history;

  // Writes an asset pick into a prop. The root decides the form:
  //
  //   public/  served as-is → a URL string, src="/hero.png"
  //   src/     built and optimised → an ESM import, src={hero}
  //
  // The src/ form is the one Astro wants for <Image>: it carries the file's
  // real dimensions, so nothing has to be typed in and MissingImageDimension
  // can't happen. An element gets `hero.src` instead — a plain <img> needs the
  // URL out of the imported object, not the object.
  const setAssetProp = useCallback(
    async (nodeId: string, propName: string, picked: PickedAsset & { readonly abs?: string }) => {
      const { pageState: state, currentPage: page } = pageStateRef.current;
      if (!state?.editable || !page?.path || !picked?.rel) {
        return;
      }
      const withoutRoot = picked.rel.split('/').slice(1).join('/');
      if (picked.root !== 'src') {
        setProp(nodeId, propName, { type: 'string', value: '/' + withoutRoot }, true);
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      const abs = picked.abs || `${projectPath}/${picked.rel}`;
      const paths = await findImportPath(projectPath, page.path, abs);
      const latest = pageStateRef.current.pageState;
      if (!latest?.editable) {
        return;
      }
      const model = latest.model;
      const node = findNodeById(model.nodes, nodeId);
      if (!node) {
        return;
      }
      const spec = chooseImportPath(model, paths);
      // Reuse the binding if this file is already imported — importing the
      // same asset twice under two names is just noise.
      let local = (model.imports || []).find((i) => !i.named && i.path === spec)?.name;
      const added = local === undefined;
      if (!local) {
        const base =
          withoutRoot
            .split('/')
            .pop()
            ?.replace(/\.[^.]+$/, '') ?? 'asset';
        let candidate = base.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1') || 'asset';
        const taken = new Set((model.imports || []).map((i) => i.name));
        // Ends within taken.size + 1 passes: each tries a name not yet tried.
        let suffix = 2;
        while (taken.has(candidate)) {
          candidate = `${base}${suffix++}`;
        }
        local = candidate;
      }
      const binding = local;
      // Step 6, prop and frontmatter: the prop as a request, then the import
      // it needs and the one a replaced image leaves behind — one undo step.
      const reference = node.kind === 'element' ? `${binding}.src` : binding;
      const value = { type: 'expr' as const, value: reference };
      const options = { coalesceKey: undefined, urgency: true };
      const prop = propsGesture(nodeId, { [propName]: value }, options);
      const imported = (current: EditorModel): EditorModel => {
        const entry = { name: binding, path: spec, quote: "'" };
        const imports = added ? [...current.imports, entry] : current.imports;
        // Picking a second image over a first leaves the first one's import
        // behind with nothing pointing at it.
        return withPrunedImports({ ...current, imports });
      };
      const afterProp = prop.apply(model);
      const changed = frontmatterOf(imported(afterProp)) !== frontmatterOf(afterProp);
      commitEdit(changed ? sequence(prop, frontmatterGesture(afterProp, options, imported)) : prop);
    },
    [commitEdit, setProp, pageStateRef, projectRef],
  );
  return { setAssetProp };
}

// Renaming an attribute.
function useRenameProp(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Renames an attribute in place, preserving its value and position (step 9:
  // a rename-attribute request, the name's bytes alone).
  const renameProp = useCallback(
    (nodeId: string, oldName: string, newName: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const names = { from: oldName, to: newName };
      const gesture = attributeRenameGesture(state.model, nodeId, names);
      if (gesture) {
        commitEdit(gesture);
      }
    },
    [commitEdit, pageStateRef],
  );
  return { renameProp };
}

// Turning a tag into a component.
function useNodeKind(
  coreState: ReturnType<typeof useCoreState>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  history: ReturnType<typeof useHistory>,
) {
  const { insertables, pageStateRef } = coreState;
  const { resolveImportPath } = nodeEdits;
  const { commitEdit } = history;

  // Switches a plain element's tag. Attributes that belonged to the old
  // tag's built-in schema but aren't valid for the new one are dropped
  // (loading="eager" on img → div); global, data-* and aria-* attributes
  // and anything custom stay.
  // Renaming a node's tag can change what kind of node it is. Astro decides
  // that by case: `<div>` is an element, `<AstroLogo>` is a component — and a
  // component is only real if something in the frontmatter provides it, so a
  // capitalised name is only accepted when it names a project component or an
  // existing import. Typing `div` over a component turns it back.
  const changeNodeKind = useCallback(
    async (nodeId: string, newTag: string) => {
      const name = String(newTag || '').trim();
      if (!/^[A-Z][\w$]*$/.test(name)) {
        return false;
      }
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return false;
      }
      const already = (state.model.imports || []).some((i) => i.name === name);
      const comp = insertables.find((component) => component.name === name);
      const asset = ASTRO_ASSETS.some((entry) => entry.name === name);
      if (!already && !comp && !asset) {
        return false;
      } // nothing provides it
      const paths = comp && !already ? await resolveImportPath(comp.path) : undefined;
      const current = pageStateRef.current.pageState;
      const model = current?.editable ? current.model : undefined;
      const node = model ? findNodeById(model.nodes, nodeId) : undefined;
      if (!model || !node) {
        return false;
      }
      if (node.name === name) {
        return true;
      }
      // Attributes that belonged to the old element's tag mean nothing to a
      // component; class, data- and aria- carry over the way they do for a
      // tag change.
      const oldNames =
        node.kind === 'element'
          ? new Set(getElementSchema(node.name).map((field) => field.name))
          : undefined;
      const dropped = Object.keys(node.props || {}).filter(
        (attr) => oldNames?.has(attr) && !GLOBAL_ATTRS.has(attr) && !/^(data-|aria-)/.test(attr),
      );
      const imported = (pageModel: EditorModel): EditorModel => {
        if (pageModel.imports.some((i) => i.name === name)) {
          return withPrunedImports(pageModel);
        }
        const entry = paths
          ? { name, path: chooseImportPath(pageModel, paths), quote: "'" }
          : asset
            ? { name, imported: name, path: ASTRO_ASSETS_MODULE, quote: "'", named: true }
            : undefined;
        return withPrunedImports(
          entry ? { ...pageModel, imports: [...pageModel.imports, entry] } : pageModel,
        );
      };
      const change = { kind: 'component' as const, name, asset, dropped };
      commitEdit(tagChangeGesture(model, node, change, imported));
      return true;
    },
    [insertables, commitEdit, resolveImportPath, pageStateRef],
  );
  return { changeNodeKind };
}

// Changing an element’s tag.
function useElementTag(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  const changeElementTag = useCallback(
    (nodeId: string, newTag: string) => {
      const tag = String(newTag || '')
        .trim()
        .toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
        return;
      }
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      const node = model ? findNodeById(model.nodes, nodeId) : undefined;
      if (!model || !node || node.name === tag) {
        return;
      }
      // A component becoming a plain tag keeps only what a tag understands:
      // its props were the component's API, and they'd be junk attributes on
      // a <div>.
      const wasComponent = node.kind !== 'element';
      const oldNames = wasComponent
        ? new Set(Object.keys(node.props || {}))
        : new Set(getElementSchema(node.name).map((field) => field.name));
      const newNames = new Set(getElementSchema(tag).map((field) => field.name));
      const dropped = Object.keys(node.props || {}).filter(
        (attr) =>
          oldNames.has(attr) &&
          !newNames.has(attr) &&
          !GLOBAL_ATTRS.has(attr) &&
          !/^(data-|aria-)/.test(attr),
      );
      const change = { kind: 'element' as const, name: tag, asset: false, dropped };
      commitEdit(tagChangeGesture(model, node, change, withPrunedImports));
    },
    [commitEdit, pageStateRef],
  );
  return { changeElementTag };
}

// A node’s text, and the frontmatter.
function useNodeText(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef } = coreState;
  const { commitEdit, scheduleSave } = history;

  // `renames` (loop editor only) carries the variable names this edit is
  // changing, so references below the node follow along. A rename touches
  // many nodes at once, so it saves immediately and gets its own history
  // entry instead of coalescing with the keystrokes around it.
  // `immediate` skips the typing coalesce for an edit that arrives already committed
  // (the style panel writing a <style> block): waiting 300 ms there just delays the
  // canvas, since the next keystroke it was batching with never comes.
  const setNodeText = useCallback(
    (
      nodeId: string,
      value: string,
      renames: readonly Rename[] | undefined = undefined,
      immediate: boolean | 'live' = false,
    ) => {
      const renaming = (renames || []).some(
        (rename) => rename.from && rename.to && rename.from !== rename.to,
      );
      const state = pageStateRef.current.pageState;
      if (renaming && state?.editable) {
        // Step 6, loop rename (multi-span): the parameters and every reference
        // below, as rename-binding requests, when the head changed nothing else.
        const pairs = (renames || []).flatMap((rename) =>
          rename.from && rename.to ? [{ from: rename.from, to: rename.to }] : [],
        );
        const change = { head: value, renames: pairs };
        const gesture = loopRenameGesture(state.model, nodeId, change, { urgency: true });
        if (gesture) {
          commitEdit(gesture);
          return;
        }
      }
      // Step 9: everything else the field says is the node restated.
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      if (node !== undefined && !renaming && statedText(node) === value) {
        // Already what the node holds: the style panel committing the CSS its
        // live writes already put there, or a field left as it was. A request
        // that changes nothing is refused by the planner, and its notice would
        // report a failure after a success. A commit still saves at once.
        if (immediate === true) {
          scheduleSave(true);
        }
        return;
      }
      const next = node ? restatedText(node, value, renames) : undefined;
      if (!next) {
        return;
      }
      const coalesceKey = renaming ? undefined : `text:${nodeId}`;
      commitEdit(nodeGesture(nodeId, next, { coalesceKey, urgency: renaming || immediate }));
    },
    [commitEdit, pageStateRef, scheduleSave],
  );

  // The code editor and file writer share the same frontmatter model, so
  // editing code preserves named imports, interleaved statements and spacing.
  // Step 6, frontmatter: the block the code describes, as a request whose
  // slot is only what differs.
  const setFrontmatter = useCallback(
    (code: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      // Object.assign, as the legacy setFrontmatter did: the block's fields replace the model's.
      const written = (model: EditorModel): EditorModel =>
        Object.assign({}, model, readFrontmatter(code));
      const options = { coalesceKey: 'frontmatter', urgency: false };
      commitEdit(frontmatterGesture(state.model, options, written));
    },
    [commitEdit, pageStateRef],
  );
  return { setFrontmatter, setNodeText };
}

// A condition’s else branch, and the frontmatter’s declarations.
function useBranchEdits(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Adds or removes a condition's else branch. Removing keeps the markup that
  // was in it — it moves to the then branch rather than being deleted — so the
  // button can't quietly throw work away.
  // Step 9: the condition restated with its branches.
  const toggleElseBranch = useCallback(
    (nodeId: string, want: boolean) => {
      const state = pageStateRef.current.pageState;
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      if (!node || node.kind !== 'cond') {
        return;
      }
      const kids = node.children;
      const thenBranch: BranchNode = kids[0] ?? {
        id: newId(),
        kind: 'branch',
        name: 'then',
        children: [],
      };
      let next: EditorNode | undefined;
      if (want && kids.length < 2) {
        const elseBranch: BranchNode = { id: newId(), kind: 'branch', name: 'else', children: [] };
        next = { ...node, op: '?', children: [thenBranch, elseBranch] };
      } else if (!want && kids.length > 1) {
        const elseBranch = kids[1];
        assert(elseBranch !== undefined, 'Else branch exists before removal');
        const rescued = elseBranch.children || [];
        const merged = { ...thenBranch, children: [...(thenBranch.children || []), ...rescued] };
        next = { ...node, op: '&&', children: [merged] };
      }
      if (!next) {
        return;
      }
      commitEdit(nodeGesture(nodeId, next, { coalesceKey: undefined, urgency: true }));
    },
    [commitEdit, pageStateRef],
  );

  // Replaces the frontmatter's non-import code (its declarations), leaving the
  // import list alone. What the props panel edits when you open the source
  // behind a `{data}` prop — the imports aren't in play there, so they don't
  // need re-extracting.
  const setExtraFrontmatter = useCallback(
    (code: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const written = (model: EditorModel): EditorModel => ({ ...model, extraFrontmatter: code });
      const options = { coalesceKey: 'frontmatter', urgency: false };
      commitEdit(frontmatterGesture(state.model, options, written));
    },
    [commitEdit, pageStateRef],
  );
  return { setExtraFrontmatter, toggleElseBranch };
}

// A node’s text content and inline children.
function useContentEdits(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef } = coreState;
  const { commitEdit } = history;

  // Sets the text content of a component (single text child convenience).
  // Where each node's loose text last sat, so emptying the Content field and
  // typing again restores its place rather than appending.
  const textSlotRef = useRef<Record<string, number>>({});

  // Step 9: the text child restated, removed, or inserted where it last sat —
  // or, for a tag with no children yet (`<Card />`), the tag restated with it.
  const setNodeContent = useCallback(
    (nodeId: string, value: string) => {
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      const node = model ? findNodeById(model.nodes, nodeId) : undefined;
      if (!model || !node || node.kind === 'text') {
        return;
      }
      const options = { coalesceKey: `content:${nodeId}`, urgency: false };
      const children = node.children ?? undefined;
      const at = children ? children.findIndex((child) => child.kind === 'text') : -1;
      const textNode = children?.[at];
      // Emptying the field takes the text node out rather than leaving an
      // empty one behind — but where it sat is remembered, so clearing the
      // field and typing again puts the words back among the children
      // instead of after all of them.
      if (textNode) {
        if (value) {
          commitEdit(nodeGesture(textNode.id, { ...textNode, value }, options));
        } else {
          textSlotRef.current[nodeId] = at;
          commitEdit(removalGesture([textNode.id], { urgency: false }));
        }
        return;
      }
      if (!value) {
        return;
      }
      const text: EditorNode = { id: newId(), kind: 'text', value };
      if (!children) {
        commitEdit(nodeGesture(nodeId, withChildren(node, [text]), options));
        return;
      }
      const back = textSlotRef.current[nodeId];
      const index =
        back !== undefined && Number.isInteger(back) && back <= children.length
          ? back
          : children.length;
      commitEdit(insertGesture(model, text, { parentId: nodeId, index }, { urgency: false }));
    },
    [commitEdit, pageStateRef],
  );

  // Replaces a node's inline children wholesale (rich Content field edits).
  // Nodes arrive from the editor without ids — assign fresh ones.
  const setNodeInline = useCallback(
    (nodeId: string, kids: readonly InlineNode[]) => {
      // Step 9: the node restated with its new inline children.
      const state = pageStateRef.current.pageState;
      const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
      if (!node || node.kind === 'text') {
        return;
      }
      const next = withChildren(node, inlineWithIds(kids, 0));
      commitEdit(nodeGesture(nodeId, next, { coalesceKey: `content:${nodeId}`, urgency: false }));
    },
    [commitEdit, pageStateRef],
  );
  return { setNodeContent, setNodeInline };
}

// Changing the page’s layout.
function useLayoutChange(
  coreState: ReturnType<typeof useCoreState>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageState, pageStateRef, scan, setSelectedId } = coreState;
  const { resolveImportPath } = nodeEdits;
  const { commitEdit } = history;

  const isMarkdownFormatRef = useRef(false);
  isMarkdownFormatRef.current =
    pageState?.editable === true &&
    (pageState.model.format === 'md' || pageState.model.format === 'mdx');

  // The latest layout change, as an identity token (see pageLoadRef).
  const layoutSeq = useRef<object>({});
  const changeLayout = useCallback(
    async (layoutName: string) => {
      const seq = {};
      layoutSeq.current = seq;
      // A markdown page has no wrapper node to swap — Astro reads its layout
      // from the `layout:` frontmatter key, as a path relative to the file.
      // Same picker, different place to write the answer.
      if (isMarkdownFormatRef.current) {
        const layout = layoutName
          ? scan.layouts.find((candidate) => candidate.name === layoutName)
          : undefined;
        if (layoutName && !layout) {
          return;
        }
        // A file-relative path, not an alias: `layout:` is resolved by Astro
        // against the page, and every project has that whether or not it has
        // configured `@/…`.
        const rel = layout ? (await resolveImportPath(layout.path)).relative : undefined;
        if (seq !== layoutSeq.current) {
          return;
        }
        const shown = pageStateRef.current.pageState;
        if (!shown?.editable) {
          return;
        }
        // The YAML block the model now holds, written as the slot that
        // differs — or, on a post without one, a new block at its top.
        commitEdit(markdownLayoutGesture(shown.model, rel));
        return;
      }
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      if (!model) {
        return;
      }
      const wrapper = findNodeById(model.nodes, 'layout');
      if (!layoutName) {
        // Unwrap: the wrapper's tags go, its children stay where they are.
        if (wrapper) {
          commitEdit(withImportsGesture(model, unwrapGesture('layout'), withPrunedImports));
        }
        setSelectedId((id) => (id === 'layout' ? undefined : id));
        return;
      }
      const layout = scan.layouts.find((candidate) => candidate.name === layoutName);
      if (!layout) {
        return;
      }
      const paths = await resolveImportPath(layout.path);
      if (seq !== layoutSeq.current) {
        return;
      } // superseded by a newer change
      const gesture = layoutWrapperGesture(model, wrapper, { name: layout.name, paths });
      if (gesture) {
        commitEdit(gesture);
      }
    },
    [scan.layouts, commitEdit, resolveImportPath, pageStateRef, setSelectedId],
  );
  return { changeLayout, isMarkdownFormatRef };
}

// Creating and deleting pages.
function usePageCreation(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { currentPage, projectRef, scan, setCurrentPage, setPageState } = coreState;
  const { rescan, showToast } = lifecycle;
  const { selectPage } = navigation;

  // ----------------------------------------------------------------
  // Page management
  // ----------------------------------------------------------------

  const createPage = useCallback(
    async (name: string, layoutName: string | undefined) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      const layout = scan.layouts.find((candidate) => candidate.name === layoutName) || undefined;
      try {
        const pagePath = await createProjectPage(projectPath, name, layout);
        const result = await rescan(projectPath);
        const page = result.pages.find((candidate) => candidate.path === pagePath);
        if (page) {
          // Opening a page reports its own failures.
          void selectPage(page);
        }
        showToast(`Created ${name}.astro`, 'success');
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      }
    },
    [scan.layouts, rescan, selectPage, showToast, projectRef],
  );

  const deletePage = useCallback(
    async (page: ScanPage) => {
      if (
        !(await confirmDialog({
          title: `Delete ${page.name}?`,
          body:
            'This removes the file from disk. ' +
            'It can be brought back from History if it was saved in a version.',
          confirmLabel: 'Delete page',
          danger: true,
        }))
      ) {
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      await deleteProjectPage(page.path);
      const result = await rescan(projectPath);
      if (currentPage?.path === page.path) {
        const next = result.pages[0] || undefined;
        if (next) {
          // Opening a page reports its own failures.
          void selectPage(next);
        } else {
          setCurrentPage(undefined);
          setPageState(undefined);
        }
      }
      showToast(`Deleted ${page.name}`, 'success');
    },
    [currentPage, rescan, selectPage, showToast, projectRef, setCurrentPage, setPageState],
  );
  return { createPage, deletePage };
}

// Moving pages and creating folders.
function usePageMoves(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { pageStateRef, projectRef, scan } = coreState;
  const { rescan, showToast } = lifecycle;
  const { selectPage } = navigation;

  // Moves/renames a page (drag between folders, inline rename). `to` is the
  // new path relative to src/pages including the extension.
  const movePageTo = useCallback(
    async (page: ScanPage, to: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      try {
        const newPath = await moveProjectPage(projectPath, page.path, to);
        const result = await rescan(projectPath);
        if (pageStateRef.current.currentPage?.path === page.path) {
          const np = result.pages.find((candidate) => candidate.path === newPath);
          if (np) {
            // Opening a page reports its own failures.
            void selectPage(np);
          }
        }
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      }
    },
    [rescan, selectPage, showToast, pageStateRef, projectRef],
  );

  // Creates an (empty) folder with a placeholder name; the panel opens an
  // inline rename right after. Returns the created folder's name.
  const createPageFolder = useCallback(async () => {
    const existing = new Set(scan.pageFolders || []);
    let name = 'new-folder';
    for (let i = 2; existing.has(name); i++) {
      name = `new-folder-${i}`;
    }
    const projectPath = projectRef.current?.path;
    if (!projectPath) {
      return undefined;
    }
    try {
      await createProjectPageFolder(projectPath, name);
      await rescan(projectPath);
      return name;
    } catch (error: unknown) {
      showToast(cleanError(error), 'error');
      return undefined;
    }
  }, [scan, rescan, showToast, projectRef]);
  return { createPageFolder, movePageTo };
}

// Renaming a page folder.
function useRenamePageFolder(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { pageStateRef, projectRef } = coreState;
  const { rescan, showToast } = lifecycle;
  const { selectPage } = navigation;

  const renamePageFolder = useCallback(
    async (from: string, to: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      try {
        await renameProjectPageFolder(projectPath, from, to);
        const result = await rescan(projectPath);
        // Re-select the current page if it lived inside the renamed folder.
        const open = pageStateRef.current.currentPage;
        if (open && !result.pages.some((candidate) => candidate.path === open.path)) {
          const newName = open.name.startsWith(from + '/')
            ? to + open.name.slice(from.length)
            : undefined;
          const np = newName && result.pages.find((candidate) => candidate.name === newName);
          if (np) {
            // Opening a page reports its own failures.
            void selectPage(np);
          }
        }
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      }
    },
    [rescan, selectPage, showToast, pageStateRef, projectRef],
  );
  return { renamePageFolder };
}

// Deleting a page folder.
function useDeletePageFolder(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { pageStateRef, projectRef, setCurrentPage, setPageState } = coreState;
  const { rescan, showToast } = lifecycle;
  const { selectPage } = navigation;

  const deletePageFolder = useCallback(
    async (directory: string, pageCount: number) => {
      const inside = pageCount
        ? `the ${pageCount} page${pageCount === 1 ? '' : 's'} inside it and `
        : '';
      if (
        !(await confirmDialog({
          title: `Delete the folder “${directory}”?`,
          body: `This removes ${inside}the folder from disk.`,
          confirmLabel: 'Delete folder',
          danger: true,
        }))
      ) {
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      try {
        await deleteProjectPageFolder(projectPath, directory);
        const result = await rescan(projectPath);
        const open = pageStateRef.current.currentPage;
        if (open && !result.pages.some((candidate) => candidate.path === open.path)) {
          const next = result.pages[0] || undefined;
          if (next) {
            // Opening a page reports its own failures.
            void selectPage(next);
          } else {
            setCurrentPage(undefined);
            setPageState(undefined);
          }
        }
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      }
    },
    [rescan, selectPage, showToast, pageStateRef, projectRef, setCurrentPage, setPageState],
  );
  return { deletePageFolder };
}

// The page tree, and binding to a collection.
function useSelectionModel(
  shortcuts: ReturnType<typeof useShortcuts>,
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { model } = shortcuts;
  const { devStatus, devUrl, sampleAskedRef, selectedId, setCollectionSamples } = coreState;
  const { commitEdit } = history;

  // ----------------------------------------------------------------
  // Selection helpers
  // ----------------------------------------------------------------

  const tree = useMemo(() => createTreeIndex(model?.nodes), [model?.nodes]);
  const selectedAncestors = useMemo(
    () => (selectedId ? tree.ancestors(selectedId) || [] : []),
    [tree, selectedId],
  );

  // The frontmatter as one editable code block (imports + everything else,
  // matching how the file is serialized).
  const frontmatterCode = useMemo(() => (model ? writeFrontmatter(model) : ''), [model]);

  // One entry of a collection, asked for when someone opens it in the picker.
  // The ref is what stops a row that has no answer from asking again forever.
  const requestCollectionSample = (name: string): void => {
    if (!name || !devUrl || devStatus !== 'on') {
      return;
    }
    if (sampleAskedRef.current.has(name)) {
      return;
    }
    sampleAskedRef.current.add(name);
    readSampleEntry(devUrl, name)
      .then((entry) => setCollectionSamples((previous) => ({ ...previous, [name]: entry })))
      .catch(() => {});
  };

  // Binding to a collection this page doesn't read yet: the query that fetches
  // it is written here, and the binding then names it like any other value.
  // A query already targeting that collection is reused — one page asking the
  // same content twice is a page doing the same work twice.
  const ensureCollectionQuery = (collection: string): string => {
    const fm = model?.extraFrontmatter || '';
    const existing = queriesInScope(fm).get(collection);
    if (existing) {
      return existing;
    }
    const name = autoQueryName(collection, namesInScope(fm, model?.imports));
    if (!model) {
      return name;
    }
    // Step 9: the frontmatter gesture — the import and the query line, as the
    // slot of the block that differs.
    const queried = (pageModel: EditorModel): EditorModel => {
      const reads = pageModel.imports.some(
        (i) => i.name === 'getCollection' && i.path === 'astro:content',
      );
      const entry = {
        name: 'getCollection',
        imported: 'getCollection',
        path: 'astro:content',
        quote: "'",
        named: true,
      };
      const existing = pageModel.extraFrontmatter || '';
      const gap = existing && !existing.endsWith('\n') ? '\n' : '';
      // No trailing newline: the printer ends the line, and one added here
      // would be left behind as a blank line when the query is taken back.
      const query = `const ${name} = await getCollection('${collection}'); // ${QUERY_MARK}`;
      const imports = reads ? pageModel.imports : [...pageModel.imports, entry];
      return { ...pageModel, imports, extraFrontmatter: `${existing}${gap}${query}` };
    };
    commitEdit(frontmatterGesture(model, { coalesceKey: undefined, urgency: false }, queried));
    return name;
  };
  return {
    ensureCollectionQuery,
    frontmatterCode,
    requestCollectionSample,
    selectedAncestors,
    tree,
  };
}

// What the Components panel would make a component from.
function useCreateFrom(
  shortcuts: ReturnType<typeof useShortcuts>,
  coreState: ReturnType<typeof useCoreState>,
  selectionModel: ReturnType<typeof useSelectionModel>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
) {
  const { model } = shortcuts;
  const { classesForRef, classesTick, selectedId, setSelectedClasses } = coreState;
  const { frontmatterCode, tree } = selectionModel;
  const { propsNeededFor } = nodeEdits;

  const selectedNode: EditorNode | (FrontmatterSubject & { readonly value: string }) | undefined =
    model && selectedId
      ? selectedId === 'frontmatter'
        ? { id: 'frontmatter', kind: 'frontmatter', value: frontmatterCode }
        : tree.node(selectedId)
      : undefined;
  // What the Components panel's create button would act on: the name to suggest
  // for the selected element, or why there's nothing to make a component from.
  const createFrom = useMemo<ComponentCreationSource>(() => {
    if (!model) {
      return { kind: 'unavailable', reason: 'Open a page to make components from it.' };
    }
    // The frontmatter row is no element to make a component from.
    const node = selectedId && selectedId !== 'frontmatter' ? tree.node(selectedId) : undefined;
    if (!node) {
      return { kind: 'unavailable', reason: 'Select an element on the canvas first.' };
    }
    if (node.kind === 'text' || node.kind === 'expr') {
      return {
        kind: 'unavailable',
        reason: 'Select the element around this, not the text itself.',
      };
    }
    if (node.id === 'layout') {
      return { kind: 'unavailable', reason: 'A layout is already a component of its own.' };
    }
    if (node.kind !== 'element' && node.kind !== 'component') {
      return { kind: 'unavailable', reason: 'Select an element on the canvas first.' };
    }
    // Its first class is the name it already goes by — `.project-card` is a
    // better guess at a component name than `Div`. The tag is the fallback.
    const first = namesIn(node.props?.['class'])[0] || namesIn(node.props?.['class:list'])[0] || '';
    return {
      kind: 'ready',
      name: toComponentName(first) || toComponentName(node.name) || 'Component',
      label: `<${node.name}>`,
      // The page values it reads, which the new component can take as props.
      props: propsNeededFor(model, node),
    };
  }, [selectedId, tree, model, propsNeededFor]);

  // Rendered classes describe one element, and the canvas can only say what the
  // NEW selection's are a frame or two later. Two ways to spend that gap, and
  // both used to be wrong in one direction:
  //
  //   clear at once   the selector field empties and then refills, so every
  //                   click on the canvas flickers through a blank panel.
  //   keep the old    the field is briefly wrong rather than briefly empty,
  //                   which is steadier to look at — but if the report never
  //                   comes (an element the page doesn't render has no classes
  //                   to report) the wrong ones would sit there for good.
  //
  // So: keep the old ones, and only fall back to empty if nothing has arrived
  // by the time the gap stops being a gap. In practice the report lands first
  // and the timer never fires.
  useEffect(() => {
    if (classesForRef.current === selectedId) {
      return undefined;
    }
    const timer = setTimeout(
      () => setSelectedClasses((previous) => (previous.length ? [] : previous)),
      600,
    );
    return () => clearTimeout(timer);
  }, [selectedId, classesTick, classesForRef, setSelectedClasses]);
  return { createFrom, selectedNode };
}

// The layout, and the fields the selection takes.
function useSelectedSchema(
  selectionModel: ReturnType<typeof useSelectionModel>,
  layoutChange: ReturnType<typeof useLayoutChange>,
  shortcuts: ReturnType<typeof useShortcuts>,
  coreState: ReturnType<typeof useCoreState>,
  createFromScope: ReturnType<typeof useCreateFrom>,
) {
  const { tree } = selectionModel;
  const { isMarkdownFormatRef } = layoutChange;
  const { model } = shortcuts;
  const { insertables, scan, selectedId } = coreState;
  const { selectedNode } = createFromScope;

  const layoutNode = tree.node('layout');
  // The page may import its layout under any local name (e.g. `import Layout
  // from '../layouts/BaseLayout.astro'`) — resolve the wrapper back to a
  // scanned layout file name for display, pickers, and schema lookup.
  const currentLayoutName = (() => {
    // Markdown names its layout by path in frontmatter rather than wrapping
    // the page in a node, so the picker reads it from there.
    if (isMarkdownFormatRef.current) {
      // Read back out of the frontmatter text, not a cached field: editing
      // that text by hand has to move the picker too.
      const match = (model?.extraFrontmatter || '').match(
        /^[ \t]*layout[ \t]*:[ \t]*(.+?)[ \t]*$/m,
      );
      const base = match?.[1]
        ?.replace(/^['"]|['"]$/g, '')
        .split('/')
        .pop()
        ?.replace(/\.astro$/i, '');
      return base && scan.layouts.some((layout) => layout.name === base) ? base : '';
    }
    if (!layoutNode) {
      return '';
    }
    if (!model) {
      return '';
    }
    const imp = (model.imports || []).find((i) => i.name === layoutNode.name);
    const base = imp?.path
      .split('/')
      .pop()
      ?.replace(/\.astro$/i, '');
    if (base && scan.layouts.some((layout) => layout.name === base)) {
      return base;
    }
    return layoutNode.name ?? '';
  })();

  const selectedSchema: readonly FieldDefinition[] = (() => {
    if (!selectedNode) {
      return [];
    }
    if (selectedId === 'layout') {
      return schemaFor(scan.layouts.find((layout) => layout.name === currentLayoutName));
    }
    if (selectedNode.kind === 'element') {
      return withClassField(getElementSchema(selectedNode.name));
    }
    if (selectedNode.kind !== 'component') {
      return [];
    }
    if (selectedNode.dynamicTag) {
      return withClassField([]);
    }
    return schemaFor(
      selectedNode.astroAsset
        ? astroAssetDef(selectedNode.name)
        : insertables.find((component) => component.name === selectedNode.name),
    );
  })();
  return { currentLayoutName, layoutNode, selectedSchema };
}

// Slots, loop scope, and the instance a component was opened from.
function useScopeContext(
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { model } = shortcuts;
  const { currentLayoutName, selectedAncestors, selectedNode, tree } = pageOps;
  const { currentPage, editStack, insertables, scan, selectedId } = coreState;

  // Slots offered by the selected node's parent (the component or layout the
  // node is slotted into) — turns the `slot` attribute into a dropdown.
  let slotOptions: readonly string[] | undefined = undefined;
  if (model && selectedNode && selectedId !== 'layout') {
    const parent = selectedId ? tree.parent(selectedId) : undefined;
    if (parent) {
      if (parent.id === 'layout') {
        slotOptions =
          scan.layouts.find((layout) => layout.name === currentLayoutName)?.slots || undefined;
      } else if (parent.kind === 'component') {
        slotOptions =
          insertables.find((component) => component.name === parent.name)?.slots || undefined;
      }
    }
  }

  // In-scope data at the selection: the file's frontmatter declarations and
  // imports, plus the item/index variables of every enclosing loop. Feeds the
  // loop editor's source list and the content editor's expression chips.
  const loopContext =
    model && selectedNode
      ? {
          frontmatter: model.extraFrontmatter || '',
          imports: model.imports || [],
          ancestorHeads: selectedAncestors
            .slice(0, -1)
            .filter((node) => node.kind === 'map')
            .map((node) => node.head),
        }
      : undefined;

  // What the instance being edited is given.
  //
  // A component opened from the canvas is being looked at in one place, with
  // one set of props — and the panel knew them only by name and type, so a
  // field showing `{heading}` could not say what heading was. The instance
  // says: it is in the file this one was opened from, at the focused path, and
  // the page's own scope is what its expressions come to.
  const [instanceProps, setInstanceProps] = useState<Readonly<Record<string, unknown>> | undefined>(
    undefined,
  );
  const focusOf = currentPage?.kind === 'component' ? currentPage.focusPath : undefined;
  const hostFile = editStack.length > 1 ? editStack[0] : undefined;
  return { focusOf, hostFile, instanceProps, loopContext, setInstanceProps, slotOptions };
}

// What the instance being edited is given.
function useInstanceProps(
  scopeContext: ReturnType<typeof useScopeContext>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { focusOf, hostFile, setInstanceProps } = scopeContext;
  const { collectionSamples, collections, scan } = coreState;

  useEffect(() => {
    if (!focusOf || !hostFile?.path) {
      setInstanceProps(undefined);
      return undefined;
    }
    let dropped = false;
    void (async () => {
      try {
        const disk = await readPage(hostFile.path);
        const read = toEditorPageState(disk);
        if (dropped || !read.editable) {
          return;
        }
        const hostModel = read.model;
        const trail = (String(focusOf).split('|').pop() ?? '').split('.').map(Number);
        const instance = nodeAtPath(hostModel.nodes, trail);
        if (!instance) {
          setInstanceProps(undefined);
          return;
        }
        // The scope at the instance: the file's frontmatter, and the loops
        // around it — `project` inside `projects.map(…)` is what its props are
        // written against.
        const chain = ancestorChain(hostModel.nodes, instance.id) || [];
        setInstanceProps(
          resolveInstanceProps(instance, {
            frontmatter: hostModel.extraFrontmatter || '',
            imports: hostModel.imports || [],
            ancestorHeads: chain
              .slice(0, -1)
              .filter((node) => node.kind === 'map')
              .map((node) => node.head),
            collectionSamples,
            collections,
          }),
        );
      } catch {
        if (!dropped) {
          setInstanceProps(undefined);
        }
      }
    })();
    return () => {
      dropped = true;
    };
  }, [focusOf, hostFile?.path, collectionSamples, collections, scan, setInstanceProps]);
}

// Link targets and the Tag field’s options.
function useTagOptions(
  coreState: ReturnType<typeof useCoreState>,
  pageOps: ReturnType<typeof usePageOps>,
  shortcuts: ReturnType<typeof useShortcuts>,
) {
  const { insertables, project, scan } = coreState;
  const { tree } = pageOps;
  const { model } = shortcuts;

  // Link settings (href fields): pages to link to and the ids on this page
  // that anchor links can target.
  const linkContext = useMemo(
    () => ({
      pages: scan.pages,
      sectionIds: tree.sectionIds,
      projectPath: project?.path ?? '',
    }),
    [scan.pages, tree, project?.path],
  );

  // What the Tag field offers: every HTML tag, the project's components,
  // Astro's own, and anything this page's frontmatter already imports — which
  // is how `<AstroLogo />` from an imported .svg becomes reachable.
  // Each option carries what it is, so the list can wear the same icons the
  // insert palette does — a tag, a component, a layout, one of Astro's.
  const tagOptions = React.useMemo<readonly TagOption[]>(() => {
    const out: TagOption[] = [];
    const seen = new Set<string>();
    const add = (name: string, kind: string): void => {
      if (!name || seen.has(name)) {
        return;
      }
      seen.add(name);
      out.push({ name, kind });
    };
    for (const tag of HTML_TAGS) {
      add(tag, 'element');
    }
    for (const component of insertables) {
      add(component.name, component.isLayout ? 'layout' : 'component');
    }
    for (const asset of ASTRO_ASSETS) {
      add(asset.name, 'astroAsset');
    }
    for (const i of model?.imports || []) {
      add(i.name, 'component');
    }
    return out;
  }, [insertables, model]);
  return { linkContext, tagOptions };
}

// The floating code window.
function useCodeWindow(
  coreState: ReturnType<typeof useCoreState>,
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { codeWin, fileText, openCodeWindowRef, projectRef, setCodeWin, setFileText } = coreState;
  const { model } = shortcuts;
  const { frontmatterCode, selectedNode, tree } = pageOps;
  const { showToast } = lifecycle;

  // Floating code window target value: page frontmatter, a raw node's inner
  // content, or a text file from public/ (loaded into fileText).
  const isFileWin = codeWin?.kind === 'file';
  const codeWinNode =
    codeWin && !isFileWin && codeWin.targetId && codeWin.targetId !== 'frontmatter' && model
      ? tree.node(codeWin.targetId)
      : undefined;
  const codeWinValue = !codeWin
    ? undefined
    : isFileWin
      ? fileText
      : codeWin.targetId === 'frontmatter'
        ? model
          ? frontmatterCode
          : undefined
        : codeWinNode?.kind === 'raw'
          ? codeWinNode.inner
          : undefined;

  // Returns whether the subject actually has a code editor, so the Enter
  // shortcut below knows whether it handled the key.
  const openCodeWindowFor = (subject: CodeSubject | undefined): boolean => {
    const codeWindow = subject === undefined ? undefined : codeWindowFor(subject);
    if (codeWindow === undefined) {
      return false;
    }
    setCodeWin(codeWindow);
    return true;
  };
  const openCodeWindow = (): boolean => openCodeWindowFor(selectedNode);
  // A navigator double-click names its row instead of reading `selectedNode`
  // (see `openCode` in StructureTree). An id the tree no longer holds, a row
  // removed between the click and the render, opens nothing.
  const openCodeWindowById = (id: string): void => {
    openCodeWindowFor(id === 'frontmatter' ? FRONTMATTER_SUBJECT : tree.node(id));
  };
  // Read by the keydown effect, which is set up long before this exists.
  openCodeWindowRef.current = openCodeWindow;

  // Opens a public/ text file in the floating editor.
  const openAssetFile = useCallback(
    async ({ rel, name }: { readonly rel: string; readonly name: string }) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      try {
        const text = await readProjectAsset(projectPath, rel);
        setFileText(text);
        setCodeWin({
          kind: 'file',
          rel,
          title: name,
          language: /\.css$/i.test(name) ? 'css' : 'javascript',
        });
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      }
    },
    [showToast, projectRef, setCodeWin, setFileText],
  );
  return { codeWinValue, isFileWin, openAssetFile, openCodeWindow, openCodeWindowById };
}

// Opening the file an imported symbol comes from.
function useSymbolFile(
  coreState: ReturnType<typeof useCoreState>,
  pageOps: ReturnType<typeof usePageOps>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { currentPage, editStackRef, projectRef, setCodeWin, setFileText } = coreState;
  const { frontmatterCode } = pageOps;
  const { showToast } = lifecycle;

  // Opens the file an imported symbol is defined in, on its declaration —
  // `{FOOTER_LINKS}` on the page, the array itself in src/consts.ts. Values
  // declared in this file's own frontmatter never come here: those are edited
  // in place, in the panel (see the props panel's source popup).
  const openSymbolFile = useCallback(
    async (name: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return false;
      }
      const imp = findImportOf(frontmatterCode, name);
      if (!imp) {
        return false;
      }
      const stack = editStackRef.current;
      const fromFile = stack[stack.length - 1]?.path || currentPage?.path;
      if (!fromFile) {
        return false;
      }
      try {
        const symbol = await readSymbol(projectPath, fromFile, imp.spec, name);
        if (!symbol?.ok) {
          showToast(
            symbol?.reason === 'too-large'
              ? 'That file is too large to edit in the app.'
              : `Couldn't find where ${name} is defined (${imp.spec}).`,
            'error',
          );
          return false;
        }
        setFileText(symbol.text);
        setCodeWin({
          kind: 'file',
          area: 'src',
          rel: symbol.rel,
          title: symbol.rel,
          language: /\.css$/i.test(symbol.rel) ? 'css' : 'javascript',
          revealLine: symbol.line,
        });
        return true;
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
        return false;
      }
    },
    [frontmatterCode, currentPage, showToast, editStackRef, projectRef, setCodeWin, setFileText],
  );
  return { openSymbolFile };
}

// Asset file edits, and the preview-token gate.
function useCanvasGate(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  codeWindow: ReturnType<typeof useCodeWindow>,
) {
  const { codeWin, pageStateRef, projectRef, setCodeWin, setFileText } = coreState;
  const { fileSaverRef } = lifecycle;
  const { codeWinValue, isFileWin } = codeWindow;

  // File edits stream to disk (debounced) — the dev server picks them up.
  const setAssetFileText = useCallback(
    (text: string) => {
      setFileText(text);
      if (!codeWin || codeWin.kind !== 'file') {
        return;
      }
      const { rel, area } = codeWin;
      if (!rel) {
        return;
      }
      // Source files live anywhere in the project; assets are rooted in public/.
      const projectPath = projectRef.current?.path;
      const saver = fileSaverRef.current;
      if (!projectPath || !saver) {
        return;
      }
      saver.schedule(`${projectPath}|${area || 'public'}|${rel}`, () =>
        writeProjectFile(area ?? 'public', projectPath, rel, text),
      );
    },
    [codeWin, fileSaverRef, projectRef, setFileText],
  );

  // Close the window if its target disappears (page switch, node deleted).
  useEffect(() => {
    if (codeWin && !isFileWin && codeWinValue === undefined) {
      setCodeWin(undefined);
    }
  }, [codeWin, isFileWin, codeWinValue, setCodeWin]);

  // The preview-token gate (plan §9, step 7): a click selects only when the
  // canvas's rendering is the bytes the editor shows and the disk still holds
  // every file it came from. Read through refs at decision time, not captured.
  const judgeEvent = useCallback<JudgeCanvasEvent>(
    (token, render) => {
      const shown = (): ShownFile | undefined => {
        const { currentPage: open, pageState: state } = pageStateRef.current;
        const projectPath = projectRef.current?.path;
        if (!isOpenFile(open) || !state || !projectPath) {
          return undefined;
        }
        return {
          file: projectRelativePath(projectPath, open.path, window.avb.platform),
          state,
        };
      };
      const projectPath = projectRef.current?.path;
      const check: CheckRender = (checked) =>
        projectPath
          ? checkPreviewRender(projectPath, checked)
          : Promise.resolve<PreviewVerdict>({ tag: 'stale', reason: 'no-render', file: undefined });
      return judgeCanvasEvent(token, render, check, shown);
    },
    [pageStateRef, projectRef],
  );
  return { judgeEvent, setAssetFileText };
}

// Canvas notices, and the classes the page rendered with.
function useCanvasNotices(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
  shortcuts: ReturnType<typeof useShortcuts>,
) {
  const { showToast } = lifecycle;
  const { editStack, nodeClasses, project } = coreState;
  const { model } = shortcuts;

  const onStaleEvent = useCallback(
    (verdict: Extract<PreviewVerdict, { readonly tag: 'stale' }>) => {
      // Visible, never silent — and never a claim that anything was lost: the
      // click simply did not select. The canvas catches up on its own.
      const where = verdict.file ? ` (${verdict.file})` : '';
      showToast(`Click not applied: ${describePreviewStale(verdict.reason)}${where}`);
    },
    [showToast],
  );

  // Past the patcher's caps the canvas reloads instead of patching (step 7):
  // honest about it, so a scroll position or an open menu lost to a reload is
  // explained. The reloads a patch could never avoid — a script that changed —
  // are what the canvas always did, and stay quiet.
  const onPreviewReload = useCallback(
    (reason: PreviewReloadReason) => {
      const why = describePreviewReload(reason);
      if (why !== undefined) {
        showToast(why);
      }
    },
    [showToast],
  );

  const editedRel =
    editStack.length > 1 && project?.path
      ? projectRelativePath(
          project.path,
          editStack[editStack.length - 1]?.path ?? '',
          window.avb.platform,
        )
      : undefined;

  // The reported classes, keyed by node id — same walk as the render report,
  // so a path only has to be resolved once.
  const liveClassesById = React.useMemo(
    () =>
      nodeClasses && model
        ? classesByNodeId(nodeClasses, model.nodes, editedRel ? `${editedRel}|` : '')
        : undefined,
    [nodeClasses, model, editedRel],
  );

  // A class the source can't resolve — `class:list={["button_wrap", …]}` —
  // leaves a node named after its tag, or after a variable in the case of a
  // dynamic `<Tag>`. The page reports what each node rendered with, so the
  // breadcrumb and the canvas chip can say the same thing the navigator does.
  const liveLabel = (node: EditorNode, fromSource: string): string => {
    if (fromSource && fromSource !== node.name) {
      return fromSource;
    }
    const live = liveClassesById?.get(node.id);
    return live?.[0] ?? fromSource;
  };
  return { editedRel, liveClassesById, liveLabel, onPreviewReload, onStaleEvent };
}

// Breadcrumb labels and the file being edited.
function useCrumbLabels(
  pageOps: ReturnType<typeof usePageOps>,
  canvasNotices: ReturnType<typeof useCanvasNotices>,
  coreState: ReturnType<typeof useCoreState>,
  shortcuts: ReturnType<typeof useShortcuts>,
) {
  const { currentLayoutName } = pageOps;
  const { liveLabel } = canvasNotices;
  const { currentPage, editStack, project, setNodeClasses, setNodeStates } = coreState;
  const { setRenderedPaths } = coreState;
  const { model } = shortcuts;

  // Breadcrumb trail for the canvas toolbar: page → ancestors → selection.
  const crumbLabel = (node: EditorNode): string => {
    if (node.id === 'layout') {
      return currentLayoutName || node.name || 'layout';
    }
    switch (node.kind) {
      case 'text':
        return 'text';
      case 'comment':
        return 'comment';
      case 'expr':
        return 'code';
      case 'map': {
        const at = node.head.indexOf('.map');
        return at > 0 ? node.head.slice(0, at + 4) : 'loop';
      }
      case 'cond':
        return `if ${node.test}`;
      case 'branch':
        return node.name === 'else' ? 'else' : 'then';
      case 'element':
      case 'raw':
        // First class wins; fall back to the bare tag when the element has
        // none. Reads `class:list` too, so a component's inner elements are
        // named the same way the navigator names them.
        return liveLabel(node, elementLabel(node));
      case 'component':
      case 'raw-line':
      case 'chunk-group':
        // `<Tag>` from `const Tag = tag` renders a real element and its name
        // is a variable, so the class it rendered with names it better.
        if (node.dynamicTag) {
          return liveLabel(node, elementLabel(node));
        }
        return node.name || node.kind;
    }
  };

  // The file being edited, relative to src/ — how the CMS addresses a page's
  // own data (`pages/index.astro#rotatingWords`).
  const openEditableFile =
    editStack[editStack.length - 1] ?? (currentPage?.kind === 'route' ? undefined : currentPage);
  const openFileSourceRel = (() => {
    const path = openEditableFile?.path;
    if (!path || !project?.path) {
      return undefined;
    }
    const rel = projectRelativePath(project.path, path, window.avb.platform);
    return rel.startsWith('src/') ? rel.slice(4) : rel;
  })();
  // An edit renumbers paths, so a report from before it describes nodes that
  // have since moved. Drop it and show nothing until the page has re-rendered
  // and said so again — a marker on the wrong row is worse than none.
  useEffect(() => {
    setRenderedPaths(undefined);
    setNodeStates(undefined);
    setNodeClasses(undefined);
  }, [model, setNodeClasses, setNodeStates, setRenderedPaths]);

  // What the spacing box is pointing at, drawn over the selected element on the
  // canvas — see spacingBands.js.
  const [spacingHover, setSpacingHover] = useState<SpacingHover | undefined>(undefined);
  return { crumbLabel, openEditableFile, openFileSourceRel, setSpacingHover, spacingHover };
}

// The breadcrumb trail, and what the navigator marks.
function useCanvasMarks(
  coreState: ReturnType<typeof useCoreState>,
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  crumbLabels: ReturnType<typeof useCrumbLabels>,
  canvasNotices: ReturnType<typeof useCanvasNotices>,
) {
  const { currentPage, nodeStates, renderedPaths, selectedId } = coreState;
  const { model } = shortcuts;
  const { selectedAncestors, tree } = pageOps;
  const { crumbLabel } = crumbLabels;
  const { editedRel } = canvasNotices;

  const crumbs: PreviewCrumb[] = [];
  if (currentPage) {
    crumbs.push({
      id: undefined,
      label: currentPage.name.replace(/\.(astro|md)$/i, ''),
    });
  }
  if (model && selectedId === 'frontmatter') {
    crumbs.push({ id: 'frontmatter', label: 'Frontmatter' });
  } else if (model && selectedId) {
    const chain = selectedAncestors;
    // A then has no row in the navigator, so the trail doesn't name it either —
    // "if command › then › hero-command" said "then" to no one (see
    // branches.js).
    crumbs.push(
      ...chain
        .filter((node, i) => node !== thenBranch(chain[i - 1]))
        .map((node) => ({ id: node.id, label: crumbLabel(node) })),
    );
  }

  // Canvas outlines: nodes are addressed by their index path in the tree
  // (matching the marker paths the dev server's plugin injects).
  // While a component is open the tree is that component's file, not the
  // page, so ask in that file's namespace — the plugin marks every .astro
  // under src with one. The canvas still shows the page, where those markers
  // appear once per instance, so every instance outlines.
  // Which nodes put nothing on the page, as ids. A node counts as rendering if
  // it rendered something itself OR anything under it did: a layout wraps
  // <html>, so its own markers are split across <head> and <body> and never
  // pair up, but its children measure fine — without the ancestor closure it
  // would read as empty. Everything left over really did produce nothing,
  // including nodes inside a component that never evaluated its slot, whose
  // markers were never emitted at all.
  const emptyNodeIds = React.useMemo(
    () =>
      renderedPaths && model ? emptyNodeIdsOf(renderedPaths, model.nodes, editedRel) : undefined,
    [renderedPaths, model, editedRel],
  );

  // The reported paths as node ids, so the navigator can mark rows without
  // knowing anything about index paths.
  const stateIds = React.useMemo(() => {
    const empty = { hidden: new Set<string>(), inert: new Set<string>() };
    if (!nodeStates || !model) {
      return empty;
    }
    const prefix = editedRel ? `${editedRel}|` : '';
    const local = (path: string): string =>
      prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const ids = (paths: readonly string[]): ReadonlySet<string> => {
      const set = new Set<string>();
      for (const path of paths || []) {
        const id = tree.byPath.get(local(path))?.id;
        if (id) {
          set.add(id);
        }
      }
      return set;
    };
    return { hidden: ids(nodeStates.hidden), inert: ids(nodeStates.inert) };
  }, [nodeStates, model, editedRel, tree]);
  return { crumbs, emptyNodeIds, stateIds };
}

// Marker paths, the selection trail, and the tab highlight.
function useSelectionPaths(
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  canvasNotices: ReturnType<typeof useCanvasNotices>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { model } = shortcuts;
  const { tree } = pageOps;
  const { editedRel } = canvasNotices;
  const { currentPage, editStack, pageState, project, rightTab, rightTabRefs } = coreState;
  const { selectedId, selectionKeysRef, setRightTabInd } = coreState;

  const pathFor = (id: string | undefined): string | undefined => {
    if (!model || !id) {
      return undefined;
    }
    const path = tree.path(id);
    if (path === undefined) {
      return undefined;
    }
    return editedRel ? `${editedRel}|${path}` : path;
  };
  // The right panel stays on whichever tab the user picked, whatever gets
  // selected next. (S / D switch it by hand.)

  // What ⇧⌘C copies: the route an editor would take to reach the selection —
  // the page, the instance of each component drilled into on the way down,
  // then the node itself — so an agent reading it lands on the markup the user
  // is looking at, not on some other use of the same component. With nothing
  // selected the open file alone still says where the user is.
  //
  // Deliberately "<file>#<index path>" rather than a marker path: a marker is
  // namespaced only when it names a component, and every entry here needs to
  // say which file it belongs to. The file is the one open at that level of the
  // stack, so it's read from the stack rather than parsed out of the key.
  // Through a ref because the menu handler is bound long before this is in scope.
  const relOf = (abs: string | undefined): string | undefined =>
    abs && project?.path ? projectRelativePath(project.path, abs, window.avb.platform) : undefined;
  const openRel = relOf(currentPage?.path);
  const leafPath = selectedId ? tree.path(selectedId) : undefined;
  selectionKeysRef.current = !openRel
    ? []
    : [
        ...editStack
          .slice(1)
          .map((entry, i) => {
            const host = relOf(editStack[i]?.path);
            return entry.hostKey && host
              ? `${host}#${trailOf(entry.hostKey).join('.')}`
              : undefined;
          })
          .filter((key): key is string => key !== undefined),
        selectedId === 'frontmatter'
          ? `${openRel}#frontmatter`
          : leafPath !== undefined
            ? `${openRel}#${leafPath}`
            : `${openRel}#`,
      ];

  // Position the Style/Settings highlight: on tab change, when the panel first
  // appears, and whenever the tab strip's width changes.
  useLayoutEffect(() => {
    const measure = () => {
      const tabButton = rightTabRefs.current[rightTab];
      setRightTabInd(
        tabButton ? { left: tabButton.offsetLeft, width: tabButton.offsetWidth } : undefined,
      );
    };
    measure();
    const strip = rightTabRefs.current[rightTab]?.parentElement;
    if (!strip || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [rightTab, pageState?.editable, rightTabRefs, setRightTabInd]);
  return { openRel, pathFor };
}

// What a canvas outline says about its node.
function useOverlayInfo(
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  crumbLabels: ReturnType<typeof useCrumbLabels>,
) {
  const { model } = shortcuts;
  const { currentLayoutName } = pageOps;
  const { crumbLabel } = crumbLabels;

  const overlayInfo = (path: string): OverlayInfo | undefined => {
    if (!model || !path) {
      return undefined;
    }
    const node = nodeAtPath(model.nodes, trailOf(path));
    if (!node) {
      return undefined;
    }
    const label =
      node.id === 'layout' ? currentLayoutName || node.name || 'layout' : crumbLabel(node);
    // Fragments group inline content rather than referring to another component.
    // Their outlines use ordinary element styling, as dynamic tags already do.
    const kind = isFragmentNode(node)
      ? 'element'
      : node.kind === 'component' && !node.dynamicTag
        ? 'component'
        : node.kind === 'map' || node.kind === 'cond' || node.kind === 'branch'
          ? 'map'
          : 'element';
    // The tag drives the overlay's icon, so it matches the Navigator row.
    const tag = node.kind === 'element' || node.kind === 'raw' ? node.name : undefined;
    return {
      label,
      kind,
      tag,
      astroAsset: !!node.astroAsset,
      dynamicTag: !!node.dynamicTag,
      nodeKind: node.kind,
      isLayout: node.id === 'layout',
      bound: kind === 'element' && isDataBound(node),
    };
  };
  return { overlayInfo };
}

// Which nodes put nothing on the page, as ids: see emptyNodeIds in App.
function emptyNodeIdsOf(
  renderedPaths: readonly string[],
  nodes: readonly EditorNode[],
  editedRel: string | undefined,
): ReadonlySet<string> {
  const prefix = editedRel ? `${editedRel}|` : '';
  const live = new Set<string>();
  for (const path of renderedPaths) {
    const local = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const parts = local.split('.');
    for (let i = parts.length; i > 0; i--) {
      live.add(parts.slice(0, i).join('.'));
    }
  }
  // Only kinds where "renders nothing" is a fact about the page. A comment,
  // the frontmatter row or a doctype line never renders and saying so on
  // every one of them would be noise.
  const MARKABLE = new Set(['element', 'component', 'map']);
  // …and neither <Fragment> nor <slot> ever puts an element on the page, so
  // there is nothing for the page to report about them and nothing to carry
  // their path. What they hold answers for them: children of either are
  // marked, and a live child makes its ancestors live. `<Fragment set:html>`
  // has no children to speak up, which is exactly the case where the panel
  // cannot tell — and saying "renders nothing" is the wrong half to guess.
  const answers = (node: EditorNode): boolean => MARKABLE.has(node.kind) && rendersOwnElement(node);
  const ids = new Set<string>();
  // An inline run — words with <a>, <strong>, <span> among them — is written
  // as one line, and markers inside it would render as spaces, so nothing in
  // there carries one. The page therefore says nothing about those nodes,
  // which is not the same as saying they rendered nothing: `unmarked` keeps
  // a link sitting in a sentence from being reported as invisible.
  const walk = (
    list: readonly EditorNode[],
    trail: readonly number[],
    { unmarked }: { readonly unmarked: boolean },
  ): void => {
    const depth = trail.length;
    assert(depth <= LIMITS.treeDepthMax, 'emptyNodeIdsOf: depth exceeds the tree cap');
    list.forEach((node, i) => {
      const nodeTrail = [...trail, i];
      if (!unmarked && answers(node) && !live.has(nodeTrail.join('.'))) {
        ids.add(node.id);
      }
      if (Array.isArray(node.children)) {
        const inline = unmarked || isInlineRun(node.children);
        walk(node.children, nodeTrail, { unmarked: inline });
      }
    });
  };
  walk(nodes, [], { unmarked: false });
  return ids;
}

// What a delete leaves unused: the imports and declarations only the removed
// nodes were reading (the legacy removeNode's rule). Pure: a new model.
function prunedAfterRemoval(model: EditorModel): {
  readonly model: EditorModel;
  readonly dropped: readonly string[];
} {
  const next = withPrunedImports(model);
  // The code the deleted markup was the only reader of goes with it: a
  // `const jobs = […]` nothing lists any more is left behind otherwise, and a
  // page collects them one deletion at a time. Only what nothing else
  // mentions — another declaration included — and never an export, which is
  // the page's own interface to Astro.
  const dead = unusedDeclarations(next).map((declaration) => declaration.name);
  if (dead.length) {
    const extraFrontmatter = withoutDeclarations(next.extraFrontmatter, dead);
    return { model: { ...next, extraFrontmatter }, dropped: dead };
  }
  return { model: next, dropped: dead };
}

// The frontmatter a model describes, compared as data.
function frontmatterOf(model: PageModel): string {
  return JSON.stringify([model.imports, model.extraFrontmatter]);
}

// What survives the page's history being dropped (dropPageHistory).
function keepsAcrossPages(entry: HistoryEntry): boolean {
  switch (entry.kind) {
    case 'cmd':
      return true;
    case 'edits':
      // Only an applied one: its inverses are all it needs.
      if (entry.record.outcome.tag === 'applied') {
        return entry.record.outcome.applied.length > 0;
      }
      return false;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

function BusyOverlay({ message }: { readonly message: string }) {
  return (
    <div className="busy-overlay">
      <div className="spinner" />
      <div>{message}</div>
    </div>
  );
}

function Toast({ toast }: { readonly toast: ToastMessage }) {
  return <div className={`toast ${toast.kind}`}>{toast.msg}</div>;
}
