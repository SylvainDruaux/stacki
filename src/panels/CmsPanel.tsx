import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Collection } from '../cmsSchema';
import type { CmsPanelContent, CmsPanelContentCollection, CmsPanelFile } from '../cmsPanelBridge';
import { collectionOf, labelize } from '../cmsSchema';
import { createCmsCollection, readCmsFiles, readContentCollections } from '../cmsPanelBridge';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CmsIcon,
  CollectionIcon,
  FolderDefaultIcon,
  GearIcon,
  HideIcon,
  PlusIcon,
} from '../ui/Icons';

const CONTENT_KEY = '\u0000content';

interface CmsPanelProps {
  readonly project: { readonly path: string };
  readonly selectedRel: string | null;
  readonly selectedContent: string | null;
  readonly currentFile: string | null;
  readonly refreshKey: string | number;
  readonly onSelect: (rel: string | null) => void;
  readonly onSelectContent: (name: string | null) => void;
  readonly onOpenSettings: (rel: string) => void;
  readonly showToast: (message: string, kind: 'error') => void;
}

interface CollectionGroup {
  readonly key: string;
  readonly kind: 'file' | 'folder';
  readonly label: string;
  readonly path: string;
  readonly items: readonly Collection[];
  readonly current: boolean;
  readonly badge: 'this page' | 'open' | null;
}

interface CmsPanelData {
  readonly files: readonly CmsPanelFile[];
  readonly content: CmsPanelContent;
  readonly refresh: () => Promise<void>;
}

const EMPTY_CONTENT: CmsPanelContent = {
  collections: [],
  covered: { files: [], dirs: [] },
};

export default function CmsPanel(props: CmsPanelProps) {
  const { files, content, refresh } = useCmsPanelData(props.project.path, props.refreshKey);
  const [creating, setCreating] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const collections = useMemo(() => visibleCollections(files, content), [files, content]);
  const groups = useMemo(
    () => collectionGroups(collections, props.currentFile),
    [collections, props.currentFile],
  );
  useSelectedGroup(props.selectedRel, openKey, collections, setOpenKey);
  const open = openKey === null ? undefined : groups.find((group) => group.key === openKey);
  const create = useCreateCollection(props, refresh, setCreating, setOpenKey);
  return (
    <div className="panel-section grow">
      <PanelHeader
        open={open}
        openKey={openKey}
        onBack={() => closeGroup(props, setOpenKey)}
        onCreate={() => setCreating(true)}
      />
      <div className="panel-body">
        {creating && <CreateRow onCreate={create} />}
        {!open && openKey !== CONTENT_KEY && (
          <GroupList content={content} groups={groups} onOpen={setOpenKey} />
        )}
        {openKey === CONTENT_KEY && (
          <ContentCollectionList
            collections={content.collections}
            selected={props.selectedContent}
            onSelect={props.onSelectContent}
          />
        )}
        {open && (
          <JsonCollectionList
            collections={open.items}
            selected={props.selectedRel}
            onSelect={props.onSelect}
            onOpenSettings={props.onOpenSettings}
          />
        )}
        {collections.length === 0 && content.collections.length === 0 && !creating && (
          <EmptyPanel onCreate={() => setCreating(true)} />
        )}
      </div>
    </div>
  );
}

function useCmsPanelData(projectPath: string, refreshKey: string | number): CmsPanelData {
  const [files, setFiles] = useState<readonly CmsPanelFile[]>([]);
  const [content, setContent] = useState<CmsPanelContent>(EMPTY_CONTENT);
  const requestId = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const ownRequestId = ++requestId.current;
    const [fileResult, contentResult] = await Promise.all([
      readCmsFiles(projectPath),
      readContentCollections(projectPath),
    ]);
    if (ownRequestId !== requestId.current) {
      return;
    }
    setFiles(fileResult.ok ? fileResult.value : []);
    setContent(contentResult.ok ? contentResult.value : EMPTY_CONTENT);
  }, [projectPath]);
  useEffect(() => {
    void refresh();
    const dispose = window.avb.onCmsChanged(() => void refresh());
    return () => {
      requestId.current += 1;
      dispose();
    };
  }, [refresh, refreshKey]);
  return { files, content, refresh };
}

function useCreateCollection(
  props: CmsPanelProps,
  refresh: () => Promise<void>,
  setCreating: React.Dispatch<React.SetStateAction<boolean>>,
  setOpenKey: React.Dispatch<React.SetStateAction<string | null>>,
): (name: string) => Promise<void> {
  return useCallback(
    async (name: string): Promise<void> => {
      setCreating(false);
      if (name.trim().length === 0) {
        return;
      }
      const result = await createCmsCollection(props.project.path, name);
      if (!result.ok) {
        props.showToast(result.error, 'error');
        return;
      }
      await refresh();
      setOpenKey(groupIdentity(result.value.rel, directoryOf(result.value.rel)).key);
      props.onSelect(result.value.rel);
    },
    [props, refresh, setCreating, setOpenKey],
  );
}

function useSelectedGroup(
  selectedRel: string | null,
  openKey: string | null,
  collections: readonly Collection[],
  setOpenKey: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  useEffect(() => {
    if (selectedRel === null || openKey !== null) {
      return;
    }
    const selected = collections.find((collection) => collection.rel === selectedRel);
    if (selected) {
      setOpenKey(groupIdentity(selected.rel, selected.dir).key);
    }
  }, [collections, openKey, selectedRel, setOpenKey]);
}

function visibleCollections(
  files: readonly CmsPanelFile[],
  content: CmsPanelContent,
): readonly Collection[] {
  return files
    .filter((file) => !ownedByContent(file.rel.split('#')[0] ?? '', content.covered))
    .map(collectionOf);
}

function ownedByContent(rel: string, covered: CmsPanelContent['covered']): boolean {
  if (covered.files.includes(`src/${rel}`)) {
    return true;
  }
  return covered.dirs.some((directory) => `src/${rel}`.startsWith(`${directory}/`));
}

function collectionGroups(
  collections: readonly Collection[],
  currentFile: string | null,
): readonly CollectionGroup[] {
  const mutableGroups = new Map<
    string,
    { readonly identity: GroupIdentity; items: Collection[] }
  >();
  for (const collection of collections) {
    const identity = groupIdentity(collection.rel, collection.dir);
    if (identity.key.toLowerCase().endsWith('.astro') && identity.key !== currentFile) {
      continue;
    }
    const existing = mutableGroups.get(identity.key);
    if (existing) {
      existing.items.push(collection);
    } else {
      mutableGroups.set(identity.key, { identity, items: [collection] });
    }
  }
  return Array.from(mutableGroups.values(), ({ identity, items }) => {
    const current = currentFile !== null && identity.key === currentFile;
    const badge: CollectionGroup['badge'] = current
      ? identity.key.startsWith('pages/')
        ? 'this page'
        : 'open'
      : null;
    return {
      ...identity,
      items,
      current,
      badge,
    };
  }).sort((left, right) => Number(right.current) - Number(left.current));
}

interface GroupIdentity {
  readonly key: string;
  readonly kind: 'file' | 'folder';
  readonly label: string;
  readonly path: string;
}

function groupIdentity(rel: string, dir: string): GroupIdentity {
  if (rel.includes('#')) {
    const base = dir.split('/').at(-1) ?? dir;
    return {
      key: dir,
      kind: 'file',
      label: base.charAt(0).toUpperCase() + base.slice(1),
      path: `src/${dir}`,
    };
  }
  return {
    key: dir,
    kind: 'folder',
    label: dir ? (dir.split('/').at(-1) ?? dir) : 'src',
    path: dir ? `src/${dir}` : 'src',
  };
}

function directoryOf(rel: string): string {
  return rel.split('/').slice(0, -1).join('/');
}

function closeGroup(
  props: Pick<CmsPanelProps, 'onSelect' | 'onSelectContent'>,
  setOpenKey: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  setOpenKey(null);
  props.onSelect(null);
  props.onSelectContent(null);
}

function PanelHeader({
  open,
  openKey,
  onBack,
  onCreate,
}: {
  readonly open: CollectionGroup | undefined;
  readonly openKey: string | null;
  readonly onBack: () => void;
  readonly onCreate: () => void;
}) {
  const title =
    openKey === CONTENT_KEY ? 'Content collections' : (open?.label ?? 'CMS Collections');
  return (
    <div className="panel-header">
      <div className="cms-crumb">
        {(open || openKey === CONTENT_KEY) && (
          <button className="ghost" title="All collections" onClick={onBack}>
            <ChevronLeftIcon size={14} />
          </button>
        )}
        <h2 title={open?.path}>{title}</h2>
      </div>
      <button className="ghost" title="New collection" onClick={onCreate}>
        <PlusIcon size={14} />
      </button>
    </div>
  );
}

function CreateRow({ onCreate }: { readonly onCreate: (name: string) => Promise<void> }) {
  return (
    <div className="cms-collection">
      <CmsIcon size={14} />
      <input
        autoFocus
        placeholder="Collection name"
        onBlur={(event) => void onCreate(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.currentTarget.value = '';
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function GroupList({
  content,
  groups,
  onOpen,
}: {
  readonly content: CmsPanelContent;
  readonly groups: readonly CollectionGroup[];
  readonly onOpen: (key: string) => void;
}) {
  return (
    <>
      {content.collections.length > 0 && (
        <GroupRow
          label="Content collections"
          count={collectionCount(content.collections.length)}
          title={content.configPath ? `Declared in ${content.configPath}` : undefined}
          onClick={() => onOpen(CONTENT_KEY)}
          icon={<CollectionIcon size={14} />}
        />
      )}
      {groups.map((group) => (
        <GroupRow
          key={group.key}
          label={group.label}
          count={collectionCount(group.items.length)}
          title={group.path}
          badge={group.badge}
          onClick={() => onOpen(group.key)}
          icon={<FolderDefaultIcon size={14} />}
        />
      ))}
    </>
  );
}

function GroupRow({
  label,
  count: countLabel,
  title,
  badge,
  onClick,
  icon,
}: {
  readonly label: string;
  readonly count: string;
  readonly title?: string | undefined;
  readonly badge?: CollectionGroup['badge'];
  readonly onClick: () => void;
  readonly icon: React.ReactNode;
}) {
  return (
    <div className="cms-collection" onClick={onClick} title={title}>
      {icon}
      <span className="cms-collection-name">{label}</span>
      {badge && <span className="badge">{badge}</span>}
      <span className="cms-collection-count">{countLabel}</span>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  );
}

function ContentCollectionList({
  collections,
  selected,
  onSelect,
}: {
  readonly collections: readonly CmsPanelContentCollection[];
  readonly selected: string | null;
  readonly onSelect: (name: string | null) => void;
}) {
  return collections.map((collection) => (
    <div
      key={collection.name}
      className={collectionClass(collection.name === selected, collection.error !== undefined)}
      onClick={() => onSelect(collection.name)}
      title={contentCollectionTitle(collection)}
    >
      {collection.editable ? <CmsIcon size={14} /> : <HideIcon size={14} />}
      <span className="cms-collection-name">{labelize(collection.name)}</span>
      <span className="cms-collection-count">{contentEntryCount(collection)}</span>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  ));
}

function JsonCollectionList({
  collections,
  selected,
  onSelect,
  onOpenSettings,
}: {
  readonly collections: readonly Collection[];
  readonly selected: string | null;
  readonly onSelect: (rel: string | null) => void;
  readonly onOpenSettings: (rel: string) => void;
}) {
  return collections.map((collection) => (
    <div
      key={collection.rel}
      className={collectionClass(collection.rel === selected, collection.error !== null)}
      onClick={() => onSelect(collection.rel)}
      title={
        collection.error ? `src/${collection.rel} — ${collection.error}` : `src/${collection.rel}`
      }
    >
      <CmsIcon size={14} />
      <span className="cms-collection-name">{collection.label}</span>
      <span className="cms-collection-count">{jsonItemCount(collection)}</span>
      <button
        className="ghost row-action"
        title="Collection settings"
        onClick={(event) => {
          event.stopPropagation();
          if (collection.error === null) {
            onOpenSettings(collection.rel);
          }
        }}
        disabled={collection.error !== null}
      >
        <GearIcon size={13} />
      </button>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  ));
}

function EmptyPanel({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <div className="props-empty">
      No content found in <code>src/</code>.
      <div style={{ marginTop: 10 }}>
        <button className="primary" onClick={onCreate}>
          New collection
        </button>
      </div>
    </div>
  );
}

function collectionClass(selected: boolean, broken: boolean): string {
  return `cms-collection ${selected ? 'on' : ''} ${broken ? 'broken' : ''}`;
}

function collectionCount(countValue: number): string {
  return countValue === 1 ? '1 collection' : `${countValue} collections`;
}

function contentEntryCount(collection: CmsPanelContentCollection): string {
  if (collection.error !== undefined) {
    return 'unreadable';
  }
  return collection.count === 1 ? '1 entry' : `${collection.count} entries`;
}

function jsonItemCount(collection: Collection): string {
  if (collection.error !== null) {
    return 'unreadable';
  }
  return collection.single || collection.items.length === 1
    ? '1 item'
    : `${collection.items.length} items`;
}

function contentCollectionTitle(collection: CmsPanelContentCollection): string {
  if (!collection.editable) {
    return 'Built by a loader in this project: read-only';
  }
  const source =
    collection.loader?.kind === 'file' ? collection.loader.file : collection.loader?.base;
  return `${source ?? 'Unknown source'} — ${collection.loader?.kind ?? 'unknown'} loader`;
}
