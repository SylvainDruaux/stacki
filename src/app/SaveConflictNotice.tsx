// The notice for a refused save (plan §7, rejection UX contract). It never
// blocks: the page stays editable underneath and keeps every local edit. A
// refused edit request (step 6) names the actor's reason.
import { describeRejection, type RejectionReason } from '../../shared/engine/intent';

// Nothing is discarded and nothing is written over the outside change until the
// user picks an action — reloading and saving over are deliberate acts.

interface SaveConflictNoticeProps {
  readonly fileName: string;
  /** Why an edit request was refused; absent for a refused whole-page save. */
  readonly reason: RejectionReason | undefined;
  /** The code panel is open on this page, so the local text can be kept. */
  readonly reviewing: boolean;
  readonly onReload: () => void;
  readonly onReview: () => void;
  readonly onKeep: () => void;
}

export default function SaveConflictNotice({
  fileName,
  reason,
  reviewing,
  onReload,
  onReview,
  onKeep,
}: SaveConflictNoticeProps) {
  return (
    <div className="save-conflict" role="status">
      <span className="save-conflict-text">
        {reason === undefined ? (
          <>
            <strong>{fileName}</strong> changed on disk while you were editing.
          </>
        ) : (
          <>
            <strong>{fileName}</strong>: {describeRejection(reason)}
          </>
        )}{' '}
        Your edits are kept here and are not being saved.
      </span>
      <button
        className="save-conflict-action"
        title="Discard your unsaved edits and show the file as it is on disk"
        onClick={onReload}
      >
        Reload from disk
      </button>
      {reviewing ? (
        <button
          className="save-conflict-action primary"
          title="Save the text in the code panel over the version on disk"
          onClick={onKeep}
        >
          Save this version
        </button>
      ) : (
        <button
          className="save-conflict-action primary"
          title="Open your unsaved version in the code panel"
          onClick={onReview}
        >
          Review in code
        </button>
      )}
    </div>
  );
}
