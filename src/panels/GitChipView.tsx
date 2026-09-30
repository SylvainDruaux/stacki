import React from 'react';
import type { WireGitInfo } from '../../shared/ipc-results';
import { branchNameError, sanitizeBranchName } from '../branchName.js';
import BranchActions from '../ui/BranchActions.jsx';
import FileBrowser from '../ui/FileBrowser.jsx';
import { BranchIcon, CheckIcon, CloseIcon, ExternalIcon } from '../ui/Icons.jsx';
import { repoSlug, webUrl } from './gitPublish';

type ChangedFiles = React.ComponentProps<typeof FileBrowser>['files'];

interface GitChipViewProps {
  readonly info: WireGitInfo;
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly open: boolean;
  readonly commitMessage: string;
  readonly newBranch: string;
  readonly picking: boolean;
  readonly picked: readonly string[] | undefined;
  readonly changed: ChangedFiles;
  readonly wrapRef: React.RefObject<HTMLDivElement>;
  readonly onToggle: () => void;
  readonly onDismissError: () => void;
  readonly onSwitch: (branch: string) => void;
  readonly onMerge: (branch: string) => void;
  readonly onDelete: (branch: string) => void;
  readonly onNewBranch: (value: string) => void;
  readonly onCreateBranch: (branch: string) => void;
  readonly onCommitMessage: (value: string) => void;
  readonly onTogglePicking: () => void;
  readonly onPick: (paths: readonly string[]) => void;
  readonly onCommit: () => void;
  readonly onOpenRemote: (remote: string) => void;
  readonly onPush: () => void;
  readonly onPublish: () => void;
}

interface BranchesProps {
  readonly info: WireGitInfo;
  readonly working: boolean;
  readonly newBranch: string;
  readonly onSwitch: (branch: string) => void;
  readonly onMerge: (branch: string) => void;
  readonly onDelete: (branch: string) => void;
  readonly onNewBranch: (value: string) => void;
  readonly onCreateBranch: (branch: string) => void;
}

interface CommitProps {
  readonly dirty: boolean;
  readonly working: boolean;
  readonly message: string;
  readonly picking: boolean;
  readonly picked: readonly string[] | undefined;
  readonly changed: ChangedFiles;
  readonly onMessage: (value: string) => void;
  readonly onTogglePicking: () => void;
  readonly onPick: (paths: readonly string[]) => void;
  readonly onCommit: () => void;
}

function ChipButton({
  info,
  busy,
  onToggle,
}: Pick<GitChipViewProps, 'info' | 'busy' | 'onToggle'>) {
  const working = busy !== undefined;
  return (
    <button className={`git-chip ${working ? 'busy' : ''}`} onClick={onToggle}>
      {working ? (
        <>
          <span className="mini-spinner" />
          {busy}
        </>
      ) : (
        <>
          <BranchIcon size={12} />
          <span className={`dot ${info.dirty ? 'dirty' : ''}`} />
          {info.branch}
          {info.ahead > 0 && <span style={{ color: 'var(--text-faint)' }}>↑{info.ahead}</span>}
        </>
      )}
    </button>
  );
}

function Branches({
  info,
  working,
  newBranch,
  onSwitch,
  onMerge,
  onDelete,
  onNewBranch,
  onCreateBranch,
}: BranchesProps) {
  const branchError = branchNameError(newBranch, info.branches);
  return (
    <>
      <h3>Branches</h3>
      {info.branches.map((branch) => (
        <div
          key={branch}
          className={`list-item ${branch === info.branch ? 'active' : ''}`}
          onClick={() => onSwitch(branch)}
        >
          <span className="icon" style={{ width: 14 }}>
            {branch === info.branch && <CheckIcon size={12} />}
          </span>
          <span className="label">{branch}</span>
          {info.parked.includes(branch) && branch !== info.branch && (
            <span className="branch-parked" title="Changes waiting on this branch">
              changes waiting
            </span>
          )}
          <BranchActions
            branch={branch}
            current={info.branch}
            {...(info.trunk === undefined ? {} : { trunk: info.trunk })}
            disabled={working}
            onMerge={onMerge}
            onDelete={onDelete}
          />
        </div>
      ))}
      <div className="dropdown-row">
        <input
          placeholder="new-branch-name"
          value={newBranch}
          aria-invalid={Boolean(branchError)}
          onChange={(event) => onNewBranch(sanitizeBranchName(event.target.value))}
          onKeyDown={(event) => {
            const name = newBranch.trim();
            if (event.key === 'Enter' && name && !branchError) {
              onCreateBranch(name);
            }
          }}
        />
      </div>
      {branchError && <div className="git-hint">{branchError}</div>}
    </>
  );
}

function CommitControls({
  dirty,
  working,
  message,
  picking,
  picked,
  changed,
  onMessage,
  onTogglePicking,
  onPick,
  onCommit,
}: CommitProps) {
  const pickedCount = picked?.length ?? 0;
  const label = !dirty
    ? 'Nothing to commit'
    : !picking
      ? 'Commit all changes'
      : `Commit ${pickedCount} file${pickedCount === 1 ? '' : 's'}`;
  return (
    <>
      <div className="divider" />
      <h3>Commit</h3>
      <div className="dropdown-row" style={{ flexDirection: 'column', gap: 6 }}>
        <input
          placeholder="Commit message"
          value={message}
          onChange={(event) => onMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && dirty && !working) {
              onCommit();
            }
          }}
        />
        {dirty && (
          <button className="git-pick-toggle" onClick={onTogglePicking}>
            {picking ? 'Commit everything instead' : 'Choose what to commit…'}
          </button>
        )}
        {picking && dirty && (
          <div className="git-pick">
            <FileBrowser
              files={changed}
              selectable
              selected={picked ?? []}
              onSelect={onPick}
              emptyMessage="Nothing has changed."
              autoFocusSearch
            />
          </div>
        )}
        <button
          className="primary"
          disabled={working || !dirty || (picking && pickedCount === 0)}
          onClick={onCommit}
        >
          {label}
        </button>
      </div>
    </>
  );
}

function GitHubControls({
  info,
  working,
  onOpenRemote,
  onPush,
  onPublish,
}: Pick<GitChipViewProps, 'info' | 'onOpenRemote' | 'onPush' | 'onPublish'> & {
  readonly working: boolean;
}) {
  const canPush = info.hasUpstream ? info.ahead > 0 : true;
  const pushLabel = !info.hasUpstream
    ? `Push ${info.branch} to origin`
    : info.ahead > 0
      ? `Push ${info.ahead} commit${info.ahead === 1 ? '' : 's'}`
      : 'Everything pushed';
  return (
    <>
      <div className="divider" />
      <h3>GitHub</h3>
      <div className="dropdown-row" style={{ flexDirection: 'column', gap: 6 }}>
        {info.remote ? (
          <>
            <button
              className="repo-link"
              title={`Open ${repoSlug(info.remote)} on GitHub`}
              onClick={() => onOpenRemote(info.remote ?? '')}
            >
              <span className="repo-slug">{repoSlug(info.remote)}</span>
              <ExternalIcon size={11} />
            </button>
            <button className="primary" disabled={working || !canPush} onClick={onPush}>
              {pushLabel}
            </button>
            {info.dirty && (
              <div className="hint-text">
                You have uncommitted changes — commit them first to include them.
              </div>
            )}
          </>
        ) : (
          <>
            <div className="hint-text">This project isn’t on GitHub yet.</div>
            <button className="primary" disabled={working} onClick={onPublish}>
              Publish to GitHub…
            </button>
          </>
        )}
      </div>
    </>
  );
}

function Dropdown(props: GitChipViewProps) {
  const working = props.busy !== undefined;
  return (
    <div className="dropdown">
      {props.error && (
        <div className="git-error">
          {props.error}
          <button className="ghost" title="Dismiss" onClick={props.onDismissError}>
            <CloseIcon size={11} />
          </button>
        </div>
      )}
      <Branches
        info={props.info}
        working={working}
        newBranch={props.newBranch}
        onSwitch={props.onSwitch}
        onMerge={props.onMerge}
        onDelete={props.onDelete}
        onNewBranch={props.onNewBranch}
        onCreateBranch={props.onCreateBranch}
      />
      <CommitControls
        dirty={props.info.dirty}
        working={working}
        message={props.commitMessage}
        picking={props.picking}
        picked={props.picked}
        changed={props.changed}
        onMessage={props.onCommitMessage}
        onTogglePicking={props.onTogglePicking}
        onPick={props.onPick}
        onCommit={props.onCommit}
      />
      <GitHubControls
        info={props.info}
        working={working}
        onOpenRemote={props.onOpenRemote}
        onPush={props.onPush}
        onPublish={props.onPublish}
      />
    </div>
  );
}

export default function GitChipView(props: GitChipViewProps) {
  return (
    <div ref={props.wrapRef} style={{ position: 'relative' }}>
      <ChipButton info={props.info} busy={props.busy} onToggle={props.onToggle} />
      {props.open && <Dropdown {...props} />}
    </div>
  );
}

export function openGitRemote(remote: string): void {
  const url = webUrl(remote);
  if (url) {
    void window.avb.openExternal(url);
  } else {
    throw new Error('Git remote: expected a GitHub URL');
  }
}
