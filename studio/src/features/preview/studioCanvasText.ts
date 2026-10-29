import { canvasContentEdits } from '../../../vendor/stacki/src/app/model/canvasTextContent';
import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import type { CanvasTextDocument } from '../../../vendor/stacki/src/features/preview/useCanvasText';
import { reportErrorToast } from '../../../vendor/stacki/src/ui/errorNotices';
import type { SharedDocument } from '../collaboration/useDocument';
import type { ParserNode } from '../source/source';
import { pathFor } from '../project/previewSelection';

export function studioCanvasText(
  file: string,
  document: SharedDocument | undefined,
  nodes: readonly ParserNode[],
): CanvasTextDocument | undefined {
  if (!document?.ready || !file.endsWith('.astro')) {
    return undefined;
  }
  const source = document.text.toString();
  return {
    file,
    source,
    nodes,
    projectPath: 'studio',
    loadContent: canvasContentEdits,
    pathFor: (id) => (isCanvasPage(file) ? '' : file + '|') + pathFor(id),
    apply: async (next) => {
      if (document.text.toString() !== source) {
        throw new Error('The shared source changed. Select the text again.');
      }
      document.replaceSource(next);
      if (document.text.toString() !== next) {
        throw new Error('Text was not changed. Check your editing access or selection lock.');
      }
    },
    report: reportErrorToast,
  };
}
