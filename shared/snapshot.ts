// A snapshot: the only source-derived state the engine keeps per file (plan
// §3.1). The exact bytes last read, their checksum, and a disposable projection
// of them. There is no version field — the checksum already answers "which
// file is this?" — and a snapshot is never edited; a new one replaces it.
import { assert } from './assert';
import type { Digest, FilePath } from './brand';
import { LIMITS } from './limits';
import type { Projection } from './source-projection';
import type { ByteString } from './span';

export interface Snapshot {
  readonly path: FilePath;
  /** SHA-256 of `bytes`, computed here from them, never supplied beside them. */
  readonly checksum: Digest;
  /** Retained so a write copies untouched bytes exactly. */
  readonly bytes: ByteString;
  readonly projection: Projection;
}

/** The only constructor. The checksum is computed from the bytes by `hash`
 * (SHA-256 in the actor, `node:crypto` in tests), so a snapshot cannot carry a
 * checksum of other bytes; the projection must describe bytes of this length.
 * The hash is a parameter because shared/ runs in the renderer as well, where
 * `node:crypto` does not exist. */
export function createSnapshot(
  input: Pick<Snapshot, 'path' | 'bytes' | 'projection'>,
  hash: (bytes: ByteString) => Digest,
): Snapshot {
  assert(input.bytes.length <= LIMITS.sourceBytesMax, 'Snapshot bytes are inside the file bound');
  assert(
    input.projection.byteLength === input.bytes.length,
    'The projection was derived from bytes of this length',
  );
  return {
    path: input.path,
    checksum: hash(input.bytes),
    bytes: input.bytes,
    projection: input.projection,
  };
}
