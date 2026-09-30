import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { CodeEditor, type CodeEditorTokenHighlight } from '../components/CodeEditor';
import SegmentedControl from '../components/SegmentedControl';
import ClassPicker from '../components/ClassPicker';
import './clip-path.css';
import type {
  ApiNullable,
  BreakpointId,
  ElementAttributeHandle,
  ElementStyleSource,
  StyleHandle,
  StyleTargetOptions,
  WebflowApi,
  WebflowStyleEditor,
  WebflowStyleLookup,
} from './webflow-designer';

type Point = { x: number; y: number };
type CornerName = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft';
type CornerRadius = { x: number; y: number };
type CornerRadii = Record<CornerName, CornerRadius>;
type PolygonShape = { kind: 'polygon'; points: Point[] };
type CircleShape = { kind: 'circle'; radius: number; cx: number; cy: number };
type EllipseShape = { kind: 'ellipse'; rx: number; ry: number; cx: number; cy: number };
type InsetShape = {
  kind: 'inset';
  top: number;
  right: number;
  bottom: number;
  left: number;
  radii: CornerRadii;
};
type ShapeFunctionShape = {
  kind: 'shape';
  value: string;
  fillRule?: 'evenodd' | 'nonzero';
  pathData?: string;
};
type CssUnitValue = { value: number; unit: string };
type CssCoordinateValue = CssUnitValue | { expression: string };
type CssCoordinatePoint = { x: CssCoordinateValue; y: CssCoordinateValue };
type RawEditableClipPath =
  | { kind: 'polygon'; points: CssCoordinatePoint[]; fillRule?: 'evenodd' | 'nonzero' }
  | { kind: 'circle'; radius: CssUnitValue; cx: CssUnitValue; cy: CssUnitValue }
  | { kind: 'ellipse'; rx: CssUnitValue; ry: CssUnitValue; cx: CssUnitValue; cy: CssUnitValue }
  | {
      kind: 'inset';
      top: CssUnitValue;
      right: CssUnitValue;
      bottom: CssUnitValue;
      left: CssUnitValue;
      radii?: { horizontal: CssUnitValue[]; vertical?: CssUnitValue[] };
    };
type RawClipPathShape = {
  kind: 'raw';
  value: string;
  preset?: string;
  editable?: RawEditableClipPath;
};
type NoneShape = { kind: 'none' };
type ClipShape =
  | NoneShape
  | PolygonShape
  | CircleShape
  | EllipseShape
  | InsetShape
  | ShapeFunctionShape
  | RawClipPathShape;
type InsetSide = 'top' | 'right' | 'bottom' | 'left';
type InsetSideMode = 'single' | 'opposite' | 'all';
type InsetRadiusMode = 'single' | 'all' | 'opposite';
type InsetModifierMode = 'single' | 'opposite' | 'all';
type KeyboardModifiers = { altKey: boolean; shiftKey: boolean; radiusUnlocked?: boolean };
type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

type HandleTarget =
  | { kind: 'polygon-point'; index: number }
  | { kind: 'circle-center' }
  | { kind: 'circle-radius' }
  | { kind: 'ellipse-center' }
  | { kind: 'ellipse-rx' }
  | { kind: 'ellipse-ry' }
  | { kind: 'inset-top' }
  | { kind: 'inset-right' }
  | { kind: 'inset-bottom' }
  | { kind: 'inset-left' }
  | { kind: 'inset-radius'; corner: CornerName };

type DragTarget = HandleTarget & {
  before: ClipShape;
  polygonPointIndexes?: number[];
  optionDuplicated?: boolean;
  dragOrigin?: { pointer: Point; handle: Point };
};

type StylePropertyRead = { value: string; breakpoint: BreakpointId };
type StyleLookupDiagnostic = {
  candidate: string | string[];
  source: 'getStyleByName' | 'getAllStyles';
  timedOut?: boolean;
  found: boolean;
  path?: string[];
  id?: string | undefined;
};
type CanvasSize = { width: number; height: number };
type CanvasHandleBounds = { minX: number; maxX: number; minY: number; maxY: number };
type BoundsSide = 'left' | 'right' | 'top' | 'bottom';
type PolygonDisplayEdge = 'prev' | 'next';
type PolygonDisplayProjection = { side: BoundsSide; edge: PolygonDisplayEdge };
type SelectionRect = { left: number; top: number; width: number; height: number };
type SnapGuides = { x: number[]; y: number[] };
type SnapAxisResult = { value: number; guide: number | undefined };
type SnapPointResult = { point: Point; guides: SnapGuides };
type ShapeResizeCorner = CornerName;
type PolygonSelectionDrag = {
  pointerId: number;
  start: Point;
  current: Point;
  startClient: Point;
  didMove: boolean;
  additive: boolean;
  baseHandles: Array<Extract<HandleTarget, { kind: 'polygon-point' }>>;
};
type ShapeTransformDrag = {
  pointerId: number;
  mode: 'move' | 'resize';
  corner?: ShapeResizeCorner;
  start: Point;
  before: ShapeFunctionShape;
  bounds: SelectionRect;
  fitMode: ShapeFitMode;
  scaleOptions: ShapeScaleOptions;
};
type SvgViewBox = { x: number; y: number; width: number; height: number };
type SvgBoundaryEdge = { from: string; to: string; fromPoint: Point; toPoint: Point };
type SvgLoopPair = {
  sourceIndex: number;
  targetLoopIndex: number;
  targetIndex: number;
  distance: number;
};
type SvgLoopPoint = { targetLoopIndex: number; targetIndex: number; distance: number };
type SvgClipPathOutline = { points: Point[]; loops: Point[][] };
type SvgShapeCommand =
  | { kind: 'line'; to: Point }
  | { kind: 'curve'; to: Point; control1: Point; control2?: Point }
  | { kind: 'close' };
type SvgShapeSubpath = { start: Point; commands: SvgShapeCommand[] };
type ShapeFitMode = 'stretch' | 'contain';
type ShapeScaleOptions = {
  useVariable: boolean;
  variableName: string;
  offsetLeftVariableName?: string;
  offsetTopVariableName?: string;
};
type ShapeScaleOptionOverrides = {
  readonly useVariable?: boolean;
  readonly variableName?: string;
  readonly offsetLeftVariableName?: string;
  readonly offsetTopVariableName?: string;
};
type ShapeOffsetCoordinate = {
  axis: 'x' | 'y';
  u: number;
  size: number;
  offset: number;
  span: number;
  sizeVar: string;
  offsetVar: string;
};
type ShapeContainModel = {
  points: Array<{ ux: number; uy: number }>;
  wu: number;
  hu: number;
  size: number;
  ol: number;
  ot: number;
  sizeVar: string;
  offsetLeftVar: string;
  offsetTopVar: string;
};
type ShapeCssPoint = { x: string; y: string };
type ShapeCssCommand =
  | { kind: 'line'; to: ShapeCssPoint }
  | { kind: 'curve'; to: ShapeCssPoint; control1: ShapeCssPoint; control2?: ShapeCssPoint }
  | { kind: 'close' };
type ShapeCssSubpath = { start: ShapeCssPoint; commands: ShapeCssCommand[] };
type ClipPathStyleOrigin = 'none' | 'current' | 'inherited';
type SelectionReadOptions = {
  force?: boolean;
  resetStyle?: boolean;
};
type SvgShapeBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
};
type PastedShapeSvgCache = {
  source: string;
  stretch: ShapeFunctionShape;
  contain: ShapeFunctionShape;
};
type ShortcutHelpItem = { keys: string; description: string };
type ShortcutHelpGroup = { title: string; items: ShortcutHelpItem[] };

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined && value !== undefined;
}

function parseFillRule(value: string | undefined): ShapeFunctionShape['fillRule'] {
  const normalized = value?.toLowerCase();
  if (normalized === 'evenodd' || normalized === 'nonzero') {
    return normalized;
  }
  return undefined;
}

function isWebflowApi(candidate: unknown): candidate is WebflowApi {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  if (!('getSelectedElement' in candidate)) {
    return false;
  }
  return typeof candidate.getSelectedElement === 'function';
}

function isElementStyleSource(candidate: unknown): candidate is ElementStyleSource {
  return typeof candidate === 'object' && candidate !== null;
}

function readWebflowApi(): WebflowApi | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'webflow');
  const candidate: unknown = descriptor?.value;
  return isWebflowApi(candidate) ? candidate : undefined;
}

const BREAKPOINT_LABELS: Record<BreakpointId, string> = {
  xxl: '1920px and up',
  xl: '1440px and up',
  large: '1280px and up',
  main: 'Desktop',
  medium: 'Tablet',
  small: 'Mobile landscape',
  tiny: 'Mobile portrait',
};

const WRITE_THROTTLE_MS = 60;
const STYLE_REFRESH_MS = 500;
const STYLE_LOOKUP_TIMEOUT_MS = 250;
const STYLE_PATH_LOOKUP_TIMEOUT_MS = 300;
const STYLE_PROPERTY_LOOKUP_TIMEOUT_MS = 750;
const SHAPE_STRETCH_PROPERTY = '--moden-clip-path-shape-stretch';
const SHAPE_CONTAIN_PROPERTY = '--moden-clip-path-shape-contain';
// All variable names default to empty: an empty name emits the raw value (e.g. 100cqw or 0.5)
// instead of var(--size, 100cqw) / var(--offset-left, 0.5). The placeholders below are only UI
// hints.
const DEFAULT_SHAPE_SCALE_VARIABLE_NAME = '';
const DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME = '';
const DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME = '';
const SHAPE_SCALE_VARIABLE_PLACEHOLDER = '--size';
const SHAPE_OFFSET_LEFT_VARIABLE_PLACEHOLDER = '--offset-left';
const SHAPE_OFFSET_TOP_VARIABLE_PLACEHOLDER = '--offset-top';
const DEFAULT_SHAPE_OFFSET_VALUE = 0.5;
const SHAPE_OFFSET_TRAVEL_EPSILON = 0.0001;
const DEFAULT_SHAPE_SCALE_OPTIONS: ShapeScaleOptions = {
  useVariable: false,
  variableName: DEFAULT_SHAPE_SCALE_VARIABLE_NAME,
  offsetLeftVariableName: DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
  offsetTopVariableName: DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
};
const HISTORY_LIMIT = 100;
const HANDLE_SIZE_PX = 12;
const KEYBOARD_STEP = 1;
const KEYBOARD_FAST_STEP = 10;
const KEYBOARD_REPEAT_DELAY_MS = 300;
const KEYBOARD_REPEAT_MS = 60;
const EDGE_SNAP_DISTANCE = 2.5;
const SNAP_GUIDE_ALIGNMENT_EPSILON = 0.1;
const SELECTION_DRAG_THRESHOLD_PX = 4;
const DUPLICATE_POINT_OFFSET = 4;
const SVG_PARSE_CELL_LIMIT = 10000;
const SVG_POINT_EPSILON = 0.0001;
const SVG_ARC_KAPPA = 0.5522847498307936;
const ARROW_KEYS: ArrowKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const CORNERS: CornerName[] = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
const CLIP_PATH_DEBUG = false;
const NONE_PRESET = 'None';
const CUSTOM_PRESET = 'Custom';
const NONE_SHAPE: NoneShape = { kind: 'none' };
const CUSTOM_SHAPE: RawClipPathShape = { kind: 'raw', value: 'inherit', preset: CUSTOM_PRESET };
const CSS_GLOBAL_CLIP_PATH_VALUES = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);
const CSS_GEOMETRY_BOX_CLIP_PATH_VALUES = new Set([
  'border-box',
  'content-box',
  'fill-box',
  'half-border-box',
  'margin-box',
  'padding-box',
  'stroke-box',
  'view-box',
]);
const DEFAULT_SHAPE_PATH_DATA =
  'M56.8 43.2H100V56.8C76.2 56.8 56.8 76.2 56.8 100H43.2' +
  'V56.8H0V43.2C23.8 43.2 43.2 23.8 43.2 0H56.8V43.2Z';
const DEFAULT_SHAPE_VALUE = [
  'from 56.8% 43.2%',
  'line to 100% 43.2%',
  'line to 100% 56.8%',
  'curve to 56.8% 100% with 76.2% 56.8% / 56.8% 76.2%',
  'line to 43.2% 100%',
  'line to 43.2% 56.8%',
  'line to 0% 56.8%',
  'line to 0% 43.2%',
  'curve to 43.2% 0% with 23.8% 43.2% / 43.2% 23.8%',
  'line to 56.8% 0%',
  'line to 56.8% 43.2%',
  'close',
].join(', ');

function formatPercent(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function formatCssNumber(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function formatCssUnitValue(value: CssUnitValue) {
  return `${formatCssNumber(value.value)}${value.unit}`;
}

function isCssUnitValue(value: CssCoordinateValue): value is CssUnitValue {
  return 'value' in value;
}

function formatCssCoordinateValue(value: CssCoordinateValue) {
  return isCssUnitValue(value) ? formatCssUnitValue(value) : value.expression;
}

function formatCssCoordinateValueForPreview(
  value: CssCoordinateValue,
  axis?: 'x' | 'y',
  size?: CanvasSize,
) {
  const formatted = formatCssCoordinateValue(value);
  return axis && size
    ? previewCssCoordinateToken(formatted, axis, size)
    : addPreviewVariableFallbacks(formatted);
}

function formatCssCoordinatePoint(point: CssCoordinatePoint) {
  return `${formatCssCoordinateValue(point.x)} ${formatCssCoordinateValue(point.y)}`;
}

function formatCssScaleNumber(value: number) {
  const rounded = Math.round(value * 10000) / 10000;
  return Number.isInteger(rounded)
    ? `${rounded}`
    : `${rounded}`.replace(/0+$/, '').replace(/\.$/, '');
}

function formatCqw(value: number) {
  return `${formatCssNumber(value)}cqw`;
}

function sanitizeShapeScaleVariableName(value: string) {
  const trimmed = value.trim();
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
}

// Coerce free-text into a valid CSS custom-property name (e.g. "Element Size" -> "--element-size").
// An already-valid `--name` is left untouched so existing variables keep their casing.
function formatShapeVariableName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^--[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  const body = trimmed
    .replace(/^-+/, '') // drop leading dashes (re-added as the -- prefix)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2') // camelCase -> kebab-case
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-') // spaces & other invalid chars -> hyphen
    .replace(/-+/g, '-') // collapse repeated hyphens
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
  return body ? `--${body}` : '';
}

function emptySnapGuides(): SnapGuides {
  return { x: [], y: [] };
}

function addSnapGuide(guides: SnapGuides, axis: keyof SnapGuides, value: number) {
  if (guides[axis].some((guide) => Math.abs(guide - value) < 0.01)) {
    return;
  }
  guides[axis].push(value);
}

function snapAxisToAnchors(value: number, anchors: number[], _startValue?: number): SnapAxisResult {
  let closest = value;
  let guide: number | undefined = undefined;
  let closestDistance = EDGE_SNAP_DISTANCE;

  anchors.forEach((anchor) => {
    const distance = Math.abs(value - anchor);
    if (distance <= closestDistance) {
      closest = anchor;
      guide = anchor;
      closestDistance = distance;
    }
  });

  return { value: closest, guide };
}

function snapPointToAnchors(
  x: number,
  y: number,
  xAnchors: number[],
  yAnchors: number[],
  start?: Point,
): SnapPointResult {
  const snappedX = snapAxisToAnchors(x, xAnchors, start?.x);
  const snappedY = snapAxisToAnchors(y, yAnchors, start?.y);
  const guides = emptySnapGuides();

  if (snappedX.guide !== undefined) {
    addSnapGuide(guides, 'x', snappedX.guide);
  }
  if (snappedY.guide !== undefined) {
    addSnapGuide(guides, 'y', snappedY.guide);
  }

  return {
    point: { x: snappedX.value, y: snappedY.value },
    guides,
  };
}

function pointAlignmentGuides(point: Point, xAnchors: number[], yAnchors: number[]) {
  const guides = emptySnapGuides();

  xAnchors.forEach((anchor) => {
    if (Math.abs(point.x - anchor) <= SNAP_GUIDE_ALIGNMENT_EPSILON) {
      addSnapGuide(guides, 'x', anchor);
    }
  });
  yAnchors.forEach((anchor) => {
    if (Math.abs(point.y - anchor) <= SNAP_GUIDE_ALIGNMENT_EPSILON) {
      addSnapGuide(guides, 'y', anchor);
    }
  });

  return guides;
}

function mergeSnapGuides(...items: SnapGuides[]) {
  const merged = emptySnapGuides();

  items.forEach((guides) => {
    guides.x.forEach((value) => addSnapGuide(merged, 'x', value));
    guides.y.forEach((value) => addSnapGuide(merged, 'y', value));
  });

  return merged;
}

function normalizeSnapGuides(guides: SnapGuides): SnapGuides | undefined {
  const x = guides.x.filter(
    (value, index, values) => values.findIndex((item) => Math.abs(item - value) < 0.01) === index,
  );
  const y = guides.y.filter(
    (value, index, values) => values.findIndex((item) => Math.abs(item - value) < 0.01) === index,
  );
  return x.length || y.length ? { x, y } : undefined;
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function rectFromPoints(start: Point, end: Point): SelectionRect {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    left,
    top,
    width: Math.max(start.x, end.x) - left,
    height: Math.max(start.y, end.y) - top,
  };
}

function pointInRect(point: Point, rect: SelectionRect) {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

function addShapeSnapCandidate(
  candidates: Array<{ delta: number; distance: number; guide: number }>,
  current: number,
  next: number,
  target: number,
  delta: number,
  { sticky }: { sticky: boolean },
) {
  const distance = Math.abs(next - target);
  if (
    distance <= EDGE_SNAP_DISTANCE &&
    (sticky || Math.abs(current - target) > SNAP_GUIDE_ALIGNMENT_EPSILON)
  ) {
    candidates.push({ delta, distance, guide: target });
  }
}

function addAlignedShapeGuide(
  guides: SnapGuides,
  axis: keyof SnapGuides,
  value: number,
  targets: number[],
) {
  targets.forEach((target) => {
    if (Math.abs(value - target) <= SNAP_GUIDE_ALIGNMENT_EPSILON) {
      addSnapGuide(guides, axis, target);
    }
  });
}

function shapeSnapGuidesForBounds(bounds: SelectionRect) {
  const guides = emptySnapGuides();
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;

  addAlignedShapeGuide(guides, 'x', bounds.left, [0]);
  addAlignedShapeGuide(guides, 'x', right, [100]);
  addAlignedShapeGuide(guides, 'x', centerX, [0, 50, 100]);
  addAlignedShapeGuide(guides, 'y', bounds.top, [0]);
  addAlignedShapeGuide(guides, 'y', bottom, [100]);
  addAlignedShapeGuide(guides, 'y', centerY, [0, 50, 100]);

  return guides;
}

function snappedShapeMoveDelta(
  bounds: SelectionRect,
  dx: number,
  dy: number,
  options: { sticky?: boolean } = {},
) {
  const sticky = options.sticky ?? false;
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const xCandidates: Array<{ delta: number; distance: number; guide: number }> = [];
  const yCandidates: Array<{ delta: number; distance: number; guide: number }> = [];

  addShapeSnapCandidate(xCandidates, bounds.left, bounds.left + dx, 0, -bounds.left, { sticky });
  addShapeSnapCandidate(xCandidates, right, right + dx, 100, 100 - right, { sticky });
  [0, 50, 100].forEach((target) => {
    addShapeSnapCandidate(xCandidates, centerX, centerX + dx, target, target - centerX, { sticky });
  });

  addShapeSnapCandidate(yCandidates, bounds.top, bounds.top + dy, 0, -bounds.top, { sticky });
  addShapeSnapCandidate(yCandidates, bottom, bottom + dy, 100, 100 - bottom, { sticky });
  [0, 50, 100].forEach((target) => {
    addShapeSnapCandidate(yCandidates, centerY, centerY + dy, target, target - centerY, { sticky });
  });

  const closest = (
    candidates: Array<{ delta: number; distance: number; guide: number }>,
    fallback: number,
  ) =>
    candidates.sort((nearer, farther) => nearer.distance - farther.distance)[0] || {
      delta: fallback,
      distance: Infinity,
      guide: NaN,
    };
  const xSnap = closest(xCandidates, dx);
  const ySnap = closest(yCandidates, dy);
  const snappedBounds = {
    ...bounds,
    left: bounds.left + xSnap.delta,
    top: bounds.top + ySnap.delta,
  };
  const guides = shapeSnapGuidesForBounds(snappedBounds);

  return {
    dx: xSnap.delta,
    dy: ySnap.delta,
    guides,
  };
}

function boundsClose(left: CanvasHandleBounds | undefined, right: CanvasHandleBounds) {
  return Boolean(
    left &&
    Math.abs(left.minX - right.minX) < 0.1 &&
    Math.abs(left.maxX - right.maxX) < 0.1 &&
    Math.abs(left.minY - right.minY) < 0.1 &&
    Math.abs(left.maxY - right.maxY) < 0.1,
  );
}

function pointInBounds(point: Point, bounds: CanvasHandleBounds) {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

function distanceSquared(from: Point, to: Point) {
  return (from.x - to.x) ** 2 + (from.y - to.y) ** 2;
}

function pointsNearlyEqual(left: Point, right: Point) {
  return Math.abs(left.x - right.x) < 0.1 && Math.abs(left.y - right.y) < 0.1;
}

function outsideBoundsSides(point: Point, bounds: CanvasHandleBounds) {
  const sides: BoundsSide[] = [];
  if (point.y < bounds.minY) {
    sides.push('top');
  }
  if (point.y > bounds.maxY) {
    sides.push('bottom');
  }
  if (point.x < bounds.minX) {
    sides.push('left');
  }
  if (point.x > bounds.maxX) {
    sides.push('right');
  }
  return sides;
}

function addUniqueIntersection(
  intersections: Array<{ point: Point; side: BoundsSide }>,
  intersection: { point: Point; side: BoundsSide },
) {
  if (
    intersections.some(
      (item) =>
        item.side === intersection.side &&
        Math.abs(item.point.x - intersection.point.x) < 0.01 &&
        Math.abs(item.point.y - intersection.point.y) < 0.01,
    )
  ) {
    return;
  }
  intersections.push(intersection);
}

function segmentBoundsIntersections(start: Point, end: Point, bounds: CanvasHandleBounds) {
  const intersections: Array<{ point: Point; side: BoundsSide }> = [];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const addAtFraction = (fraction: number, side: BoundsSide) => {
    if (fraction < 0 || fraction > 1) {
      return;
    }
    const point = { x: start.x + dx * fraction, y: start.y + dy * fraction };
    if (pointInBounds(point, bounds)) {
      addUniqueIntersection(intersections, { point, side });
    }
  };

  if (Math.abs(dx) > 0.0001) {
    addAtFraction((bounds.minX - start.x) / dx, 'left');
    addAtFraction((bounds.maxX - start.x) / dx, 'right');
  }
  if (Math.abs(dy) > 0.0001) {
    addAtFraction((bounds.minY - start.y) / dy, 'top');
    addAtFraction((bounds.maxY - start.y) / dy, 'bottom');
  }

  return intersections;
}

function closestPolygonProjection(
  candidates: Array<{ point: Point; edge: PolygonDisplayEdge; side: BoundsSide }>,
  target: Point,
) {
  return candidates.reduce((closest, candidate) =>
    distanceSquared(candidate.point, target) < distanceSquared(closest.point, target)
      ? candidate
      : closest,
  );
}

function polygonHandleDisplayPoint(
  points: Point[],
  index: number,
  bounds: CanvasHandleBounds | undefined,
  preferred?: PolygonDisplayProjection,
): { point: Point; projection: PolygonDisplayProjection | undefined } {
  const point = points[index];
  if (!point) {
    return { point: { x: 0, y: 0 }, projection: undefined };
  }
  if (!bounds || pointInBounds(point, bounds)) {
    return { point, projection: undefined };
  }

  const previous = points[(index - 1 + points.length) % points.length] ?? point;
  const next = points[(index + 1) % points.length] ?? point;
  const sides = outsideBoundsSides(point, bounds);
  const incomingIntersections = segmentBoundsIntersections(previous, point, bounds);
  const outgoingIntersections = segmentBoundsIntersections(point, next, bounds);
  const candidatesForSide = (side: BoundsSide) => [
    ...incomingIntersections
      .filter((intersection) => intersection.side === side)
      .map((intersection) => ({ point: intersection.point, side, edge: 'prev' as const })),
    ...outgoingIntersections
      .filter((intersection) => intersection.side === side)
      .map((intersection) => ({ point: intersection.point, side, edge: 'next' as const })),
  ];

  if (preferred && sides.includes(preferred.side)) {
    const preferredCandidate = candidatesForSide(preferred.side).find(
      (candidate) => candidate.edge === preferred.edge,
    );
    if (preferredCandidate) {
      return { point: preferredCandidate.point, projection: preferred };
    }
  }

  for (const side of sides) {
    const candidates = candidatesForSide(side);
    if (candidates.length) {
      const closest = closestPolygonProjection(candidates, point);
      return { point: closest.point, projection: { side, edge: closest.edge } };
    }
  }

  const allCandidates = [
    ...incomingIntersections.map((intersection) => ({
      point: intersection.point,
      side: intersection.side,
      edge: 'prev' as const,
    })),
    ...outgoingIntersections.map((intersection) => ({
      point: intersection.point,
      side: intersection.side,
      edge: 'next' as const,
    })),
  ];
  if (allCandidates.length) {
    const closest = closestPolygonProjection(allCandidates, point);
    return { point: closest.point, projection: { side: closest.side, edge: closest.edge } };
  }

  return {
    point: {
      x: clampValue(point.x, bounds.minX, bounds.maxX),
      y: clampValue(point.y, bounds.minY, bounds.maxY),
    },
    projection: undefined,
  };
}

function snapDragPointForTarget(
  shape: ClipShape,
  target: DragTarget,
  x: number,
  y: number,
): SnapPointResult {
  const start = target.dragOrigin?.handle;
  if (
    (target.kind === 'circle-center' &&
      (shape.kind === 'circle' || (shape.kind === 'raw' && shape.editable?.kind === 'circle'))) ||
    (target.kind === 'ellipse-center' &&
      (shape.kind === 'ellipse' || (shape.kind === 'raw' && shape.editable?.kind === 'ellipse')))
  ) {
    return snapPointToAnchors(x, y, [0, 50, 100], [0, 50, 100]);
  }

  if (shape.kind === 'inset' && target.kind === 'inset-radius') {
    const { x0, y0, x1, y1, width, height } = insetBox(shape);
    return snapPointToAnchors(
      x,
      y,
      [0, x0, x0 + width / 2, 50, x1, 100],
      [0, y0, y0 + height / 2, 50, y1, 100],
      start,
    );
  }

  return snapPointToAnchors(x, y, [0, 50, 100], [0, 50, 100], start);
}

function offsetDuplicatePoint(point: Point) {
  const dx =
    point.x + DUPLICATE_POINT_OFFSET <= 100 ? DUPLICATE_POINT_OFFSET : -DUPLICATE_POINT_OFFSET;
  const dy =
    point.y + DUPLICATE_POINT_OFFSET <= 100 ? DUPLICATE_POINT_OFFSET : -DUPLICATE_POINT_OFFSET;
  return {
    x: clampValue(point.x + dx, 0, 100),
    y: clampValue(point.y + dy, 0, 100),
  };
}

function makeInsetRadii(radius: number): CornerRadii {
  return {
    topLeft: { x: radius, y: radius },
    topRight: { x: radius, y: radius },
    bottomRight: { x: radius, y: radius },
    bottomLeft: { x: radius, y: radius },
  };
}

function radiusValuesClose(left: number, right: number) {
  return Math.abs(left - right) < 1;
}

function radiiClose(left: CornerRadii, right: CornerRadii) {
  return CORNERS.every(
    (corner) =>
      radiusValuesClose(left[corner].x, right[corner].x) &&
      radiusValuesClose(left[corner].y, right[corner].y),
  );
}

function hasRoundedCorners(radii: CornerRadii) {
  return CORNERS.some((corner) => radii[corner].x > 0 || radii[corner].y > 0);
}

function formatRadiusList(values: number[]) {
  const formatted = values.map(formatPercent);
  if (
    formatted[0] === formatted[1] &&
    formatted[0] === formatted[2] &&
    formatted[0] === formatted[3]
  ) {
    return formatted[0];
  }
  if (formatted[0] === formatted[2] && formatted[1] === formatted[3]) {
    return `${formatted[0]} ${formatted[1]}`;
  }
  if (formatted[1] === formatted[3]) {
    return `${formatted[0]} ${formatted[1]} ${formatted[2]}`;
  }
  return formatted.join(' ');
}

function formatRadii(radii: CornerRadii) {
  const horizontal = CORNERS.map((corner) => radii[corner].x);
  const vertical = CORNERS.map((corner) => radii[corner].y);
  const horizontalPart = formatRadiusList(horizontal);
  const verticalPart = formatRadiusList(vertical);
  return horizontalPart === verticalPart ? horizontalPart : `${horizontalPart} / ${verticalPart}`;
}

function formatInsetSides(shape: InsetShape) {
  return formatRadiusList([shape.top, shape.right, shape.bottom, shape.left]);
}

function formatCssUnitList(values: CssUnitValue[]) {
  return values.map(formatCssUnitValue).join(' ');
}

function formatRawEditableClipPath(editable: RawEditableClipPath) {
  if (editable.kind === 'polygon') {
    const prefix = editable.fillRule ? `${editable.fillRule}, ` : '';
    return `polygon(${prefix}${editable.points.map(formatCssCoordinatePoint).join(', ')})`;
  }

  if (editable.kind === 'circle') {
    const radius = formatCssUnitValue(editable.radius);
    const center = `${formatCssUnitValue(editable.cx)} ${formatCssUnitValue(editable.cy)}`;
    return `circle(${radius} at ${center})`;
  }

  if (editable.kind === 'ellipse') {
    const radii = `${formatCssUnitValue(editable.rx)} ${formatCssUnitValue(editable.ry)}`;
    const center = `${formatCssUnitValue(editable.cx)} ${formatCssUnitValue(editable.cy)}`;
    return `ellipse(${radii} at ${center})`;
  }

  const sides = formatCssUnitList([editable.top, editable.right, editable.bottom, editable.left]);
  if (!editable.radii) {
    return `inset(${sides})`;
  }
  const horizontal = formatCssUnitList(editable.radii.horizontal);
  const vertical = editable.radii.vertical
    ? ` / ${formatCssUnitList(editable.radii.vertical)}`
    : '';
  return `inset(${sides} round ${horizontal}${vertical})`;
}

function oppositeCorner(corner: CornerName): CornerName {
  if (corner === 'topLeft') {
    return 'bottomRight';
  }
  if (corner === 'topRight') {
    return 'bottomLeft';
  }
  if (corner === 'bottomRight') {
    return 'topLeft';
  }
  return 'topRight';
}

function oppositeInsetSide(side: InsetSide): InsetSide {
  if (side === 'top') {
    return 'bottom';
  }
  if (side === 'right') {
    return 'left';
  }
  if (side === 'bottom') {
    return 'top';
  }
  return 'right';
}

function insetSideForHandle(handle: HandleTarget): InsetSide | undefined {
  if (handle.kind === 'inset-top') {
    return 'top';
  }
  if (handle.kind === 'inset-right') {
    return 'right';
  }
  if (handle.kind === 'inset-bottom') {
    return 'bottom';
  }
  if (handle.kind === 'inset-left') {
    return 'left';
  }
  return undefined;
}

function insetModifierModeFromKeys(modifiers: KeyboardModifiers): InsetModifierMode {
  return modifiers.shiftKey ? 'all' : modifiers.altKey ? 'opposite' : 'single';
}

function isInsetHandle(handle: HandleTarget | undefined) {
  return Boolean(handle && (handle.kind === 'inset-radius' || insetSideForHandle(handle)));
}

function isInsetHandleAffected(
  activeHandle: HandleTarget | undefined,
  candidate: HandleTarget,
  mode: InsetModifierMode,
) {
  if (mode === 'single' || !activeHandle || handlesMatch(activeHandle, candidate)) {
    return false;
  }

  if (activeHandle.kind === 'inset-radius' && candidate.kind === 'inset-radius') {
    return mode === 'all' || candidate.corner === oppositeCorner(activeHandle.corner);
  }

  const activeSide = insetSideForHandle(activeHandle);
  const candidateSide = insetSideForHandle(candidate);
  if (!activeSide || !candidateSide) {
    return false;
  }

  return mode === 'all' || candidateSide === oppositeInsetSide(activeSide);
}

function cornerLabel(corner: CornerName) {
  if (corner === 'topLeft') {
    return 'top left';
  }
  if (corner === 'topRight') {
    return 'top right';
  }
  if (corner === 'bottomRight') {
    return 'bottom right';
  }
  return 'bottom left';
}

function pointsClose(left: Point[], right: Point[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((point, index) => {
    const other = right[index];
    return (
      other !== undefined && Math.abs(point.x - other.x) < 1 && Math.abs(point.y - other.y) < 1
    );
  });
}

function shapesClose(left: ClipShape, right: ClipShape) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'none' && right.kind === 'none') {
    return true;
  }
  if (left.kind === 'raw' && right.kind === 'raw') {
    return left.value === right.value;
  }
  if (left.kind === 'polygon' && right.kind === 'polygon') {
    return pointsClose(left.points, right.points);
  }
  if (left.kind === 'circle' && right.kind === 'circle') {
    return (
      Math.abs(left.radius - right.radius) < 1 &&
      Math.abs(left.cx - right.cx) < 1 &&
      Math.abs(left.cy - right.cy) < 1
    );
  }
  if (left.kind === 'ellipse' && right.kind === 'ellipse') {
    return (
      Math.abs(left.rx - right.rx) < 1 &&
      Math.abs(left.ry - right.ry) < 1 &&
      Math.abs(left.cx - right.cx) < 1 &&
      Math.abs(left.cy - right.cy) < 1
    );
  }
  if (left.kind === 'inset' && right.kind === 'inset') {
    return (
      Math.abs(left.top - right.top) < 1 &&
      Math.abs(left.right - right.right) < 1 &&
      Math.abs(left.bottom - right.bottom) < 1 &&
      Math.abs(left.left - right.left) < 1 &&
      radiiClose(left.radii, right.radii)
    );
  }
  if (left.kind === 'shape' && right.kind === 'shape') {
    return (
      left.value === right.value && (left.fillRule || 'nonzero') === (right.fillRule || 'nonzero')
    );
  }
  return false;
}

function pointsEqual(left: Point[], right: Point[]) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((point, index) => {
    const other = right[index];
    return other !== undefined && point.x === other.x && point.y === other.y;
  });
}

function radiiEqual(left: CornerRadii, right: CornerRadii) {
  return CORNERS.every(
    (corner) => left[corner].x === right[corner].x && left[corner].y === right[corner].y,
  );
}

function shapesEqual(left: ClipShape, right: ClipShape) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'none' && right.kind === 'none') {
    return true;
  }
  if (left.kind === 'raw' && right.kind === 'raw') {
    return left.value === right.value;
  }
  if (left.kind === 'polygon' && right.kind === 'polygon') {
    return pointsEqual(left.points, right.points);
  }
  if (left.kind === 'circle' && right.kind === 'circle') {
    return left.radius === right.radius && left.cx === right.cx && left.cy === right.cy;
  }
  if (left.kind === 'ellipse' && right.kind === 'ellipse') {
    return (
      left.rx === right.rx && left.ry === right.ry && left.cx === right.cx && left.cy === right.cy
    );
  }
  if (left.kind === 'inset' && right.kind === 'inset') {
    return (
      left.top === right.top &&
      left.right === right.right &&
      left.bottom === right.bottom &&
      left.left === right.left &&
      radiiEqual(left.radii, right.radii)
    );
  }
  if (left.kind === 'shape' && right.kind === 'shape') {
    return (
      left.value === right.value &&
      (left.fillRule || 'nonzero') === (right.fillRule || 'nonzero') &&
      (left.pathData || '') === (right.pathData || '')
    );
  }
  return false;
}

function handlesMatch(left: HandleTarget | undefined, right: HandleTarget) {
  if (!left || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'polygon-point' && right.kind === 'polygon-point') {
    return left.index === right.index;
  }
  if (left.kind === 'inset-radius' && right.kind === 'inset-radius') {
    return left.corner === right.corner;
  }
  return left.kind !== 'polygon-point' && left.kind !== 'inset-radius';
}

function isPolygonPointHandle(
  handle: HandleTarget | undefined,
): handle is Extract<HandleTarget, { kind: 'polygon-point' }> {
  return handle?.kind === 'polygon-point';
}

function handleListIncludes(handles: HandleTarget[], handle: HandleTarget) {
  return handles.some((item) => handlesMatch(item, handle));
}

function uniqueHandles(handles: HandleTarget[]) {
  return handles.reduce<HandleTarget[]>((unique, handle) => {
    if (!handleListIncludes(unique, handle)) {
      unique.push(handle);
    }
    return unique;
  }, []);
}

function previousSurvivingPolygonIndex(
  pointCount: number,
  deletedIndexes: Set<number>,
  referenceIndex: number,
) {
  for (let offset = 1; offset <= pointCount; offset += 1) {
    const index = (referenceIndex - offset + pointCount) % pointCount;
    if (!deletedIndexes.has(index)) {
      return index;
    }
  }
  return undefined;
}

function remapPolygonIndexAfterDelete(index: number, deletedIndexes: Set<number>) {
  let deletedBefore = 0;
  deletedIndexes.forEach((deletedIndex) => {
    if (deletedIndex < index) {
      deletedBefore += 1;
    }
  });
  return index - deletedBefore;
}

function handleKey(handle: HandleTarget) {
  if (handle.kind === 'polygon-point') {
    return `${handle.kind}:${handle.index}`;
  }
  if (handle.kind === 'inset-radius') {
    return `${handle.kind}:${handle.corner}`;
  }
  return handle.kind;
}

function handleFromDragTarget(target: DragTarget): HandleTarget {
  if (target.kind === 'polygon-point') {
    return { kind: target.kind, index: target.index };
  }
  if (target.kind === 'inset-radius') {
    return { kind: target.kind, corner: target.corner };
  }
  return { kind: target.kind };
}

const HANDLE_COLOR_CLASSES: readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
] = [
  'clip-path_color-a',
  'clip-path_color-b',
  'clip-path_color-c',
  'clip-path_color-d',
  'clip-path_color-e',
  'clip-path_color-f',
  'clip-path_color-g',
  'clip-path_color-h',
];

function handleColorClass(handle: HandleTarget) {
  if (handle.kind === 'polygon-point') {
    return HANDLE_COLOR_CLASSES[handle.index % HANDLE_COLOR_CLASSES.length] ?? 'clip-path_color-a';
  }
  if (handle.kind === 'circle-center' || handle.kind === 'ellipse-center') {
    return 'clip-path_color-center';
  }
  if (
    handle.kind === 'circle-radius' ||
    handle.kind === 'ellipse-rx' ||
    handle.kind === 'inset-top'
  ) {
    return 'clip-path_color-a';
  }
  if (handle.kind === 'ellipse-ry' || handle.kind === 'inset-right') {
    return 'clip-path_color-b';
  }
  if (handle.kind === 'inset-bottom') {
    return 'clip-path_color-c';
  }
  if (handle.kind === 'inset-left') {
    return 'clip-path_color-d';
  }
  if (handle.kind === 'inset-radius') {
    return (
      HANDLE_COLOR_CLASSES[(CORNERS.indexOf(handle.corner) + 4) % HANDLE_COLOR_CLASSES.length] ??
      'clip-path_color-a'
    );
  }
  return 'clip-path_color-a';
}

function polygonPointColorClass(index: number, colorClasses: string[] = []) {
  return (
    colorClasses[index] ||
    HANDLE_COLOR_CLASSES[index % HANDLE_COLOR_CLASSES.length] ||
    'clip-path_color-a'
  );
}

function normalizePolygonPointColors(count: number, colors: string[] = []) {
  return Array.from({ length: count }, (_, index) => polygonPointColorClass(index, colors));
}

function nextPolygonPointColor(colors: string[], insertIndex: number) {
  const blocked = new Set([colors[insertIndex - 1], colors[insertIndex]].filter(Boolean));
  const unusedColor = HANDLE_COLOR_CLASSES.find(
    (colorClass) => !colors.includes(colorClass) && !blocked.has(colorClass),
  );
  if (unusedColor) {
    return unusedColor;
  }
  return (
    HANDLE_COLOR_CLASSES.find((colorClass) => !blocked.has(colorClass)) || HANDLE_COLOR_CLASSES[0]
  );
}

function shorthandGroups<T>(items: T[], count = items.length) {
  const first = items[0];
  if (first === undefined) {
    return [];
  }
  const second = items[1] ?? first;
  const third = items[2] ?? first;
  const fourth = items[3] ?? second;
  if (count <= 1) {
    return [[first, second, third, fourth]];
  }
  if (count === 2) {
    return [
      [first, third],
      [second, fourth],
    ];
  }
  if (count === 3) {
    return [[first], [second, fourth], [third]];
  }
  return [[first], [second], [third], [fourth]];
}

const PRESETS: Record<string, ClipShape> = {
  [NONE_PRESET]: NONE_SHAPE,
  Polygon: {
    kind: 'polygon',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
  },
  Inset: { kind: 'inset', top: 12, right: 12, bottom: 12, left: 12, radii: makeInsetRadii(24) },
  Circle: { kind: 'circle', radius: 42, cx: 50, cy: 50 },
  Ellipse: { kind: 'ellipse', rx: 44, ry: 30, cx: 50, cy: 50 },
  Shape: { kind: 'shape', value: DEFAULT_SHAPE_VALUE, pathData: DEFAULT_SHAPE_PATH_DATA },
  [CUSTOM_PRESET]: CUSTOM_SHAPE,
};
const PRESET_NAMES = Object.keys(PRESETS);

function formatPolygon(points: Point[]) {
  const coords = points
    .map((point) => `${formatPercent(point.x)} ${formatPercent(point.y)}`)
    .join(', ');
  return `polygon(${coords})`;
}

function formatShapeValueFromPoints(points: Point[]) {
  const [firstPoint, ...restPoints] = points;
  if (!firstPoint) {
    return DEFAULT_SHAPE_VALUE;
  }

  return [
    `from ${formatPercent(firstPoint.x)} ${formatPercent(firstPoint.y)}`,
    ...restPoints.map((point) => `line to ${formatPercent(point.x)} ${formatPercent(point.y)}`),
    'close',
  ].join(', ');
}

function formatShapeCssPoint(point: ShapeCssPoint) {
  return `${point.x} ${point.y}`;
}

function mapShapeSubpathsToCss(
  subpaths: SvgShapeSubpath[],
  mapPoint: (point: Point) => ShapeCssPoint,
): ShapeCssSubpath[] {
  return subpaths.map((subpath) => ({
    start: mapPoint(subpath.start),
    commands: subpath.commands.map((command) => {
      if (command.kind === 'line') {
        return { kind: 'line' as const, to: mapPoint(command.to) };
      }
      if (command.kind === 'curve') {
        return {
          kind: 'curve' as const,
          to: mapPoint(command.to),
          control1: mapPoint(command.control1),
          ...(command.control2 ? { control2: mapPoint(command.control2) } : {}),
        };
      }
      return command;
    }),
  }));
}

function formatShapeValueFromCssSubpaths(subpaths: ShapeCssSubpath[]) {
  const [firstSubpath, ...restSubpaths] = subpaths;
  if (!firstSubpath) {
    return DEFAULT_SHAPE_VALUE;
  }

  const commandToShapeValue = (command: ShapeCssCommand) => {
    if (command.kind === 'line') {
      return `line to ${formatShapeCssPoint(command.to)}`;
    }
    if (command.kind === 'curve') {
      const control2 = command.control2 ? ` / ${formatShapeCssPoint(command.control2)}` : '';
      return [
        `curve to ${formatShapeCssPoint(command.to)}`,
        `with ${formatShapeCssPoint(command.control1)}${control2}`,
      ].join(' ');
    }
    return 'close';
  };
  // The first subpath opens `from` its start; each later one opens with a `move to`.
  const subpathCommands = (subpath: ShapeCssSubpath, opening: 'from' | 'move to') => [
    `${opening} ${formatShapeCssPoint(subpath.start)}`,
    ...subpath.commands.map(commandToShapeValue),
  ];

  return [
    ...subpathCommands(firstSubpath, 'from'),
    ...restSubpaths.flatMap((subpath) => subpathCommands(subpath, 'move to')),
  ].join(', ');
}

function formatShapeValueFromSubpaths(subpaths: SvgShapeSubpath[]) {
  return formatShapeValueFromCssSubpaths(
    mapShapeSubpathsToCss(subpaths, (point) => ({
      x: formatPercent(point.x),
      y: formatPercent(point.y),
    })),
  );
}

function formatPathDataFromPoints(points: Point[]) {
  const [firstPoint, ...restPoints] = points;
  if (!firstPoint) {
    return DEFAULT_SHAPE_PATH_DATA;
  }

  return [
    `M${firstPoint.x} ${firstPoint.y}`,
    ...restPoints.map((point) => `L${point.x} ${point.y}`),
    'Z',
  ].join('');
}

function formatPathDataFromSubpaths(subpaths: SvgShapeSubpath[]) {
  const pathData = subpaths.flatMap((subpath) => [
    `M${subpath.start.x} ${subpath.start.y}`,
    ...subpath.commands.map((command) => {
      if (command.kind === 'line') {
        return `L${command.to.x} ${command.to.y}`;
      }
      if (command.kind === 'curve') {
        return command.control2
          ? `C${command.control1.x} ${command.control1.y} ` +
              `${command.control2.x} ${command.control2.y} ` +
              `${command.to.x} ${command.to.y}`
          : `Q${command.control1.x} ${command.control1.y} ${command.to.x} ${command.to.y}`;
      }
      return 'Z';
    }),
  ]);

  return pathData.length ? pathData.join('') : DEFAULT_SHAPE_PATH_DATA;
}

function shapeFromPolygonPoints(points: Point[]): ShapeFunctionShape {
  return {
    kind: 'shape',
    value: formatShapeValueFromPoints(points),
    pathData: formatPathDataFromPoints(points),
  };
}

function shapeFromSvgSubpaths(
  subpaths: SvgShapeSubpath[],
  fillRule?: ShapeFunctionShape['fillRule'],
): ShapeFunctionShape {
  if (!subpaths.length) {
    return shapeFromPolygonPoints([]);
  }

  return {
    kind: 'shape',
    value: formatShapeValueFromSubpaths(subpaths),
    ...(fillRule ? { fillRule } : {}),
    pathData: formatPathDataFromSubpaths(subpaths),
  };
}

function svgShapeCommandPoints(command: SvgShapeCommand) {
  if (command.kind === 'close') {
    return [];
  }
  if (command.kind === 'curve') {
    return [command.to, command.control1, command.control2].filter(isDefined);
  }
  return [command.to];
}

function svgShapeSubpathPoints(subpaths: SvgShapeSubpath[]) {
  return subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.commands.flatMap(svgShapeCommandPoints),
  ]);
}

function svgShapeSubpathBounds(subpaths: SvgShapeSubpath[]): SvgShapeBounds | undefined {
  const points = svgShapeSubpathPoints(subpaths);
  if (!points.length) {
    return undefined;
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= SVG_POINT_EPSILON || height <= SVG_POINT_EPSILON) {
    return undefined;
  }

  return { minX, maxX, minY, maxY, width, height };
}

function svgShapeBoundsFromViewBox(viewBox: SvgViewBox): SvgShapeBounds | undefined {
  if (viewBox.width <= SVG_POINT_EPSILON || viewBox.height <= SVG_POINT_EPSILON) {
    return undefined;
  }
  return {
    minX: viewBox.x,
    maxX: viewBox.x + viewBox.width,
    minY: viewBox.y,
    maxY: viewBox.y + viewBox.height,
    width: viewBox.width,
    height: viewBox.height,
  };
}

function mapSvgShapeCommandPoints(
  command: SvgShapeCommand,
  mapper: (point: Point) => Point,
): SvgShapeCommand {
  if (command.kind === 'close') {
    return command;
  }
  if (command.kind === 'line') {
    return { ...command, to: mapper(command.to) };
  }
  return {
    kind: 'curve',
    to: mapper(command.to),
    control1: mapper(command.control1),
    ...(command.control2 ? { control2: mapper(command.control2) } : {}),
  };
}

function fitShapeSubpathsToPercentBox(
  subpaths: SvgShapeSubpath[],
  preferredBounds?: SvgShapeBounds | undefined,
) {
  const bounds = preferredBounds || svgShapeSubpathBounds(subpaths);
  if (!bounds) {
    return undefined;
  }

  const fitPoint = (point: Point) => ({
    x: ((point.x - bounds.minX) / bounds.width) * 100,
    y: ((point.y - bounds.minY) / bounds.height) * 100,
  });

  return subpaths.map((subpath) => ({
    start: fitPoint(subpath.start),
    commands: subpath.commands.map((command) => mapSvgShapeCommandPoints(command, fitPoint)),
  }));
}

function formatShapeContainCoordinate(
  offset: number,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
) {
  const sign = offset < 0 ? '-' : '+';
  const amount = Math.abs(offset);
  if (options.useVariable) {
    const variableName = sanitizeShapeScaleVariableName(options.variableName);
    if (variableName) {
      const amountScale = formatCssScaleNumber(amount / 100);
      return `calc(50% ${sign} ${amountScale} * var(${variableName}, 100cqw))`;
    }
  }
  return `calc(50% ${sign} ${formatCqw(amount)})`;
}

function resolveShapeScaleVarNames(options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS) {
  // Any empty name stays empty -> the coordinate emits the raw value instead of a var() wrapper.
  return {
    sizeVar: sanitizeShapeScaleVariableName(options.variableName || ''),
    offsetLeftVar: sanitizeShapeScaleVariableName(options.offsetLeftVariableName || ''),
    offsetTopVar: sanitizeShapeScaleVariableName(options.offsetTopVariableName || ''),
  };
}

// The span is WU (x) or HU (y); size = S (cqw); offset = OL/OT. See
// SHAPE_OFFSET_COORDINATE_PATTERN.
function formatShapeOffsetCoordinate(
  position: number,
  span: number,
  size: number,
  offset: number,
  sizeVar: string,
  offsetVar: string,
  axis: 'x' | 'y',
) {
  const travelUnit = axis === 'x' ? 'cqw' : 'cqh';
  // No variable -> emit the raw value (100cqw / 0.5) instead of a var(name, value) wrapper.
  const sizeToken = sizeVar
    ? `var(${sizeVar}, ${formatCssNumber(size)}cqw)`
    : `${formatCssNumber(size)}cqw`;
  const offsetToken = offsetVar
    ? `var(${offsetVar}, ${formatCssScaleNumber(offset)})`
    : formatCssScaleNumber(offset);
  const positionTerm = `${formatCssScaleNumber(position)} * ${sizeToken}`;
  const spanTerm = `${formatCssScaleNumber(span)} * ${sizeToken}`;
  return `calc(${positionTerm} + ${offsetToken} * (100${travelUnit} - ${spanTerm}))`;
}

type ShapeOffsetBounds = {
  minAx: number;
  minAy: number;
  wu: number;
  hu: number;
  size: number;
  ol: number;
  ot: number;
};

// Decompose a set of canvas points (0..100, 50 = center) into the offset model: size stays 100
// (the shape's width lives in WU), with OL/OT derived from the shape's near-edge position so the
// on-canvas appearance is preserved.
function shapeOffsetBoundsFromCanvasPoints(points: Point[]): ShapeOffsetBounds | undefined {
  if (!points.length) {
    return undefined;
  }
  const axs = points.map((point) => (point.x - 50) / 100);
  const ays = points.map((point) => (point.y - 50) / 100);
  const minAx = Math.min(...axs);
  const minAy = Math.min(...ays);
  const wu = Math.max(...axs) - minAx;
  const hu = Math.max(...ays) - minAy;
  const size = 100;
  const travelX = 100 - wu * size;
  const travelY = 100 - hu * size;
  // |travel| ~ 0 means the shape fills the axis; OL/OT are then indeterminate, so default to
  // centered.
  const ol =
    Math.abs(travelX) > SHAPE_OFFSET_TRAVEL_EPSILON
      ? (50 + minAx * 100) / travelX
      : DEFAULT_SHAPE_OFFSET_VALUE;
  const ot =
    Math.abs(travelY) > SHAPE_OFFSET_TRAVEL_EPSILON
      ? (50 + minAy * 100) / travelY
      : DEFAULT_SHAPE_OFFSET_VALUE;
  return { minAx, minAy, wu, hu, size, ol, ot };
}

function formatShapeOffsetPoint(
  point: Point,
  bounds: ShapeOffsetBounds,
  names: { sizeVar: string; offsetLeftVar: string; offsetTopVar: string },
): ShapeCssPoint {
  return {
    x: formatShapeOffsetCoordinate(
      (point.x - 50) / 100 - bounds.minAx,
      bounds.wu,
      bounds.size,
      bounds.ol,
      names.sizeVar,
      names.offsetLeftVar,
      'x',
    ),
    y: formatShapeOffsetCoordinate(
      (point.y - 50) / 100 - bounds.minAy,
      bounds.hu,
      bounds.size,
      bounds.ot,
      names.sizeVar,
      names.offsetTopVar,
      'y',
    ),
  };
}

function containShapeSubpathsToCss(
  subpaths: SvgShapeSubpath[],
  preferredBounds?: SvgShapeBounds | undefined,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
) {
  const bounds = preferredBounds || svgShapeSubpathBounds(subpaths);
  if (!bounds) {
    return undefined;
  }

  const names = resolveShapeScaleVarNames(options);
  const centerX = bounds.minX + bounds.width / 2;
  const centerY = bounds.minY + bounds.height / 2;
  // A freshly fitted SVG is normalized to its own bounds: x spans ±0.5 (WU = 1), y spans the aspect
  // ratio, centered (OL = OT = 0.5).
  const offsetBounds: ShapeOffsetBounds = {
    minAx: -0.5,
    minAy: -bounds.height / (2 * bounds.width),
    wu: 1,
    hu: bounds.height / bounds.width,
    size: 100,
    ol: DEFAULT_SHAPE_OFFSET_VALUE,
    ot: DEFAULT_SHAPE_OFFSET_VALUE,
  };

  return mapShapeSubpathsToCss(subpaths, (point) =>
    formatShapeOffsetPoint(
      {
        x: 50 + ((point.x - centerX) / bounds.width) * 100,
        y: 50 + ((point.y - centerY) / bounds.width) * 100,
      },
      offsetBounds,
      names,
    ),
  );
}

function formatClipPath(shape: ClipShape) {
  if (shape.kind === 'none') {
    return 'none';
  }
  if (shape.kind === 'raw') {
    return shape.editable ? formatRawEditableClipPath(shape.editable) : shape.value;
  }
  if (shape.kind === 'polygon') {
    return formatPolygon(shape.points);
  }
  if (shape.kind === 'shape') {
    const prefix = shape.fillRule && shape.fillRule !== 'nonzero' ? `${shape.fillRule} ` : '';
    return `shape(${prefix}${shape.value})`;
  }
  if (shape.kind === 'circle') {
    const center = `${formatPercent(shape.cx)} ${formatPercent(shape.cy)}`;
    return `circle(${formatPercent(shape.radius)} at ${center})`;
  }
  if (shape.kind === 'ellipse') {
    const radii = `${formatPercent(shape.rx)} ${formatPercent(shape.ry)}`;
    const center = `${formatPercent(shape.cx)} ${formatPercent(shape.cy)}`;
    return `ellipse(${radii} at ${center})`;
  }
  const sides = formatInsetSides(shape);
  return hasRoundedCorners(shape.radii)
    ? `inset(${sides} round ${formatRadii(shape.radii)})`
    : `inset(${sides})`;
}

function formatCodeValue(shape: ClipShape) {
  return shape.kind === 'none' ? '' : formatClipPath(shape);
}

function addPreviewVariableFallbacks(value: string) {
  return value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g, 'var($1, 1rem)');
}

function previewAxisSize(axis: 'x' | 'y', size: CanvasSize) {
  return axis === 'x' ? size.width : size.height;
}

function previewUnitPx(unit: string, axis: 'x' | 'y', size: CanvasSize) {
  const axisSize = previewAxisSize(axis, size);
  const normalized = unit.toLowerCase();
  const pxUnit = axisSize / 1600;

  if (normalized === '%') {
    return axisSize / 100;
  }
  if (normalized === 'px') {
    return pxUnit;
  }
  if (normalized === 'em' || normalized === 'rem' || normalized === 'lh' || normalized === 'rlh') {
    return axisSize / 100;
  }
  if (normalized === 'ch' || normalized === 'ex') {
    return axisSize / 200;
  }
  if (normalized === 'vw' || normalized === 'svw' || normalized === 'lvw' || normalized === 'dvw') {
    return size.width / 100;
  }
  if (normalized === 'vh' || normalized === 'svh' || normalized === 'lvh' || normalized === 'dvh') {
    return size.height / 100;
  }
  if (
    normalized === 'vmin' ||
    normalized === 'svmin' ||
    normalized === 'lvmin' ||
    normalized === 'dvmin'
  ) {
    return Math.min(size.width, size.height) / 100;
  }
  if (
    normalized === 'vmax' ||
    normalized === 'svmax' ||
    normalized === 'lvmax' ||
    normalized === 'dvmax'
  ) {
    return Math.max(size.width, size.height) / 100;
  }
  if (normalized === 'cqw' || normalized === 'cqi') {
    return size.width / 100;
  }
  if (normalized === 'cqh' || normalized === 'cqb') {
    return size.height / 100;
  }
  if (normalized === 'cqmin') {
    return Math.min(size.width, size.height) / 100;
  }
  if (normalized === 'cqmax') {
    return Math.max(size.width, size.height) / 100;
  }
  if (normalized === 'in') {
    return 96 * pxUnit;
  }
  if (normalized === 'cm') {
    return (96 / 2.54) * pxUnit;
  }
  if (normalized === 'mm') {
    return (96 / 25.4) * pxUnit;
  }
  if (normalized === 'q') {
    return (96 / 101.6) * pxUnit;
  }
  if (normalized === 'pt') {
    return (96 / 72) * pxUnit;
  }
  if (normalized === 'pc') {
    return 16 * pxUnit;
  }
  return axisSize / 100;
}

function previewCssLengthPercentageToken(token: string, axis: 'x' | 'y', size: CanvasSize) {
  const match = token.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%|[a-z][a-z0-9]*)$/i);
  if (!match) {
    return token;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return token;
  }

  const unit = match[2];
  if (unit === undefined) {
    return token;
  }
  const axisSize = previewAxisSize(axis, size);
  if (axisSize <= 0) {
    return token;
  }
  const percent =
    unit === '%' ? value : ((value * previewUnitPx(unit, axis, size)) / axisSize) * 100;
  return `${formatCssScaleNumber(percent)}%`;
}

function addPreviewVariableFallbacksForAxis(value: string, axis: 'x' | 'y', size: CanvasSize) {
  const fallback = previewCssLengthPercentageToken('1rem', axis, size);
  return value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g, `var($1, ${fallback})`);
}

function previewCssCoordinateToken(value: string, axis: 'x' | 'y', size: CanvasSize) {
  const withFallbacks = addPreviewVariableFallbacksForAxis(value, axis, size);
  return withFallbacks.replace(
    /([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%|[a-z][a-z0-9]*)\b/gi,
    (match, number: string, unit: string, offset: number, source: string) => {
      const previous = source[offset - 1];
      if (previous && /[a-zA-Z0-9_-]/.test(previous)) {
        return match;
      }
      return previewCssLengthPercentageToken(`${number}${unit}`, axis, size);
    },
  );
}

function formatCssUnitValueForPreview(value: CssUnitValue, axis: 'x' | 'y', size: CanvasSize) {
  return previewCssCoordinateToken(formatCssUnitValue(value), axis, size);
}

function expandCssShorthandTokens(tokens: string[]) {
  const first = tokens[0] || '0%';
  return [first, tokens[1] || first, tokens[2] || first, tokens[3] || tokens[1] || first];
}

function formatRawEditableClipPathForPreview(editable: RawEditableClipPath, size: CanvasSize) {
  if (editable.kind === 'polygon') {
    const prefix = editable.fillRule ? `${editable.fillRule}, ` : '';
    const points = editable.points
      .map(
        (point) =>
          `${formatCssCoordinateValueForPreview(point.x, 'x', size)} ` +
          formatCssCoordinateValueForPreview(point.y, 'y', size),
      )
      .join(', ');
    return `polygon(${prefix}${points})`;
  }

  if (editable.kind === 'circle') {
    const radius = formatCssUnitValueForPreview(editable.radius, 'x', size);
    const centerX = formatCssUnitValueForPreview(editable.cx, 'x', size);
    const centerY = formatCssUnitValueForPreview(editable.cy, 'y', size);
    return [`circle(${radius}`, `at ${centerX} ${centerY})`].join(' ');
  }

  if (editable.kind === 'ellipse') {
    const radiusX = formatCssUnitValueForPreview(editable.rx, 'x', size);
    const radiusY = formatCssUnitValueForPreview(editable.ry, 'y', size);
    const centerX = formatCssUnitValueForPreview(editable.cx, 'x', size);
    const centerY = formatCssUnitValueForPreview(editable.cy, 'y', size);
    return [`ellipse(${radiusX} ${radiusY}`, `at ${centerX} ${centerY})`].join(' ');
  }

  const sides = [
    formatCssUnitValueForPreview(editable.top, 'y', size),
    formatCssUnitValueForPreview(editable.right, 'x', size),
    formatCssUnitValueForPreview(editable.bottom, 'y', size),
    formatCssUnitValueForPreview(editable.left, 'x', size),
  ].join(' ');
  if (!editable.radii) {
    return `inset(${sides})`;
  }

  const horizontalValues = expandCssUnitValues(editable.radii.horizontal);
  const verticalValues = expandCssUnitValues(editable.radii.vertical || editable.radii.horizontal);
  const horizontal = horizontalValues
    .map((value) => formatCssUnitValueForPreview(value, 'x', size))
    .join(' ');
  const vertical = verticalValues
    .map((value) => formatCssUnitValueForPreview(value, 'y', size))
    .join(' ');
  const verticalSuffix = horizontal === vertical ? '' : ` / ${vertical}`;
  return `inset(${sides} round ${horizontal}${verticalSuffix})`;
}

function formatShapeFunctionForPreview(shape: ShapeFunctionShape, size: CanvasSize) {
  const subpaths = parseShapeCssSubpaths(shape.value);
  const prefix = shape.fillRule && shape.fillRule !== 'nonzero' ? `${shape.fillRule} ` : '';
  if (!subpaths) {
    return `shape(${prefix}${addPreviewVariableFallbacks(shape.value)})`;
  }

  const transformed = mapShapeCssSubpathPoints(subpaths, (point) => ({
    x: previewCssCoordinateToken(point.x, 'x', size),
    y: previewCssCoordinateToken(point.y, 'y', size),
  }));
  return `shape(${prefix}${formatShapeValueFromCssSubpaths(transformed)})`;
}

// A raw `x y` coordinate pair, each token given its preview fallbacks for its own axis.
function previewCssCoordinatePair(xToken: string, yToken: string, size: CanvasSize) {
  return (
    `${previewCssCoordinateToken(xToken, 'x', size)} ` +
    previewCssCoordinateToken(yToken, 'y', size)
  );
}

function formatRawClipPathStringForPreview(value: string, size: CanvasSize) {
  const polygonMatch = value.match(/^polygon\s*\((.*)\)$/is);
  if (polygonMatch?.[1]) {
    return previewRawPolygon(polygonMatch[1], size);
  }
  const circleMatch = value.match(/^circle\s*\((.*)\)$/is);
  if (circleMatch?.[1]) {
    return previewRawCircle(circleMatch[1], size);
  }
  const ellipseMatch = value.match(/^ellipse\s*\((.*)\)$/is);
  if (ellipseMatch?.[1]) {
    return previewRawEllipse(ellipseMatch[1], size);
  }
  const insetMatch = value.match(/^inset\s*\((.*)\)$/is);
  if (insetMatch?.[1]) {
    return previewRawInset(insetMatch[1], size);
  }
  return addPreviewVariableFallbacks(value);
}

// `polygon(…)`'s arguments with each coordinate resolved for the preview canvas.
function previewRawPolygon(argument: string, size: CanvasSize) {
  const parts = splitShapeCommandList(argument);
  const fillRule = /^(evenodd|nonzero)$/i.test(parts[0] || '') ? parts[0] : undefined;
  const pointParts = fillRule ? parts.slice(1) : parts;
  const points = pointParts.map((part) => {
    const tokens = splitTopLevelWhitespace(part);
    return tokens.length === 2
      ? previewCssCoordinatePair(tokens[0] ?? '', tokens[1] ?? '', size)
      : part;
  });
  return `polygon(${[fillRule, ...points].filter(Boolean).join(', ')})`;
}

// The ` at <x> <y>` of a circle or ellipse, resolved for the preview canvas.
function previewCenterSuffix(centerPart: string | undefined, size: CanvasSize) {
  const centerTokens = centerPart ? splitTopLevelWhitespace(centerPart) : [];
  if (centerTokens.length === 2) {
    return ` at ${previewCssCoordinatePair(centerTokens[0] ?? '', centerTokens[1] ?? '', size)}`;
  }
  return centerPart ? ` at ${centerPart}` : '';
}

function previewRawCircle(argument: string, size: CanvasSize) {
  const [radiusPart, centerPart] = splitTopLevelKeyword(argument, 'at');
  const radiusTokens = splitTopLevelWhitespace(radiusPart);
  const radius = radiusTokens[0]
    ? previewCssCoordinateToken(radiusTokens[0], 'x', size)
    : radiusPart;
  return `circle(${radius}${previewCenterSuffix(centerPart, size)})`;
}

function previewRawEllipse(argument: string, size: CanvasSize) {
  const [radiiPart, centerPart] = splitTopLevelKeyword(argument, 'at');
  const radii = splitTopLevelWhitespace(radiiPart);
  const previewRadii =
    radii.length === 2 ? previewCssCoordinatePair(radii[0] ?? '', radii[1] ?? '', size) : radiiPart;
  return `ellipse(${previewRadii}${previewCenterSuffix(centerPart, size)})`;
}

function previewRawInset(argument: string, size: CanvasSize) {
  const [insetPart, roundPart] = splitTopLevelKeyword(argument, 'round');
  const sides = splitTopLevelWhitespace(insetPart);
  const previewSides =
    sides.length >= 1 && sides.length <= 4
      ? expandCssShorthandTokens(sides)
          .map((token, index) =>
            previewCssCoordinateToken(token, index % 2 === 0 ? 'y' : 'x', size),
          )
          .join(' ')
      : insetPart;
  if (!roundPart) {
    return `inset(${previewSides})`;
  }

  const radiusParts = splitTopLevelChar(roundPart, '/');
  const horizontalTokens = splitTopLevelWhitespace(radiusParts[0] || '');
  const verticalTokens = splitTopLevelWhitespace(radiusParts[1] || radiusParts[0] || '');
  const horizontal = expandCssShorthandTokens(horizontalTokens)
    .map((token) => previewCssCoordinateToken(token, 'x', size))
    .join(' ');
  const vertical = expandCssShorthandTokens(verticalTokens)
    .map((token) => previewCssCoordinateToken(token, 'y', size))
    .join(' ');
  const verticalSuffix = horizontal === vertical ? '' : ` / ${vertical}`;
  return `inset(${previewSides} round ${horizontal}${verticalSuffix})`;
}

function formatClipPathForPreview(shape: ClipShape, css: string, size: CanvasSize | undefined) {
  if (shape.kind === 'none') {
    return 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';
  }
  if (!size) {
    return addPreviewVariableFallbacks(css);
  }
  if (shape.kind === 'raw') {
    return shape.editable
      ? formatRawEditableClipPathForPreview(shape.editable, size)
      : formatRawClipPathStringForPreview(shape.value, size);
  }
  if (shape.kind === 'shape') {
    return formatShapeFunctionForPreview(shape, size);
  }
  return addPreviewVariableFallbacks(css);
}

function tokenRangesFromParts(value: string, parts: string[]) {
  const ranges: Array<{ from: number; to: number }> = [];
  let searchFrom = 0;

  parts.forEach((part) => {
    const token = part.trim();
    if (!token) {
      return;
    }
    const index = value.indexOf(token, searchFrom);
    if (index < 0) {
      return;
    }
    ranges.push({ from: index, to: index + token.length });
    searchFrom = index + token.length;
  });

  return ranges;
}

function functionContentRange(value: string) {
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  return open >= 0 && close > open
    ? { from: open + 1, to: close, content: value.slice(open + 1, close) }
    : undefined;
}

function splitPolygonCoordinateTokens(value: string) {
  const range = functionContentRange(value);
  if (!range) {
    return [];
  }
  const parts = splitShapeCommandList(range.content);
  const pointParts = /^(evenodd|nonzero)$/i.test(parts[0] || '') ? parts.slice(1) : parts;
  return pointParts.flatMap((part) => splitTopLevelWhitespace(part));
}

function splitCircleCoordinateTokens(value: string) {
  const range = functionContentRange(value);
  if (!range) {
    return [];
  }
  const [radiusPart, centerPart] = splitTopLevelKeyword(range.content, 'at');
  return [
    ...splitTopLevelWhitespace(radiusPart),
    ...(centerPart ? splitTopLevelWhitespace(centerPart) : []),
  ];
}

function splitEllipseCoordinateTokens(value: string) {
  return splitCircleCoordinateTokens(value);
}

function splitInsetCoordinateTokens(value: string) {
  const range = functionContentRange(value);
  if (!range) {
    return [];
  }
  const [insetPart, roundPart] = splitTopLevelKeyword(range.content, 'round');
  const tokens = [...splitTopLevelWhitespace(insetPart)];
  if (!roundPart) {
    return tokens;
  }

  splitTopLevelChar(roundPart, '/').forEach((part) => {
    tokens.push(...splitTopLevelWhitespace(part));
  });
  return tokens;
}

function clipPathValueTokenRanges(value: string, shape: ClipShape) {
  if (shape.kind === 'polygon' || (shape.kind === 'raw' && shape.editable?.kind === 'polygon')) {
    return tokenRangesFromParts(value, splitPolygonCoordinateTokens(value));
  }
  if (shape.kind === 'circle' || (shape.kind === 'raw' && shape.editable?.kind === 'circle')) {
    return tokenRangesFromParts(value, splitCircleCoordinateTokens(value));
  }
  if (shape.kind === 'ellipse' || (shape.kind === 'raw' && shape.editable?.kind === 'ellipse')) {
    return tokenRangesFromParts(value, splitEllipseCoordinateTokens(value));
  }
  if (shape.kind === 'inset' || (shape.kind === 'raw' && shape.editable?.kind === 'inset')) {
    return tokenRangesFromParts(value, splitInsetCoordinateTokens(value));
  }
  return [];
}

function codeTokenClassName(colorClass: string) {
  return `clip-path_code-token ${colorClass}`;
}

type ClipPathCodeHighlight = CodeEditorTokenHighlight & {
  colorClass: string;
  handles: HandleTarget[];
};

function buildClipPathCodeHighlights(
  shape: ClipShape,
  value: string,
  polygonPointColors: string[] = [],
): ClipPathCodeHighlight[] {
  const ranges = clipPathValueTokenRanges(value, shape);
  const highlights: ClipPathCodeHighlight[] = [];
  const addHighlight: AddCodeHighlight = (range, handles, colorClass) => {
    const firstHandle = handles[0];
    if (!range || !firstHandle) {
      return;
    }
    const resolvedColorClass = colorClass ?? handleColorClass(firstHandle);
    highlights.push({
      ...range,
      handles,
      colorClass: resolvedColorClass,
      className: codeTokenClassName(resolvedColorClass),
    });
  };
  // A raw value is highlighted by the geometry it was parsed into, a shape by its own.
  const geometry = shape.kind === 'raw' ? shape.editable : shape;
  if (geometry?.kind === 'polygon') {
    geometry.points.forEach((_, index) => {
      const handle: HandleTarget = { kind: 'polygon-point', index };
      const colorClass = polygonPointColorClass(index, polygonPointColors);
      addHighlight(ranges[index * 2], [handle], colorClass);
      addHighlight(ranges[index * 2 + 1], [handle], colorClass);
    });
  } else if (geometry?.kind === 'circle') {
    const radiusHandle: HandleTarget = { kind: 'circle-radius' };
    const centerHandle: HandleTarget = { kind: 'circle-center' };
    addHighlight(ranges[0], [radiusHandle]);
    addHighlight(ranges[1], [centerHandle]);
    addHighlight(ranges[2], [centerHandle]);
  } else if (geometry?.kind === 'ellipse') {
    const rxHandle: HandleTarget = { kind: 'ellipse-rx' };
    const ryHandle: HandleTarget = { kind: 'ellipse-ry' };
    const centerHandle: HandleTarget = { kind: 'ellipse-center' };
    addHighlight(ranges[0], [rxHandle]);
    addHighlight(ranges[1], [ryHandle]);
    addHighlight(ranges[2], [centerHandle]);
    addHighlight(ranges[3], [centerHandle]);
  } else if (geometry?.kind === 'inset') {
    addInsetCodeHighlights(value, ranges, addHighlight);
  }
  return highlights;
}

// Records one highlighted code range and the handles it belongs to.
type AddCodeHighlight = (
  range: { from: number; to: number } | undefined,
  handles: HandleTarget[],
  colorClass?: string,
) => void;

// An inset's code ranges: the side lengths before `round`, then the horizontal and
// vertical radii either side of the `/`, each shorthand token owning the handles it
// sets.
function addInsetCodeHighlights(
  value: string,
  ranges: Array<{ from: number; to: number }>,
  addHighlight: AddCodeHighlight,
): void {
  const roundMatch = value.match(/\bround\b/i);
  const roundIndex = roundMatch?.index ?? -1;
  const sideRanges = roundIndex >= 0 ? ranges.filter((range) => range.from < roundIndex) : ranges;
  const radiusRanges = roundIndex >= 0 ? ranges.filter((range) => range.from > roundIndex) : [];
  const sideHandles: HandleTarget[] = [
    { kind: 'inset-top' },
    { kind: 'inset-right' },
    { kind: 'inset-bottom' },
    { kind: 'inset-left' },
  ];
  shorthandGroups(sideHandles, sideRanges.length).forEach((handles, index) => {
    addHighlight(
      sideRanges[index],
      handles,
      HANDLE_COLOR_CLASSES[index % HANDLE_COLOR_CLASSES.length],
    );
  });

  const radiusHandles: HandleTarget[] = CORNERS.map((corner) => ({
    kind: 'inset-radius',
    corner,
  }));
  const slashIndex = roundIndex >= 0 ? value.indexOf('/', roundIndex) : -1;
  const horizontalRadiusRanges =
    slashIndex >= 0 ? radiusRanges.filter((range) => range.from < slashIndex) : radiusRanges;
  const verticalRadiusRanges =
    slashIndex >= 0 ? radiusRanges.filter((range) => range.from > slashIndex) : [];
  for (const radiusRangeList of [horizontalRadiusRanges, verticalRadiusRanges]) {
    shorthandGroups(radiusHandles, radiusRangeList.length).forEach((handles, index) => {
      addHighlight(
        radiusRangeList[index],
        handles,
        HANDLE_COLOR_CLASSES[(index + 4) % HANDLE_COLOR_CLASSES.length],
      );
    });
  }
}

function parsePercent(value: string): number | undefined {
  if (value.trim() === '0') {
    return 0;
  }
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  return match?.[1] ? parseFloat(match[1]) : undefined;
}

function splitTopLevelWhitespace(value: string) {
  const tokens: string[] = [];
  let depth = 0;
  let start: number | undefined = undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
    }

    if (char !== undefined && /\s/.test(char) && depth === 0) {
      if (start !== undefined) {
        tokens.push(value.slice(start, index));
        start = undefined;
      }
    } else if (start === undefined) {
      start = index;
    }
  }

  if (start !== undefined) {
    tokens.push(value.slice(start));
  }
  return tokens.map((token) => token.trim()).filter(Boolean);
}

function splitTopLevelChar(value: string, separator: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
    }
    if (char === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function splitTopLevelKeyword(value: string, keyword: string) {
  let depth = 0;
  const lowerValue = value.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
    }
    if (depth !== 0 || lowerValue.slice(index, index + lowerKeyword.length) !== lowerKeyword) {
      continue;
    }

    const before = value[index - 1];
    const after = value[index + lowerKeyword.length];
    if ((before && !/\s/.test(before)) || (after && !/\s/.test(after))) {
      continue;
    }

    return [value.slice(0, index).trim(), value.slice(index + lowerKeyword.length).trim()] as const;
  }

  return [value.trim(), undefined] as const;
}

function hasBalancedParens(value: string) {
  let depth = 0;
  for (const char of value) {
    if (char === '(') {
      depth += 1;
    }
    if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function isCssLengthPercentageToken(value: string) {
  const token = value.trim();
  if (!token) {
    return false;
  }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(token)) {
    return Number(token) === 0;
  }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:%|[a-z][a-z0-9]*)$/i.test(token)) {
    return true;
  }
  if (/^[a-z_][a-z0-9_-]*\(.*\)$/i.test(token)) {
    return hasBalancedParens(token);
  }
  return false;
}

function parseCssUnitValue(value: string): CssUnitValue | undefined {
  const token = value.trim();
  const match = token.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%|[a-z][a-z0-9]*)?$/i);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const unit = match[2] || (parsed === 0 ? '%' : '');
  return unit ? { value: parsed, unit } : undefined;
}

function parseCssCoordinateValue(value: string): CssCoordinateValue | undefined {
  const unitValue = parseCssUnitValue(value);
  if (unitValue) {
    return unitValue;
  }
  return isCssLengthPercentageToken(value) ? { expression: value.trim() } : undefined;
}

function parseCssUnitList(value: string, min: number, max: number) {
  const tokens = splitTopLevelWhitespace(value);
  if (tokens.length < min || tokens.length > max) {
    return undefined;
  }
  const values = tokens.map(parseCssUnitValue);
  return values.every(isDefined) ? values.filter(isDefined) : undefined;
}

function validLengthPercentageList(value: string, min: number, max: number) {
  const tokens = splitTopLevelWhitespace(value);
  return tokens.length >= min && tokens.length <= max && tokens.every(isCssLengthPercentageToken);
}

function validRawCenter(value: string | undefined) {
  return !value || validLengthPercentageList(value, 2, 2);
}

function parsePolygon(value: string): Point[] | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/polygon\s*\(([^)]+)\)/i);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }
  const parts = content.split(',');
  const points: Point[] = [];
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length !== 2) {
      return undefined;
    }
    const x = parsePercent(tokens[0] ?? '');
    const y = parsePercent(tokens[1] ?? '');
    if (x === undefined || y === undefined) {
      return undefined;
    }
    points.push({ x, y });
  }
  return points.length >= 3 ? points : undefined;
}

function parseCenter(value: string): Point | undefined {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length !== 2) {
    return undefined;
  }
  const x = parsePercent(tokens[0] ?? '');
  const y = parsePercent(tokens[1] ?? '');
  return x === undefined || y === undefined ? undefined : { x, y };
}

function parseCircle(value: string): CircleShape | undefined {
  const match = value.match(/^circle\s*\((.*)\)$/i);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }
  const [radiusPart = '', centerPart] = content.split(/\s+at\s+/i).map((part) => part.trim());
  const radius = parsePercent(radiusPart);
  if (radius === undefined) {
    return undefined;
  }
  const center = centerPart ? parseCenter(centerPart) : { x: 50, y: 50 };
  return center ? { kind: 'circle', radius, cx: center.x, cy: center.y } : undefined;
}

function parseEllipse(value: string): EllipseShape | undefined {
  const match = value.match(/^ellipse\s*\((.*)\)$/i);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }
  const [radiiPart = '', centerPart] = content.split(/\s+at\s+/i).map((part) => part.trim());
  const radii = radiiPart.split(/\s+/);
  if (radii.length !== 2) {
    return undefined;
  }
  const rx = parsePercent(radii[0] ?? '');
  const ry = parsePercent(radii[1] ?? '');
  if (rx === undefined || ry === undefined) {
    return undefined;
  }
  const center = centerPart ? parseCenter(centerPart) : { x: 50, y: 50 };
  return center ? { kind: 'ellipse', rx, ry, cx: center.x, cy: center.y } : undefined;
}

function expandRadiusValues(values: number[]): [number, number, number, number] | undefined {
  if (values.length < 1 || values.length > 4) {
    return undefined;
  }
  const topLeft = values[0];
  if (topLeft === undefined) {
    return undefined;
  }
  const topRight = values[1] ?? topLeft;
  const bottomRight = values[2] ?? topLeft;
  const bottomLeft = values[3] ?? values[1] ?? topLeft;
  return [topLeft, topRight, bottomRight, bottomLeft];
}

function parseRadiusList(value: string): [number, number, number, number] | undefined {
  const values = value.trim().split(/\s+/).filter(Boolean).map(parsePercent);
  if (values.length < 1 || values.length > 4 || values.some((item) => item === undefined)) {
    return undefined;
  }
  return expandRadiusValues(values.filter(isDefined));
}

function parseInsetRadii(value: string | undefined): CornerRadii | undefined {
  if (!value) {
    return makeInsetRadii(0);
  }
  const parts = value.split(/\s*\/\s*/);
  if (parts.length > 2) {
    return undefined;
  }
  const horizontal = parseRadiusList(parts[0] ?? '');
  if (!horizontal) {
    return undefined;
  }
  const vertical = parts[1] ? parseRadiusList(parts[1]) : horizontal;
  if (!vertical) {
    return undefined;
  }

  return {
    topLeft: { x: horizontal[0], y: vertical[0] },
    topRight: { x: horizontal[1], y: vertical[1] },
    bottomRight: { x: horizontal[2], y: vertical[2] },
    bottomLeft: { x: horizontal[3], y: vertical[3] },
  };
}

function parseInset(value: string): InsetShape | undefined {
  const match = value.match(/^inset\s*\((.*)\)$/i);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }
  const [insetPart = '', roundPart] = content.split(/\s+round\s+/i);
  const values = insetPart.trim().split(/\s+/).map(parsePercent);
  if (values.length < 1 || values.length > 4 || values.some((item) => item === undefined)) {
    return undefined;
  }
  const nums = values.filter(isDefined);
  const top = nums[0];
  if (top === undefined) {
    return undefined;
  }
  const right = nums[1] ?? top;
  const bottom = nums[2] ?? top;
  const left = nums[3] ?? nums[1] ?? top;
  const radii = parseInsetRadii(roundPart);
  return radii ? { kind: 'inset', top, right, bottom, left, radii } : undefined;
}

function isCssRadiusToken(value: string) {
  return isCssLengthPercentageToken(value) || /^(closest-side|farthest-side)$/i.test(value.trim());
}

function validRawRadiusList(value: string, min: number, max: number) {
  const tokens = splitTopLevelWhitespace(value);
  return tokens.length >= min && tokens.length <= max && tokens.every(isCssRadiusToken);
}

function validRawInsetRadii(value: string | undefined) {
  if (!value) {
    return true;
  }
  const parts = splitTopLevelChar(value, '/');
  return (
    parts.length >= 1 &&
    parts.length <= 2 &&
    validLengthPercentageList(parts[0] ?? '', 1, 4) &&
    (!parts[1] || validLengthPercentageList(parts[1], 1, 4))
  );
}

function parseRawPolygon(value: string): RawClipPathShape | undefined {
  const match = value.match(/^polygon\s*\((.*)\)$/is);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }

  const parts = splitShapeCommandList(content);
  const fillRule = parseFillRule(parts[0]);
  const pointParts = fillRule ? parts.slice(1) : parts;
  if (pointParts.length < 3) {
    return undefined;
  }

  const parsedPoints: CssCoordinatePoint[] = [];
  const valid = pointParts.every((part) => {
    const tokens = splitTopLevelWhitespace(part);
    const x = parseCssCoordinateValue(tokens[0] || '');
    const y = parseCssCoordinateValue(tokens[1] || '');
    if (tokens.length === 2 && x && y) {
      parsedPoints.push({ x, y });
      return true;
    }
    return tokens.length === 2 && tokens.every(isCssLengthPercentageToken);
  });

  if (!valid) {
    return undefined;
  }
  const editable =
    parsedPoints.length === pointParts.length
      ? { kind: 'polygon' as const, points: parsedPoints, ...(fillRule ? { fillRule } : {}) }
      : undefined;
  return {
    kind: 'raw',
    value: value.trim(),
    preset: 'Polygon',
    ...(editable ? { editable } : {}),
  };
}

function parseRawCircle(value: string): RawClipPathShape | undefined {
  const match = value.match(/^circle\s*\((.*)\)$/is);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }

  const [radiusPart, centerPart] = splitTopLevelKeyword(content, 'at');
  const radiusTokens = splitTopLevelWhitespace(radiusPart);
  const validRadius = radiusTokens.length === 1 && isCssRadiusToken(radiusTokens[0] ?? '');
  if (!validRadius || !validRawCenter(centerPart)) {
    return undefined;
  }

  const centerTokens = centerPart ? splitTopLevelWhitespace(centerPart) : [];
  const radius = parseCssUnitValue(radiusTokens[0] ?? '');
  const cx = centerPart ? parseCssUnitValue(centerTokens[0] || '') : { value: 50, unit: '%' };
  const cy = centerPart ? parseCssUnitValue(centerTokens[1] || '') : { value: 50, unit: '%' };
  const editable = radius && cx && cy ? { kind: 'circle' as const, radius, cx, cy } : undefined;
  return {
    kind: 'raw',
    value: value.trim(),
    preset: 'Circle',
    ...(editable ? { editable } : {}),
  };
}

function parseRawEllipse(value: string): RawClipPathShape | undefined {
  const match = value.match(/^ellipse\s*\((.*)\)$/is);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }

  const [radiiPart, centerPart] = splitTopLevelKeyword(content, 'at');
  if (!validRawRadiusList(radiiPart, 2, 2) || !validRawCenter(centerPart)) {
    return undefined;
  }

  const radii = splitTopLevelWhitespace(radiiPart);
  const center = centerPart ? splitTopLevelWhitespace(centerPart) : [];
  const rx = parseCssUnitValue(radii[0] || '');
  const ry = parseCssUnitValue(radii[1] || '');
  const cx = centerPart ? parseCssUnitValue(center[0] || '') : { value: 50, unit: '%' };
  const cy = centerPart ? parseCssUnitValue(center[1] || '') : { value: 50, unit: '%' };
  const editable = rx && ry && cx && cy ? { kind: 'ellipse' as const, rx, ry, cx, cy } : undefined;
  return {
    kind: 'raw',
    value: value.trim(),
    preset: 'Ellipse',
    ...(editable ? { editable } : {}),
  };
}

function parseRawInset(value: string): RawClipPathShape | undefined {
  const match = value.match(/^inset\s*\((.*)\)$/is);
  const content = match?.[1];
  if (!content) {
    return undefined;
  }

  const [insetPart, roundPart] = splitTopLevelKeyword(content, 'round');
  if (!validLengthPercentageList(insetPart, 1, 4) || !validRawInsetRadii(roundPart)) {
    return undefined;
  }

  const sideValues = parseCssUnitList(insetPart, 1, 4);
  const top = sideValues?.[0];
  const right = sideValues?.[1] ?? sideValues?.[0];
  const bottom = sideValues?.[2] ?? sideValues?.[0];
  const left = sideValues?.[3] ?? sideValues?.[1] ?? sideValues?.[0];
  const radiusParts = roundPart ? splitTopLevelChar(roundPart, '/') : [];
  const horizontal = radiusParts[0] ? parseCssUnitList(radiusParts[0], 1, 4) : undefined;
  const vertical = radiusParts[1] ? parseCssUnitList(radiusParts[1], 1, 4) : undefined;
  const editable =
    top && right && bottom && left && (!roundPart || horizontal)
      ? {
          kind: 'inset' as const,
          top,
          right,
          bottom,
          left,
          ...(horizontal ? { radii: { horizontal, ...(vertical ? { vertical } : {}) } } : {}),
        }
      : undefined;

  return {
    kind: 'raw',
    value: value.trim(),
    preset: 'Inset',
    ...(editable ? { editable } : {}),
  };
}

function parseRawBasicClipPath(value: string): RawClipPathShape | undefined {
  return (
    parseRawPolygon(value) ||
    parseRawCircle(value) ||
    parseRawEllipse(value) ||
    parseRawInset(value)
  );
}

function parseCustomClipPath(value: string): RawClipPathShape | undefined {
  const trimmed = value.trim().replace(/;$/, '');
  const lowerValue = trimmed.toLowerCase();
  if (!trimmed || lowerValue === 'none') {
    return undefined;
  }
  if (CSS_GLOBAL_CLIP_PATH_VALUES.has(lowerValue)) {
    return { kind: 'raw', value: trimmed, preset: CUSTOM_PRESET };
  }
  if (CSS_GEOMETRY_BOX_CLIP_PATH_VALUES.has(lowerValue)) {
    return { kind: 'raw', value: trimmed, preset: CUSTOM_PRESET };
  }
  if (/^[a-z][a-z0-9-]*\s*\(/is.test(trimmed) && hasBalancedParens(trimmed)) {
    return { kind: 'raw', value: trimmed, preset: CUSTOM_PRESET };
  }
  return undefined;
}

function parseShape(value: string): ShapeFunctionShape | undefined {
  const match = value.match(/^shape\s*\((.*)\)$/is);
  const initialContent = match?.[1];
  if (!initialContent) {
    return undefined;
  }

  let content = initialContent.trim();
  let fillRule: ShapeFunctionShape['fillRule'];
  const fillRuleMatch = content.match(/^(evenodd|nonzero)\s+(from\b.*)$/is);
  if (fillRuleMatch) {
    fillRule = parseFillRule(fillRuleMatch[1]);
    content = fillRuleMatch[2]?.trim() ?? '';
  }

  return /^from\b/i.test(content)
    ? { kind: 'shape', value: content, ...(fillRule ? { fillRule } : {}) }
    : undefined;
}

function splitShapeCommandList(value: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const SHAPE_ABSOLUTE_NUMBER = '(?:\\d+\\.?\\d*|\\.\\d+)';
const SHAPE_SIGNED_NUMBER = `[-+]?${SHAPE_ABSOLUTE_NUMBER}`;
const SHAPE_CQW_COORDINATE_PATTERN = [
  'calc\\(\\s*(?:',
  `50%\\s*([+-])\\s*(${SHAPE_ABSOLUTE_NUMBER})cqw`,
  '|',
  `(${SHAPE_SIGNED_NUMBER})cqw\\s*\\+\\s*50%`,
  ')\\s*\\)',
].join('');
const SHAPE_MIN_COORDINATE_PATTERN = [
  'calc\\(\\s*50%\\s*([+-])\\s*min\\(\\s*',
  `(${SHAPE_ABSOLUTE_NUMBER})cqw\\s*,\\s*${SHAPE_ABSOLUTE_NUMBER}cqh`,
  '\\s*\\)\\s*\\)',
].join('');
const SHAPE_SCALE_COORDINATE_PATTERN = [
  'calc\\(\\s*50%\\s*([+-])\\s*',
  `(${SHAPE_ABSOLUTE_NUMBER})\\s*\\*\\s*var\\(\\s*([a-zA-Z0-9_-]+)\\s*,\\s*100cqw\\s*\\)`,
  '\\s*\\)',
].join('');
// New contain encoding, per axis. The size and offset terms are each either var(name, value)
// or a bare value:
//   x: calc(Ux * <size> + <offset> * (100cqw - WU * <size>))
//   y: calc(Uy * <size> + <offset> * (100cqh - HU * <size>))
// Capture groups: 1=u, 2=sizeVar, 3=S(var form), 4=S(raw form), 5=offsetVar,
//                 6=offset(var form), 7=offset(raw form), 8=span.
const SHAPE_VAR_NAME = '([a-zA-Z0-9_-]+)';
// Size token: var(name, S cqw) or a bare S cqw (capturing name + both number forms).
const SHAPE_SIZE_TOKEN =
  `(?:var\\(\\s*${SHAPE_VAR_NAME}\\s*,\\s*(${SHAPE_ABSOLUTE_NUMBER})cqw\\s*\\)` +
  `|(${SHAPE_ABSOLUTE_NUMBER})cqw)`;
// Second size occurrence inside the travel term — match either form, capture nothing.
const SHAPE_SIZE_TOKEN_LOOSE =
  `(?:var\\(\\s*[a-zA-Z0-9_-]+\\s*,\\s*${SHAPE_ABSOLUTE_NUMBER}cqw\\s*\\)` +
  `|${SHAPE_ABSOLUTE_NUMBER}cqw)`;
const buildShapeOffsetCoordinatePattern = (travelUnit: string) =>
  [
    'calc\\(\\s*',
    `(${SHAPE_SIGNED_NUMBER})\\s*\\*\\s*${SHAPE_SIZE_TOKEN}`,
    '\\s*\\+\\s*',
    `(?:var\\(\\s*${SHAPE_VAR_NAME}\\s*,\\s*(${SHAPE_SIGNED_NUMBER})\\s*\\)`,
    `|(${SHAPE_SIGNED_NUMBER}))`,
    `\\s*\\*\\s*\\(\\s*100${travelUnit}\\s*-\\s*`,
    `(${SHAPE_ABSOLUTE_NUMBER})\\s*\\*\\s*${SHAPE_SIZE_TOKEN_LOOSE}\\s*\\)`,
    '\\s*\\)',
  ].join('');
const SHAPE_OFFSET_COORDINATE_PATTERN_X = buildShapeOffsetCoordinatePattern('cqw');
const SHAPE_OFFSET_COORDINATE_PATTERN_Y = buildShapeOffsetCoordinatePattern('cqh');
const SHAPE_OFFSET_COORDINATE_X_RE = new RegExp(`^${SHAPE_OFFSET_COORDINATE_PATTERN_X}`, 'i');
const SHAPE_OFFSET_COORDINATE_Y_RE = new RegExp(`^${SHAPE_OFFSET_COORDINATE_PATTERN_Y}`, 'i');
const SHAPE_OFFSET_COORDINATE_X_EXACT_RE = new RegExp(
  `^${SHAPE_OFFSET_COORDINATE_PATTERN_X}$`,
  'i',
);
const SHAPE_OFFSET_COORDINATE_Y_EXACT_RE = new RegExp(
  `^${SHAPE_OFFSET_COORDINATE_PATTERN_Y}$`,
  'i',
);
const SHAPE_OFFSET_LEFT_VARIABLE_NAME_RE = new RegExp(SHAPE_OFFSET_COORDINATE_PATTERN_X, 'i');
const SHAPE_OFFSET_TOP_VARIABLE_NAME_RE = new RegExp(SHAPE_OFFSET_COORDINATE_PATTERN_Y, 'i');
// Offset patterns must come first so the longer, more specific match wins coordinate splitting.
const SHAPE_CALCULATED_COORDINATE_RE = new RegExp(
  `^(?:${[
    SHAPE_OFFSET_COORDINATE_PATTERN_X,
    SHAPE_OFFSET_COORDINATE_PATTERN_Y,
    SHAPE_MIN_COORDINATE_PATTERN,
    SHAPE_SCALE_COORDINATE_PATTERN,
    SHAPE_CQW_COORDINATE_PATTERN,
  ].join('|')})`,
  'i',
);
const SHAPE_CQW_COORDINATE_EXACT_RE = new RegExp(`^${SHAPE_CQW_COORDINATE_PATTERN}$`, 'i');
const SHAPE_MIN_COORDINATE_EXACT_RE = new RegExp(`^${SHAPE_MIN_COORDINATE_PATTERN}$`, 'i');
const SHAPE_SCALE_COORDINATE_RE = new RegExp(`^${SHAPE_SCALE_COORDINATE_PATTERN}`, 'i');
const SHAPE_SCALE_COORDINATE_EXACT_RE = new RegExp(`^${SHAPE_SCALE_COORDINATE_PATTERN}$`, 'i');
const SHAPE_SCALE_VARIABLE_NAME_RE = new RegExp(SHAPE_SCALE_COORDINATE_PATTERN, 'i');

function parseShapeOffsetCoordinate(
  value: string,
  exact = false,
): ShapeOffsetCoordinate | undefined {
  const trimmed = value.trim();
  const xMatch = trimmed.match(
    exact ? SHAPE_OFFSET_COORDINATE_X_EXACT_RE : SHAPE_OFFSET_COORDINATE_X_RE,
  );
  const match =
    xMatch ||
    trimmed.match(exact ? SHAPE_OFFSET_COORDINATE_Y_EXACT_RE : SHAPE_OFFSET_COORDINATE_Y_RE);
  if (!match) {
    return undefined;
  }
  const position = Number(match[1]);
  const size = Number(match[3] ?? match[4]);
  const offset = Number(match[6] ?? match[7]);
  const span = Number(match[8]);
  if (![position, size, offset, span].every(Number.isFinite)) {
    return undefined;
  }
  return {
    axis: xMatch ? 'x' : 'y',
    u: position,
    size,
    offset,
    span,
    sizeVar: match[2] ?? '',
    offsetVar: match[5] ?? '',
  };
}

function shapeOffsetCoordinateToCanvas(parsed: ShapeOffsetCoordinate) {
  return parsed.u * parsed.size + parsed.offset * (100 - parsed.span * parsed.size);
}

function shapeOffsetVariableNamesFromValue(value: string) {
  const xMatch = value.match(SHAPE_OFFSET_LEFT_VARIABLE_NAME_RE);
  const yMatch = value.match(SHAPE_OFFSET_TOP_VARIABLE_NAME_RE);
  if (!xMatch && !yMatch) {
    return undefined;
  }
  return {
    sizeVar: xMatch?.[2] || yMatch?.[2] || undefined,
    offsetLeftVar: xMatch?.[5] || undefined,
    offsetTopVar: yMatch?.[5] || undefined,
  };
}

function shapeCalculatedCoordinateOffset(value: string, exact = false) {
  const trimmed = value.trim();
  const offsetParsed = parseShapeOffsetCoordinate(trimmed, exact);
  if (offsetParsed) {
    const canvas = shapeOffsetCoordinateToCanvas(offsetParsed);
    return Number.isFinite(canvas) ? canvas - 50 : undefined;
  }

  const minMatch = trimmed.match(
    exact ? SHAPE_MIN_COORDINATE_EXACT_RE : new RegExp(`^${SHAPE_MIN_COORDINATE_PATTERN}`, 'i'),
  );
  if (minMatch) {
    const offset = Number(minMatch[2]);
    if (!Number.isFinite(offset)) {
      return undefined;
    }
    return minMatch[1] === '-' ? -offset : offset;
  }

  const scaleMatch = trimmed.match(
    exact ? SHAPE_SCALE_COORDINATE_EXACT_RE : SHAPE_SCALE_COORDINATE_RE,
  );
  if (scaleMatch) {
    const offset = Number(scaleMatch[2]) * 100;
    if (!Number.isFinite(offset)) {
      return undefined;
    }
    return scaleMatch[1] === '-' ? -offset : offset;
  }

  const match = trimmed.match(
    exact ? SHAPE_CQW_COORDINATE_EXACT_RE : new RegExp(`^${SHAPE_CQW_COORDINATE_PATTERN}`, 'i'),
  );
  if (!match) {
    return undefined;
  }

  if (match[3] !== undefined) {
    const offset = Number(match[3]);
    return Number.isFinite(offset) ? offset : undefined;
  }

  const offset = Number(match[2]);
  if (!Number.isFinite(offset)) {
    return undefined;
  }
  return match[1] === '-' ? -offset : offset;
}

function readShapeCssCoordinate(value: string) {
  const trimmed = value.trimStart();
  const percentMatch = trimmed.match(/^-?\d+(?:\.\d+)?%/i);
  if (percentMatch) {
    return {
      coordinate: percentMatch[0],
      rest: trimmed.slice(percentMatch[0].length).trimStart(),
    };
  }

  const calculatedMatch = trimmed.match(SHAPE_CALCULATED_COORDINATE_RE);
  if (calculatedMatch) {
    return {
      coordinate: calculatedMatch[0],
      rest: trimmed.slice(calculatedMatch[0].length).trimStart(),
    };
  }

  return undefined;
}

function parseShapeCssPoint(value: string): ShapeCssPoint | undefined {
  const parsed = readShapeCssPoint(value);
  return parsed && !parsed.rest ? parsed.point : undefined;
}

function hasContainerQueryUnit(value: string) {
  return /cq[wh]\b/i.test(value);
}

function shapeScaleVariableNameFromValue(value: string) {
  const offsetNames = shapeOffsetVariableNamesFromValue(value);
  if (offsetNames?.sizeVar) {
    return offsetNames.sizeVar;
  }
  return value.match(SHAPE_SCALE_VARIABLE_NAME_RE)?.[3] || undefined;
}

function readShapeCssPoint(value: string) {
  const x = readShapeCssCoordinate(value);
  if (!x) {
    return undefined;
  }

  const y = readShapeCssCoordinate(x.rest);
  if (!y) {
    return undefined;
  }

  return {
    point: { x: x.coordinate, y: y.coordinate },
    rest: y.rest,
  };
}

function shapeCoordinateOffset(value: string) {
  const percent = parsePercent(value);
  if (percent !== undefined) {
    return percent - 50;
  }

  return shapeCalculatedCoordinateOffset(value, true);
}

function shapeCssPointToCanvasPoint(point: ShapeCssPoint): Point | undefined {
  const xOffset = shapeCoordinateOffset(point.x);
  const yOffset = shapeCoordinateOffset(point.y);
  return xOffset === undefined || yOffset === undefined
    ? undefined
    : { x: 50 + xOffset, y: 50 + yOffset };
}

function shapeCssBounds(shape: ShapeFunctionShape): SelectionRect | undefined {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return undefined;
  }

  const points = collectShapeCssPoints(subpaths)
    .map(shapeCssPointToCanvasPoint)
    .filter((point): point is Point => Boolean(point));
  if (!points.length) {
    return undefined;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

function parseShapeCssSubpaths(value: string): ShapeCssSubpath[] | undefined {
  const subpaths: ShapeCssSubpath[] = [];
  let activeSubpath: ShapeCssSubpath | undefined = undefined;

  for (const command of splitShapeCommandList(value)) {
    const moveMatch = command.match(/^(from|move\s+to)\s+(.+)$/i);
    if (moveMatch?.[2]) {
      const start = parseShapeCssPoint(moveMatch[2]);
      if (!start) {
        return undefined;
      }
      activeSubpath = { start, commands: [] };
      subpaths.push(activeSubpath);
      continue;
    }

    if (!activeSubpath) {
      return undefined;
    }

    const lineMatch = command.match(/^line\s+to\s+(.+)$/i);
    if (lineMatch?.[1]) {
      const to = parseShapeCssPoint(lineMatch[1]);
      if (!to) {
        return undefined;
      }
      activeSubpath.commands.push({ kind: 'line', to });
      continue;
    }

    const curveMatch = command.match(/^curve\s+to\s+(.+)$/i);
    if (curveMatch?.[1]) {
      const to = readShapeCssPoint(curveMatch[1]);
      if (!to) {
        return undefined;
      }

      const withMatch = to.rest.match(/^with\s+(.+)$/i);
      if (!withMatch?.[1]) {
        return undefined;
      }

      const control1 = readShapeCssPoint(withMatch[1]);
      if (!control1) {
        return undefined;
      }

      const controlRest = control1.rest.trim();
      if (!controlRest) {
        activeSubpath.commands.push({ kind: 'curve', to: to.point, control1: control1.point });
        continue;
      }

      const control2Match = controlRest.match(/^\/\s*(.+)$/);
      const control2 = control2Match?.[1] ? parseShapeCssPoint(control2Match[1]) : undefined;
      if (!control2) {
        return undefined;
      }

      activeSubpath.commands.push({
        kind: 'curve',
        to: to.point,
        control1: control1.point,
        control2,
      });
      continue;
    }

    if (/^close$/i.test(command)) {
      activeSubpath.commands.push({ kind: 'close' });
      continue;
    }

    return undefined;
  }

  return subpaths.length ? subpaths : undefined;
}

function collectShapeCssPoints(subpaths: ShapeCssSubpath[]) {
  return subpaths.flatMap((subpath) => [
    subpath.start,
    ...subpath.commands.flatMap((command) => {
      if (command.kind === 'close') {
        return [];
      }
      if (command.kind === 'line') {
        return [command.to];
      }
      return [command.to, command.control1, command.control2].filter(isDefined);
    }),
  ]);
}

function mapShapeCssSubpathPoints(
  subpaths: ShapeCssSubpath[],
  mapper: (point: ShapeCssPoint) => ShapeCssPoint,
): ShapeCssSubpath[] {
  return subpaths.map((subpath) => ({
    start: mapper(subpath.start),
    commands: subpath.commands.map((command) => {
      if (command.kind === 'line') {
        return { kind: 'line' as const, to: mapper(command.to) };
      }
      if (command.kind === 'curve') {
        return {
          kind: 'curve' as const,
          to: mapper(command.to),
          control1: mapper(command.control1),
          ...(command.control2 ? { control2: mapper(command.control2) } : {}),
        };
      }
      return command;
    }),
  }));
}

// Re-emit a set of CSS subpaths in the offset encoding, decomposing each point's canvas position
// into the shared size/offset model. Used for stretch->contain conversion and legacy upgrades.
function emitContainCssFromSubpaths(
  subpaths: ShapeCssSubpath[],
  options: ShapeScaleOptions,
): ShapeCssSubpath[] | undefined {
  const canvasPoints = collectShapeCssPoints(subpaths)
    .map(shapeCssPointToCanvasPoint)
    .filter((point): point is Point => Boolean(point));
  const bounds = shapeOffsetBoundsFromCanvasPoints(canvasPoints);
  if (!bounds) {
    return undefined;
  }
  const names = resolveShapeScaleVarNames(options);
  return mapShapeCssSubpathPoints(subpaths, (point) => {
    const canvas = shapeCssPointToCanvasPoint(point);
    return canvas ? formatShapeOffsetPoint(canvas, bounds, names) : point;
  });
}

// Parse a contain shape that is already in the offset encoding into its structured model.
// Returns null if any coordinate is not in the new format (legacy/foreign shapes).
function containModelFromShape(shape: ShapeFunctionShape): ShapeContainModel | undefined {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return undefined;
  }
  const cssPoints = collectShapeCssPoints(subpaths);
  if (!cssPoints.length) {
    return undefined;
  }

  const points: Array<{ ux: number; uy: number }> = [];
  let header: Omit<ShapeContainModel, 'points'> | undefined = undefined;
  for (const point of cssPoints) {
    const px = parseShapeOffsetCoordinate(point.x, true);
    const py = parseShapeOffsetCoordinate(point.y, true);
    if (!px || px.axis !== 'x' || !py || py.axis !== 'y') {
      return undefined;
    }
    points.push({ ux: px.u, uy: py.u });
    if (!header) {
      header = {
        wu: px.span,
        hu: py.span,
        size: px.size,
        ol: px.offset,
        ot: py.offset,
        sizeVar: px.sizeVar,
        offsetLeftVar: px.offsetVar,
        offsetTopVar: py.offsetVar,
      };
    }
  }
  if (!header) {
    return undefined;
  }
  return { points, ...header };
}

// Re-emit a contain shape keeping every point's own Ux/Uy but applying the model's
// size/offset/names.
function shapeFromContainModel(
  shape: ShapeFunctionShape,
  model: ShapeContainModel,
): ShapeFunctionShape {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return shape;
  }
  const remapped = mapShapeCssSubpathPoints(subpaths, (point) => {
    const px = parseShapeOffsetCoordinate(point.x, true);
    const py = parseShapeOffsetCoordinate(point.y, true);
    if (!px || !py) {
      return point;
    }
    return {
      x: formatShapeOffsetCoordinate(
        px.u,
        model.wu,
        model.size,
        model.ol,
        model.sizeVar,
        model.offsetLeftVar,
        'x',
      ),
      y: formatShapeOffsetCoordinate(
        py.u,
        model.hu,
        model.size,
        model.ot,
        model.sizeVar,
        model.offsetTopVar,
        'y',
      ),
    };
  });
  return { ...shape, value: formatShapeValueFromCssSubpaths(remapped) };
}

// Translate a contain shape by a canvas-space delta by folding it into OL/OT (the geometry is
// fixed).
// Offsets are left unclamped so the shape can be moved partially off the container, as before.
function moveContainModel(model: ShapeContainModel, dx: number, dy: number): ShapeContainModel {
  const travelX = 100 - model.wu * model.size;
  const travelY = 100 - model.hu * model.size;
  return {
    ...model,
    // |travel| ~ 0 means the shape fills the axis and can't be repositioned along it.
    ol: Math.abs(travelX) > SHAPE_OFFSET_TRAVEL_EPSILON ? model.ol + dx / travelX : model.ol,
    ot: Math.abs(travelY) > SHAPE_OFFSET_TRAVEL_EPSILON ? model.ot + dy / travelY : model.ot,
  };
}

// Uniformly scale a contain shape by writing --size, recomputing OL/OT so the anchor canvas point
// (opposite corner, or shape center on alt) stays fixed. The shape may grow larger than the
// container (travel goes negative — the offset then controls which side overflows).
function resizeContainModel(
  model: ShapeContainModel,
  anchor: Point,
  scale: number,
): ShapeContainModel {
  const size = Math.max(0, model.size * scale);

  const bboxWidth = model.wu * model.size;
  const bboxHeight = model.hu * model.size;
  // Anchor's fractional position within the bbox (0 = near edge, 0.5 = center, 1 = far edge).
  const fx =
    bboxWidth > SHAPE_OFFSET_TRAVEL_EPSILON
      ? (anchor.x - model.ol * (100 - bboxWidth)) / bboxWidth
      : DEFAULT_SHAPE_OFFSET_VALUE;
  const fy =
    bboxHeight > SHAPE_OFFSET_TRAVEL_EPSILON
      ? (anchor.y - model.ot * (100 - bboxHeight)) / bboxHeight
      : DEFAULT_SHAPE_OFFSET_VALUE;

  const newTravelX = 100 - model.wu * size;
  const newTravelY = 100 - model.hu * size;
  return {
    ...model,
    size,
    ol:
      Math.abs(newTravelX) > SHAPE_OFFSET_TRAVEL_EPSILON
        ? (anchor.x - fx * model.wu * size) / newTravelX
        : model.ol,
    ot:
      Math.abs(newTravelY) > SHAPE_OFFSET_TRAVEL_EPSILON
        ? (anchor.y - fy * model.hu * size) / newTravelY
        : model.ot,
  };
}

function convertShapeFitMode(
  shape: ShapeFunctionShape,
  fitMode: ShapeFitMode,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
): ShapeFunctionShape | undefined {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return undefined;
  }

  if (fitMode === 'contain') {
    const contained = emitContainCssFromSubpaths(subpaths, options);
    if (!contained) {
      return undefined;
    }
    return {
      ...shape,
      value: formatShapeValueFromCssSubpaths(contained),
    };
  }

  const xOffsets = collectShapeCssPoints(subpaths)
    .map((point) => shapeCoordinateOffset(point.x))
    .filter((offset): offset is number => offset !== undefined);
  const yOffsets = collectShapeCssPoints(subpaths)
    .map((point) => shapeCoordinateOffset(point.y))
    .filter((offset): offset is number => offset !== undefined);
  if (!xOffsets.length || !yOffsets.length) {
    return undefined;
  }

  const minXOffset = Math.min(...xOffsets);
  const maxXOffset = Math.max(...xOffsets);
  const minYOffset = Math.min(...yOffsets);
  const maxYOffset = Math.max(...yOffsets);
  const xOffsetRange = maxXOffset - minXOffset;
  const yOffsetRange = maxYOffset - minYOffset;
  if (xOffsetRange <= SVG_POINT_EPSILON || yOffsetRange <= SVG_POINT_EPSILON) {
    return undefined;
  }

  const stretched = mapShapeCssSubpathPoints(subpaths, (point) => {
    const xOffset = shapeCoordinateOffset(point.x);
    const yOffset = shapeCoordinateOffset(point.y);
    return {
      x:
        xOffset === undefined
          ? point.x
          : formatPercent(((xOffset - minXOffset) / xOffsetRange) * 100),
      y:
        yOffset === undefined
          ? point.y
          : formatPercent(((yOffset - minYOffset) / yOffsetRange) * 100),
    };
  });

  return {
    ...shape,
    value: formatShapeValueFromCssSubpaths(stretched),
  };
}

function cacheFromShapeFitVariants(
  shape: ShapeFunctionShape,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
): PastedShapeSvgCache | undefined {
  const isContain = hasContainerQueryUnit(shape.value);
  const stretch = isContain ? convertShapeFitMode(shape, 'stretch', options) : shape;
  const contain = isContain
    ? normalizeContainShapeCoordinates(shape, options)
    : convertShapeFitMode(shape, 'contain', options);

  return stretch && contain ? { source: 'shape()', stretch, contain } : undefined;
}

function normalizeContainShapeCoordinates(
  shape: ShapeFunctionShape,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
): ShapeFunctionShape {
  // Already in the offset encoding: preserve geometry/size/offset, only apply (possibly renamed)
  // vars.
  const model = containModelFromShape(shape);
  if (model) {
    const names = resolveShapeScaleVarNames(options);
    return shapeFromContainModel(shape, {
      ...model,
      sizeVar: names.sizeVar,
      offsetLeftVar: names.offsetLeftVar,
      offsetTopVar: names.offsetTopVar,
    });
  }

  // Legacy contain (or any parseable coordinates): upgrade to the offset encoding in place.
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return shape;
  }
  const upgraded = emitContainCssFromSubpaths(subpaths, options);
  if (!upgraded) {
    return shape;
  }
  return {
    ...shape,
    value: formatShapeValueFromCssSubpaths(upgraded),
  };
}

function normalizeShapeFitCache(
  cache: PastedShapeSvgCache | undefined,
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
) {
  if (!cache) {
    return undefined;
  }
  const stretch = hasContainerQueryUnit(cache.stretch.value)
    ? convertShapeFitMode(cache.stretch, 'stretch', options) || cache.stretch
    : cache.stretch;
  const contain = normalizeContainShapeCoordinates(cache.contain, options);

  return { ...cache, stretch, contain };
}

function formatShapeCanvasPoint(
  point: Point,
  fitMode: ShapeFitMode,
  options: ShapeScaleOptions,
): ShapeCssPoint {
  if (fitMode === 'contain') {
    return {
      x: formatShapeContainCoordinate(point.x - 50, options),
      y: formatShapeContainCoordinate(point.y - 50, options),
    };
  }

  return {
    x: formatPercent(point.x),
    y: formatPercent(point.y),
  };
}

function transformShapeCanvasPoints(
  shape: ShapeFunctionShape,
  fitMode: ShapeFitMode,
  options: ShapeScaleOptions,
  transform: (point: Point) => Point,
): ShapeFunctionShape | undefined {
  const subpaths = parseShapeCssSubpaths(shape.value);
  if (!subpaths) {
    return undefined;
  }

  const transformed = mapShapeCssSubpathPoints(subpaths, (point) => {
    const canvasPoint = shapeCssPointToCanvasPoint(point);
    return canvasPoint ? formatShapeCanvasPoint(transform(canvasPoint), fitMode, options) : point;
  });

  return {
    ...shape,
    value: formatShapeValueFromCssSubpaths(transformed),
  };
}

function shapeResizeCornerPoint(bounds: SelectionRect, corner: ShapeResizeCorner): Point {
  if (corner === 'topLeft') {
    return { x: bounds.left, y: bounds.top };
  }
  if (corner === 'topRight') {
    return { x: bounds.left + bounds.width, y: bounds.top };
  }
  if (corner === 'bottomRight') {
    return { x: bounds.left + bounds.width, y: bounds.top + bounds.height };
  }
  return { x: bounds.left, y: bounds.top + bounds.height };
}

function oppositeShapeResizeCorner(corner: ShapeResizeCorner): ShapeResizeCorner {
  return oppositeCorner(corner);
}

function shapeFromPastedSvgCache(cache: PastedShapeSvgCache, fitMode: ShapeFitMode) {
  return fitMode === 'contain' ? cache.contain : cache.stretch;
}

function parseClipPath(value: string): ClipShape | undefined {
  if (value.trim().toLowerCase() === 'none') {
    return NONE_SHAPE;
  }
  const shape = parseShape(value);
  if (shape) {
    return shape;
  }
  const polygon = parsePolygon(value);
  if (polygon) {
    return { kind: 'polygon', points: polygon };
  }
  return (
    parseCircle(value) ||
    parseEllipse(value) ||
    parseInset(value) ||
    parseRawBasicClipPath(value) ||
    parseCustomClipPath(value)
  );
}

function parseClipPathInput(value: string): ClipShape | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const declarationMatch = trimmed.match(/(?:^|[;{\s])(?:-webkit-)?clip-path\s*:\s*([^;}]+)/i);
  const clipPathValue = declarationMatch?.[1] ?? trimmed;
  return parseClipPath(clipPathValue.trim().replace(/;$/, ''));
}

function parseSvgNumber(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const match = value.trim().match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSvgNumberList(value: string | undefined) {
  if (!value) {
    return [];
  }
  return Array.from(value.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi), (match) =>
    Number(match[0]),
  ).filter(Number.isFinite);
}

function extractSvgMarkup(value: string) {
  return value.match(/<svg\b[\s\S]*<\/svg>/i)?.[0] || undefined;
}

function svgTagName(element: Element) {
  return element.tagName.toLowerCase();
}

function svgStyleValue(element: Element, property: string) {
  const style = element.getAttribute('style');
  if (!style) {
    return undefined;
  }

  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'));
  return match?.[1]?.trim() || undefined;
}

function inheritedSvgAttribute(element: Element, attribute: string) {
  let current: Element | undefined = element;
  while (current) {
    const styleValue = svgStyleValue(current, attribute);
    if (styleValue) {
      return styleValue;
    }

    const value = current.getAttribute(attribute);
    if (value !== null) {
      return value;
    }

    current = current.parentElement ?? undefined;
  }

  return undefined;
}

function isRenderableSvgElement(element: Element) {
  const display = inheritedSvgAttribute(element, 'display')?.trim().toLowerCase();
  const visibility = inheritedSvgAttribute(element, 'visibility')?.trim().toLowerCase();
  const fill = inheritedSvgAttribute(element, 'fill')?.trim().toLowerCase();
  const opacity = inheritedSvgAttribute(element, 'opacity')?.trim();
  const fillOpacity = inheritedSvgAttribute(element, 'fill-opacity')?.trim();

  return (
    display !== 'none' &&
    visibility !== 'hidden' &&
    visibility !== 'collapse' &&
    fill !== 'none' &&
    opacity !== '0' &&
    fillOpacity !== '0'
  );
}

function isInsideSkippedSvgElement(element: Element) {
  let current = element.parentElement;
  while (current) {
    const tagName = svgTagName(current);
    if (
      tagName === 'defs' ||
      tagName === 'clippath' ||
      tagName === 'mask' ||
      tagName === 'pattern' ||
      tagName === 'symbol'
    ) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

function hasSvgTransform(element: Element) {
  let current: Element | undefined = element;
  while (current && svgTagName(current) !== 'svg') {
    const transform = current.getAttribute('transform');
    if (transform && transform.trim()) {
      return true;
    }
    current = current.parentElement ?? undefined;
  }

  return false;
}

// An SVG attribute's text, or undefined when the element doesn't carry it (the
// DOM's own answer for that is null).
function svgAttribute(element: Element, name: string): string | undefined {
  return element.getAttribute(name) ?? undefined;
}

function parseSvgViewBox(svg: Element, contours: Point[][]): SvgViewBox | undefined {
  const viewBoxValues = parseSvgNumberList(svgAttribute(svg, 'viewBox'));
  const [x, y, widthViewBox, heightViewBox] = viewBoxValues;
  if (
    x !== undefined &&
    y !== undefined &&
    widthViewBox !== undefined &&
    heightViewBox !== undefined &&
    viewBoxValues.length === 4 &&
    widthViewBox > 0 &&
    heightViewBox > 0
  ) {
    return { x, y, width: widthViewBox, height: heightViewBox };
  }

  const width = parseSvgNumber(svgAttribute(svg, 'width'));
  const height = parseSvgNumber(svgAttribute(svg, 'height'));
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    return { x: 0, y: 0, width, height };
  }

  const points = contours.flat();
  if (!points.length) {
    return undefined;
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  if (maxX <= minX || maxY <= minY) {
    return undefined;
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function svgPointsAlmostEqual(left: Point, right: Point) {
  return (
    Math.abs(left.x - right.x) < SVG_POINT_EPSILON && Math.abs(left.y - right.y) < SVG_POINT_EPSILON
  );
}

function isSvgPointCollinear(first: Point, second: Point, third: Point) {
  const area =
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  return Math.abs(area) < SVG_POINT_EPSILON;
}

function simplifySvgContour(points: readonly Point[]) {
  const withoutDuplicates = points.reduce<Point[]>((unique, point) => {
    const previous = unique[unique.length - 1];
    if (!previous || !svgPointsAlmostEqual(previous, point)) {
      unique.push(point);
    }
    return unique;
  }, []);

  const firstPoint = withoutDuplicates[0];
  const lastPoint = withoutDuplicates[withoutDuplicates.length - 1];
  if (
    firstPoint &&
    lastPoint &&
    withoutDuplicates.length > 1 &&
    svgPointsAlmostEqual(firstPoint, lastPoint)
  ) {
    withoutDuplicates.pop();
  }

  let simplified = withoutDuplicates;
  let changed = true;
  while (changed && simplified.length >= 3) {
    changed = false;
    simplified = simplified.filter((point, index, list) => {
      const previous = list[(index - 1 + list.length) % list.length];
      const next = list[(index + 1) % list.length];
      const keep =
        previous !== undefined && next !== undefined
          ? !isSvgPointCollinear(previous, point, next)
          : false;
      if (!keep) {
        changed = true;
      }
      return keep;
    });
  }

  return simplified.length >= 3 ? simplified : [];
}

function parseSvgPoints(value: string | undefined) {
  const values = parseSvgNumberList(value);
  if (values.length < 6 || values.length % 2 !== 0) {
    return undefined;
  }

  const points: Point[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (x === undefined || y === undefined) {
      return undefined;
    }
    points.push({ x, y });
  }

  return simplifySvgContour(points);
}

function parseClosedSvgPolyline(value: string | undefined) {
  const values = parseSvgNumberList(value);
  if (values.length < 8 || values.length % 2 !== 0) {
    return undefined;
  }

  const points: Point[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (x === undefined || y === undefined) {
      return undefined;
    }
    points.push({ x, y });
  }
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint || !svgPointsAlmostEqual(firstPoint, lastPoint)) {
    return undefined;
  }

  return simplifySvgContour(points);
}

function parseSvgRect(element: Element) {
  const rx = parseSvgNumber(svgAttribute(element, 'rx')) || 0;
  const ry = parseSvgNumber(svgAttribute(element, 'ry')) || 0;
  if (rx > 0 || ry > 0) {
    return undefined;
  }

  const x = parseSvgNumber(svgAttribute(element, 'x')) || 0;
  const y = parseSvgNumber(svgAttribute(element, 'y')) || 0;
  const width = parseSvgNumber(svgAttribute(element, 'width'));
  const height = parseSvgNumber(svgAttribute(element, 'height'));
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return [];
  }

  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function svgSubpathHasArea(subpath: SvgShapeSubpath) {
  const points = [subpath.start, ...subpath.commands.flatMap(svgShapeCommandPoints)];
  if (points.length < 3) {
    return false;
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return maxX - minX > SVG_POINT_EPSILON && maxY - minY > SVG_POINT_EPSILON;
}

function closeSvgSubpath(subpath: SvgShapeSubpath) {
  const lastCommand = subpath.commands[subpath.commands.length - 1];
  return lastCommand?.kind === 'close'
    ? subpath
    : { ...subpath, commands: [...subpath.commands, { kind: 'close' as const }] };
}

function parseSvgRectShape(element: Element) {
  const x = parseSvgNumber(svgAttribute(element, 'x')) || 0;
  const y = parseSvgNumber(svgAttribute(element, 'y')) || 0;
  const width = parseSvgNumber(svgAttribute(element, 'width'));
  const height = parseSvgNumber(svgAttribute(element, 'height'));
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return [];
  }

  const rawRx = parseSvgNumber(svgAttribute(element, 'rx'));
  const rawRy = parseSvgNumber(svgAttribute(element, 'ry'));
  const rx = Math.min(width / 2, Math.max(0, rawRx ?? rawRy ?? 0));
  const ry = Math.min(height / 2, Math.max(0, rawRy ?? rawRx ?? 0));
  const right = x + width;
  const bottom = y + height;

  if (rx <= SVG_POINT_EPSILON || ry <= SVG_POINT_EPSILON) {
    return [
      {
        start: { x, y },
        commands: [
          { kind: 'line' as const, to: { x: right, y } },
          { kind: 'line' as const, to: { x: right, y: bottom } },
          { kind: 'line' as const, to: { x, y: bottom } },
          { kind: 'close' as const },
        ],
      },
    ];
  }

  const kx = rx * SVG_ARC_KAPPA;
  const ky = ry * SVG_ARC_KAPPA;
  return [
    {
      start: { x: x + rx, y },
      commands: [
        { kind: 'line' as const, to: { x: right - rx, y } },
        {
          kind: 'curve' as const,
          to: { x: right, y: y + ry },
          control1: { x: right - rx + kx, y },
          control2: { x: right, y: y + ry - ky },
        },
        { kind: 'line' as const, to: { x: right, y: bottom - ry } },
        {
          kind: 'curve' as const,
          to: { x: right - rx, y: bottom },
          control1: { x: right, y: bottom - ry + ky },
          control2: { x: right - rx + kx, y: bottom },
        },
        { kind: 'line' as const, to: { x: x + rx, y: bottom } },
        {
          kind: 'curve' as const,
          to: { x, y: bottom - ry },
          control1: { x: x + rx - kx, y: bottom },
          control2: { x, y: bottom - ry + ky },
        },
        { kind: 'line' as const, to: { x, y: y + ry } },
        {
          kind: 'curve' as const,
          to: { x: x + rx, y },
          control1: { x, y: y + ry - ky },
          control2: { x: x + rx - kx, y },
        },
        { kind: 'close' as const },
      ],
    },
  ];
}

function parseSvgEllipseShape(cx: number, cy: number, rx: number, ry: number) {
  if (rx <= 0 || ry <= 0) {
    return [];
  }

  const kx = rx * SVG_ARC_KAPPA;
  const ky = ry * SVG_ARC_KAPPA;
  return [
    {
      start: { x: cx + rx, y: cy },
      commands: [
        {
          kind: 'curve' as const,
          to: { x: cx, y: cy + ry },
          control1: { x: cx + rx, y: cy + ky },
          control2: { x: cx + kx, y: cy + ry },
        },
        {
          kind: 'curve' as const,
          to: { x: cx - rx, y: cy },
          control1: { x: cx - kx, y: cy + ry },
          control2: { x: cx - rx, y: cy + ky },
        },
        {
          kind: 'curve' as const,
          to: { x: cx, y: cy - ry },
          control1: { x: cx - rx, y: cy - ky },
          control2: { x: cx - kx, y: cy - ry },
        },
        {
          kind: 'curve' as const,
          to: { x: cx + rx, y: cy },
          control1: { x: cx + kx, y: cy - ry },
          control2: { x: cx + rx, y: cy - ky },
        },
        { kind: 'close' as const },
      ],
    },
  ];
}

function parseSvgCircleShape(element: Element) {
  const cx = parseSvgNumber(svgAttribute(element, 'cx')) || 0;
  const cy = parseSvgNumber(svgAttribute(element, 'cy')) || 0;
  const radius = parseSvgNumber(svgAttribute(element, 'r')) || 0;
  return parseSvgEllipseShape(cx, cy, radius, radius);
}

function parseSvgEllipseElementShape(element: Element) {
  const cx = parseSvgNumber(svgAttribute(element, 'cx')) || 0;
  const cy = parseSvgNumber(svgAttribute(element, 'cy')) || 0;
  const rx = parseSvgNumber(svgAttribute(element, 'rx')) || 0;
  const ry = parseSvgNumber(svgAttribute(element, 'ry')) || 0;
  return parseSvgEllipseShape(cx, cy, rx, ry);
}

function parseSvgPolygonShape(element: Element, requireClosed = true) {
  const values = parseSvgNumberList(svgAttribute(element, 'points'));
  if (values.length < 6 || values.length % 2 !== 0) {
    return undefined;
  }

  const points: Point[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];
    if (x === undefined || y === undefined) {
      return undefined;
    }
    points.push({ x, y });
  }
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (
    requireClosed &&
    (!firstPoint || !lastPoint || !svgPointsAlmostEqual(firstPoint, lastPoint))
  ) {
    return undefined;
  }

  const simplified = simplifySvgContour(points);
  const [start, ...rest] = simplified;
  if (!start || rest.length < 2) {
    return [];
  }

  return [
    {
      start,
      commands: [
        ...rest.map((point) => ({ kind: 'line' as const, to: point })),
        { kind: 'close' as const },
      ],
    },
  ];
}

function isSvgPathCommand(token: string) {
  return /^[a-z]$/i.test(token);
}

// The command letters and numbers of an element's `d` attribute, or undefined when it
// has none.
function svgPathTokens(element: Element): string[] | undefined {
  const pathData = element.getAttribute('d');
  const tokens = pathData?.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  return tokens?.length ? tokens : undefined;
}

// Reads a path's tokens in order: a command letter, then the numbers after it.
type SvgPathCursor = {
  done: () => boolean;
  // The next token when it is a command letter, consumed; undefined otherwise.
  takeCommand: () => string | undefined;
  hasNumber: () => boolean;
  readNumber: () => number | undefined;
  // `count` numbers, or undefined when any is missing or not finite.
  readNumbers: (count: number) => number[] | undefined;
};

function svgPathCursor(tokens: readonly string[]): SvgPathCursor {
  let index = 0;
  const hasNumber = () => {
    const token = tokens[index];
    return token !== undefined && !isSvgPathCommand(token);
  };
  const readNumber = () => {
    if (!hasNumber()) {
      return undefined;
    }
    const value = Number(tokens[index] ?? '');
    index += 1;
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    done: () => index >= tokens.length,
    takeCommand: () => {
      const token = tokens[index];
      if (token !== undefined && isSvgPathCommand(token)) {
        index += 1;
        return token;
      }
      return undefined;
    },
    hasNumber,
    readNumber,
    readNumbers: (count) => {
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        const value = readNumber();
        if (value === undefined) {
          return undefined;
        }
        values.push(value);
      }
      return values;
    },
  };
}

// The pen of a straight-edged path: where it is, where the path began, and the
// corners so far. The reader owns that state and changes it only through its own
// methods, so the command helpers below ask it to move instead of writing its fields.
class SimpleSvgPathReader {
  #command = '';
  #current: Point = { x: 0, y: 0 };
  #start: Point | undefined = undefined;
  #closed = false;
  readonly #corners: Point[] = [];

  // The command whose numbers are being read; empty after a close-path.
  get command(): string {
    return this.#command;
  }

  get current(): Point {
    return this.#current;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get corners(): readonly Point[] {
    return this.#corners;
  }

  // Takes the next command letter when there is one; otherwise the numbers that
  // follow repeat the command before them.
  takeCommand(cursor: SvgPathCursor): string {
    this.#command = cursor.takeCommand() ?? this.#command;
    return this.#command;
  }

  // Starts the path at `point`. Numbers after a move-to are line-tos, relative when
  // the move was.
  moveTo(point: Point, { relative }: { relative: boolean }): void {
    this.#current = point;
    this.#start = point;
    this.#corners.push(point);
    this.#command = relative ? 'l' : 'L';
    this.#closed = false;
  }

  lineTo(point: Point): void {
    this.#current = point;
    this.#corners.push(point);
  }

  // Returns the pen to where the path began. False when the path never began.
  close(): boolean {
    if (!this.#start) {
      return false;
    }
    this.#current = this.#start;
    this.#closed = true;
    this.#command = '';
    return true;
  }
}

function parseSimpleSvgPath(element: Element) {
  const tokens = svgPathTokens(element);
  if (!tokens) {
    return undefined;
  }
  const cursor = svgPathCursor(tokens);
  const reader = new SimpleSvgPathReader();
  while (!cursor.done()) {
    if (!reader.takeCommand(cursor)) {
      return undefined;
    }
    if (!applySimpleSvgCommand(reader, cursor)) {
      return undefined;
    }
  }

  const points = reader.corners;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (
    !reader.closed &&
    firstPoint &&
    lastPoint &&
    points.length > 1 &&
    !svgPointsAlmostEqual(firstPoint, lastPoint)
  ) {
    return undefined;
  }
  return simplifySvgContour(points);
}

// One command of a straight-edged path. False when the path is not one this reads.
function applySimpleSvgCommand(reader: SimpleSvgPathReader, cursor: SvgPathCursor): boolean {
  const relative = reader.command === reader.command.toLowerCase();
  switch (reader.command.toUpperCase()) {
    case 'M':
      return simpleSvgMove(reader, cursor, { relative });
    case 'L':
      while (cursor.hasNumber()) {
        const numbers = cursor.readNumbers(2);
        if (!numbers) {
          return false;
        }
        reader.lineTo(offsetSvgPoint(reader.current, numbers, { relative }));
      }
      return true;
    case 'H':
      while (cursor.hasNumber()) {
        const x = cursor.readNumber();
        if (x === undefined) {
          return false;
        }
        const current = reader.current;
        reader.lineTo({ x: relative ? current.x + x : x, y: current.y });
      }
      return true;
    case 'V':
      while (cursor.hasNumber()) {
        const y = cursor.readNumber();
        if (y === undefined) {
          return false;
        }
        const current = reader.current;
        reader.lineTo({ x: current.x, y: relative ? current.y + y : y });
      }
      return true;
    case 'Z':
      return reader.close();
    default:
      return false;
  }
}

// A straight-edged path starts once: a second move-to is a second contour, which
// this reader does not take.
function simpleSvgMove(
  reader: SimpleSvgPathReader,
  cursor: SvgPathCursor,
  { relative }: { relative: boolean },
): boolean {
  if (reader.corners.length) {
    return false;
  }
  const numbers = cursor.readNumbers(2);
  if (!numbers) {
    return false;
  }
  reader.moveTo(offsetSvgPoint(reader.current, numbers, { relative }), { relative });
  return true;
}

// The point `[x, y]` names: as written, or from `current` for a relative command.
function offsetSvgPoint(
  current: Point,
  [x = 0, y = 0]: readonly number[],
  { relative }: { relative: boolean },
): Point {
  return relative ? { x: current.x + x, y: current.y + y } : { x, y };
}

function transformSvgArcPoint(point: Point, cosPhi: number, sinPhi: number, center: Point) {
  return {
    x: cosPhi * point.x - sinPhi * point.y + center.x,
    y: sinPhi * point.x + cosPhi * point.y + center.y,
  };
}

function svgVectorAngle(ux: number, uy: number, vx: number, vy: number) {
  const dot = ux * vx + uy * vy;
  const length = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  return sign * Math.acos(clampValue(dot / length, -1, 1));
}

function svgArcToCubicCurves(
  from: Point,
  rawRx: number,
  rawRy: number,
  rotation: number,
  { largeArc, sweep }: { largeArc: boolean; sweep: boolean },
  to: Point,
) {
  if (svgPointsAlmostEqual(from, to)) {
    return [];
  }

  let rx = Math.abs(rawRx);
  let ry = Math.abs(rawRy);
  if (rx <= SVG_POINT_EPSILON || ry <= SVG_POINT_EPSILON) {
    return [{ kind: 'line' as const, to }];
  }

  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const rotatedX = cosPhi * dx + sinPhi * dy;
  const rotatedY = -sinPhi * dx + cosPhi * dy;

  const radiusScale = (rotatedX * rotatedX) / (rx * rx) + (rotatedY * rotatedY) / (ry * ry);
  if (radiusScale > 1) {
    const scale = Math.sqrt(radiusScale);
    rx *= scale;
    ry *= scale;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const rotatedXSquared = rotatedX * rotatedX;
  const rotatedYSquared = rotatedY * rotatedY;
  const denominator = rx2 * rotatedYSquared + ry2 * rotatedXSquared;
  if (denominator === 0) {
    return [{ kind: 'line' as const, to }];
  }

  const sign = largeArc === sweep ? -1 : 1;
  const coefficient =
    sign *
    Math.sqrt(
      Math.max(0, (rx2 * ry2 - rx2 * rotatedYSquared - ry2 * rotatedXSquared) / denominator),
    );
  const cxp = (coefficient * (rx * rotatedY)) / ry;
  const cyp = (coefficient * (-ry * rotatedX)) / rx;
  const center = {
    x: cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2,
    y: sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2,
  };
  const startVector = { x: (rotatedX - cxp) / rx, y: (rotatedY - cyp) / ry };
  const endVector = { x: (-rotatedX - cxp) / rx, y: (-rotatedY - cyp) / ry };
  const startAngle = svgVectorAngle(1, 0, startVector.x, startVector.y);
  let deltaAngle = svgVectorAngle(startVector.x, startVector.y, endVector.x, endVector.y);

  if (!sweep && deltaAngle > 0) {
    deltaAngle -= Math.PI * 2;
  }
  if (sweep && deltaAngle < 0) {
    deltaAngle += Math.PI * 2;
  }

  const curves = svgArcSegments({ rx, ry, cosPhi, sinPhi, center, startAngle, deltaAngle });
  const lastCurve = curves[curves.length - 1];
  if (lastCurve?.kind === 'curve') {
    lastCurve.to = to;
  }
  return curves;
}

// The arc from `startAngle` through `deltaAngle` on the ellipse (rx, ry) rotated by
// phi about `center`, as cubic curves of at most a quarter turn each.
function svgArcSegments({
  rx,
  ry,
  cosPhi,
  sinPhi,
  center,
  startAngle: firstAngle,
  deltaAngle,
}: {
  rx: number;
  ry: number;
  cosPhi: number;
  sinPhi: number;
  center: Point;
  startAngle: number;
  deltaAngle: number;
}): SvgShapeCommand[] {
  const segments = Math.ceil(Math.abs(deltaAngle) / (Math.PI / 2));
  const segmentAngle = deltaAngle / segments;
  const curves: SvgShapeCommand[] = [];
  let startAngle = firstAngle;

  for (let segment = 0; segment < segments; segment += 1) {
    const nextAngle = startAngle + segmentAngle;
    const alpha = (4 / 3) * Math.tan((nextAngle - startAngle) / 4);
    const arcEnd = { x: rx * Math.cos(nextAngle), y: ry * Math.sin(nextAngle) };
    const control1 = {
      x: rx * (Math.cos(startAngle) - alpha * Math.sin(startAngle)),
      y: ry * (Math.sin(startAngle) + alpha * Math.cos(startAngle)),
    };
    const control2 = {
      x: rx * (Math.cos(nextAngle) + alpha * Math.sin(nextAngle)),
      y: ry * (Math.sin(nextAngle) - alpha * Math.cos(nextAngle)),
    };

    curves.push({
      kind: 'curve',
      to: transformSvgArcPoint(arcEnd, cosPhi, sinPhi, center),
      control1: transformSvgArcPoint(control1, cosPhi, sinPhi, center),
      control2: transformSvgArcPoint(control2, cosPhi, sinPhi, center),
    });
    startAngle = nextAngle;
  }
  return curves;
}

// The pen of a curved path: where it is, the subpath it is drawing, the control
// points a smooth curve reflects, and the subpaths finished so far. The reader owns
// that state and changes it only through its own methods, so the command helpers
// below ask it to draw instead of writing its fields.
class SvgShapePathReader {
  #command = '';
  #current: Point = { x: 0, y: 0 };
  #activeSubpath: SvgShapeSubpath | undefined = undefined;
  #previousCubicControl: Point | undefined = undefined;
  #previousQuadraticControl: Point | undefined = undefined;
  #previousCommand = '';
  readonly #subpaths: SvgShapeSubpath[] = [];

  // The command whose numbers are being read; empty after a close-path.
  get command(): string {
    return this.#command;
  }

  get current(): Point {
    return this.#current;
  }

  get previousCubicControl(): Point | undefined {
    return this.#previousCubicControl;
  }

  get previousQuadraticControl(): Point | undefined {
    return this.#previousQuadraticControl;
  }

  // The letter of the last command read, which decides whether a smooth curve
  // reflects a control point.
  get previousCommand(): string {
    return this.#previousCommand;
  }

  // Takes the next command letter when there is one; otherwise the numbers that
  // follow repeat the command before them.
  takeCommand(cursor: SvgPathCursor): string {
    this.#command = cursor.takeCommand() ?? this.#command;
    return this.#command;
  }

  // A move-to ends the subpath being drawn and starts the next at `point`. Numbers
  // after it are line-tos, relative when the move was.
  moveTo(point: Point, { relative }: { relative: boolean }): void {
    this.#finishSubpath();
    this.#current = point;
    this.#activeSubpath = { start: point, commands: [] };
    this.forgetControlPoints();
    this.#previousCommand = 'M';
    this.#command = relative ? 'l' : 'L';
  }

  lineTo(to: Point): void {
    this.#addCommand({ kind: 'line', to });
  }

  cubicTo(to: Point, control1: Point, control2: Point): void {
    this.#addCommand({ kind: 'curve', to, control1, control2 });
    this.#previousCubicControl = control2;
    this.#previousQuadraticControl = undefined;
  }

  quadraticTo(to: Point, control1: Point): void {
    this.#addCommand({ kind: 'curve', to, control1 });
    this.#previousQuadraticControl = control1;
    this.#previousCubicControl = undefined;
  }

  // An arc arrives as the cubic curves that approximate it; a smooth curve after it
  // reflects nothing.
  arcTo(curves: readonly SvgShapeCommand[]): void {
    for (const curve of curves) {
      this.#addCommand(curve);
    }
    this.forgetControlPoints();
  }

  forgetControlPoints(): void {
    this.#previousCubicControl = undefined;
    this.#previousQuadraticControl = undefined;
  }

  // Records the letter of a command once all its numbers are read.
  recordCommand(letter: string): void {
    this.#previousCommand = letter;
  }

  // A close-path returns the pen to the subpath's start and ends the subpath. False
  // when no subpath is being drawn.
  close(): boolean {
    const subpath = this.#activeSubpath;
    if (!subpath) {
      return false;
    }
    subpath.commands.push({ kind: 'close' });
    this.#current = subpath.start;
    this.#finishSubpath();
    this.forgetControlPoints();
    this.#previousCommand = 'Z';
    this.#command = '';
    return true;
  }

  // Ends the path: the subpath being drawn is finished, and the subpaths kept are
  // returned.
  finish(): SvgShapeSubpath[] {
    this.#finishSubpath();
    return this.#subpaths;
  }

  #addCommand(nextCommand: SvgShapeCommand): void {
    if (!this.#activeSubpath) {
      this.#activeSubpath = { start: this.#current, commands: [] };
    }
    this.#activeSubpath.commands.push(nextCommand);
    if (nextCommand.kind !== 'close') {
      this.#current = nextCommand.to;
    }
  }

  // Closes the subpath being drawn and keeps it when it encloses anything.
  #finishSubpath(): void {
    if (!this.#activeSubpath) {
      return;
    }
    const closed = closeSvgSubpath(this.#activeSubpath);
    if (svgSubpathHasArea(closed)) {
      this.#subpaths.push(closed);
    }
    this.#activeSubpath = undefined;
  }
}

function parseSvgPathShape(element: Element) {
  const tokens = svgPathTokens(element);
  if (!tokens) {
    return undefined;
  }
  const cursor = svgPathCursor(tokens);
  const reader = new SvgShapePathReader();
  while (!cursor.done()) {
    if (!reader.takeCommand(cursor)) {
      return undefined;
    }
    if (!applySvgShapeCommand(reader, cursor)) {
      return undefined;
    }
  }
  return reader.finish();
}

// One command of a curved path. False when the path is not one this reads.
function applySvgShapeCommand(reader: SvgShapePathReader, cursor: SvgPathCursor): boolean {
  const relative = reader.command === reader.command.toLowerCase();
  const letter = reader.command.toUpperCase();
  switch (letter) {
    case 'M':
      return svgShapeMove(reader, cursor, { relative });
    case 'L':
    case 'H':
    case 'V':
      return svgShapeLines(reader, cursor, { relative, letter });
    case 'C':
    case 'S':
      return svgShapeCubics(reader, cursor, { relative, smooth: letter === 'S' });
    case 'Q':
    case 'T':
      return svgShapeQuadratics(reader, cursor, { relative, smooth: letter === 'T' });
    case 'A':
      return svgShapeArcs(reader, cursor, { relative });
    case 'Z':
      return reader.close();
    default:
      return false;
  }
}

function svgShapeTo(
  reader: SvgShapePathReader,
  x: number,
  y: number,
  { relative }: { relative: boolean },
): Point {
  const current = reader.current;
  return relative ? { x: current.x + x, y: current.y + y } : { x, y };
}

// A move-to ends the subpath being drawn and starts the next; numbers after it are
// line-tos.
function svgShapeMove(
  reader: SvgShapePathReader,
  cursor: SvgPathCursor,
  { relative }: { relative: boolean },
): boolean {
  const numbers = cursor.readNumbers(2);
  if (!numbers) {
    return false;
  }
  reader.moveTo(offsetSvgPoint(reader.current, numbers, { relative }), { relative });
  return true;
}

// Line-tos: to a point (L), along x (H), or along y (V).
function svgShapeLines(
  reader: SvgShapePathReader,
  cursor: SvgPathCursor,
  { relative, letter }: { relative: boolean; letter: 'L' | 'H' | 'V' },
): boolean {
  while (cursor.hasNumber()) {
    const numbers = cursor.readNumbers(letter === 'L' ? 2 : 1);
    if (!numbers) {
      return false;
    }
    const current = reader.current;
    const [first = 0] = numbers;
    const to =
      letter === 'L'
        ? offsetSvgPoint(current, numbers, { relative })
        : letter === 'H'
          ? { x: relative ? current.x + first : first, y: current.y }
          : { x: current.x, y: relative ? current.y + first : first };
    reader.lineTo(to);
  }
  reader.forgetControlPoints();
  reader.recordCommand(letter);
  return true;
}

// Cubic curves (C); a smooth one (S) reflects the previous curve's second control
// point for its first.
function svgShapeCubics(
  reader: SvgShapePathReader,
  cursor: SvgPathCursor,
  { relative, smooth }: { relative: boolean; smooth: boolean },
): boolean {
  while (cursor.hasNumber()) {
    const numbers = cursor.readNumbers(smooth ? 4 : 6);
    if (!numbers) {
      return false;
    }
    const current = reader.current;
    const previous = reader.previousCubicControl;
    const [x1 = 0, y1 = 0] = numbers;
    const control1: Point = !smooth
      ? svgShapeTo(reader, x1, y1, { relative })
      : previous && ['C', 'S'].includes(reader.previousCommand)
        ? { x: current.x * 2 - previous.x, y: current.y * 2 - previous.y }
        : current;
    const [x2 = 0, y2 = 0, x = 0, y = 0] = smooth ? numbers : numbers.slice(2);
    const control2 = svgShapeTo(reader, x2, y2, { relative });
    const to = svgShapeTo(reader, x, y, { relative });
    reader.cubicTo(to, control1, control2);
  }
  reader.recordCommand(smooth ? 'S' : 'C');
  return true;
}

// Quadratic curves (Q); a smooth one (T) reflects the previous curve's control point.
function svgShapeQuadratics(
  reader: SvgShapePathReader,
  cursor: SvgPathCursor,
  { relative, smooth }: { relative: boolean; smooth: boolean },
): boolean {
  while (cursor.hasNumber()) {
    const numbers = cursor.readNumbers(smooth ? 2 : 4);
    if (!numbers) {
      return false;
    }
    const current = reader.current;
    const previous = reader.previousQuadraticControl;
    const [x1 = 0, y1 = 0] = numbers;
    const control1: Point = !smooth
      ? svgShapeTo(reader, x1, y1, { relative })
      : previous && ['Q', 'T'].includes(reader.previousCommand)
        ? { x: current.x * 2 - previous.x, y: current.y * 2 - previous.y }
        : current;
    const [x = 0, y = 0] = smooth ? numbers : numbers.slice(2);
    const to = svgShapeTo(reader, x, y, { relative });
    reader.quadraticTo(to, control1);
  }
  reader.recordCommand(smooth ? 'T' : 'Q');
  return true;
}

// Elliptical arcs, drawn as the cubic curves that approximate them.
function svgShapeArcs(
  reader: SvgShapePathReader,
  cursor: SvgPathCursor,
  { relative }: { relative: boolean },
): boolean {
  while (cursor.hasNumber()) {
    const numbers = cursor.readNumbers(7);
    if (!numbers) {
      return false;
    }
    const [rx = 0, ry = 0, rotation = 0, largeArc = 0, sweep = 0, x = 0, y = 0] = numbers;
    const to = svgShapeTo(reader, x, y, { relative });
    const arcCommands = svgArcToCubicCurves(
      reader.current,
      rx,
      ry,
      rotation,
      { largeArc: largeArc !== 0, sweep: sweep !== 0 },
      to,
    );
    reader.arcTo(arcCommands);
  }
  reader.recordCommand('A');
  return true;
}

function isAxisAlignedSvgContour(points: Point[]) {
  return points.every((point, index) => {
    const next = points[(index + 1) % points.length];
    return (
      next !== undefined &&
      (Math.abs(point.x - next.x) < SVG_POINT_EPSILON ||
        Math.abs(point.y - next.y) < SVG_POINT_EPSILON)
    );
  });
}

function polygonArea(points: Point[]) {
  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return next ? area + point.x * next.y - next.x * point.y : area;
    }, 0) / 2
  );
}

function pointInsidePolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (
    let index = 0, previousIndex = polygon.length - 1;
    index < polygon.length;
    previousIndex = index, index += 1
  ) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    if (!current || !previous) {
      continue;
    }
    const crossesY = current.y > point.y !== previous.y > point.y;
    if (!crossesY) {
      continue;
    }

    const x =
      ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (point.x < x) {
      inside = !inside;
    }
  }

  return inside;
}

function sortedUniqueSvgValues(values: number[]) {
  return [...new Set(values.map((value) => Math.round(value * 100000) / 100000))].sort(
    (left, right) => left - right,
  );
}

function svgGridPointKey(point: Point) {
  return `${point.x},${point.y}`;
}

function traceSvgBoundary(edges: SvgBoundaryEdge[]) {
  const outgoing = new Map<string, SvgBoundaryEdge[]>();
  edges.forEach((edge) => {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge]);
  });

  const unused = new Set(edges);
  const loops: Point[][] = [];

  while (unused.size) {
    const first = unused.values().next();
    if (first.done) {
      break;
    }
    let edge: SvgBoundaryEdge | undefined = first.value;

    const startKey = edge.from;
    const loop: Point[] = [edge.fromPoint];

    while (edge) {
      unused.delete(edge);
      loop.push(edge.toPoint);
      if (edge.to === startKey) {
        break;
      }

      edge = (outgoing.get(edge.to) || []).find((candidate) => unused.has(candidate));
      if (!edge) {
        return undefined;
      }
    }

    const simplified = simplifySvgContour(loop);
    if (simplified.length >= 3 && Math.abs(polygonArea(simplified)) > SVG_POINT_EPSILON) {
      loops.push(simplified);
    }
  }

  return loops;
}

function svgContourBounds(points: Point[]) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
  };
}

function rotateClosedSvgContour(points: Point[], startIndex: number) {
  const rotated = [...points.slice(startIndex), ...points.slice(0, startIndex)];
  const firstPoint = rotated[0];
  return firstPoint ? [...rotated, firstPoint] : [];
}

function closestSvgLoopPair(source: Point[], targets: Point[][]): SvgLoopPair | undefined {
  let best: SvgLoopPair | undefined = undefined;

  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const sourcePoint = source[sourceIndex];
    if (!sourcePoint) {
      continue;
    }
    for (let targetLoopIndex = 0; targetLoopIndex < targets.length; targetLoopIndex += 1) {
      const target = targets[targetLoopIndex];
      if (!target) {
        continue;
      }
      for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
        const targetPoint = target[targetIndex];
        if (!targetPoint) {
          continue;
        }
        const distance = distanceSquared(sourcePoint, targetPoint);
        if (!best || distance < best.distance) {
          best = { sourceIndex, targetLoopIndex, targetIndex, distance };
        }
      }
    }
  }

  return best;
}

function closestSvgPointToLoop(point: Point, targets: Point[][]): SvgLoopPoint | undefined {
  let best: SvgLoopPoint | undefined = undefined;

  for (let targetLoopIndex = 0; targetLoopIndex < targets.length; targetLoopIndex += 1) {
    const target = targets[targetLoopIndex];
    if (!target) {
      continue;
    }
    for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
      const targetPoint = target[targetIndex];
      if (!targetPoint) {
        continue;
      }
      const distance = distanceSquared(point, targetPoint);
      if (!best || distance < best.distance) {
        best = { targetLoopIndex, targetIndex, distance };
      }
    }
  }

  return best;
}

function connectSvgBoundaryLoops(loops: Point[][]) {
  if (!loops.length) {
    return undefined;
  }
  if (loops.length === 1) {
    return loops[0];
  }

  const sortedLoops = [...loops].sort((left, right) => {
    const leftBounds = svgContourBounds(left);
    const rightBounds = svgContourBounds(right);
    return leftBounds.minY - rightBounds.minY || leftBounds.minX - rightBounds.minX;
  });
  const [firstLoop, ...restLoops] = sortedLoops;
  if (!firstLoop) {
    return undefined;
  }
  const firstBridge = closestSvgLoopPair(firstLoop, restLoops);
  if (!firstBridge) {
    return undefined;
  }

  const connected = rotateClosedSvgContour(firstLoop, firstBridge.sourceIndex);
  let currentLoop = restLoops[firstBridge.targetLoopIndex];
  let currentIndex = firstBridge.targetIndex;
  restLoops.splice(firstBridge.targetLoopIndex, 1);

  while (currentLoop) {
    connected.push(...rotateClosedSvgContour(currentLoop, currentIndex));
    if (!restLoops.length) {
      break;
    }

    const currentPoint = currentLoop[currentIndex];
    if (!currentPoint) {
      return undefined;
    }
    const nextBridge = closestSvgPointToLoop(currentPoint, restLoops);
    if (!nextBridge) {
      return undefined;
    }

    currentLoop = restLoops[nextBridge.targetLoopIndex];
    currentIndex = nextBridge.targetIndex;
    restLoops.splice(nextBridge.targetLoopIndex, 1);
  }

  return connected;
}

function unionAxisAlignedSvgContours(contours: Point[][]): SvgClipPathOutline | undefined {
  const xs = sortedUniqueSvgValues(contours.flatMap((contour) => contour.map((point) => point.x)));
  const ys = sortedUniqueSvgValues(contours.flatMap((contour) => contour.map((point) => point.y)));
  if (xs.length < 2 || ys.length < 2) {
    return undefined;
  }
  if ((xs.length - 1) * (ys.length - 1) > SVG_PARSE_CELL_LIMIT) {
    return undefined;
  }

  const filled = filledSvgGridCells(xs, ys, contours);
  if (!filled?.size) {
    return undefined;
  }
  const edges = svgGridBoundaryEdges(xs, ys, filled);
  if (!edges) {
    return undefined;
  }
  const loops = traceSvgBoundary(edges);
  if (!loops) {
    return undefined;
  }

  const connectedPoints = connectSvgBoundaryLoops(loops);
  return connectedPoints ? { points: connectedPoints, loops } : undefined;
}

const svgGridCellKey = (xIndex: number, yIndex: number) => `${xIndex}:${yIndex}`;

// The cell between grid lines (xIndex, yIndex): its corners, or undefined when a
// line is missing.
function svgGridCell(xs: number[], ys: number[], xIndex: number, yIndex: number) {
  const xStart = xs[xIndex];
  const xEnd = xs[xIndex + 1];
  const yStart = ys[yIndex];
  const yEnd = ys[yIndex + 1];
  if (xStart === undefined || xEnd === undefined || yStart === undefined || yEnd === undefined) {
    return undefined;
  }
  return { xStart, xEnd, yStart, yEnd };
}

// The grid cells (by key) whose centres fall inside any of the contours. Undefined
// when the grid is malformed.
function filledSvgGridCells(
  xs: number[],
  ys: number[],
  contours: Point[][],
): Set<string> | undefined {
  const filled = new Set<string>();
  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      const cell = svgGridCell(xs, ys, xIndex, yIndex);
      if (!cell) {
        return undefined;
      }
      const center = { x: (cell.xStart + cell.xEnd) / 2, y: (cell.yStart + cell.yEnd) / 2 };
      if (contours.some((contour) => pointInsidePolygon(center, contour))) {
        filled.add(svgGridCellKey(xIndex, yIndex));
      }
    }
  }
  return filled;
}

// The outline of the filled cells: every cell side that has no filled neighbour
// across it, oriented clockwise. Undefined when the grid is malformed.
function svgGridBoundaryEdges(
  xs: number[],
  ys: number[],
  filled: Set<string>,
): SvgBoundaryEdge[] | undefined {
  const isFilled = (xIndex: number, yIndex: number) => filled.has(svgGridCellKey(xIndex, yIndex));
  const edges: SvgBoundaryEdge[] = [];
  const addEdge = (fromPoint: Point, toPoint: Point) => {
    edges.push({
      from: svgGridPointKey(fromPoint),
      to: svgGridPointKey(toPoint),
      fromPoint,
      toPoint,
    });
  };

  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      if (!isFilled(xIndex, yIndex)) {
        continue;
      }
      const cell = svgGridCell(xs, ys, xIndex, yIndex);
      if (!cell) {
        return undefined;
      }
      const topLeft = { x: cell.xStart, y: cell.yStart };
      const topRight = { x: cell.xEnd, y: cell.yStart };
      const bottomRight = { x: cell.xEnd, y: cell.yEnd };
      const bottomLeft = { x: cell.xStart, y: cell.yEnd };

      if (!isFilled(xIndex, yIndex - 1)) {
        addEdge(topLeft, topRight);
      }
      if (!isFilled(xIndex + 1, yIndex)) {
        addEdge(topRight, bottomRight);
      }
      if (!isFilled(xIndex, yIndex + 1)) {
        addEdge(bottomRight, bottomLeft);
      }
      if (!isFilled(xIndex - 1, yIndex)) {
        addEdge(bottomLeft, topLeft);
      }
    }
  }
  return edges;
}

function parseSvgElementContour(element: Element) {
  const tagName = svgTagName(element);
  if (tagName === 'rect') {
    return parseSvgRect(element);
  }
  if (tagName === 'polygon') {
    return parseSvgPoints(svgAttribute(element, 'points'));
  }
  if (tagName === 'polyline') {
    return parseClosedSvgPolyline(svgAttribute(element, 'points'));
  }
  if (tagName === 'path') {
    return parseSimpleSvgPath(element);
  }
  return undefined;
}

function parseSvgElementShape(element: Element) {
  const tagName = svgTagName(element);
  if (tagName === 'rect') {
    return parseSvgRectShape(element);
  }
  if (tagName === 'circle') {
    return parseSvgCircleShape(element);
  }
  if (tagName === 'ellipse') {
    return parseSvgEllipseElementShape(element);
  }
  if (tagName === 'polygon') {
    return parseSvgPolygonShape(element, false);
  }
  if (tagName === 'polyline') {
    return parseSvgPolygonShape(element, true);
  }
  if (tagName === 'path') {
    return parseSvgPathShape(element);
  }
  return undefined;
}

function svgShapeFillRule(
  svg: Element,
  elements: Element[],
): ShapeFunctionShape['fillRule'] | undefined {
  const values = [svg, ...elements].map(
    (element) =>
      inheritedSvgAttribute(element, 'fill-rule') || inheritedSvgAttribute(element, 'clip-rule'),
  );
  return values.some((value) => value?.trim().toLowerCase() === 'evenodd') ? 'evenodd' : undefined;
}

function normalizeSvgContourToPercent(points: Point[], viewBox: SvgViewBox) {
  const normalized = points.map((point) => ({
    x: ((point.x - viewBox.x) / viewBox.width) * 100,
    y: ((point.y - viewBox.y) / viewBox.height) * 100,
  }));

  return normalized.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) &&
    normalized.length >= 3
    ? normalized
    : undefined;
}

function parseSvgDocument(value: string) {
  const markup = extractSvgMarkup(value);
  if (!markup || typeof DOMParser === 'undefined') {
    return undefined;
  }

  const document = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (document.querySelector('parsererror')) {
    return undefined;
  }

  const svg =
    svgTagName(document.documentElement) === 'svg'
      ? document.documentElement
      : document.querySelector('svg');
  return svg ? { document, svg } : undefined;
}

function parseSvgClipPathOutline(value: string): SvgClipPathOutline | undefined {
  const parsedDocument = parseSvgDocument(value);
  if (!parsedDocument) {
    return undefined;
  }
  const { svg } = parsedDocument;

  const supportedElements = Array.from(svg.querySelectorAll('rect, polygon, polyline, path'));
  const unsupportedElements = Array.from(svg.querySelectorAll('circle, ellipse, line')).filter(
    (element) => !isInsideSkippedSvgElement(element) && isRenderableSvgElement(element),
  );
  if (unsupportedElements.length) {
    return undefined;
  }

  const contours: Point[][] = [];
  for (const element of supportedElements) {
    if (isInsideSkippedSvgElement(element) || !isRenderableSvgElement(element)) {
      continue;
    }
    if (hasSvgTransform(element)) {
      return undefined;
    }

    const contour = parseSvgElementContour(element);
    if (contour === undefined) {
      return undefined;
    }
    if (contour.length >= 3) {
      contours.push(simplifySvgContour(contour));
    }
  }

  if (!contours.length) {
    return undefined;
  }

  const outline =
    contours.length === 1
      ? contours[0]
        ? { points: contours[0], loops: [contours[0]] }
        : undefined
      : contours.every(isAxisAlignedSvgContour)
        ? unionAxisAlignedSvgContours(contours)
        : undefined;
  if (!outline?.points.length) {
    return undefined;
  }

  const viewBox = parseSvgViewBox(svg, contours);
  if (!viewBox) {
    return undefined;
  }

  const points = normalizeSvgContourToPercent(outline.points, viewBox);
  const loops = outline.loops
    .map((loop) => normalizeSvgContourToPercent(loop, viewBox))
    .filter((loop): loop is Point[] => Boolean(loop?.length));
  return points && loops.length ? { points, loops } : undefined;
}

function parseSvgClipPathShape(
  value: string,
  fitMode: ShapeFitMode = 'stretch',
  options: ShapeScaleOptions = DEFAULT_SHAPE_SCALE_OPTIONS,
): ShapeFunctionShape | undefined {
  const parsedDocument = parseSvgDocument(value);
  if (!parsedDocument) {
    return undefined;
  }
  const { svg } = parsedDocument;

  const supportedElements = Array.from(
    svg.querySelectorAll('rect, circle, ellipse, polygon, polyline, path'),
  );
  const unsupportedElements = Array.from(svg.querySelectorAll('image, text, use, line')).filter(
    (element) => !isInsideSkippedSvgElement(element) && isRenderableSvgElement(element),
  );
  if (unsupportedElements.length) {
    return undefined;
  }

  const renderedElements: Element[] = [];
  const subpaths: SvgShapeSubpath[] = [];
  for (const element of supportedElements) {
    if (isInsideSkippedSvgElement(element) || !isRenderableSvgElement(element)) {
      continue;
    }
    if (hasSvgTransform(element)) {
      return undefined;
    }

    const elementSubpaths = parseSvgElementShape(element);
    if (elementSubpaths === undefined) {
      return undefined;
    }
    if (elementSubpaths.length) {
      renderedElements.push(element);
      subpaths.push(...elementSubpaths);
    }
  }

  const viewBox = parseSvgViewBox(svg, [svgShapeSubpathPoints(subpaths)]);
  const viewBoxBounds = viewBox ? svgShapeBoundsFromViewBox(viewBox) : undefined;
  const fitted = fitShapeSubpathsToPercentBox(subpaths, viewBoxBounds);
  if (!fitted) {
    return undefined;
  }

  const fillRule = svgShapeFillRule(svg, renderedElements);
  if (fitMode === 'contain') {
    const contained = containShapeSubpathsToCss(subpaths, viewBoxBounds, options);
    return contained
      ? {
          kind: 'shape',
          value: formatShapeValueFromCssSubpaths(contained),
          ...(fillRule ? { fillRule } : {}),
          pathData: formatPathDataFromSubpaths(fitted),
        }
      : undefined;
  }

  return shapeFromSvgSubpaths(fitted, fillRule);
}

function parseSvgClipPathPolygon(value: string): PolygonShape | undefined {
  const outline = parseSvgClipPathOutline(value);
  return outline ? { kind: 'polygon', points: outline.points } : undefined;
}

function isNoneClipPathValue(value: string | undefined) {
  return !value || value.trim().toLowerCase() === 'none';
}

function normalizeClipPathValue(value: string | undefined) {
  if (isNoneClipPathValue(value)) {
    return { shape: NONE_SHAPE, css: 'none' };
  }

  const parsed = parseClipPathInput(value || '');
  return {
    shape: parsed || NONE_SHAPE,
    css: parsed ? formatClipPath(parsed) : 'none',
  };
}

function shortcutShapeKind(shape: ClipShape) {
  if (shape.kind !== 'raw') {
    return shape.kind;
  }
  return shape.editable?.kind || 'raw';
}

// The shortcuts that hold for every shape.
const GENERAL_SHORTCUTS: ShortcutHelpGroup = {
  title: 'General',
  items: [
    { keys: 'Arrow keys', description: 'Move the selected handle by 1%.' },
    { keys: 'Space + Arrow keys', description: 'Move by 10% instead of 1%.' },
    { keys: 'Cmd/Ctrl + Z', description: 'Undo the last change.' },
    { keys: 'Cmd/Ctrl + Shift + Z', description: 'Redo the last change.' },
    { keys: 'Paste SVG', description: 'Paste an SVG to build a shape.' },
  ],
};

const POLYGON_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Polygon',
    items: [
      { keys: 'Drag to select', description: 'Drag to select over multiple points.' },
      { keys: 'Shift + click point', description: 'Select multiple points.' },
      {
        keys: 'Option/Alt + drag point',
        description: 'Duplicate a point by dragging it while holding option/alt.',
      },
      { keys: 'Delete / Backspace', description: 'Delete selected points (3 must remain).' },
      { keys: 'Cmd/Ctrl + D', description: 'Duplicate the selected point.' },
    ],
  },
];

const CIRCLE_SHORTCUTS: ShortcutHelpGroup[] = [
  { title: 'Center', items: [{ keys: 'drag/arrow keys', description: 'Move the center.' }] },
  { title: 'Radius', items: [{ keys: 'drag/arrow keys', description: 'Resize the radius.' }] },
];

const ELLIPSE_SHORTCUTS: ShortcutHelpGroup[] = [
  { title: 'Center', items: [{ keys: 'drag/arrow keys', description: 'Move the center.' }] },
  {
    title: 'Radius',
    items: [
      { keys: 'drag/arrow keys', description: 'Resize the selected radius.' },
      {
        keys: 'Shift + drag/arrow keys',
        description: 'Scale both radii, keeping the aspect ratio.',
      },
    ],
  },
];

const INSET_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Sides',
    items: [
      { keys: 'drag/arrow keys', description: 'Adjust the selected side.' },
      {
        keys: 'Option/Alt + drag/arrow keys',
        description: 'Adjust this side and its opposite side together.',
      },
      { keys: 'Shift + drag/arrow keys', description: 'Adjust all sides together.' },
    ],
  },
  {
    title: 'Corners',
    items: [
      { keys: 'drag/arrow keys', description: 'Round the selected corner.' },
      {
        keys: 'Option/Alt + drag/arrow keys',
        description: 'Round this corner and its opposite together.',
      },
      { keys: 'Shift + drag/arrow keys', description: 'Match all corners to this one.' },
      {
        keys: 'U + drag/arrow keys',
        description: 'Set horizontal and vertical radius separately.',
      },
    ],
  },
];

const SCALED_SHAPE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Shape',
    items: [
      { keys: 'Drag/arrow keys', description: 'Move the shape.' },
      { keys: 'Drag corner', description: 'Resize toward the opposite corner.' },
      { keys: 'Option/Alt + drag corner', description: 'Resize from the center.' },
    ],
  },
];

const STRETCHED_SHAPE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Shape',
    items: [{ keys: 'Stretch mode', description: 'Switch to Scale to move or resize.' }],
  },
];

const NONE_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'None',
    items: [
      { keys: 'Paste SVG', description: 'Paste an SVG to build a shape.' },
      { keys: 'Dropdown', description: 'Pick a preset to start editing.' },
    ],
  },
];

const CUSTOM_SHORTCUTS: ShortcutHelpGroup[] = [
  {
    title: 'Custom',
    items: [
      { keys: 'Code editor', description: 'Edit the raw clip-path value.' },
      { keys: 'Paste SVG', description: 'Paste an SVG to make it editable.' },
    ],
  },
];

// The shortcut help by the kind of shape being edited; anything else is custom.
const SHORTCUTS_BY_KIND: Partial<Record<string, ShortcutHelpGroup[]>> = {
  polygon: POLYGON_SHORTCUTS,
  circle: CIRCLE_SHORTCUTS,
  ellipse: ELLIPSE_SHORTCUTS,
  inset: INSET_SHORTCUTS,
  none: NONE_SHORTCUTS,
};

// The shortcut help for the shape being edited, then the general shortcuts.
function clipPathShortcutGroups(shape: ClipShape, shapeFitMode: ShapeFitMode): ShortcutHelpGroup[] {
  const kind = shortcutShapeKind(shape);
  if (kind === 'shape') {
    const shapeGroups =
      shapeFitMode === 'contain' ? SCALED_SHAPE_SHORTCUTS : STRETCHED_SHAPE_SHORTCUTS;
    return [...shapeGroups, GENERAL_SHORTCUTS];
  }
  return [...(SHORTCUTS_BY_KIND[kind] ?? CUSTOM_SHORTCUTS), GENERAL_SHORTCUTS];
}

function matchPreset(shape: ClipShape): string | undefined {
  if (shape.kind === 'polygon') {
    return 'Polygon';
  }
  if (shape.kind === 'circle') {
    return 'Circle';
  }
  if (shape.kind === 'ellipse') {
    return 'Ellipse';
  }
  if (shape.kind === 'inset') {
    return 'Inset';
  }
  if (shape.kind === 'shape') {
    return 'Shape';
  }
  if (shape.kind === 'raw') {
    return shape.preset || undefined;
  }

  for (const [name, preset] of Object.entries(PRESETS)) {
    if (shapesClose(preset, shape)) {
      return name;
    }
  }
  return undefined;
}

function presetOptionId(name: string) {
  return `clip-path_preset-option-${name.toLowerCase().replace(/\s+/g, '-')}`;
}

function cssUnitPx(unit: string, axis: 'x' | 'y', canvas: HTMLElement) {
  const rect = canvas.getBoundingClientRect();
  return previewUnitPx(unit, axis, { width: rect.width, height: rect.height });
}

function cssUnitValueToCanvasPercent(value: CssUnitValue, axis: 'x' | 'y', canvas: HTMLElement) {
  const rect = canvas.getBoundingClientRect();
  const axisSize = axis === 'x' ? rect.width : rect.height;
  if (axisSize <= 0) {
    return value.value;
  }
  return ((value.value * cssUnitPx(value.unit, axis, canvas)) / axisSize) * 100;
}

function canvasPercentToCssUnitValue(
  percent: number,
  axis: 'x' | 'y',
  unit: string,
  canvas: HTMLElement,
): CssUnitValue {
  const rect = canvas.getBoundingClientRect();
  const axisSize = axis === 'x' ? rect.width : rect.height;
  const unitPx = cssUnitPx(unit, axis, canvas);
  const value = unitPx > 0 ? ((percent / 100) * axisSize) / unitPx : percent;
  return { value, unit };
}

function cssUnitValueToken(value: CssUnitValue) {
  return formatCssUnitValue(value);
}

function cssUnitCalculationToken(left: CssUnitValue, operator: '+' | '-', right: CssUnitValue) {
  return `calc(${cssUnitValueToken(left)} ${operator} ${cssUnitValueToken(right)})`;
}

function insetBox(shape: InsetShape) {
  const x0 = shape.left;
  const y0 = shape.top;
  const x1 = 100 - shape.right;
  const y1 = 100 - shape.bottom;
  return {
    x0,
    y0,
    x1,
    y1,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  };
}

function insetRadiusToCanvas(shape: InsetShape, radius: CornerRadius): CornerRadius {
  const { width, height } = insetBox(shape);
  return {
    x: Math.max(0, (radius.x / 100) * width),
    y: Math.max(0, (radius.y / 100) * height),
  };
}

function expandCssUnitValues(
  values: CssUnitValue[],
  fallback: CssUnitValue = { value: 0, unit: '%' },
): [CssUnitValue, CssUnitValue, CssUnitValue, CssUnitValue] {
  const first = values[0] || fallback;
  return [first, values[1] || first, values[2] || first, values[3] || values[1] || first];
}

function cssCoordinateExpressionToCanvasPercent(
  expression: string,
  axis: 'x' | 'y',
  canvas: HTMLElement,
) {
  const rect = canvas.getBoundingClientRect();
  const axisSize = axis === 'x' ? rect.width : rect.height;
  if (axisSize <= 0 || typeof document === 'undefined') {
    return undefined;
  }

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.width = '0';
  probe.style.height = '0';
  probe.style.pointerEvents = 'none';
  probe.style.visibility = 'hidden';
  if (axis === 'x') {
    probe.style.left = previewCssCoordinateToken(expression, axis, {
      width: rect.width,
      height: rect.height,
    });
    probe.style.top = '0';
  } else {
    probe.style.left = '0';
    probe.style.top = previewCssCoordinateToken(expression, axis, {
      width: rect.width,
      height: rect.height,
    });
  }

  canvas.appendChild(probe);
  const probeRect = probe.getBoundingClientRect();
  probe.remove();

  const offset = axis === 'x' ? probeRect.left - rect.left : probeRect.top - rect.top;
  if (!Number.isFinite(offset)) {
    return undefined;
  }
  return (offset / axisSize) * 100;
}

function cssCoordinateValueToCanvasPercent(
  value: CssCoordinateValue,
  axis: 'x' | 'y',
  canvas: HTMLElement,
) {
  return isCssUnitValue(value)
    ? cssUnitValueToCanvasPercent(value, axis, canvas)
    : cssCoordinateExpressionToCanvasPercent(value.expression, axis, canvas);
}

function partialCssCoordinatePointToCanvasPoint(
  point: CssCoordinatePoint,
  canvas: HTMLElement,
): Point | undefined {
  const x = cssCoordinateValueToCanvasPercent(point.x, 'x', canvas);
  const y = cssCoordinateValueToCanvasPercent(point.y, 'y', canvas);
  if (x === undefined && y === undefined) {
    return undefined;
  }
  return {
    x: x ?? 0,
    y: y ?? 0,
  };
}

function rawInsetBox(shape: Extract<RawEditableClipPath, { kind: 'inset' }>, canvas: HTMLElement) {
  const left = cssUnitValueToCanvasPercent(shape.left, 'x', canvas);
  const top = cssUnitValueToCanvasPercent(shape.top, 'y', canvas);
  const right = 100 - cssUnitValueToCanvasPercent(shape.right, 'x', canvas);
  const bottom = 100 - cssUnitValueToCanvasPercent(shape.bottom, 'y', canvas);
  return {
    x0: left,
    y0: top,
    x1: right,
    y1: bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function rawEditableHandlePoint(
  editable: RawEditableClipPath,
  handle: HandleTarget,
  canvas: HTMLElement,
): Point | undefined {
  if (handle.kind === 'polygon-point' && editable.kind === 'polygon') {
    const point = editable.points[handle.index];
    return point ? partialCssCoordinatePointToCanvasPoint(point, canvas) : undefined;
  }

  if (editable.kind === 'circle') {
    if (handle.kind === 'circle-center') {
      return {
        x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
      };
    }
    if (handle.kind === 'circle-radius') {
      return {
        x:
          cssUnitValueToCanvasPercent(editable.cx, 'x', canvas) +
          cssUnitValueToCanvasPercent(editable.radius, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
      };
    }
  }

  if (editable.kind === 'ellipse') {
    if (handle.kind === 'ellipse-center') {
      return {
        x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
      };
    }
    if (handle.kind === 'ellipse-rx') {
      return {
        x:
          cssUnitValueToCanvasPercent(editable.cx, 'x', canvas) +
          cssUnitValueToCanvasPercent(editable.rx, 'x', canvas),
        y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
      };
    }
    if (handle.kind === 'ellipse-ry') {
      return {
        x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas),
        y:
          cssUnitValueToCanvasPercent(editable.cy, 'y', canvas) +
          cssUnitValueToCanvasPercent(editable.ry, 'y', canvas),
      };
    }
  }

  if (editable.kind !== 'inset') {
    return undefined;
  }
  return rawInsetHandlePoint(editable, handle, canvas);
}

// Where a raw inset's edge or corner-radius handle sits on the canvas.
function rawInsetHandlePoint(
  editable: Extract<RawEditableClipPath, { kind: 'inset' }>,
  handle: HandleTarget,
  canvas: HTMLElement,
): Point | undefined {
  const box = rawInsetBox(editable, canvas);
  if (handle.kind === 'inset-top') {
    return { x: box.x0 + box.width / 2, y: box.y0 };
  }
  if (handle.kind === 'inset-right') {
    return { x: box.x1, y: box.y0 + box.height / 2 };
  }
  if (handle.kind === 'inset-bottom') {
    return { x: box.x0 + box.width / 2, y: box.y1 };
  }
  if (handle.kind === 'inset-left') {
    return { x: box.x0, y: box.y0 + box.height / 2 };
  }

  if (handle.kind === 'inset-radius' && editable.radii) {
    const horizontal = expandCssUnitValues(editable.radii.horizontal);
    const vertical = expandCssUnitValues(editable.radii.vertical || editable.radii.horizontal);
    const index = CORNERS.indexOf(handle.corner);
    const horizontalRadius = horizontal[index];
    const verticalRadius = vertical[index];
    if (!horizontalRadius || !verticalRadius) {
      return undefined;
    }
    const radiusX = cssUnitValueToCanvasPercent(horizontalRadius, 'x', canvas);
    const radiusY = cssUnitValueToCanvasPercent(verticalRadius, 'y', canvas);
    if (handle.corner === 'topLeft') {
      return { x: box.x0 + radiusX, y: box.y0 + radiusY };
    }
    if (handle.corner === 'topRight') {
      return { x: box.x1 - radiusX, y: box.y0 + radiusY };
    }
    if (handle.corner === 'bottomRight') {
      return { x: box.x1 - radiusX, y: box.y1 - radiusY };
    }
    return { x: box.x0 + radiusX, y: box.y1 - radiusY };
  }

  return undefined;
}

function rawEditableHandleCssPoint(
  editable: RawEditableClipPath,
  handle: HandleTarget,
): { x: string; y: string } | undefined {
  if (handle.kind === 'polygon-point' && editable.kind === 'polygon') {
    const point = editable.points[handle.index];
    return point
      ? {
          x: formatCssCoordinateValueForPreview(point.x),
          y: formatCssCoordinateValueForPreview(point.y),
        }
      : undefined;
  }

  if (editable.kind === 'circle') {
    if (handle.kind === 'circle-center') {
      return { x: cssUnitValueToken(editable.cx), y: cssUnitValueToken(editable.cy) };
    }
    if (handle.kind === 'circle-radius') {
      return {
        x: cssUnitCalculationToken(editable.cx, '+', editable.radius),
        y: cssUnitValueToken(editable.cy),
      };
    }
  }

  if (editable.kind === 'ellipse') {
    if (handle.kind === 'ellipse-center') {
      return { x: cssUnitValueToken(editable.cx), y: cssUnitValueToken(editable.cy) };
    }
    if (handle.kind === 'ellipse-rx') {
      return {
        x: cssUnitCalculationToken(editable.cx, '+', editable.rx),
        y: cssUnitValueToken(editable.cy),
      };
    }
    if (handle.kind === 'ellipse-ry') {
      return {
        x: cssUnitValueToken(editable.cx),
        y: cssUnitCalculationToken(editable.cy, '+', editable.ry),
      };
    }
  }

  if (editable.kind !== 'inset') {
    return undefined;
  }
  return rawInsetHandleCssPoint(editable, handle);
}

// Where a raw inset's edge or corner-radius handle sits, as CSS the preview resolves.
function rawInsetHandleCssPoint(
  editable: Extract<RawEditableClipPath, { kind: 'inset' }>,
  handle: HandleTarget,
): { x: string; y: string } | undefined {
  const left = cssUnitValueToken(editable.left);
  const top = cssUnitValueToken(editable.top);
  const right = `calc(100% - ${cssUnitValueToken(editable.right)})`;
  const bottom = `calc(100% - ${cssUnitValueToken(editable.bottom)})`;
  if (handle.kind === 'inset-top') {
    return { x: `calc((${left} + ${right}) / 2)`, y: top };
  }
  if (handle.kind === 'inset-right') {
    return { x: right, y: `calc((${top} + ${bottom}) / 2)` };
  }
  if (handle.kind === 'inset-bottom') {
    return { x: `calc((${left} + ${right}) / 2)`, y: bottom };
  }
  if (handle.kind === 'inset-left') {
    return { x: left, y: `calc((${top} + ${bottom}) / 2)` };
  }

  if (handle.kind === 'inset-radius' && editable.radii) {
    const horizontal = expandCssUnitValues(editable.radii.horizontal);
    const vertical = expandCssUnitValues(editable.radii.vertical || editable.radii.horizontal);
    const index = CORNERS.indexOf(handle.corner);
    const radiusX = horizontal[index];
    const radiusY = vertical[index];
    if (!radiusX || !radiusY) {
      return undefined;
    }
    if (handle.corner === 'topLeft') {
      return {
        x: cssUnitCalculationToken(editable.left, '+', radiusX),
        y: cssUnitCalculationToken(editable.top, '+', radiusY),
      };
    }
    if (handle.corner === 'topRight') {
      return {
        x: `calc(100% - ${cssUnitValueToken(editable.right)} - ${cssUnitValueToken(radiusX)})`,
        y: cssUnitCalculationToken(editable.top, '+', radiusY),
      };
    }
    if (handle.corner === 'bottomRight') {
      return {
        x: `calc(100% - ${cssUnitValueToken(editable.right)} - ${cssUnitValueToken(radiusX)})`,
        y: `calc(100% - ${cssUnitValueToken(editable.bottom)} - ${cssUnitValueToken(radiusY)})`,
      };
    }
    return {
      x: cssUnitCalculationToken(editable.left, '+', radiusX),
      y: `calc(100% - ${cssUnitValueToken(editable.bottom)} - ${cssUnitValueToken(radiusY)})`,
    };
  }

  return undefined;
}

const MEDIUM_BREAKPOINT_ICON_PATH =
  'M3 3C3 2.44772 3.44772 2 4 2H12C12.5523 2 13 2.44772 13 3V13' +
  'C13 13.5523 12.5523 14 12 14H4C3.44772 14 3 13.5523 3 13V3ZM4 3H12V13H4V3Z';
const SMALL_BREAKPOINT_ICON_PATH =
  'M4 12C2.89543 12 2 11.1046 2 10L2 6C2 4.89543 2.89543 4 4 4L12 4C13.1046 4 14 4.89543 14 6' +
  'V10C14 11.1046 13.1046 12 12 12H4ZM3 10L3 6C3 5.44772 3.44772 5 4 5L12 5C12.5523 ' +
  '5 13 5.44772 13 6V10C13 10.5523 12.5523 11 12 11L4 11C3.44772 11 3 10.5523 3 10Z';
const TINY_BREAKPOINT_ICON_PATH =
  'M4 4C4 2.89543 4.89543 2 6 2H10C11.1046 2 12 2.89543 12 4V12C12 13.1046 11.1046 ' +
  '14 10 14H6C4.89543 14 4 13.1046 4 12V4ZM6 3H10C10.5523 3 11 3.44772 11 4V12' +
  'C11 12.5523 10.5523 13 10 13H6C5.44772 13 5 12.5523 5 12V4C5 3.44772 5.44772 3 6 3Z';
const DESKTOP_BREAKPOINT_ICON_PATH =
  'M12 5.36602L10.1519 6.43301L9.65192 5.56699L11.5 4.5L9.65193 3.43301' +
  'L10.1519 2.56699L12 3.63397V1.5H13V3.63397L14.8481 2.56699L15.3481 3.43301' +
  'L13.5 4.5L15.3481 5.56699L14.8481 6.43301L13 5.36602V7.5H12V5.36602Z';

function BreakpointIcon({ breakpoint }: { breakpoint: BreakpointId }) {
  if (breakpoint === 'medium') {
    return (
      <svg className="clip-path_source-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9.5 11H6.5V12H9.5V11Z" />
        <path fillRule="evenodd" clipRule="evenodd" d={MEDIUM_BREAKPOINT_ICON_PATH} />
      </svg>
    );
  }
  if (breakpoint === 'small') {
    return (
      <svg className="clip-path_source-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M12 9V7H11V9H12Z" />
        <path fillRule="evenodd" clipRule="evenodd" d={SMALL_BREAKPOINT_ICON_PATH} />
      </svg>
    );
  }
  if (breakpoint === 'tiny') {
    return (
      <svg className="clip-path_source-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M7 12H9V11H7V12Z" />
        <path fillRule="evenodd" clipRule="evenodd" d={TINY_BREAKPOINT_ICON_PATH} />
      </svg>
    );
  }
  // Desktop (main) and all larger breakpoints (large / xl / xxl).
  return (
    <svg className="clip-path_source-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={DESKTOP_BREAKPOINT_ICON_PATH} />
      <path d="M3 4H8V5H3V12H13V9H14V12H16V13H0V12H2V5C2 4.44772 2.44772 4 3 4Z" />
    </svg>
  );
}

function PresetIcon({ shape }: { shape: ClipShape }) {
  if (shape.kind === 'none') {
    return (
      <svg
        className="clip-path_preset-icon"
        viewBox="-8 -8 116 116"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <line x1="22" y1="78" x2="78" y2="22" />
      </svg>
    );
  }

  const insetIconRadius =
    shape.kind === 'inset'
      ? Math.max(36, ...CORNERS.flatMap((corner) => [shape.radii[corner].x, shape.radii[corner].y]))
      : 0;

  return (
    <svg
      className="clip-path_preset-icon"
      viewBox="-8 -8 116 116"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {shape.kind === 'polygon' ? (
        <polygon points={shape.points.map((point) => `${point.x},${point.y}`).join(' ')} />
      ) : undefined}
      {shape.kind === 'circle' ? (
        <circle cx={shape.cx} cy={shape.cy} r={shape.radius} />
      ) : undefined}
      {shape.kind === 'ellipse' ? (
        <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />
      ) : undefined}
      {shape.kind === 'inset' ? (
        <rect x="0" y="0" width="100" height="100" rx={insetIconRadius} ry={insetIconRadius} />
      ) : undefined}
      {shape.kind === 'shape' ? (
        <path d={shape.pathData || DEFAULT_SHAPE_PATH_DATA} fillRule={shape.fillRule} />
      ) : undefined}
      {shape.kind === 'raw' ? (
        <path d="M16 70C16 42 34 24 56 28C82 32 84 56 62 58C44 60 42 80 62 84C78 88 92 78 92 58" />
      ) : undefined}
    </svg>
  );
}

// How a drag bends a shape: which sides and corners move together, whether the
// radii stay round, whether an ellipse keeps its proportions, and the canvas the
// raw CSS units are measured against.
type ShapeDragOptions = {
  insetSideMode?: InsetSideMode;
  insetRadiusMode?: InsetRadiusMode;
  insetRadiusUnlocked?: boolean;
  ellipseScaleProportional?: boolean;
  canvas?: HTMLElement | undefined;
};
type RawEditable<Kind extends RawEditableClipPath['kind']> = Extract<
  RawEditableClipPath,
  { kind: Kind }
>;

function updateShapeForDrag(
  shape: ClipShape,
  target: DragTarget,
  x: number,
  y: number,
  options: ShapeDragOptions = {},
): ClipShape {
  if (shape.kind === 'none') {
    return shape;
  }
  if (shape.kind === 'raw' && shape.editable && options.canvas) {
    const next = updateRawShapeForDrag(shape, target, { x, y }, options, options.canvas);
    if (next) {
      return next;
    }
  }
  if (target.kind === 'polygon-point' && shape.kind === 'polygon') {
    return dragPolygonPoint(shape, target, x, y);
  }
  if (shape.kind === 'circle' || shape.kind === 'ellipse') {
    return dragRoundShape(shape, target, x, y, options);
  }
  if (shape.kind === 'inset') {
    return dragInset(shape, target, x, y, options);
  }
  return shape;
}

// A drag on a shape written in raw CSS units, converted through the canvas. Undefined
// when the handle is not one this shape has.
function updateRawShapeForDrag(
  shape: RawClipPathShape,
  target: DragTarget,
  point: Point,
  options: ShapeDragOptions,
  canvas: HTMLElement,
): ClipShape | undefined {
  const editable = shape.editable;
  if (target.kind === 'polygon-point' && editable?.kind === 'polygon') {
    return dragRawPolygonPoint(shape, editable, target, point, canvas);
  }
  if (editable?.kind === 'circle') {
    return dragRawCircle(shape, editable, target, point, canvas);
  }
  if (editable?.kind === 'ellipse') {
    return dragRawEllipse(shape, editable, target, point, options, canvas);
  }
  if (editable?.kind === 'inset') {
    const side = insetSideForHandle(target);
    if (side) {
      return dragRawInsetSide(shape, editable, side, point, options, canvas);
    }
    if (target.kind === 'inset-radius' && editable.radii) {
      return dragRawInsetRadius(shape, editable, target.corner, point, options, canvas);
    }
  }
  return undefined;
}

// The shape with its raw editable replaced, and its CSS rewritten to match.
function withRawEditable(shape: RawClipPathShape, nextEditable: RawEditableClipPath): ClipShape {
  return { ...shape, editable: nextEditable, value: formatRawEditableClipPath(nextEditable) };
}

// Moves the dragged raw polygon point, and the other selected points with it.
function dragRawPolygonPoint(
  shape: RawClipPathShape,
  editable: RawEditable<'polygon'>,
  target: DragTarget & { kind: 'polygon-point' },
  { x, y }: Point,
  canvas: HTMLElement,
): ClipShape {
  const selectedIndexes = new Set(
    target.polygonPointIndexes?.length ? target.polygonPointIndexes : [target.index],
  );
  const beforeEditable =
    target.before.kind === 'raw' && target.before.editable?.kind === 'polygon'
      ? target.before.editable
      : editable;
  const beforePoint = beforeEditable.points[target.index];
  if (!beforePoint) {
    return shape;
  }
  if (!isCssUnitValue(beforePoint.x) && !isCssUnitValue(beforePoint.y)) {
    return shape;
  }
  const beforeCanvasPoint = {
    x: isCssUnitValue(beforePoint.x) ? cssUnitValueToCanvasPercent(beforePoint.x, 'x', canvas) : x,
    y: isCssUnitValue(beforePoint.y) ? cssUnitValueToCanvasPercent(beforePoint.y, 'y', canvas) : y,
  };
  const dx = isCssUnitValue(beforePoint.x) ? x - beforeCanvasPoint.x : 0;
  const dy = isCssUnitValue(beforePoint.y) ? y - beforeCanvasPoint.y : 0;
  const nextEditable: RawEditableClipPath = {
    ...editable,
    points: editable.points.map((point, index) => {
      if (!selectedIndexes.has(index)) {
        return point;
      }
      return offsetRawPoint(point, beforeEditable.points[index] || point, { dx, dy }, canvas);
    }),
  };
  return withRawEditable(shape, nextEditable);
}

// A selected raw point moved by the drag: its coordinates that are plain units
// follow, measured from where the point was when the drag began.
function offsetRawPoint(
  point: CssCoordinatePoint,
  beforeSelected: CssCoordinatePoint,
  { dx, dy }: { dx: number; dy: number },
  canvas: HTMLElement,
): CssCoordinatePoint {
  const beforeSelectedCanvas = {
    x: isCssUnitValue(beforeSelected.x)
      ? cssUnitValueToCanvasPercent(beforeSelected.x, 'x', canvas)
      : 0,
    y: isCssUnitValue(beforeSelected.y)
      ? cssUnitValueToCanvasPercent(beforeSelected.y, 'y', canvas)
      : 0,
  };
  return {
    x:
      isCssUnitValue(point.x) && isCssUnitValue(beforeSelected.x)
        ? canvasPercentToCssUnitValue(beforeSelectedCanvas.x + dx, 'x', point.x.unit, canvas)
        : point.x,
    y:
      isCssUnitValue(point.y) && isCssUnitValue(beforeSelected.y)
        ? canvasPercentToCssUnitValue(beforeSelectedCanvas.y + dy, 'y', point.y.unit, canvas)
        : point.y,
  };
}

// Moves a raw circle's centre, or sets its radius to the pointer's distance from it.
function dragRawCircle(
  shape: RawClipPathShape,
  editable: RawEditable<'circle'>,
  target: DragTarget,
  { x, y }: Point,
  canvas: HTMLElement,
): ClipShape | undefined {
  if (target.kind === 'circle-center') {
    return withRawEditable(shape, {
      ...editable,
      cx: canvasPercentToCssUnitValue(x, 'x', editable.cx.unit, canvas),
      cy: canvasPercentToCssUnitValue(y, 'y', editable.cy.unit, canvas),
    });
  }
  if (target.kind !== 'circle-radius') {
    return undefined;
  }
  const center = {
    x: cssUnitValueToCanvasPercent(editable.cx, 'x', canvas),
    y: cssUnitValueToCanvasPercent(editable.cy, 'y', canvas),
  };
  const rect = canvas.getBoundingClientRect();
  const distancePx = Math.hypot(
    ((x - center.x) / 100) * rect.width,
    ((y - center.y) / 100) * rect.height,
  );
  const unitPx = cssUnitPx(editable.radius.unit, 'x', canvas);
  return withRawEditable(shape, {
    ...editable,
    radius: {
      value: unitPx > 0 ? distancePx / unitPx : editable.radius.value,
      unit: editable.radius.unit,
    },
  });
}

// Moves a raw ellipse's centre, or sets one radius (scaling the other with it when
// proportional).
function dragRawEllipse(
  shape: RawClipPathShape,
  editable: RawEditable<'ellipse'>,
  target: DragTarget,
  { x, y }: Point,
  options: ShapeDragOptions,
  canvas: HTMLElement,
): ClipShape | undefined {
  if (target.kind === 'ellipse-center') {
    return withRawEditable(shape, {
      ...editable,
      cx: canvasPercentToCssUnitValue(x, 'x', editable.cx.unit, canvas),
      cy: canvasPercentToCssUnitValue(y, 'y', editable.cy.unit, canvas),
    });
  }
  if (target.kind === 'ellipse-rx') {
    const centerX = cssUnitValueToCanvasPercent(editable.cx, 'x', canvas);
    const nextRxPercent = Math.abs(x - centerX);
    const nextEditable: RawEditableClipPath = {
      ...editable,
      rx: canvasPercentToCssUnitValue(nextRxPercent, 'x', editable.rx.unit, canvas),
    };
    if (options.ellipseScaleProportional) {
      const currentRxPercent = cssUnitValueToCanvasPercent(editable.rx, 'x', canvas);
      if (currentRxPercent > 0) {
        const scale = nextRxPercent / currentRxPercent;
        nextEditable.ry = { value: Math.max(0, editable.ry.value * scale), unit: editable.ry.unit };
      }
    }
    return withRawEditable(shape, nextEditable);
  }
  if (target.kind === 'ellipse-ry') {
    const centerY = cssUnitValueToCanvasPercent(editable.cy, 'y', canvas);
    const nextRyPercent = Math.abs(y - centerY);
    const nextEditable: RawEditableClipPath = {
      ...editable,
      ry: canvasPercentToCssUnitValue(nextRyPercent, 'y', editable.ry.unit, canvas),
    };
    if (options.ellipseScaleProportional) {
      const currentRyPercent = cssUnitValueToCanvasPercent(editable.ry, 'y', canvas);
      if (currentRyPercent > 0) {
        const scale = nextRyPercent / currentRyPercent;
        nextEditable.rx = { value: Math.max(0, editable.rx.value * scale), unit: editable.rx.unit };
      }
    }
    return withRawEditable(shape, nextEditable);
  }
  return undefined;
}

// Moves a raw inset edge — alone, with its opposite, or all four together.
function dragRawInsetSide(
  shape: RawClipPathShape,
  editable: RawEditable<'inset'>,
  side: InsetSide,
  { x, y }: Point,
  options: ShapeDragOptions,
  canvas: HTMLElement,
): ClipShape {
  const nextEditable: Extract<RawEditableClipPath, { kind: 'inset' }> = { ...editable };
  const setSide = (nextSide: InsetSide, value: CssUnitValue) => {
    nextEditable[nextSide] = value;
  };
  const sideValue =
    side === 'top'
      ? canvasPercentToCssUnitValue(y, 'y', editable.top.unit, canvas)
      : side === 'right'
        ? canvasPercentToCssUnitValue(100 - x, 'x', editable.right.unit, canvas)
        : side === 'bottom'
          ? canvasPercentToCssUnitValue(100 - y, 'y', editable.bottom.unit, canvas)
          : canvasPercentToCssUnitValue(x, 'x', editable.left.unit, canvas);
  const mode = options.insetSideMode || 'single';

  if (mode === 'all') {
    setSide('top', { ...sideValue, unit: editable.top.unit });
    setSide('right', { ...sideValue, unit: editable.right.unit });
    setSide('bottom', { ...sideValue, unit: editable.bottom.unit });
    setSide('left', { ...sideValue, unit: editable.left.unit });
  } else if (mode === 'opposite') {
    setSide(side, sideValue);
    const opposite = oppositeInsetSide(side);
    const oppositeUnit = editable[opposite].unit;
    setSide(opposite, { ...sideValue, unit: oppositeUnit });
  } else {
    setSide(side, sideValue);
  }
  return withRawEditable(shape, nextEditable);
}

// Sets a raw inset corner radius from the pointer — alone, with the opposite corner,
// or all four — round unless the radius is unlocked.
function dragRawInsetRadius(
  shape: RawClipPathShape,
  editable: RawEditable<'inset'>,
  corner: CornerName,
  { x, y }: Point,
  options: ShapeDragOptions,
  canvas: HTMLElement,
): ClipShape {
  const radii = editable.radii;
  if (!radii) {
    return shape;
  }
  const box = rawInsetBox(editable, canvas);
  const horizontal = expandCssUnitValues(radii.horizontal);
  const vertical = expandCssUnitValues(radii.vertical || radii.horizontal);
  const cornerIndex = CORNERS.indexOf(corner);
  const localXPercent =
    corner === 'topRight' || corner === 'bottomRight'
      ? Math.max(0, box.x1 - x)
      : Math.max(0, x - box.x0);
  const localYPercent =
    corner === 'bottomRight' || corner === 'bottomLeft'
      ? Math.max(0, box.y1 - y)
      : Math.max(0, y - box.y0);
  const currentHorizontal = horizontal[cornerIndex];
  const currentVertical = vertical[cornerIndex];
  if (!currentHorizontal || !currentVertical) {
    return shape;
  }
  const radiusX = canvasPercentToCssUnitValue(localXPercent, 'x', currentHorizontal.unit, canvas);
  const radiusY = canvasPercentToCssUnitValue(localYPercent, 'y', currentVertical.unit, canvas);
  const radius = options.insetRadiusUnlocked
    ? { x: radiusX, y: radiusY }
    : { x: radiusX, y: { value: radiusX.value, unit: currentVertical.unit } };
  const next = setRawInsetRadii(
    { horizontal, vertical },
    { corner, cornerIndex, radius, mode: options.insetRadiusMode || 'single' },
  );
  return withRawEditable(shape, { ...editable, radii: next });
}

// The radii with the dragged corner — and, by mode, its opposite or every corner —
// set to `radius`, each keeping its own unit.
function setRawInsetRadii(
  { horizontal, vertical }: { horizontal: CssUnitValue[]; vertical: CssUnitValue[] },
  {
    corner,
    cornerIndex,
    radius,
    mode,
  }: {
    corner: CornerName;
    cornerIndex: number;
    radius: { x: CssUnitValue; y: CssUnitValue };
    mode: InsetRadiusMode;
  },
): { horizontal: CssUnitValue[]; vertical: CssUnitValue[] } {
  const nextHorizontal = [...horizontal];
  const nextVertical = [...vertical];
  const setRadius = (target: CornerName) => {
    const index = CORNERS.indexOf(target);
    const horizontalValue = nextHorizontal[index];
    const verticalValue = nextVertical[index];
    if (!horizontalValue || !verticalValue) {
      return;
    }
    nextHorizontal[index] =
      index === cornerIndex ? radius.x : { value: radius.x.value, unit: horizontalValue.unit };
    nextVertical[index] =
      index === cornerIndex ? radius.y : { value: radius.y.value, unit: verticalValue.unit };
  };
  if (mode === 'all') {
    CORNERS.forEach(setRadius);
  } else if (mode === 'opposite') {
    setRadius(corner);
    setRadius(oppositeCorner(corner));
  } else {
    setRadius(corner);
  }
  return { horizontal: nextHorizontal, vertical: nextVertical };
}

// Moves the dragged polygon point; with several selected, all of them move by the
// same offset from where the drag began.
function dragPolygonPoint(
  shape: PolygonShape,
  target: DragTarget & { kind: 'polygon-point' },
  x: number,
  y: number,
): ClipShape {
  if (target.before.kind === 'polygon' && target.polygonPointIndexes?.length) {
    const beforePoint = target.before.points[target.index];
    if (!beforePoint) {
      return shape;
    }

    const selectedIndexes = new Set(target.polygonPointIndexes);
    const dx = x - beforePoint.x;
    const dy = y - beforePoint.y;

    return {
      kind: 'polygon',
      points: shape.points.map((point, index) => {
        const beforeSelectedPoint =
          target.before.kind === 'polygon' ? target.before.points[index] : undefined;
        return selectedIndexes.has(index) && beforeSelectedPoint
          ? { x: beforeSelectedPoint.x + dx, y: beforeSelectedPoint.y + dy }
          : point;
      }),
    };
  }

  return {
    kind: 'polygon',
    points: shape.points.map((point, index) => (index === target.index ? { x, y } : point)),
  };
}

// Moves a circle or ellipse's centre, or sets a radius from the pointer (an ellipse
// scaling its other radius with it when proportional).
function dragRoundShape(
  shape: CircleShape | EllipseShape,
  target: DragTarget,
  x: number,
  y: number,
  options: ShapeDragOptions,
): ClipShape {
  if (shape.kind === 'circle') {
    if (target.kind === 'circle-center') {
      return { ...shape, cx: x, cy: y };
    }
    if (target.kind === 'circle-radius') {
      const radius = Math.sqrt((x - shape.cx) ** 2 + (y - shape.cy) ** 2);
      return { ...shape, radius: Math.max(0, radius) };
    }
    return shape;
  }
  if (target.kind === 'ellipse-center') {
    return { ...shape, cx: x, cy: y };
  }
  if (target.kind === 'ellipse-rx') {
    const nextRx = Math.max(0, Math.abs(x - shape.cx));
    if (options.ellipseScaleProportional && shape.rx > 0) {
      const scale = nextRx / shape.rx;
      return { ...shape, rx: nextRx, ry: Math.max(0, shape.ry * scale) };
    }
    return { ...shape, rx: nextRx };
  }
  if (target.kind === 'ellipse-ry') {
    const nextRy = Math.max(0, Math.abs(y - shape.cy));
    if (options.ellipseScaleProportional && shape.ry > 0) {
      const scale = nextRy / shape.ry;
      return { ...shape, ry: nextRy, rx: Math.max(0, shape.rx * scale) };
    }
    return { ...shape, ry: nextRy };
  }
  return shape;
}

// Moves an inset edge, or sets a corner radius from the pointer.
function dragInset(
  shape: InsetShape,
  target: DragTarget,
  x: number,
  y: number,
  options: ShapeDragOptions,
): ClipShape {
  const insetSideByTarget: Partial<Record<DragTarget['kind'], InsetSide>> = {
    'inset-top': 'top',
    'inset-right': 'right',
    'inset-bottom': 'bottom',
    'inset-left': 'left',
  };
  const side = insetSideByTarget[target.kind];

  if (side) {
    const value = side === 'top' ? y : side === 'right' ? 100 - x : side === 'bottom' ? 100 - y : x;
    const oppositeSide = oppositeInsetSide(side);
    const mode = options.insetSideMode || 'single';
    const next: InsetShape = { ...shape };

    if (mode === 'all') {
      next.top = value;
      next.right = value;
      next.bottom = value;
      next.left = value;
    } else if (mode === 'opposite') {
      next[side] = value;
      next[oppositeSide] = value;
    } else {
      next[side] = value;
    }

    return next;
  }
  if (target.kind === 'inset-radius') {
    return dragInsetRadius(shape, target.corner, x, y, options);
  }
  return shape;
}

// Sets an inset corner radius from the pointer — alone, with the opposite corner,
// or all four — round unless the radius is unlocked.
function dragInsetRadius(
  shape: InsetShape,
  corner: CornerName,
  x: number,
  y: number,
  options: ShapeDragOptions,
): ClipShape {
  const { width, height, x1: rightEdge, y1: bottomEdge } = insetBox(shape);
  const localX =
    corner === 'topRight' || corner === 'bottomRight'
      ? Math.max(0, rightEdge - x)
      : Math.max(0, x - shape.left);
  const localY =
    corner === 'bottomRight' || corner === 'bottomLeft'
      ? Math.max(0, bottomEdge - y)
      : Math.max(0, y - shape.top);
  const radiusX = width > 0 ? (localX / width) * 100 : 0;
  const radiusY = height > 0 ? (localY / height) * 100 : 0;
  const radiusValue = Math.max(0, (radiusX + radiusY) / 2);
  const radius = options.insetRadiusUnlocked
    ? { x: radiusX, y: radiusY }
    : { x: radiusValue, y: radiusValue };
  const nextRadii = { ...shape.radii };
  const setRadius = (target: CornerName) => {
    nextRadii[target] = { ...radius };
  };

  const insetRadiusMode = options.insetRadiusMode || 'single';

  if (insetRadiusMode === 'all') {
    CORNERS.forEach(setRadius);
  } else if (insetRadiusMode === 'opposite') {
    setRadius(corner);
    setRadius(oppositeCorner(corner));
  } else {
    setRadius(corner);
  }

  return {
    ...shape,
    radii: nextRadii,
  };
}

function isSpaceKey(key: string, code?: string) {
  return key === ' ' || key === 'Spacebar' || code === 'Space';
}

function isRadiusUnlockKey(key: string, code?: string) {
  return key.toLowerCase() === 'u' || code === 'KeyU';
}

function stopKeyboardEvent(event: React.KeyboardEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation?.();
}

function isArrowKey(key: string): key is ArrowKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}

function arrowDelta(key: string, step = KEYBOARD_STEP) {
  if (key === 'ArrowLeft') {
    return { x: -step, y: 0 };
  }
  if (key === 'ArrowRight') {
    return { x: step, y: 0 };
  }
  if (key === 'ArrowUp') {
    return { x: 0, y: -step };
  }
  if (key === 'ArrowDown') {
    return { x: 0, y: step };
  }
  return undefined;
}

function ellipseRadiusValueDelta(
  handle: Extract<HandleTarget, { kind: 'ellipse-rx' | 'ellipse-ry' }>,
  key: string,
  step = KEYBOARD_STEP,
) {
  if (handle.kind === 'ellipse-rx') {
    if (key === 'ArrowRight' || key === 'ArrowUp') {
      return step;
    }
    if (key === 'ArrowLeft' || key === 'ArrowDown') {
      return -step;
    }
  }

  if (key === 'ArrowDown' || key === 'ArrowRight') {
    return step;
  }
  if (key === 'ArrowUp' || key === 'ArrowLeft') {
    return -step;
  }
  return 0;
}

function insetValueDelta(side: InsetSide, key: string, step = KEYBOARD_STEP) {
  if (side === 'top') {
    if (key === 'ArrowDown' || key === 'ArrowRight') {
      return step;
    }
    if (key === 'ArrowUp' || key === 'ArrowLeft') {
      return -step;
    }
  } else if (side === 'right') {
    if (key === 'ArrowLeft' || key === 'ArrowUp') {
      return step;
    }
    if (key === 'ArrowRight' || key === 'ArrowDown') {
      return -step;
    }
  } else if (side === 'bottom') {
    if (key === 'ArrowUp' || key === 'ArrowRight') {
      return step;
    }
    if (key === 'ArrowDown' || key === 'ArrowLeft') {
      return -step;
    }
  } else if (side === 'left') {
    if (key === 'ArrowRight' || key === 'ArrowUp') {
      return step;
    }
    if (key === 'ArrowLeft' || key === 'ArrowDown') {
      return -step;
    }
  }
  return 0;
}

function cornerRadiusDelta(corner: CornerName, key: string, step = KEYBOARD_STEP) {
  const delta = { x: 0, y: 0 };
  const horizontalSign = corner === 'topRight' || corner === 'bottomRight' ? -1 : 1;
  const verticalSign = corner === 'bottomRight' || corner === 'bottomLeft' ? -1 : 1;

  if (key === 'ArrowRight') {
    delta.x = step * horizontalSign;
  }
  if (key === 'ArrowLeft') {
    delta.x = -step * horizontalSign;
  }
  if (key === 'ArrowDown') {
    delta.y = step * verticalSign;
  }
  if (key === 'ArrowUp') {
    delta.y = -step * verticalSign;
  }

  return delta;
}

function lockedRadiusValue(radius: CornerRadius) {
  return Math.max(0, (radius.x + radius.y) / 2);
}

// How an arrow key bends a shape: the drag options, plus the circle's radius angle,
// the selected polygon points, and the step.
type ShapeKeyboardOptions = {
  canvas?: HTMLElement | undefined;
  insetSideMode?: InsetSideMode;
  insetRadiusMode?: InsetRadiusMode;
  insetRadiusUnlocked?: boolean;
  ellipseScaleProportional?: boolean;
  circleRadiusAngle?: number;
  polygonPointIndexes?: number[];
  step?: number;
};
// The shape after a key, and the circle radius handle's new angle when it moved.
type ShapeKeyboardResult = { shape: ClipShape; circleRadiusAngle?: number };

function updateShapeForKeyboard(
  shape: ClipShape,
  handle: HandleTarget,
  key: string,
  options: ShapeKeyboardOptions = {},
): ShapeKeyboardResult {
  const step = options.step || KEYBOARD_STEP;
  const delta = arrowDelta(key, step);
  if (!delta || shape.kind === 'none') {
    return { shape };
  }
  if (shape.kind === 'raw' && shape.editable && options.canvas) {
    return keyRawShape(shape, shape.editable, handle, delta, options, options.canvas);
  }
  if (handle.kind === 'polygon-point' && shape.kind === 'polygon') {
    return keyPolygonPoints(shape, handle.index, delta, options);
  }
  if (shape.kind === 'circle') {
    return keyCircle(shape, handle, delta, options);
  }
  if (shape.kind === 'ellipse') {
    return keyEllipse(shape, handle, { key, step, delta }, options);
  }
  if (shape.kind === 'inset') {
    return keyInset(shape, handle, { key, step }, options);
  }
  return { shape };
}

// A key on a shape written in raw CSS units: the drag the key amounts to, from the
// handle's current place.
function keyRawShape(
  shape: RawClipPathShape,
  editable: RawEditableClipPath,
  handle: HandleTarget,
  delta: Point,
  options: ShapeKeyboardOptions,
  canvas: HTMLElement,
): ShapeKeyboardResult {
  const currentPoint = rawEditableHandlePoint(editable, handle, canvas);
  if (!currentPoint) {
    return { shape };
  }
  const target: DragTarget = {
    ...handle,
    before: shape,
    ...(isPolygonPointHandle(handle) && options.polygonPointIndexes
      ? { polygonPointIndexes: options.polygonPointIndexes }
      : {}),
  };
  const dragOptions = {
    canvas,
    ...(options.insetRadiusMode ? { insetRadiusMode: options.insetRadiusMode } : {}),
    ...(options.insetRadiusUnlocked !== undefined
      ? { insetRadiusUnlocked: options.insetRadiusUnlocked }
      : {}),
    ...(options.insetSideMode ? { insetSideMode: options.insetSideMode } : {}),
    ...(options.ellipseScaleProportional !== undefined
      ? { ellipseScaleProportional: options.ellipseScaleProportional }
      : {}),
  };
  return {
    shape: updateShapeForDrag(
      shape,
      target,
      currentPoint.x + delta.x,
      currentPoint.y + delta.y,
      dragOptions,
    ),
  };
}

// Moves the selected polygon points (or the one with the key) by the key's step.
function keyPolygonPoints(
  shape: PolygonShape,
  index: number,
  delta: Point,
  options: ShapeKeyboardOptions,
): ShapeKeyboardResult {
  const point = shape.points[index];
  if (!point) {
    return { shape };
  }
  const selectedIndexes = new Set(
    options.polygonPointIndexes?.length ? options.polygonPointIndexes : [index],
  );
  return {
    shape: {
      kind: 'polygon' as const,
      points: shape.points.map((item, itemIndex) =>
        selectedIndexes.has(itemIndex) ? { x: item.x + delta.x, y: item.y + delta.y } : item,
      ),
    },
  };
}

// Moves a circle's centre, or its radius handle around and away from the centre.
function keyCircle(
  shape: CircleShape,
  handle: HandleTarget,
  delta: Point,
  options: ShapeKeyboardOptions,
): ShapeKeyboardResult {
  if (handle.kind === 'circle-center') {
    return { shape: { ...shape, cx: shape.cx + delta.x, cy: shape.cy + delta.y } };
  }
  if (handle.kind !== 'circle-radius') {
    return { shape };
  }
  const angle = options.circleRadiusAngle ?? 0;
  const x = shape.cx + Math.cos(angle) * shape.radius + delta.x;
  const y = shape.cy + Math.sin(angle) * shape.radius + delta.y;
  const radius = Math.max(0, Math.sqrt((x - shape.cx) ** 2 + (y - shape.cy) ** 2));
  return {
    shape: { ...shape, radius },
    circleRadiusAngle: radius > 0 ? Math.atan2(y - shape.cy, x - shape.cx) : angle,
  };
}

// Moves an ellipse's centre, or grows a radius (scaling the other with it when
// proportional).
function keyEllipse(
  shape: EllipseShape,
  handle: HandleTarget,
  { key, step, delta }: { key: string; step: number; delta: Point },
  options: ShapeKeyboardOptions,
): ShapeKeyboardResult {
  if (handle.kind === 'ellipse-center') {
    return { shape: { ...shape, cx: shape.cx + delta.x, cy: shape.cy + delta.y } };
  }
  if (handle.kind === 'ellipse-rx') {
    const radiusDelta = ellipseRadiusValueDelta(handle, key, step);
    if (!radiusDelta) {
      return { shape };
    }
    const nextRx = Math.max(0, shape.rx + radiusDelta);
    if (options.ellipseScaleProportional && shape.rx > 0) {
      const scale = nextRx / shape.rx;
      return { shape: { ...shape, rx: nextRx, ry: Math.max(0, shape.ry * scale) } };
    }
    return { shape: { ...shape, rx: nextRx } };
  }
  if (handle.kind === 'ellipse-ry') {
    const radiusDelta = ellipseRadiusValueDelta(handle, key, step);
    if (!radiusDelta) {
      return { shape };
    }
    const nextRy = Math.max(0, shape.ry + radiusDelta);
    if (options.ellipseScaleProportional && shape.ry > 0) {
      const scale = nextRy / shape.ry;
      return { shape: { ...shape, ry: nextRy, rx: Math.max(0, shape.rx * scale) } };
    }
    return { shape: { ...shape, ry: nextRy } };
  }
  return { shape };
}

// Moves an inset edge (alone, with its opposite, or all four), or grows a corner
// radius.
function keyInset(
  shape: InsetShape,
  handle: HandleTarget,
  { key, step }: { key: string; step: number },
  options: ShapeKeyboardOptions,
): ShapeKeyboardResult {
  const side = insetSideForHandle(handle);
  if (side) {
    const mode = options.insetSideMode || 'single';
    const next: InsetShape = { ...shape };
    const valueDelta = insetValueDelta(side, key, step);
    if (!valueDelta) {
      return { shape };
    }
    if (mode === 'all') {
      const value = next[side] + valueDelta;
      next.top = value;
      next.right = value;
      next.bottom = value;
      next.left = value;
      return { shape: next };
    }
    if (mode === 'opposite') {
      const oppositeSide = oppositeInsetSide(side);
      next[side] += valueDelta;
      next[oppositeSide] += valueDelta;
      return { shape: next };
    }
    next[side] += valueDelta;
    return { shape: next };
  }
  if (handle.kind === 'inset-radius') {
    return keyInsetRadius(shape, handle.corner, { key, step }, options);
  }
  return { shape };
}

// Grows an inset corner radius — alone, with the opposite corner, or all four —
// round unless the radius is unlocked.
function keyInsetRadius(
  shape: InsetShape,
  corner: CornerName,
  { key, step }: { key: string; step: number },
  options: ShapeKeyboardOptions,
): ShapeKeyboardResult {
  const mode = options.insetRadiusMode || 'single';
  const radiusDelta = cornerRadiusDelta(corner, key, step);
  if (!radiusDelta.x && !radiusDelta.y) {
    return { shape };
  }
  const nextRadii = { ...shape.radii };
  const activeRadius = shape.radii[corner];
  const radiusDeltaValue = radiusDelta.x || radiusDelta.y;
  const lockedValue = Math.max(0, lockedRadiusValue(activeRadius) + radiusDeltaValue);
  const nextRadius = options.insetRadiusUnlocked
    ? {
        x: Math.max(0, activeRadius.x + radiusDelta.x),
        y: Math.max(0, activeRadius.y + radiusDelta.y),
      }
    : { x: lockedValue, y: lockedValue };
  const setRadius = (target: CornerName) => {
    nextRadii[target] = { ...nextRadius };
  };

  if (mode === 'all') {
    CORNERS.forEach(setRadius);
  } else if (mode === 'opposite') {
    setRadius(corner);
    setRadius(oppositeCorner(corner));
  } else {
    setRadius(corner);
  }

  return { shape: { ...shape, radii: nextRadii } };
}

async function writePastedShapeMetadata(
  style: StyleHandle,
  cache: PastedShapeSvgCache | undefined,
  options?: StyleTargetOptions,
) {
  const writeProperty = async (property: string, nextValue: string) => {
    try {
      await style.setProperty?.(property, nextValue, options);
    } catch {
      // Some Webflow style handles may reject custom properties.
    }
  };

  const removeProperty = async (property: string) => {
    try {
      await style.removeProperty?.(property, options);
    } catch {
      // Metadata is only an enhancement for restoring the fit toggle.
    }
  };

  if (!cache) {
    await Promise.all([
      removeProperty(SHAPE_STRETCH_PROPERTY),
      removeProperty(SHAPE_CONTAIN_PROPERTY),
    ]);
    return;
  }

  await Promise.all([
    writeProperty(SHAPE_STRETCH_PROPERTY, formatClipPath(cache.stretch)),
    writeProperty(SHAPE_CONTAIN_PROPERTY, formatClipPath(cache.contain)),
  ]);
}

async function writeClipPathToStyle(
  style: StyleHandle,
  value: string,
  options: {
    shapeSvgCache?: PastedShapeSvgCache | undefined;
    styleOptions?: StyleTargetOptions;
  } = {},
) {
  const styleOptions = options.styleOptions;
  if (isNoneClipPathValue(value)) {
    if (styleOptions) {
      await style.setProperty?.('clip-path', 'none', styleOptions);
    } else if (style.removeProperty) {
      await style.removeProperty('clip-path', styleOptions);
    } else {
      await style.setProperty?.('clip-path', 'none', styleOptions);
    }

    await writePastedShapeMetadata(style, undefined, styleOptions);
    return;
  }

  await style.setProperty?.('clip-path', value, styleOptions);
  await writePastedShapeMetadata(style, options.shapeSvgCache || undefined, styleOptions);
}

// The styles an element reports, as the Designer API delivers them: the list, or
// null, holding handles or nulls.
type StyleHandleList = ApiNullable<Array<ApiNullable<StyleHandle>>>;

function isStyleHandle(style: ApiNullable<StyleHandle> | undefined): style is StyleHandle {
  return Boolean(
    style?.getProperty || style?.getProperties || style?.setProperty || style?.removeProperty,
  );
}

function debugClipPath(label: string, details?: unknown) {
  if (!CLIP_PATH_DEBUG) {
    return;
  }
  try {
    console.log(`[Moden ClipPath debug] ${label}\n${JSON.stringify(details, null, 2)}`);
  } catch {
    console.log(`[Moden ClipPath debug] ${label}`, details);
  }
}

function canWriteClipPathValue(style: ApiNullable<StyleHandle> | undefined, value: string) {
  if (!style) {
    return false;
  }
  return isNoneClipPathValue(value)
    ? Boolean(style.setProperty || style.removeProperty)
    : Boolean(style.setProperty);
}

function getStyleHandles(styles: StyleHandleList | undefined) {
  return Array.isArray(styles) ? styles.filter(isStyleHandle) : [];
}

function addUniqueStyleHandle(
  styles: StyleHandle[],
  style: StyleHandle,
  seenRefs: Set<StyleHandle>,
  seenIds: Set<string>,
) {
  if (style.id) {
    if (seenIds.has(style.id)) {
      return;
    }
    seenIds.add(style.id);
  } else if (seenRefs.has(style)) {
    return;
  }

  seenRefs.add(style);
  styles.push(style);
}

async function readOptional<T>(reader: (() => Promise<T> | undefined) | undefined) {
  if (!reader) {
    return undefined;
  }

  try {
    return await reader();
  } catch {
    return undefined;
  }
}

async function readOptionalWithTimeout<T>(
  reader: (() => Promise<T> | undefined) | undefined,
  timeoutMs: number,
) {
  if (!reader) {
    return undefined;
  }

  let timeoutId: number | undefined = undefined;
  try {
    return await Promise.race([
      reader(),
      new Promise<undefined>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function selectedElementKey(element: unknown) {
  if (!isElementStyleSource(element)) {
    return undefined;
  }
  const id = element.id;
  if (!id) {
    return undefined;
  }
  if (typeof id === 'string') {
    return id;
  }

  try {
    return JSON.stringify(id);
  } catch {
    return String(id);
  }
}

function addStyleHandles(
  styles: StyleHandle[],
  nextStyles: StyleHandleList | undefined,
  seenRefs: Set<StyleHandle>,
  seenIds: Set<string>,
) {
  getStyleHandles(nextStyles).forEach((style) => {
    addUniqueStyleHandle(styles, style, seenRefs, seenIds);
  });
}

async function getElementPrimaryStyleHandles(element: unknown) {
  if (!isElementStyleSource(element)) {
    return [];
  }
  const source = element;
  const styles: StyleHandle[] = [];
  const seenRefs = new Set<StyleHandle>();
  const seenIds = new Set<string>();

  addStyleHandles(styles, await readOptional(() => source.getStyles?.()), seenRefs, seenIds);

  const selectedStyle = await readOptional(() => source.getStyle?.());
  if (isStyleHandle(selectedStyle)) {
    addUniqueStyleHandle(styles, selectedStyle, seenRefs, seenIds);
  }

  return styles;
}

function addClassNamesFromValue(classNames: Set<string>, value: unknown) {
  if (typeof value !== 'string') {
    return;
  }

  value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .forEach((className) => classNames.add(className));
}

function addClassNamesFromAttributes(
  classNames: Set<string>,
  attributes: ApiNullable<Array<ElementAttributeHandle>> | undefined,
) {
  if (!Array.isArray(attributes)) {
    return;
  }

  attributes.forEach((attribute) => {
    if (typeof attribute?.name === 'string' && attribute.name.toLowerCase() === 'class') {
      addClassNamesFromValue(classNames, attribute.value);
    }
  });
}

async function addClassNamesFromStyleHandles(
  classNames: Set<string>,
  styles: StyleHandleList | undefined,
) {
  const styleNames = await Promise.all(
    getStyleHandles(styles).map((style) =>
      readOptionalWithTimeout(() => style.getName?.(), STYLE_LOOKUP_TIMEOUT_MS),
    ),
  );

  styleNames
    .filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
    .forEach((name) => classNames.add(name.trim()));
}

async function getElementClassNames(element: unknown, styles?: StyleHandleList | undefined) {
  if (!isElementStyleSource(element)) {
    return [];
  }
  const source = element;
  const classNames = new Set<string>();
  await addClassNamesFromStyleHandles(classNames, styles);
  if (classNames.size) {
    return [...classNames];
  }

  const [
    attributeClass,
    resolvedAttributeClass,
    customAttributeClass,
    attributes,
    resolvedAttributes,
    customAttributes,
  ] = await Promise.all([
    readOptionalWithTimeout(() => source.getAttributeValue?.('class'), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(
      () => source.getResolvedAttributeValue?.('class'),
      STYLE_LOOKUP_TIMEOUT_MS,
    ),
    readOptionalWithTimeout(() => source.getCustomAttribute?.('class'), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => source.getAttributes?.(), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => source.getResolvedAttributes?.(), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => source.getAllCustomAttributes?.(), STYLE_LOOKUP_TIMEOUT_MS),
  ]);

  addClassNamesFromValue(classNames, attributeClass);
  addClassNamesFromValue(classNames, resolvedAttributeClass);
  addClassNamesFromValue(classNames, customAttributeClass);
  addClassNamesFromAttributes(classNames, attributes);
  addClassNamesFromAttributes(classNames, resolvedAttributes);
  addClassNamesFromAttributes(classNames, customAttributes);

  return [...classNames];
}

function getStyleLookupCandidates(classNames: string[]) {
  const candidates: Array<string | string[]> = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: string | string[]) => {
    const key = Array.isArray(candidate) ? candidate.join('\u0000') : candidate;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push(candidate);
  };

  classNames.forEach((className) => {
    addCandidate(className);
  });
  for (let endIndex = 1; endIndex < classNames.length; endIndex += 1) {
    addCandidate(classNames.slice(0, endIndex + 1));
  }

  return candidates;
}

function getStandaloneStyleLookupCandidates(classNames: string[]) {
  return [...new Set(classNames)];
}

// How far up a style's parent chain the editor reads. A Webflow combo class nests
// one level per class in the combo, so 20 is far past any real selector; a chain
// longer than that is treated as unreadable rather than followed.
const CLIP_PATH_LIMITS = { styleDepthMax: 20 } as const;

async function getStyleNamePath(style: StyleHandle, depth = 0): Promise<string[]> {
  if (depth > CLIP_PATH_LIMITS.styleDepthMax) {
    return [];
  }

  const parent = await readOptionalWithTimeout(
    () => style.getParent?.(),
    STYLE_PATH_LOOKUP_TIMEOUT_MS,
  );
  const parentPath = isStyleHandle(parent) ? await getStyleNamePath(parent, depth + 1) : [];
  const name = await readOptionalWithTimeout(() => style.getName?.(), STYLE_PATH_LOOKUP_TIMEOUT_MS);

  return typeof name === 'string' && name.trim() ? [...parentPath, name] : parentPath;
}

async function lookupStyleByNameCandidate(
  webflowApi: WebflowStyleLookup,
  candidate: string | string[],
) {
  const timeout = Symbol('timeout');
  let timeoutId: number | undefined = undefined;

  try {
    const result = await Promise.race([
      webflowApi.getStyleByName?.(candidate),
      new Promise<typeof timeout>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(timeout), STYLE_LOOKUP_TIMEOUT_MS);
      }),
    ]);

    if (result === timeout) {
      return { candidate, source: 'getStyleByName' as const, timedOut: true, found: false };
    }

    if (!isStyleHandle(result)) {
      return { candidate, source: 'getStyleByName' as const, found: false };
    }

    return {
      candidate,
      source: 'getStyleByName' as const,
      found: true,
      style: result,
      id: result.id || undefined,
    };
  } catch {
    return { candidate, source: 'getStyleByName' as const, found: false };
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

async function getClassStyleHandlesWithDiagnostics(
  classNames: string[],
  webflowApi: WebflowStyleLookup,
) {
  if (!classNames.length) {
    const diagnostics: StyleLookupDiagnostic[] = [];
    return { styles: [], diagnostics };
  }

  const styles: StyleHandle[] = [];
  const seenRefs = new Set<StyleHandle>();
  const seenIds = new Set<string>();
  const candidates = getStandaloneStyleLookupCandidates(classNames);
  const diagnostics: StyleLookupDiagnostic[] = [];

  if (webflowApi.getStyleByName) {
    const lookupResults = await Promise.all(
      candidates.map((candidate) => lookupStyleByNameCandidate(webflowApi, candidate)),
    );
    lookupResults.forEach((result) => {
      diagnostics.push({
        candidate: result.candidate,
        source: result.source,
        found: result.found,
        ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
        ...(result.id !== undefined ? { id: result.id } : {}),
      });
      if ('style' in result && isStyleHandle(result.style)) {
        addUniqueStyleHandle(styles, result.style, seenRefs, seenIds);
      }
    });
  }

  return { styles, diagnostics };
}

async function getElementClassStyleHandles(
  element: unknown,
  webflowApi: WebflowStyleLookup,
  elementStyles?: StyleHandleList | undefined,
) {
  const { styles } = await getClassStyleHandlesWithDiagnostics(
    await getElementClassNames(element, elementStyles),
    webflowApi,
  );
  return styles;
}

function normalizeStylePropertyValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function hasClipPathDeclaration(value: string | undefined) {
  return Boolean(value && value.trim());
}

function styleOptionsForBreakpoint(
  breakpoint: BreakpointId | undefined,
): StyleTargetOptions | undefined {
  return breakpoint && breakpoint !== 'main' ? { breakpoint } : undefined;
}

function inheritedBreakpointChain(breakpoint: BreakpointId | undefined) {
  if (breakpoint === 'xxl') {
    return ['xxl', 'xl', 'large', 'main'] as const;
  }
  if (breakpoint === 'xl') {
    return ['xl', 'large', 'main'] as const;
  }
  if (breakpoint === 'large') {
    return ['large', 'main'] as const;
  }
  if (breakpoint === 'medium') {
    return ['medium', 'main'] as const;
  }
  if (breakpoint === 'small') {
    return ['small', 'medium', 'main'] as const;
  }
  if (breakpoint === 'tiny') {
    return ['tiny', 'small', 'medium', 'main'] as const;
  }
  return ['main'] as const;
}

function clipPathStyleOriginFromSource(
  sourceBreakpoint: BreakpointId | undefined,
  activeBreakpoint: BreakpointId,
): ClipPathStyleOrigin {
  if (!sourceBreakpoint) {
    return 'none';
  }
  return sourceBreakpoint === activeBreakpoint ? 'current' : 'inherited';
}

async function readStylePropertyDeclarationAt(
  style: StyleHandle,
  property: string,
  options?: StyleTargetOptions,
) {
  let propertiesWereRead = false;

  try {
    const properties = await readOptionalWithTimeout(
      () => style.getProperties?.(options),
      STYLE_PROPERTY_LOOKUP_TIMEOUT_MS,
    );
    propertiesWereRead = true;
    const raw = normalizeStylePropertyValue(properties?.[property]);
    if (hasClipPathDeclaration(raw)) {
      return raw;
    }
  } catch {
    // Fall back to direct property lookup when the property map is unavailable.
  }

  try {
    const raw = normalizeStylePropertyValue(
      await readOptionalWithTimeout(
        () => style.getProperty?.(property, options),
        STYLE_PROPERTY_LOOKUP_TIMEOUT_MS,
      ),
    );
    if (!hasClipPathDeclaration(raw)) {
      return undefined;
    }
    if (property === 'clip-path' && propertiesWereRead && isNoneClipPathValue(raw)) {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

async function readStylePropertyDeclarationWithSource(
  style: StyleHandle,
  property: string,
  options?: StyleTargetOptions,
): Promise<StylePropertyRead | undefined> {
  for (const breakpoint of inheritedBreakpointChain(options?.breakpoint || 'main')) {
    const value = await readStylePropertyDeclarationAt(
      style,
      property,
      styleOptionsForBreakpoint(breakpoint),
    );
    if (value && hasClipPathDeclaration(value)) {
      return { value, breakpoint };
    }
  }
  return undefined;
}

async function readStylePropertyDeclaration(
  style: StyleHandle,
  property: string,
  options?: StyleTargetOptions,
) {
  return (
    (await readStylePropertyDeclarationWithSource(style, property, options))?.value || undefined
  );
}

async function readClipPathDeclarationWithSource(style: StyleHandle, options?: StyleTargetOptions) {
  return readStylePropertyDeclarationWithSource(style, 'clip-path', options);
}

function parseStoredShapeVariant(value: string | undefined) {
  const parsed = parseClipPathInput(value || '');
  return parsed?.kind === 'shape' ? parsed : undefined;
}

async function readPastedShapeMetadata(style: StyleHandle, options?: StyleTargetOptions) {
  const [stretchValue, containValue] = await Promise.all([
    readStylePropertyDeclaration(style, SHAPE_STRETCH_PROPERTY, options),
    readStylePropertyDeclaration(style, SHAPE_CONTAIN_PROPERTY, options),
  ]);
  const stretch = parseStoredShapeVariant(stretchValue);
  const contain = parseStoredShapeVariant(containValue);

  return stretch && contain ? { source: 'style', stretch, contain } : undefined;
}

async function findClipPathStyle(
  styles: StyleHandleList | undefined,
  options?: StyleTargetOptions,
) {
  const styleHandles = getStyleHandles(styles);
  if (!styleHandles.length) {
    return undefined;
  }

  const reads = await Promise.all(
    styleHandles.map(async (style) => {
      try {
        const declaration = await readClipPathDeclarationWithSource(style, options);
        return {
          style,
          raw: declaration?.value || undefined,
          breakpoint: declaration?.breakpoint || undefined,
        };
      } catch {
        return { style, raw: undefined, breakpoint: undefined };
      }
    }),
  );

  const declaredClipPath = [...reads].reverse().find(({ raw }) => hasClipPathDeclaration(raw));
  return declaredClipPath || reads[0];
}

async function debugStyleSummary(style: StyleHandle, options?: StyleTargetOptions) {
  const [path, properties, directClipPath, inheritedClipPath] = await Promise.all([
    getStyleNamePath(style),
    readOptionalWithTimeout(() => style.getProperties?.(options), STYLE_PROPERTY_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(
      () => style.getProperty?.('clip-path', options),
      STYLE_PROPERTY_LOOKUP_TIMEOUT_MS,
    ),
    readClipPathDeclarationWithSource(style, options),
  ]);
  return {
    id: style.id || undefined,
    path,
    name: path[path.length - 1] || undefined,
    canSet: Boolean(style.setProperty),
    canRemove: Boolean(style.removeProperty),
    propertiesClipPath: normalizeStylePropertyValue(properties?.['clip-path']),
    directClipPath: normalizeStylePropertyValue(directClipPath),
    inheritedClipPath,
  };
}

async function debugStyleSummaries(
  styles: StyleHandleList | undefined,
  options?: StyleTargetOptions,
) {
  return Promise.all(getStyleHandles(styles).map((style) => debugStyleSummary(style, options)));
}

async function resolveWritableClipPathStyleForElement(
  element: unknown | undefined,
  webflowApi: WebflowStyleLookup,
  value: string,
  options?: StyleTargetOptions,
) {
  if (!element) {
    return undefined;
  }

  const primaryStyles = await getElementPrimaryStyleHandles(element);
  const primaryMatch = await findClipPathStyle(primaryStyles, options);
  const classStyles = await getElementClassStyleHandles(element, webflowApi, primaryStyles);
  const classMatch = classStyles.length
    ? await findClipPathStyle([...classStyles, ...primaryStyles], options)
    : undefined;
  const candidates: StyleHandle[] = [];
  const seenRefs = new Set<StyleHandle>();
  const seenIds = new Set<string>();

  const addCandidate = (style: ApiNullable<StyleHandle> | undefined) => {
    if (isStyleHandle(style)) {
      addUniqueStyleHandle(candidates, style, seenRefs, seenIds);
    }
  };

  if (classMatch && (hasClipPathDeclaration(classMatch.raw) || !primaryMatch)) {
    addCandidate(classMatch.style);
  }
  addCandidate(primaryMatch?.style);
  addCandidate(classMatch?.style);
  addStyleHandles(candidates, primaryStyles, seenRefs, seenIds);
  addStyleHandles(candidates, classStyles, seenRefs, seenIds);

  return candidates.find((style) => canWriteClipPathValue(style, value)) || undefined;
}

// Resolve the style for an exact class path — `['clip-path']` → standalone
// `.clip-path`, `['hero','clip-path']` → combo `.hero.clip-path` — creating it
// (and any missing parent in the combo chain) when it doesn't exist yet. Used
// when the user has picked specific class tags, so edits land on those exact
// selectors rather than the element's most-specific combo.
// Find the style whose full name-path is EXACTLY `names` (e.g. `['clip-path']`
// → standalone `.clip-path`, not the combo `.hero.clip-path` that also ends in
// `clip-path`). getStyleByName can hand back a combo whose leaf matches, so we
// verify the resolved path before trusting it. Read-only (never creates).
async function findStyleForClassPath(
  names: string[],
  api: WebflowStyleLookup,
): Promise<StyleHandle | undefined> {
  if (!names.length) {
    return undefined;
  }
  const candidate = names.length === 1 ? names[0] : names;
  if (!candidate) {
    return undefined;
  }
  const existing = await readOptionalWithTimeout(
    () => api.getStyleByName?.(candidate),
    STYLE_LOOKUP_TIMEOUT_MS,
  );
  if (!isStyleHandle(existing)) {
    return undefined;
  }
  const path = await getStyleNamePath(existing);
  return path.length === names.length && path.every((name, index) => name === names[index])
    ? existing
    : undefined;
}

// Like findStyleForClassPath, but creates the exact standalone/combo (and any
// missing parent in the chain) when it doesn't exist yet.
async function resolveOrCreateStyleForClassPath(
  names: string[],
  api: WebflowStyleEditor,
  depth = 0,
): Promise<StyleHandle | undefined> {
  if (!names.length) {
    return undefined;
  }
  if (depth > CLIP_PATH_LIMITS.styleDepthMax) {
    return undefined;
  }

  const existing = await findStyleForClassPath(names, api);
  if (existing) {
    return existing;
  }
  if (!api.createStyle) {
    return undefined;
  }

  if (names.length === 1) {
    const name = names[0];
    if (!name) {
      return undefined;
    }
    const created = await readOptional(() => api.createStyle?.(name));
    return isStyleHandle(created) ? created : undefined;
  }

  const parent = await resolveOrCreateStyleForClassPath(names.slice(0, -1), api, depth + 1);
  if (!isStyleHandle(parent)) {
    return undefined;
  }
  const name = names[names.length - 1];
  if (!name) {
    return undefined;
  }
  const created = await readOptional(() => api.createStyle?.(name, { parent }));
  return isStyleHandle(created) ? created : undefined;
}

// Resolve which selector's clip-path actually wins the CSS cascade for this
// element: highest specificity first (combo `.a.b` beats standalone `.b`), then
// — for equal specificity — the one defined LATEST in the stylesheet (created
// last in Webflow). Stylesheet order, NOT the element's class-application order,
// is the tiebreaker, mirroring how the browser resolves it. Candidates are the
// element's own combo chain plus each class's standalone style.
async function resolveCascadeWinnerClipPathStyle(
  classNames: string[],
  primaryStyles: StyleHandle[],
  options: StyleTargetOptions | undefined,
  api: WebflowStyleLookup,
): Promise<
  | {
      style: StyleHandle;
      raw: string;
      breakpoint: BreakpointId;
      namePath: string[];
    }
  | undefined
> {
  const declaring = await readDeclaringCascadeCandidates(classNames, primaryStyles, options, api);
  if (!declaring.length) {
    return undefined;
  }

  const maxSpecificity = Math.max(...declaring.map((entry) => entry.specificity));
  const topTier = declaring.filter((entry) => entry.specificity === maxSpecificity);
  const winner = await latestInStylesheet(topTier, api);
  if (!winner) {
    return undefined;
  }
  return {
    style: winner.style,
    raw: winner.raw,
    breakpoint: winner.breakpoint,
    namePath: winner.namePath,
  };
}

// A style whose clip-path could win the cascade, with what the cascade compares.
type CascadeCandidate = {
  style: StyleHandle;
  raw: string;
  breakpoint: BreakpointId;
  namePath: string[];
  specificity: number;
};

// The candidates (element combo chain + each class's standalone) that declare a
// clip-path. Each one's clip-path and name-path are read IN PARALLEL — this runs on
// the polling path, so sequential round-trips to the Designer would block the read
// loop.
async function readDeclaringCascadeCandidates(
  classNames: string[],
  primaryStyles: StyleHandle[],
  options: StyleTargetOptions | undefined,
  api: WebflowStyleLookup,
): Promise<CascadeCandidate[]> {
  const standalones = await Promise.all(
    classNames.map((name) => findStyleForClassPath([name], api)),
  );
  const candidates: StyleHandle[] = [];
  const seenRefs = new Set<StyleHandle>();
  const seenIds = new Set<string>();
  addStyleHandles(candidates, primaryStyles, seenRefs, seenIds);
  for (const standalone of standalones) {
    if (standalone) {
      addUniqueStyleHandle(candidates, standalone, seenRefs, seenIds);
    }
  }

  const reads = await Promise.all(
    candidates.map(async (style): Promise<CascadeCandidate | undefined> => {
      const declaration = await readClipPathDeclarationWithSource(style, options);
      if (!declaration) {
        return undefined;
      }
      if (!hasClipPathDeclaration(declaration.value)) {
        return undefined;
      }
      const namePath = await getStyleNamePath(style);
      return {
        style,
        raw: declaration.value,
        breakpoint: declaration.breakpoint,
        namePath,
        specificity: namePath.length,
      };
    }),
  );
  return reads.filter((entry): entry is CascadeCandidate => entry !== undefined);
}

// Among equally specific candidates, the one defined latest in the stylesheet wins.
// The (potentially large) full style list is fetched only when there's a real tie.
async function latestInStylesheet(
  topTier: CascadeCandidate[],
  api: WebflowStyleLookup,
): Promise<CascadeCandidate | undefined> {
  const firstWinner = topTier[0];
  if (!firstWinner) {
    return undefined;
  }
  if (topTier.length <= 1) {
    return firstWinner;
  }
  const allStyles =
    (await readOptionalWithTimeout(() => api.getAllStyles?.(), STYLE_LOOKUP_TIMEOUT_MS)) || [];
  const orderById = new Map<string, number>();
  allStyles.forEach((style, index) => {
    if (style?.id) {
      orderById.set(style.id, index);
    }
  });
  const orderOf = (entry: CascadeCandidate) =>
    entry.style.id ? (orderById.get(entry.style.id) ?? -1) : -1;
  let winner = firstWinner;
  for (const entry of topTier.slice(1)) {
    if (orderOf(entry) > orderOf(winner)) {
      winner = entry;
    }
  }
  return winner;
}

// The keyboard and pointer hints read out after each canvas handle's name.
const HANDLE_ADJUST_HINT = 'Drag or use arrow keys to adjust.';
const POINT_HANDLE_HINT =
  'Drag to move, double-click to remove. Use arrow keys to move when selected.';
const INSET_EDGE_HANDLE_HINT =
  'Drag or use arrow keys to resize. ' +
  'Hold Shift for all sides or Option for this side and the opposite side.';
const INSET_RADIUS_HANDLE_HINT =
  'Drag or use arrow keys to adjust. ' +
  'Hold U to unlock separate horizontal and vertical radii. ' +
  'Hold Shift for all corners or Option for this corner and the opposite corner.';

// A field the user types into: the canvas's keyboard shortcuts leave it alone.
function isEditableTarget(target: HTMLElement | undefined) {
  return Boolean(
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable),
  );
}

// The props of the editor when it is embedded in the Style panel.
type ClipPathProps = {
  /** When provided (embedded in the Style panel's Effects popup), clip-path is
      persisted through these — the panel's own writers, which target the user's
      selected selector — instead of the tool resolving its own class style, and the
      class-picker tags are hidden. onApply gets a ready-to-use `clip-path` value. */
  onApply?: (value: string) => void;
  onClear?: () => void;
  hideClassPicker?: boolean;
};

// The shape being edited, its code text, and the preset menu.
function useShapeState() {
  const [shape, setShape] = useState<ClipShape>(NONE_SHAPE);
  const [codeValue, setCodeValue] = useState(formatCodeValue(NONE_SHAPE));
  const [activePreset, setActivePreset] = useState<string>(NONE_PRESET);
  const [isPresetOpen, setIsPresetOpen] = useState(false);
  const [isCodeTransitioning, setIsCodeTransitioning] = useState(false);
  const [circleRadiusAngle, setCircleRadiusAngle] = useState(0);
  return {
    shape,
    setShape,
    codeValue,
    setCodeValue,
    activePreset,
    setActivePreset,
    isPresetOpen,
    setIsPresetOpen,
    isCodeTransitioning,
    setIsCodeTransitioning,
    circleRadiusAngle,
    setCircleRadiusAngle,
  };
}

type EditorAfterShapeState = ClipPathProps & ReturnType<typeof useShapeState>;

// Which handles are selected, and what the canvas measures.
function useHandleSelectionState() {
  const [selectedHandle, setSelectedHandle] = useState<HandleTarget | undefined>(undefined);
  const [selectedCodeHandles, setSelectedCodeHandles] = useState<HandleTarget[]>([]);
  const [isShapeTransformSelected, setIsShapeTransformSelected] = useState(false);
  const [activeInsetModifierMode, setActiveInsetModifierMode] =
    useState<InsetModifierMode>('single');
  const [activePresetIndex, setActivePresetIndex] = useState(PRESET_NAMES.indexOf(NONE_PRESET));
  const [handleBounds, setHandleBounds] = useState<CanvasHandleBounds | undefined>(undefined);
  const [canvasSize, setCanvasSize] = useState<CanvasSize | undefined>(undefined);
  const [polygonPointColors, setPolygonPointColors] = useState<string[]>([]);
  return {
    selectedHandle,
    setSelectedHandle,
    selectedCodeHandles,
    setSelectedCodeHandles,
    isShapeTransformSelected,
    setIsShapeTransformSelected,
    activeInsetModifierMode,
    setActiveInsetModifierMode,
    activePresetIndex,
    setActivePresetIndex,
    handleBounds,
    setHandleBounds,
    canvasSize,
    setCanvasSize,
    polygonPointColors,
    setPolygonPointColors,
  };
}

type EditorAfterHandleSelectionState = EditorAfterShapeState &
  ReturnType<typeof useHandleSelectionState>;

// How a pasted shape fits the element, and the drag guides.
function useShapeFitState() {
  const [shapeFitMode, setShapeFitMode] = useState<ShapeFitMode>('contain');
  const [shapeScaleUseVariable, setShapeScaleUseVariable] = useState(false);
  const [shapeScaleVariableName, setShapeScaleVariableName] = useState(
    DEFAULT_SHAPE_SCALE_VARIABLE_NAME,
  );
  const [shapeOffsetLeftVariableName, setShapeOffsetLeftVariableName] = useState(
    DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
  );
  const [shapeOffsetTopVariableName, setShapeOffsetTopVariableName] = useState(
    DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
  );
  const [selectionRect, setSelectionRect] = useState<SelectionRect | undefined>(undefined);
  const [snapGuides, setSnapGuides] = useState<SnapGuides | undefined>(undefined);
  return {
    shapeFitMode,
    setShapeFitMode,
    shapeScaleUseVariable,
    setShapeScaleUseVariable,
    shapeScaleVariableName,
    setShapeScaleVariableName,
    shapeOffsetLeftVariableName,
    setShapeOffsetLeftVariableName,
    shapeOffsetTopVariableName,
    setShapeOffsetTopVariableName,
    selectionRect,
    setSelectionRect,
    snapGuides,
    setSnapGuides,
  };
}

type EditorAfterShapeFitState = EditorAfterHandleSelectionState &
  ReturnType<typeof useShapeFitState>;

// Where the clip-path is read from and written to, and the popovers over it.
function useStyleSourceState() {
  const [clipPathStyleOrigin, setClipPathStyleOrigin] = useState<ClipPathStyleOrigin>('none');
  const [elementClassNames, setElementClassNames] = useState<string[]>([]);
  const [appliedClassName, setAppliedClassName] = useState<string | undefined>(undefined);
  const [selectedClassNames, setSelectedClassNames] = useState<string[]>([]);
  // Where the rendered clip-path actually comes from (for the orange "inherited"
  // label's "Value comes from:" popover) — its selector classes and breakpoint.
  const [clipPathSourceSelector, setClipPathSourceSelector] = useState<string[]>([]);
  const [clipPathSourceBreakpoint, setClipPathSourceBreakpoint] = useState<
    BreakpointId | undefined
  >(undefined);
  const [isClipPathLabelMenuOpen, setIsClipPathLabelMenuOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const [shortcutHelpPortalTarget, setShortcutHelpPortalTarget] = useState<HTMLElement | undefined>(
    undefined,
  );
  return {
    clipPathStyleOrigin,
    setClipPathStyleOrigin,
    elementClassNames,
    setElementClassNames,
    appliedClassName,
    setAppliedClassName,
    selectedClassNames,
    setSelectedClassNames,
    clipPathSourceSelector,
    setClipPathSourceSelector,
    clipPathSourceBreakpoint,
    setClipPathSourceBreakpoint,
    isClipPathLabelMenuOpen,
    setIsClipPathLabelMenuOpen,
    isShortcutHelpOpen,
    setIsShortcutHelpOpen,
    shortcutHelpPortalTarget,
    setShortcutHelpPortalTarget,
  };
}

type EditorAfterStyleSourceState = EditorAfterShapeFitState &
  ReturnType<typeof useStyleSourceState>;

// Mutable state of the canvas: its elements, and the drags in flight.
function useCanvasRefs() {
  // Memoized cascade-winner per (classNames + cheap effective value) so a refining
  // re-read can reuse the existing shape-cache-aware load path instead of blocking
  // the first paint. Keyed so it auto-invalidates when the situation changes.
  const cascadeWinnerCacheRef = useRef<
    | {
        key: string;
        winner: Awaited<ReturnType<typeof resolveCascadeWinnerClipPathStyle>>;
      }
    | undefined
  >(undefined);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const clipPathLabelRef = useRef<HTMLDivElement>(null);
  const shortcutHelpRef = useRef<HTMLDivElement>(null);
  const presetDropdownRef = useRef<HTMLDivElement>(null);
  const presetButtonRef = useRef<HTMLButtonElement>(null);
  const presetListRef = useRef<HTMLDivElement>(null);
  const presetTypeaheadRef = useRef('');
  const presetTypeaheadTimerRef = useRef<number | undefined>(undefined);
  const dragTargetRef = useRef<DragTarget | undefined>(undefined);
  const polygonSelectionDragRef = useRef<PolygonSelectionDrag | undefined>(undefined);
  const shapeTransformDragRef = useRef<ShapeTransformDrag | undefined>(undefined);
  const activePointerIdRef = useRef<number | undefined>(undefined);
  const activePointerCaptureRef = useRef<HTMLElement | undefined>(undefined);
  return {
    cascadeWinnerCacheRef,
    canvasWrapRef,
    canvasRef,
    clipPathLabelRef,
    shortcutHelpRef,
    presetDropdownRef,
    presetButtonRef,
    presetListRef,
    presetTypeaheadRef,
    presetTypeaheadTimerRef,
    dragTargetRef,
    polygonSelectionDragRef,
    shapeTransformDragRef,
    activePointerIdRef,
    activePointerCaptureRef,
  };
}

type EditorAfterCanvasRefs = EditorAfterStyleSourceState & ReturnType<typeof useCanvasRefs>;

// Mutable state of the write path and of the keyboard.
function useWriteRefs() {
  const styleRef = useRef<StyleHandle | undefined>(undefined);
  const latestCssRef = useRef<string>('');
  const lastWrittenRef = useRef<string | undefined>(undefined);
  const writeTimerRef = useRef<number | undefined>(undefined);
  const localWritePendingRef = useRef(false);
  const selectedHandleRef = useRef<HandleTarget | undefined>(undefined);
  const selectedHandlesRef = useRef<HandleTarget[]>([]);
  const isShapeTransformSelectedRef = useRef(false);
  const handleBoundsRef = useRef<CanvasHandleBounds | undefined>(undefined);
  const polygonPointColorsRef = useRef<string[]>([]);
  const spaceKeyPressedRef = useRef(false);
  const radiusUnlockKeyPressedRef = useRef(false);
  const keyboardModifiersRef = useRef<KeyboardModifiers>({
    altKey: false,
    shiftKey: false,
    radiusUnlocked: false,
  });
  const pressedArrowKeysRef = useRef<Set<ArrowKey>>(new Set());
  const handledKeyboardEventsRef = useRef<WeakSet<Event>>(new WeakSet());
  return {
    styleRef,
    latestCssRef,
    lastWrittenRef,
    writeTimerRef,
    localWritePendingRef,
    selectedHandleRef,
    selectedHandlesRef,
    isShapeTransformSelectedRef,
    handleBoundsRef,
    polygonPointColorsRef,
    spaceKeyPressedRef,
    radiusUnlockKeyPressedRef,
    keyboardModifiersRef,
    pressedArrowKeysRef,
    handledKeyboardEventsRef,
  };
}

type EditorAfterWriteRefs = EditorAfterCanvasRefs & ReturnType<typeof useWriteRefs>;

// Timers and bookkeeping for keyboard moves, the code transition, and selection reads.
function useSelectionRefs() {
  const keyboardMoveDelayTimerRef = useRef<number | undefined>(undefined);
  const keyboardMoveTimerRef = useRef<number | undefined>(undefined);
  const polygonDisplayProjectionsRef = useRef<Map<number, PolygonDisplayProjection>>(new Map());
  const isPresetOpenRef = useRef(false);
  const circleRadiusAngleRef = useRef(0);
  const codeChangedShapeRef = useRef(false);
  const codeTransitionTimerRef = useRef<number | undefined>(undefined);
  const selectionReadSeqRef = useRef(0);
  const selectionReadInProgressRef = useRef(false);
  const selectionReadTimerRef = useRef<number | undefined>(undefined);
  const selectedElementKeyRef = useRef<string | undefined>(undefined);
  const selectedClassNamesRef = useRef<string[]>([]);
  // True while the selection is the auto-derived cascade winner (not a manual
  // click) — lets it keep following the winner as styles/classes change.
  const selectionIsDefaultRef = useRef(true);
  const refreshSelectedElementRef = useRef<((options?: SelectionReadOptions) => void) | undefined>(
    undefined,
  );
  return {
    keyboardMoveDelayTimerRef,
    keyboardMoveTimerRef,
    polygonDisplayProjectionsRef,
    isPresetOpenRef,
    circleRadiusAngleRef,
    codeChangedShapeRef,
    codeTransitionTimerRef,
    selectionReadSeqRef,
    selectionReadInProgressRef,
    selectionReadTimerRef,
    selectedElementKeyRef,
    selectedClassNamesRef,
    selectionIsDefaultRef,
    refreshSelectedElementRef,
  };
}

type EditorAfterSelectionRefs = EditorAfterWriteRefs & ReturnType<typeof useSelectionRefs>;

// Mirrors of the latest shape settings and embed callbacks, and the undo history.
function useShapeRefs(editor: EditorAfterSelectionRefs) {
  const { onApply, onClear } = editor;
  const shapeRef = useRef<ClipShape>(NONE_SHAPE);
  const shapeFitModeRef = useRef<ShapeFitMode>('contain');
  const shapeScaleUseVariableRef = useRef(false);
  const shapeScaleVariableNameRef = useRef(DEFAULT_SHAPE_SCALE_VARIABLE_NAME);
  const shapeOffsetLeftVariableNameRef = useRef(DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME);
  const shapeOffsetTopVariableNameRef = useRef(DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME);
  const pastedShapeSvgCacheRef = useRef<PastedShapeSvgCache | undefined>(undefined);
  const activeBreakpointRef = useRef<BreakpointId>('main');
  // Mirror the embed callbacks into refs so the write effect (keyed on [css]) always
  // sees the latest without re-subscribing.
  const onApplyRef = useRef(onApply);
  const onClearRef = useRef(onClear);
  onApplyRef.current = onApply;
  onClearRef.current = onClear;

  const historyRef = useRef<ClipShape[]>([NONE_SHAPE]);
  const historyIndexRef = useRef<number>(0);
  return {
    shapeRef,
    shapeFitModeRef,
    shapeScaleUseVariableRef,
    shapeScaleVariableNameRef,
    shapeOffsetLeftVariableNameRef,
    shapeOffsetTopVariableNameRef,
    pastedShapeSvgCacheRef,
    activeBreakpointRef,
    onApplyRef,
    onClearRef,
    historyRef,
    historyIndexRef,
  };
}

type EditorAfterShapeRefs = EditorAfterSelectionRefs & ReturnType<typeof useShapeRefs>;

// The CSS the shape writes, and the code editor's token colours.
function useCodeHighlights(editor: EditorAfterShapeRefs) {
  const { shape, canvasSize, codeValue, polygonPointColors } = editor;
  const css = useMemo(() => formatClipPath(shape), [shape]);
  const previewCss = useMemo(
    () => formatClipPathForPreview(shape, css, canvasSize),
    [canvasSize, css, shape],
  );
  const codeTokenHighlights = useMemo(
    () => buildClipPathCodeHighlights(shape, codeValue, polygonPointColors),
    [shape, codeValue, polygonPointColors],
  );
  const codeHandleColorClasses = useMemo(() => {
    const colorClasses = new Map<string, string>();
    codeTokenHighlights.forEach((highlight) => {
      highlight.handles.forEach((handle) =>
        colorClasses.set(handleKey(handle), highlight.colorClass),
      );
    });
    return colorClasses;
  }, [codeTokenHighlights]);
  return { css, previewCss, codeTokenHighlights, codeHandleColorClasses };
}

type EditorAfterCodeHighlights = EditorAfterShapeRefs & ReturnType<typeof useCodeHighlights>;

// The code tokens of the selected handles, drawn over the rest.
function useSelectedCodeHighlights(editor: EditorAfterCodeHighlights) {
  const { selectedCodeHandles, selectedHandle, codeTokenHighlights, codeValue } = editor;
  const selectedCodeTokenHighlights = useMemo<CodeEditorTokenHighlight[]>(() => {
    const selectedHandles = selectedCodeHandles.length
      ? selectedCodeHandles
      : selectedHandle
        ? [selectedHandle]
        : [];
    if (!selectedHandles.length) {
      return codeTokenHighlights;
    }

    const selectionHighlights: CodeEditorTokenHighlight[] = [];
    const seenRanges = new Set<string>();

    selectedHandles.forEach((selected) => {
      const ranges = codeTokenHighlights
        .filter((highlight) => highlight.handles.some((handle) => handlesMatch(selected, handle)))
        .sort((left, right) => left.from - right.from || left.to - right.to);

      let group: ClipPathCodeHighlight[] = [];
      const flushGroup = () => {
        const first = group[0];
        const last = group[group.length - 1];
        if (!first || !last) {
          return;
        }
        const from = first.from;
        const to = last.to;
        const colorClass = first.colorClass;
        const key = `${from}:${to}:${colorClass}`;
        if (!seenRanges.has(key)) {
          seenRanges.add(key);
          selectionHighlights.push({
            from,
            to,
            className: `clip-path_code-token-selection ${colorClass}`,
          });
        }
        group = [];
      };

      ranges.forEach((range) => {
        const previous = group[group.length - 1];
        if (previous && !/^\s*$/.test(codeValue.slice(previous.to, range.from))) {
          flushGroup();
        }
        group.push(range);
      });
      flushGroup();
    });

    return [...selectionHighlights, ...codeTokenHighlights];
  }, [codeTokenHighlights, codeValue, selectedCodeHandles, selectedHandle]);
  return { selectedCodeTokenHighlights };
}

type EditorAfterSelectedCodeHighlights = EditorAfterCodeHighlights &
  ReturnType<typeof useSelectedCodeHighlights>;

// The shortcut help, and the refs that mirror this render's state for the listeners
// registered once.
function useLatestMirrors(editor: EditorAfterSelectedCodeHighlights) {
  const { shape, shapeFitMode, latestCssRef, css, shapeRef, shapeFitModeRef } = editor;
  const { shapeScaleUseVariableRef, shapeScaleUseVariable, shapeScaleVariableNameRef } = editor;
  const { shapeScaleVariableName, shapeOffsetLeftVariableNameRef } = editor;
  const { shapeOffsetLeftVariableName, shapeOffsetTopVariableNameRef } = editor;
  const { shapeOffsetTopVariableName, isShapeTransformSelectedRef } = editor;
  const { isShapeTransformSelected, handleBoundsRef, handleBounds, isPresetOpenRef } = editor;
  const { isPresetOpen, circleRadiusAngleRef, circleRadiusAngle } = editor;
  const shortcutHelpGroups = useMemo(
    () => clipPathShortcutGroups(shape, shapeFitMode),
    [shape, shapeFitMode],
  );
  latestCssRef.current = css;
  shapeRef.current = shape;
  shapeFitModeRef.current = shapeFitMode;
  shapeScaleUseVariableRef.current = shapeScaleUseVariable;
  shapeScaleVariableNameRef.current = shapeScaleVariableName;
  shapeOffsetLeftVariableNameRef.current = shapeOffsetLeftVariableName;
  shapeOffsetTopVariableNameRef.current = shapeOffsetTopVariableName;
  isShapeTransformSelectedRef.current = isShapeTransformSelected;
  handleBoundsRef.current = handleBounds;
  isPresetOpenRef.current = isPresetOpen;
  circleRadiusAngleRef.current = circleRadiusAngle;
  return { shortcutHelpGroups };
}

type EditorAfterLatestMirrors = EditorAfterSelectedCodeHighlights &
  ReturnType<typeof useLatestMirrors>;

// Keeping presets, pending writes, and point colours in step with the shape.
function shapeSyncActions(editor: EditorAfterLatestMirrors) {
  const { setActivePreset, setActivePresetIndex, writeTimerRef, selectionReadSeqRef } = editor;
  const { selectionReadTimerRef, localWritePendingRef, polygonPointColorsRef } = editor;
  const { setPolygonPointColors } = editor;
  const syncPresetForShape = (next: ClipShape) => {
    const matchedPreset = matchPreset(next);
    const nextPreset = matchedPreset || NONE_PRESET;
    setActivePreset(nextPreset);
    setActivePresetIndex(PRESET_NAMES.indexOf(nextPreset));
  };

  const clearPendingWrite = () => {
    if (writeTimerRef.current !== undefined) {
      window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = undefined;
    }
  };

  const cancelPendingSelectionRead = () => {
    selectionReadSeqRef.current += 1;
    if (selectionReadTimerRef.current !== undefined) {
      window.clearTimeout(selectionReadTimerRef.current);
      selectionReadTimerRef.current = undefined;
    }
  };

  const markLocalShapeChange = () => {
    localWritePendingRef.current = true;
    cancelPendingSelectionRead();
  };

  const syncPolygonPointColors = (colors: string[]) => {
    polygonPointColorsRef.current = colors;
    setPolygonPointColors(colors);
  };

  const syncPolygonPointColorsForShape = (
    next: ClipShape,
    colors = polygonPointColorsRef.current,
  ) => {
    syncPolygonPointColors(
      next.kind === 'polygon' ? normalizePolygonPointColors(next.points.length, colors) : [],
    );
  };
  return {
    syncPresetForShape,
    clearPendingWrite,
    cancelPendingSelectionRead,
    markLocalShapeChange,
    syncPolygonPointColors,
    syncPolygonPointColorsForShape,
  };
}

type EditorAfterShapeSyncActions = EditorAfterLatestMirrors & ReturnType<typeof shapeSyncActions>;

// Keeping the shape-scale options and fit mode in step with a loaded shape.
function shapeScaleSyncActions(editor: EditorAfterShapeSyncActions) {
  const { shapeScaleUseVariableRef, shapeScaleVariableNameRef } = editor;
  const { shapeOffsetLeftVariableNameRef, shapeOffsetTopVariableNameRef } = editor;
  const { setShapeScaleUseVariable, setShapeScaleVariableName } = editor;
  const { setShapeOffsetLeftVariableName, setShapeOffsetTopVariableName, shapeFitModeRef } = editor;
  const { setShapeFitMode } = editor;
  const currentShapeScaleOptions = (
    overrides: ShapeScaleOptionOverrides = {},
  ): ShapeScaleOptions => ({
    useVariable: overrides.useVariable ?? shapeScaleUseVariableRef.current,
    variableName: overrides.variableName ?? shapeScaleVariableNameRef.current,
    offsetLeftVariableName:
      overrides.offsetLeftVariableName ?? shapeOffsetLeftVariableNameRef.current,
    offsetTopVariableName: overrides.offsetTopVariableName ?? shapeOffsetTopVariableNameRef.current,
  });

  const syncShapeScaleOptionsForLoadedShape = (next: ClipShape) => {
    if (next.kind !== 'shape') {
      return;
    }
    const variableName = shapeScaleVariableNameFromValue(next.value);
    const offsetNames = shapeOffsetVariableNamesFromValue(next.value);
    const nextUseVariable = Boolean(variableName);
    shapeScaleUseVariableRef.current = nextUseVariable;
    setShapeScaleUseVariable(nextUseVariable);

    if (variableName) {
      shapeScaleVariableNameRef.current = variableName;
      setShapeScaleVariableName(variableName);
    }
    if (offsetNames?.offsetLeftVar) {
      shapeOffsetLeftVariableNameRef.current = offsetNames.offsetLeftVar;
      setShapeOffsetLeftVariableName(offsetNames.offsetLeftVar);
    }
    if (offsetNames?.offsetTopVar) {
      shapeOffsetTopVariableNameRef.current = offsetNames.offsetTopVar;
      setShapeOffsetTopVariableName(offsetNames.offsetTopVar);
    }
  };

  const syncShapeFitModeForLoadedShape = (next: ClipShape, fallbackMode?: ShapeFitMode) => {
    if (next.kind !== 'shape') {
      return;
    }
    if (fallbackMode !== 'stretch') {
      syncShapeScaleOptionsForLoadedShape(next);
    }
    const nextMode: ShapeFitMode =
      fallbackMode || (hasContainerQueryUnit(next.value) ? 'contain' : 'stretch');
    shapeFitModeRef.current = nextMode;
    setShapeFitMode(nextMode);
  };
  return {
    currentShapeScaleOptions,
    syncShapeScaleOptionsForLoadedShape,
    syncShapeFitModeForLoadedShape,
  };
}

type EditorAfterShapeScaleSyncActions = EditorAfterShapeSyncActions &
  ReturnType<typeof shapeScaleSyncActions>;

// The pasted-SVG cache, point colours, the keyboard move loop, and snap guides.
function pastedCacheActions(editor: EditorAfterShapeScaleSyncActions) {
  const { pastedShapeSvgCacheRef, currentShapeScaleOptions, polygonPointColorsRef } = editor;
  const { syncPolygonPointColors, setActiveInsetModifierMode, keyboardMoveDelayTimerRef } = editor;
  const { keyboardMoveTimerRef, pressedArrowKeysRef, setSnapGuides } = editor;
  const clearPastedShapeSvgCache = () => {
    pastedShapeSvgCacheRef.current = undefined;
  };

  const shapeMatchesPastedSvgCache = (next: ClipShape, cache = pastedShapeSvgCacheRef.current) =>
    next.kind === 'shape' &&
    Boolean(cache && (shapesClose(next, cache.stretch) || shapesClose(next, cache.contain)));

  const matchingPastedSvgCacheForShape = (
    next: ClipShape,
    options: ShapeScaleOptions = currentShapeScaleOptions(),
  ) => {
    const cache = normalizeShapeFitCache(pastedShapeSvgCacheRef.current, options);
    return next.kind === 'shape' && cache && shapeMatchesPastedSvgCache(next, cache)
      ? cache
      : undefined;
  };

  const cacheFromPastedShapeSvgSource = (source: string): PastedShapeSvgCache | undefined => {
    const stretch = parseSvgClipPathShape(source, 'stretch');
    const contain = parseSvgClipPathShape(source, 'contain', currentShapeScaleOptions());
    return normalizeShapeFitCache(
      stretch && contain ? { source, stretch, contain } : undefined,
      currentShapeScaleOptions(),
    );
  };

  const insertPolygonPointColor = (insertIndex: number, pointCount: number) => {
    const colors = normalizePolygonPointColors(pointCount, polygonPointColorsRef.current);
    const nextColor = nextPolygonPointColor(colors, insertIndex);
    const nextColors = [...colors.slice(0, insertIndex), nextColor, ...colors.slice(insertIndex)];
    syncPolygonPointColors(nextColors);
    return nextColors;
  };

  const syncInsetModifierMode = (modifiers: KeyboardModifiers) => {
    const next = insetModifierModeFromKeys(modifiers);
    setActiveInsetModifierMode((current) => (current === next ? current : next));
    return next;
  };

  const stopKeyboardMoveLoop = (clearKeys = true) => {
    if (keyboardMoveDelayTimerRef.current !== undefined) {
      window.clearTimeout(keyboardMoveDelayTimerRef.current);
      keyboardMoveDelayTimerRef.current = undefined;
    }
    if (keyboardMoveTimerRef.current !== undefined) {
      window.clearInterval(keyboardMoveTimerRef.current);
      keyboardMoveTimerRef.current = undefined;
    }
    if (clearKeys) {
      pressedArrowKeysRef.current.clear();
    }
  };

  const showSnapGuides = (guides: SnapGuides) => {
    setSnapGuides(normalizeSnapGuides(guides));
  };

  const clearSnapGuides = () => {
    setSnapGuides(undefined);
  };
  return {
    clearPastedShapeSvgCache,
    shapeMatchesPastedSvgCache,
    matchingPastedSvgCacheForShape,
    cacheFromPastedShapeSvgSource,
    insertPolygonPointColor,
    syncInsetModifierMode,
    stopKeyboardMoveLoop,
    showSnapGuides,
    clearSnapGuides,
  };
}

type EditorAfterPastedCacheActions = EditorAfterShapeScaleSyncActions &
  ReturnType<typeof pastedCacheActions>;

// Selecting handles, and reading the polygon selection.
function handleSelectionActions(editor: EditorAfterPastedCacheActions) {
  const { isShapeTransformSelectedRef, setIsShapeTransformSelected, selectedHandleRef } = editor;
  const { stopKeyboardMoveLoop, clearSnapGuides, selectedHandlesRef, setSelectedHandle } = editor;
  const { setSelectedCodeHandles, setActiveInsetModifierMode, spaceKeyPressedRef } = editor;
  const setShapeTransformSelection = (selected: boolean) => {
    isShapeTransformSelectedRef.current = selected;
    setIsShapeTransformSelected(selected);
    if (!selected) {
      if (!selectedHandleRef.current) {
        stopKeyboardMoveLoop();
      }
      clearSnapGuides();
      return;
    }

    selectedHandleRef.current = undefined;
    selectedHandlesRef.current = [];
    setSelectedHandle(undefined);
    setSelectedCodeHandles([]);
    setActiveInsetModifierMode('single');
  };

  const setHandleSelection = (
    handle: HandleTarget | undefined,
    handles = handle ? [handle] : [],
  ) => {
    if (isShapeTransformSelectedRef.current) {
      isShapeTransformSelectedRef.current = false;
      setIsShapeTransformSelected(false);
    }
    const nextHandles = handle ? uniqueHandles(handles.length ? handles : [handle]) : [];
    selectedHandleRef.current = handle;
    selectedHandlesRef.current = nextHandles;
    setSelectedHandle(handle);
    setSelectedCodeHandles(nextHandles);
    if (!handle) {
      spaceKeyPressedRef.current = false;
      stopKeyboardMoveLoop();
      clearSnapGuides();
      setActiveInsetModifierMode('single');
    }
  };

  const selectHandle = (handle: HandleTarget | undefined) => {
    setHandleSelection(handle);
  };

  const getPolygonSelection = (handle: HandleTarget) => {
    if (!isPolygonPointHandle(handle)) {
      return [];
    }

    const selectedPolygonHandles = selectedHandlesRef.current.filter(isPolygonPointHandle);
    return handleListIncludes(selectedPolygonHandles, handle) ? selectedPolygonHandles : [handle];
  };

  const getPolygonSelectionIndexes = (handle: HandleTarget) =>
    getPolygonSelection(handle).map((selected) => selected.index);

  const getActivePolygonSelection = () => {
    const selectedPolygonHandles = selectedHandlesRef.current.filter(isPolygonPointHandle);
    if (selectedPolygonHandles.length) {
      return selectedPolygonHandles;
    }

    const selectedHandle = selectedHandleRef.current;
    return isPolygonPointHandle(selectedHandle) ? [selectedHandle] : [];
  };
  return {
    setShapeTransformSelection,
    setHandleSelection,
    selectHandle,
    getPolygonSelection,
    getPolygonSelectionIndexes,
    getActivePolygonSelection,
  };
}

type EditorAfterHandleSelectionActions = EditorAfterPastedCacheActions &
  ReturnType<typeof handleSelectionActions>;

// Selecting handles from the pointer and the keyboard.
function pointerSelectionActions(editor: EditorAfterHandleSelectionActions) {
  const { selectedHandlesRef, setHandleSelection, selectedHandleRef, setSelectedHandle } = editor;
  const { selectHandle, canvasRef } = editor;
  const selectHandleFromPointer = (handle: HandleTarget, { additive }: { additive: boolean }) => {
    if (isPolygonPointHandle(handle)) {
      const selectedPolygonHandles = selectedHandlesRef.current.filter(isPolygonPointHandle);
      if (additive) {
        const nextHandles = uniqueHandles([...selectedPolygonHandles, handle]);
        setHandleSelection(handle, nextHandles);
        return nextHandles;
      }

      if (selectedPolygonHandles.length > 1 && handleListIncludes(selectedPolygonHandles, handle)) {
        setHandleSelection(handle, selectedPolygonHandles);
        return selectedPolygonHandles;
      }
    }

    setHandleSelection(handle);
    return [handle];
  };

  const selectHandleForKeyboard = (handle: HandleTarget) => {
    if (handleListIncludes(selectedHandlesRef.current, handle)) {
      selectedHandleRef.current = handle;
      setSelectedHandle(handle);
      return;
    }

    selectHandle(handle);
  };

  const canvasPointFromClient = (clientX: number, clientY: number): Point | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return undefined;
    }
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  };
  return { selectHandleFromPointer, selectHandleForKeyboard, canvasPointFromClient };
}

type EditorAfterPointerSelectionActions = EditorAfterHandleSelectionActions &
  ReturnType<typeof pointerSelectionActions>;

// The marquee selection of polygon points.
function polygonSelectionActions(editor: EditorAfterPointerSelectionActions) {
  const { handleBoundsRef, polygonDisplayProjectionsRef, shapeRef, setHandleSelection } = editor;
  const polygonDisplayPointForSelection = (points: Point[], index: number): Point => {
    const display = polygonHandleDisplayPoint(
      points,
      index,
      handleBoundsRef.current,
      polygonDisplayProjectionsRef.current.get(index),
    ).point;
    const bounds = handleBoundsRef.current;
    if (!bounds || bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
      return display;
    }
    return {
      x: clampValue(display.x, bounds.minX, bounds.maxX),
      y: clampValue(display.y, bounds.minY, bounds.maxY),
    };
  };

  const applyPolygonSelectionRect = (selection: PolygonSelectionDrag) => {
    const current = shapeRef.current;
    if (current.kind !== 'polygon') {
      return;
    }

    const rect = rectFromPoints(selection.start, selection.current);
    const selectedByRect = current.points
      .map((_, index) => ({ kind: 'polygon-point' as const, index }))
      .filter((handle) =>
        pointInRect(polygonDisplayPointForSelection(current.points, handle.index), rect),
      );
    const validBaseHandles = selection.baseHandles.filter(
      (handle) => handle.index >= 0 && handle.index < current.points.length,
    );
    const nextHandles = selection.additive
      ? uniqueHandles([...validBaseHandles, ...selectedByRect])
      : selectedByRect;
    const nextPrimary =
      selectedByRect[selectedByRect.length - 1] || nextHandles[nextHandles.length - 1] || undefined;

    setHandleSelection(nextPrimary, nextHandles);
  };

  const focusSelectedHandle = () => {
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>('.clip-path_handle.is-selected')
        ?.focus({ preventScroll: true });
    });
  };
  return { polygonDisplayPointForSelection, applyPolygonSelectionRect, focusSelectedHandle };
}

type EditorAfterPolygonSelectionActions = EditorAfterPointerSelectionActions &
  ReturnType<typeof polygonSelectionActions>;

// Pointer capture, the undo commit, and closing what a drag leaves open.
function dragSupportActions(editor: EditorAfterPolygonSelectionActions) {
  const { activePointerIdRef, activePointerCaptureRef, historyRef, historyIndexRef } = editor;
  const { setIsPresetOpen, codeTransitionTimerRef, setIsCodeTransitioning } = editor;
  const releaseActivePointerCapture = () => {
    const pointerId = activePointerIdRef.current;
    const captureTarget = activePointerCaptureRef.current;
    if (pointerId !== undefined && captureTarget?.hasPointerCapture?.(pointerId)) {
      try {
        captureTarget.releasePointerCapture(pointerId);
      } catch {
        /* pointer capture can already be gone after pointerup/cancel */
      }
    }
    activePointerIdRef.current = undefined;
    activePointerCaptureRef.current = undefined;
  };
  const commit = (next: ClipShape) => {
    const current = historyRef.current[historyIndexRef.current];
    if (current && shapesClose(current, next)) {
      return;
    }
    const truncated = historyRef.current.slice(0, historyIndexRef.current + 1);
    truncated.push(next);
    if (truncated.length > HISTORY_LIMIT) {
      truncated.shift();
    }
    historyRef.current = truncated;
    historyIndexRef.current = truncated.length - 1;
  };

  const closePresetDropdown = () => {
    setIsPresetOpen(false);
  };

  const stopCodeTransition = () => {
    if (codeTransitionTimerRef.current !== undefined) {
      window.clearTimeout(codeTransitionTimerRef.current);
      codeTransitionTimerRef.current = undefined;
    }
    setIsCodeTransitioning(false);
  };
  return { releaseActivePointerCapture, commit, closePresetDropdown, stopCodeTransition };
}

type EditorAfterDragSupportActions = EditorAfterPolygonSelectionActions &
  ReturnType<typeof dragSupportActions>;

// Ending a handle drag and a marquee drag.
function dragFinishActions(editor: EditorAfterDragSupportActions) {
  const { keyboardModifiersRef, dragTargetRef, setShape, commit, clearSnapGuides } = editor;
  const { releaseActivePointerCapture, radiusUnlockKeyPressedRef, selectedHandleRef } = editor;
  const { syncInsetModifierMode, setActiveInsetModifierMode, focusSelectedHandle } = editor;
  const { polygonSelectionDragRef, applyPolygonSelectionRect, selectHandle } = editor;
  const { setSelectionRect } = editor;
  const finishDrag = (
    focusHandle = true,
    modifiers: KeyboardModifiers = keyboardModifiersRef.current,
  ) => {
    const target = dragTargetRef.current;
    if (target) {
      setShape((current) => {
        commit(current);
        return current;
      });
    }
    dragTargetRef.current = undefined;
    clearSnapGuides();
    releaseActivePointerCapture();
    keyboardModifiersRef.current = {
      altKey: modifiers.altKey,
      shiftKey: modifiers.shiftKey,
      radiusUnlocked: radiusUnlockKeyPressedRef.current,
    };
    if (isInsetHandle(selectedHandleRef.current)) {
      syncInsetModifierMode(keyboardModifiersRef.current);
    } else {
      setActiveInsetModifierMode('single');
    }
    if (target && focusHandle) {
      focusSelectedHandle();
    }
  };

  const finishPolygonSelectionDrag = (applySelection = true) => {
    const selection = polygonSelectionDragRef.current;
    if (!selection) {
      return;
    }

    if (applySelection && selection.didMove) {
      applyPolygonSelectionRect(selection);
    } else if (applySelection && !selection.additive) {
      selectHandle(undefined);
    }

    polygonSelectionDragRef.current = undefined;
    setSelectionRect(undefined);
    clearSnapGuides();
    releaseActivePointerCapture();
  };
  return { finishDrag, finishPolygonSelectionDrag };
}

type EditorAfterDragFinishActions = EditorAfterDragSupportActions &
  ReturnType<typeof dragFinishActions>;

// Moving and resizing a whole shape by its bounding box.
function transformDragActions(editor: EditorAfterDragFinishActions) {
  const { keyboardModifiersRef, showSnapGuides, clearSnapGuides } = editor;
  const shapeFromTransformDrag = (
    drag: ShapeTransformDrag,
    point: Point,
    modifiers: KeyboardModifiers = keyboardModifiersRef.current,
  ) => {
    const containModel =
      drag.fitMode === 'contain' ? containModelFromShape(drag.before) : undefined;

    if (drag.mode === 'move') {
      const rawDx = point.x - drag.start.x;
      const rawDy = point.y - drag.start.y;
      const { dx, dy, guides } = snappedShapeMoveDelta(drag.bounds, rawDx, rawDy, { sticky: true });
      showSnapGuides(guides);
      if (containModel) {
        return shapeFromContainModel(drag.before, moveContainModel(containModel, dx, dy));
      }
      return transformShapeCanvasPoints(
        drag.before,
        drag.fitMode,
        drag.scaleOptions,
        (currentPoint) => ({ x: currentPoint.x + dx, y: currentPoint.y + dy }),
      );
    }

    if (!drag.corner) {
      return undefined;
    }
    // Resize toward the opposite corner by default (it stays pinned). Hold Option/Alt to resize
    // from the shape's center instead.
    const anchor = modifiers.altKey
      ? {
          x: drag.bounds.left + drag.bounds.width / 2,
          y: drag.bounds.top + drag.bounds.height / 2,
        }
      : shapeResizeCornerPoint(drag.bounds, oppositeShapeResizeCorner(drag.corner));
    const startHandle = shapeResizeCornerPoint(drag.bounds, drag.corner);
    const startVector = { x: startHandle.x - anchor.x, y: startHandle.y - anchor.y };
    const nextVector = { x: point.x - anchor.x, y: point.y - anchor.y };
    const startLengthSquared = startVector.x ** 2 + startVector.y ** 2;
    if (startLengthSquared <= SVG_POINT_EPSILON) {
      return undefined;
    }

    const rawScale =
      (nextVector.x * startVector.x + nextVector.y * startVector.y) / startLengthSquared;
    const scale = Math.max(0, rawScale);
    clearSnapGuides();
    if (containModel) {
      return shapeFromContainModel(drag.before, resizeContainModel(containModel, anchor, scale));
    }
    return transformShapeCanvasPoints(
      drag.before,
      drag.fitMode,
      drag.scaleOptions,
      (currentPoint) => ({
        x: anchor.x + (currentPoint.x - anchor.x) * scale,
        y: anchor.y + (currentPoint.y - anchor.y) * scale,
      }),
    );
  };
  return { shapeFromTransformDrag };
}

type EditorAfterTransformDragActions = EditorAfterDragFinishActions &
  ReturnType<typeof transformDragActions>;

// Ending a shape drag, and loading a shape read from the selection.
function selectionLoadActions(editor: EditorAfterTransformDragActions) {
  const { shapeTransformDragRef, setShape, commit, clearSnapGuides } = editor;
  const { releaseActivePointerCapture, clearPendingWrite, localWritePendingRef } = editor;
  const { shapeMatchesPastedSvgCache, clearPastedShapeSvgCache, dragTargetRef } = editor;
  const { polygonSelectionDragRef, setSelectionRect, selectHandle, codeChangedShapeRef } = editor;
  const { closePresetDropdown, stopCodeTransition, shapeRef } = editor;
  const { syncPolygonPointColorsForShape, syncPresetForShape } = editor;
  const { syncShapeFitModeForLoadedShape, setCodeValue, lastWrittenRef, historyRef } = editor;
  const { historyIndexRef } = editor;
  const finishShapeTransformDrag = (commitChange = true) => {
    const drag = shapeTransformDragRef.current;
    if (drag && commitChange) {
      setShape((current) => {
        commit(current);
        return current;
      });
    }
    shapeTransformDragRef.current = undefined;
    clearSnapGuides();
    releaseActivePointerCapture();
  };

  const loadShapeFromSelection = (next: ClipShape, lastWritten = formatClipPath(next)) => {
    clearPendingWrite();
    localWritePendingRef.current = false;
    if (!shapeMatchesPastedSvgCache(next)) {
      clearPastedShapeSvgCache();
    }
    dragTargetRef.current = undefined;
    polygonSelectionDragRef.current = undefined;
    shapeTransformDragRef.current = undefined;
    setSelectionRect(undefined);
    clearSnapGuides();
    releaseActivePointerCapture();
    selectHandle(undefined);
    codeChangedShapeRef.current = false;
    closePresetDropdown();
    stopCodeTransition();
    if (!shapesClose(shapeRef.current, next)) {
      setShape(next);
    }
    syncPolygonPointColorsForShape(next, []);
    syncPresetForShape(next);
    syncShapeFitModeForLoadedShape(next);
    setCodeValue(formatCodeValue(next));
    lastWrittenRef.current = lastWritten;
    historyRef.current = [next];
    historyIndexRef.current = 0;
  };
  return { finishShapeTransformDrag, loadShapeFromSelection };
}

type EditorAfterSelectionLoadActions = EditorAfterTransformDragActions &
  ReturnType<typeof selectionLoadActions>;

// Undo and redo.
function historyActions(editor: EditorAfterSelectionLoadActions) {
  const { historyIndexRef, markLocalShapeChange, clearPastedShapeSvgCache, historyRef } = editor;
  const { setShape, syncPolygonPointColorsForShape, syncPresetForShape } = editor;
  const undo = () => {
    if (historyIndexRef.current <= 0) {
      return;
    }
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    historyIndexRef.current -= 1;
    const previous = historyRef.current[historyIndexRef.current];
    if (!previous) {
      throw new Error('Clip path invariant failed: undo history entry is missing');
    }
    setShape(previous);
    syncPolygonPointColorsForShape(previous);
    syncPresetForShape(previous);
  };

  const redo = () => {
    if (historyIndexRef.current >= historyRef.current.length - 1) {
      return;
    }
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    historyIndexRef.current += 1;
    const next = historyRef.current[historyIndexRef.current];
    if (!next) {
      throw new Error('Clip path invariant failed: redo history entry is missing');
    }
    setShape(next);
    syncPolygonPointColorsForShape(next);
    syncPresetForShape(next);
  };
  return { undo, redo };
}

type EditorAfterHistoryActions = EditorAfterSelectionLoadActions &
  ReturnType<typeof historyActions>;

// Deleting the selected polygon points.
function pointDeleteActions(editor: EditorAfterHistoryActions) {
  const { shapeRef, getActivePolygonSelection, selectedHandleRef, polygonPointColorsRef } = editor;
  const { markLocalShapeChange, setHandleSelection, syncPolygonPointColors, setShape } = editor;
  const { commit, syncPresetForShape, focusSelectedHandle } = editor;
  const deleteSelectedPolygonPoints = () => {
    const current = shapeRef.current;
    if (current.kind !== 'polygon') {
      return false;
    }

    const selectedIndexes = Array.from(
      new Set(
        getActivePolygonSelection()
          .map((handle) => handle.index)
          .filter((index) => index >= 0 && index < current.points.length),
      ),
    ).sort((left, right) => left - right);
    if (!selectedIndexes.length || current.points.length - selectedIndexes.length < 3) {
      return false;
    }

    const indexesToDelete = new Set(selectedIndexes);
    const activeIndex =
      selectedHandleRef.current?.kind === 'polygon-point' &&
      indexesToDelete.has(selectedHandleRef.current.index)
        ? selectedHandleRef.current.index
        : selectedIndexes[0];
    if (activeIndex === undefined) {
      return false;
    }
    const previousOldIndex = previousSurvivingPolygonIndex(
      current.points.length,
      indexesToDelete,
      activeIndex,
    );
    const previousNewIndex =
      previousOldIndex === undefined
        ? undefined
        : remapPolygonIndexAfterDelete(previousOldIndex, indexesToDelete);
    const nextSelectedHandle: HandleTarget | undefined =
      previousNewIndex === undefined
        ? undefined
        : { kind: 'polygon-point', index: previousNewIndex };
    const next: ClipShape = {
      kind: 'polygon',
      points: current.points.filter((_, index) => !indexesToDelete.has(index)),
    };
    const nextColors = normalizePolygonPointColors(
      current.points.length,
      polygonPointColorsRef.current,
    ).filter((_, index) => !indexesToDelete.has(index));

    markLocalShapeChange();
    setHandleSelection(nextSelectedHandle);
    shapeRef.current = next;
    syncPolygonPointColors(nextColors);
    setShape(next);
    commit(next);
    syncPresetForShape(next);
    if (nextSelectedHandle) {
      focusSelectedHandle();
    }
    return true;
  };
  return { deleteSelectedPolygonPoints };
}

type EditorAfterPointDeleteActions = EditorAfterHistoryActions &
  ReturnType<typeof pointDeleteActions>;

// Duplicating polygon points, and opening the preset menu.
function pointDuplicateActions(editor: EditorAfterPointDeleteActions) {
  const { shapeRef, markLocalShapeChange, insertPolygonPointColor, setShape, commit } = editor;
  const { syncPresetForShape, setHandleSelection, getActivePolygonSelection } = editor;
  const { presetListRef, activePreset, setActivePresetIndex, setIsPresetOpen } = editor;
  const duplicatePolygonPoint = (
    index: number,
    options: { commitChange?: boolean; selectDuplicate?: boolean } = {},
  ) => {
    const current = shapeRef.current;
    if (current.kind !== 'polygon') {
      return undefined;
    }

    const point = current.points[index];
    if (!point) {
      return undefined;
    }

    const duplicateIndex = index + 1;
    const next: ClipShape = {
      kind: 'polygon',
      points: [
        ...current.points.slice(0, duplicateIndex),
        offsetDuplicatePoint(point),
        ...current.points.slice(duplicateIndex),
      ],
    };
    const duplicateHandle: HandleTarget = { kind: 'polygon-point', index: duplicateIndex };

    markLocalShapeChange();
    insertPolygonPointColor(duplicateIndex, current.points.length);
    shapeRef.current = next;
    setShape(next);
    if (options.commitChange ?? true) {
      commit(next);
    }
    syncPresetForShape(next);
    if (options.selectDuplicate ?? true) {
      setHandleSelection(duplicateHandle);
    }

    return { shape: next, handle: duplicateHandle };
  };

  const duplicateSelectedPolygonPoint = () => {
    const [firstSelectedPoint] = getActivePolygonSelection();
    if (!firstSelectedPoint) {
      return false;
    }
    return Boolean(duplicatePolygonPoint(firstSelectedPoint.index));
  };

  const focusPresetList = () => {
    window.requestAnimationFrame(() => presetListRef.current?.focus());
  };

  const openPresetDropdown = (index = PRESET_NAMES.indexOf(activePreset)) => {
    const nextIndex = index >= 0 ? index : 0;
    setActivePresetIndex(nextIndex);
    setIsPresetOpen(true);
    focusPresetList();
  };
  return {
    duplicatePolygonPoint,
    duplicateSelectedPolygonPoint,
    focusPresetList,
    openPresetDropdown,
  };
}

type EditorAfterPointDuplicateActions = EditorAfterPointDeleteActions &
  ReturnType<typeof pointDuplicateActions>;

// Choosing a preset shape.
function presetChoiceActions(editor: EditorAfterPointDuplicateActions) {
  const { markLocalShapeChange, clearPastedShapeSvgCache, selectHandle, clearSnapGuides } = editor;
  const { setCircleRadiusAngle, shapeScaleUseVariableRef, shapeScaleVariableNameRef } = editor;
  const { shapeOffsetLeftVariableNameRef, shapeOffsetTopVariableNameRef } = editor;
  const { setShapeScaleUseVariable, setShapeScaleVariableName } = editor;
  const { setShapeOffsetLeftVariableName, setShapeOffsetTopVariableName } = editor;
  const { pastedShapeSvgCacheRef, shapeFitModeRef, setShapeFitMode, setActivePreset } = editor;
  const { shapeRef, setCodeValue, setShape, syncPolygonPointColorsForShape, commit } = editor;
  const { setIsPresetOpen, presetButtonRef } = editor;
  const choosePreset = (name: string) => {
    const preset = PRESETS[name];
    if (!preset) {
      return;
    }
    let nextPreset = preset;
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    selectHandle(undefined);
    clearSnapGuides();
    if (preset.kind === 'circle') {
      setCircleRadiusAngle(0);
    }
    if (preset.kind === 'shape') {
      shapeScaleUseVariableRef.current = false;
      shapeScaleVariableNameRef.current = DEFAULT_SHAPE_SCALE_VARIABLE_NAME;
      shapeOffsetLeftVariableNameRef.current = DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME;
      shapeOffsetTopVariableNameRef.current = DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME;
      setShapeScaleUseVariable(false);
      setShapeScaleVariableName(DEFAULT_SHAPE_SCALE_VARIABLE_NAME);
      setShapeOffsetLeftVariableName(DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME);
      setShapeOffsetTopVariableName(DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME);
      const cache = cacheFromShapeFitVariants(preset, DEFAULT_SHAPE_SCALE_OPTIONS);
      if (cache) {
        pastedShapeSvgCacheRef.current = cache;
        nextPreset = cache.contain;
      }
      shapeFitModeRef.current = 'contain';
      setShapeFitMode('contain');
    }
    setActivePreset(name);
    shapeRef.current = nextPreset;
    setCodeValue(formatCodeValue(nextPreset));
    setShape(nextPreset);
    syncPolygonPointColorsForShape(nextPreset, []);
    commit(nextPreset);
    setIsPresetOpen(false);
    window.requestAnimationFrame(() => presetButtonRef.current?.focus());
  };
  return { choosePreset };
}

type EditorAfterPresetChoiceActions = EditorAfterPointDuplicateActions &
  ReturnType<typeof presetChoiceActions>;

// Resetting the breakpoint's clip-path, class selection, and the source label.
function breakpointActions(editor: EditorAfterPresetChoiceActions) {
  const { onClearRef, setIsClipPathLabelMenuOpen, clearPendingWrite } = editor;
  const { localWritePendingRef, lastWrittenRef, setClipPathStyleOrigin, styleRef } = editor;
  const { cancelPendingSelectionRead, activeBreakpointRef, refreshSelectedElementRef } = editor;
  const { selectedClassNamesRef, selectionIsDefaultRef, setSelectedClassNames } = editor;
  const { closePresetDropdown, clipPathStyleOrigin } = editor;
  const resetCurrentBreakpointClipPath = async () => {
    // Embedded mode: the parent owns the write target, so clear through it.
    if (onClearRef.current) {
      setIsClipPathLabelMenuOpen(false);
      clearPendingWrite();
      localWritePendingRef.current = false;
      onClearRef.current();
      lastWrittenRef.current = undefined;
      setClipPathStyleOrigin('none');
      return;
    }
    const style = styleRef.current;
    if (!style) {
      return;
    }

    setIsClipPathLabelMenuOpen(false);
    clearPendingWrite();
    localWritePendingRef.current = false;
    cancelPendingSelectionRead();

    const styleOptions = styleOptionsForBreakpoint(activeBreakpointRef.current);
    try {
      await style.removeProperty?.('clip-path', styleOptions);
      await writePastedShapeMetadata(style, undefined, styleOptions);
      lastWrittenRef.current = undefined;
      setClipPathStyleOrigin('none');
      refreshSelectedElementRef.current?.({ force: true, resetStyle: true });
    } catch {
      refreshSelectedElementRef.current?.({ force: true, resetStyle: true });
    }
  };

  // Toggle/order logic now lives in the shared ClassPicker; this just applies the
  // resulting selection and re-reads the style for the new selector.
  const handleClassSelectionChange = (next: string[]) => {
    selectedClassNamesRef.current = next;
    selectionIsDefaultRef.current = false;
    setSelectedClassNames(next);
    setIsClipPathLabelMenuOpen(false);
    closePresetDropdown();
    refreshSelectedElementRef.current?.({ force: true, resetStyle: true });
  };

  const onClipPathLabelClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    // Current → reset menu (Option-click resets immediately). Inherited → a
    // read-only "Value comes from:" popover. None → nothing.
    if (clipPathStyleOrigin === 'none') {
      return;
    }

    if (clipPathStyleOrigin === 'current' && event.altKey) {
      void resetCurrentBreakpointClipPath();
      return;
    }

    setIsClipPathLabelMenuOpen((isOpen) => !isOpen);
  };
  return { resetCurrentBreakpointClipPath, handleClassSelectionChange, onClipPathLabelClick };
}

type EditorAfterBreakpointActions = EditorAfterPresetChoiceActions &
  ReturnType<typeof breakpointActions>;

// Editing the shape as code.
function codeEditActions(editor: EditorAfterBreakpointActions) {
  const { codeTransitionTimerRef, setIsCodeTransitioning, setCodeValue, shape } = editor;
  const { markLocalShapeChange, clearPastedShapeSvgCache, selectHandle } = editor;
  const { codeChangedShapeRef, setShape, syncPolygonPointColorsForShape, commit } = editor;
  const { syncPresetForShape, setCircleRadiusAngle, syncShapeFitModeForLoadedShape } = editor;
  const startCodeTransition = () => {
    if (codeTransitionTimerRef.current !== undefined) {
      window.clearTimeout(codeTransitionTimerRef.current);
    }
    setIsCodeTransitioning(true);
    codeTransitionTimerRef.current = window.setTimeout(() => {
      setIsCodeTransitioning(false);
      codeTransitionTimerRef.current = undefined;
    }, 420);
  };

  const onCodeChange = (nextValue: string) => {
    setCodeValue(nextValue);
    if (!nextValue.trim()) {
      if (shape.kind === 'none') {
        return;
      }

      markLocalShapeChange();
      clearPastedShapeSvgCache();
      selectHandle(undefined);
      codeChangedShapeRef.current = true;
      startCodeTransition();
      setShape(NONE_SHAPE);
      syncPolygonPointColorsForShape(NONE_SHAPE);
      commit(NONE_SHAPE);
      syncPresetForShape(NONE_SHAPE);
      return;
    }

    const parsed = parseClipPathInput(nextValue);
    if (!parsed) {
      return;
    }

    if (shapesClose(shape, parsed)) {
      return;
    }
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    selectHandle(undefined);
    codeChangedShapeRef.current = true;
    startCodeTransition();
    if (parsed.kind === 'none') {
      setCodeValue('');
    }
    if (parsed.kind === 'circle' && shape.kind !== 'circle') {
      setCircleRadiusAngle(0);
    }
    syncShapeFitModeForLoadedShape(parsed);
    setShape(parsed);
    syncPolygonPointColorsForShape(parsed);
    commit(parsed);
    syncPresetForShape(parsed);
  };
  return { startCodeTransition, onCodeChange };
}

type EditorAfterCodeEditActions = EditorAfterBreakpointActions & ReturnType<typeof codeEditActions>;

// Selecting in the code, and applying a pasted SVG.
function codeSelectionActions(editor: EditorAfterCodeEditActions) {
  const { dragTargetRef, codeTokenHighlights, selectHandle, setHandleSelection } = editor;
  const { pastedShapeSvgCacheRef, currentShapeScaleOptions } = editor;
  const { syncShapeFitModeForLoadedShape, shapeRef, markLocalShapeChange } = editor;
  const { codeChangedShapeRef, startCodeTransition, syncPolygonPointColorsForShape } = editor;
  const { setCodeValue, setShape, commit, syncPresetForShape } = editor;
  const onCodeSelectionChange = (position: number) => {
    if (dragTargetRef.current) {
      return;
    }
    const activeElement = document.activeElement;
    if (!(activeElement instanceof Element) || !activeElement.closest('.code-editor')) {
      return;
    }

    const match = codeTokenHighlights.find(
      (highlight) => position >= highlight.from && position <= highlight.to,
    );
    if (!match) {
      selectHandle(undefined);
      return;
    }

    const [primaryHandle] = match.handles;
    setHandleSelection(primaryHandle || undefined, match.handles);
  };

  const applyPastedSvgClipPath = (
    next: ClipShape,
    // `cacheUpdate` replaces the pasted-SVG cache — with nothing, when its `cache` is
    // absent — and leaving it out keeps the cache as it is.
    options: {
      cacheUpdate?: { cache: PastedShapeSvgCache | undefined };
      shapeFitMode?: ShapeFitMode;
    } = {},
  ) => {
    if (options.cacheUpdate !== undefined) {
      pastedShapeSvgCacheRef.current = normalizeShapeFitCache(
        options.cacheUpdate.cache,
        currentShapeScaleOptions(),
      );
    }
    syncShapeFitModeForLoadedShape(next, options.shapeFitMode);

    const current = shapeRef.current;
    if (shapesClose(current, next)) {
      return;
    }

    markLocalShapeChange();
    selectHandle(undefined);
    codeChangedShapeRef.current = false;
    startCodeTransition();
    shapeRef.current = next;
    syncPolygonPointColorsForShape(next, []);
    setCodeValue(formatCodeValue(next));
    setShape(next);
    commit(next);
    syncPresetForShape(next);
  };
  return { onCodeSelectionChange, applyPastedSvgClipPath };
}

type EditorAfterCodeSelectionActions = EditorAfterCodeEditActions &
  ReturnType<typeof codeSelectionActions>;

// Reading a pasted SVG, and switching how a shape fits.
function shapeFitActions(editor: EditorAfterCodeSelectionActions) {
  const { cacheFromPastedShapeSvgSource, shapeFitModeRef, shapeRef } = editor;
  const { currentShapeScaleOptions, matchingPastedSvgCacheForShape, setShapeFitMode } = editor;
  const { pastedShapeSvgCacheRef, applyPastedSvgClipPath } = editor;
  const parseClipboardSvgShape = (text: string, html: string, fitMode: ShapeFitMode) => {
    const textCache = cacheFromPastedShapeSvgSource(text);
    if (textCache) {
      return { shape: shapeFromPastedSvgCache(textCache, fitMode), cache: textCache };
    }

    const htmlCache = cacheFromPastedShapeSvgSource(html);
    return htmlCache
      ? { shape: shapeFromPastedSvgCache(htmlCache, fitMode), cache: htmlCache }
      : undefined;
  };

  const setShapeFitModeFromControl = (nextMode: ShapeFitMode) => {
    if (nextMode === shapeFitModeRef.current) {
      return;
    }
    const currentShape = shapeRef.current;
    if (currentShape.kind !== 'shape') {
      return;
    }

    const shapeScaleOptions = currentShapeScaleOptions();
    const cache =
      matchingPastedSvgCacheForShape(currentShape) ||
      cacheFromShapeFitVariants(currentShape, shapeScaleOptions);
    const nextShape = cache
      ? shapeFromPastedSvgCache(cache, nextMode)
      : convertShapeFitMode(currentShape, nextMode, shapeScaleOptions);
    if (!nextShape) {
      return;
    }

    setShapeFitMode(nextMode);
    shapeFitModeRef.current = nextMode;

    if (cache) {
      pastedShapeSvgCacheRef.current = cache;
    }
    applyPastedSvgClipPath(nextShape, { cacheUpdate: { cache }, shapeFitMode: nextMode });
  };
  return { parseClipboardSvgShape, setShapeFitModeFromControl };
}

type EditorAfterShapeFitActions = EditorAfterCodeSelectionActions &
  ReturnType<typeof shapeFitActions>;

// The shape-scale variables, and moving through the presets.
function shapeScaleActions(editor: EditorAfterShapeFitActions) {
  const { shapeRef, currentShapeScaleOptions, shapeOffsetLeftVariableNameRef } = editor;
  const { shapeOffsetTopVariableNameRef, shapeScaleUseVariableRef } = editor;
  const { shapeScaleVariableNameRef, setShapeScaleUseVariable, setShapeScaleVariableName } = editor;
  const { setShapeOffsetLeftVariableName, setShapeOffsetTopVariableName } = editor;
  const { matchingPastedSvgCacheForShape, pastedShapeSvgCacheRef, shapeFitModeRef } = editor;
  const { applyPastedSvgClipPath, setActivePresetIndex } = editor;
  const setShapeScaleOptionsFromControl = (nextOptions: ShapeScaleOptions) => {
    const currentShape = shapeRef.current;
    const previousOptions = currentShapeScaleOptions();
    // The contain encoding always uses variables now; sanitize for emit, but keep the raw typed
    // strings in state so the inputs stay editable. Empty fields fall back to the defaults.
    const rawSize = nextOptions.variableName;
    const rawLeft = nextOptions.offsetLeftVariableName ?? shapeOffsetLeftVariableNameRef.current;
    const rawTop = nextOptions.offsetTopVariableName ?? shapeOffsetTopVariableNameRef.current;
    const normalizedOptions: ShapeScaleOptions = {
      useVariable: true,
      variableName: sanitizeShapeScaleVariableName(rawSize) || DEFAULT_SHAPE_SCALE_VARIABLE_NAME,
      offsetLeftVariableName:
        sanitizeShapeScaleVariableName(rawLeft) || DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
      offsetTopVariableName:
        sanitizeShapeScaleVariableName(rawTop) || DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
    };

    shapeScaleUseVariableRef.current = true;
    shapeScaleVariableNameRef.current = rawSize;
    shapeOffsetLeftVariableNameRef.current = rawLeft;
    shapeOffsetTopVariableNameRef.current = rawTop;
    setShapeScaleUseVariable(true);
    setShapeScaleVariableName(rawSize);
    setShapeOffsetLeftVariableName(rawLeft);
    setShapeOffsetTopVariableName(rawTop);

    if (currentShape.kind !== 'shape') {
      return;
    }

    const currentCache =
      matchingPastedSvgCacheForShape(currentShape, previousOptions) ||
      cacheFromShapeFitVariants(currentShape, previousOptions);
    const nextCache = currentCache
      ? normalizeShapeFitCache(currentCache, normalizedOptions)
      : undefined;
    if (nextCache) {
      pastedShapeSvgCacheRef.current = nextCache;
    }

    if (shapeFitModeRef.current !== 'contain') {
      return;
    }

    const nextShape =
      nextCache?.contain || normalizeContainShapeCoordinates(currentShape, normalizedOptions);
    applyPastedSvgClipPath(nextShape, {
      cacheUpdate: { cache: nextCache },
      shapeFitMode: 'contain',
    });
  };

  const moveActivePreset = (nextIndex: number) => {
    const wrappedIndex = (nextIndex + PRESET_NAMES.length) % PRESET_NAMES.length;
    setActivePresetIndex(wrappedIndex);
  };
  return { setShapeScaleOptionsFromControl, moveActivePreset };
}

type EditorAfterShapeScaleActions = EditorAfterShapeFitActions &
  ReturnType<typeof shapeScaleActions>;

// The alignment guide a handle snaps to.
function guideActions(editor: EditorAfterShapeScaleActions) {
  const { circleRadiusAngleRef, canvasRef } = editor;
  const guidePointForHandle = (
    targetShape: ClipShape,
    handle: HandleTarget,
    circleAngle = circleRadiusAngleRef.current,
  ): Point | undefined => {
    if (targetShape.kind === 'raw' && targetShape.editable && canvasRef.current) {
      return rawEditableHandlePoint(targetShape.editable, handle, canvasRef.current);
    }

    if (handle.kind === 'polygon-point' && targetShape.kind === 'polygon') {
      return targetShape.points[handle.index] || undefined;
    }

    if (handle.kind === 'circle-center' && targetShape.kind === 'circle') {
      return { x: targetShape.cx, y: targetShape.cy };
    }

    if (handle.kind === 'circle-radius' && targetShape.kind === 'circle') {
      return {
        x: targetShape.cx + Math.cos(circleAngle) * targetShape.radius,
        y: targetShape.cy + Math.sin(circleAngle) * targetShape.radius,
      };
    }

    if (handle.kind === 'ellipse-center' && targetShape.kind === 'ellipse') {
      return { x: targetShape.cx, y: targetShape.cy };
    }

    if (handle.kind === 'ellipse-rx' && targetShape.kind === 'ellipse') {
      return { x: targetShape.cx + targetShape.rx, y: targetShape.cy };
    }

    if (handle.kind === 'ellipse-ry' && targetShape.kind === 'ellipse') {
      return { x: targetShape.cx, y: targetShape.cy + targetShape.ry };
    }

    if (targetShape.kind !== 'inset') {
      return undefined;
    }

    const { x0, y0, x1, y1, width, height } = insetBox(targetShape);
    if (handle.kind === 'inset-top') {
      return { x: x0 + width / 2, y: targetShape.top };
    }
    if (handle.kind === 'inset-right') {
      return { x: 100 - targetShape.right, y: y0 + height / 2 };
    }
    if (handle.kind === 'inset-bottom') {
      return { x: x0 + width / 2, y: 100 - targetShape.bottom };
    }
    if (handle.kind === 'inset-left') {
      return { x: targetShape.left, y: y0 + height / 2 };
    }

    if (handle.kind === 'inset-radius') {
      const radius = targetShape.radii[handle.corner];
      const canvasRadius = insetRadiusToCanvas(targetShape, radius);
      if (handle.corner === 'topLeft') {
        return { x: targetShape.left + canvasRadius.x, y: targetShape.top + canvasRadius.y };
      }
      if (handle.corner === 'topRight') {
        return { x: x1 - canvasRadius.x, y: targetShape.top + canvasRadius.y };
      }
      if (handle.corner === 'bottomRight') {
        return { x: x1 - canvasRadius.x, y: y1 - canvasRadius.y };
      }
      return { x: targetShape.left + canvasRadius.x, y: y1 - canvasRadius.y };
    }

    return undefined;
  };
  return { guidePointForHandle };
}

type EditorAfterGuideActions = EditorAfterShapeScaleActions & ReturnType<typeof guideActions>;

// Where a drag puts its handle, and the guides a keyboard move shows.
function dragPointActions(editor: EditorAfterGuideActions) {
  const { guidePointForHandle, circleRadiusAngleRef } = editor;
  const targetWithDragOrigin = (target: DragTarget, pointer: Point): DragTarget => {
    const handlePoint = guidePointForHandle(target.before, handleFromDragTarget(target));
    return handlePoint ? { ...target, dragOrigin: { pointer, handle: handlePoint } } : target;
  };

  const dragPointForTarget = (target: DragTarget, rawPoint: Point) => {
    const origin = target.dragOrigin;
    if (!origin) {
      return rawPoint;
    }

    return {
      x: origin.handle.x + rawPoint.x - origin.pointer.x,
      y: origin.handle.y + rawPoint.y - origin.pointer.y,
    };
  };

  const keyboardGuidesForHandles = (
    targetShape: ClipShape,
    handles: HandleTarget[],
    circleAngle = circleRadiusAngleRef.current,
  ) => {
    const guides = handles.map((handle) => {
      const point = guidePointForHandle(targetShape, handle, circleAngle);
      if (!point) {
        return emptySnapGuides();
      }

      if (targetShape.kind === 'inset' && handle.kind === 'inset-radius') {
        const { x0, y0, x1, y1, width, height } = insetBox(targetShape);
        return pointAlignmentGuides(
          point,
          [0, x0, x0 + width / 2, 50, x1, 100],
          [0, y0, y0 + height / 2, 50, y1, 100],
        );
      }

      return pointAlignmentGuides(point, [0, 50, 100], [0, 50, 100]);
    });

    return mergeSnapGuides(...guides);
  };
  return { targetWithDragOrigin, dragPointForTarget, keyboardGuidesForHandles };
}

type EditorAfterDragPointActions = EditorAfterGuideActions & ReturnType<typeof dragPointActions>;

// Typing a preset's name to jump to it.
function presetTypeaheadActions(editor: EditorAfterDragPointActions) {
  const { presetTypeaheadTimerRef, presetTypeaheadRef, activePresetIndex } = editor;
  const { setActivePresetIndex } = editor;
  const handlePresetTypeahead = (key: string) => {
    if (key.length !== 1) {
      return false;
    }

    if (presetTypeaheadTimerRef.current !== undefined) {
      window.clearTimeout(presetTypeaheadTimerRef.current);
    }

    const query = `${presetTypeaheadRef.current}${key}`.toLowerCase();
    presetTypeaheadRef.current = query;
    presetTypeaheadTimerRef.current = window.setTimeout(() => {
      presetTypeaheadRef.current = '';
      presetTypeaheadTimerRef.current = undefined;
    }, 700);

    const startIndex = (activePresetIndex + 1) % PRESET_NAMES.length;
    const orderedNames = [...PRESET_NAMES.slice(startIndex), ...PRESET_NAMES.slice(0, startIndex)];
    const match = orderedNames.find((name) => name.toLowerCase().startsWith(query));
    if (!match) {
      return true;
    }

    setActivePresetIndex(PRESET_NAMES.indexOf(match));
    return true;
  };
  return { handlePresetTypeahead };
}

type EditorAfterPresetTypeaheadActions = EditorAfterDragPointActions &
  ReturnType<typeof presetTypeaheadActions>;

// The preset button's keys.
function presetButtonActions(editor: EditorAfterPresetTypeaheadActions) {
  const { openPresetDropdown, handlePresetTypeahead, setIsPresetOpen, focusPresetList } = editor;
  const onPresetButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openPresetDropdown();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      openPresetDropdown(PRESET_NAMES.length - 1);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPresetDropdown();
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      openPresetDropdown(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      openPresetDropdown(PRESET_NAMES.length - 1);
      return;
    }

    if (handlePresetTypeahead(event.key)) {
      event.preventDefault();
      setIsPresetOpen(true);
      focusPresetList();
    }
  };
  return { onPresetButtonKeyDown };
}

type EditorAfterPresetButtonActions = EditorAfterPresetTypeaheadActions &
  ReturnType<typeof presetButtonActions>;

// The preset list's keys.
function presetListActions(editor: EditorAfterPresetButtonActions) {
  const { moveActivePreset, activePresetIndex, setActivePresetIndex, choosePreset } = editor;
  const { closePresetDropdown, presetButtonRef, handlePresetTypeahead } = editor;
  const onPresetListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActivePreset(activePresetIndex + 1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActivePreset(activePresetIndex - 1);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setActivePresetIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setActivePresetIndex(PRESET_NAMES.length - 1);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const presetName = PRESET_NAMES[activePresetIndex];
      if (presetName) {
        choosePreset(presetName);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closePresetDropdown();
      presetButtonRef.current?.focus();
      return;
    }

    if (event.key === 'Tab') {
      closePresetDropdown();
      return;
    }

    if (handlePresetTypeahead(event.key)) {
      event.preventDefault();
    }
  };
  return { onPresetListKeyDown };
}

type EditorAfterPresetListActions = EditorAfterPresetButtonActions &
  ReturnType<typeof presetListActions>;

// Moving a handle with the keyboard.
function handleKeyboardActions(editor: EditorAfterPresetListActions) {
  const { shapeRef, latestCssRef, syncInsetModifierMode, radiusUnlockKeyPressedRef } = editor;
  const { getPolygonSelectionIndexes, canvasRef, circleRadiusAngleRef } = editor;
  const { spaceKeyPressedRef, markLocalShapeChange, cancelPendingSelectionRead } = editor;
  const { setCircleRadiusAngle, setShape, commit, syncPresetForShape, showSnapGuides } = editor;
  const { keyboardGuidesForHandles } = editor;
  const moveHandleWithKeyboard = (
    handle: HandleTarget,
    key: string,
    modifiers: KeyboardModifiers,
  ) => {
    if (!isArrowKey(key)) {
      return false;
    }

    const currentShape = shapeRef.current;
    const currentCss = latestCssRef.current;
    const insetModifierMode = syncInsetModifierMode(modifiers);
    const insetRadiusMode: InsetRadiusMode = insetModifierMode;
    const insetSideMode: InsetSideMode = insetModifierMode;
    const insetRadiusUnlocked = modifiers.radiusUnlocked ?? radiusUnlockKeyPressedRef.current;
    const polygonPointIndexes = getPolygonSelectionIndexes(handle);
    const result = updateShapeForKeyboard(currentShape, handle, key, {
      canvas: canvasRef.current ?? undefined,
      circleRadiusAngle: circleRadiusAngleRef.current,
      insetRadiusMode,
      insetRadiusUnlocked,
      insetSideMode,
      ellipseScaleProportional: modifiers.shiftKey,
      polygonPointIndexes,
      step: spaceKeyPressedRef.current ? KEYBOARD_FAST_STEP : KEYBOARD_STEP,
    });
    const shapeChanged = !shapesEqual(currentShape, result.shape);
    const angleChanged =
      typeof result.circleRadiusAngle === 'number' &&
      Math.abs(result.circleRadiusAngle - circleRadiusAngleRef.current) > 0.0001;

    if (!shapeChanged && !angleChanged) {
      return false;
    }

    if (formatClipPath(result.shape) !== currentCss) {
      markLocalShapeChange();
    } else {
      cancelPendingSelectionRead();
    }
    if (typeof result.circleRadiusAngle === 'number') {
      circleRadiusAngleRef.current = result.circleRadiusAngle;
      setCircleRadiusAngle(result.circleRadiusAngle);
    }
    if (shapeChanged) {
      shapeRef.current = result.shape;
      setShape(result.shape);
      commit(result.shape);
      syncPresetForShape(result.shape);
    }
    const nextCircleAngle = result.circleRadiusAngle ?? circleRadiusAngleRef.current;
    const guideHandles =
      isPolygonPointHandle(handle) && polygonPointIndexes.length
        ? polygonPointIndexes.map((index) => ({ kind: 'polygon-point' as const, index }))
        : [handle];
    showSnapGuides(keyboardGuidesForHandles(result.shape, guideHandles, nextCircleAngle));
    return true;
  };
  return { moveHandleWithKeyboard };
}

type EditorAfterHandleKeyboardActions = EditorAfterPresetListActions &
  ReturnType<typeof handleKeyboardActions>;

// Moving the whole shape with the keyboard.
function shapeKeyboardActions(editor: EditorAfterHandleKeyboardActions) {
  const { shapeRef, spaceKeyPressedRef, shapeFitModeRef, currentShapeScaleOptions } = editor;
  const { showSnapGuides, markLocalShapeChange, clearPastedShapeSvgCache, setShape } = editor;
  const { commit, setActivePreset } = editor;
  const moveShapeWithKeyboard = (key: ArrowKey) => {
    const currentShape = shapeRef.current;
    if (currentShape.kind !== 'shape') {
      return false;
    }

    const bounds = shapeCssBounds(currentShape);
    if (!bounds) {
      return false;
    }

    const delta = arrowDelta(key, spaceKeyPressedRef.current ? KEYBOARD_FAST_STEP : KEYBOARD_STEP);
    if (!delta) {
      return false;
    }

    const fitMode: ShapeFitMode =
      shapeFitModeRef.current === 'contain' || hasContainerQueryUnit(currentShape.value)
        ? 'contain'
        : 'stretch';
    const containModel = fitMode === 'contain' ? containModelFromShape(currentShape) : undefined;
    const next = containModel
      ? shapeFromContainModel(currentShape, moveContainModel(containModel, delta.x, delta.y))
      : transformShapeCanvasPoints(currentShape, fitMode, currentShapeScaleOptions(), (point) => ({
          x: point.x + delta.x,
          y: point.y + delta.y,
        }));
    if (!next || shapesEqual(currentShape, next)) {
      return false;
    }

    const nextBounds = shapeCssBounds(next);
    showSnapGuides(nextBounds ? shapeSnapGuidesForBounds(nextBounds) : emptySnapGuides());
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    shapeRef.current = next;
    setShape(next);
    commit(next);
    setActivePreset('Shape');
    return true;
  };
  return { moveShapeWithKeyboard };
}

type EditorAfterShapeKeyboardActions = EditorAfterHandleKeyboardActions &
  ReturnType<typeof shapeKeyboardActions>;

// The repeating keyboard move and the modifier refs it reads.
function keyboardLoopActions(editor: EditorAfterShapeKeyboardActions) {
  const { selectedHandleRef, isShapeTransformSelectedRef, isPresetOpenRef } = editor;
  const { stopKeyboardMoveLoop, pressedArrowKeysRef, moveHandleWithKeyboard } = editor;
  const { keyboardModifiersRef, moveShapeWithKeyboard, keyboardMoveDelayTimerRef } = editor;
  const { keyboardMoveTimerRef, radiusUnlockKeyPressedRef, syncInsetModifierMode } = editor;
  const runKeyboardMoveTick = () => {
    const handle = selectedHandleRef.current;
    const shapeSelected = isShapeTransformSelectedRef.current;
    if ((!handle && !shapeSelected) || isPresetOpenRef.current) {
      stopKeyboardMoveLoop();
      return;
    }

    const keys = ARROW_KEYS.filter((key) => pressedArrowKeysRef.current.has(key));
    if (!keys.length) {
      stopKeyboardMoveLoop(false);
      return;
    }

    keys.forEach((key) => {
      if (handle) {
        moveHandleWithKeyboard(handle, key, keyboardModifiersRef.current);
      } else if (shapeSelected) {
        moveShapeWithKeyboard(key);
      }
    });
  };

  const startKeyboardMoveLoop = () => {
    if (
      keyboardMoveDelayTimerRef.current !== undefined ||
      keyboardMoveTimerRef.current !== undefined
    ) {
      return;
    }
    keyboardMoveDelayTimerRef.current = window.setTimeout(() => {
      keyboardMoveDelayTimerRef.current = undefined;
      runKeyboardMoveTick();
      keyboardMoveTimerRef.current = window.setInterval(runKeyboardMoveTick, KEYBOARD_REPEAT_MS);
    }, KEYBOARD_REPEAT_DELAY_MS);
  };

  const updateKeyboardModifierRefs = (modifiers: KeyboardModifiers) => {
    keyboardModifiersRef.current = {
      altKey: modifiers.altKey,
      shiftKey: modifiers.shiftKey,
      radiusUnlocked: modifiers.radiusUnlocked ?? radiusUnlockKeyPressedRef.current,
    };
    if (isInsetHandle(selectedHandleRef.current)) {
      syncInsetModifierMode(keyboardModifiersRef.current);
    }
  };
  return { runKeyboardMoveTick, startKeyboardMoveLoop, updateKeyboardModifierRefs };
}

type EditorAfterKeyboardLoopActions = EditorAfterShapeKeyboardActions &
  ReturnType<typeof keyboardLoopActions>;

// Pressing and releasing move keys, and following a shape drag.
function keyboardKeyActions(editor: EditorAfterKeyboardLoopActions) {
  const { updateKeyboardModifierRefs, selectHandleForKeyboard, pressedArrowKeysRef } = editor;
  const { moveHandleWithKeyboard, keyboardModifiersRef, startKeyboardMoveLoop } = editor;
  const { setShapeTransformSelection, moveShapeWithKeyboard, stopKeyboardMoveLoop } = editor;
  const { shapeTransformDragRef, canvasPointFromClient, shapeFromTransformDrag, shapeRef } = editor;
  const { markLocalShapeChange, setShape, setActivePreset } = editor;
  const pressKeyboardMoveKey = (
    handle: HandleTarget,
    key: ArrowKey,
    modifiers: KeyboardModifiers,
  ) => {
    updateKeyboardModifierRefs(modifiers);
    selectHandleForKeyboard(handle);
    const wasPressed = pressedArrowKeysRef.current.has(key);
    pressedArrowKeysRef.current.add(key);
    if (!wasPressed) {
      moveHandleWithKeyboard(handle, key, keyboardModifiersRef.current);
    }
    startKeyboardMoveLoop();
  };

  const pressShapeMoveKey = (key: ArrowKey, modifiers: KeyboardModifiers) => {
    updateKeyboardModifierRefs(modifiers);
    setShapeTransformSelection(true);
    const wasPressed = pressedArrowKeysRef.current.has(key);
    pressedArrowKeysRef.current.add(key);
    if (!wasPressed) {
      moveShapeWithKeyboard(key);
    }
    startKeyboardMoveLoop();
  };

  const releaseKeyboardMoveKey = (key: ArrowKey, modifiers: KeyboardModifiers) => {
    updateKeyboardModifierRefs(modifiers);
    pressedArrowKeysRef.current.delete(key);
    if (!pressedArrowKeysRef.current.size) {
      stopKeyboardMoveLoop(false);
    }
  };

  const updateShapeTransformDrag = (event: PointerEvent) => {
    const drag = shapeTransformDragRef.current;
    if (!drag) {
      return false;
    }
    if (event.pointerId !== drag.pointerId) {
      return true;
    }

    const point = canvasPointFromClient(event.clientX, event.clientY);
    if (!point) {
      return true;
    }

    updateKeyboardModifierRefs(event);
    const next = shapeFromTransformDrag(drag, point, keyboardModifiersRef.current);
    if (!next || shapesEqual(shapeRef.current, next)) {
      return true;
    }

    markLocalShapeChange();
    shapeRef.current = next;
    setShape(next);
    setActivePreset('Shape');
    return true;
  };
  return {
    pressKeyboardMoveKey,
    pressShapeMoveKey,
    releaseKeyboardMoveKey,
    updateShapeTransformDrag,
  };
}

type EditorAfterKeyboardKeyActions = EditorAfterKeyboardLoopActions &
  ReturnType<typeof keyboardKeyActions>;

// Following a marquee drag.
function marqueeMoveActions(editor: EditorAfterKeyboardKeyActions) {
  const { polygonSelectionDragRef, canvasPointFromClient, setSelectionRect } = editor;
  const { applyPolygonSelectionRect } = editor;
  const updatePolygonSelectionDrag = (event: PointerEvent) => {
    const selection = polygonSelectionDragRef.current;
    if (!selection) {
      return false;
    }
    if (event.pointerId !== selection.pointerId) {
      return true;
    }

    const point = canvasPointFromClient(event.clientX, event.clientY);
    if (!point) {
      return true;
    }

    selection.current = point;
    const dx = event.clientX - selection.startClient.x;
    const dy = event.clientY - selection.startClient.y;
    if (!selection.didMove && Math.hypot(dx, dy) >= SELECTION_DRAG_THRESHOLD_PX) {
      selection.didMove = true;
    }

    if (selection.didMove) {
      const rect = rectFromPoints(selection.start, selection.current);
      setSelectionRect(rect);
      applyPolygonSelectionRect(selection);
    }

    return true;
  };
  return { updatePolygonSelectionDrag };
}

type EditorAfterMarqueeMoveActions = EditorAfterKeyboardKeyActions &
  ReturnType<typeof marqueeMoveActions>;

// Duplicating a polygon point by Option-dragging it.
function pointDuplicateDragActions(editor: EditorAfterMarqueeMoveActions) {
  const { shapeRef, insertPolygonPointColor, setHandleSelection, setShape, dragTargetRef } = editor;
  // Option-dragging a polygon point leaves a copy behind: the first move with
  // Option held inserts the duplicate, and the drag carries on with that. Returns
  // the new drag target, or undefined when the point is gone.
  const duplicateDraggedPolygonPoint = (
    index: number,
    beforeShape: PolygonShape,
    rawPoint: Point,
  ): DragTarget | undefined => {
    const originalPoint = beforeShape.points[index];
    if (!originalPoint) {
      return undefined;
    }
    const currentShape = shapeRef.current;
    const draggedPoint =
      currentShape.kind === 'polygon' ? currentShape.points[index] || originalPoint : originalPoint;
    const duplicatePoint = pointsNearlyEqual(draggedPoint, originalPoint)
      ? offsetDuplicatePoint(originalPoint)
      : draggedPoint;
    const duplicateIndex = index + 1;
    const duplicateShape: PolygonShape = {
      kind: 'polygon',
      points: [
        ...beforeShape.points.slice(0, duplicateIndex),
        duplicatePoint,
        ...beforeShape.points.slice(duplicateIndex),
      ],
    };
    const duplicateHandle: HandleTarget = { kind: 'polygon-point', index: duplicateIndex };
    insertPolygonPointColor(duplicateIndex, beforeShape.points.length);
    setHandleSelection(duplicateHandle);
    shapeRef.current = duplicateShape;
    setShape(duplicateShape);
    const target: DragTarget = {
      ...duplicateHandle,
      before: duplicateShape,
      polygonPointIndexes: [duplicateIndex],
      optionDuplicated: true,
      dragOrigin: { pointer: rawPoint, handle: duplicatePoint },
    };
    dragTargetRef.current = target;
    return target;
  };
  return { duplicateDraggedPolygonPoint };
}

type EditorAfterPointDuplicateDragActions = EditorAfterMarqueeMoveActions &
  ReturnType<typeof pointDuplicateDragActions>;

// Following a handle drag.
function handleDragActions(editor: EditorAfterPointDuplicateDragActions) {
  const { dragPointForTarget, shapeRef, circleRadiusAngleRef, setCircleRadiusAngle } = editor;
  const { syncInsetModifierMode, radiusUnlockKeyPressedRef, setShape, showSnapGuides } = editor;
  const { canvasRef, markLocalShapeChange, setActivePreset } = editor;
  // Moves the dragged handle to the pointer (snapped), writing the shape live.
  const dragShapeTo = (target: DragTarget, rawPoint: Point, event: PointerEvent) => {
    const dragPoint = dragPointForTarget(target, rawPoint);
    const snapResult = snapDragPointForTarget(shapeRef.current, target, dragPoint.x, dragPoint.y);
    const snappedPoint = snapResult.point;
    const { x, y } = snappedPoint;
    if (target.kind === 'circle-radius' && shapeRef.current.kind === 'circle') {
      const dx = x - shapeRef.current.cx;
      const dy = y - shapeRef.current.cy;
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        const nextAngle = Math.atan2(dy, dx);
        circleRadiusAngleRef.current = nextAngle;
        setCircleRadiusAngle(nextAngle);
      }
    }
    const insetModifierMode = syncInsetModifierMode(event);
    const insetRadiusMode: InsetRadiusMode = insetModifierMode;
    const insetSideMode: InsetSideMode = insetModifierMode;
    const insetRadiusUnlocked = radiusUnlockKeyPressedRef.current;
    setShape((current) => {
      const dragShape =
        target.kind === 'polygon-point' &&
        target.before.kind === 'polygon' &&
        current.kind === 'polygon' &&
        target.before.points.length > current.points.length
          ? target.before
          : current;
      const activeDragPoint = dragPointForTarget(target, rawPoint);
      const activeSnapResult =
        dragShape === shapeRef.current
          ? snapResult
          : snapDragPointForTarget(dragShape, target, activeDragPoint.x, activeDragPoint.y);
      showSnapGuides(activeSnapResult.guides);
      const point = activeSnapResult.point;
      const next = updateShapeForDrag(dragShape, target, point.x, point.y, {
        canvas: canvasRef.current ?? undefined,
        insetRadiusMode,
        insetRadiusUnlocked,
        insetSideMode,
        ellipseScaleProportional: event.shiftKey,
      });
      if (!shapesClose(dragShape, next)) {
        markLocalShapeChange();
        setActivePreset(matchPreset(next) || NONE_PRESET);
      }
      shapeRef.current = next;
      return next;
    });
  };
  return { dragShapeTo };
}

type EditorAfterHandleDragActions = EditorAfterPointDuplicateDragActions &
  ReturnType<typeof handleDragActions>;

// The window's pointer moves during any drag.
function pointerMoveActions(editor: EditorAfterHandleDragActions) {
  const { shapeTransformDragRef, updateShapeTransformDrag, polygonSelectionDragRef } = editor;
  const { updatePolygonSelectionDrag, dragTargetRef, canvasRef, activePointerIdRef } = editor;
  const { finishDrag, duplicateDraggedPolygonPoint, dragShapeTo } = editor;
  const onWindowPointerMove = (event: PointerEvent) => {
    if (shapeTransformDragRef.current && updateShapeTransformDrag(event)) {
      return;
    }
    if (polygonSelectionDragRef.current && updatePolygonSelectionDrag(event)) {
      return;
    }

    let target = dragTargetRef.current;
    if (!target || !canvasRef.current) {
      return;
    }
    if (
      activePointerIdRef.current !== undefined &&
      event.pointerId !== activePointerIdRef.current
    ) {
      return;
    }
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      finishDrag();
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    const rawX = ((event.clientX - rect.left) / rect.width) * 100;
    const rawY = ((event.clientY - rect.top) / rect.height) * 100;
    const rawPoint = { x: rawX, y: rawY };

    if (
      target.kind === 'polygon-point' &&
      event.altKey &&
      !target.optionDuplicated &&
      target.before.kind === 'polygon'
    ) {
      target = duplicateDraggedPolygonPoint(target.index, target.before, rawPoint) ?? target;
    }
    dragShapeTo(target, rawPoint, event);
  };
  return { onWindowPointerMove };
}

type EditorAfterPointerMoveActions = EditorAfterHandleDragActions &
  ReturnType<typeof pointerMoveActions>;

// The window's pointer releases during any drag.
function pointerEndActions(editor: EditorAfterPointerMoveActions) {
  const { shapeTransformDragRef, updateShapeTransformDrag, finishShapeTransformDrag } = editor;
  const { polygonSelectionDragRef, updatePolygonSelectionDrag } = editor;
  const { finishPolygonSelectionDrag, activePointerIdRef, finishDrag } = editor;
  const onWindowPointerUp = (event: PointerEvent) => {
    const shapeTransform = shapeTransformDragRef.current;
    if (shapeTransform) {
      if (event.pointerId !== shapeTransform.pointerId) {
        return;
      }
      updateShapeTransformDrag(event);
      finishShapeTransformDrag(true);
      return;
    }
    const selection = polygonSelectionDragRef.current;
    if (selection) {
      if (event.pointerId !== selection.pointerId) {
        return;
      }
      updatePolygonSelectionDrag(event);
      finishPolygonSelectionDrag(true);
      return;
    }
    if (
      activePointerIdRef.current !== undefined &&
      event.pointerId !== activePointerIdRef.current
    ) {
      return;
    }
    finishDrag(true, event);
  };
  const onWindowPointerCancel = (event: PointerEvent) => {
    const shapeTransform = shapeTransformDragRef.current;
    if (shapeTransform) {
      if (event.pointerId !== shapeTransform.pointerId) {
        return;
      }
      finishShapeTransformDrag(false);
      return;
    }
    const selection = polygonSelectionDragRef.current;
    if (selection) {
      if (event.pointerId !== selection.pointerId) {
        return;
      }
      finishPolygonSelectionDrag(false);
      return;
    }
    if (
      activePointerIdRef.current !== undefined &&
      event.pointerId !== activePointerIdRef.current
    ) {
      return;
    }
    finishDrag(false, event);
  };
  return { onWindowPointerUp, onWindowPointerCancel };
}

type EditorAfterPointerEndActions = EditorAfterPointerMoveActions &
  ReturnType<typeof pointerEndActions>;

// The window pointer listeners for drags.
function useWindowPointerListeners(editor: EditorAfterPointerEndActions) {
  const { shapeTransformDragRef, finishShapeTransformDrag, polygonSelectionDragRef } = editor;
  const { finishPolygonSelectionDrag, finishDrag, onWindowPointerMove, onWindowPointerUp } = editor;
  const { onWindowPointerCancel } = editor;
  const onWindowBlurDuringDrag = () => {
    if (shapeTransformDragRef.current) {
      finishShapeTransformDrag(false);
      return;
    }
    if (polygonSelectionDragRef.current) {
      finishPolygonSelectionDrag(false);
      return;
    }
    finishDrag(false);
  };

  // Window pointer listeners, registered once: they reach the current render's
  // handlers through this ref, so a drag always works with the latest state.
  const windowPointerHandlers = {
    onWindowPointerMove,
    onWindowPointerUp,
    onWindowPointerCancel,
    onWindowBlurDuringDrag,
  };
  const windowPointerRef = useRef(windowPointerHandlers);
  windowPointerRef.current = windowPointerHandlers;
  useEffect(() => {
    const onMove = (event: PointerEvent) => windowPointerRef.current.onWindowPointerMove(event);
    const onUp = (event: PointerEvent) => windowPointerRef.current.onWindowPointerUp(event);
    const onCancel = (event: PointerEvent) => windowPointerRef.current.onWindowPointerCancel(event);
    const onBlur = () => windowPointerRef.current.onWindowBlurDuringDrag();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return { onWindowBlurDuringDrag, windowPointerHandlers, windowPointerRef };
}

type EditorAfterWindowPointerListeners = EditorAfterPointerEndActions &
  ReturnType<typeof useWindowPointerListeners>;

// The shortcut-help target, and closing the menus and popovers on an outside press.
function useDismissListeners(editor: EditorAfterWindowPointerListeners) {
  const { setShortcutHelpPortalTarget, isPresetOpen, presetDropdownRef, setIsPresetOpen } = editor;
  const { isClipPathLabelMenuOpen, clipPathLabelRef } = editor;
  const { setIsClipPathLabelMenuOpen, isShortcutHelpOpen, shortcutHelpRef } = editor;
  const { setIsShortcutHelpOpen } = editor;
  useEffect(() => {
    setShortcutHelpPortalTarget(document.getElementById('clip-path_header-shortcuts') ?? undefined);
  }, [setShortcutHelpPortalTarget]);

  useEffect(() => {
    if (!isPresetOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && presetDropdownRef.current?.contains(event.target)) {
        return;
      }
      // What closePresetDropdown does, with the setter React keeps stable.
      setIsPresetOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isPresetOpen, presetDropdownRef, setIsPresetOpen]);

  useEffect(() => {
    if (!isClipPathLabelMenuOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && clipPathLabelRef.current?.contains(event.target)) {
        return;
      }
      setIsClipPathLabelMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isClipPathLabelMenuOpen, clipPathLabelRef, setIsClipPathLabelMenuOpen]);

  useEffect(() => {
    if (!isShortcutHelpOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && shortcutHelpRef.current?.contains(event.target)) {
        return;
      }
      setIsShortcutHelpOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsShortcutHelpOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isShortcutHelpOpen, shortcutHelpRef, setIsShortcutHelpOpen]);
}

// Clearing the selection on an outside press.
function useDeselectListener(editor: EditorAfterWindowPointerListeners) {
  const { selectedHandleRef, isShapeTransformSelectedRef, dragTargetRef } = editor;
  const { shapeTransformDragRef, setShapeTransformSelection, selectHandle } = editor;
  const onDocumentPointerDownDeselect = (event: MouseEvent) => {
    if (
      (!selectedHandleRef.current && !isShapeTransformSelectedRef.current) ||
      dragTargetRef.current ||
      shapeTransformDragRef.current
    ) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest('.clip-path_handle')) {
      return;
    }
    if (target instanceof Element && target.closest('.clip-path_shape-move')) {
      return;
    }
    if (target instanceof Element && target.closest('.clip-path_shape-resize')) {
      return;
    }
    if (target instanceof Element && target.closest('.code-editor')) {
      return;
    }
    if (isShapeTransformSelectedRef.current) {
      setShapeTransformSelection(false);
    }
    selectHandle(undefined);
  };

  // A press anywhere but a handle, the shape, or the code clears the selection. Registered
  // once; the ref reaches the current render's handler.
  const documentPointerDownRef = useRef(onDocumentPointerDownDeselect);
  documentPointerDownRef.current = onDocumentPointerDownDeselect;
  useEffect(() => {
    const listener = (event: MouseEvent) => documentPointerDownRef.current(event);
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, []);
  return { onDocumentPointerDownDeselect, documentPointerDownRef };
}

type EditorAfterDeselectListener = EditorAfterWindowPointerListeners &
  ReturnType<typeof useDeselectListener>;

// Measuring the canvas and the space its handles may use.
function useCanvasMeasure(editor: EditorAfterDeselectListener) {
  const { canvasRef, canvasWrapRef, setCanvasSize, setHandleBounds } = editor;
  useLayoutEffect(() => {
    const updateBounds = () => {
      const canvas = canvasRef.current;
      const wrap = canvasWrapRef.current;
      if (!canvas || !wrap) {
        return;
      }

      const canvasRect = canvas.getBoundingClientRect();
      if (canvasRect.width <= 0 || canvasRect.height <= 0) {
        return;
      }
      const nextSize = { width: canvasRect.width, height: canvasRect.height };
      setCanvasSize((current) =>
        current &&
        Math.abs(current.width - nextSize.width) < 0.1 &&
        Math.abs(current.height - nextSize.height) < 0.1
          ? current
          : nextSize,
      );

      const wrapRect = wrap.getBoundingClientRect();
      const handleRadius = HANDLE_SIZE_PX / 2;
      const nextBounds = {
        minX: ((wrapRect.left - canvasRect.left + handleRadius) / canvasRect.width) * 100,
        maxX: ((wrapRect.right - canvasRect.left - handleRadius) / canvasRect.width) * 100,
        minY: ((wrapRect.top - canvasRect.top + handleRadius) / canvasRect.height) * 100,
        maxY: ((wrapRect.bottom - canvasRect.top - handleRadius) / canvasRect.height) * 100,
      };

      setHandleBounds((current) => (boundsClose(current, nextBounds) ? current : nextBounds));
    };

    updateBounds();

    let observer: ResizeObserver | undefined = undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateBounds);
      if (canvasRef.current) {
        observer.observe(canvasRef.current);
      }
      if (canvasWrapRef.current) {
        observer.observe(canvasWrapRef.current);
      }
    }

    window.addEventListener('resize', updateBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, [canvasRef, canvasWrapRef, setCanvasSize, setHandleBounds]);
}

// Scrolling the preset list, the code text, and the shortcut keys.
function useCodeSyncEffects(editor: EditorAfterDeselectListener) {
  const { isPresetOpen, presetListRef, activePreset, codeChangedShapeRef, setCodeValue } = editor;
  const { shape, css, getActivePolygonSelection, deleteSelectedPolygonPoints } = editor;
  const { duplicateSelectedPolygonPoint, undo, redo } = editor;
  useLayoutEffect(() => {
    if (!isPresetOpen) {
      return;
    }

    const list = presetListRef.current;
    const selectedOption = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    selectedOption?.scrollIntoView({ block: 'nearest' });
  }, [activePreset, isPresetOpen, presetListRef]);

  useEffect(() => {
    if (codeChangedShapeRef.current) {
      codeChangedShapeRef.current = false;
      return;
    }

    setCodeValue(formatCodeValue(shape));
  }, [css, shape, codeChangedShapeRef, setCodeValue]);

  const onShortcutKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (!mod && (key === 'backspace' || key === 'delete')) {
      if (getActivePolygonSelection().length) {
        event.preventDefault();
        deleteSelectedPolygonPoints();
      }
      return;
    }

    if (!mod) {
      return;
    }

    if (key === 'd' && !event.shiftKey) {
      if (duplicateSelectedPolygonPoint()) {
        event.preventDefault();
      }
      return;
    }

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      redo();
    }
  };
  return { onShortcutKeyDown };
}

type EditorAfterCodeSyncEffects = EditorAfterDeselectListener &
  ReturnType<typeof useCodeSyncEffects>;

// The keyboard shortcut and paste listeners.
function useShortcutListeners(editor: EditorAfterCodeSyncEffects) {
  const { onShortcutKeyDown, shapeFitModeRef, parseClipboardSvgShape } = editor;
  const { applyPastedSvgClipPath, clearPastedShapeSvgCache } = editor;
  // Delete, duplicate, undo and redo from the keyboard. Registered once; the ref reaches
  // the current render's handler.
  const shortcutKeyRef = useRef(onShortcutKeyDown);
  shortcutKeyRef.current = onShortcutKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutKeyRef.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const onWindowPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain') || '';
    const html = event.clipboardData?.getData('text/html') || '';
    const next = parseSvgClipPathPolygon(text) || parseSvgClipPathPolygon(html);
    if (!next) {
      const fitMode = shapeFitModeRef.current;
      const nextShape = parseClipboardSvgShape(text, html, fitMode);
      if (!nextShape) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      applyPastedSvgClipPath(nextShape.shape, {
        cacheUpdate: { cache: nextShape.cache },
        shapeFitMode: fitMode,
      });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearPastedShapeSvgCache();
    applyPastedSvgClipPath(next);
  };

  // Pasting an SVG (or a clip-path) replaces the shape. Registered once, in the capture
  // phase; the ref reaches the current render's handler.
  const windowPasteRef = useRef(onWindowPaste);
  windowPasteRef.current = onWindowPaste;
  useEffect(() => {
    const listener = (event: ClipboardEvent) => windowPasteRef.current(event);
    window.addEventListener('paste', listener, true);
    return () => window.removeEventListener('paste', listener, true);
  }, []);
  return { shortcutKeyRef, onWindowPaste, windowPasteRef };
}

type EditorAfterShortcutListeners = EditorAfterCodeSyncEffects &
  ReturnType<typeof useShortcutListeners>;

// The window's key presses that move handles.
function windowKeyDownActions(editor: EditorAfterShortcutListeners) {
  const { handledKeyboardEventsRef, isPresetOpenRef, selectedHandleRef } = editor;
  const { isShapeTransformSelectedRef, dragTargetRef, radiusUnlockKeyPressedRef } = editor;
  const { updateKeyboardModifierRefs, spaceKeyPressedRef, pressKeyboardMoveKey } = editor;
  const { pressShapeMoveKey } = editor;
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (handledKeyboardEventsRef.current.has(event)) {
      return;
    }
    if (event.metaKey || event.ctrlKey || isPresetOpenRef.current) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : undefined;
    const handle = selectedHandleRef.current;
    const shapeSelected = isShapeTransformSelectedRef.current;
    const shouldIgnore = isEditableTarget(target) && !dragTargetRef.current;
    const isHandleTarget =
      target instanceof Element && Boolean(target.closest('.clip-path_handle'));

    if (isRadiusUnlockKey(event.key, event.code)) {
      if (!shouldIgnore) {
        radiusUnlockKeyPressedRef.current = true;
        updateKeyboardModifierRefs({
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          radiusUnlocked: true,
        });
      }
      return;
    }

    if ((!handle && !shapeSelected) || shouldIgnore) {
      return;
    }

    if (isHandleTarget && (isSpaceKey(event.key, event.code) || isArrowKey(event.key))) {
      return;
    }

    updateKeyboardModifierRefs(event);

    if (isSpaceKey(event.key, event.code)) {
      event.preventDefault();
      spaceKeyPressedRef.current = true;
      return;
    }

    if (!isArrowKey(event.key)) {
      return;
    }

    event.preventDefault();
    if (handle) {
      pressKeyboardMoveKey(handle, event.key, event);
    } else {
      pressShapeMoveKey(event.key, event);
    }
  };
  return { onWindowKeyDown };
}

type EditorAfterWindowKeyDownActions = EditorAfterShortcutListeners &
  ReturnType<typeof windowKeyDownActions>;

// The window key listeners that move handles.
function useWindowKeyListeners(editor: EditorAfterWindowKeyDownActions) {
  const { handledKeyboardEventsRef, radiusUnlockKeyPressedRef } = editor;
  const { updateKeyboardModifierRefs, spaceKeyPressedRef, selectedHandleRef } = editor;
  const { isShapeTransformSelectedRef, releaseKeyboardMoveKey, keyboardModifiersRef } = editor;
  const { stopKeyboardMoveLoop, setActiveInsetModifierMode, onWindowKeyDown } = editor;
  const onWindowKeyUp = (event: KeyboardEvent) => {
    if (handledKeyboardEventsRef.current.has(event)) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    const isHandleTarget =
      target instanceof Element && Boolean(target.closest('.clip-path_handle'));

    if (isRadiusUnlockKey(event.key, event.code)) {
      radiusUnlockKeyPressedRef.current = false;
      updateKeyboardModifierRefs({
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        radiusUnlocked: false,
      });
      return;
    }

    if (isHandleTarget && (isSpaceKey(event.key, event.code) || isArrowKey(event.key))) {
      return;
    }

    if (isSpaceKey(event.key, event.code)) {
      spaceKeyPressedRef.current = false;
      if (selectedHandleRef.current || isShapeTransformSelectedRef.current) {
        event.preventDefault();
      }
      return;
    }

    updateKeyboardModifierRefs(event);
    if (!isArrowKey(event.key)) {
      return;
    }

    releaseKeyboardMoveKey(event.key, event);
  };

  const onWindowKeyBlur = () => {
    spaceKeyPressedRef.current = false;
    radiusUnlockKeyPressedRef.current = false;
    keyboardModifiersRef.current = { altKey: false, shiftKey: false, radiusUnlocked: false };
    stopKeyboardMoveLoop();
    setActiveInsetModifierMode('single');
  };

  // Window key listeners, registered once: they reach the current render's
  // handlers through this ref.
  const windowKeyHandlers = { onWindowKeyDown, onWindowKeyUp, onWindowKeyBlur };
  const windowKeyRef = useRef(windowKeyHandlers);
  windowKeyRef.current = windowKeyHandlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => windowKeyRef.current.onWindowKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => windowKeyRef.current.onWindowKeyUp(event);
    const onBlur = () => windowKeyRef.current.onWindowKeyBlur();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return { onWindowKeyUp, onWindowKeyBlur, windowKeyHandlers, windowKeyRef };
}

type EditorAfterWindowKeyListeners = EditorAfterWindowKeyDownActions &
  ReturnType<typeof useWindowKeyListeners>;

// Reading the Webflow selection.
function useSelectionSync(editor: EditorAfterWindowKeyListeners) {
  const { selectionReadInProgressRef, selectionReadSeqRef, selectionReadTimerRef } = editor;
  const { activeBreakpointRef, setIsClipPathLabelMenuOpen, refreshSelectedElementRef } = editor;
  // The listeners below outlive this render; they read the editor through this ref.
  const readerRef = useRef(editor);
  readerRef.current = editor;
  useEffect(() => {
    const webflowApi = readWebflowApi();
    if (!webflowApi) {
      return;
    }
    const session: SelectionSession = { cancelled: false, webflowApi, readerRef };
    refreshSelectedElementRef.current = (options: SelectionReadOptions = {}) => {
      void readCurrentSelectedElement(session, options);
    };
    const scheduleRead = () => scheduleCurrentSelectedElementRead(session, selectionReadTimerRef);
    const unsubscribeSelectedElement = webflowApi.subscribe?.('selectedelement', scheduleRead);
    const unsubscribeMediaQuery = webflowApi.subscribe?.('mediaquery', (breakpoint) => {
      activeBreakpointRef.current = breakpoint || 'main';
      setIsClipPathLabelMenuOpen(false);
      scheduleRead();
    });
    const styleRefreshTimer = window.setInterval(() => {
      if (selectionReadInProgressRef.current) {
        return;
      }
      void readCurrentSelectedElement(session);
    }, STYLE_REFRESH_MS);

    void syncCurrentBreakpoint(webflowApi, activeBreakpointRef).then(() =>
      readCurrentSelectedElement(session, { force: true, resetStyle: true }),
    );

    return () => {
      session.cancelled = true;
      selectionReadSeqRef.current += 1;
      selectionReadInProgressRef.current = false;
      window.clearInterval(styleRefreshTimer);
      if (selectionReadTimerRef.current !== undefined) {
        window.clearTimeout(selectionReadTimerRef.current);
        selectionReadTimerRef.current = undefined;
      }
      unsubscribeSelectedElement?.();
      unsubscribeMediaQuery?.();
      refreshSelectedElementRef.current = undefined;
    };
  }, [
    selectionReadInProgressRef,
    selectionReadSeqRef,
    selectionReadTimerRef,
    activeBreakpointRef,
    setIsClipPathLabelMenuOpen,
    refreshSelectedElementRef,
  ]);
}

// What a selection read reads and records.
type SelectionReader = EditorAfterWindowKeyListeners;

// One subscription to the Designer's selection, cancelled when the editor unmounts.
// The reader is the latest render's editor.
type SelectionSession = {
  cancelled: boolean;
  readonly webflowApi: WebflowApi;
  readonly readerRef: MutableRefObject<SelectionReader>;
};

// The bookkeeping of one read: its sequence number, whether it was forced, and
// whether it is logged.
type SelectionRead = { readSeq: number; force: boolean; debugRead: boolean };

// The styles an element carries and the clip-path style found among them.
type FoundClipPathStyle = Awaited<ReturnType<typeof findClipPathStyle>>;
type ElementStyles = {
  styles: StyleHandle[];
  classNames: string[];
  selectedStyle: FoundClipPathStyle;
  styleOptions: StyleTargetOptions | undefined;
};

// Whether this read still counts: not cancelled, and not superseded by a later one.
function isCurrentRead(session: SelectionSession, read: SelectionRead): boolean {
  if (session.cancelled) {
    return false;
  }
  return read.readSeq === session.readerRef.current.selectionReadSeqRef.current;
}

async function syncCurrentBreakpoint(
  webflowApi: WebflowApi,
  activeBreakpointRef: MutableRefObject<BreakpointId>,
): Promise<void> {
  try {
    activeBreakpointRef.current = (await webflowApi.getMediaQuery?.()) || 'main';
  } catch {
    activeBreakpointRef.current = 'main';
  }
}

// A selection change reads the new element a beat later, once the Designer settles.
function scheduleCurrentSelectedElementRead(
  session: SelectionSession,
  selectionReadTimerRef: MutableRefObject<number | undefined>,
): void {
  if (selectionReadTimerRef.current !== undefined) {
    window.clearTimeout(selectionReadTimerRef.current);
  }
  selectionReadTimerRef.current = window.setTimeout(() => {
    selectionReadTimerRef.current = undefined;
    void readCurrentSelectedElement(session, { force: true, resetStyle: true });
  }, 120);
}

async function readCurrentSelectedElement(
  session: SelectionSession,
  options: SelectionReadOptions = {},
): Promise<void> {
  try {
    await readSelectedElement(session, await session.webflowApi.getSelectedElement?.(), options);
  } catch {
    if (!session.cancelled && options.force) {
      loadNoneIfChanged(session.readerRef.current, { force: options.force });
    }
  }
}

// No clip-path on the selection: forget the style and show none.
function loadNoneIfChanged(reader: SelectionReader, { force }: { force: boolean }): void {
  const { styleRef } = reader;
  styleRef.current = undefined;
  showNoClipPathSource(reader);
  if (shouldReloadNone(reader, { force })) {
    reader.loadShapeFromSelection(NONE_SHAPE, 'none');
  }
}

// No clip-path on the selection, which a later write can go to `style`.
function loadNoneForWritableStyle(
  reader: SelectionReader,
  style: StyleHandle | undefined,
  { force }: { force: boolean },
): void {
  const { styleRef } = reader;
  styleRef.current = style || undefined;
  showNoClipPathSource(reader);
  if (shouldReloadNone(reader, { force })) {
    reader.loadShapeFromSelection(NONE_SHAPE, 'none');
  }
}

function showNoClipPathSource(reader: SelectionReader): void {
  reader.setClipPathStyleOrigin('none');
  reader.setAppliedClassName(undefined);
  reader.setClipPathSourceSelector([]);
  reader.setClipPathSourceBreakpoint(undefined);
  reader.setIsClipPathLabelMenuOpen(false);
}

function shouldReloadNone(reader: SelectionReader, { force }: { force: boolean }): boolean {
  return (
    force ||
    reader.lastWrittenRef.current !== 'none' ||
    !shapesClose(reader.shapeRef.current, NONE_SHAPE)
  );
}

async function readSelectedElement(
  session: SelectionSession,
  element: unknown,
  options: SelectionReadOptions = {},
): Promise<void> {
  const read = startSelectionRead(session, element, options);
  if (!read) {
    return;
  }
  try {
    await readElementClipPath(session, read, element);
  } catch (error: unknown) {
    if (read.debugRead) {
      debugClipPath('readSelectedElement:error', error);
    }
    if (isCurrentRead(session, read)) {
      if (read.force) {
        loadNoneIfChanged(session.readerRef.current, { force: read.force });
      }
    }
  } finally {
    const reader = session.readerRef.current;
    if (read.readSeq === reader.selectionReadSeqRef.current) {
      reader.selectionReadInProgressRef.current = false;
    }
  }
}

// Claims the read and handles what needs no styles: a read already running, a
// write about to land, a new element, no element at all. Undefined when the read
// is over.
function startSelectionRead(
  session: SelectionSession,
  element: unknown,
  options: SelectionReadOptions,
): SelectionRead | undefined {
  const reader = session.readerRef.current;
  const force = options.force ?? false;
  if (reader.selectionReadInProgressRef.current && !force && !options.resetStyle) {
    return undefined;
  }
  reader.selectionReadInProgressRef.current = true;
  const readSeq = ++reader.selectionReadSeqRef.current;
  const nextElementKey = selectedElementKey(element);
  const selectionChanged = nextElementKey !== reader.selectedElementKeyRef.current;
  const debugRead = Boolean(CLIP_PATH_DEBUG && (force || options.resetStyle || selectionChanged));
  if (debugRead) {
    debugClipPath('readSelectedElement:start', {
      activeBreakpoint: reader.activeBreakpointRef.current,
      elementKey: nextElementKey,
      force,
      resetStyle: Boolean(options.resetStyle),
      selectionChanged,
    });
  }
  if (selectionChanged) {
    forgetPreviousElement(reader, nextElementKey);
  }
  if (options.resetStyle) {
    reader.clearPendingWrite();
    reader.localWritePendingRef.current = false;
    reader.styleRef.current = undefined;
  } else if (!selectionChanged && writeInFlight(reader)) {
    reader.selectionReadInProgressRef.current = false;
    return undefined;
  }
  const read = { readSeq, force, debugRead };
  if (!element) {
    finishEmptySelectionRead(session, read);
    return undefined;
  }
  return read;
}

// A write (or a drag that will write) is pending; a read now would undo it.
function writeInFlight(reader: SelectionReader): boolean {
  return Boolean(
    reader.localWritePendingRef.current ||
    reader.writeTimerRef.current !== undefined ||
    reader.dragTargetRef.current,
  );
}

// A different element: its classes, selection, and pending write start over.
function forgetPreviousElement(reader: SelectionReader, nextElementKey: string | undefined): void {
  const { selectedElementKeyRef, selectedClassNamesRef, selectionIsDefaultRef } = reader;
  const { cascadeWinnerCacheRef, localWritePendingRef } = reader;
  selectedElementKeyRef.current = nextElementKey;
  selectedClassNamesRef.current = [];
  selectionIsDefaultRef.current = true;
  cascadeWinnerCacheRef.current = undefined;
  reader.setSelectedClassNames([]);
  reader.clearPendingWrite();
  localWritePendingRef.current = false;
  loadNoneIfChanged(reader, { force: true });
}

// Nothing selected: no classes, and no clip-path.
function finishEmptySelectionRead(session: SelectionSession, read: SelectionRead): void {
  const reader = session.readerRef.current;
  if (read.debugRead) {
    debugClipPath('readSelectedElement:no-element');
  }
  if (isCurrentRead(session, read)) {
    reader.setElementClassNames([]);
    reader.selectedClassNamesRef.current = [];
    reader.selectionIsDefaultRef.current = true;
    reader.setSelectedClassNames([]);
    loadNoneIfChanged(reader, { force: read.force });
  }
  if (read.readSeq === reader.selectionReadSeqRef.current) {
    reader.selectionReadInProgressRef.current = false;
  }
}

// Reads the element's clip-path — from its own styles, its classes, the cascade
// winner, or the classes picked in the tags — and loads it into the editor.
async function readElementClipPath(
  session: SelectionSession,
  read: SelectionRead,
  element: unknown,
): Promise<void> {
  const found = await readElementStyles(session, read, element);
  if (!found) {
    return;
  }
  const defaultStyle = await followDefaultSelection(session, read, found);
  if (defaultStyle === 'stale') {
    return;
  }
  const target = await targetSelectedClasses(session, read, {
    ...found,
    selectedStyle: defaultStyle,
  });
  if (target.kind === 'done') {
    return;
  }
  const selectedStyle = await applySelectedStyle(session, read, found, target);
  if (!selectedStyle) {
    return;
  }
  await loadSelectedShape(session, read, found, {
    selectedStyle,
    refineKey: target.inheritedWinnerRefineKey,
  });
}

// The element's styles and class names, and the style its clip-path comes from:
// its own styles first, then its classes' styles. Undefined when the read is stale.
async function readElementStyles(
  session: SelectionSession,
  read: SelectionRead,
  element: unknown,
): Promise<ElementStyles | undefined> {
  const reader = session.readerRef.current;
  const styleOptions = styleOptionsForBreakpoint(reader.activeBreakpointRef.current);
  const styles = await getElementPrimaryStyleHandles(element);
  if (!isCurrentRead(session, read)) {
    return undefined;
  }
  let selectedStyle = await findClipPathStyle(styles, styleOptions);
  const classNames = await getElementClassNames(element, styles);
  if (isCurrentRead(session, read)) {
    reader.setElementClassNames(classNames);
  }
  dropRemovedSelectedClasses(session, read, classNames);
  if (read.debugRead) {
    debugClipPath('readSelectedElement:primary-styles', {
      classNames,
      lookupCandidates: getStyleLookupCandidates(classNames),
      styles: await debugStyleSummaries(styles, styleOptions),
      selectedStyle: selectedStyle
        ? await debugStyleSummary(selectedStyle.style, styleOptions)
        : undefined,
      selectedRaw: selectedStyle?.raw || undefined,
      selectedBreakpoint: selectedStyle?.breakpoint || undefined,
    });
  }
  const found = { styles, classNames, selectedStyle, styleOptions };
  if (!hasClipPathDeclaration(selectedStyle?.raw)) {
    const fromClasses = await lookupClassClipPathStyle(session, read, found);
    if (fromClasses === 'stale') {
      return undefined;
    }
    selectedStyle = fromClasses;
  }
  if (!isCurrentRead(session, read)) {
    return undefined;
  }
  return { ...found, selectedStyle };
}

// Drop any manually selected classes that are no longer on the element (e.g.
// removed in the Designer) so we don't keep resolving their style globally and
// showing a stale preview.
function dropRemovedSelectedClasses(
  session: SelectionSession,
  read: SelectionRead,
  classNames: string[],
): void {
  const reader = session.readerRef.current;
  if (!reader.selectedClassNamesRef.current.some((name) => !classNames.includes(name))) {
    return;
  }
  const stillPresent = reader.selectedClassNamesRef.current.filter((name) =>
    classNames.includes(name),
  );
  reader.selectedClassNamesRef.current = stillPresent;
  if (isCurrentRead(session, read)) {
    reader.setSelectedClassNames(stillPresent);
  }
}

// The element's own styles declare no clip-path: look through its classes' styles.
async function lookupClassClipPathStyle(
  session: SelectionSession,
  read: SelectionRead,
  { styles, classNames, selectedStyle, styleOptions }: ElementStyles,
): Promise<FoundClipPathStyle | 'stale'> {
  if (read.debugRead) {
    debugClipPath('readSelectedElement:class-lookup-start', {
      classNames,
      lookupCandidates: getStyleLookupCandidates(classNames),
    });
  }
  const classLookup = await getClassStyleHandlesWithDiagnostics(classNames, session.webflowApi);
  const classStyles = classLookup.styles;
  if (!isCurrentRead(session, read)) {
    return 'stale';
  }
  let classSelectedStyle: FoundClipPathStyle = undefined;
  let nextSelectedStyle = selectedStyle;
  if (classStyles.length) {
    classSelectedStyle = await findClipPathStyle([...classStyles, ...styles], styleOptions);
    if (hasClipPathDeclaration(classSelectedStyle?.raw) || !selectedStyle) {
      nextSelectedStyle = classSelectedStyle;
    }
  }
  if (read.debugRead) {
    debugClipPath('readSelectedElement:class-styles', {
      lookupResults: classLookup.diagnostics,
      classStyles: await debugStyleSummaries(classStyles, styleOptions),
      classSelectedStyle: classSelectedStyle
        ? await debugStyleSummary(classSelectedStyle.style, styleOptions)
        : undefined,
      classSelectedRaw: classSelectedStyle?.raw || undefined,
      classSelectedBreakpoint: classSelectedStyle?.breakpoint || undefined,
      finalSelectedRaw: nextSelectedStyle?.raw || undefined,
      finalSelectedBreakpoint: nextSelectedStyle?.breakpoint || undefined,
    });
  }
  return nextSelectedStyle;
}

// While the selection is still the auto-default (user hasn't manually picked a
// class), keep it locked to the current cascade winner — the clip-path that
// actually renders: highest specificity, then latest stylesheet position — so it
// follows style resets and class add/remove on the same element, not just on
// element change.
async function followDefaultSelection(
  session: SelectionSession,
  read: SelectionRead,
  found: ElementStyles,
): Promise<FoundClipPathStyle | 'stale'> {
  const reader = session.readerRef.current;
  if (!reader.selectionIsDefaultRef.current) {
    return found.selectedStyle;
  }
  const winner = hasClipPathDeclaration(found.selectedStyle?.raw)
    ? await resolveCascadeWinnerClipPathStyle(
        found.classNames,
        found.styles,
        found.styleOptions,
        session.webflowApi,
      )
    : undefined;
  if (!isCurrentRead(session, read)) {
    return 'stale';
  }
  const defaultSelection = winner
    ? winner.namePath.filter((name) => found.classNames.includes(name))
    : [];
  const current = reader.selectedClassNamesRef.current;
  const changed =
    defaultSelection.length !== current.length ||
    defaultSelection.some((name, index) => name !== current[index]);
  if (changed) {
    reader.selectedClassNamesRef.current = defaultSelection;
    reader.setSelectedClassNames(defaultSelection);
  }
  return winner
    ? { style: winner.style, raw: winner.raw, breakpoint: winner.breakpoint }
    : found.selectedStyle;
}

// Where the read lands for the classes picked in the tags, or 'done' when it has
// already settled on none.
type SelectedClassTarget =
  | { kind: 'done' }
  | {
      kind: 'style';
      selectedStyle: FoundClipPathStyle;
      selectedNames: string[];
      writeStyleHandle: StyleHandle | undefined;
      originOverride: ClipPathStyleOrigin | undefined;
      appliedNameOverride: { name: string | undefined } | undefined;
      // Set when an inherited class showed its cheap effective value and still needs
      // the exact cascade winner resolved (in the background) afterward.
      inheritedWinnerRefineKey: string | undefined;
    };
type ClassStyleTarget = Extract<SelectedClassTarget, { kind: 'style' }>;

// When classes are picked in the tags, target them for reading and writing. If
// they have no clip-path of their own, show the effective (cascade-winner) value
// and mark it inherited — like a larger-breakpoint inheritance.
async function targetSelectedClasses(
  session: SelectionSession,
  read: SelectionRead,
  found: ElementStyles,
): Promise<SelectedClassTarget> {
  const reader = session.readerRef.current;
  const selectedNames = reader.selectedClassNamesRef.current;
  const untargeted: ClassStyleTarget = {
    kind: 'style',
    selectedStyle: found.selectedStyle,
    selectedNames,
    writeStyleHandle: undefined,
    originOverride: undefined,
    appliedNameOverride: undefined,
    inheritedWinnerRefineKey: undefined,
  };
  if (!selectedNames.length) {
    return untargeted;
  }
  // Resolve the exact standalone class (`.clip-path`) for a single selection, or
  // the exact combo (`.hero.clip-path`) for several — path-verified so we never
  // grab a combo whose leaf name merely matches, and never the element's own
  // most-specific combo handle.
  const targetStyle = await findStyleForClassPath(selectedNames, session.webflowApi);
  if (!isCurrentRead(session, read)) {
    return { kind: 'done' };
  }
  const targetDeclaration = targetStyle
    ? await readClipPathDeclarationWithSource(targetStyle, found.styleOptions)
    : undefined;
  if (!isCurrentRead(session, read)) {
    return { kind: 'done' };
  }
  if (targetStyle && targetDeclaration && hasClipPathDeclaration(targetDeclaration.value)) {
    return {
      ...untargeted,
      writeStyleHandle: targetStyle,
      selectedStyle: {
        style: targetStyle,
        raw: targetDeclaration.value,
        breakpoint: targetDeclaration.breakpoint,
      },
      appliedNameOverride: { name: selectedNames[selectedNames.length - 1] ?? undefined },
    };
  }
  if (hasClipPathDeclaration(found.selectedStyle?.raw)) {
    return inheritForSelectedClasses(session, read, found, {
      ...untargeted,
      writeStyleHandle: targetStyle,
    });
  }
  // Nothing renders → none on the (writable) selected class.
  loadNoneForWritableStyle(reader, targetStyle, { force: read.force });
  return { kind: 'done' };
}

// The selected class has no clip-path of its own, but the element shows an
// effective one → inherited. Paint the orange label + the cheap effective value
// INSTANTLY; resolve the exact cascade winner (slower) afterward and only re-read
// if it actually differs.
function inheritForSelectedClasses(
  session: SelectionSession,
  read: SelectionRead,
  found: ElementStyles,
  target: ClassStyleTarget,
): ClassStyleTarget {
  const reader = session.readerRef.current;
  if (isCurrentRead(session, read)) {
    reader.setClipPathStyleOrigin('inherited');
  }
  const inherited: ClassStyleTarget = { ...target, originOverride: 'inherited' };
  const winnerKey =
    `${found.classNames.join('\u0000')}|` +
    `${found.selectedStyle?.style?.id ?? ''}|${found.selectedStyle?.raw ?? ''}`;
  const cached = reader.cascadeWinnerCacheRef.current;
  if (cached && cached.key === winnerKey) {
    // Exact winner already known — use it directly (no flash).
    if (!cached.winner) {
      return inherited;
    }
    return {
      ...inherited,
      selectedStyle: {
        style: cached.winner.style,
        raw: cached.winner.raw,
        breakpoint: cached.winner.breakpoint,
      },
    };
  }
  // Show the cheap effective value now; refine after this read.
  return { ...inherited, inheritedWinnerRefineKey: winnerKey };
}

// Points the editor at the style the value comes from and fills in the source
// label. Undefined when there is no clip-path to load (none has been shown).
async function applySelectedStyle(
  session: SelectionSession,
  read: SelectionRead,
  found: ElementStyles,
  target: ClassStyleTarget,
): Promise<NonNullable<FoundClipPathStyle> | undefined> {
  const reader = session.readerRef.current;
  const { selectedStyle } = target;
  if (!selectedStyle) {
    if (read.debugRead) {
      debugClipPath('readSelectedElement:result-none-no-style');
    }
    loadNoneIfChanged(reader, { force: read.force });
    return undefined;
  }
  if (!hasClipPathDeclaration(selectedStyle.raw)) {
    if (read.debugRead) {
      debugClipPath('readSelectedElement:result-none-writable-style', {
        style: await debugStyleSummary(selectedStyle.style, found.styleOptions),
      });
    }
    loadNoneForWritableStyle(reader, selectedStyle.style, { force: read.force });
    return undefined;
  }
  // In class-selection mode never fall back to the element's combo handle; an
  // undefined target here means "create the selected class/combo on write".
  reader.styleRef.current = target.selectedNames.length
    ? target.writeStyleHandle
    : target.writeStyleHandle || selectedStyle.style;
  reader.setClipPathStyleOrigin(
    target.originOverride ||
      clipPathStyleOriginFromSource(selectedStyle.breakpoint, reader.activeBreakpointRef.current),
  );
  // The selector + breakpoint the rendered value actually comes from, for the
  // "Value comes from:" popover on the inherited (orange) label.
  const sourceNamePath = await getStyleNamePath(selectedStyle.style);
  if (isCurrentRead(session, read)) {
    const sourceClasses = sourceNamePath.filter((name) => found.classNames.includes(name));
    reader.setClipPathSourceSelector(sourceClasses.length ? sourceClasses : sourceNamePath);
    reader.setClipPathSourceBreakpoint(selectedStyle.breakpoint);
    reader.setAppliedClassName(
      target.appliedNameOverride
        ? target.appliedNameOverride.name
        : sourceNamePath[sourceNamePath.length - 1] || undefined,
    );
  }
  return selectedStyle;
}

// Loads the selected style's clip-path into the editor, with its pasted-SVG
// variants when it has them.
async function loadSelectedShape(
  session: SelectionSession,
  read: SelectionRead,
  found: ElementStyles,
  {
    selectedStyle,
    refineKey,
  }: { selectedStyle: NonNullable<FoundClipPathStyle>; refineKey: string | undefined },
): Promise<void> {
  const reader = session.readerRef.current;
  const normalized = normalizeClipPathValue(selectedStyle.raw);
  if (read.debugRead) {
    debugClipPath('readSelectedElement:result-detected', {
      raw: selectedStyle.raw,
      normalizedCss: normalized.css,
      preset: matchPreset(normalized.shape),
      sourceBreakpoint: selectedStyle.breakpoint,
      style: await debugStyleSummary(selectedStyle.style, found.styleOptions),
    });
  }
  const loadedShapeScaleOptions = loadedShapeScaleOptionsFor(reader, normalized.shape);
  let rawShapeSvgCache: PastedShapeSvgCache | undefined = undefined;
  if (normalized.shape.kind === 'shape') {
    rawShapeSvgCache =
      reader.matchingPastedSvgCacheForShape(normalized.shape, loadedShapeScaleOptions) ||
      (await readPastedShapeMetadata(selectedStyle.style, found.styleOptions)) ||
      cacheFromShapeFitVariants(normalized.shape, loadedShapeScaleOptions);
  }
  const shapeSvgCache = normalizeShapeFitCache(rawShapeSvgCache, loadedShapeScaleOptions);
  const loadedShape =
    normalized.shape.kind === 'shape' &&
    rawShapeSvgCache &&
    shapeSvgCache &&
    shapesClose(normalized.shape, rawShapeSvgCache.contain)
      ? shapeSvgCache.contain
      : normalized.shape;
  if (!isCurrentRead(session, read)) {
    return;
  }
  if (refineKey) {
    // Best effort: the lookups behind it swallow their own failures, and a winner
    // it cannot resolve leaves the effective value already on screen.
    void refineInheritedWinner(session, read, found, refineKey);
  }
  // Skip the reload when the value is unchanged from what we already have — even
  // on a forced re-read. `loadShapeFromSelection` wipes the undo stack, and a forced
  // re-read can fire right after applying to a NEW class (the createStyle triggers a
  // selection event), which would otherwise destroy the just-created undo step.
  // styleRef/origin/source are already set above, so this only avoids the needless
  // reload.
  const unchanged =
    reader.lastWrittenRef.current === normalized.css &&
    shapesClose(reader.shapeRef.current, loadedShape);
  if (!unchanged) {
    reader.loadShapeFromSelection(loadedShape, normalized.css);
  }
  if (shapeSvgCache && reader.shapeMatchesPastedSvgCache(loadedShape, shapeSvgCache)) {
    reader.pastedShapeSvgCacheRef.current = shapeSvgCache;
  }
}

// The scale options a loaded shape was written with: its own variables, or the
// editor's current ones without a variable for a shape that names none.
function loadedShapeScaleOptionsFor(reader: SelectionReader, shape: ClipShape): ShapeScaleOptions {
  const loadedScaleVariableName =
    shape.kind === 'shape' ? shapeScaleVariableNameFromValue(shape.value) : undefined;
  const loadedOffsetNames =
    shape.kind === 'shape' ? shapeOffsetVariableNamesFromValue(shape.value) : undefined;
  if (!loadedScaleVariableName) {
    return reader.currentShapeScaleOptions({ useVariable: false });
  }
  return {
    useVariable: true,
    variableName: loadedScaleVariableName,
    offsetLeftVariableName:
      loadedOffsetNames?.offsetLeftVar || DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
    offsetTopVariableName:
      loadedOffsetNames?.offsetTopVar || DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
  };
}

// An inherited class just painted its cheap effective value. Resolve the exact
// cascade winner in the background; cache it and, if it actually differs from what
// we showed, re-read (which now hits the cache and loads the winner through the
// normal shape-aware path).
async function refineInheritedWinner(
  session: SelectionSession,
  read: SelectionRead,
  found: ElementStyles,
  refineKey: string,
): Promise<void> {
  const winner = await resolveCascadeWinnerClipPathStyle(
    found.classNames,
    found.styles,
    found.styleOptions,
    session.webflowApi,
  );
  if (!isCurrentRead(session, read)) {
    return;
  }
  const reader = session.readerRef.current;
  reader.cascadeWinnerCacheRef.current = { key: refineKey, winner };
  const winnerCss = winner ? normalizeClipPathValue(winner.raw).css : undefined;
  if (winnerCss && winnerCss !== reader.lastWrittenRef.current) {
    reader.refreshSelectedElementRef.current?.({ force: true });
  }
}

// Writing the clip-path.
function useClipPathWrite(editor: EditorAfterWindowKeyListeners) {
  const { styleRef, onApplyRef, css, localWritePendingRef, lastWrittenRef, writeTimerRef } = editor;
  // The flush runs after this render is gone; it reads the editor through this ref.
  const writerRef = useRef(editor);
  writerRef.current = editor;
  useEffect(() => {
    const style = styleRef.current;
    const webflowApi = readWebflowApi();
    const canResolveSelectedStyle = webflowApi !== undefined;
    // Embedded mode (onApply): the parent panel owns the write target, so the tool's own
    // ability to reach a Webflow style handle says nothing about whether the value can be
    // written. Without this the gate below returned early every time outside the
    // Designer — the flush that calls onApply was never reached, so editing a shape did
    // nothing at all.
    if (!onApplyRef.current && !canWriteClipPathValue(style, css) && !canResolveSelectedStyle) {
      localWritePendingRef.current = false;
      return;
    }
    if (lastWrittenRef.current === css) {
      localWritePendingRef.current = false;
      return;
    }
    if (writeTimerRef.current !== undefined) {
      return;
    }
    scheduleClipPathFlush(writerRef, webflowApi);
  }, [css, styleRef, onApplyRef, localWritePendingRef, lastWrittenRef, writeTimerRef]);
}

// What a clip-path write reads and records.
type ClipPathWriter = EditorAfterWindowKeyListeners;

// Writes the latest CSS once the throttle has passed.
function scheduleClipPathFlush(
  writerRef: MutableRefObject<ClipPathWriter>,
  webflowApi: WebflowApi | undefined,
): void {
  writerRef.current.writeTimerRef.current = window.setTimeout(() => {
    // Nothing to handle here: the flush catches its own failures, and a failed
    // write is retried by the next change.
    void flushClipPathWrite(writerRef, webflowApi);
  }, WRITE_THROTTLE_MS);
}

// Writes the latest CSS, then schedules another write if it changed meanwhile.
async function flushClipPathWrite(
  writerRef: MutableRefObject<ClipPathWriter>,
  webflowApi: WebflowApi | undefined,
): Promise<void> {
  const writer = writerRef.current;
  const valueToWrite = writer.latestCssRef.current;
  writer.writeTimerRef.current = undefined;
  if (writer.lastWrittenRef.current === valueToWrite) {
    return;
  }
  const settled = writer.onApplyRef.current
    ? applyClipPathToEmbed(writer, valueToWrite)
    : await writeClipPathToWebflow(writer, webflowApi, valueToWrite);
  if (settled === 'stop') {
    return;
  }
  if (
    writer.latestCssRef.current !== writer.lastWrittenRef.current &&
    writer.writeTimerRef.current === undefined
  ) {
    scheduleClipPathFlush(writerRef, webflowApi);
  }
}

// Embedded mode: the parent style panel owns the write target (the user's selected
// selector + breakpoint), so hand it the raw value and skip all of the tool's own
// class/style resolution.
function applyClipPathToEmbed(writer: ClipPathWriter, valueToWrite: string): 'continue' {
  const { lastWrittenRef, localWritePendingRef } = writer;
  try {
    if (isNoneClipPathValue(valueToWrite)) {
      writer.onClearRef.current?.();
    } else {
      writer.onApplyRef.current?.(valueToWrite);
    }
  } catch {
    /* parent write failed — next change retries */
  }
  lastWrittenRef.current = valueToWrite;
  writer.setClipPathStyleOrigin(isNoneClipPathValue(valueToWrite) ? 'none' : 'current');
  writer.setAppliedClassName(undefined);
  localWritePendingRef.current = writer.latestCssRef.current !== valueToWrite;
  return 'continue';
}

// Writes to the element's clip-path style in the Designer, resolving (or creating)
// the style first when the one in hand can't take the value. 'stop' when there is
// nothing that can.
async function writeClipPathToWebflow(
  writer: ClipPathWriter,
  webflowApi: WebflowApi | undefined,
  valueToWrite: string,
): Promise<'continue' | 'stop'> {
  const { localWritePendingRef, pastedShapeSvgCacheRef, lastWrittenRef } = writer;
  try {
    const targetStyle = await resolveClipPathWriteTarget(writer, webflowApi, valueToWrite);
    if (!canWriteClipPathValue(targetStyle, valueToWrite)) {
      localWritePendingRef.current = false;
      return 'stop';
    }
    if (targetStyle) {
      const shapeSvgCache = writer.matchingPastedSvgCacheForShape(writer.shapeRef.current);
      if (shapeSvgCache) {
        pastedShapeSvgCacheRef.current = shapeSvgCache;
      }
      const styleOptions = styleOptionsForBreakpoint(writer.activeBreakpointRef.current);
      await writeClipPathToStyle(targetStyle, valueToWrite, {
        ...(shapeSvgCache ? { shapeSvgCache } : {}),
        ...(styleOptions ? { styleOptions } : {}),
      });
    }
    lastWrittenRef.current = valueToWrite;
    await recordClipPathWrite(writer, targetStyle, valueToWrite);
    localWritePendingRef.current = writer.latestCssRef.current !== valueToWrite;
  } catch {
    localWritePendingRef.current = false;
    /* swallow — next change will retry */
  }
  return 'continue';
}

// The style a write lands on: the one in hand when it can take the value; else, in
// class-selection mode, the exact selected class/combo (created if it doesn't exist
// — never the element's own combo); else the element's writable clip-path style.
async function resolveClipPathWriteTarget(
  writer: ClipPathWriter,
  webflowApi: WebflowApi | undefined,
  valueToWrite: string,
): Promise<StyleHandle | undefined> {
  const { styleRef } = writer;
  let targetStyle = styleRef.current;
  const selectedNames = writer.selectedClassNamesRef.current;
  if (selectedNames.length && webflowApi && !canWriteClipPathValue(targetStyle, valueToWrite)) {
    targetStyle = await resolveOrCreateStyleForClassPath(selectedNames, webflowApi);
    if (targetStyle) {
      styleRef.current = targetStyle;
    }
  } else if (
    !selectedNames.length &&
    !canWriteClipPathValue(targetStyle, valueToWrite) &&
    webflowApi
  ) {
    targetStyle = await resolveWritableClipPathStyleForElement(
      (await webflowApi.getSelectedElement?.()) || undefined,
      webflowApi,
      valueToWrite,
      styleOptionsForBreakpoint(writer.activeBreakpointRef.current),
    );
    if (targetStyle) {
      styleRef.current = targetStyle;
    }
  }
  return targetStyle;
}

// After a write: the label's origin (none, or set at this breakpoint) and the class
// it was written to.
async function recordClipPathWrite(
  writer: ClipPathWriter,
  targetStyle: StyleHandle | undefined,
  valueToWrite: string,
): Promise<void> {
  const nextOrigin =
    isNoneClipPathValue(valueToWrite) &&
    !styleOptionsForBreakpoint(writer.activeBreakpointRef.current)
      ? 'none'
      : 'current';
  writer.setClipPathStyleOrigin(nextOrigin);
  if (nextOrigin === 'current' && targetStyle) {
    const writtenStyleNamePath = await getStyleNamePath(targetStyle);
    writer.setAppliedClassName(writtenStyleNamePath[writtenStyleNamePath.length - 1] || undefined);
  } else {
    writer.setAppliedClassName(undefined);
  }
}

// Clearing the timers on unmount, the preset option ids, and handle classes.
function useTimerCleanup(editor: EditorAfterWindowKeyListeners) {
  const { writeTimerRef, presetTypeaheadTimerRef, codeTransitionTimerRef } = editor;
  const { stopKeyboardMoveLoop, activePreset, shape, activePresetIndex } = editor;
  const { codeHandleColorClasses, polygonPointColors, selectedHandle } = editor;
  const { selectedCodeHandles, activeInsetModifierMode } = editor;
  // The cleanup runs once, on unmount; it stops the loop through the latest render's
  // handler.
  const stopKeyboardMoveLoopRef = useRef(stopKeyboardMoveLoop);
  stopKeyboardMoveLoopRef.current = stopKeyboardMoveLoop;
  useEffect(() => {
    const stopLatestKeyboardMoveLoop = () => stopKeyboardMoveLoopRef.current();
    return () => {
      if (writeTimerRef.current !== undefined) {
        window.clearTimeout(writeTimerRef.current);
        writeTimerRef.current = undefined;
      }
      if (presetTypeaheadTimerRef.current !== undefined) {
        window.clearTimeout(presetTypeaheadTimerRef.current);
        presetTypeaheadTimerRef.current = undefined;
      }
      if (codeTransitionTimerRef.current !== undefined) {
        window.clearTimeout(codeTransitionTimerRef.current);
        codeTransitionTimerRef.current = undefined;
      }
      stopLatestKeyboardMoveLoop();
    };
  }, [writeTimerRef, presetTypeaheadTimerRef, codeTransitionTimerRef]);

  const selectedPresetShape = PRESETS[activePreset] || shape;
  const activePresetOptionName = PRESET_NAMES[activePresetIndex] || PRESET_NAMES[0] || NONE_PRESET;
  const activePresetOptionId = presetOptionId(activePresetOptionName);
  const handleDisplayColorClass = (handle: HandleTarget) => {
    const codeColorClass = codeHandleColorClasses.get(handleKey(handle));
    if (codeColorClass) {
      return codeColorClass;
    }
    if (handle.kind === 'polygon-point') {
      return polygonPointColorClass(handle.index, polygonPointColors);
    }
    if (
      handle.kind === 'inset-radius' &&
      shape.kind === 'inset' &&
      !hasRoundedCorners(shape.radii)
    ) {
      return HANDLE_COLOR_CLASSES[4];
    }
    return handleColorClass(handle);
  };
  const handleClassName = (handle: HandleTarget, extra?: string) =>
    [
      'clip-path_handle',
      handleDisplayColorClass(handle),
      extra,
      handlesMatch(selectedHandle, handle) ||
      selectedCodeHandles.some((selected) => handlesMatch(selected, handle))
        ? 'is-selected'
        : '',
      isInsetHandleAffected(selectedHandle, handle, activeInsetModifierMode) ? 'is-affected' : '',
    ]
      .filter(Boolean)
      .join(' ');
  const isHandleSelected = (handle: HandleTarget) =>
    handlesMatch(selectedHandle, handle) ||
    selectedCodeHandles.some((selected) => handlesMatch(selected, handle));
  return {
    selectedPresetShape,
    activePresetOptionName,
    activePresetOptionId,
    handleDisplayColorClass,
    handleClassName,
    isHandleSelected,
  };
}

type EditorAfterTimerCleanup = EditorAfterWindowKeyListeners & ReturnType<typeof useTimerCleanup>;

// Adding and removing polygon points.
function pointEditActions(editor: EditorAfterTimerCleanup) {
  const { canvasRef, shape, markLocalShapeChange, insertPolygonPointColor, setShape } = editor;
  const { shapeRef, commit, setActivePreset, polygonPointColorsRef, setHandleSelection } = editor;
  const { syncPolygonPointColors, focusSelectedHandle } = editor;
  const onAddPoint = (event: React.MouseEvent) => {
    if (!canvasRef.current || shape.kind !== 'polygon') {
      return;
    }
    markLocalShapeChange();
    const rect = canvasRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    insertPolygonPointColor(shape.points.length, shape.points.length);
    setShape((current) => {
      if (current.kind !== 'polygon') {
        return current;
      }
      const next: ClipShape = { kind: 'polygon', points: [...current.points, { x, y }] };
      shapeRef.current = next;
      commit(next);
      return next;
    });
    setActivePreset('Polygon');
  };

  const onRemovePoint = (index: number) => {
    if (shape.kind !== 'polygon' || shape.points.length <= 3) {
      return;
    }
    const indexesToDelete = new Set([index]);
    const previousOldIndex = previousSurvivingPolygonIndex(
      shape.points.length,
      indexesToDelete,
      index,
    );
    const previousNewIndex =
      previousOldIndex === undefined
        ? undefined
        : remapPolygonIndexAfterDelete(previousOldIndex, indexesToDelete);
    const nextSelectedHandle: HandleTarget | undefined =
      previousNewIndex === undefined
        ? undefined
        : { kind: 'polygon-point', index: previousNewIndex };
    const next: ClipShape = {
      kind: 'polygon',
      points: shape.points.filter((_, i) => i !== index),
    };
    const nextColors = normalizePolygonPointColors(
      shape.points.length,
      polygonPointColorsRef.current,
    ).filter((_, i) => i !== index);

    markLocalShapeChange();
    setHandleSelection(nextSelectedHandle);
    syncPolygonPointColors(nextColors);
    shapeRef.current = next;
    setShape(next);
    commit(next);
    setActivePreset('Polygon');
    if (nextSelectedHandle) {
      focusSelectedHandle();
    }
  };
  return { onAddPoint, onRemovePoint };
}

type EditorAfterPointEditActions = EditorAfterTimerCleanup & ReturnType<typeof pointEditActions>;

// Starting a marquee selection.
function marqueeStartActions(editor: EditorAfterPointEditActions) {
  const { dragTargetRef, polygonSelectionDragRef, shapeRef, canvasPointFromClient } = editor;
  const { cancelPendingSelectionRead, closePresetDropdown, stopCodeTransition } = editor;
  const { stopKeyboardMoveLoop, selectedHandlesRef, setSelectionRect, activePointerIdRef } = editor;
  const { activePointerCaptureRef, finishPolygonSelectionDrag } = editor;
  const beginPolygonSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (dragTargetRef.current || polygonSelectionDragRef.current) {
      return;
    }
    if (shapeRef.current.kind !== 'polygon') {
      return;
    }
    if (event.target instanceof Element && event.target.closest('.clip-path_handle')) {
      return;
    }

    const start = canvasPointFromClient(event.clientX, event.clientY);
    if (!start) {
      return;
    }

    cancelPendingSelectionRead();
    closePresetDropdown();
    stopCodeTransition();
    stopKeyboardMoveLoop();
    const baseHandles = event.shiftKey
      ? selectedHandlesRef.current.filter(isPolygonPointHandle)
      : [];

    polygonSelectionDragRef.current = {
      pointerId: event.pointerId,
      start,
      current: start,
      startClient: { x: event.clientX, y: event.clientY },
      didMove: false,
      additive: event.shiftKey,
      baseHandles,
    };
    setSelectionRect(undefined);
    activePointerIdRef.current = event.pointerId;
    activePointerCaptureRef.current = event.currentTarget;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.addEventListener(
        'lostpointercapture',
        () => finishPolygonSelectionDrag(false),
        { once: true },
      );
    } catch {
      /* setPointerCapture can fail if the host has already cancelled the pointer */
    }
  };
  return { beginPolygonSelectionDrag };
}

type EditorAfterMarqueeStartActions = EditorAfterPointEditActions &
  ReturnType<typeof marqueeStartActions>;

// Starting a shape move or resize.
function transformStartActions(editor: EditorAfterMarqueeStartActions) {
  const { dragTargetRef, polygonSelectionDragRef, shapeTransformDragRef, shapeRef } = editor;
  const { shapeFitModeRef, canvasPointFromClient, cancelPendingSelectionRead } = editor;
  const { closePresetDropdown, clearPastedShapeSvgCache, selectHandle } = editor;
  const { stopCodeTransition, stopKeyboardMoveLoop, setShapeTransformSelection } = editor;
  const { currentShapeScaleOptions, activePointerIdRef, activePointerCaptureRef } = editor;
  const { finishShapeTransformDrag } = editor;
  const beginShapeTransformDrag =
    (mode: ShapeTransformDrag['mode'], corner?: ShapeResizeCorner) =>
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }
      if (
        dragTargetRef.current ||
        polygonSelectionDragRef.current ||
        shapeTransformDragRef.current
      ) {
        return;
      }

      const currentShape = shapeRef.current;
      if (currentShape.kind !== 'shape') {
        return;
      }
      if (shapeFitModeRef.current === 'stretch' && !hasContainerQueryUnit(currentShape.value)) {
        return;
      }

      const start = canvasPointFromClient(event.clientX, event.clientY);
      const bounds = shapeCssBounds(currentShape);
      if (!start || !bounds) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      cancelPendingSelectionRead();
      closePresetDropdown();
      clearPastedShapeSvgCache();
      selectHandle(undefined);
      stopCodeTransition();
      stopKeyboardMoveLoop();
      setShapeTransformSelection(true);

      const fitMode: ShapeFitMode =
        shapeFitModeRef.current === 'contain' || hasContainerQueryUnit(currentShape.value)
          ? 'contain'
          : 'stretch';
      shapeTransformDragRef.current = {
        pointerId: event.pointerId,
        mode,
        ...(corner ? { corner } : {}),
        start,
        before: currentShape,
        bounds,
        fitMode,
        scaleOptions: currentShapeScaleOptions(),
      };
      activePointerIdRef.current = event.pointerId;
      activePointerCaptureRef.current = event.currentTarget;

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.addEventListener(
          'lostpointercapture',
          () => finishShapeTransformDrag(false),
          { once: true },
        );
      } catch {
        /* setPointerCapture can fail if the host has already cancelled the pointer */
      }
    };
  return { beginShapeTransformDrag };
}

type EditorAfterTransformStartActions = EditorAfterMarqueeStartActions &
  ReturnType<typeof transformStartActions>;

// Starting a handle drag.
function dragStartActions(editor: EditorAfterTransformStartActions) {
  const { canvasPointFromClient, cancelPendingSelectionRead, duplicatePolygonPoint } = editor;
  const { setHandleSelection, selectHandleFromPointer, polygonDisplayProjectionsRef } = editor;
  const { syncInsetModifierMode, stopCodeTransition, dragTargetRef, targetWithDragOrigin } = editor;
  const { activePointerIdRef, activePointerCaptureRef, finishDrag } = editor;
  const beginDrag = (target: DragTarget) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    const pointerStart = canvasPointFromClient(event.clientX, event.clientY);
    if (!pointerStart) {
      return;
    }

    event.preventDefault();
    cancelPendingSelectionRead();
    event.currentTarget.focus({ preventScroll: true });
    let handle = handleFromDragTarget(target);
    let dragStartTarget = target;
    let nextSelection: HandleTarget[];

    if (target.kind === 'polygon-point' && event.altKey) {
      const duplicate = duplicatePolygonPoint(target.index, {
        commitChange: false,
        selectDuplicate: false,
      });
      if (duplicate) {
        handle = duplicate.handle;
        dragStartTarget = { ...duplicate.handle, before: duplicate.shape, optionDuplicated: true };
        setHandleSelection(duplicate.handle);
        nextSelection = [duplicate.handle];
      } else {
        nextSelection = selectHandleFromPointer(handle, { additive: event.shiftKey });
      }
    } else {
      nextSelection = selectHandleFromPointer(handle, { additive: event.shiftKey });
    }

    const selectedPolygonIndexes = isPolygonPointHandle(handle)
      ? nextSelection.filter(isPolygonPointHandle).map((selected) => selected.index)
      : undefined;
    const nextTarget = selectedPolygonIndexes?.length
      ? { ...dragStartTarget, polygonPointIndexes: selectedPolygonIndexes }
      : dragStartTarget;

    if (nextTarget.kind === 'polygon-point') {
      const projectionIndexes = nextTarget.polygonPointIndexes || [nextTarget.index];
      projectionIndexes.forEach((index) => {
        polygonDisplayProjectionsRef.current.delete(index);
      });
    }
    syncInsetModifierMode(event);
    stopCodeTransition();
    dragTargetRef.current = targetWithDragOrigin(nextTarget, pointerStart);
    activePointerIdRef.current = event.pointerId;
    activePointerCaptureRef.current = event.currentTarget;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.addEventListener('lostpointercapture', () => finishDrag(false), {
        once: true,
      });
    } catch {
      /* setPointerCapture can fail if the host has already cancelled the pointer */
    }
  };
  return { beginDrag };
}

type EditorAfterDragStartActions = EditorAfterTransformStartActions &
  ReturnType<typeof dragStartActions>;

// The handles' keys, and where the inset handles sit.
function handleGeometry(editor: EditorAfterDragStartActions) {
  const { handledKeyboardEventsRef, selectHandleForKeyboard, spaceKeyPressedRef } = editor;
  const { pressKeyboardMoveKey, updateKeyboardModifierRefs, releaseKeyboardMoveKey } = editor;
  const { shape } = editor;
  const onHandleKeyDown =
    (handle: HandleTarget) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (isSpaceKey(event.key, event.code)) {
        handledKeyboardEventsRef.current.add(event.nativeEvent);
        stopKeyboardEvent(event);
        selectHandleForKeyboard(handle);
        spaceKeyPressedRef.current = true;
        return;
      }

      if (!isArrowKey(event.key) || event.metaKey || event.ctrlKey) {
        return;
      }
      handledKeyboardEventsRef.current.add(event.nativeEvent);
      stopKeyboardEvent(event);
      pressKeyboardMoveKey(handle, event.key, event);
    };

  const onHandleKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isSpaceKey(event.key, event.code)) {
      handledKeyboardEventsRef.current.add(event.nativeEvent);
      stopKeyboardEvent(event);
      spaceKeyPressedRef.current = false;
      return;
    }

    updateKeyboardModifierRefs(event);
    if (!isArrowKey(event.key)) {
      return;
    }

    handledKeyboardEventsRef.current.add(event.nativeEvent);
    stopKeyboardEvent(event);
    releaseKeyboardMoveKey(event.key, event);
  };

  const insetWidth = shape.kind === 'inset' ? 100 - shape.left - shape.right : 0;
  const insetHeight = shape.kind === 'inset' ? 100 - shape.top - shape.bottom : 0;
  const insetCenterX = shape.kind === 'inset' ? shape.left + insetWidth / 2 : 0;
  const insetCenterY = shape.kind === 'inset' ? shape.top + insetHeight / 2 : 0;
  const insetRadii = shape.kind === 'inset' ? shape.radii : makeInsetRadii(0);
  const insetRadiusHandlePosition = (corner: CornerName) => {
    const radius = insetRadii[corner];
    if (shape.kind !== 'inset') {
      return { x: 0, y: 0 };
    }
    const canvasRadius = insetRadiusToCanvas(shape, radius);
    if (corner === 'topLeft') {
      return { x: shape.left + canvasRadius.x, y: shape.top + canvasRadius.y };
    }
    if (corner === 'topRight') {
      return { x: 100 - shape.right - canvasRadius.x, y: shape.top + canvasRadius.y };
    }
    if (corner === 'bottomRight') {
      return { x: 100 - shape.right - canvasRadius.x, y: 100 - shape.bottom - canvasRadius.y };
    }
    return { x: shape.left + canvasRadius.x, y: 100 - shape.bottom - canvasRadius.y };
  };
  return {
    onHandleKeyDown,
    onHandleKeyUp,
    insetWidth,
    insetHeight,
    insetCenterX,
    insetCenterY,
    insetRadii,
    insetRadiusHandlePosition,
  };
}

type EditorAfterHandleGeometry = EditorAfterDragStartActions & ReturnType<typeof handleGeometry>;

// Where the circle handle and the shape bounds sit, and the source label.
function renderGeometry(editor: EditorAfterHandleGeometry) {
  const { shape, circleRadiusAngle, handleBounds, canvasSize, clipPathStyleOrigin } = editor;
  const { selectedClassNames } = editor;
  const circleRadiusHandleX =
    shape.kind === 'circle' ? shape.cx + Math.cos(circleRadiusAngle) * shape.radius : 0;
  const circleRadiusHandleY =
    shape.kind === 'circle' ? shape.cy + Math.sin(circleRadiusAngle) * shape.radius : 0;
  const handlePositionStyle = (x: number, y: number) => {
    const nextX =
      handleBounds && handleBounds.minX <= handleBounds.maxX
        ? clampValue(x, handleBounds.minX, handleBounds.maxX)
        : x;
    const nextY =
      handleBounds && handleBounds.minY <= handleBounds.maxY
        ? clampValue(y, handleBounds.minY, handleBounds.maxY)
        : y;
    return { left: `${nextX}%`, top: `${nextY}%` };
  };
  const handleCssPositionStyle = (x: string, y: string) => {
    const previewX = canvasSize
      ? previewCssCoordinateToken(x, 'x', canvasSize)
      : addPreviewVariableFallbacks(x);
    const previewY = canvasSize
      ? previewCssCoordinateToken(y, 'y', canvasSize)
      : addPreviewVariableFallbacks(y);
    const left =
      handleBounds && handleBounds.minX <= handleBounds.maxX
        ? `clamp(${handleBounds.minX}%, ${previewX}, ${handleBounds.maxX}%)`
        : previewX;
    const top =
      handleBounds && handleBounds.minY <= handleBounds.maxY
        ? `clamp(${handleBounds.minY}%, ${previewY}, ${handleBounds.maxY}%)`
        : previewY;
    return { left, top };
  };
  const activeShapeBounds = shape.kind === 'shape' ? shapeCssBounds(shape) : undefined;
  const shapeBoundsStyle = activeShapeBounds
    ? {
        left: `${activeShapeBounds.left}%`,
        top: `${activeShapeBounds.top}%`,
        width: `${activeShapeBounds.width}%`,
        height: `${activeShapeBounds.height}%`,
      }
    : undefined;

  const clipPathLabelClassName = [
    'clip-path_control-label',
    clipPathStyleOrigin === 'current' ? 'is-current' : '',
    clipPathStyleOrigin === 'inherited' ? 'is-inherited' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const selectedSelector = selectedClassNames.length
    ? selectedClassNames.map((name) => `.${name}`).join('')
    : undefined;
  return {
    circleRadiusHandleX,
    circleRadiusHandleY,
    handlePositionStyle,
    handleCssPositionStyle,
    activeShapeBounds,
    shapeBoundsStyle,
    clipPathLabelClassName,
    selectedSelector,
  };
}

type EditorAfterRenderGeometry = EditorAfterHandleGeometry & ReturnType<typeof renderGeometry>;

// The editor as the view components read it.
type ClipPathEditor = EditorAfterRenderGeometry;
type EditorProps = { editor: ClipPathEditor };

// The editor: the class tags, the preset menu, the canvas, and the code.
function ClipPathView({ editor }: EditorProps) {
  const { shortcutHelpPortalTarget, hideClassPicker, codeValue } = editor;
  const { selectedCodeTokenHighlights, onCodeChange, onCodeSelectionChange } = editor;
  return (
    <div className="clip-path_component">
      {shortcutHelpPortalTarget
        ? createPortal(<ShortcutHelpControl editor={editor} />, shortcutHelpPortalTarget)
        : undefined}
      {hideClassPicker ? undefined : <ClassTagsControl editor={editor} />}
      <PresetControl editor={editor} />
      <ClipPathCanvas editor={editor} />
      <ShapeFitControl editor={editor} />
      <ShapeScaleVariableControl editor={editor} />

      <CodeEditor
        id="clip-path_css-output"
        className="clip-path_code"
        value={codeValue}
        language="css"
        ariaLabel="Editable clip-path CSS"
        tokenHighlights={selectedCodeTokenHighlights}
        onChange={onCodeChange}
        onSelectionChange={onCodeSelectionChange}
      />
    </div>
  );
}

// The element's classes as tags; picking some targets their style.
function ClassTagsControl({ editor }: EditorProps) {
  const { elementClassNames, selectedClassNames, handleClassSelectionChange } = editor;
  const { selectedSelector } = editor;
  if (!elementClassNames.length) {
    return undefined;
  }
  return (
    <ClassPicker
      className="clip-path_classes"
      tokens={elementClassNames.map((name) => ({ name, kind: 'class' }))}
      selected={selectedClassNames}
      onChange={handleClassSelectionChange}
      tagTitle={(token, isActive) =>
        selectedSelector && isActive
          ? `Editing clip path on ${selectedSelector}`
          : `Edit clip path on .${token.name} — Shift/Option-click to combine`
      }
    />
  );
}

// The "Clip Path" label (with its reset menu or its source popover) and the preset
// dropdown.
function PresetControl({ editor }: EditorProps) {
  const { isPresetOpen, isClipPathLabelMenuOpen, clipPathStyleOrigin } = editor;
  const { isShortcutHelpOpen } = editor;
  return (
    <div
      className={[
        'clip-path_control-row',
        isPresetOpen ? 'is-dropdown-open' : '',
        isClipPathLabelMenuOpen && clipPathStyleOrigin !== 'none' ? 'is-label-menu-open' : '',
        isShortcutHelpOpen ? 'is-shortcuts-open' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <ClipPathLabel editor={editor} />
      <div className="clip-path_control-field">
        <PresetDropdown editor={editor} />
      </div>
    </div>
  );
}

// The label: blue when this breakpoint sets the clip-path (a menu to reset it),
// orange when it is inherited (a popover naming where it comes from).
function ClipPathLabel({ editor }: EditorProps) {
  const { clipPathLabelRef, clipPathStyleOrigin, clipPathLabelClassName } = editor;
  const { isClipPathLabelMenuOpen, onClipPathLabelClick, resetCurrentBreakpointClipPath } = editor;
  return (
    <div className="clip-path_control-label-wrap" ref={clipPathLabelRef}>
      {clipPathStyleOrigin !== 'none' ? (
        <button
          id="clip-path_preset-label"
          type="button"
          className={`${clipPathLabelClassName} clip-path_control-label-button`}
          aria-haspopup={clipPathStyleOrigin === 'current' ? 'menu' : 'dialog'}
          aria-expanded={isClipPathLabelMenuOpen}
          onClick={onClipPathLabelClick}
        >
          Clip Path
        </button>
      ) : (
        <span className={clipPathLabelClassName} id="clip-path_preset-label">
          Clip Path
        </span>
      )}
      {isClipPathLabelMenuOpen && clipPathStyleOrigin === 'current' ? (
        <div className="clip-path_label-menu" role="menu">
          <button
            type="button"
            className="clip-path_label-menu-item"
            role="menuitem"
            onClick={() => void resetCurrentBreakpointClipPath()}
          >
            <svg className="clip-path_label-menu-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.2 5.2H2.2V2.2" />
              <path d="M2.6 5.2A5.5 5.5 0 1 1 4 12.2" />
            </svg>
            <span>Reset</span>
            <span className="clip-path_label-menu-shortcut">Option + click</span>
          </button>
        </div>
      ) : undefined}
      {isClipPathLabelMenuOpen && clipPathStyleOrigin === 'inherited' ? (
        <ClipPathSourceMenu editor={editor} />
      ) : undefined}
    </div>
  );
}

// Where an inherited clip-path comes from: its breakpoint and its selector.
function ClipPathSourceMenu({ editor }: EditorProps) {
  const { clipPathSourceBreakpoint, clipPathSourceSelector, appliedClassName } = editor;
  return (
    <div
      className="clip-path_label-menu clip-path_source-menu"
      role="dialog"
      aria-label="Clip path value source"
    >
      <span className="clip-path_source-title">Value comes from:</span>
      <div className="clip-path_source-row">
        {clipPathSourceBreakpoint ? (
          <span
            className="clip-path_source-breakpoint"
            title={BREAKPOINT_LABELS[clipPathSourceBreakpoint]}
          >
            <BreakpointIcon breakpoint={clipPathSourceBreakpoint} />
            {BREAKPOINT_LABELS[clipPathSourceBreakpoint]}
          </span>
        ) : undefined}
        {(clipPathSourceSelector.length
          ? clipPathSourceSelector
          : appliedClassName
            ? [appliedClassName]
            : []
        ).map((name) => (
          <span className="clip-path_source-class" key={name}>
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

// The preset button and, while open, its listbox.
function PresetDropdown({ editor }: EditorProps) {
  const { presetDropdownRef, presetButtonRef, isPresetOpen, closePresetDropdown } = editor;
  const { setIsShortcutHelpOpen, openPresetDropdown, onPresetButtonKeyDown } = editor;
  const { selectedPresetShape, activePreset } = editor;
  return (
    <div className="clip-path_preset" ref={presetDropdownRef}>
      <button
        id="clip-path_preset-button"
        ref={presetButtonRef}
        type="button"
        className="clip-path_preset-button"
        aria-haspopup="listbox"
        aria-expanded={isPresetOpen}
        aria-controls="clip-path_preset-listbox"
        aria-labelledby="clip-path_preset-label clip-path_preset-button"
        onClick={() => {
          if (isPresetOpen) {
            closePresetDropdown();
          } else {
            setIsShortcutHelpOpen(false);
            openPresetDropdown();
          }
        }}
        onKeyDown={onPresetButtonKeyDown}
      >
        <span className="clip-path_preset-value">
          <PresetIcon shape={selectedPresetShape} />
          <span className="clip-path_preset-name">{activePreset}</span>
        </span>
        <svg className="clip-path_preset-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 6.2 8 10l3.8-3.8" />
        </svg>
      </button>

      {isPresetOpen ? <PresetList editor={editor} /> : undefined}
    </div>
  );
}

// The presets, each with its icon; hovering one makes it the active option.
function PresetList({ editor }: EditorProps) {
  const { presetListRef, activePresetOptionId, onPresetListKeyDown, activePreset } = editor;
  const { activePresetIndex, setActivePresetIndex, choosePreset } = editor;
  return (
    <div
      id="clip-path_preset-listbox"
      ref={presetListRef}
      className="clip-path_preset-list"
      role="listbox"
      tabIndex={-1}
      aria-labelledby="clip-path_preset-label"
      aria-activedescendant={activePresetOptionId}
      onKeyDown={onPresetListKeyDown}
    >
      {PRESET_NAMES.map((name, index) => {
        const optionShape = PRESETS[name];
        if (!optionShape) {
          return undefined;
        }
        const isSelected = activePreset === name;

        return (
          <div
            key={name}
            id={presetOptionId(name)}
            className={[
              'clip-path_preset-option',
              index === activePresetIndex ? 'is-active' : '',
              isSelected ? 'is-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="option"
            aria-selected={isSelected}
            onMouseEnter={() => setActivePresetIndex(index)}
            onClick={() => choosePreset(name)}
          >
            <PresetIcon shape={optionShape} />
            <span className="clip-path_preset-name">{name}</span>
          </div>
        );
      })}
    </div>
  );
}

// How a pasted shape fits the element: scaled to the container, or stretched.
function ShapeFitControl({ editor }: EditorProps) {
  const { activePreset, shapeFitMode, setShapeFitModeFromControl } = editor;
  if (activePreset !== 'Shape') {
    return undefined;
  }
  return (
    <div className="clip-path_control-row clip-path_control-row--with-help">
      <label className="clip-path_control-label" id="clip-path_shape-fit-label">
        Fit
      </label>
      <div className="clip-path_control-field">
        <SegmentedControl<ShapeFitMode>
          ariaLabel="Fit"
          value={shapeFitMode}
          onChange={setShapeFitModeFromControl}
          options={[
            { value: 'contain', label: 'Scale' },
            { value: 'stretch', label: 'Stretch' },
          ]}
        />
      </div>
      {shapeFitMode === 'contain' ? (
        <p className="clip-path_control-help">
          <svg className="clip-path_control-help-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" />
            <path d="M6.5 6.2a2 2 0 0 1 3.8.9c0 1.8-2.2 1.6-2.2 3" />
            <path d="M8 12.2h.01" />
          </svg>
          <span>Apply container-type: size; to the parent</span>
        </p>
      ) : undefined}
    </div>
  );
}

// A shape-variable row's label, with its explanation on hover.
function ShapeVariableLabel({ id, text, tip }: { id: string; text: string; tip: string }) {
  return (
    <div className="clip-path_label-with-help">
      <label className="clip-path_control-label" id={id}>
        {text}
      </label>
      <span className="clip-path_label-help">
        <button type="button" className="clip-path_label-help-button" aria-label={tip}>
          <svg className="clip-path_label-help-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" />
            <path d="M6.5 6.2a2 2 0 0 1 3.8.9c0 1.8-2.2 1.6-2.2 3" />
            <path d="M8 12.2h.01" />
          </svg>
        </button>
        <span className="clip-path_label-help-tip" aria-hidden="true">
          {tip}
        </span>
      </span>
    </div>
  );
}

// A shape-variable name field; the name is tidied into a custom property on blur.
function ShapeVariableInput({
  id,
  labelId,
  value,
  placeholder,
  apply,
}: {
  id: string;
  labelId: string;
  value: string;
  placeholder: string;
  apply: (name: string) => void;
}) {
  return (
    <div className="clip-path_control-field clip-path_variable-field">
      <input
        id={id}
        className="u-input clip-path_variable-input"
        value={value}
        onChange={(event) => apply(event.target.value)}
        onBlur={(event) => {
          const formatted = formatShapeVariableName(event.target.value);
          if (event.target.value !== formatted) {
            apply(formatted);
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-labelledby={labelId}
      />
    </div>
  );
}

// The variables a scaled shape reads: its size and its X / Y offsets.
function ShapeScaleVariableControl({ editor }: EditorProps) {
  const { activePreset, shapeFitMode, shapeScaleVariableName } = editor;
  const { setShapeScaleOptionsFromControl, currentShapeScaleOptions } = editor;
  const { shapeOffsetLeftVariableName, shapeOffsetTopVariableName } = editor;
  if (activePreset !== 'Shape' || shapeFitMode !== 'contain') {
    return undefined;
  }
  const apply = (overrides: ShapeScaleOptionOverrides) =>
    setShapeScaleOptionsFromControl(currentShapeScaleOptions(overrides));
  return (
    <>
      <div className="clip-path_control-row">
        <ShapeVariableLabel
          id="clip-path_shape-variable-label"
          text="Size"
          tip={
            'This optional variable allows us to animate shape size or change size based on ' +
            'screen size'
          }
        />
        <ShapeVariableInput
          id="clip-path_shape-variable-input"
          labelId="clip-path_shape-variable-label"
          value={shapeScaleVariableName}
          placeholder={SHAPE_SCALE_VARIABLE_PLACEHOLDER}
          apply={(name) => apply({ variableName: name })}
        />
      </div>
      <div className="clip-path_control-row">
        <ShapeVariableLabel
          id="clip-path_shape-offset-left-label"
          text="Offset X"
          tip="Optional variable to animate or shift the shape horizontally (0 = left, 1 = right)."
        />
        <ShapeVariableInput
          id="clip-path_shape-offset-left-input"
          labelId="clip-path_shape-offset-left-label"
          value={shapeOffsetLeftVariableName}
          placeholder={SHAPE_OFFSET_LEFT_VARIABLE_PLACEHOLDER}
          apply={(name) => apply({ offsetLeftVariableName: name })}
        />
      </div>
      <div className="clip-path_control-row">
        <ShapeVariableLabel
          id="clip-path_shape-offset-top-label"
          text="Offset Y"
          tip="Optional variable to animate or shift the shape vertically (0 = top, 1 = bottom)."
        />
        <ShapeVariableInput
          id="clip-path_shape-offset-top-input"
          labelId="clip-path_shape-offset-top-label"
          value={shapeOffsetTopVariableName}
          placeholder={SHAPE_OFFSET_TOP_VARIABLE_PLACEHOLDER}
          apply={(name) => apply({ offsetTopVariableName: name })}
        />
      </div>
    </>
  );
}

// The "?" button in the header and its keyboard-shortcut popover.
function ShortcutHelpControl({ editor }: EditorProps) {
  const { shortcutHelpRef, isShortcutHelpOpen, closePresetDropdown } = editor;
  const { setIsShortcutHelpOpen, selectedPresetShape, activePreset } = editor;
  return (
    <div className="clip-path_shortcuts" ref={shortcutHelpRef}>
      <button
        type="button"
        className="clip-path_shortcuts-button"
        aria-label="Show Clip Path shortcuts"
        aria-haspopup="dialog"
        aria-expanded={isShortcutHelpOpen}
        aria-controls="clip-path_shortcuts-popover"
        onClick={() => {
          closePresetDropdown();
          setIsShortcutHelpOpen((isOpen) => !isOpen);
        }}
      >
        <svg className="clip-path_shortcuts-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6.4 6.2a1.8 1.8 0 1 1 2.9 1.4c-.7.5-1.1.8-1.1 1.8" />
          <path d="M8 11.8h.01" />
        </svg>
      </button>
      {isShortcutHelpOpen ? (
        <div
          id="clip-path_shortcuts-popover"
          className="clip-path_shortcuts-popover"
          role="dialog"
          aria-label="Clip Path shortcuts"
        >
          <div className="clip-path_shortcuts-header">
            <span className="clip-path_shortcuts-title">Shortcuts</span>
            <span className="clip-path_shortcuts-preset">
              <PresetIcon shape={selectedPresetShape} />
              <span className="clip-path_shortcuts-preset-name">{activePreset}</span>
            </span>
          </div>
          <ShortcutHelpGroups editor={editor} />
        </div>
      ) : undefined}
    </div>
  );
}

// The shortcuts for the current shape, grouped.
function ShortcutHelpGroups({ editor }: EditorProps) {
  const { shortcutHelpGroups } = editor;
  return (
    <div className="clip-path_shortcuts-body">
      {shortcutHelpGroups.map((group) => (
        <section className="clip-path_shortcuts-group" key={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {group.items.map((item) => (
              <div key={`${group.title}-${item.keys}`}>
                <dt>
                  {item.keys.split(' + ').map((key, index) => (
                    <kbd className="clip-path_shortcuts-key" key={index}>
                      {key}
                    </kbd>
                  ))}
                </dt>
                <dd>{item.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

// The canvas: the clipped preview, the drag guides and marquee, and the handles.
function ClipPathCanvas({ editor }: EditorProps) {
  const { canvasWrapRef, beginPolygonSelectionDrag, isCodeTransitioning, canvasRef } = editor;
  const { shape, onAddPoint, previewCss } = editor;
  return (
    <div
      className="clip-path_canvas-wrap"
      ref={canvasWrapRef}
      onPointerDown={beginPolygonSelectionDrag}
    >
      <div
        className={['clip-path_canvas', isCodeTransitioning ? 'is-code-transitioning' : '']
          .filter(Boolean)
          .join(' ')}
        ref={canvasRef}
        onDoubleClick={shape.kind === 'polygon' ? onAddPoint : undefined}
      >
        <div
          className={['clip-path_preview', isCodeTransitioning ? 'is-code-transitioning' : '']
            .filter(Boolean)
            .join(' ')}
          style={{ clipPath: previewCss, WebkitClipPath: previewCss }}
        />
        <CanvasGuides editor={editor} />
        <ShapeBoundsControls editor={editor} />
        <RawPolygonHandles editor={editor} />
        <RawCircleHandles editor={editor} />
        <RawEllipseHandles editor={editor} />
        <RawInsetHandles editor={editor} />
        <PolygonHandles editor={editor} />
        <CircleHandles editor={editor} />
        <EllipseHandles editor={editor} />
        <InsetHandles editor={editor} />
      </div>
    </div>
  );
}

// The snap guides of a drag in progress, and the marquee.
function CanvasGuides({ editor }: EditorProps) {
  const { snapGuides, selectionRect } = editor;
  return (
    <>
      {snapGuides ? (
        <>
          {snapGuides.x.map((x) => (
            <div key={`x-${x}`} className="clip-path_snap-guide is-x" style={{ left: `${x}%` }} />
          ))}
          {snapGuides.y.map((y) => (
            <div key={`y-${y}`} className="clip-path_snap-guide is-y" style={{ top: `${y}%` }} />
          ))}
        </>
      ) : undefined}
      {selectionRect ? (
        <div
          className="clip-path_selection-box"
          style={{
            left: `${selectionRect.left}%`,
            top: `${selectionRect.top}%`,
            width: `${selectionRect.width}%`,
            height: `${selectionRect.height}%`,
          }}
        />
      ) : undefined}
    </>
  );
}

// A scaled shape's bounding box: drag inside it to move, drag a corner to resize.
function ShapeBoundsControls({ editor }: EditorProps) {
  const { shape, activeShapeBounds, shapeFitMode, isShapeTransformSelected } = editor;
  const { shapeBoundsStyle, beginShapeTransformDrag, handlePositionStyle } = editor;
  if (shape.kind !== 'shape' || !activeShapeBounds || shapeFitMode !== 'contain') {
    return undefined;
  }
  return (
    <>
      <div
        className={['clip-path_shape-bounds', isShapeTransformSelected ? 'is-selected' : '']
          .filter(Boolean)
          .join(' ')}
        style={shapeBoundsStyle}
        aria-hidden="true"
      />
      <div
        className="clip-path_shape-move"
        style={shapeBoundsStyle}
        onPointerDown={beginShapeTransformDrag('move')}
        aria-label="Move shape"
        role="button"
        tabIndex={-1}
      />
      {CORNERS.map((corner) => {
        const point = shapeResizeCornerPoint(activeShapeBounds, corner);
        return (
          <button
            key={corner}
            type="button"
            className={[
              'clip-path_shape-resize',
              `is-${corner}`,
              isShapeTransformSelected ? 'is-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={handlePositionStyle(point.x, point.y)}
            onPointerDown={beginShapeTransformDrag('resize', corner)}
            aria-label={`Resize shape from ${cornerLabel(corner)} corner`}
          />
        );
      })}
    </>
  );
}

// One canvas handle: placed, selectable, draggable, and moved by the arrow keys.
function HandleButton({
  editor,
  handle,
  extra,
  style,
  label,
  onDoubleClick,
}: EditorProps & {
  handle: HandleTarget;
  extra?: string;
  style: CSSProperties;
  label: string;
  onDoubleClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { shape, handleClassName, beginDrag, onHandleKeyDown, onHandleKeyUp } = editor;
  const { isHandleSelected } = editor;
  return (
    <button
      className={handleClassName(handle, extra)}
      style={style}
      onPointerDown={beginDrag({ ...handle, before: shape })}
      onKeyDown={onHandleKeyDown(handle)}
      onKeyUp={onHandleKeyUp}
      onDoubleClick={onDoubleClick}
      aria-pressed={isHandleSelected(handle)}
      aria-label={label}
    />
  );
}

// The points of a polygon written in units the canvas cannot place as plain
// percentages.
function RawPolygonHandles({ editor }: EditorProps) {
  const { shape, handleCssPositionStyle } = editor;
  if (shape.kind !== 'raw' || shape.editable?.kind !== 'polygon') {
    return undefined;
  }
  return shape.editable.points.map((point, index) => {
    const handle: HandleTarget = { kind: 'polygon-point', index };
    return (
      <HandleButton
        key={index}
        editor={editor}
        handle={handle}
        style={handleCssPositionStyle(
          formatCssCoordinateValueForPreview(point.x),
          formatCssCoordinateValueForPreview(point.y),
        )}
        label={`Point ${index + 1}. Drag or use arrow keys to move.`}
      />
    );
  });
}

// The centre and radius of a circle written in raw CSS units.
function RawCircleHandles({ editor }: EditorProps) {
  const { shape, handleCssPositionStyle } = editor;
  if (shape.kind !== 'raw' || shape.editable?.kind !== 'circle') {
    return undefined;
  }
  const center: HandleTarget = { kind: 'circle-center' };
  const radius: HandleTarget = { kind: 'circle-radius' };
  const centerPoint = rawEditableHandleCssPoint(shape.editable, center);
  const radiusPoint = rawEditableHandleCssPoint(shape.editable, radius);
  return (
    <>
      {centerPoint ? (
        <HandleButton
          editor={editor}
          handle={center}
          extra="is-center"
          style={handleCssPositionStyle(centerPoint.x, centerPoint.y)}
          label="Circle center. Drag or use arrow keys to move."
        />
      ) : undefined}
      {radiusPoint ? (
        <HandleButton
          editor={editor}
          handle={radius}
          style={handleCssPositionStyle(radiusPoint.x, radiusPoint.y)}
          label="Circle radius. Drag or use arrow keys to resize."
        />
      ) : undefined}
    </>
  );
}

// The centre and radii of an ellipse written in raw CSS units.
function RawEllipseHandles({ editor }: EditorProps) {
  const { shape, handleCssPositionStyle } = editor;
  if (shape.kind !== 'raw' || shape.editable?.kind !== 'ellipse') {
    return undefined;
  }
  const editable = shape.editable;
  const handles: HandleTarget[] = [
    { kind: 'ellipse-center' },
    { kind: 'ellipse-rx' },
    { kind: 'ellipse-ry' },
  ];
  return handles.map((handle) => {
    const point = rawEditableHandleCssPoint(editable, handle);
    if (!point) {
      return undefined;
    }
    const handleLabel =
      handle.kind === 'ellipse-center'
        ? 'Ellipse center'
        : handle.kind === 'ellipse-rx'
          ? 'Ellipse horizontal radius'
          : 'Ellipse vertical radius';
    return (
      <HandleButton
        key={handle.kind}
        editor={editor}
        handle={handle}
        {...(handle.kind === 'ellipse-center' ? { extra: 'is-center' } : {})}
        style={handleCssPositionStyle(point.x, point.y)}
        label={`${handleLabel}. ${HANDLE_ADJUST_HINT}`}
      />
    );
  });
}

// The edges and corner radii of an inset written in raw CSS units.
function RawInsetHandles({ editor }: EditorProps) {
  const { shape, handleCssPositionStyle } = editor;
  if (shape.kind !== 'raw' || shape.editable?.kind !== 'inset') {
    return undefined;
  }
  const editable = shape.editable;
  const sides: HandleTarget[] = [
    { kind: 'inset-top' },
    { kind: 'inset-right' },
    { kind: 'inset-bottom' },
    { kind: 'inset-left' },
  ];
  const cornerHandle = (corner: CornerName): HandleTarget => ({ kind: 'inset-radius', corner });
  return (
    <>
      {sides.map((handle) => {
        const point = rawEditableHandleCssPoint(editable, handle);
        if (!point) {
          return undefined;
        }
        return (
          <HandleButton
            key={handle.kind}
            editor={editor}
            handle={handle}
            extra="is-inset-side"
            style={handleCssPositionStyle(point.x, point.y)}
            label="Inset edge. Drag or use arrow keys to resize."
          />
        );
      })}
      {editable.radii
        ? CORNERS.map((corner) => {
            const point = rawEditableHandleCssPoint(editable, cornerHandle(corner));
            if (!point) {
              return undefined;
            }
            return (
              <HandleButton
                key={corner}
                editor={editor}
                handle={cornerHandle(corner)}
                extra="is-radius"
                style={handleCssPositionStyle(point.x, point.y)}
                label={`Inset ${cornerLabel(corner)} corner radius. ${HANDLE_ADJUST_HINT}`}
              />
            );
          })
        : undefined}
    </>
  );
}

// A polygon's points. A point outside the canvas is drawn on its edge; the side it
// was projected to is remembered so the handle doesn't jump between sides.
function PolygonHandles({ editor }: EditorProps) {
  const { shape, handleBounds, polygonDisplayProjectionsRef, handlePositionStyle } = editor;
  const { onRemovePoint } = editor;
  if (shape.kind !== 'polygon') {
    return undefined;
  }
  return shape.points.map((point, i) => {
    const handle: HandleTarget = { kind: 'polygon-point', index: i };
    const display = polygonHandleDisplayPoint(
      shape.points,
      i,
      handleBounds,
      polygonDisplayProjectionsRef.current.get(i),
    );
    if (display.projection) {
      polygonDisplayProjectionsRef.current.set(i, display.projection);
    } else {
      polygonDisplayProjectionsRef.current.delete(i);
    }
    return (
      <HandleButton
        key={i}
        editor={editor}
        handle={handle}
        style={handlePositionStyle(display.point.x, display.point.y)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onRemovePoint(i);
        }}
        label={`Point ${i + 1}. ${POINT_HANDLE_HINT}`}
      />
    );
  });
}

// A circle's centre and radius.
function CircleHandles({ editor }: EditorProps) {
  const { shape, handlePositionStyle, circleRadiusHandleX, circleRadiusHandleY } = editor;
  if (shape.kind !== 'circle') {
    return undefined;
  }
  return (
    <>
      <HandleButton
        editor={editor}
        handle={{ kind: 'circle-center' }}
        extra="is-center"
        style={handlePositionStyle(shape.cx, shape.cy)}
        label="Circle center. Drag or use arrow keys to move."
      />
      <HandleButton
        editor={editor}
        handle={{ kind: 'circle-radius' }}
        style={handlePositionStyle(circleRadiusHandleX, circleRadiusHandleY)}
        label="Circle radius. Drag or use arrow keys to resize."
      />
    </>
  );
}

// An ellipse's centre and its two radii.
function EllipseHandles({ editor }: EditorProps) {
  const { shape, handlePositionStyle } = editor;
  if (shape.kind !== 'ellipse') {
    return undefined;
  }
  return (
    <>
      <HandleButton
        editor={editor}
        handle={{ kind: 'ellipse-center' }}
        extra="is-center"
        style={handlePositionStyle(shape.cx, shape.cy)}
        label="Ellipse center. Drag or use arrow keys to move."
      />
      <HandleButton
        editor={editor}
        handle={{ kind: 'ellipse-rx' }}
        style={handlePositionStyle(shape.cx + shape.rx, shape.cy)}
        label="Ellipse horizontal radius. Drag or use any arrow key to resize."
      />
      <HandleButton
        editor={editor}
        handle={{ kind: 'ellipse-ry' }}
        style={handlePositionStyle(shape.cx, shape.cy + shape.ry)}
        label="Ellipse vertical radius. Drag or use any arrow key to resize."
      />
    </>
  );
}

// An inset's four edges and its corner radii.
function InsetHandles({ editor }: EditorProps) {
  const { shape, handlePositionStyle, insetCenterX, insetCenterY } = editor;
  const { insetRadiusHandlePosition } = editor;
  if (shape.kind !== 'inset') {
    return undefined;
  }
  const edges: Array<{ handle: HandleTarget; x: number; y: number; name: string }> = [
    { handle: { kind: 'inset-top' }, x: insetCenterX, y: shape.top, name: 'top' },
    { handle: { kind: 'inset-right' }, x: 100 - shape.right, y: insetCenterY, name: 'right' },
    { handle: { kind: 'inset-bottom' }, x: insetCenterX, y: 100 - shape.bottom, name: 'bottom' },
    { handle: { kind: 'inset-left' }, x: shape.left, y: insetCenterY, name: 'left' },
  ];
  return (
    <>
      {edges.map((edge) => (
        <HandleButton
          key={edge.name}
          editor={editor}
          handle={edge.handle}
          extra="is-inset-side"
          style={handlePositionStyle(edge.x, edge.y)}
          label={`Inset ${edge.name} edge. ${INSET_EDGE_HANDLE_HINT}`}
        />
      ))}
      {CORNERS.map((corner) => {
        const position = insetRadiusHandlePosition(corner);
        return (
          <HandleButton
            key={corner}
            editor={editor}
            handle={{ kind: 'inset-radius', corner }}
            extra="is-radius"
            style={handlePositionStyle(position.x, position.y)}
            label={`Inset ${cornerLabel(corner)} corner radius. ${INSET_RADIUS_HANDLE_HINT}`}
          />
        );
      })}
    </>
  );
}

function useClipPathEditorPart1(editor: ClipPathProps) {
  const stage1 = Object.assign(editor, useShapeState());
  const stage2 = Object.assign(stage1, useHandleSelectionState());
  const stage3 = Object.assign(stage2, useShapeFitState());
  const stage4 = Object.assign(stage3, useStyleSourceState());
  const stage5 = Object.assign(stage4, useCanvasRefs());
  const stage6 = Object.assign(stage5, useWriteRefs());
  const stage7 = Object.assign(stage6, useSelectionRefs());
  const stage8 = Object.assign(stage7, useShapeRefs(stage7));
  const stage9 = Object.assign(stage8, useCodeHighlights(stage8));
  const stage10 = Object.assign(stage9, useSelectedCodeHighlights(stage9));
  const stage11 = Object.assign(stage10, useLatestMirrors(stage10));
  const stage12 = Object.assign(stage11, shapeSyncActions(stage11));
  const stage13 = Object.assign(stage12, shapeScaleSyncActions(stage12));
  const stage14 = Object.assign(stage13, pastedCacheActions(stage13));
  const stage15 = Object.assign(stage14, handleSelectionActions(stage14));
  const stage16 = Object.assign(stage15, pointerSelectionActions(stage15));
  const stage17 = Object.assign(stage16, polygonSelectionActions(stage16));
  const stage18 = Object.assign(stage17, dragSupportActions(stage17));
  const stage19 = Object.assign(stage18, dragFinishActions(stage18));
  const stage20 = Object.assign(stage19, transformDragActions(stage19));
  const stage21 = Object.assign(stage20, selectionLoadActions(stage20));
  const stage22 = Object.assign(stage21, historyActions(stage21));
  const stage23 = Object.assign(stage22, pointDeleteActions(stage22));
  const stage24 = Object.assign(stage23, pointDuplicateActions(stage23));
  const stage25 = Object.assign(stage24, presetChoiceActions(stage24));
  const stage26 = Object.assign(stage25, breakpointActions(stage25));
  const stage27 = Object.assign(stage26, codeEditActions(stage26));
  const stage28 = Object.assign(stage27, codeSelectionActions(stage27));
  return stage28;
}

function useClipPathEditorPart2(editor: EditorAfterCodeSelectionActions) {
  const stage1 = Object.assign(editor, shapeFitActions(editor));
  const stage2 = Object.assign(stage1, shapeScaleActions(stage1));
  const stage3 = Object.assign(stage2, guideActions(stage2));
  const stage4 = Object.assign(stage3, dragPointActions(stage3));
  const stage5 = Object.assign(stage4, presetTypeaheadActions(stage4));
  const stage6 = Object.assign(stage5, presetButtonActions(stage5));
  const stage7 = Object.assign(stage6, presetListActions(stage6));
  const stage8 = Object.assign(stage7, handleKeyboardActions(stage7));
  const stage9 = Object.assign(stage8, shapeKeyboardActions(stage8));
  const stage10 = Object.assign(stage9, keyboardLoopActions(stage9));
  const stage11 = Object.assign(stage10, keyboardKeyActions(stage10));
  const stage12 = Object.assign(stage11, marqueeMoveActions(stage11));
  const stage13 = Object.assign(stage12, pointDuplicateDragActions(stage12));
  const stage14 = Object.assign(stage13, handleDragActions(stage13));
  const stage15 = Object.assign(stage14, pointerMoveActions(stage14));
  const stage16 = Object.assign(stage15, pointerEndActions(stage15));
  const stage17 = Object.assign(stage16, useWindowPointerListeners(stage16));
  useDismissListeners(stage17);
  const stage18 = Object.assign(stage17, useDeselectListener(stage17));
  useCanvasMeasure(stage18);
  const stage19 = Object.assign(stage18, useCodeSyncEffects(stage18));
  const stage20 = Object.assign(stage19, useShortcutListeners(stage19));
  const stage21 = Object.assign(stage20, windowKeyDownActions(stage20));
  const stage22 = Object.assign(stage21, useWindowKeyListeners(stage21));
  useSelectionSync(stage22);
  useClipPathWrite(stage22);
  const stage23 = Object.assign(stage22, useTimerCleanup(stage22));
  const stage24 = Object.assign(stage23, pointEditActions(stage23));
  return stage24;
}

function useClipPathEditorPart3(editor: EditorAfterPointEditActions) {
  const stage1 = Object.assign(editor, marqueeStartActions(editor));
  const stage2 = Object.assign(stage1, transformStartActions(stage1));
  const stage3 = Object.assign(stage2, dragStartActions(stage2));
  const stage4 = Object.assign(stage3, handleGeometry(stage3));
  const stage5 = Object.assign(stage4, renderGeometry(stage4));
  return stage5;
}

export default function ClipPath(props: ClipPathProps = {}) {
  // A copy: the composers widen the object they are given into the editor.
  const editor = useClipPathEditorPart3(
    useClipPathEditorPart2(useClipPathEditorPart1({ ...props })),
  );
  return <ClipPathView editor={editor} />;
}
