import type { IpcResults, WireWorktreeInfo } from '../../../shared/ipc-results';
import type { HistoryCommit, HistoryCommitFile, HistoryFile } from './historyBridge';

export type HistoryGitInfo = IpcResults['git:info'];

export interface HistoryPanelProps {
  readonly project: { readonly path: string } | undefined;
  readonly gitInfo: HistoryGitInfo | undefined;
  readonly previewRef: string | undefined;
  readonly onPreviewCommit: (commit: HistoryCommit) => void;
  readonly onExitPreview: () => void;
  readonly onRestoreFile: (commit: HistoryCommit, file: HistoryCommitFile) => void;
  readonly onRestoreProject: (commit: HistoryCommit) => void;
  readonly onOpenFile: (file: HistoryFile) => void;
  readonly onSwitchBranch: (branch: string) => void;
  readonly onMergeBranch: (branch: string) => void;
  readonly onDeleteBranch: (branch: string) => void;
}

export interface HistoryOpen {
  readonly timeline: boolean;
  readonly files: boolean;
  readonly branches: boolean;
  readonly worktrees: boolean;
}

export interface HistoryInventory {
  readonly files: readonly HistoryFile[];
  readonly worktrees: readonly WireWorktreeInfo[];
}
