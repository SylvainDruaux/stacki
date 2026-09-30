/*
 * Local UI preferences — kept separate from `storage.ts` (which owns the auth
 * session). One preference remains:
 *   - embedSource: the embed the Style Editor last targeted for new styles
 * Best-effort: any read failure falls back to no preference rather than
 * throwing, so a corrupt value never blocks the app from loading.
 */
import { BOUNDARY_LIMITS } from '../../../shared/boundary';

// The embed the Style Editor last targeted for new custom styles — restored as the
// default so a chosen embed (e.g. a global-CSS embed) sticks across reloads.
const EMBED_SOURCE_KEY = 'moden.embedEditor.source';

/** A stored embed source key, or undefined when absent or not one: storage is
 * shared with every earlier build, so what it holds is parsed like any input.
 * A key names a file or a node, so it is bounded as a path. */
export function parseStoredEmbedSource(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    if (raw.length > 0) {
      return raw.length <= BOUNDARY_LIMITS.pathLengthMax ? raw : undefined;
    }
  }
  return undefined;
}

export function loadEmbedSource(): string | undefined {
  try {
    return parseStoredEmbedSource(localStorage.getItem(EMBED_SOURCE_KEY));
  } catch {
    return undefined;
  }
}

export function saveEmbedSource(key: string | undefined) {
  try {
    if (key) {
      localStorage.setItem(EMBED_SOURCE_KEY, key);
    } else {
      localStorage.removeItem(EMBED_SOURCE_KEY);
    }
  } catch {
    /* noop */
  }
}
