import { parsePublishConnection } from '../../shared/publishConnection';
import { record } from '../../shared/validation';
import { published } from '../publishing/publishFailure';
import { gitWorkspaceBranch, parseGitWorkspaceManifest } from './gitWorkspaceContract';
import { gitWorkspaceContext, initializeGitWorkspace } from './gitWorkspaceObjects';
import { writeLocalGitWorkspace } from './gitWorkspaceStorage';
import { prepareGitWorkspaceCheckout } from './gitWorkspaceCheckout';

/** Recover unpublished commits and the active draft before restoring newer CRDT updates. */
export async function restoreGitWorkspace(root: string, input: unknown, baseline: string) {
  const data = record(input);
  if (data['workspace'] === undefined) {
    return;
  }
  const manifest = parseGitWorkspaceManifest(data['workspace']);
  const connection = published(parsePublishConnection(input));
  if (manifest.repository !== connection.repository) {
    throw new Error('Git checkpoint belongs to another repository.');
  }
  const git = gitWorkspaceContext(root, connection);
  await initializeGitWorkspace(git, connection, manifest);
  const checkout = await prepareGitWorkspaceCheckout(
    git,
    baseline,
    manifest.draft ?? gitWorkspaceBranch(manifest).head,
  );
  try {
    await checkout.apply();
    await writeLocalGitWorkspace(root, manifest);
  } finally {
    await checkout.dispose();
  }
}
