import React from 'react';
import type { WireWorktreeInfo } from '../../../shared/ipc-results';
import type { HistoryFile } from './historyBridge';
import BranchActions from '../git/BranchActions';
import FileBrowser from '../git/FileBrowser';
import { BranchIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon } from '../../ui/Icons';
import type { HistoryGitInfo } from './historyPanelTypes';

export function HistorySection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  readonly title: string;
  readonly count?: number | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={`history-section ${open ? 'open' : ''}`}>
      <button className="history-section-head" onClick={onToggle}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="history-section-title">{title}</span>
        {count !== undefined && <span className="history-section-count">{count}</span>}
      </button>
      {open && children}
    </div>
  );
}

export function HistoryFiles({
  files,
  open,
  toggle,
  onOpen,
}: {
  readonly files: readonly HistoryFile[];
  readonly open: boolean;
  readonly toggle: () => void;
  readonly onOpen: (file: HistoryFile) => void;
}) {
  const changed = files.filter((file) => file.status).length;
  return (
    <HistorySection title="Files" count={changed || undefined} open={open} onToggle={toggle}>
      <FileBrowser files={files} onOpen={onOpen} emptyMessage="Nothing here yet." />
    </HistorySection>
  );
}

export function HistoryBranches({
  gitInfo,
  open,
  toggle,
  onSwitch,
  onMerge,
  onDelete,
}: {
  readonly gitInfo: HistoryGitInfo | undefined;
  readonly open: boolean;
  readonly toggle: () => void;
  readonly onSwitch: (branch: string) => void;
  readonly onMerge: (branch: string) => void;
  readonly onDelete: (branch: string) => void;
}) {
  const repository = gitInfo?.isRepo ? gitInfo : undefined;
  return (
    <HistorySection
      title="Branches"
      count={repository?.branches.length}
      open={open}
      onToggle={toggle}
    >
      {repository?.branches.map((branch) => (
        <div
          key={branch}
          className={`list-item ${branch === repository.branch ? 'active' : ''}`}
          onClick={() => {
            if (branch !== repository.branch) {
              onSwitch(branch);
            }
          }}
        >
          <span className="icon" style={{ width: 14 }}>
            {branch === repository.branch ? <CheckIcon size={12} /> : <BranchIcon size={12} />}
          </span>
          <span className="label">{branch}</span>
          {repository.parked.includes(branch) && branch !== repository.branch && (
            <span className="branch-parked" title="Changes waiting on this branch">
              changes waiting
            </span>
          )}
          <BranchActions
            branch={branch}
            current={repository.branch}
            {...(repository.trunk === undefined ? {} : { trunk: repository.trunk })}
            onMerge={onMerge}
            onDelete={onDelete}
          />
        </div>
      ))}
    </HistorySection>
  );
}

export function HistoryWorktrees({
  worktrees,
  open,
  toggle,
}: {
  readonly worktrees: readonly WireWorktreeInfo[];
  readonly open: boolean;
  readonly toggle: () => void;
}) {
  return (
    <HistorySection
      title="Worktrees"
      count={worktrees.length > 1 ? worktrees.length : undefined}
      open={open}
      onToggle={toggle}
    >
      <p className="history-note">
        {worktrees.length > 1
          ? 'The same project, open in more than one folder — each on its own branch.'
          : 'This project is open in one folder only. Worktrees let the same project sit in ' +
            'several folders at once, each on a different branch.'}
      </p>
      {worktrees.length > 1 &&
        worktrees.map((worktree) => (
          <div className="list-item" key={worktree.path} title={worktree.path}>
            <span className="icon" style={{ width: 14 }}>
              <BranchIcon size={12} />
            </span>
            <span className="label">{worktree.branch ?? 'a single version'}</span>
            <span className="sub">{worktree.path.split(/[\\/]/).at(-1) ?? worktree.path}</span>
          </div>
        ))}
    </HistorySection>
  );
}
