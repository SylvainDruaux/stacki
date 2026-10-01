import React, { useEffect, useState } from 'react';
import type { Result } from '../../../shared/core/result';
import type {
  VariableFile,
  VariableGroup,
  VariableSelection,
  VariablesSnapshot,
} from './variablesBridge';
import { readCSSVariables } from './variablesBridge';
import { ChevronLeftIcon, ChevronRightIcon, VariableIcon, FileIcon } from '../../ui/Icons';

export interface VariablesPanelProps {
  readonly project: { readonly path: string };
  readonly selected?: VariableSelection | undefined;
  readonly onSelect: (selection: VariableSelection | undefined) => void;
}

const EMPTY_FILES: readonly VariableFile[] = [];

// Files preserve the author's stylesheet boundaries; groups preserve the rules inside them.
export default function VariablesPanel(props: VariablesPanelProps) {
  const { selected, onSelect, project } = props;
  const result = useVariableFiles(project.path);
  const files = result.ok ? result.value.files : EMPTY_FILES;
  const error = result.ok ? undefined : result.error;
  const [openFile, setOpenFile] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!selected || openFile) {
      return;
    }
    const file = files.find((entry) => entry.rel === selected.file);
    if (!file || onlyGroup(file)) {
      return;
    }
    setOpenFile(selected.file);
  }, [selected, openFile, files]);
  const open = openFile ? files.find((file) => file.rel === openFile) : undefined;
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <div className="cms-crumb">
          {open && (
            <button
              className="ghost"
              title="All stylesheets"
              onClick={() => {
                setOpenFile(undefined);
                onSelect(undefined);
              }}
            >
              <ChevronLeftIcon size={14} />
            </button>
          )}
          <h2 title={open ? open.rel : undefined}>{open ? open.name : 'Variables'}</h2>
        </div>
      </div>
      <div className="panel-body">
        {!open &&
          files.map((file) => (
            <VariableFileRow
              key={file.rel}
              file={file}
              selected={selected}
              onOpen={setOpenFile}
              onSelect={onSelect}
            />
          ))}
        {open &&
          open.groups.map((group, index) => (
            <VariableGroupRow
              key={`${group.label}-${index}`}
              group={group}
              file={open.rel}
              index={index}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        {error && <div className="cms-error">{error}</div>}
        {!files.length && !error && (
          <div className="props-empty">
            No CSS custom properties found in this project&rsquo;s stylesheets.
          </div>
        )}
      </div>
    </div>
  );
}

function useVariableFiles(projectPath: string) {
  const [result, setResult] = useState<Result<VariablesSnapshot, string>>({
    ok: true,
    value: { files: [], values: {} },
  });
  useEffect(() => {
    // One request plus one pending refresh bounds watcher bursts. Each callback
    // finishes before a queued read starts; obsolete project responses are ignored.
    let live = true;
    let running = false;
    let pending = false;
    // It calls itself again only from the read's callback, never on the stack.
    // eslint-disable-next-line stacki/bounded-recursion -- Event re-entry from a promise callback.
    const refresh = () => {
      if (!live) {
        return;
      }
      if (running) {
        pending = true;
        return;
      }
      running = true;
      void readCSSVariables(projectPath).then((next) => {
        running = false;
        if (!live) {
          return;
        }
        setResult(next);
        if (pending) {
          pending = false;
          refresh();
        }
      });
    };
    refresh();
    const unsubscribe = window.avb.onCssChanged(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [projectPath]);
  return result;
}

interface FileRowProps {
  readonly file: VariableFile;
  readonly selected: VariableSelection | undefined;
  readonly onOpen: (file: string) => void;
  readonly onSelect: VariablesPanelProps['onSelect'];
}
function VariableFileRow({ file, selected, onOpen, onSelect }: FileRowProps) {
  return (
    <div
      className={`cms-collection ${file.error ? 'broken' : ''} ${
        onlyGroup(file) && selected?.file === file.rel ? 'on' : ''
      }`}
      title={file.rel}
      onClick={() => {
        if (!file.groups.length) {
          return;
        }
        if (!onlyGroup(file)) {
          onOpen(file.rel);
        }
        onSelect({ file: file.rel, index: 0 });
      }}
    >
      <FileIcon size={14} />
      <span className="cms-collection-name">{file.name}</span>
      <span className="cms-collection-count">
        {file.error ? 'unreadable' : file.count === 1 ? '1 variable' : `${file.count} variables`}
      </span>
      {!onlyGroup(file) && (
        <span className="cms-collection-chevron">
          <ChevronRightIcon size={10} />
        </span>
      )}
    </div>
  );
}
interface GroupRowProps {
  readonly group: VariableGroup;
  readonly file: string;
  readonly index: number;
  readonly selected: VariableSelection | undefined;
  readonly onSelect: VariablesPanelProps['onSelect'];
}
function VariableGroupRow({ group, file, index, selected, onSelect }: GroupRowProps) {
  return (
    <div
      className={`cms-collection ${
        selected && selected.file === file && selected.index === index ? 'on' : ''
      }`}
      title={group.columns.map((column) => column.selector).join(',\n')}
      onClick={() => onSelect({ file, index })}
    >
      <VariableIcon size={14} />
      <span className="cms-collection-name">{group.label}</span>
      <span className="cms-collection-count">
        {group.kind === 'modes'
          ? `${group.columns.length} modes`
          : countOf(group) === 1
            ? '1 variable'
            : `${countOf(group)} variables`}
      </span>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  );
}
function onlyGroup(file: VariableFile): boolean {
  return file.groups.length === 1;
}
function countOf(group: VariableGroup): number {
  return group.blocks.reduce(
    (sum, block) =>
      sum + block.rows.reduce((count, row) => count + row.cells.filter(Boolean).length, 0),
    0,
  );
}
