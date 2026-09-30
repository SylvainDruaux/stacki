import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcResults, WireGitInfo } from '../../shared/ipc-results';
import type { Result } from '../../shared/result';
import { assert } from '../../shared/assert';
import { cleanError } from '../cleanError.js';
import { deleteBranchAction, mergeBranchAction, tidyUp } from '../gitActions.js';
import {
  checkoutGitBranch,
  commitGitChanges,
  initializeGit,
  pushGitBranch,
  readGitInfo,
  readGitStatus,
  resolveGitMerge,
} from '../gitChipBridge';
import { BranchIcon } from '../ui/Icons.jsx';
import useDismiss from '../ui/useDismiss.js';
import type { Conflict, ConflictChoices } from './gitConflictModel';
import GitChipView, { openGitRemote } from './GitChipView';
import MergeConflictModal from './MergeConflictModal';
import PublishModal from './PublishModal';
import type { PublishRequest } from './PublishModal';
import { publishGitProject } from './gitPublishWorkflow';
import SwitchBranchModal from './SwitchBranchModal';

type ToastKind = 'error' | 'success' | 'info';
type ShowToast = (message: string, kind: ToastKind) => void;
type ActionWork = () => Promise<void>;
type RunAction = (
  work: ActionWork,
  successMessage: string | null,
  label?: string,
) => Promise<boolean>;

interface GitProject {
  readonly path: string;
  readonly name: string;
}

interface GitChipProps {
  readonly project: GitProject;
  readonly showToast: ShowToast;
  readonly flushSave: () => Promise<unknown>;
  readonly onWorktreeChanged?: (() => Promise<unknown>) | undefined;
}

interface RepositoryProps extends GitChipProps {
  readonly info: WireGitInfo;
  readonly refresh: () => Promise<void>;
  readonly runAction: RunAction;
  readonly busy: string | null;
  readonly error: string | null;
  readonly setBusy: React.Dispatch<React.SetStateAction<string | null>>;
  readonly setError: React.Dispatch<React.SetStateAction<string | null>>;
}

type PendingConflict = Conflict & { readonly deleteAfter: boolean };
interface SwitchTarget {
  readonly branch: string;
  readonly files: readonly string[];
}

async function gitValue<Value>(pending: Promise<Result<Value, string>>): Promise<Value> {
  const result = await pending;
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

function useGitInfo(projectPath: string, onError: (message: string | null) => void) {
  const [info, setInfo] = useState<IpcResults['git:info'] | null>(null);
  const projectPathCurrent = useRef(projectPath);
  projectPathCurrent.current = projectPath;
  const refresh = useCallback(async (): Promise<void> => {
    const requestedPath = projectPath;
    const result = await readGitInfo(requestedPath);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    if (projectPathCurrent.current === requestedPath) {
      onError(null);
      setInfo(result.value);
    }
  }, [onError, projectPath]);
  useEffect(() => {
    setInfo(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { info, refresh } as const;
}

function useActionRunner(
  flushSave: () => Promise<unknown>,
  refresh: () => Promise<void>,
  onWorktreeChanged: (() => Promise<unknown>) | undefined,
  showToast: ShowToast,
) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runAction = useCallback<RunAction>(
    async (work, successMessage, label = 'Working…') => {
      setBusy(label);
      setError(null);
      try {
        await flushSave();
        await work();
        await refresh();
        await onWorktreeChanged?.();
        if (successMessage) {
          showToast(successMessage, 'success');
        }
        setBusy(null);
        return true;
      } catch (caught: unknown) {
        const message = cleanError(caught);
        setError(message);
        showToast(message, 'error');
        setBusy(null);
        return false;
      }
    },
    [flushSave, onWorktreeChanged, refresh, showToast],
  );
  return { busy, error, setBusy, setError, runAction } as const;
}

export default function GitChip(props: GitChipProps) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const showLoadError = useCallback((message: string | null) => setLoadError(message), []);
  const { info, refresh } = useGitInfo(props.project.path, showLoadError);
  const action = useActionRunner(
    props.flushSave,
    refresh,
    props.onWorktreeChanged,
    props.showToast,
  );
  if (!info) {
    return null;
  }
  if (!info.isRepo) {
    return (
      <InitializeGitChip
        projectPath={props.project.path}
        busy={action.busy}
        runAction={action.runAction}
      />
    );
  }
  return (
    <RepositoryGitChip
      {...props}
      info={info}
      refresh={refresh}
      runAction={action.runAction}
      busy={action.busy}
      error={action.error ?? loadError}
      setBusy={action.setBusy}
      setError={action.setError}
    />
  );
}

function InitializeGitChip({
  projectPath,
  busy,
  runAction,
}: {
  readonly projectPath: string;
  readonly busy: string | null;
  readonly runAction: RunAction;
}) {
  const initialize = (): void => {
    void runAction(
      async () => {
        await gitValue(initializeGit(projectPath));
      },
      'Initialized git repository',
      'Initializing…',
    );
  };
  return (
    <button className="git-chip" disabled={busy !== null} onClick={initialize}>
      {busy ? <span className="mini-spinner" /> : <BranchIcon size={12} />}
      {busy ?? 'Initialize Git'}
    </button>
  );
}

function RepositoryGitChip(props: RepositoryProps) {
  const state = useRepositoryState();
  const { setOpen } = state;
  const dismiss = useCallback(() => setOpen(false), [setOpen]);
  useDismiss(state.wrapRef, state.open, dismiss);
  useEffect(() => {
    if (props.error) {
      setOpen(true);
    }
  }, [props.error, setOpen]);
  useChangedFiles(props, state);
  const actions = useRepositoryActions(props, state);
  const commit = useCommitAction(props, state);
  return (
    <>
      <GitChipView
        info={props.info}
        busy={props.busy}
        error={props.error}
        open={state.open}
        commitMessage={state.commitMessage}
        newBranch={state.newBranch}
        picking={state.picking}
        picked={state.picked}
        changed={state.changed}
        wrapRef={state.wrapRef}
        onToggle={() => toggleRepository(props, state)}
        onDismissError={() => props.setError(null)}
        onSwitch={actions.requestSwitch}
        onMerge={actions.mergeBranch}
        onDelete={actions.deleteBranch}
        onNewBranch={state.setNewBranch}
        onCreateBranch={actions.createBranch}
        onCommitMessage={state.setCommitMessage}
        onTogglePicking={() => state.setPicking((value) => !value)}
        onPick={state.setPicked}
        onCommit={commit}
        onOpenRemote={openGitRemote}
        onPush={actions.push}
        onPublish={() => {
          state.setOpen(false);
          state.setShowPublish(true);
        }}
      />
      <GitModals
        {...props}
        switchTo={state.switchTo}
        conflict={state.conflict}
        showPublish={state.showPublish}
        setSwitchTo={state.setSwitchTo}
        setConflict={state.setConflict}
        setShowPublish={state.setShowPublish}
        parkThenSwitch={actions.parkThenSwitch}
        commitThenSwitch={actions.commitThenSwitch}
      />
    </>
  );
}

function useRepositoryState() {
  const [open, setOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [showPublish, setShowPublish] = useState(false);
  const [switchTo, setSwitchTo] = useState<SwitchTarget | null>(null);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [picked, setPicked] = useState<readonly string[] | null>(null);
  const [changed, setChanged] = useState<IpcResults['git:status']>([]);
  const [picking, setPicking] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  return {
    open,
    commitMessage,
    newBranch,
    showPublish,
    switchTo,
    conflict,
    changed,
    picked,
    picking,
    wrapRef,
    setOpen,
    setCommitMessage,
    setNewBranch,
    setShowPublish,
    setSwitchTo,
    setConflict,
    setChanged,
    setPicked,
    setPicking,
  } as const;
}

function toggleRepository(props: RepositoryProps, state: ReturnType<typeof useRepositoryState>) {
  state.setOpen((value) => !value);
  void props.refresh();
}

interface ChangedState {
  readonly open: boolean;
  readonly picking: boolean;
  readonly setChanged: React.Dispatch<React.SetStateAction<IpcResults['git:status']>>;
  readonly setPicked: React.Dispatch<React.SetStateAction<readonly string[] | null>>;
}

function useChangedFiles(props: RepositoryProps, state: ChangedState): void {
  const { open, picking, setChanged, setPicked } = state;
  useEffect(() => {
    if (!picking || !open) {
      return;
    }
    void readGitStatus(props.project.path).then((result) => {
      if (!result.ok) {
        setChanged([]);
        return;
      }
      setChanged(result.value);
      setPicked((current) => current ?? result.value.map((file) => file.path));
    });
  }, [props.info.dirty, props.info.head, props.project.path, open, picking, setChanged, setPicked]);
}

interface ActionState {
  readonly setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | null>>;
  readonly setConflict: React.Dispatch<React.SetStateAction<PendingConflict | null>>;
  readonly setNewBranch: React.Dispatch<React.SetStateAction<string>>;
}

function useRepositoryActions(props: RepositoryProps, state: ActionState) {
  const requestSwitch = (branch: string): void => {
    if (branch === props.info.branch) {
      return;
    }
    state.setOpen(false);
    void props.runAction(() => switchBranch(props, state, branch), null, 'Switching…');
  };
  const mergeBranch = (branch: string): void => {
    void mergeBranchAction({
      projectPath: props.project.path,
      branch,
      into: props.info.branch,
      trunk: props.info.trunk ?? null,
      run: (work, label) => void props.runAction(work, null, label),
      showToast: props.showToast,
      onConflict: (next) => {
        state.setConflict(next);
        state.setOpen(false);
      },
    });
  };
  const deleteBranch = (branch: string): void => {
    void deleteBranchAction({
      projectPath: props.project.path,
      branch,
      parked: props.info.parked.includes(branch),
      run: (work, label) => void props.runAction(work, null, label),
      showToast: props.showToast,
    });
  };
  return {
    requestSwitch,
    mergeBranch,
    deleteBranch,
    createBranch: (branch: string) => createBranch(props, state, branch),
    push: () => pushBranch(props),
    parkThenSwitch: (branch: string) => parkThenSwitch(props, branch),
    commitThenSwitch: (branch: string, message: string) => commitThenSwitch(props, branch, message),
  } as const;
}

async function switchBranch(
  props: RepositoryProps,
  state: ActionState,
  branch: string,
): Promise<void> {
  const result = await gitValue(checkoutGitBranch(props.project.path, branch, { kind: 'switch' }));
  if (!result.ok) {
    state.setSwitchTo({ branch, files: result.files });
    state.setOpen(true);
    return;
  }
  if (result.error) {
    props.showToast(result.error, 'error');
  } else if (result.restored) {
    props.showToast(`Picked your changes back up on ${branch}`, 'success');
  } else if (props.info.dirty) {
    props.showToast(`On ${branch} — your changes came with you`, 'success');
  } else {
    props.showToast(`Switched to ${branch}`, 'success');
  }
}

function createBranch(props: RepositoryProps, state: ActionState, branch: string): void {
  state.setNewBranch('');
  void props.runAction(
    async () => {
      const result = await gitValue(
        checkoutGitBranch(props.project.path, branch, { kind: 'create' }),
      );
      assert(result.ok, 'Creating a branch cannot return a blocked checkout');
    },
    `Created branch ${branch}`,
    'Creating branch…',
  );
}

function pushBranch(props: RepositoryProps): void {
  void props.runAction(
    async () => {
      await gitValue(pushGitBranch(props.project.path, props.info.branch));
    },
    `Pushed ${props.info.branch} to origin`,
    'Pushing…',
  );
}

async function parkThenSwitch(props: RepositoryProps, branch: string): Promise<boolean> {
  const from = props.info.branch;
  return props.runAction(
    async () => {
      const result = await gitValue(
        checkoutGitBranch(props.project.path, branch, { kind: 'park' }),
      );
      assert(result.ok, 'Parking before checkout cannot return a blocked checkout');
      if (result.error) {
        props.showToast(result.error, 'error');
      } else if (result.restored) {
        props.showToast(`Picked your changes back up on ${branch}`, 'success');
      }
    },
    `On ${branch} — your changes are waiting on ${from}`,
    'Switching…',
  );
}

function commitThenSwitch(
  props: RepositoryProps,
  branch: string,
  message: string,
): Promise<boolean> {
  const from = props.info.branch;
  return props.runAction(
    async () => {
      await gitValue(commitGitChanges(props.project.path, message));
      const result = await gitValue(
        checkoutGitBranch(props.project.path, branch, { kind: 'switch' }),
      );
      assert(result.ok, 'Committed work must permit the requested checkout');
    },
    `Committed to ${from}, now on ${branch}`,
    'Committing…',
  );
}

interface CommitState {
  readonly commitMessage: string;
  readonly picking: boolean;
  readonly picked: readonly string[] | null;
  readonly changed: IpcResults['git:status'];
  readonly setCommitMessage: React.Dispatch<React.SetStateAction<string>>;
  readonly setPicked: React.Dispatch<React.SetStateAction<readonly string[] | null>>;
  readonly setPicking: React.Dispatch<React.SetStateAction<boolean>>;
}

function useCommitAction(props: RepositoryProps, state: CommitState): () => void {
  return () => {
    const message = state.commitMessage.trim() || 'Update from Stacki';
    const allPicked =
      !state.picking || state.picked === null || state.picked.length === state.changed.length;
    const paths = allPicked ? undefined : state.picked;
    state.setCommitMessage('');
    void props
      .runAction(
        async () => {
          await gitValue(commitGitChanges(props.project.path, message, paths ?? undefined));
        },
        paths ? `Saved ${paths.length} file${paths.length === 1 ? '' : 's'}` : 'Changes committed',
        'Committing…',
      )
      .then(() => {
        state.setPicked(null);
        state.setPicking(false);
      });
  };
}

interface ModalProps extends RepositoryProps {
  readonly switchTo: SwitchTarget | null;
  readonly conflict: PendingConflict | null;
  readonly showPublish: boolean;
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | null>>;
  readonly setConflict: React.Dispatch<React.SetStateAction<PendingConflict | null>>;
  readonly setShowPublish: React.Dispatch<React.SetStateAction<boolean>>;
  readonly parkThenSwitch: (branch: string) => Promise<boolean>;
  readonly commitThenSwitch: (branch: string, message: string) => Promise<boolean>;
}

function GitModals(props: ModalProps) {
  return (
    <>
      {props.conflict && <ConflictModal {...props} conflict={props.conflict} />}
      {props.switchTo && <CheckoutModal {...props} switchTo={props.switchTo} />}
      {props.showPublish && <GitPublishModal {...props} />}
    </>
  );
}

function ConflictModal(props: ModalProps & { readonly conflict: PendingConflict }) {
  const resolve = async (choices: ConflictChoices): Promise<void> => {
    const done = await props.runAction(() => resolveConflict(props, choices), null, 'Merging…');
    if (done) {
      props.setConflict(null);
    }
  };
  return (
    <MergeConflictModal
      conflict={props.conflict}
      busy={props.busy}
      onCancel={() => props.setConflict(null)}
      onResolve={resolve}
    />
  );
}

async function resolveConflict(
  props: ModalProps & { readonly conflict: PendingConflict },
  choices: ConflictChoices,
): Promise<void> {
  const result = await gitValue(
    resolveGitMerge(props.project.path, props.conflict.branch, choices),
  );
  assert(result.ok, 'Merge resolution must complete');
  assert(result.into !== undefined, 'Merge resolution requires a target branch');
  if (props.conflict.deleteAfter) {
    await tidyUp({
      projectPath: props.project.path,
      branch: props.conflict.branch,
      into: result.into,
      changed: true,
      showToast: props.showToast,
    });
  } else {
    props.showToast(`Merged ${props.conflict.branch} into ${result.into}`, 'success');
  }
}

function CheckoutModal(props: ModalProps & { readonly switchTo: SwitchTarget }) {
  return (
    <SwitchBranchModal
      from={props.info.branch}
      to={props.switchTo.branch}
      files={props.switchTo.files}
      busy={props.busy}
      onCancel={() => props.setSwitchTo(null)}
      onLeaveHere={async () => {
        if (await props.parkThenSwitch(props.switchTo.branch)) {
          props.setSwitchTo(null);
        }
      }}
      onCommitFirst={async (message: string) => {
        if (await props.commitThenSwitch(props.switchTo.branch, message)) {
          props.setSwitchTo(null);
        }
      }}
    />
  );
}

function GitPublishModal(props: ModalProps) {
  const publish = async (request: PublishRequest): Promise<Result<string | undefined, string>> => {
    props.setBusy('Publishing…');
    try {
      try {
        await props.flushSave();
      } catch (caught: unknown) {
        return { ok: false, error: cleanError(caught) };
      }
      const result = await publishGitProject(props.project.path, request);
      if (result.ok) {
        await props.refresh();
      }
      return result;
    } finally {
      props.setBusy(null);
    }
  };
  return (
    <PublishModal
      projectPath={props.project.path}
      defaultName={props.project.name}
      branch={props.info.branch}
      onClose={() => props.setShowPublish(false)}
      onPublish={publish}
      openExternal={(url) => window.avb.openExternal(url)}
    />
  );
}
