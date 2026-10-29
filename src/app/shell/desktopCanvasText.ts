import { canvasContentEdits } from '../model/canvasTextContent';
import type { ShellView } from '../App';
import type { CanvasTextDocument } from '../../features/preview/useCanvasText';
import { projectRelativePath } from '../../lib/projectPath';

export function desktopCanvasText(app: ShellView): CanvasTextDocument | undefined {
  const state = app.pageState;
  const file = app.openEditableFile?.path;
  if (!file || !state?.editable || state.parsedFrom !== state.source) {
    return undefined;
  }
  if (!file.endsWith('.astro')) {
    return undefined;
  }
  return {
    file: projectRelativePath(app.project.path, file, window.avb.platform),
    projectPath: app.project.path,
    loadContent: canvasContentEdits,
    source: state.source,
    nodes: state.model.nodes,
    pathFor: app.pathFor,
    apply: app.changeCodeSource,
    report: app.showToast,
  };
}
