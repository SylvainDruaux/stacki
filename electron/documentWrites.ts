// The one document host of the main process, and the entry points every module
// uses to write project text (plan §3.3, §5.2: one writer per file). main.ts
// installs the host at startup with its telemetry log and the watcher's
// self-write note; modules that are also loaded without main (tests, the CSS
// variable tools) get a quiet default host, so their writes still go through
// actors. The app loads main once. The test harness loads it several times in
// one process, so a later install replaces an earlier host — only while that
// host holds no intent: hosts run each intent to its outcome synchronously, so
// a replaced host has nothing in flight, and the lock file and the re-read
// under it (documentDisk.ts) still serialize any two actors of one file.
import { assert } from '../shared/assert';
import type { Digest } from '../shared/brand';
import { createNodeDocumentActors, type DocumentActors, type WriteReport } from './documentActors';

interface DocumentHost {
  readonly documents: DocumentActors;
  readonly noteWrite: (file: string, text: string | null) => void;
}

// The module's single piece of state: the process's host, set once.
let installed: DocumentHost | undefined;

/** Install the process's document host (see the header on replacing one). */
export function installDocumentHost(host: DocumentHost): void {
  if (installed !== undefined) {
    assert(installed.documents.quiescent(), 'A document host is replaced only when idle');
  }
  installed = host;
}

export function documentHost(): DocumentHost {
  installed ??= {
    documents: createNodeDocumentActors({ log: () => {}, schedule: (task) => setImmediate(task) }),
    noteWrite: () => {},
  };
  return installed;
}

/** Write project text that no edit named a base for, through its actor: the
 * witness is the file as it is now, a missing file is created, and anything
 * but `applied` throws like the `fs.writeFileSync` it replaces did. */
export function writeProjectText(file: string, text: string): Digest {
  const host = documentHost();
  host.noteWrite(file, text);
  const report = host.documents.writeCurrent(file, text);
  if (report.tag === 'applied') {
    return report.checksum;
  }
  throw new Error(describeWriteReport(file, report));
}

/** Create a new project file through its actor; never overwrites. */
export function createProjectText(file: string, text: string): Digest {
  const host = documentHost();
  host.noteWrite(file, text);
  const created = host.documents.create(file, text);
  if (created.ok) {
    return created.value;
  }
  throw new Error(created.error.message);
}

/** A user-facing sentence for a write that did not apply. */
export function describeWriteReport(
  file: string,
  report: Exclude<WriteReport, { readonly tag: 'applied' }>,
): string {
  switch (report.tag) {
    case 'rejected':
      return report.message === '' ? `Could not save ${file} (${report.reason}).` : report.message;
    case 'uncertain':
      return `${file} may not have been saved: ${report.message}`;
    case 'backpressured':
      return `${file} has too many saves waiting; the edit was kept, save again.`;
    default: {
      const exhaustive: never = report;
      return exhaustive;
    }
  }
}
