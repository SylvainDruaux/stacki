// One transient draft mirrors the active canvas editor without changing source,
// history or iframe markup. Only Content fields subscribe to per-keystroke updates.
import { createLiveValue, useLiveValue } from './liveValue';
import { projectRelativePath } from '../lib/projectPath';

export interface CanvasTextDraft {
  readonly session: string;
  readonly projectPath: string;
  readonly file: string;
  readonly nodeID: string;
  readonly sourceValue: string;
  readonly value: string;
}

export const canvasTextDraft = createLiveValue<CanvasTextDraft | undefined>(undefined);

export function clearCanvasTextDraft(session: string): void {
  if (canvasTextDraft.get()?.session === session) {
    canvasTextDraft.set(undefined);
  }
}

export function useCanvasTextDraft(scope: {
  readonly projectPath?: string | undefined;
  readonly filePath?: string | undefined;
}): CanvasTextDraft | undefined {
  const draft = useLiveValue(canvasTextDraft);
  if (!draft || !scope.projectPath || !scope.filePath) {
    return undefined;
  }
  const file = projectRelativePath(
    scope.projectPath,
    scope.filePath,
    window.avb?.platform ?? 'linux',
  );
  return draft.projectPath === scope.projectPath && draft.file === file ? draft : undefined;
}

export function canvasDraftValue(
  node: { readonly id?: string; readonly value: string },
  draft: CanvasTextDraft | undefined,
): string {
  return draft && node.id === draft.nodeID && node.value === draft.sourceValue
    ? draft.value
    : node.value;
}
