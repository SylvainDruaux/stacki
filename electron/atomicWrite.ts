// One write primitive for every file Stacki rewrites in place: pages, chunk
// files, the style re-write, and component-property batches (plan §11 step 0).
//
// Why atomic: a plain writeFileSync truncates the target first, so a crash, a
// full disk or a concurrent reader can observe a half-written page. Here the
// bytes go to a temporary file in the same directory (same filesystem, so the
// rename is atomic), are flushed, and replace the target in one rename. The
// target either holds the old bytes or the new ones, never a mixture.
//
// Why verify: the temporary file is created exclusively (`wx`), so nobody else
// can have written it; its bytes are asserted. The target is shared with every
// other writer on the machine, so a mismatch after the rename is an expected
// failure (`write-race`), not an assertion — no portable API offers
// compare-and-swap on a pathname (plan §5.2).
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../shared/assert';
import { toDigest, type Digest } from '../shared/brand';
import { LIMITS } from '../shared/limits';
import { err, ok, type Result } from '../shared/result';
import { readSourceBytes } from './main.bounds';

export type AtomicWriteError =
  | { readonly code: 'filesystem'; readonly message: string }
  | { readonly code: 'write-race'; readonly message: string };

/** A file's exact bytes decoded as UTF-8, with the checksum of those bytes. */
export interface SourceSnapshot {
  readonly text: string;
  readonly checksum: Digest;
}

const TEMPORARY_PREFIX = '.stacki-write-';
const TEMPORARY_SUFFIX = '.tmp';
/** Permission bits a replacement keeps; file-type bits are not settable. */
const MODE_BITS = 0o7777;

// Strict decoding: invalid UTF-8 is an error, never a lossy replacement, and a
// leading BOM stays in the text so writing the text back reproduces it (§3.2).
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** SHA-256 of the exact bytes, the only constructor of a Digest outside the
 * wire parser. A string is hashed as its UTF-8 encoding. */
export function digestOf(bytes: Buffer | string): Digest {
  return toDigest(createHash('sha256').update(bytes).digest('hex'));
}

/** True for the temporary files this module creates, so the project watcher
 * can ignore them instead of reporting an outside edit. */
export function isAtomicTemporary(name: string): boolean {
  const base = path.basename(name);
  if (base.startsWith(TEMPORARY_PREFIX)) {
    return base.endsWith(TEMPORARY_SUFFIX);
  }
  return false;
}

/** Read a source file as a snapshot. Throws like readSource on missing,
 * oversized or undecodable files — callers already surface those as errors. */
export function readSourceSnapshot(file: string): SourceSnapshot {
  const bytes = readSourceBytes(file);
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new Error(`${path.basename(file)} is not valid UTF-8`);
  }
  const checksum = digestOf(bytes);
  // Strict decoding is lossless, so the text re-encodes to the bytes it came
  // from; the checksum therefore names the text as well as the file.
  assert(digestOf(text) === checksum, 'Decoded source re-encodes to the bytes read');
  return { text, checksum };
}

/** Replace `file` with `text` atomically and return the checksum on disk. */
export function writeFileAtomic(file: string, text: string): Result<Digest, AtomicWriteError> {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > LIMITS.sourceBytesMax) {
    return err({ code: 'filesystem', message: `${file} would exceed the 10 MB source limit` });
  }
  const expected = digestOf(bytes);
  const target = resolveTarget(file);
  if (!target.ok) {
    return target;
  }
  const temporary = path.join(
    path.dirname(target.value.path),
    `${TEMPORARY_PREFIX}${randomUUID()}${TEMPORARY_SUFFIX}`,
  );
  const staged = stageTemporary(temporary, bytes, target.value.mode);
  if (!staged.ok) {
    return discardTemporary(temporary, file, staged.error.message);
  }
  // Created exclusively above: nobody else can have written these bytes.
  assert(digestOf(fs.readFileSync(temporary)) === expected, 'Temporary file holds planned bytes');
  try {
    fs.renameSync(temporary, target.value.path);
  } catch (error: unknown) {
    return discardTemporary(temporary, file, errorMessage(error));
  }
  return verifyTarget(target.value.path, expected);
}

interface WriteTarget {
  readonly path: string;
  /** Permission bits to keep, or undefined for a new file. */
  readonly mode: number | undefined;
}

// A symlinked page is written through to the file it names; renaming over the
// link itself would silently turn it into a regular file.
function resolveTarget(file: string): Result<WriteTarget, AtomicWriteError> {
  try {
    const real = fs.realpathSync(file);
    return ok({ path: real, mode: fs.statSync(real).mode & MODE_BITS });
  } catch (error: unknown) {
    if (isMissing(error)) {
      return ok({ path: path.resolve(file), mode: undefined });
    }
    return err({ code: 'filesystem', message: errorMessage(error) });
  }
}

function stageTemporary(
  temporary: string,
  bytes: Buffer,
  mode: number | undefined,
): Result<void, AtomicWriteError> {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode ?? 0o666);
    if (mode !== undefined) {
      // The umask applied at open time must not narrow the file's permissions.
      fs.fchmodSync(descriptor, mode);
    }
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error: unknown) {
    return err({ code: 'filesystem', message: errorMessage(error) });
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
  return ok(undefined);
}

function verifyTarget(target: string, expected: Digest): Result<Digest, AtomicWriteError> {
  let actual: Digest;
  try {
    actual = digestOf(readSourceBytes(target));
  } catch (error: unknown) {
    return err({
      code: 'write-race',
      message: `${target} vanished after writing: ${errorMessage(error)}`,
    });
  }
  if (actual === expected) {
    return ok(actual);
  }
  return err({
    code: 'write-race',
    message: `${target} was changed by another writer during the save`,
  });
}

function discardTemporary(
  temporary: string,
  file: string,
  reason: string,
): Result<never, AtomicWriteError> {
  try {
    fs.rmSync(temporary, { force: true });
  } catch (error: unknown) {
    return err({
      code: 'filesystem',
      message:
        `Could not save ${file} or remove temporary file ${temporary}: ` +
        `${reason}; ${errorMessage(error)}`,
    });
  }
  return err({ code: 'filesystem', message: `Could not save ${file}: ${reason}` });
}

export function isMissing(error: unknown): boolean {
  if (error instanceof Error) {
    if ('code' in error) {
      return error.code === 'ENOENT';
    }
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
