import type { Result } from '../../../shared/result';
import type { PublishRequest } from './PublishModal';
import { assert } from '../../../shared/assert';
import { parseIpcPayload } from '../../../shared/ipc-payloads';
import { commitGitChanges, createGitHubRepository, readGitInfo } from './gitChipBridge';

// The owner flushes editor writes before this workflow reads the working tree.
// Each operating failure stops the next destructive step; no parser is caught.
export async function publishGitProject(
  projectPath: string,
  request: PublishRequest,
): Promise<Result<string | undefined, string>> {
  // Validate the complete request before committing anything on disk.
  const payload = parseIpcPayload('git:publish', { projectPath, ...request });
  if (payload.repoName.trim().length === 0) {
    return { ok: false, error: 'Enter a repository name.' };
  }
  const state = await readGitInfo(projectPath);
  if (!state.ok) {
    return state;
  }
  if (!state.value.isRepo) {
    return { ok: false, error: 'Initialize a Git repository before publishing.' };
  }
  assert(state.value.ahead >= 0, 'Git publish: ahead count must be nonnegative');
  assert(Number.isSafeInteger(state.value.ahead), 'Git publish: ahead count must be an integer');
  if (state.value.dirty || state.value.branch === '(no commits yet)') {
    request.onStep('Committing changes…');
    const committed = await commitGitChanges(projectPath, 'Initial commit from Stacki');
    if (!committed.ok) {
      return committed;
    }
  }
  request.onStep('Creating repository and pushing…');
  const published = await createGitHubRepository(projectPath, payload.repoName, {
    isPrivate: payload.isPrivate,
  });
  return published.ok ? { ok: true, value: published.value.url } : published;
}
