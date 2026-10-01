import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRequest } from '../assetPick';
import type { AssetPanelEntry } from '../assetPanelBridge';
import type { Result } from '../../shared/result';
import { BOUNDARY_LIMITS, pathText } from '../../shared/boundary';
import {
  deleteAsset,
  makeAssetDirectory,
  moveAsset,
  onAssetListingChanged,
  pickUploadAssets,
  readAssetListing,
  renameAsset,
  uploadAssets,
} from '../assetPanelBridge';
import {
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  TrashIcon,
  UploadCloudIcon,
} from '../ui/Icons';
import AssetThumb, { TEXT_EXT } from '../ui/AssetThumb';
import MoreMenu from '../ui/MoreMenu';
import { confirmDialog } from '../ui/ConfirmDialog';
import { allowDragEffect } from '../editor/dragState';

const PICK_HOME = 'src/assets';
const FILE_DROP_COUNT_MAX = 1_000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|oga)$/i;

type AssetFile = Extract<AssetPanelEntry, { readonly isDir: false }>;
type Toast = (message: string, kind: 'error') => void;

export interface AssetUndo {
  readonly label: string;
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
}

interface AssetsPanelProps {
  readonly project: { readonly path: string };
  readonly showToast: Toast;
  readonly onOpenFile?: (file: { readonly rel: string; readonly name: string }) => void;
  readonly pick?: AssetRequest | undefined;
  readonly onPickCancel?: () => void;
  readonly onRecordUndo?: (command: AssetUndo) => void;
}

interface AssetPanelState {
  readonly entries: readonly AssetPanelEntry[];
  readonly missing: boolean;
  readonly cwd: string;
  readonly setCwd: React.Dispatch<React.SetStateAction<string>>;
  readonly renaming: string | undefined;
  readonly setRenaming: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly newFolder: boolean;
  readonly setNewFolder: React.Dispatch<React.SetStateAction<boolean>>;
  readonly dragTarget: string | undefined;
  readonly setDragTarget: React.Dispatch<React.SetStateAction<string | undefined>>;
}

export default function AssetsPanel(props: AssetsPanelProps) {
  const state = useAssetPanelState(props);
  const actions = useAssetActions(props, state);
  if (state.missing && state.entries.length === 0) {
    return <MissingAssets onUpload={() => void actions.pickUpload('')} />;
  }
  return <AssetPanelBody props={props} state={state} actions={actions} />;
}

function useAssetPanelState(props: AssetsPanelProps): AssetPanelState {
  const [entries, setEntries] = useState<readonly AssetPanelEntry[]>([]);
  const [missing, setMissing] = useState(false);
  const [cwd, setCwd] = useState('');
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [newFolder, setNewFolder] = useState(false);
  const [dragTarget, setDragTarget] = useState<string | undefined>(undefined);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  useAssetListing(props.project.path, props.showToast, cwdRef, setEntries, setMissing, setCwd);
  usePickPlacement(props.project.path, props.pick, entries, setCwd);
  useEffect(() => {
    setCwd('');
    setRenaming(undefined);
    setNewFolder(false);
    setDragTarget(undefined);
  }, [props.project.path]);
  return {
    entries,
    missing,
    cwd,
    setCwd,
    renaming,
    setRenaming,
    newFolder,
    setNewFolder,
    dragTarget,
    setDragTarget,
  };
}

function useAssetListing(
  projectPath: string,
  showToast: Toast,
  cwdRef: React.MutableRefObject<string>,
  setEntries: React.Dispatch<React.SetStateAction<readonly AssetPanelEntry[]>>,
  setMissing: React.Dispatch<React.SetStateAction<boolean>>,
  setCwd: React.Dispatch<React.SetStateAction<string>>,
): void {
  const callbacks = useRef({ showToast, setEntries, setMissing, setCwd });
  callbacks.current = { showToast, setEntries, setMissing, setCwd };
  useEffect(() => {
    let active = true;
    let reading = false;
    let pending = false;
    // It calls itself again only after its read has settled, never on the stack.
    // eslint-disable-next-line stacki/bounded-recursion -- Re-entry after an awaited read.
    async function refresh(): Promise<void> {
      if (reading) {
        pending = true;
        return;
      }
      reading = true;
      const result = await readAssetListing(projectPath);
      if (active) {
        applyListingResult(result, cwdRef.current, callbacks.current);
      }
      reading = false;
      if (active && pending) {
        pending = false;
        void refresh();
      }
    }
    void refresh();
    const dispose = onAssetListingChanged(() => void refresh());
    return () => {
      active = false;
      dispose();
    };
  }, [cwdRef, projectPath]);
}

function applyListingResult(
  result: Awaited<ReturnType<typeof readAssetListing>>,
  cwd: string,
  callbacks: {
    readonly showToast: Toast;
    readonly setEntries: React.Dispatch<React.SetStateAction<readonly AssetPanelEntry[]>>;
    readonly setMissing: React.Dispatch<React.SetStateAction<boolean>>;
    readonly setCwd: React.Dispatch<React.SetStateAction<string>>;
  },
): void {
  if (!result.ok) {
    callbacks.showToast(result.error, 'error');
    return;
  }
  callbacks.setEntries(result.value.entries);
  callbacks.setMissing(result.value.missing);
  if (cwd && !result.value.entries.some((entry) => entry.isDir && entry.rel === cwd)) {
    callbacks.setCwd('');
  }
}

function usePickPlacement(
  projectPath: string,
  pick: AssetRequest | undefined,
  entries: readonly AssetPanelEntry[],
  setCwd: React.Dispatch<React.SetStateAction<string>>,
): void {
  const pickKey = pick ? `${projectPath}:${pick.mediaKind}:${pick.current}` : undefined;
  const placedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!pick) {
      placedRef.current = undefined;
      return;
    }
    if (placedRef.current === pickKey) {
      return;
    }
    if (pick.current.includes('/')) {
      setCwd(parentOf(pick.current));
      placedRef.current = pickKey;
      return;
    }
    if (entries.length === 0) {
      return;
    }
    const hasMatch = entries.some(
      (entry) => !entry.isDir && isInPickHome(entry.rel) && kindMatches(pick.mediaKind, entry.name),
    );
    setCwd(hasMatch ? PICK_HOME : '');
    placedRef.current = pickKey;
  }, [entries, pick, pickKey, setCwd]);
}

interface AssetActions {
  readonly pickUpload: (destinationRel: string) => Promise<void>;
  readonly makeDirectory: (name: string) => Promise<void>;
  readonly commitRename: (entry: AssetPanelEntry, value: string) => void;
  readonly remove: (file: AssetFile) => void;
  readonly dropInto: (destinationRel: string) => React.DragEventHandler<HTMLElement>;
  readonly dragOverInto: (destinationRel: string) => React.DragEventHandler<HTMLElement>;
}

function useAssetActions(props: AssetsPanelProps, state: AssetPanelState): AssetActions {
  const { project, showToast } = props;
  const { cwd, setDragTarget, setRenaming } = state;
  const pickUpload = useCallback(
    async (destinationRel: string): Promise<void> => {
      reportResult(await pickUploadAssets(project.path, destinationRel), showToast);
    },
    [project.path, showToast],
  );
  const makeDirectory = useCallback(
    async (name: string): Promise<void> => {
      reportResult(await makeAssetDirectory(project.path, cwd, name), showToast);
    },
    [cwd, project.path, showToast],
  );
  const move = useAssetMove(props);
  const rename = useAssetRename(props);
  const remove = useAssetRemove(props);
  const commitRename = useCallback(
    (entry: AssetPanelEntry, value: string): void => {
      setRenaming(undefined);
      void rename(entry, value);
    },
    [rename, setRenaming],
  );
  const dropInto = useDropInto(project.path, showToast, setDragTarget, move);
  const dragOverInto = useDragOverInto(setDragTarget);
  return { pickUpload, makeDirectory, commitRename, remove, dropInto, dragOverInto };
}

function useAssetMove(props: AssetsPanelProps) {
  const { project, showToast, onRecordUndo } = props;
  const execute = useCallback(
    async (fromRel: string, toDirectoryRel: string): Promise<boolean> => {
      const result = await moveAsset(project.path, fromRel, toDirectoryRel);
      if (!result.ok) {
        showToast(result.error, 'error');
        return false;
      }
      if (!result.value) {
        showToast('That asset was already gone.', 'error');
        return false;
      }
      return true;
    },
    [project.path, showToast],
  );
  return useCallback(
    async (fromRel: string, toDirectoryRel: string): Promise<void> => {
      if (!(await execute(fromRel, toDirectoryRel))) {
        return;
      }
      const fromDirectory = parentOf(fromRel);
      const name = basename(fromRel);
      const landedRel = toDirectoryRel ? `${toDirectoryRel}/${name}` : name;
      onRecordUndo?.({
        label: `move ${name}`,
        undo: async () => void (await execute(landedRel, fromDirectory)),
        redo: async () => void (await execute(fromRel, toDirectoryRel)),
      });
    },
    [execute, onRecordUndo],
  );
}

function useAssetRename(props: AssetsPanelProps) {
  const { project, showToast, onRecordUndo } = props;
  const execute = useCallback(
    async (rel: string, newName: string): Promise<boolean> => {
      const result = await renameAsset(project.path, rel, newName);
      return reportResult(result, showToast);
    },
    [project.path, showToast],
  );
  return useCallback(
    async (entry: AssetPanelEntry, value: string): Promise<void> => {
      const clean = value.trim();
      if (!clean || clean === entry.name || !(await execute(entry.rel, clean))) {
        return;
      }
      const directory = parentOf(entry.rel);
      const renamedRel = directory ? `${directory}/${clean}` : clean;
      onRecordUndo?.({
        label: `rename to ${clean}`,
        undo: async () => void (await execute(renamedRel, entry.name)),
        redo: async () => void (await execute(entry.rel, clean)),
      });
    },
    [execute, onRecordUndo],
  );
}

function useAssetRemove(props: AssetsPanelProps) {
  const { project, showToast } = props;
  return useCallback(
    (file: AssetFile): void => {
      void removeAsset(file, project.path, showToast);
    },
    [project.path, showToast],
  );
}

async function removeAsset(file: AssetFile, projectPath: string, showToast: Toast): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Delete ${file.name}?`,
    body:
      'The file moves to your Bin. Anything on the site still pointing at ' +
      `/${file.rel} will stop finding it.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  const result = await deleteAsset(projectPath, file.rel);
  if (!result.ok) {
    showToast(result.error, 'error');
    return;
  }
  if (!result.value) {
    showToast(`${file.name} was already gone.`, 'error');
  }
}

function useDropInto(
  projectPath: string,
  showToast: Toast,
  setDragTarget: AssetPanelState['setDragTarget'],
  move: (fromRel: string, destinationRel: string) => Promise<void>,
) {
  return useCallback(
    (destinationRel: string): React.DragEventHandler<HTMLElement> =>
      (event): void => {
        event.preventDefault();
        event.stopPropagation();
        setDragTarget(undefined);
        const payload = dropPayload(event.dataTransfer);
        if (!payload.ok) {
          showToast(payload.error, 'error');
          return;
        }
        if (!payload.value) {
          return;
        }
        if (payload.value.kind === 'asset') {
          if (
            payload.value.rel === destinationRel ||
            parentOf(payload.value.rel) === destinationRel
          ) {
            return;
          }
          void move(payload.value.rel, destinationRel);
          return;
        }
        void uploadDropped(projectPath, showToast, destinationRel, payload.value.paths);
      },
    [move, projectPath, setDragTarget, showToast],
  );
}

function useDragOverInto(setDragTarget: AssetPanelState['setDragTarget']) {
  return useCallback(
    (destinationRel: string): React.DragEventHandler<HTMLElement> =>
      (event): void => {
        if (acceptsDrop(event.dataTransfer)) {
          event.preventDefault();
          event.stopPropagation();
          setDragTarget(destinationRel);
        }
      },
    [setDragTarget],
  );
}

async function uploadDropped(
  projectPath: string,
  showToast: Toast,
  destinationRel: string,
  paths: readonly string[],
): Promise<void> {
  reportResult(await uploadAssets(projectPath, destinationRel, paths), showToast);
}

type DropPayload =
  | { readonly kind: 'asset'; readonly rel: string }
  | { readonly kind: 'os'; readonly paths: readonly string[] };

// A drop carrying nothing usable is ok with no payload, not an error.
function dropPayload(transfer: DataTransfer): Result<DropPayload | undefined, string> {
  const rel = transfer.getData('avb/asset');
  if (rel) {
    try {
      return { ok: true, value: { kind: 'asset', rel: parseAssetRel(rel) } };
    } catch (error: unknown) {
      return { ok: false, error: String(error) };
    }
  }
  if (transfer.files.length > FILE_DROP_COUNT_MAX) {
    return { ok: false, error: `Drop at most ${FILE_DROP_COUNT_MAX} files at once.` };
  }
  const paths = [...transfer.files]
    .map((file) => window.avb.getFilePath(file))
    .filter((path): path is string => path !== undefined && path !== '')
    .map(pathText);
  return paths.length === 0
    ? { ok: true, value: undefined }
    : { ok: true, value: { kind: 'os', paths } };
}

function parseAssetRel(input: string): string {
  const rel = pathText(input);
  if (rel.startsWith('/') || rel.split('/').some((segment) => !segment || segment === '..')) {
    throw new Error('Dropped asset has an invalid relative path.');
  }
  return rel;
}

function acceptsDrop(transfer: DataTransfer): boolean {
  return transfer.types.includes('avb/asset') || transfer.types.includes('Files');
}

function reportResult<Value>(result: Result<Value, string>, showToast: Toast): boolean {
  if (!result.ok) {
    showToast(result.error, 'error');
    return false;
  }
  return true;
}

function AssetPanelBody({
  props,
  state,
  actions,
}: {
  readonly props: AssetsPanelProps;
  readonly state: AssetPanelState;
  readonly actions: AssetActions;
}) {
  const folders = state.entries.filter((entry) => entry.isDir && entry.parent === state.cwd);
  const files = state.entries.filter(
    (entry): entry is AssetFile =>
      !entry.isDir &&
      entry.parent === state.cwd &&
      (!props.pick || kindMatches(props.pick.mediaKind, entry.name)),
  );
  return (
    <div className="panel-section grow">
      <AssetHeader cwd={state.cwd} actions={actions} state={state} />
      <PickBanner
        {...(props.pick === undefined ? {} : { pick: props.pick })}
        {...(props.onPickCancel === undefined ? {} : { onCancel: props.onPickCancel })}
      />
      <AssetBreadcrumbs state={state} actions={actions} />
      <AssetContents
        props={props}
        state={state}
        actions={actions}
        folders={folders}
        files={files}
      />
    </div>
  );
}

function AssetHeader({
  cwd,
  actions,
  state,
}: {
  readonly cwd: string;
  readonly actions: AssetActions;
  readonly state: AssetPanelState;
}) {
  return (
    <div className="panel-header">
      <h2>Assets</h2>
      <div style={{ display: 'flex', gap: 2 }}>
        <button
          className="ghost"
          title={cwd ? 'New folder' : 'Open public/ or src/ first'}
          disabled={!cwd}
          onClick={() => state.setNewFolder(true)}
        >
          <FolderPlusIcon size={14} />
        </button>
        <button
          className="ghost"
          title={cwd ? 'Upload assets' : 'Open public/ or src/ first'}
          disabled={!cwd}
          onClick={() => void actions.pickUpload(cwd)}
        >
          <UploadCloudIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function PickBanner({
  pick,
  onCancel,
}: {
  readonly pick?: AssetRequest | undefined;
  readonly onCancel?: () => void;
}) {
  if (!pick) {
    return undefined;
  }
  return (
    <div className="asset-picking">
      <span>{pickPrompt(pick.mediaKind)}</span>
      <button className="ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function AssetBreadcrumbs({
  state,
  actions,
}: {
  readonly state: AssetPanelState;
  readonly actions: AssetActions;
}) {
  const crumbs = useMemo(() => buildCrumbs(state.cwd), [state.cwd]);
  return (
    <div className="asset-crumbs">
      {crumbs.map((crumb, index) => (
        <React.Fragment key={crumb.rel}>
          {index > 0 && (
            <span className="crumb-sep">
              <ChevronRightIcon size={9} />
            </span>
          )}
          <span
            className={`crumb ${index === crumbs.length - 1 ? 'last' : ''} ${
              state.dragTarget === crumb.rel && state.cwd !== crumb.rel ? 'drop' : ''
            }`}
            onClick={() => state.setCwd(crumb.rel)}
            onDragOver={actions.dragOverInto(crumb.rel)}
            onDragLeave={() => state.setDragTarget(undefined)}
            onDrop={actions.dropInto(crumb.rel)}
          >
            {crumb.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function AssetContents({
  props,
  state,
  actions,
  folders,
  files,
}: {
  readonly props: AssetsPanelProps;
  readonly state: AssetPanelState;
  readonly actions: AssetActions;
  readonly folders: readonly AssetPanelEntry[];
  readonly files: readonly AssetFile[];
}) {
  return (
    <div
      className={`panel-body asset-body ${state.dragTarget === state.cwd ? 'drop' : ''}`}
      onDragOver={actions.dragOverInto(state.cwd)}
      onDragLeave={(event) => {
        if (event.target === event.currentTarget) {
          state.setDragTarget(undefined);
        }
      }}
      onDrop={actions.dropInto(state.cwd)}
    >
      {state.newFolder && <NewFolderRow state={state} actions={actions} />}
      {folders.map((folder) => (
        <AssetFolder key={folder.rel} folder={folder} state={state} actions={actions} />
      ))}
      <div className="asset-grid">
        {files.map((file) => (
          <AssetTile key={file.rel} file={file} props={props} state={state} actions={actions} />
        ))}
      </div>
      {folders.length === 0 && files.length === 0 && !state.newFolder && (
        <div className="props-empty">Empty folder. Drop files here or use the upload button.</div>
      )}
    </div>
  );
}

function NewFolderRow({
  state,
  actions,
}: {
  readonly state: AssetPanelState;
  readonly actions: AssetActions;
}) {
  return (
    <div className="asset-folder">
      <FolderIcon size={14} />
      <input
        autoFocus
        placeholder="Folder name"
        onBlur={(event) => {
          state.setNewFolder(false);
          const name = event.currentTarget.value.trim();
          if (name) {
            void actions.makeDirectory(name);
          }
        }}
        onKeyDown={blurRenameInput}
      />
    </div>
  );
}

function AssetFolder({
  folder,
  state,
  actions,
}: {
  readonly folder: AssetPanelEntry;
  readonly state: AssetPanelState;
  readonly actions: AssetActions;
}) {
  return (
    <div
      className={`asset-folder ${state.dragTarget === folder.rel ? 'drop' : ''}`}
      draggable={state.renaming !== folder.rel}
      onDragStart={(event) => startAssetDrag(event, folder.rel)}
      onDragOver={actions.dragOverInto(folder.rel)}
      onDragLeave={() => state.setDragTarget(undefined)}
      onDrop={actions.dropInto(folder.rel)}
      onClick={() => {
        if (state.renaming !== folder.rel) {
          state.setCwd(folder.rel);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        state.setRenaming(folder.rel);
      }}
    >
      <FolderIcon size={14} />
      {state.renaming === folder.rel ? (
        <RenameInput entry={folder} onCommit={actions.commitRename} />
      ) : (
        <span className="asset-folder-name">{folder.name}</span>
      )}
      <span className="crumb-sep">
        <ChevronRightIcon size={9} />
      </span>
    </div>
  );
}

function AssetTile({
  file,
  props,
  state,
  actions,
}: {
  readonly file: AssetFile;
  readonly props: AssetsPanelProps;
  readonly state: AssetPanelState;
  readonly actions: AssetActions;
}) {
  const editable = TEXT_EXT.test(file.name);
  return (
    <div
      className={`asset-tile ${props.pick ? 'pickable' : ''} ${
        props.pick?.current === file.rel ? 'selected' : ''
      }`}
      draggable={state.renaming !== file.rel}
      onDragStart={(event) => startAssetDrag(event, file.rel)}
      title={assetTitle(file, { editable, picking: Boolean(props.pick) })}
      onClick={props.pick ? () => props.pick?.onPick(file.rel, file) : undefined}
    >
      <AssetThumb
        file={file}
        className={editable && !props.pick ? 'editable' : ''}
        onClick={() => {
          if (!props.pick && editable) {
            props.onOpenFile?.({ rel: file.rel, name: file.name });
          }
        }}
      />
      {state.renaming === file.rel ? (
        <RenameInput entry={file} onCommit={actions.commitRename} />
      ) : (
        <div className="asset-name" onDoubleClick={() => state.setRenaming(file.rel)}>
          {file.name}
        </div>
      )}
      {!props.pick && (
        <MoreMenu
          className="asset-tile-menu"
          title={`Options for ${file.name}`}
          items={[
            {
              label: 'Delete',
              icon: <TrashIcon size={13} />,
              danger: true,
              onSelect: () => actions.remove(file),
            },
          ]}
        />
      )}
    </div>
  );
}

function MissingAssets({ onUpload }: { readonly onUpload: () => void }) {
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Assets</h2>
      </div>
      <div className="props-empty">
        This project has no <code>public/</code> folder yet.
        <div style={{ marginTop: 10 }}>
          <button className="primary" onClick={onUpload}>
            Upload an asset
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameInput({
  entry,
  onCommit,
}: {
  readonly entry: AssetPanelEntry;
  readonly onCommit: (entry: AssetPanelEntry, value: string) => void;
}) {
  const [value, setValue] = useState(entry.name);
  return (
    <input
      autoFocus
      value={value}
      spellCheck={false}
      onFocus={(event) => {
        const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.');
        event.currentTarget.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
      }}
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={() => onCommit(entry, value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setValue(entry.name);
          onCommit(entry, entry.name);
        }
      }}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

function kindMatches(kind: AssetRequest['mediaKind'], name: string): boolean {
  switch (kind) {
    case 'image':
      return IMAGE_EXT.test(name);
    case 'video':
      return VIDEO_EXT.test(name);
    case 'audio':
      return AUDIO_EXT.test(name);
    case 'asset':
      return true;
  }
}

function pickPrompt(kind: AssetRequest['mediaKind']): string {
  switch (kind) {
    case 'image':
      return 'Choose an image';
    case 'video':
      return 'Choose a video';
    case 'audio':
      return 'Choose an audio file';
    case 'asset':
      return 'Choose a file';
  }
}

function buildCrumbs(cwd: string): readonly { readonly rel: string; readonly label: string }[] {
  const crumbs = [{ rel: '', label: 'Assets' }];
  const parts = cwd ? cwd.split('/') : [];
  if (parts.length > BOUNDARY_LIMITS.depthMax) {
    throw new Error('Asset breadcrumbs: depth limit exceeded');
  }
  for (let index = 0; index < parts.length; index++) {
    const label = parts[index];
    if (label !== undefined) {
      crumbs.push({ rel: parts.slice(0, index + 1).join('/'), label });
    }
  }
  return crumbs;
}

function parentOf(rel: string): string {
  const index = rel.lastIndexOf('/');
  return index < 0 ? '' : rel.slice(0, index);
}

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

function isInPickHome(rel: string): boolean {
  return rel === PICK_HOME || rel.startsWith(`${PICK_HOME}/`);
}

function startAssetDrag(event: React.DragEvent<HTMLElement>, rel: string): void {
  event.dataTransfer.setData('avb/asset', rel);
  allowDragEffect(event.dataTransfer, 'move');
}

function blurRenameInput(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
  }
  if (event.key === 'Escape') {
    clearInput(event.currentTarget);
    event.currentTarget.blur();
  }
}

// An uncontrolled input's text is the element's own state, cleared in place.
function clearInput(inputElement: HTMLInputElement): void {
  inputElement.value = '';
}

function assetTitle(
  file: AssetFile,
  mode: { readonly editable: boolean; readonly picking: boolean },
): string {
  if (mode.picking) {
    return `Use /${file.rel}`;
  }
  return mode.editable ? `/${file.rel} — click to edit` : `/${file.rel}`;
}
