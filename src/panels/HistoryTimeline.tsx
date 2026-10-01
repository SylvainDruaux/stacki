import React, { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../shared/assert';
import type { HistoryCommit, HistoryCommitFile } from '../historyBridge';
import { readHistoryLog } from '../historyBridge';
import { commitAuthor, dayGroup, relativeTime, summarize } from '../historyModel';
import { ChevronRightIcon, PreviewIcon } from '../ui/Icons';
import FileStatus from '../features/git/FileStatus';

const HISTORY_COMMITS_MAX = 10_000;

type TimelineState =
  | {
      readonly kind: 'loading';
      readonly commits: readonly HistoryCommit[];
      readonly atEnd: boolean;
    }
  | { readonly kind: 'ready'; readonly commits: readonly HistoryCommit[]; readonly atEnd: boolean }
  | {
      readonly kind: 'error';
      readonly commits: readonly HistoryCommit[];
      readonly atEnd: boolean;
      readonly message: string;
    };

interface HistoryTimelineProps {
  readonly projectPath: string;
  readonly branch: string | undefined;
  readonly head: string | undefined;
  readonly userEmail: string | undefined;
  readonly previewRef: string | undefined;
  readonly onPreviewCommit: (commit: HistoryCommit) => void;
  readonly onExitPreview: () => void;
  readonly onRestoreFile: (commit: HistoryCommit, file: HistoryCommitFile) => void;
  readonly onRestoreProject: (commit: HistoryCommit) => void;
}

export default function HistoryTimeline(props: HistoryTimelineProps) {
  const timeline = useTimeline(props.projectPath, props.branch, props.head);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  useEffect(() => {
    setExpanded((hash) =>
      hash && timeline.state.commits.some((commit) => commit.hash === hash) ? hash : undefined,
    );
  }, [timeline.state.commits]);
  return (
    <>
      {timeline.state.kind === 'loading' && <p className="history-empty">Reading history…</p>}
      {timeline.state.kind === 'error' && <p className="history-error">{timeline.state.message}</p>}
      {timeline.state.kind === 'ready' && timeline.state.commits.length === 0 && (
        <p className="history-empty">
          Nothing saved yet. Once you save your first version it shows up here, and you can come
          back to it whenever you like.
        </p>
      )}
      {timeline.state.commits.map((commit, index) => (
        <CommitRow
          key={commit.hash}
          commit={commit}
          newDay={startsDay(timeline.state.commits, index)}
          expanded={expanded === commit.hash}
          previewing={props.previewRef === commit.hash}
          toggle={() => setExpanded(expanded === commit.hash ? undefined : commit.hash)}
          {...props}
        />
      ))}
      {!timeline.state.atEnd && timeline.state.kind !== 'loading' && (
        <button className="history-more" onClick={timeline.loadOlder}>
          Show older
        </button>
      )}
    </>
  );
}

function useTimeline(projectPath: string, branch: string | undefined, head: string | undefined) {
  const [state, setState] = useState<TimelineState>({ kind: 'loading', commits: [], atEnd: false });
  const requestRef = useRef(0);
  useEffect(() => {
    const request = ++requestRef.current;
    setState({ kind: 'loading', commits: [], atEnd: false });
    void readHistoryLog(projectPath, 0).then((result) => {
      if (requestRef.current !== request) {
        return;
      }
      setState(
        result.ok
          ? { kind: 'ready', commits: result.value.commits, atEnd: result.value.atEnd }
          : { kind: 'error', commits: [], atEnd: false, message: result.error },
      );
    });
    return () => {
      requestRef.current += 1;
    };
  }, [branch, head, projectPath]);
  const loadOlder = useCallback(() => {
    if (state.kind === 'loading' || state.commits.length >= HISTORY_COMMITS_MAX) {
      return;
    }
    void appendHistory(projectPath, state, requestRef, setState);
  }, [projectPath, state]);
  return { state, loadOlder };
}

async function appendHistory(
  projectPath: string,
  previous: TimelineState,
  requestRef: React.MutableRefObject<number>,
  setState: React.Dispatch<React.SetStateAction<TimelineState>>,
): Promise<void> {
  const request = ++requestRef.current;
  setState({ kind: 'loading', commits: previous.commits, atEnd: previous.atEnd });
  const result = await readHistoryLog(projectPath, previous.commits.length);
  if (requestRef.current !== request) {
    return;
  }
  if (!result.ok) {
    setState({ kind: 'error', commits: previous.commits, atEnd: false, message: result.error });
    return;
  }
  const commits = mergeCommits(previous.commits, result.value.commits);
  setState({
    kind: 'ready',
    commits,
    atEnd: result.value.atEnd || commits.length >= HISTORY_COMMITS_MAX,
  });
}

function mergeCommits(
  previous: readonly HistoryCommit[],
  incoming: readonly HistoryCommit[],
): readonly HistoryCommit[] {
  const commits = new Map(previous.map((commit) => [commit.hash, commit]));
  for (const commit of incoming) {
    if (commits.size >= HISTORY_COMMITS_MAX) {
      break;
    }
    commits.set(commit.hash, commit);
  }
  assert(commits.size <= HISTORY_COMMITS_MAX, 'History timeline: commit limit exceeded');
  return [...commits.values()];
}

function startsDay(commits: readonly HistoryCommit[], index: number): boolean {
  const commit = commits.at(index);
  assert(commit !== undefined, 'History timeline: current commit exists');
  const previous = commits.at(index - 1);
  return previous === undefined || dayGroup(commit.when) !== dayGroup(previous.when);
}

interface CommitRowProps extends HistoryTimelineProps {
  readonly commit: HistoryCommit;
  readonly newDay: boolean;
  readonly expanded: boolean;
  readonly previewing: boolean;
  readonly toggle: () => void;
}

function CommitRow(props: CommitRowProps) {
  const { commit } = props;
  return (
    <>
      {props.newDay && <div className="history-day">{dayGroup(commit.when)}</div>}
      <div
        className={`history-commit ${props.expanded ? 'open' : ''} ${
          props.previewing ? 'previewing' : ''
        }`}
      >
        <button className="history-commit-head" onClick={props.toggle}>
          <span className="history-dot" />
          <span className="history-commit-main">
            <span className="history-subject">{commit.subject}</span>
            <span className="history-meta">
              {commitAuthor(commit, props.userEmail)} · {summarize(commit.files)} ·{' '}
              {relativeTime(commit.when)}
            </span>
          </span>
        </button>
        {props.expanded && <CommitBody {...props} />}
      </div>
    </>
  );
}

function CommitBody(props: CommitRowProps) {
  const { commit } = props;
  return (
    <div className="history-commit-body">
      <div className="history-files">
        {commit.files?.map((file) => (
          <div className="history-file" key={file.path + (file.from ?? '')}>
            <FileStatus status={file.status} inCommit />
            <span className="history-file-label" title={file.path}>
              {file.label}
            </span>
            <button
              className="row-action"
              title={`Put ${file.label} back to how it was here`}
              onClick={() => props.onRestoreFile(commit, file)}
            >
              <ChevronRightIcon size={12} />
            </button>
          </div>
        ))}
        {!commit.files?.length && (
          <div className="history-file muted">Nothing changed in this one</div>
        )}
      </div>
      <div className="history-commit-actions">
        <button
          className={props.previewing ? 'primary' : ''}
          onClick={() => (props.previewing ? props.onExitPreview() : props.onPreviewCommit(commit))}
        >
          <PreviewIcon size={12} />
          {props.previewing ? 'Back to now' : 'Preview this version'}
        </button>
        <button onClick={() => props.onRestoreProject(commit)}>Take everything back to here</button>
      </div>
      <div className="history-hash" title="What git calls this version">
        {commit.shortHash}
        {commit.isMerge ? ' · brought a branch in' : ''}
      </div>
    </div>
  );
}
