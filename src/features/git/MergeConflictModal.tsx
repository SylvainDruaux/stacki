import React, { useMemo, useState } from 'react';
import type {
  Conflict,
  ConflictChoice,
  ConflictChoices,
  ConflictPicks,
  ConflictHunk,
} from './gitConflictModel';
import { assert } from '../../../shared/core/assert';
import {
  choicesForSend,
  conflictHunks,
  conflictLabel,
  contestedIn,
  initialConflictPicks,
} from './gitConflictModel';
import Code from './Code';

export interface MergeConflictProps {
  readonly conflict: Conflict;
  readonly busy: string | undefined;
  readonly onCancel: () => void;
  readonly onResolve: (choices: ConflictChoices) => void;
}
export default function MergeConflictModal(props: MergeConflictProps) {
  const model = useConflict(props);
  const { working, conflict, busy, onCancel, onResolve, picks } = model;
  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          if (!working) {
            onCancel();
          }
        }
      }}
    >
      <div className="modal conflict-modal">
        <div className="modal-header">Both branches changed the same thing</div>
        <ConflictIntro conflict={conflict} />
        <div className="conflict-split">
          <ConflictFiles model={model} />
          <ConflictDetail model={model} />
        </div>
        {working && (
          <div className="publish-progress" style={{ padding: '0 16px 8px' }}>
            <span className="mini-spinner" />
            <span>{busy}</span>
          </div>
        )}
        <div className="modal-footer">
          <button onClick={onCancel} disabled={working}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={working}
            onClick={() => onResolve(choicesForSend(conflict, picks))}
          >
            Merge with these choices
          </button>
        </div>
      </div>
    </div>
  );
}
function useConflict(props: MergeConflictProps) {
  const { conflict } = props;
  const [picks, setPicks] = useState<ConflictPicks>(() => initialConflictPicks(conflict));
  const first = conflict.files[0];
  assert(first !== undefined, 'Merge conflict: at least one file is required');
  const [openPath, setOpenPath] = useState(first.path);
  const file = conflict.files.find((candidate) => candidate.path === openPath) ?? first;
  const hunks = useMemo(() => conflictHunks(file.parts ?? []), [file.parts]);
  const setOne = (path: string, index: number, choice: ConflictChoice) =>
    setPicks((current) => {
      const choices = current[path];
      assert(choices !== undefined, 'Merge conflict: selected file must exist');
      assert(index >= 0, 'Merge conflict: choice index must be nonnegative');
      assert(index < choices.length, 'Merge conflict: choice index exceeds count');
      return {
        ...current,
        [path]: choices.map((value, position) => (position === index ? choice : value)),
      };
    });
  const setAll = (path: string, choice: ConflictChoice) =>
    setPicks((current) => {
      const choices = current[path];
      assert(choices !== undefined, 'Merge conflict: selected file must exist');
      return { ...current, [path]: choices.map(() => choice) };
    });
  const setWhole = (path: string, choice: 'ours' | 'theirs') =>
    setPicks((current) => ({ ...current, [path]: [choice] }));
  return {
    ...props,
    picks,
    openPath,
    setOpenPath,
    file,
    hunks,
    setOne,
    setAll,
    setWhole,
    working: Boolean(props.busy),
  };
}
type ConflictModel = ReturnType<typeof useConflict>;
interface ModelProps {
  readonly model: ConflictModel;
}
function ConflictIntro({ conflict }: Pick<MergeConflictProps, 'conflict'>) {
  const contested = conflict.files.reduce((total, file) => total + contestedIn(file), 0);
  return (
    <div className="conflict-intro hint-text">
      {contested === 0 ? (
        <>
          Every difference could be worked out on its own — each change was made on only one branch,
          or in a different part of the same line. Look it over and merge.
        </>
      ) : (
        <>
          {contested === 1 ? 'One place' : `${contested} places`} where{' '}
          <strong>{conflict.from}</strong> and <strong>{conflict.branch}</strong> really disagree.
          The rest is already worked out.
        </>
      )}
    </div>
  );
}
function ConflictFiles({ model }: ModelProps) {
  return (
    <div className="conflict-files">
      {model.conflict.files.map((file) => {
        const left = contestedIn(file);
        return (
          <button
            key={file.path}
            className={`conflict-file-row ${file.path === model.openPath ? 'on' : ''}`}
            onClick={() => model.setOpenPath(file.path)}
            title={file.path}
          >
            <span className="conflict-file-name">{file.path.split('/').pop()}</span>
            <span className="conflict-file-dir">{file.path.split('/').slice(0, -1).join('/')}</span>
            <span className={`conflict-file-badge ${left ? 'warn' : ''}`}>
              {left ? `${left} to decide` : 'sorted'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
function ConflictDetail({ model }: ModelProps) {
  const { file, working, conflict, setAll, hunks } = model;
  return (
    <div className="conflict-detail">
      {file.parts === undefined ? (
        <ConflictWhole model={model} />
      ) : (
        <>
          <div className="conflict-detail-head">
            <span className="conflict-detail-path">{file.path}</span>
            <div className="conflict-choice">
              <button disabled={working} onClick={() => setAll(file.path, 'ours')}>
                All {conflict.from}
              </button>
              <button disabled={working} onClick={() => setAll(file.path, 'theirs')}>
                All {conflict.branch}
              </button>
            </div>
          </div>
          {hunks.map((hunk) => (
            <ConflictHunkView key={hunk.index} model={model} hunk={hunk} />
          ))}
        </>
      )}
    </div>
  );
}
function ConflictWhole({ model }: ModelProps) {
  const { conflict, file, picks, setWhole, working } = model;
  return (
    <div className="conflict-whole">
      This one can only be taken whole — there’s no text in it to compare.
      <div className="conflict-choice" style={{ marginTop: 8 }}>
        <button
          className={picks[file.path]?.[0] !== 'theirs' ? 'on' : ''}
          disabled={working}
          onClick={() => setWhole(file.path, 'ours')}
        >
          {conflict.from}
        </button>
        <button
          className={picks[file.path]?.[0] === 'theirs' ? 'on' : ''}
          disabled={working}
          onClick={() => setWhole(file.path, 'theirs')}
        >
          {conflict.branch}
        </button>
      </div>
    </div>
  );
}
interface HunkProps extends ModelProps {
  readonly hunk: ConflictHunk;
}
function ConflictHunkView({ model, hunk }: HunkProps) {
  const { clash, index, before, after } = hunk;
  const choice = model.picks[model.file.path]?.[index];
  return (
    <div className={`conflict-hunk ${clash.merged !== undefined ? 'combined' : ''}`}>
      <div className="conflict-hunk-head">
        <span className="conflict-hunk-n">{conflictLabel(model.conflict, clash)}</span>
        <ConflictHunkChoices model={model} hunk={hunk} />
      </div>
      {before && <div className="conflict-ctx">{before}</div>}
      {clash.merged !== undefined && choice === 'merged' ? (
        <div className="conflict-side kept">
          <div className="conflict-side-label">both edits, combined</div>
          <Code text={clash.merged} filename={model.file.path} maxHeight={160} />
        </div>
      ) : (
        <ConflictSides model={model} hunk={hunk} />
      )}
      {after && <div className="conflict-ctx">{after}</div>}
    </div>
  );
}
function ConflictHunkChoices({ model, hunk }: HunkProps) {
  const { clash, index } = hunk;
  const { picks, file, working, setOne, conflict } = model;
  const choice = picks[file.path]?.[index];
  return (
    <div className="conflict-choice">
      {clash.merged !== undefined && (
        <button
          className={choice === 'merged' ? 'on' : ''}
          disabled={working}
          onClick={() => setOne(file.path, index, 'merged')}
          title="Keep both edits — they don’t overlap"
        >
          Both edits
        </button>
      )}
      <button
        className={choice === 'ours' ? 'on' : ''}
        disabled={working}
        onClick={() => setOne(file.path, index, 'ours')}
      >
        {conflict.from}
      </button>
      <button
        className={choice === 'theirs' ? 'on' : ''}
        disabled={working}
        onClick={() => setOne(file.path, index, 'theirs')}
      >
        {conflict.branch}
      </button>
      {clash.changedBy === 'both' && clash.merged === undefined && (
        <button
          className={choice === 'both' ? 'on' : ''}
          disabled={working}
          onClick={() => setOne(file.path, index, 'both')}
          title="Keep both versions, one after the other"
        >
          Both
        </button>
      )}
    </div>
  );
}
function ConflictSides({ model, hunk }: HunkProps) {
  const { conflict, file, picks } = model;
  const choice = picks[file.path]?.[hunk.index];
  const sides = [
    { id: 'ours', label: conflict.from, text: hunk.clash.ours },
    { id: 'theirs', label: conflict.branch, text: hunk.clash.theirs },
  ];
  return (
    <div className="conflict-sides">
      {sides.map((side) => (
        <div
          className={`conflict-side ${choice === side.id || choice === 'both' ? 'kept' : ''}`}
          key={side.id}
        >
          <div className="conflict-side-label">{side.label}</div>
          {side.text ? (
            <Code text={side.text} filename={file.path} maxHeight={160} />
          ) : (
            <div className="conflict-empty">(nothing)</div>
          )}
        </div>
      ))}
    </div>
  );
}
