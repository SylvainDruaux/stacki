// A canvas stays an editor surface while its pointer switches between selecting and using the site.
export type CanvasInteraction = 'select' | 'interact';

export function parseCanvasInteraction(input: unknown): CanvasInteraction | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:interaction') {
    return undefined;
  }
  if ('mode' in input && (input.mode === 'select' || input.mode === 'interact')) {
    return input.mode;
  }
  return undefined;
}

export function parseCanvasNavigation(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:navigated') {
    return undefined;
  }
  if (!('path' in input) || typeof input.path !== 'string') {
    return undefined;
  }
  const path = input.path;
  if (path.length > 4000 || !path.startsWith('/') || path.startsWith('//')) {
    return undefined;
  }
  if (/[\\\x00-\x20]/.test(path)) {
    return undefined;
  }
  return path;
}
