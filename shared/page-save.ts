// The page save contract (plan §11 step 0). A page read carries the checksum of
// the exact bytes it returned; a write names the checksum it was authored
// against, and main refuses it when the file no longer holds those bytes. That
// refusal is an expected operating failure, so it arrives as a Result value. A
// reply that breaks this shape is a programmer error and throws here.
import { toDigest, type Digest } from './brand';
import { LIMITS } from './limits';
import { parsePageReadResult, type ParsePageResult } from './page-node';
import { toRecord } from './record';
import { err, ok, type Result } from './result';

/** A page as read from (or just written to) disk. */
export type PageDiskRead = ParsePageResult & {
  readonly source: string;
  readonly checksum: Digest;
};

export type PageWriteError =
  | { readonly code: 'conflict'; readonly message: string; readonly diskChecksum: Digest }
  | { readonly code: 'missing'; readonly message: string }
  | { readonly code: 'filesystem'; readonly message: string }
  | { readonly code: 'write-race'; readonly message: string }
  /** The write may have landed; the file's actor could not verify it (§3.5). */
  | { readonly code: 'uncertain'; readonly message: string }
  /** The file's actor queue was full; the edit was never accepted (§7). */
  | { readonly code: 'backpressured'; readonly message: string };

export function parsePageDiskRead(input: unknown): PageDiskRead {
  const page = parsePageReadResult(input);
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('PageDiskRead: expected object');
  }
  return { ...page, checksum: checksumField(record['checksum'], 'PageDiskRead.checksum') };
}

export function parsePageWriteResult(input: unknown): Result<PageDiskRead, PageWriteError> {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('PageWriteResult: expected object');
  }
  if (record['ok'] === true) {
    return ok(parsePageDiskRead(input));
  }
  if (record['ok'] === false) {
    return err(parsePageWriteError(record['error']));
  }
  throw new Error('PageWriteResult.ok: expected boolean');
}

function parsePageWriteError(input: unknown): PageWriteError {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('PageWriteError: expected object');
  }
  const message = record['message'];
  if (typeof message !== 'string') {
    throw new Error('PageWriteError.message: expected string');
  }
  if (message.length > LIMITS.attrCharsMax) {
    throw new Error('PageWriteError.message: exceeds limit');
  }
  const code = record['code'];
  switch (code) {
    case 'conflict':
      return {
        code,
        message,
        diskChecksum: checksumField(record['diskChecksum'], 'PageWriteError.diskChecksum'),
      };
    case 'missing':
    case 'filesystem':
    case 'write-race':
    case 'uncertain':
    case 'backpressured':
      return { code, message };
    default:
      throw new Error('PageWriteError.code: unknown value');
  }
}

function checksumField(input: unknown, where: string): Digest {
  if (typeof input !== 'string') {
    throw new Error(`${where}: expected string`);
  }
  try {
    return toDigest(input);
  } catch (error: unknown) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
