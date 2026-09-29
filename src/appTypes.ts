import type { CSSProperties } from 'react';
import type { Data } from '../shared/boundary';
import type { IpcResults, WireGitInfo, WireInjectedRoute } from '../shared/ipc-results';
import type { Digest } from '../shared/brand';
import type { ParsePageResult } from '../shared/page-node';
import type { ScanResult } from '../shared/scan';
import type { AssetRequest } from './assetPick';
import type { CoalescedRun } from './coalescedRun';
import { carryHandles, carryRoundTrip, randomSeed, seedOf } from './nodeHandles';
import type { EditsRecord, PageOrigin } from './pageEdits';
import { saveStateClean, type SaveState } from './saveState';
import type { VariableSelection } from './variablesBridge';
import {
  cloneEditorModel,
  type EditorModel,
  type EditorNode,
} from '../shared/editor-model';

export { cloneEditorModel, nodeId } from '../shared/editor-model';
export type { EditorModel, EditorNode } from '../shared/editor-model';

export interface ProjectIdentity {
  readonly path: string;
  readonly name: string;
}

export type OpenKind = 'page' | 'component';
export interface OpenFile {
  readonly kind: OpenKind;
  readonly path: string;
  readonly name: string;
  readonly route?: string;
  readonly focusPath?: string | null;
  readonly focusOcc?: number;
  readonly focusWhole?: boolean;
  readonly hostKey?: string | null;
}

export interface OpenRoute {
  readonly kind: 'route';
  readonly name: string;
  readonly route: string;
  readonly from: string | null;
  readonly path?: undefined;
}

export type CurrentPage = OpenFile | OpenRoute;

interface PageStateBase {
  readonly source: string;
  /** Where this state stands against the file on disk (plan §7). */
  readonly save: SaveState;
}

export interface EditablePageState extends PageStateBase {
  readonly editable: true;
  readonly model: EditorModel;
  /** The text `model` is a parse of — for nodes a gesture changed or made,
   * the parse the gesture was applied to. Its source ranges index this text,
   * and handles are carried from it onto the next parse (src/nodeHandles.ts). */
  readonly parsedFrom: string;
  /** The page as the app's last read or reply left it (an .astro page): edit
   * requests are stated against it when they are sent. */
  readonly origin: PageOrigin | undefined;
}

export interface RawPageState extends PageStateBase {
  readonly editable: false;
  readonly reason: string;
  readonly bail: { readonly what: string; readonly near: string } | null;
}

export type EditorPageState = EditablePageState | RawPageState;

export interface PageStateSnapshot {
  readonly currentPage: CurrentPage | null;
  readonly pageState: EditorPageState | null;
}

export interface UndoCommand {
  readonly kind: 'cmd';
  readonly undo: () => unknown | Promise<unknown>;
  redo: () => unknown | Promise<unknown>;
  label?: string;
  readonly coalesceKey?: string | null;
}

/** An undo step of the open page: its writes' inverses, which Undo submits
 * against the checksums they were returned with (plan §11.9: undo is inverse
 * splices only). The record is mutable: answers arrive after the entry is
 * pushed. */
export interface EditsEntry {
  readonly kind: 'edits';
  readonly record: EditsRecord;
}

export type HistoryEntry = UndoCommand | EditsEntry;
export interface AppHistory {
  past: HistoryEntry[];
  future: HistoryEntry[];
  lastPush: number;
  lastKey: string | null;
}

export type ToastKind = 'info' | 'success' | 'error';
export interface ToastMessage {
  readonly msg: string;
  readonly kind: ToastKind;
}

export type LeftTab =
  | 'pages'
  | 'navigator'
  | 'properties'
  | 'components'
  | 'assets'
  | 'cms'
  | 'variables'
  | 'code'
  | 'history'
  | null;
export type RightTab = 'style' | 'settings';
export type DevStatus = 'off' | 'starting' | 'on';
export type TrailingSlash = 'always' | 'never' | 'ignore';

export interface NodeStates {
  readonly hidden: readonly string[];
  readonly inert: readonly string[];
}

export interface CodeWindowState {
  readonly kind?: 'file';
  readonly area?: 'src';
  readonly targetId?: string;
  readonly rel?: string;
  readonly title: string;
  readonly language: string;
  readonly revealLine?: number;
}

export interface PreviewCommitInfo {
  readonly url: string;
  readonly subject: string | undefined;
  readonly when: string | undefined;
}

export type DynamicEntry = IpcResults['page:dynamicPaths']['entries'][number];
export type CollectionSample = Data | null;
export type CollectionSamples = Readonly<Record<string, CollectionSample>>;
export type ItemIndexes = Readonly<Record<string, number>>;
export type GitInfo = IpcResults['git:info'];
export type RepositoryInfo = WireGitInfo;
export type InjectedRoute = WireInjectedRoute;
export type VariablesGroup = VariableSelection;
export type RightTabIndicator = Pick<CSSProperties, 'left' | 'width'>;
export type AssetPick = AssetRequest;

/** The open project's scans: one in flight, at most one waiting. */
export interface ProjectScans {
  readonly projectPath: string;
  readonly scans: CoalescedRun<ScanResult>;
}

export interface NodeClipboard {
  readonly node: EditorNode;
  readonly vars: readonly string[];
  readonly frontmatter: string;
  readonly imports: readonly { readonly name: string; readonly path: string }[];
  readonly pagePath: string | null;
}

export function findEditorNodeById(
  nodes: readonly EditorNode[] | null | undefined,
  id: string,
): EditorNode | null {
  const pending = [...(nodes ?? [])];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (visited > 100_000) {
      throw new Error('Editor node lookup exceeds limit');
    }
    const node = pending.shift();
    if (!node) {
      continue;
    }
    if (node.id === id) {
      return node;
    }
    if ('children' in node && Array.isArray(node.children)) {
      pending.unshift(...node.children);
    }
  }
  return null;
}

export function findEditorParentList(
  model: EditorModel,
  id: string,
): { readonly list: EditorNode[]; readonly index: number } | null {
  const pending: EditorNode[][] = [model.nodes];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (visited > 100_000) {
      throw new Error('Editor parent lookup exceeds limit');
    }
    const list = pending.shift();
    if (!list) {
      continue;
    }
    const index = list.findIndex((node) => node.id === id);
    if (index >= 0) {
      return { list, index };
    }
    for (const node of list) {
      if ('children' in node && Array.isArray(node.children)) {
        pending.push(node.children);
      }
    }
  }
  return null;
}

/** A page as a read or a reply left it: clean, and — an .astro page — its
 * own origin. */
export function toEditorPageState(
  input: ParsePageResult & { readonly source: string; readonly checksum: Digest },
): EditorPageState {
  const save = saveStateClean(input.checksum);
  const source = input.source;
  if (!input.editable) {
    return { editable: false, reason: input.reason, bail: input.bail, source, save };
  }
  const model = cloneEditorModel(input.model);
  const origin =
    input.model.format === undefined
      ? { checksum: input.checksum, source, model: input.model }
      : undefined; // Markdown and MDX join the engine at step 10.
  return { editable: true, model, source, parsedFrom: source, save, origin };
}

/** A fresh parse with the session's handles, carried from the page state it
 * replaces by the byte diff (src/nodeHandles.ts): a reload, typed code's
 * parse, a code save's reply. A Markdown reply is a round trip of the model
 * sent. Replies to the app's own gestures are carried from the origin by the
 * saver, with the gesture's own prediction — never from the view, which also
 * holds newer gestures' nodes. Unchanged when either side is not editable. */
export function carriedParse<Parsed extends ParsePageResult & { readonly source: string }>(
  local: EditorPageState | null,
  parsed: Parsed & { readonly checksum?: Digest },
): Parsed {
  if (!isEditableState(local) || !parsed.editable) {
    return parsed;
  }
  if (parsed.model.format !== undefined) {
    const model = carryRoundTrip(local.model, parsed.model);
    return model === undefined ? parsed : { ...parsed, model };
  }
  const before = { source: local.parsedFrom, model: local.model };
  const checksum = parsed.checksum;
  const seed = checksum === undefined ? randomSeed() : seedOf(checksum);
  const after = { source: parsed.source, seed, model: parsed.model };
  return { ...parsed, model: carryHandles({ before, after, own: undefined, predicted: undefined }) };
}

export function isOpenFile(page: CurrentPage | null): page is OpenFile {
  return page?.kind === 'page' || page?.kind === 'component';
}

export function isEditableState(state: EditorPageState | null): state is EditablePageState {
  return state?.editable === true;
}
