// Disk work is bounded before allocating or recursing. These limits leave room
// for large sites while making a pathological project fail near its cause.
import * as fs from 'fs';
import * as path from 'path';
import { assert } from '../shared/assert.js';
import { LIMITS } from '../shared/limits.js';

// The source-file bound lives in shared/limits.ts (plan §8), because the actor,
// the renderer and these readers must all refuse the same file.
export const MAIN_LIMITS = {
  directoryEntriesMax: 100000,
  directoryDepthMax: 64,
  portAttemptsMax: 100,
  fileNameAttemptsMax: 10000,
  previewServersMax: 16,
  styleNudgesMax: 1024,
  logChunkCharsMax: 64000,
} as const;

export function readSource(file: string): string {
  return readSourceBytes(file).toString('utf8');
}

/** The exact bytes of a source file, bounded before and after the read. A
 * checksum must be taken over these bytes, never over decoded text. */
export function readSourceBytes(file: string): Buffer {
  const size = fs.statSync(file).size;
  if (size > LIMITS.sourceBytesMax) {
    throw new Error('Source file exceeds 10 MB limit');
  }
  const bytes = fs.readFileSync(file);
  // A writer may grow the file between stat and read, so check both sides.
  if (bytes.length > LIMITS.sourceBytesMax) {
    throw new Error('Source file exceeds 10 MB limit');
  }
  return bytes;
}

export function directoryBudget(root: string): (directory: string, entries: number) => void {
  // This closure owns the total; nested directory readers cannot reset it.
  let visited = 0;
  return (directory, entries) => {
    assert(Number.isSafeInteger(entries), 'Directory entry count must be an integer');
    assert(entries >= 0, 'Directory entry count must be nonnegative');
    const depth = path.relative(root, directory).split(path.sep).length;
    if (depth > MAIN_LIMITS.directoryDepthMax) {
      throw new Error('Directory depth exceeds limit');
    }
    visited += entries + 1;
    if (visited > MAIN_LIMITS.directoryEntriesMax) {
      throw new Error('Directory entries exceed limit');
    }
  };
}
