import {
  parseCanvasTextCatalog,
  type CanvasTextCatalog,
  type CanvasTextTarget,
} from '../../shared/properties/canvasText';
import { parseCanvasTextClose } from '../../shared/properties/canvasTextOverlay';
import { canvasTextSourceMatches } from './frameRegions';
import { matchCanvasText, type TextMatch } from './frameTextMatch';
import { openNativeText } from './frameTextNative';

interface ActiveText {
  readonly catalog: CanvasTextCatalog;
  readonly editor: NonNullable<ReturnType<typeof openNativeText>>;
}

export function createCanvasTextSession(post: (message: unknown) => void) {
  let catalog: CanvasTextCatalog | undefined;
  let active: ActiveText | undefined;
  const finish = (action: 'apply' | 'cancel') => active?.editor.finish(action);
  return {
    catalog: () => catalog,
    contains: (event: MouseEvent) => active?.editor.contains(event) ?? false,
    dismiss: () => finish('apply'),
    reconcile: () => {
      if (
        active &&
        (!active.editor.intact() ||
          !canvasTextSourceMatches(active.catalog.file, active.catalog.checksum))
      ) {
        finish('cancel');
      }
    },
    receive: (input: unknown) => {
      const request = readCanvasTextRequest(input);
      if (!request) {
        return;
      }
      if (request.kind === 'close') {
        if (active?.catalog.session === request.value.session) {
          finish(request.value.action);
        }
        return;
      }
      if (catalog?.session !== request.value.session) {
        finish('cancel');
      }
      catalog = request.value;
    },
    open: (target: CanvasTextTarget, match: TextMatch, event: MouseEvent) => {
      finish('apply');
      const current = catalog;
      if (!current) {
        return;
      }
      const editor = openNativeText(
        match,
        event,
        (value) =>
          post({ type: 'avb:text-draft', session: current.session, key: target.key, value }),
        (result) => {
          active = undefined;
          // Save precedes inactive so the panel can retain its draft until the
          // source acknowledges it, without flashing the old text on blur.
          commitCanvasText({ catalog: current, target, match }, result, post);
          post({ type: 'avb:text-inactive', session: current.session });
        },
      );
      if (editor) {
        active = { catalog: current, editor };
        post({ type: 'avb:text-active', session: current.session, key: target.key });
      } else {
        post({ type: 'avb:text-refused', message: 'This text cannot be edited safely.' });
      }
    },
  };
}

function commitCanvasText(
  entry: {
    readonly catalog: CanvasTextCatalog;
    readonly target: CanvasTextTarget;
    readonly match: TextMatch;
  },
  result: { readonly value: string | undefined; readonly restored: boolean },
  post: (message: unknown) => void,
) {
  const { value, restored } = result;
  if (value === undefined || value === entry.target.value) {
    return;
  }
  if (
    !restored ||
    !matchCanvasText(entry.target, entry.match.element) ||
    !canvasTextSourceMatches(entry.catalog.file, entry.catalog.checksum)
  ) {
    post({
      type: 'avb:text-refused',
      message: 'The page changed while editing. The text was not saved; select it again.',
    });
    return;
  }
  post({ type: 'avb:text-save', session: entry.catalog.session, key: entry.target.key, value });
}

function readCanvasTextRequest(input: unknown) {
  try {
    const close = parseCanvasTextClose(input);
    if (close) {
      return { kind: 'close', value: close } as const;
    }
    return { kind: 'catalog', value: parseCanvasTextCatalog(input) } as const;
  } catch {
    // Ignore other protocols and malformed data before running trusted control flow.
    return undefined;
  }
}
