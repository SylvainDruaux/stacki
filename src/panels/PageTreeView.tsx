import React from 'react';
import type { ScanPage } from '../../shared/scan';
import type { PageTreeNode, PageTreePage } from '../pageTree';
import { comparePageNames, isCollectionRoute, leadsFolders } from '../pageOrder';
import { countTreePages, pageDirectory, pageExtension, stripPageExtension } from '../pageTree';
import {
  CloseIcon,
  CollectionIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  TrashIcon,
} from '../ui/Icons';
import { RenameInput } from './PageDialogs';
import { allowDragEffect } from '../dragState';

export type PageEditing =
  | { readonly kind: 'page'; readonly key: string }
  | { readonly kind: 'folder'; readonly key: string }
  | { readonly kind: 'none' };

export interface PageTreeActions {
  readonly select: (page: ScanPage) => void;
  readonly removePage: (page: ScanPage) => void;
  readonly movePage: (page: ScanPage, to: string) => void;
  readonly removeFolder: (rel: string, pageCount: number) => void;
  readonly renameFolder: (from: string, to: string) => void;
  readonly setEditing: React.Dispatch<React.SetStateAction<PageEditing>>;
  readonly toggleFolder: (rel: string) => void;
  readonly dragOver: (event: React.DragEvent<HTMLDivElement>, rel: string) => void;
  readonly drop: (event: React.DragEvent<HTMLDivElement>, rel: string) => void;
}

interface PageTreeViewProps {
  readonly node: PageTreeNode;
  readonly rel: string;
  readonly depth: number;
  readonly currentPage: ScanPage | undefined;
  readonly collapsed: ReadonlySet<string>;
  readonly editing: PageEditing;
  readonly dropDirectory: string | undefined;
  readonly actions: PageTreeActions;
}

export function PageTreeView(props: PageTreeViewProps) {
  const pages = [...props.node.pages].sort((left, right) =>
    comparePageNames(left.base, right.base),
  );
  const lead = pages.filter((page) => leadsFolders(page.base));
  const rest = pages.filter((page) => !leadsFolders(page.base));
  const directories = [...props.node.directories.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    <>
      {lead.map((page) => (
        <PageRow key={page.path} page={page} props={props} />
      ))}
      {directories.map(([name, child]) => {
        const rel = props.rel ? `${props.rel}/${name}` : name;
        return <FolderRows key={rel} name={name} node={child} rel={rel} props={props} />;
      })}
      {rest.map((page) => (
        <PageRow key={page.path} page={page} props={props} />
      ))}
    </>
  );
}

function PageRow({
  page,
  props,
}: {
  readonly page: PageTreePage;
  readonly props: PageTreeViewProps;
}) {
  const editing = props.editing.kind === 'page' && props.editing.key === page.path;
  const collection = isCollectionRoute(page.name);
  return (
    <div
      className={`list-item ${collection ? 'collection' : ''} ${
        props.currentPage?.path === page.path ? 'active' : ''
      }`}
      style={{ paddingLeft: 8 + props.depth * 14 }}
      title={page.route}
      draggable={!editing}
      onDragStart={(event) => startPageDrag(event, page)}
      onClick={() => {
        if (!editing) {
          props.actions.select(page);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        props.actions.setEditing({ kind: 'page', key: page.path });
      }}
    >
      <span className="icon">
        {collection ? <CollectionIcon size={13} /> : <FileIcon size={13} />}
      </span>
      {editing ? (
        <RenameInput
          initial={stripPageExtension(page.base)}
          onCommit={(text) => commitPageRename(page, text, props.actions)}
        />
      ) : (
        <span className="label">{stripPageExtension(page.base)}</span>
      )}
      <button
        className="row-action"
        title="Delete page"
        onClick={(event) => {
          event.stopPropagation();
          props.actions.removePage(page);
        }}
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}

function FolderRows({
  name,
  node,
  rel,
  props,
}: {
  readonly name: string;
  readonly node: PageTreeNode;
  readonly rel: string;
  readonly props: PageTreeViewProps;
}) {
  const collapsed = props.collapsed.has(rel);
  const editing = props.editing.kind === 'folder' && props.editing.key === rel;
  const count = countTreePages(node);
  return (
    <React.Fragment>
      <FolderRow
        name={name}
        rel={rel}
        count={count}
        collapsed={collapsed}
        editing={editing}
        props={props}
      />
      {!collapsed && <PageTreeView {...props} node={node} rel={rel} depth={props.depth + 1} />}
    </React.Fragment>
  );
}

function FolderRow({
  name,
  rel,
  count,
  collapsed,
  editing,
  props,
}: {
  readonly name: string;
  readonly rel: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly editing: boolean;
  readonly props: PageTreeViewProps;
}) {
  return (
    <div
      className={`list-item folder ${props.dropDirectory === rel ? 'drop' : ''}`}
      style={{ paddingLeft: 8 + props.depth * 14 }}
      onClick={() => {
        if (!editing) {
          props.actions.toggleFolder(rel);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        props.actions.setEditing({ kind: 'folder', key: rel });
      }}
      onDragOver={(event) => props.actions.dragOver(event, rel)}
      onDrop={(event) => props.actions.drop(event, rel)}
    >
      <span className="icon">
        {collapsed ? <FolderIcon size={13} /> : <FolderOpenIcon size={13} />}
      </span>
      {editing ? (
        <RenameInput
          initial={name}
          onCommit={(text) => commitFolderRename(rel, text, props.actions)}
        />
      ) : (
        <span className="label">{name}</span>
      )}
      {collapsed && count > 0 && (
        <span className="sub folder-count">
          {count} page{count === 1 ? '' : 's'}
        </span>
      )}
      <button
        className="row-action"
        title="Delete folder"
        onClick={(event) => {
          event.stopPropagation();
          props.actions.removeFolder(rel, count);
        }}
      >
        <TrashIcon size={12} />
      </button>
    </div>
  );
}

function startPageDrag(event: React.DragEvent<HTMLDivElement>, page: PageTreePage): void {
  event.dataTransfer.setData('avb/page', JSON.stringify({ path: page.path, name: page.name }));
  allowDragEffect(event.dataTransfer, 'move');
}

function commitPageRename(page: PageTreePage, text: string, actions: PageTreeActions): void {
  actions.setEditing({ kind: 'none' });
  const base = text
    .trim()
    .replace(/\.(astro|md)$/i, '')
    .replace(/[^\w-]+/g, '-');
  if (!base || base === stripPageExtension(page.base)) {
    return;
  }
  const directory = pageDirectory(page.name);
  actions.movePage(page, `${directory ? `${directory}/` : ''}${base}${pageExtension(page.base)}`);
}

function commitFolderRename(rel: string, text: string, actions: PageTreeActions): void {
  actions.setEditing({ kind: 'none' });
  const name = text.trim().replace(/[^\w-]+/g, '-');
  const parts = rel.split('/');
  if (!name || name === parts.at(-1)) {
    return;
  }
  actions.renameFolder(rel, [...parts.slice(0, -1), name].join('/'));
}
