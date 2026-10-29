import { pathText, record } from '../core/boundary';

// The host receives editing state only; the browser owns the text and caret.
export type CanvasTextOverlayEvent =
  | { readonly type: 'avb:text-active'; readonly session: string; readonly key: string }
  | { readonly type: 'avb:text-inactive'; readonly session: string };

export function parseCanvasTextOverlay(input: unknown): CanvasTextOverlayEvent | undefined {
  const data = record(input);
  if (data['type'] === 'avb:text-active') {
    return {
      type: 'avb:text-active',
      session: pathText(data['session']),
      key: pathText(data['key']),
    };
  }
  if (data['type'] === 'avb:text-inactive') {
    return { type: 'avb:text-inactive', session: pathText(data['session']) };
  }
  return undefined;
}

export function parseCanvasTextClose(input: unknown) {
  const data = record(input);
  if (data['type'] !== 'avb:text-close') {
    return undefined;
  }
  if (data['action'] !== 'apply' && data['action'] !== 'cancel') {
    throw new Error('Expected text editing close action');
  }
  return { session: pathText(data['session']), action: data['action'] } as const;
}
