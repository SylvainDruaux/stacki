import type { CanvasTextTarget, CanvasTextCatalog } from '../../shared/properties/canvasText';
import { pathsOf, canvasTextSourceMatches } from './frameRegions';
import { canvasDragged } from './frameInteraction';
import { matchCanvasText, canvasTextRect } from './frameTextMatch';
import { createCanvasTextSession } from './frameTextSession';

export function installCanvasText(
  post: (message: unknown) => void,
  selects: () => boolean,
  select: (target: CanvasTextTarget, element: Element) => void,
): void {
  const session = createCanvasTextSession(post);
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent) {
      return;
    }
    session.receive(event.data);
  });
  const click = (event: MouseEvent) => {
    if (session.contains(event)) {
      // The native mousedown has already placed/extended the caret. Keep editing
      // while suppressing page click handlers and component drill-in behavior.
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    session.dismiss();
    // A single click belongs to element selection. Only a double click may
    // take over focus for typing; clicks inside an open editor still place its caret.
    if (event.type !== 'dblclick') {
      return;
    }
    const catalog = session.catalog();
    if (!selects() || canvasDragged() || !catalog || !(event.target instanceof Element)) {
      return;
    }
    const hit = findTextHit(catalog, event);
    if (!hit) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!canvasTextSourceMatches(catalog.file, catalog.checksum)) {
      post({
        type: 'avb:text-refused',
        message: 'Text editing is waiting for the current source render.',
      });
      return;
    }
    select(hit.target, hit.match.element);
    session.open(hit.target, hit.match, event);
  };
  window.addEventListener('click', click, true);
  window.addEventListener('dblclick', click, true);
  window.addEventListener('scroll', session.dismiss, true);
  window.addEventListener('resize', session.dismiss);
  document.addEventListener('avb:morphed', session.reconcile);
}

function findTextHit(catalog: CanvasTextCatalog, event: MouseEvent) {
  if (!(event.target instanceof Element)) {
    return undefined;
  }
  const ancestors = new Set<string>();
  let element: Element | undefined = event.target;
  for (let depth = 0; element && depth < 32; depth++) {
    for (const path of pathsOf(element)) {
      ancestors.add(path);
    }
    element = element.parentElement ?? undefined;
  }
  for (const target of catalog.targets) {
    if (!ancestors.has(target.parent)) {
      continue;
    }
    const match = matchCanvasText(target, event.target);
    const box = match && canvasTextRect(match);
    if (
      box &&
      match &&
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom
    ) {
      return { target, match };
    }
  }
  return undefined;
}
