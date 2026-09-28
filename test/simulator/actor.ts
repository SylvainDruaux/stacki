// The step-1 document actor, as pure steps (plan §5.2, §10). One actor per
// file. Each call does one unit of the write protocol and returns the next
// state plus what happened; the scheduler decides what runs between two
// steps, so an external write can land between the plan and the write, or
// between the write and the verifying read — exactly the races §5.2 guards.
//
//   idle    → read, refresh the snapshot, plan, verify witnesses, apply in
//             memory, re-parse the candidate           (§5.2 steps 1–6)
//   planned → re-read, re-verify, atomic replace       (§5.2 steps 7–8)
//   written → re-read, verify the checksum, commit     (§5.2 steps 9–10)
//
// The shipping actor (step 5) replaces this one and must keep the same
// invariants. No timers, no promises, no OS: the disk is an interface.
//
// From step 3 an intent is queued with the snapshot it was authored against
// (a Submission), because the step-2 planner maps a stale intent from those
// bytes (PlanningBase.authored). The actor cannot keep them itself: its own
// snapshot bound, LIMITS.snapshotsRetainedMax (2), is spent on the current
// snapshot and the in-flight candidate. Carrying them is one answer to the
// open `lastKnownBytes` question, not the decision — step 5 decides.
import { assert } from '../../dist/shared/assert.js';
import type { FilePath } from '../../dist/shared/brand.js';
import type {
  Intent,
  Outcome,
  RejectionReason,
  SubmissionResult,
} from '../../dist/shared/intent.js';
import { LIMITS } from '../../dist/shared/limits.js';
import type { Plan, PlanningBase } from '../../dist/shared/planner.js';
import type { Result } from '../../dist/shared/result.js';
import type { Snapshot } from '../../dist/shared/snapshot.js';
import type { DocumentDisk } from './fake-disk.ts';
import { sha256, snapshotOf } from './project.ts';
import { applySplices, changedRanges, witnessesHold } from './splice.ts';

export type Planner = (base: PlanningBase, intent: Intent) => Result<Plan, RejectionReason>;

/** A queued intent and the snapshot it was authored against. */
export interface Submission {
  readonly intent: Intent;
  readonly authored: Snapshot;
}

/** An intent between planning and commit, with everything the next step needs. */
interface InFlight {
  readonly intent: Intent;
  readonly base: Snapshot;
  readonly plan: Plan;
  readonly candidate: Snapshot;
}

export type ActorPhase =
  | { readonly tag: 'idle' }
  | ({ readonly tag: 'planned' } & InFlight)
  | ({ readonly tag: 'written' } & InFlight);

/** The watcher is a hint (plan §2): it only says "read again before trusting". */
export type WatcherHint = 'clean' | 'dirty';

export interface ActorState {
  readonly path: FilePath;
  readonly snapshot: Snapshot | undefined;
  /** Disk generation the snapshot was read at (FakeDisk stamps every write). */
  readonly generation: number;
  readonly queue: readonly Submission[];
  readonly phase: ActorPhase;
  readonly hint: WatcherHint;
}

export type ActorEffect =
  | { readonly tag: 'outcome'; readonly outcome: Outcome }
  | ({ readonly tag: 'committed'; readonly previousGeneration: number; readonly generation: number } & InFlight)
  | { readonly tag: 'refreshed'; readonly previousGeneration: number; readonly generation: number };

export interface ActorStep {
  readonly state: ActorState;
  readonly effects: readonly ActorEffect[];
  /** Parses this step ran — bounded by LIMITS.parseTasksInFlightMax. */
  readonly parses: number;
}

export function createActor(path: FilePath): ActorState {
  return { path, snapshot: undefined, generation: 0, queue: [], phase: { tag: 'idle' }, hint: 'dirty' };
}

/** Accept the intent or push back: a full queue is backpressure, not rejection. */
export function submitIntent(
  state: ActorState,
  submission: Submission,
): { readonly state: ActorState; readonly result: SubmissionResult } {
  const intent = submission.intent;
  assert(intent.file === state.path, 'An intent is submitted to its own file actor');
  assert(submission.authored.path === intent.file, 'The authored snapshot is of the intent file');
  assert(
    submission.authored.checksum === intent.authoredChecksum,
    'The authored snapshot is the one the intent names',
  );
  assert(state.queue.length <= LIMITS.intentsPendingMax, 'The queue never exceeds its bound');
  if (state.queue.length < LIMITS.intentsPendingMax) {
    const next = { ...state, queue: [...state.queue, submission] };
    return { state: next, result: { tag: 'accepted', intentId: intent.id } };
  }
  return { state, result: { tag: 'backpressured' } };
}

/** Whether a step would do anything: in-flight work, queued work, or a hint. */
export function actorHasWork(state: ActorState): boolean {
  if (state.phase.tag === 'idle') {
    return state.queue.length > 0 ? true : state.hint === 'dirty';
  }
  return true;
}

export function markDirty(state: ActorState): ActorState {
  return { ...state, hint: 'dirty' };
}

export function stepActor(state: ActorState, disk: DocumentDisk, planner: Planner): ActorStep {
  const phase = state.phase;
  switch (phase.tag) {
    case 'idle':
      return stepIdle(state, disk, planner);
    case 'planned':
      return stepPlanned(state, phase, disk);
    case 'written':
      return stepWritten(state, phase, disk);
    default: {
      const exhaustive: never = phase;
      throw new Error(`Unknown actor phase ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A crash (plan §3.5): the in-flight intent becomes `uncertain` with its
 * candidate checksum; queued intents were never planned and become `uncertain`
 * without one. The restarted actor knows nothing and re-reads from disk. */
export function crashActor(state: ActorState): ActorStep {
  const effects: ActorEffect[] = [];
  const phase = state.phase;
  if (phase.tag !== 'idle') {
    const outcome: Outcome = {
      tag: 'uncertain',
      intentId: phase.intent.id,
      candidateChecksum: phase.candidate.checksum,
    };
    effects.push({ tag: 'outcome', outcome });
  }
  for (const { intent } of state.queue) {
    const outcome: Outcome = { tag: 'uncertain', intentId: intent.id, candidateChecksum: undefined };
    effects.push({ tag: 'outcome', outcome });
  }
  assert(effects.length <= LIMITS.intentsPendingMax + 1, 'A crash reports at most the queue');
  return { state: createActor(state.path), effects, parses: 0 };
}

// Read the disk and adopt its bytes as the snapshot when they changed. The
// generation check is invariant 7 on the producer side: a read never goes back.
function refresh(state: ActorState, disk: DocumentDisk): { state: ActorState; step: ActorStep } | RejectionReason {
  const read = disk.read(state.path);
  if (!read.ok) {
    return 'write-failed';
  }
  assert(read.value.generation >= state.generation, 'A disk read never returns an older generation');
  const checksum = sha256(read.value.bytes);
  if (state.snapshot !== undefined) {
    if (state.snapshot.checksum === checksum) {
      const next = { ...state, generation: read.value.generation, hint: 'clean' as const };
      return { state: next, step: { state: next, effects: [], parses: 0 } };
    }
  }
  const snapshot = snapshotOf(state.path, read.value.bytes);
  const next = { ...state, snapshot, generation: read.value.generation, hint: 'clean' as const };
  const effect: ActorEffect = {
    tag: 'refreshed',
    previousGeneration: state.generation,
    generation: read.value.generation,
  };
  return { state: next, step: { state: next, effects: [effect], parses: 1 } };
}

function stepIdle(state: ActorState, disk: DocumentDisk, planner: Planner): ActorStep {
  const refreshed = refresh(state, disk);
  const [submission, ...rest] = state.queue;
  if (submission === undefined) {
    return typeof refreshed === 'string' ? { state, effects: [], parses: 0 } : refreshed.step;
  }
  const { intent, authored } = submission;
  if (typeof refreshed === 'string') {
    return reject({ ...state, queue: rest }, intent, refreshed, 0);
  }
  const current = { ...refreshed.state, queue: rest };
  const base = current.snapshot;
  assert(base !== undefined, 'A successful refresh leaves a snapshot');
  const parses = refreshed.step.parses;
  const planned = planner({ authored, current: base }, intent);
  if (!planned.ok) {
    return reject(current, intent, planned.error, parses, refreshed.step.effects);
  }
  const plan = planned.value;
  if (plan.splices.length > LIMITS.splicesPerIntentMax) {
    return reject(current, intent, 'resource-limit', parses, refreshed.step.effects);
  }
  if (!witnessesHold(base.bytes, plan.splices)) {
    return reject(current, intent, 'region-externally-modified', parses, refreshed.step.effects);
  }
  const bytes = applySplices(base.bytes, plan.splices);
  if (bytes.length > LIMITS.sourceBytesMax) {
    return reject(current, intent, 'resource-limit', parses, refreshed.step.effects);
  }
  const candidate = snapshotOf(state.path, bytes);
  if (plan.candidate === 'must-parse') {
    if (candidate.projection.tag === 'parse-error') {
      return reject(current, intent, 'source-invalid', parses + 1, refreshed.step.effects);
    }
    assertPostKinds(candidate, plan);
  }
  const phase: ActorPhase = { tag: 'planned', intent, base, plan, candidate };
  return { state: { ...current, phase }, effects: refreshed.step.effects, parses: parses + 1 };
}

// The target keeps its expected kind (§5.2 step 6). A planner that produced a
// candidate where it does not is broken, so this asserts rather than rejects.
function assertPostKinds(candidate: Snapshot, plan: Plan): void {
  const projection = candidate.projection;
  assert(projection.tag === 'valid', 'Post-kinds are checked on a parsing candidate');
  for (const expected of plan.postKinds) {
    const found = projection.nodes.find(
      (node) =>
        node.path.length === expected.path.length &&
        node.path.every((step, index) => step === expected.path[index]),
    );
    assert(found !== undefined, 'The planned target still exists in the candidate');
    assert(found.kind === expected.kind, 'The planned target keeps its expected kind');
  }
}

function stepPlanned(state: ActorState, phase: Extract<ActorPhase, { tag: 'planned' }>, disk: DocumentDisk): ActorStep {
  const idle = { ...state, phase: { tag: 'idle' as const } };
  const read = disk.read(state.path);
  if (!read.ok) {
    return reject(idle, phase.intent, 'write-failed', 0);
  }
  // Re-read before writing (§5.2 step 7): the snapshot may be stale by now.
  // Step 1 does not re-plan against new bytes; later steps map instead.
  if (sha256(read.value.bytes) !== phase.base.checksum) {
    return reject({ ...idle, hint: 'dirty' }, phase.intent, 'region-externally-modified', 0);
  }
  assert(witnessesHold(read.value.bytes, phase.plan.splices), 'Witnesses hold on re-read bytes');
  const written = disk.replace(state.path, phase.candidate.bytes);
  if (!written.ok) {
    return reject({ ...idle, hint: 'dirty' }, phase.intent, 'write-failed', 0);
  }
  return { state: { ...state, phase: { ...phase, tag: 'written' } }, effects: [], parses: 0 };
}

function stepWritten(state: ActorState, phase: Extract<ActorPhase, { tag: 'written' }>, disk: DocumentDisk): ActorStep {
  const idle = { ...state, phase: { tag: 'idle' as const } };
  const read = disk.read(state.path);
  if (!read.ok) {
    return reject({ ...idle, hint: 'dirty' }, phase.intent, 'write-race', 0);
  }
  // Verify (§5.2 step 9): anything but the candidate means another writer won.
  if (sha256(read.value.bytes) !== phase.candidate.checksum) {
    return reject({ ...idle, hint: 'dirty' }, phase.intent, 'write-race', 0);
  }
  assert(read.value.generation >= state.generation, 'The commit never adopts an older generation');
  const committed: ActorState = { ...idle, snapshot: phase.candidate, generation: read.value.generation };
  const outcome: Outcome = {
    tag: 'applied',
    intentId: phase.intent.id,
    changedRanges: changedRanges(phase.plan.splices),
    checksum: phase.candidate.checksum,
  };
  const commit: ActorEffect = {
    tag: 'committed',
    previousGeneration: state.generation,
    generation: read.value.generation,
    intent: phase.intent,
    base: phase.base,
    plan: phase.plan,
    candidate: phase.candidate,
  };
  return { state: committed, effects: [commit, { tag: 'outcome', outcome }], parses: 0 };
}

function reject(
  state: ActorState,
  intent: Intent,
  reason: RejectionReason,
  parses: number,
  earlier: readonly ActorEffect[] = [],
): ActorStep {
  assert(parses <= LIMITS.parseTasksInFlightMax, 'A step runs at most the parse bound');
  const outcome: Outcome = { tag: 'rejected', intentId: intent.id, reason };
  return { state, effects: [...earlier, { tag: 'outcome', outcome }], parses };
}
