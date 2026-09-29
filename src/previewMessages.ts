import type { Box } from './outlineBoxes';
import type { Spacing } from './spacingBands';
import {
  boolean,
  count,
  dictionary,
  digest,
  list,
  nullable,
  optional,
  pathText,
  record,
} from '../shared/boundary';
import type { Digest } from '../shared/brand';
import { parsePreviewRender, type PreviewRender } from '../shared/preview-token';

export type PreviewMessage =
  | {
      readonly kind: 'rects';
      readonly rects: Readonly<Record<string, readonly Box[] | null>>;
      readonly classes: Readonly<Record<string, readonly (readonly string[])[]>>;
      readonly spacing: Readonly<Record<string, readonly (Spacing | null)[]>>;
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
  | { readonly kind: 'query-result'; readonly input: unknown };

/** Where on the canvas an event landed, and which rendering it landed on: the
 * token is absent until the frame has digested its rendering's manifest. */
export interface LocatedEvent {
  readonly path: string | null;
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
    case 'avb:query-result':
      return { kind: 'query-result', input: value };
    default:
      return undefined;
  }
}

function parseRects(value: Readonly<Record<string, unknown>>): PreviewMessage {
  return {
    kind: 'rects',
    rects: dictionary(nullable(list(parseBox)))(value['rects']),
    classes: dictionary(list(list(pathText)))(value['classes']),
    spacing: dictionary(list(nullable(parseSpacing)))(value['spacing']),
  };
}

function parseLocatedMessage(value: Readonly<Record<string, unknown>>): LocatedEvent {
  const token = nullable(optional(digest))(value['token']);
  return {
    path: nullable(pathText)(value['path']),
    occurrence: count(value['occurrence']),
    token: token ?? undefined,
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
