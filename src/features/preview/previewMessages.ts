import type { Box } from './outlineBoxes';
import type { Spacing } from './spacingBands';
import {
  boolean,
  count,
  dictionary,
  digest,
  list,
  optional,
  pathText,
  record,
} from '../../../shared/core/boundary';
import type { Digest } from '../../../shared/core/brand';
import { parsePreviewRender, type PreviewRender } from '../../../shared/page/previewToken';

export type PreviewMessage =
  | {
      readonly kind: 'rects';
      readonly rects: Readonly<Record<string, readonly Box[] | undefined>>;
      readonly classes: Readonly<Record<string, readonly (readonly string[])[]>>;
      readonly spacing: Readonly<Record<string, readonly (Spacing | undefined)[]>>;
    }
  | {
      readonly kind: 'node-classes';
      readonly classes: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly kind: 'rendered-nodes'; readonly paths: readonly string[] }
  | {
      readonly kind: 'node-states';
      readonly hidden: readonly string[];
      readonly inert: readonly string[];
    }
  | { readonly kind: 'modifiers'; readonly shiftKey: boolean; readonly altKey: boolean }
  | ({ readonly kind: 'hover-node' } & LocatedEvent)
  | ({ readonly kind: 'click-node'; readonly outside: boolean } & LocatedEvent)
  | ({ readonly kind: 'open-node' } & LocatedEvent)
  | { readonly kind: 'canvas-ready' }
  /** The rendering the canvas shows: its manifest and token (plan §9, step 7). */
  | { readonly kind: 'render'; readonly render: PreviewRender }
  /** The canvas reloaded instead of patching, and why (step 7). */
  | { readonly kind: 'preview-reload'; readonly reason: PreviewReloadReason }
  | { readonly kind: 'query-result'; readonly input: unknown };

/** Why the canvas patcher reloaded (electron/previewClient/morphClient.ts): past one of its
 * caps, or for the reasons a patch was never possible. */
export const PREVIEW_RELOAD_REASONS = [
  'markers-over-cap',
  'diff-over-cap',
  'scripts-changed',
  'patch-failed',
] as const;
export type PreviewReloadReason = (typeof PREVIEW_RELOAD_REASONS)[number];

/** The notice for a reload a cap caused, or undefined for one the canvas could
 * never have avoided (those stay quiet, as they always were). */
export function describePreviewReload(reason: PreviewReloadReason): string | undefined {
  switch (reason) {
    case 'markers-over-cap':
      return 'The canvas reloaded: this page has more elements than it updates in place.';
    case 'diff-over-cap':
      return 'The canvas reloaded: the change was too large to update in place.';
    case 'scripts-changed':
    case 'patch-failed':
      return undefined;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** A shortcut the canvas frame forwards while it holds keyboard focus
 * (electron/preload/frameDesign.ts): the app replays it as its own key event. */
export type ShortcutMessage =
  | { readonly name: 'insert' }
  | { readonly name: 'arrow'; readonly key: string }
  | { readonly name: 'key'; readonly key: string; readonly meta: boolean };

// A KeyboardEvent key is one character or a short name ("ArrowDown").
const SHORTCUT_KEY_CHARS_MAX = 32;

function shortcutKey(input: unknown): string {
  if (typeof input === 'string') {
    if (input.length <= SHORTCUT_KEY_CHARS_MAX) {
      return input;
    }
    throw new Error('Shortcut key exceeds limit');
  }
  throw new Error('Expected shortcut key');
}

/** A forwarded shortcut, or undefined for any other message — project code
 * posts to the same window, so a message that is not one is ignored. */
export function parseShortcutMessage(input: unknown): ShortcutMessage | undefined {
  try {
    const value = record(input);
    if (value['type'] !== 'avb:shortcut') {
      return undefined;
    }
    switch (value['name']) {
      case 'insert':
        return { name: 'insert' };
      case 'arrow':
        return { name: 'arrow', key: shortcutKey(value['key']) };
      case 'key':
        return { name: 'key', key: shortcutKey(value['key']), meta: value['meta'] === true };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Where on the canvas an event landed, and which rendering it landed on: the
 * token is absent until the frame has digested its rendering's manifest. */
export interface LocatedEvent {
  readonly path: string | undefined;
  readonly occurrence: number;
  readonly token: Digest | undefined;
}

export function parsePreviewMessage(input: unknown): PreviewMessage | undefined {
  let value: Readonly<Record<string, unknown>>;
  try {
    value = record(input);
    return parseKnownMessage(value);
  } catch {
    // Messages originate in project code. Malformed input is ignored at this
    // boundary so one page cannot break the editor's own event loop.
    return undefined;
  }
}

function parseKnownMessage(value: Readonly<Record<string, unknown>>): PreviewMessage | undefined {
  switch (value['type']) {
    case 'avb:rects':
      return parseRects(value);
    case 'avb:node-classes':
      return { kind: 'node-classes', classes: dictionary(list(pathText))(value['classes']) };
    case 'avb:rendered-nodes':
      return { kind: 'rendered-nodes', paths: list(pathText)(value['paths']) };
    case 'avb:node-states':
      return {
        kind: 'node-states',
        hidden: list(pathText)(value['hidden']),
        inert: list(pathText)(value['inert']),
      };
    case 'avb:modifiers':
      return {
        kind: 'modifiers',
        shiftKey: boolean(value['shiftKey']),
        altKey: boolean(value['altKey']),
      };
    case 'avb:hover-node':
      return { kind: 'hover-node', ...parseLocatedMessage(value) };
    case 'avb:click-node':
      return {
        kind: 'click-node',
        ...parseLocatedMessage(value),
        outside: boolean(value['outside']),
      };
    case 'avb:open-node':
      return { kind: 'open-node', ...parseLocatedMessage(value) };
    case 'avb:canvas-ready':
      return { kind: 'canvas-ready' };
    case 'avb:render':
      return { kind: 'render', render: parsePreviewRender(value) };
    case 'avb:preview-reload':
      return { kind: 'preview-reload', reason: parseReloadReason(value['reason']) };
    case 'avb:query-result':
      return { kind: 'query-result', input: value };
    default:
      return undefined;
  }
}

function parseRects(value: Readonly<Record<string, unknown>>): PreviewMessage {
  return {
    kind: 'rects',
    rects: dictionary(optional(list(parseBox)))(value['rects']),
    classes: dictionary(list(list(pathText)))(value['classes']),
    spacing: dictionary(list(optional(parseSpacing)))(value['spacing']),
  };
}

function parseReloadReason(input: unknown): PreviewReloadReason {
  const found = PREVIEW_RELOAD_REASONS.find((reason) => reason === input);
  if (found === undefined) {
    throw new Error('Preview reload: unknown reason');
  }
  return found;
}

function parseLocatedMessage(value: Readonly<Record<string, unknown>>): LocatedEvent {
  return {
    path: optional(pathText)(value['path']),
    occurrence: count(value['occurrence']),
    token: optional(digest)(value['token']),
  };
}

function parseBox(input: unknown): Box {
  const value = record(input);
  const width = finite(value['w']);
  const height = finite(value['h']);
  if (width < 0 || height < 0) {
    throw new Error('Preview rectangle: expected nonnegative size');
  }
  return { x: finite(value['x']), y: finite(value['y']), w: width, h: height };
}

function parseSpacing(input: unknown): Spacing {
  const value = record(input);
  const padding = optional(parseSides)(value['padding']);
  const margin = optional(parseSides)(value['margin']);
  const gaps = optional(list(parseGap))(value['gaps']);
  return {
    ...(padding === undefined ? {} : { padding }),
    ...(margin === undefined ? {} : { margin }),
    ...(gaps === undefined ? {} : { gaps }),
  };
}

function parseSides(input: unknown) {
  const value = record(input);
  return optionalFields({
    top: optional(nonnegativeFinite)(value['top']),
    right: optional(nonnegativeFinite)(value['right']),
    bottom: optional(nonnegativeFinite)(value['bottom']),
    left: optional(nonnegativeFinite)(value['left']),
  });
}

function parseGap(input: unknown): Box & { readonly axis: 'row' | 'column' } {
  const value = record(input);
  const axis = value['axis'];
  if (axis !== 'row' && axis !== 'column') {
    throw new Error('Preview gap: unknown axis');
  }
  return { ...parseBox(value), axis };
}

function finite(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error('Preview measurement: expected finite number');
  }
  return input;
}

function nonnegativeFinite(input: unknown): number {
  const value = finite(input);
  if (value < 0) {
    throw new Error('Preview spacing: expected nonnegative number');
  }
  return value;
}

function optionalFields<Value extends Readonly<Record<string, unknown>>>(value: Value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
