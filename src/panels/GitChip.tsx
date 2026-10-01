import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcResults, WireGitInfo } from '../../shared/ipc-results';
import type { Result } from '../../shared/result';
import { assert } from '../../shared/assert';
import { cleanError } from '../lib/cleanError';
import { deleteBranchAction, mergeBranchAction, tidyUp } from '../gitActions';
import {
  checkoutGitBranch,
  commitGitChanges,
  initializeGit,
  pushGitBranch,
  readGitInfo,
  readGitStatus,
  resolveGitMerge,
} from '../gitChipBridge';
import { BranchIcon } from '../ui/Icons';
import useDismiss from '../ui/useDismiss';
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
  successMessage: string | undefined,
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
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly setBusy: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly setError: React.Dispatch<React.SetStateAction<string | undefined>>;
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

function useGitInfo(projectPath: string, onError: (message: string | undefined) => void) {
  const [info, setInfo] = useState<IpcResults['git:info'] | undefined>(undefined);
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
      onError(undefined);
      setInfo(result.value);
    }
  }, [onError, projectPath]);
  useEffect(() => {
    setInfo(undefined);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { info, refresh } as const;
}

function useActionRunner({
  flushSave,
  refresh,
  onWorktreeChanged,
  showToast,
}: {
  readonly flushSave: () => Promise<unknown>;
  readonly refresh: () => Promise<void>;
  readonly onWorktreeChanged: (() => Promise<unknown>) | undefined;
  readonly showToast: ShowToast;
}) {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const runAction = useCallback<RunAction>(
    async (work, successMessage, label = 'Working…') => {
      setBusy(label);
      setError(undefined);
      try {
        await flushSave();
        await work();
        await refresh();
        await onWorktreeChanged?.();
        if (successMessage) {
          showToast(successMessage, 'success');
        }
        setBusy(undefined);
        return true;
      } catch (caught: unknown) {
        const message = cleanError(caught);
        setError(message);
        showToast(message, 'error');
        setBusy(undefined);
        return false;
      }
    },
    [flushSave, onWorktreeChanged, refresh, showToast],
  );
  return { busy, error, setBusy, setError, runAction } as const;
}

export default function GitChip(props: GitChipProps) {
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const showLoadError = useCallback((message: string | undefined) => setLoadError(message), []);
  const { info, refresh } = useGitInfo(props.project.path, showLoadError);
  const action = useActionRunner({
    flushSave: props.flushSave,
    refresh,
    onWorktreeChanged: props.onWorktreeChanged,
    showToast: props.showToast,
  });
  if (!info) {
    return undefined;
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
  readonly busy: string | undefined;
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
    <button className="git-chip" disabled={busy !== undefined} onClick={initialize}>
      {busy ? <span className="mini-spinner" /> : <BranchIcon size={12} />}
      {busy ?? 'Initialize Git'}
    </button>
  );
}

function RepositoryGitChip(props: RepositoryProps) {
  const state = useRepositoryState();
  const { setOpen } = state;
  const dismiss = useCallback(() => setOpen(false), [setOpen]);
  useDismiss(state.wrapRef, { active: state.open }, dismiss);
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
        onDismissError={() => props.setError(undefined)}
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
  const [switchTo, setSwitchTo] = useState<SwitchTarget | undefined>(undefined);
  const [conflict, setConflict] = useState<PendingConflict | undefined>(undefined);
  // The files picked for a partial commit; undefined until the picker loads them.
  const [picked, setPicked] = useState<readonly string[] | undefined>(undefined);
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
  readonly setPicked: React.Dispatch<React.SetStateAction<readonly string[] | undefined>>;
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
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | undefined>>;
  readonly setConflict: React.Dispatch<React.SetStateAction<PendingConflict | undefined>>;
  readonly setNewBranch: React.Dispatch<React.SetStateAction<string>>;
}

function useRepositoryActions(props: RepositoryProps, state: ActionState) {
  const requestSwitch = (branch: string): void => {
    if (branch === props.info.branch) {
      return;
    }
    state.setOpen(false);
    void props.runAction(() => switchBranch(props, state, branch), undefined, 'Switching…');
  };
  const mergeBranch = (branch: string): void => {
    void mergeBranchAction({
      projectPath: props.project.path,
      branch,
      into: props.info.branch,
      trunk: props.info.trunk,
      run: (work, label) => void props.runAction(work, undefined, label),
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
      run: (work, label) => void props.runAction(work, undefined, label),
      showToast: props.showToast,
    });
  };
  return {
    requestSwitch,
    mergeBranch,
    deleteBranch,
    createBranch: (branch: string) => createNamedBranch(props, state, branch),
    push: () => pushBranch(props),
    parkThenSwitch: (branch: string) => parkAndSwitch(props, branch),
    commitThenSwitch: (branch: string, message: string) => commitAndSwitch(props, branch, message),
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

function createNamedBranch(props: RepositoryProps, state: ActionState, branch: string): void {
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

async function parkAndSwitch(props: RepositoryProps, branch: string): Promise<boolean> {
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

function commitAndSwitch(
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
  readonly picked: readonly string[] | undefined;
  readonly changed: IpcResults['git:status'];
  readonly setCommitMessage: React.Dispatch<React.SetStateAction<string>>;
  readonly setPicked: React.Dispatch<React.SetStateAction<readonly string[] | undefined>>;
  readonly setPicking: React.Dispatch<React.SetStateAction<boolean>>;
}

function useCommitAction(props: RepositoryProps, state: CommitState): () => void {
  return () => {
    const message = state.commitMessage.trim() || 'Update from Stacki';
    const allPicked =
      !state.picking || state.picked === undefined || state.picked.length === state.changed.length;
    const paths = allPicked ? undefined : state.picked;
    state.setCommitMessage('');
    void props
      .runAction(
        async () => {
          await gitValue(commitGitChanges(props.project.path, message, paths));
        },
        paths ? `Saved ${paths.length} file${paths.length === 1 ? '' : 's'}` : 'Changes committed',
        'Committing…',
      )
      .then(() => {
        state.setPicked(undefined);
        state.setPicking(false);
      });
  };
}

interface ModalProps extends RepositoryProps {
  readonly switchTo: SwitchTarget | undefined;
  readonly conflict: PendingConflict | undefined;
  readonly showPublish: boolean;
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | undefined>>;
  readonly setConflict: React.Dispatch<React.SetStateAction<PendingConflict | undefined>>;
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
    const done = await props.runAction(
      () => resolveConflict(props, choices),
      undefined,
      'Merging…',
    );
    if (done) {
      props.setConflict(undefined);
    }
  };
  return (
    <MergeConflictModal
      conflict={props.conflict}
      busy={props.busy}
      onCancel={() => props.setConflict(undefined)}
      onResolve={(choices) => {
        // runAction reports its own failures (a toast and the chip's error).
        void resolve(choices);
      }}
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
      onCancel={() => props.setSwitchTo(undefined)}
      onLeaveHere={() => {
        // runAction reports its own failures and resolves false; it never rejects.
        void props.parkThenSwitch(props.switchTo.branch).then((done) => {
          if (done) {
            props.setSwitchTo(undefined);
          }
        });
      }}
      onCommitFirst={(message: string) => {
        // runAction reports its own failures and resolves false; it never rejects.
        void props.commitThenSwitch(props.switchTo.branch, message).then((done) => {
          if (done) {
            props.setSwitchTo(undefined);
          }
        });
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
      props.setBusy(undefined);
    }
  };
  return (
    <PublishModal
      projectPath={props.project.path}
      defaultName={props.project.name}
      branch={props.info.branch}
      onClose={() => props.setShowPublish(false)}
      onPublish={publish}
      openExternal={(url) => {
        // Opening a link is best effort, as everywhere else in the app.
        void window.avb.openExternal(url);
      }}
    />
  );
}
