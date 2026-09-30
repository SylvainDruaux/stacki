// The stop hook's memory for one agent session (AGENTS.md §10: its retry loop
// has a stated bound). A stop with failing checks is refused at most
// stopContinuationsMax times for one set of findings. After that the session
// may end, and the same findings — identified by a digest of the report — do
// not start a new round of refusals: an agent that is waiting, or handing a
// known problem back to its human, is not sent in circles. New or changed
// findings start a new round. Passing checks forget everything.
//
// Kept inside the git directory: per clone and per worktree, never tracked,
// never seen by tools that walk the working tree.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../policy/assert.mts';
import { runChild } from '../policy/child.mts';

export interface StopState {
  // Refusals in the current round.
  readonly refusals: number;
  // Digest of the findings a finished round let through, if any.
  readonly releasedDigest: string | undefined;
}

export type StopDecision =
  | { readonly kind: 'refuse'; readonly attempt: number; readonly next: StopState }
  | { readonly kind: 'release'; readonly next: StopState }
  | { readonly kind: 'already-released'; readonly next: StopState };

const EMPTY: StopState = { refusals: 0, releasedDigest: undefined };
const STATE_DIRECTORY = 'stacki-agent';
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REFUSALS_MAX = 1_000;

export function reportDigest(report: string): string {
  return createHash('sha256').update(report).digest('hex');
}

// Pure: what to do with a failing stop, given the stored state.
export function decideStop(state: StopState, digest: string, refusalsMax: number): StopDecision {
  assert(DIGEST.test(digest), 'decideStop: a digest is a sha256 hex string');
  assert(refusalsMax > 0, 'decideStop: at least one refusal is allowed');
  if (state.releasedDigest === digest) {
    return { kind: 'already-released', next: state };
  }
  // Findings that differ from the ones last released start a fresh round.
  const refusals = state.releasedDigest === undefined ? state.refusals + 1 : 1;
  if (refusals <= refusalsMax) {
    return { kind: 'refuse', attempt: refusals, next: { refusals, releasedDigest: undefined } };
  }
  return { kind: 'release', next: { refusals: 0, releasedDigest: digest } };
}

export function readStopState(root: string, sessionId: string): StopState {
  const file = stateFile(root, sessionId);
  if (!fs.existsSync(file)) {
    return EMPTY;
  }
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A corrupt file costs at most one extra round of refusals.
    return EMPTY;
  }
  return parseStopState(input);
}

export function writeStopState(root: string, sessionId: string, state: StopState): void {
  assert(state.refusals >= 0, 'writeStopState: refusals are non-negative');
  assert(state.refusals <= REFUSALS_MAX, 'writeStopState: refusals out of range');
  const file = stateFile(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
  // Paired with readStopState: what was written reads back the same.
  const stored = readStopState(root, sessionId);
  assert(stored.refusals === state.refusals, 'writeStopState: refusals did not persist');
  assert(stored.releasedDigest === state.releasedDigest, 'writeStopState: digest did not persist');
}

export function clearStopState(root: string, sessionId: string): void {
  fs.rmSync(stateFile(root, sessionId), { force: true });
}

export function parseStopState(input: unknown): StopState {
  if (typeof input !== 'object' || input === null) {
    return EMPTY;
  }
  const refusals: unknown = Reflect.get(input, 'refusals');
  const digest: unknown = Reflect.get(input, 'releasedDigest');
  if (typeof refusals !== 'number' || !Number.isSafeInteger(refusals)) {
    return EMPTY;
  }
  if (refusals < 0 || refusals > REFUSALS_MAX) {
    return EMPTY;
  }
  const releasedDigest = typeof digest === 'string' && DIGEST.test(digest) ? digest : undefined;
  return { refusals, releasedDigest };
}

function stateFile(root: string, sessionId: string): string {
  assert(SESSION_ID.test(sessionId), 'stop-state: session id is a safe file name');
  const gitDirectory = runChild('git', ['rev-parse', '--absolute-git-dir'], { cwd: root });
  assert(gitDirectory.status === 0, `stop-state: not a git repository: ${gitDirectory.stderr}`);
  return path.join(gitDirectory.stdout.trim(), STATE_DIRECTORY, `stop-${sessionId}.json`);
}
