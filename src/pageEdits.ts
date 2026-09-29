// The renderer half of the compat adapter and the persistence layer's edit
// queue (plan §2 layer 3, §7; step 6). A gesture that has an intent form is
// sent as an edit request — main writes splices, never the whole file — and
// every other gesture still saves the whole model (`replace-source`) until its
// turn in the §11.6 order.
//
// Where a request's node references come from: the page's origin, the parse
// the shown model was cloned from. The shown model and its origin share node
// ids because one is a clone of the other, not because an id survived a
// reparse (plan §4: modelAdoption.ts keys the UI and never feeds an anchor).
// The reference is that parse's own facts — a path, a kind, a source range —
// and main checks them against its projection of the same bytes. After the
// app's own saves the origin stays put until the page is clean again; main
// rebases requests authored against it through its commit log, exactly.
//
// The queue's rules (plan §7):
//   - Requests coalesce within a stream (one field of one node) while unsent:
//     the latest value wins, and a set is idempotent. Structural requests
//     carry no stream and never coalesce. The actor never merges.
//   - A gesture without an intent form turns the queue into `model`: the
//     whole-model save then carries every unsaved edit, the queued ones
//     included, until the page is clean again.
//   - A refusal never destroys input: the edits stay in the model, and the
//     page's conflict notice names the reason (plan §7, rejection contract).
//   - Typing in the code editor turns the queue into `code` (step 8): the
//     page's unsaved edits are its text, saved as one patch from the baseline
//     the text descends from (src/codeEdits.ts) until the page is clean.
//     Requests queued before the typing are dropped, as the whole-model save
//     dropped them before: the text the user typed into does not hold them.
import { assert } from '../shared/assert';
import type { Digest } from '../shared/brand';
import type { EditorModel } from '../shared/editor-model';
import type { Edit, EditRequest, NodeRef } from '../shared/edit-request';
import type { RejectionReason, SourceEdit } from '../shared/intent';
import { LIMITS } from '../shared/limits';
import type { PageEditError, PageEdited } from '../shared/page-save';
import type { PageModel, PageNode } from '../shared/page-node';
import type { Result } from '../shared/result';
import type { SaveState } from './saveState';

/** The parse a shown model was cloned from, and the checksum of its bytes. */
export interface PageOrigin {
  readonly checksum: Digest;
  readonly model: PageModel;
}

/** One applied edit, as Undo needs it: the inverse hunks and the checksum of
 * the bytes they are hunks of. */
export interface AppliedEdit {
  readonly checksum: Digest;
  readonly inverse: readonly SourceEdit[];
}

/** What became of a gesture's requests, for its undo entry. `sent` counts the
 * requests still owed an answer; `subsumed` means a whole-model save carried
 * the gesture, so only the entry's snapshot can undo it. */
export type EditsOutcome =
  | { readonly tag: 'pending'; readonly waiting: number; readonly applied: readonly AppliedEdit[] }
  | { readonly tag: 'applied'; readonly applied: readonly AppliedEdit[] }
  | { readonly tag: 'subsumed' };

/** The undo entry of a gesture that went out as requests. Its outcome is
 * written as answers arrive: the one field of it that changes. */
export interface EditsRecord {
  outcome: EditsOutcome;
}

export interface EditDraft {
  readonly edit: Edit;
  readonly authoredChecksum: Digest;
  /** Coalescing key; null for a request that must go out on its own. */
  readonly stream: string | null;
  readonly record: EditsRecord;
}

/** The bytes a code save is a patch of (step 8). */
export type CodeBaseline =
  /** A version the page's actor holds: its checksum and text, and the text
   * the editor's typing descends from. The two texts are one unless a save
   * came back holding more than it sent — an outside edit merged, a request
   * rebased — and then the next save merges the typing into it first. */
  | {
      readonly tag: 'known';
      readonly checksum: Digest;
      readonly source: string;
      readonly typedFrom: string;
    }
  /** "Save this version" over a refused save: the patch is of whatever the
   * disk holds at the page's base, read when the save is sent. */
  | { readonly tag: 'disk' };

export type DraftQueue =
  | { readonly tag: 'edits'; readonly pending: readonly EditDraft[] }
  | { readonly tag: 'model' }
  | { readonly tag: 'code'; readonly baseline: CodeBaseline };

/** A page as the code editor showed it when the user typed: its save state
 * and the text its editor held. */
export interface TypedFrom {
  readonly save: SaveState;
  readonly source: string;
}

/** The reference main needs for a node of the origin, or undefined when the
 * node is not one main can name in the page's own bytes: created since the
 * origin was read, inside a chunk file, or without a source range. */
export function nodeRefIn(origin: PageOrigin, nodeId: string): NodeRef | undefined {
  assert(origin.model.format === undefined, 'Only .astro pages have an edit origin');
  const pending: { readonly node: PageNode; readonly path: readonly number[] }[] = [];
  origin.model.nodes.forEach((node, index) => pending.push({ node, path: [index] }));
  // Preorder over at most the tree's own bound.
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'The origin stays inside the tree bound');
    const entry = pending[visited];
    assert(entry !== undefined, 'The visit index lies inside the pending list');
    const node = entry.node;
    if (node.kind === 'chunk-group') {
      continue; // Its children live in another file, with other offsets.
    }
    if (node.id === nodeId) {
      if (node.start === undefined || node.end === undefined) {
        return undefined;
      }
      return { path: entry.path, kind: node.kind, span: { start: node.start, end: node.end } };
    }
    if ('children' in node && Array.isArray(node.children)) {
      const children: readonly PageNode[] = node.children;
      children.forEach((child, index) =>
        pending.push({ node: child, path: [...entry.path, index] }),
      );
    }
  }
  return undefined;
}

/** A gesture as the adapter states it (step 6): the requests it is, against
 * the origin's nodes, or undefined when it has no intent form yet; and its
 * effect on the shown model, applied at once. The effect is a pure function —
 * a new model, the old one untouched — so the adapter's edit is centralized
 * here instead of spread over mutation sites (the adapter-surface ratchet). */
export interface EditGesture {
  readonly request: (
    refOf: (nodeId: string) => NodeRef | undefined,
  ) => readonly StreamedEdit[] | undefined;
  readonly apply: (model: EditorModel) => EditorModel;
  /** Groups undo steps and coalesces bursts, as mutateModel's key did. */
  readonly coalesceKey: string | null;
  readonly urgency: boolean | 'live';
}

export interface StreamedEdit {
  readonly edit: Edit;
  /** One field of one node; null when the request must go out on its own. */
  readonly stream: string | null;
}

/** The unsent requests of the open page, and the rules above. Keyed by the
 * page and its origin: a new origin means the page was clean in between, so
 * nothing from before is owed. Private, mutable state with one owner
 * (AGENTS.md §7): the page saver's write. */
export class EditDrafts {
  #path: string | undefined;
  #origin: Digest | undefined;
  #queue: DraftQueue = { tag: 'edits', pending: [] };

  queue(path: string): DraftQueue {
    return path === this.#path ? this.#queue : { tag: 'model' };
  }

  /** The user typed in the code editor (or Undo put text back): from now
   * until the page is clean its edits are its text. The baseline is the page
   * as shown before the change — the text the typing descends from and the
   * checksum of those bytes — kept while the queue already holds code. A
   * refused page's shown text may be a review of the model rather than
   * bytes on disk, so its baseline is the disk, read at the save. */
  typeCode(path: string, shown: TypedFrom): void {
    const save = shown.save;
    const fresh = path !== this.#path || save.tag === 'clean';
    const queue = this.queue(path);
    if (!fresh && queue.tag === 'code') {
      return;
    }
    if (!fresh && queue.tag === 'edits') {
      for (const draft of queue.pending) {
        subsume(draft.record);
      }
    }
    this.#path = path;
    this.#origin = undefined; // Requests start over once the page is clean.
    this.#queue = { tag: 'code', baseline: typedBaseline(shown) };
    assert(this.queue(path).tag === 'code', 'Typing leaves the page in code');
  }

  /** The baseline of the page's code queue. */
  codeBaseline(path: string): CodeBaseline {
    const queue = this.queue(path);
    assert(queue.tag === 'code', 'Only a code queue has a baseline');
    return queue.baseline;
  }

  /** A code save applied: the disk holds `checksum`, whose text is `source`,
   * and the typing since descends from `typedFrom`, the text the save sent. */
  codeSaved(path: string, saved: Omit<Extract<CodeBaseline, { tag: 'known' }>, 'tag'>): void {
    if (this.queue(path).tag !== 'code') {
      return; // A whole-model save took over meanwhile; it carries the text.
    }
    this.#queue = { tag: 'code', baseline: { tag: 'known', ...saved } };
  }

  /** The user keeps their text over a refused save ("Save this version"):
   * a code queue now patches whatever the disk holds at the new base. */
  acceptDisk(path: string): void {
    if (this.queue(path).tag === 'code') {
      this.#queue = { tag: 'code', baseline: { tag: 'disk' } };
    }
  }

  /** Queue a request; false when the page saves whole models until clean. */
  record(path: string, draft: EditDraft): boolean {
    if (path !== this.#path || draft.authoredChecksum !== this.#origin) {
      // Clean since: whatever was queued for the old origin went to disk, or
      // was discarded by a reload.
      this.#path = path;
      this.#origin = draft.authoredChecksum;
      this.#queue = { tag: 'edits', pending: [] };
    }
    const queue = this.#queue;
    if (queue.tag !== 'edits') {
      // Code typed since the origin was read never keeps that origin (App's
      // changeCodeSource drops it), so a code queue reaches here only through
      // a bug; the whole-model save is the one that carries both.
      assert(queue.tag === 'model', 'A request is never recorded over typed code');
      subsume(draft.record);
      return false;
    }
    const last = queue.pending[queue.pending.length - 1];
    if (coalesces(last, draft)) {
      this.#queue = { tag: 'edits', pending: [...queue.pending.slice(0, -1), draft] };
      return true;
    }
    if (queue.pending.length >= LIMITS.intentsPendingMax) {
      // More unsent requests than one actor queues: the whole-model save
      // carries them instead of growing the queue (plan §8).
      this.markModel(path);
      subsume(draft.record);
      return false;
    }
    owe(draft.record);
    this.#queue = { tag: 'edits', pending: [...queue.pending, draft] };
    return true;
  }

  /** A gesture without an intent form: whole models until clean. */
  markModel(path: string): void {
    const queue = this.queue(path);
    if (queue.tag === 'edits') {
      for (const draft of queue.pending) {
        subsume(draft.record);
      }
    }
    if (path !== this.#path) {
      this.#origin = undefined;
    }
    this.#path = path;
    this.#queue = { tag: 'model' };
  }

  /** Take every unsent request, oldest first, to send now. */
  take(path: string): readonly EditDraft[] {
    const queue = this.queue(path);
    if (queue.tag !== 'edits') {
      return [];
    }
    this.#queue = { tag: 'edits', pending: [] };
    return queue.pending;
  }

  /** Put back requests a failed save did not send, ahead of newer ones. */
  restore(path: string, drafts: readonly EditDraft[]): void {
    const queue = this.queue(path);
    if (queue.tag !== 'edits') {
      for (const draft of drafts) {
        subsume(draft.record);
      }
      return;
    }
    this.#queue = { tag: 'edits', pending: [...drafts, ...queue.pending] };
  }
}

function typedBaseline(shown: TypedFrom): CodeBaseline {
  const save = shown.save;
  switch (save.tag) {
    case 'clean':
      return {
        tag: 'known',
        checksum: save.checksum,
        source: shown.source,
        typedFrom: shown.source,
      };
    case 'dirty':
    case 'saving':
      // Visual edits change the model, never `source`: it is still the text
      // of the bytes the page's edits were authored against.
      return {
        tag: 'known',
        checksum: save.baseChecksum,
        source: shown.source,
        typedFrom: shown.source,
      };
    case 'conflicted':
      return { tag: 'disk' };
    default: {
      const exhaustive: never = save;
      return exhaustive;
    }
  }
}

// One stream, one undo entry, still unsent: the newer value replaces the
// older. A set is idempotent, so only the last value matters on disk.
function coalesces(last: EditDraft | undefined, draft: EditDraft): boolean {
  if (last === undefined || draft.stream === null) {
    return false;
  }
  if (last.stream === draft.stream) {
    return last.record === draft.record;
  }
  return false;
}

/** The request went out and applied: the undo entry learns its inverse. */
export function recordApplied(record: EditsRecord, applied: AppliedEdit): void {
  const outcome = record.outcome;
  if (outcome.tag !== 'pending') {
    return; // Subsumed by a whole-model save: the snapshot undoes it.
  }
  assert(outcome.waiting > 0, 'An answer arrives for a request the record waits on');
  const done = [...outcome.applied, applied];
  record.outcome =
    outcome.waiting === 1
      ? { tag: 'applied', applied: done }
      : { tag: 'pending', waiting: outcome.waiting - 1, applied: done };
}

export function subsume(record: EditsRecord): void {
  record.outcome = { tag: 'subsumed' };
}

function owe(record: EditsRecord): void {
  const outcome = record.outcome;
  switch (outcome.tag) {
    case 'pending':
      record.outcome = { ...outcome, waiting: outcome.waiting + 1 };
      return;
    case 'applied':
      record.outcome = { tag: 'pending', waiting: 1, applied: outcome.applied };
      return;
    case 'subsumed':
      return;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/** How a save of queued requests ended (the saver turns it into a
 * PageWriteOutcome). */
export type DraftsOutcome =
  /** Every request applied; the last reply is the page as written. */
  | { readonly tag: 'applied'; readonly last: PageEdited }
  /** A request cannot be planned (no intent form after all): save the whole
   * model instead, against the bytes the applied ones left. */
  | { readonly tag: 'fallback'; readonly base: Digest }
  /** Refused because the file is not what the requests were written against
   * (plan §7): the page is conflicted, and says why. */
  | {
      readonly tag: 'refused';
      readonly reason: RejectionReason;
      readonly diskChecksum: Digest;
      readonly advanced: Digest | undefined;
    }
  /** Could not save now; the unsent requests are queued again. `advanced` is
   * the checksum the applied ones left, when any did. */
  | { readonly tag: 'failed'; readonly message: string; readonly advanced: Digest | undefined };

/** Send requests one at a time, in order. Each is answered before the next
 * goes, so the actor's own commit log rebases the later ones exactly. */
export async function sendDrafts(input: {
  readonly path: string;
  readonly drafts: readonly EditDraft[];
  readonly base: Digest;
  readonly send: (request: EditRequest) => Promise<Result<PageEdited, PageEditError>>;
  /** Where unsent drafts go back to, or turn into whole-model saves. */
  readonly store: EditDrafts;
}): Promise<DraftsOutcome> {
  assert(input.drafts.length > 0, 'A save of requests has requests');
  let last: PageEdited | undefined;
  for (const [index, draft] of input.drafts.entries()) {
    const answer = await input.send({
      pagePath: input.path,
      authoredChecksum: draft.authoredChecksum,
      edit: draft.edit,
    });
    if (answer.ok) {
      recordApplied(draft.record, {
        checksum: answer.value.checksum,
        inverse: answer.value.inverse,
      });
      last = answer.value;
      continue;
    }
    const rest = input.drafts.slice(index);
    const stop = { rest, disk: last?.checksum ?? input.base, advanced: last?.checksum };
    return stopped(answer.error, stop, input.path, input.store);
  }
  assert(last !== undefined, 'Every request applied, so there was a last');
  return { tag: 'applied', last };
}

// The control flow of a save that stopped: which drafts go back to be sent
// again, which a whole-model save carries instead, and what the page is told.
function stopped(
  error: PageEditError,
  stop: {
    readonly rest: readonly EditDraft[];
    readonly disk: Digest;
    readonly advanced: Digest | undefined;
  },
  path: string,
  store: EditDrafts,
): DraftsOutcome {
  const { rest, disk, advanced } = stop;
  const carryWhole = (): void => {
    for (const draft of rest) {
      subsume(draft.record);
    }
    store.markModel(path);
  };
  switch (error.code) {
    case 'rejected':
      carryWhole();
      if (error.reason === 'unsupported-operation') {
        return { tag: 'fallback', base: disk };
      }
      if (error.diskChecksum === undefined) {
        return { tag: 'failed', message: error.message, advanced };
      }
      if (error.diskChecksum === disk) {
        // Nothing changed under the requests: the model is still an edit of
        // exactly these bytes, so the whole-model save is safe.
        return { tag: 'fallback', base: disk };
      }
      return { tag: 'refused', reason: error.reason, diskChecksum: error.diskChecksum, advanced };
    case 'missing':
    case 'filesystem':
    case 'backpressured':
      // Refused before anything was written: safe to send again.
      store.restore(path, rest);
      return { tag: 'failed', message: error.message, advanced };
    case 'write-race':
    case 'uncertain':
      // The write may have landed, or another writer replaced it: sending an
      // insertion again could insert twice. The whole-model save carries
      // these, and its checksum guard turns any surprise into a conflict.
      carryWhole();
      return { tag: 'failed', message: error.message, advanced };
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}
