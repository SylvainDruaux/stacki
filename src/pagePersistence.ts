// Serialize page writes and drain edits made while a write is pending. A
// write acknowledges its exact state object, never a newer edit or another
// file. Every write names the checksum it was authored against, and a refusal
// (the file changed on disk) stops autosave instead of retrying (plan §7).

import { assert } from '../shared/assert';
import type { Digest } from '../shared/brand';
import type { RejectionReason } from '../shared/intent';
import { LIMITS } from '../shared/limits';
import type { ScanResult } from '../shared/scan';
import {
  saveStateBase,
  saveStateFailed,
  saveStateNeedsWrite,
  saveStateStarted,
  type SaveState,
} from './saveState';

/** The page state as the saver needs it: an object whose identity is the ack
 * token, carrying its save state. */
interface PageStateHandle {
  readonly save: SaveState;
}

interface CurrentSnapshot<State extends PageStateHandle> {
  readonly currentPage?: { readonly path?: string | undefined } | null;
  readonly pageState?: State | null;
}

/** What one write did. Failures other than a conflict reject the promise,
 * except `advanced`: some of the edits reached disk through the app's own
 * writes (step 6, edit requests go one at a time) and the rest did not. The
 * disk now holds `checksum`, which later writes must name as their base, and
 * the error is reported like any other failure. */
export type PageWriteOutcome<State> =
  | { readonly tag: 'written'; readonly state: State; readonly checksum: Digest }
  | {
      readonly tag: 'conflict';
      readonly diskChecksum: Digest;
      /** Why an edit request was refused; absent for a whole-model save. */
      readonly reason?: RejectionReason;
      /** The base the refusal compared, when not the one the write named: a
       * code save refused for typing that cannot merge with what the app's
       * own last save left (src/codeEdits.ts). */
      readonly baseChecksum?: Digest;
    }
  | { readonly tag: 'advanced'; readonly checksum: Digest; readonly error: Error };

interface PageSaverDeps<State extends PageStateHandle> {
  readonly readCurrent: () => CurrentSnapshot<State>;
  readonly write: (
    path: string,
    pageState: State,
    baseChecksum: Digest,
  ) => Promise<PageWriteOutcome<State>>;
  /** A copy of `pageState` with another save state; identity is the ack token. */
  readonly withSave: (pageState: State, save: SaveState) => State;
  /** Install `next` if `previous` is still the current page state. */
  readonly replace: (previous: State, next: State) => void;
  /** The file refused a write: mark whatever state is current as conflicted,
   * with the actor's reason when an edit request was refused. */
  readonly markConflicted: (
    baseChecksum: Digest,
    diskChecksum: Digest,
    reason: RejectionReason | undefined,
  ) => void;
}

/** Where a flush left the page: its edits are on disk (or there were none), or
 * a refused save is holding them back until the user decides (plan §7). */
export type FlushOutcome = 'settled' | 'conflicted';

export interface PageSaver {
  readonly flush: () => Promise<FlushOutcome>;
  /** The checksum a write of this save state must name right now. */
  readonly baseFor: (path: string, save: SaveState) => Digest;
  /** True while a write is on its way to disk; its outcome is authoritative. */
  readonly writing: () => boolean;
}

interface Acknowledgement<State> {
  readonly outcome: PageWriteOutcome<State>;
  readonly baseChecksum: Digest;
  /** The state written and the `saving` copy published for it. */
  readonly copies: readonly State[];
}

// Why a base can advance: every unsaved state keeps the base of the clean
// state it grew from. While the user types through a save, the next state is
// still based on the bytes before that save, yet the disk now holds the bytes
// the saver itself wrote. `lineage` records that one step — "states based on
// `from` are now based on `to`" — so the app never conflicts with itself.
interface Lineage {
  readonly path: string;
  readonly from: Digest;
  readonly to: Digest;
}

export function createPageSaver<State extends PageStateHandle>(
  deps: PageSaverDeps<State>,
): PageSaver {
  const saver = new SerialPageSaver(deps);
  let pending: Promise<unknown> = Promise.resolve();
  return {
    flush: () => {
      const result = pending.then(() => saver.flush());
      // A failed save is reported to its caller and leaves future saves usable.
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    baseFor: (path, save) => saver.baseFor(path, save),
    writing: () => saver.writing(),
  };
}

// One flush at a time (createPageSaver chains them); this class owns the
// state that must survive between flushes and never hands it out.
class SerialPageSaver<State extends PageStateHandle> {
  readonly #deps: PageSaverDeps<State>;
  readonly #acknowledged = new WeakMap<State, Acknowledgement<State>>();
  #lineage: Lineage | undefined;
  #inFlight = false;

  constructor(deps: PageSaverDeps<State>) {
    this.#deps = deps;
  }

  writing(): boolean {
    return this.#inFlight;
  }

  baseFor(path: string, save: SaveState): Digest {
    assert(save.tag !== 'clean', 'A clean page state has nothing to write');
    const lineage = this.#lineage;
    if (lineage !== undefined && lineage.path === path && lineage.from === save.baseChecksum) {
      return lineage.to;
    }
    return save.baseChecksum;
  }

  async flush(): Promise<FlushOutcome> {
    const path = this.#deps.readCurrent().currentPage?.path;
    if (!path) {
      return 'settled';
    }
    // Each pass past the first needs a strictly newer edit; hitting the cap
    // means edits arrive faster than writes can ever drain — a bug.
    for (let drain = 0; drain < LIMITS.saveDrainMax; drain++) {
      const { currentPage, pageState } = this.#deps.readCurrent();
      if (currentPage?.path !== path || !pageState) {
        return 'settled';
      }
      let acknowledgement = this.#acknowledged.get(pageState);
      if (acknowledgement === undefined) {
        if (pageState.save.tag === 'clean') {
          this.#lineage = undefined; // every later edit grows from this checksum
          return 'settled';
        }
        if (pageState.save.tag === 'conflicted') {
          return 'conflicted'; // autosave stays off until the user decides (plan §7)
        }
        assert(saveStateNeedsWrite(pageState.save), 'Only a dirty page state is written');
        acknowledgement = await this.#write(path, pageState);
      }
      this.#settle(acknowledgement);
      if (acknowledgement.outcome.tag === 'conflict') {
        return 'conflicted';
      }
      // The ref updates on render; until then it still shows a copy just settled.
      const latest = this.#deps.readCurrent().pageState;
      if (!latest || acknowledgement.copies.includes(latest)) {
        return 'settled';
      }
    }
    throw new Error(`save drain exceeded ${LIMITS.saveDrainMax} passes for ${path}`);
  }

  async #write(path: string, pageState: State): Promise<Acknowledgement<State>> {
    const baseChecksum = this.baseFor(path, pageState.save);
    const saving = this.#deps.withSave(pageState, saveStateStarted(pageState.save));
    this.#deps.replace(pageState, saving);
    this.#inFlight = true;
    let outcome: PageWriteOutcome<State>;
    try {
      outcome = await this.#deps.write(path, pageState, baseChecksum);
    } catch (error: unknown) {
      // Back to unsaved; if a newer edit superseded the copy, it already is.
      this.#deps.replace(saving, this.#deps.withSave(saving, saveStateFailed(saving.save)));
      throw error;
    } finally {
      this.#inFlight = false;
    }
    if (outcome.tag === 'advanced') {
      // Part of the edit reached disk through our own writes: later states
      // are based on those bytes, and the rest stays unsaved (dirty).
      this.#lineage = { path, from: saveStateBase(pageState.save), to: outcome.checksum };
      this.#deps.replace(saving, this.#deps.withSave(saving, saveStateFailed(saving.save)));
      throw outcome.error;
    }
    if (outcome.tag === 'written') {
      const written = outcome.state.save;
      assert(written.tag === 'clean', 'A written page state is clean');
      assert(written.checksum === outcome.checksum, 'A written state carries the written checksum');
      this.#lineage = { path, from: saveStateBase(pageState.save), to: outcome.checksum };
    }
    const acknowledgement = { outcome, baseChecksum, copies: [pageState, saving] };
    this.#acknowledged.set(pageState, acknowledgement);
    this.#acknowledged.set(saving, acknowledgement);
    return acknowledgement;
  }

  #settle(acknowledgement: Acknowledgement<State>): void {
    const { outcome } = acknowledgement;
    if (outcome.tag === 'conflict') {
      const { diskChecksum, reason } = outcome;
      const base = outcome.baseChecksum ?? acknowledgement.baseChecksum;
      this.#deps.markConflicted(base, diskChecksum, reason);
      return;
    }
    assert(outcome.tag === 'written', 'Only a written or refused save is acknowledged');
    for (const copy of acknowledgement.copies) {
      this.#deps.replace(copy, outcome.state);
    }
  }
}

export function scanContainsFile(scan: ScanResult | null | undefined, path: string): boolean {
  return (['pages', 'components', 'layouts'] as const).some((kind) =>
    scan?.[kind]?.some((entry) => entry.path === path),
  );
}

// Each code window destination owns its debounce. Typing in a second file must
// never cancel the first file's pending write. Writes to one file stay ordered.

type WriteFn = () => unknown;

interface WaitingEntry {
  readonly write: WriteFn;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

interface FileSaverDeps {
  readonly delay?: number;
  readonly onError?: (error: unknown) => void;
}

export function createFileSaver({ delay = 300, onError = () => {} }: FileSaverDeps = {}): {
  schedule(key: string, write: WriteFn): void;
  flush(): Promise<void>;
} {
  const waiting = new Map<string, WaitingEntry>();
  const running = new Map<string, Promise<unknown>>();
  const start = (key: string): Promise<unknown> => {
    const entry = waiting.get(key);
    if (!entry) {
      return running.get(key) || Promise.resolve();
    }
    waiting.delete(key);
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    const result: Promise<unknown> = (running.get(key) || Promise.resolve()).catch(() => {}).then(() => entry.write());
    running.set(key, result);
    result.then(
      () => {
        if (running.get(key) === result) {
          running.delete(key);
        }
      },
      (error: unknown) => {
        if (running.get(key) === result) {
          running.delete(key);
          if (!waiting.has(key)) {
            waiting.set(key, { write: entry.write, timer: null });
          }
        }
        onError(error);
      },
    );
    return result;
  };
  return {
    schedule(key: string, write: WriteFn): void {
      const pending = waiting.get(key);
      if (pending?.timer != null) {
        clearTimeout(pending.timer);
      }
      waiting.set(key, {
        write,
        timer: setTimeout(() => {
          void start(key).catch(() => {});
        }, delay),
      });
    },
    async flush(): Promise<void> {
      let drain = 0;
      do {
        drain += 1;
        // Same convergence argument as createPageSaver's flush.
        if (drain > LIMITS.saveDrainMax) {
          throw new Error(`file-saver flush exceeded ${LIMITS.saveDrainMax} passes`);
        }
        for (const key of waiting.keys()) {
          start(key);
        }
        await Promise.all(running.values());
      } while (waiting.size);
    },
  };
}
