// Disk I/O behind an interface (plan §10). The document actor reads and
// atomically replaces files only through DocumentDisk; the simulator hands it
// this in-memory fake, so no step touches the OS and every interleaving is the
// scheduler's choice. The fake stamps each write with a global generation, which
// is how invariant 7 (never commit an older snapshot over a newer one) is
// checked without trusting the actor's own bookkeeping.
import { assert } from '../../dist/shared/assert.js';
import type { FilePath } from '../../dist/shared/brand.js';
import { err, ok, type Result } from '../../dist/shared/result.js';
import { toByteString, type ByteString } from '../../dist/shared/span.js';

export type DiskError = { readonly code: 'missing' } | { readonly code: 'failed' };

export interface DiskRead {
  readonly bytes: ByteString;
  /** Which write produced these bytes; monotonic across the whole disk. */
  readonly generation: number;
}

export interface DocumentDisk {
  read(path: FilePath): Result<DiskRead, DiskError>;
  /** Atomic replace: readers see the old bytes or the new ones, never a mix. */
  replace(path: FilePath, bytes: ByteString): Result<number, DiskError>;
}

/** Files one simulated project holds. */
export const FAKE_DISK_FILES_MAX = 64;

export class FakeDisk implements DocumentDisk {
  private readonly files = new Map<FilePath, DiskRead>();
  private readonly failing = new Set<FilePath>();
  private generation = 0;

  read(path: FilePath): Result<DiskRead, DiskError> {
    const file = this.files.get(path);
    if (file === undefined) {
      return err({ code: 'missing' });
    }
    assert(file.generation <= this.generation, 'A file generation never runs ahead of the disk');
    return ok(file);
  }

  replace(path: FilePath, bytes: ByteString): Result<number, DiskError> {
    if (this.failing.delete(path)) {
      return err({ code: 'failed' });
    }
    return ok(this.store(path, bytes));
  }

  /** A write by someone other than the actor: an editor, an AI tool, git. */
  writeExternally(path: FilePath, bytes: ByteString): number {
    return this.store(path, bytes);
  }

  /** The next actor replace of `path` fails (disk full, permission). */
  failNextReplace(path: FilePath): void {
    assert(this.files.has(path), 'Only an existing file can be made to fail');
    this.failing.add(path);
  }

  generationOf(path: FilePath): number {
    return this.files.get(path)?.generation ?? 0;
  }

  paths(): readonly FilePath[] {
    return [...this.files.keys()];
  }

  private store(path: FilePath, bytes: ByteString): number {
    if (this.files.has(path)) {
      assert(this.files.size <= FAKE_DISK_FILES_MAX, 'Disk file count stays bounded');
    } else {
      assert(this.files.size < FAKE_DISK_FILES_MAX, 'Disk file count stays bounded');
    }
    this.generation += 1;
    assert(Number.isSafeInteger(this.generation), 'Disk generation stays a safe integer');
    this.files.set(path, { bytes: toByteString(bytes), generation: this.generation });
    return this.generation;
  }
}
