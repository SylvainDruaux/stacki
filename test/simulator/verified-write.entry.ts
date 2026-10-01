// The benches' write stage (spike, baseline, patch): §5.2 steps 8–9 without an
// actor — the atomic replace, then a read-back that the bytes are the ones
// written. Since step 5 the replace also flushes the directory (atomicWrite.ts),
// which the step-3/4 measurements did not, so a re-run's write column is not
// comparable one-to-one with the numbers recorded in the tracker.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { replaceFileAtomic } from '#dist/electron/documents/atomicWrite.js';
import { toDigest, type Digest } from '#dist/shared/core/brand.js';
import { err, ok, type Result } from '#dist/shared/core/result.js';

export interface VerifiedWriteError {
  readonly code: 'filesystem' | 'exists' | 'not-durable' | 'write-race';
  readonly message: string;
}

export function writeVerified(file: string, text: string): Result<Digest, VerifiedWriteError> {
  const bytes = Buffer.from(text, 'utf8');
  const replaced = replaceFileAtomic(file, bytes);
  if (!replaced.ok) {
    return err(replaced.error);
  }
  const expected = createHash('sha256').update(bytes).digest('hex');
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual === expected) {
    return ok(toDigest(actual));
  }
  return err({ code: 'write-race', message: `${file} changed after the write` });
}
