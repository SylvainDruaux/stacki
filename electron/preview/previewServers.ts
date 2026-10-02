// Preview servers for a past commit: each runs in its own worktree, and
// stopping one removes the worktree with it.

import type { PreviewServer } from '../lib/mainTypes';
import * as previewWorktree from './previewWorktree';
import { git, stopProcessTree } from '../lib/nodeTools';

// --- Previewing an old version ---------------------------------------------
//
// A second, deliberately dumb dev server pointed at a checkout of an old
// commit (see previewWorktree.js). None of the primary server's machinery
// applies: a preview is read-only, so it needs no markers, no morph client and
// no click-to-select — it only has to render. That is `bare` on spawnDevServer,
// which already exists as the primary server's last-resort path.
//
// Kept in its own registry rather than generalising `DevServers`, whose daemon
// detection, external-server adoption and log plumbing are all keyed to there
// being exactly one. Keyed by project path.
export const previewServers = new Map<string, PreviewServer>();

export async function stopPreview(projectPath: string) {
  const current = previewServers.get(projectPath);
  if (!current) {
    return;
  }
  previewServers.delete(projectPath);
  stopProcessTree(current.proc);
  try {
    await previewWorktree.removeWorktree(git, { projectPath });
  } catch {
    /* the checkout is disposable; nothing here is the user's work */
  }
}

export function stopAllPreviews() {
  for (const [projectPath] of previewServers) {
    // Nothing to wait for: stopPreview settles on its own, since removing the
    // disposable checkout is already best-effort inside it.
    void stopPreview(projectPath);
  }
}
