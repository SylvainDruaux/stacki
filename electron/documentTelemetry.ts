// Is the wall holding? (plan §9a.) One counter and one structured log line per
// terminal outcome, backpressured submission and leaked lock. The
// rejection distribution is the production signal for everything the
// simulator's corpus cannot cover; the counts are read from the log.
//
// Privacy: a line names the file only by a hash of its path — raw paths leak
// usernames — and never carries source bytes, disk error text or intent
// payloads. No pipeline, no dashboard, no dependency.
import { createHash } from 'node:crypto';
import { assert } from '../shared/assert';
import type { FilePath, IntentId } from '../shared/brand';
import { REJECTION_REASONS, type Outcome, type RejectionReason } from '../shared/intent';

/** What one line records. (The step-0 save guard's `conflict` went with the
 * last whole-file save at step 10: a stale edit is an outcome, `rejected`.) */
export type TelemetryEvent =
  | { readonly tag: 'outcome'; readonly outcome: Outcome }
  | { readonly tag: 'backpressured' }
  /** An actor could not release its lock (documentDisk.ts breaks it later). */
  | { readonly tag: 'lock-leaked' };

export interface TelemetryCounts {
  readonly applied: number;
  readonly uncertain: number;
  readonly backpressured: number;
  readonly lockLeaked: number;
  readonly rejected: Readonly<Record<RejectionReason, number>>;
}

export interface DocumentTelemetry {
  record(file: FilePath, event: TelemetryEvent): void;
  counts(): TelemetryCounts;
}

/** Hex characters of the path hash a line carries: enough to tell files apart
 * in one log, too few to be worth brute-forcing beyond a guessed path. */
const PATH_HASH_CHARS = 16;
/** The event name every line starts with, for grepping a log. */
export const TELEMETRY_EVENT = 'stacki.document';

export function createDocumentTelemetry(log: (line: string) => void): DocumentTelemetry {
  // The one mutable state of this module: counts owned by this closure.
  const rejected = Object.fromEntries(REJECTION_REASONS.map((reason) => [reason, 0]));
  const totals: Totals = { applied: 0, uncertain: 0, backpressured: 0, lockLeaked: 0 };
  return {
    record(file, event) {
      const line = countEvent(event, totals, rejected);
      log(JSON.stringify({ event: TELEMETRY_EVENT, file: hashPath(file), ...line }));
    },
    counts() {
      const copy: Record<string, number> = { ...rejected };
      return { ...totals, rejected: rejectionCounts(copy) };
    },
  };
}

export function hashPath(file: string): string {
  return createHash('sha256').update(file).digest('hex').slice(0, PATH_HASH_CHARS);
}

/** The counters other than rejections, owned by one telemetry closure. */
interface Totals {
  applied: number;
  uncertain: number;
  backpressured: number;
  lockLeaked: number;
}

interface Line {
  readonly intent?: IntentId;
  readonly outcome: string;
  readonly reason?: RejectionReason;
  readonly count: number;
}

// Push the ifs up: every counter moves here, and the line reports its total.
function countEvent(event: TelemetryEvent, totals: Totals, rejected: Record<string, number>): Line {
  switch (event.tag) {
    case 'backpressured':
      totals.backpressured += 1;
      return { outcome: 'backpressured', count: totals.backpressured };
    case 'lock-leaked':
      totals.lockLeaked += 1;
      return { outcome: 'lock-leaked', count: totals.lockLeaked };
    case 'outcome':
      return countOutcome(event.outcome, totals, rejected);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function countOutcome(outcome: Outcome, totals: Totals, rejected: Record<string, number>): Line {
  const intent = outcome.intentId;
  switch (outcome.tag) {
    case 'applied':
      totals.applied += 1;
      return { intent, outcome: 'applied', count: totals.applied };
    case 'uncertain':
      totals.uncertain += 1;
      return { intent, outcome: 'uncertain', count: totals.uncertain };
    case 'rejected': {
      const count = (rejected[outcome.reason] ?? 0) + 1;
      rejected[outcome.reason] = count;
      return { intent, outcome: 'rejected', reason: outcome.reason, count };
    }
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// Written out, not built from the list: a new reason is a compile error here.
function rejectionCounts(input: Record<string, number>): Record<RejectionReason, number> {
  const count = (reason: RejectionReason): number => {
    const value = input[reason];
    assert(value !== undefined, 'Every rejection reason has a counter');
    assert(Number.isSafeInteger(value), 'A counter is a count');
    return value;
  };
  return {
    'anchor-moved': count('anchor-moved'),
    'anchor-ambiguous': count('anchor-ambiguous'),
    'region-externally-modified': count('region-externally-modified'),
    'source-invalid': count('source-invalid'),
    'unsupported-operation': count('unsupported-operation'),
    'resource-limit': count('resource-limit'),
    'write-failed': count('write-failed'),
    'write-race': count('write-race'),
    'merge-conflict': count('merge-conflict'),
  };
}
