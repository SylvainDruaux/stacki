import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { HoverTooltip } from './components/SegmentedControl';
import useScrub from './components/useScrub';
import { handleArrowStep } from './model/numberStep';
import { isNonNegative } from './model/cssProperties';
import { hasOwnedPopup, inOwnedPopup } from './model/popupLayer';
import ProvenanceList from './ProvenanceList';
import VariableConnect, { useSharedVars } from './VariableConnect';
import type { ProjectVariable } from './model/webflow';
import { selectorsMatch, type ResolvedProp } from './model/resolved';
import { getHost } from './model/host';
import { getModifiers, onModifiers, setModifiers } from '../../editor/heldModifiers';
import { assert } from '../../../shared/assert';

// Shared "spacing box" primitives: Webflow's masked-SVG frame with draggable side
// handles, click-to-edit value labels, and a popover editor. Used by SpacingSection
// (nested margin + padding) and PositionSection (a single inset frame: top/right/
// bottom/left). Each side is driven by the resolved model — blue when the picked
// selector sets it, orange when another selector does, dim (assumed unset) otherwise.

export type SetProp = (prop: string, value: string, important: boolean) => void;
export type ClearProp = (prop: string | string[]) => void;
export type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;
export type Read = (prop: string) => ResolvedProp | undefined;
export type SelectSelector = (selector: string, prop?: string) => void;

export type Side = 'top' | 'right' | 'bottom' | 'left';

type Display = {
  present: boolean;
  isSelected: boolean;
  value: string;
  important: boolean;
  /** The picked selector sets this side but a more specific selector wins. */
  overridden: boolean;
  /** The selector that wins the cascade (for the override tooltip). */
  winnerSelector: string;
};
function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) {
    return {
      present: false,
      isSelected: false,
      value: '',
      important: false,
      overridden: false,
      winnerSelector: '',
    };
  }
  const isSelected = resolved.source === 'selected';
  // A wrapped value that Webflow cannot round-trip is moved to the selected embed
  // rule, while its native class can still read back as the inner Variable object.
  // Prefer that authored fallback so spacing shows/edits `calc(...)`, not the lossy
  // variable name. This remains scoped to the same selected selector.
  const editingSelector = resolved.contributors.find(
    (contributor) => contributor.editing,
  )?.selectorText;
  const wrappedFallback = resolved.contributors.find(
    (contributor) =>
      contributor.origin === 'embed' &&
      isWrappedValue(contributor.value) &&
      (contributor.isSelected ||
        (!!editingSelector && selectorsMatch(contributor.selectorText, editingSelector))),
  );
  const source =
    wrappedFallback ??
    (isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner);
  return {
    present: true,
    isSelected,
    value: source.value,
    important: source.important,
    overridden: resolved.overridden,
    winnerSelector: resolved.winner.selectorText,
  };
}

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i);
  if (match) {
    return { value: input.slice(0, match.index).trim(), important: true };
  }
  return { value: input.trim(), important: false };
}

// ── Drag-to-adjust helpers (shared by the SVG side handles) ──────────────────

// Each side drags along one axis; `sign` maps "away from centre" to an increase
// (drag the top band up, the left band left, etc.).
const SIDE_AXIS: Record<Side, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
  top: { axis: 'y', sign: -1 },
  bottom: { axis: 'y', sign: 1 },
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
};

const ALL_SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

// Sides a drag affects, by modifier: Shift → all four, Alt/Option → the dragged
// side + its opposite, otherwise just the dragged side. All affected sides are
// set to the same value (they equalise as you drag).
function affectedSides(side: Side, event: { shiftKey: boolean; altKey: boolean }): Side[] {
  if (event.shiftKey) {
    return ALL_SIDES;
  }
  if (event.altKey) {
    return [side, OPPOSITE[side]];
  }
  return [side];
}

// The props of `sides` alongside `prop`, which names `side` (`padding-right` →
// `padding-`, the bare inset `right` → ``). Only sides share a prefix this way,
// so anything else stays a one-property edit.
function siblingProps(prop: string, side: Side, sides: Side[]): string[] {
  if (!prop.endsWith(side)) {
    return [prop];
  }
  const prefix = prop.slice(0, prop.length - side.length);
  return sides.map((sibling) => `${prefix}${sibling}`);
}

// CSS px of value change per screen px dragged. 0.5 ≈ half-speed for fine control.
const DRAG_SENSITIVITY = 0.5;

/** Split a length into its number and unit (unit '' when absent / non-numeric). */
function parseAmountUnit(value: string): { amount: number; unit: string } {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
  if (!match) {
    return { amount: 0, unit: '' };
  }
  return { amount: parseFloat(match[1] ?? ''), unit: (match[2] ?? '').toLowerCase() };
}

/** How many CSS px one unit spans, so a drag in screen px maps to a value delta. */
function pxPerUnit(unit: string): number {
  switch (unit) {
    case 'px':
      return 1;
    case 'rem':
    case 'em':
      return 16;
    case 'pt':
      return 96 / 72;
    default:
      return 16; // %, vw, … — approximate so the drag still feels reasonable
  }
}

/** Round to a sensible precision for the unit and re-attach it. */
function formatLength(amount: number, unit: string): string {
  const rounded =
    unit === 'px' || unit === '%' ? Math.round(amount) : Math.round(amount * 100) / 100;
  return `${rounded}${unit}`;
}

// The frame band, drawn exactly like Webflow's spacing control: four shaded
// trapezoids clipped by a mask that subtracts a rounded inner rect which is 1px
// larger than the centre hole on every side — so its rounded corners bite into
// the band and the trapezoids meet a rounded (not square) inner corner. Fixed
// geometry (viewBox == Webflow's) with preserveAspectRatio="none" scales the SVG
// to the frame while the frame keeps Webflow's aspect ratio, so nothing distorts.
export const FRAMES = {
  // w/h: viewBox size · band: side thickness · or/ir: outer/inner corner radius
  // mask: the subtracted inner rect (1px larger than the w-2·band × h-2·band hole)
  margin: {
    w: 224,
    h: 112,
    or: 4,
    ir: 4,
    mask: { x: 35, y: 23, w: 154, h: 66 },
    paths: {
      top: 'm0,0 h224 l-36,24 h-152 l-36,-24z',
      right: 'm224,0 v112 l-36,-24 v-64 l36,-24z',
      bottom: 'm0,112 h224 l-36,-24 h-152 l-36,24z',
      left: 'm0,0 v112 l36,-24 v-64 l-36,-24z',
    },
  },
  padding: {
    w: 150,
    h: 60,
    or: 2,
    ir: 2,
    mask: { x: 35, y: 23, w: 80, h: 14 },
    paths: {
      top: 'm0,0 h150 l-36,24 h-78 l-36,-24z',
      right: 'm150,0 v60 l-36,-24 v-12 l36,-24z',
      bottom: 'm0,60 h150 l-36,-24 h-78 l-36,24z',
      left: 'm0,0 v60 l36,-24 v-12 l-36,-24z',
    },
  },
  // Webflow's position/inset frame — a single 172×56 band with a 36×24 edge and a
  // 100×8 centre hole (the exact geometry from Webflow's position control SVG).
  position: {
    w: 172,
    h: 56,
    or: 4,
    ir: 4,
    mask: { x: 35, y: 23, w: 102, h: 10 },
    paths: {
      top: 'm0,0 h172 l-36,24 h-100 l-36,-24z',
      right: 'm172,0 v56 l-36,-24 v-8 l36,-24z',
      bottom: 'm0,56 h172 l-36,-24 h-100 l-36,24z',
      left: 'm0,0 v56 l36,-24 v-8 l-36,-24z',
    },
  },
} as const;

export type FrameKey = keyof typeof FRAMES;

type FillProps = {
  frame: FrameKey;
  /** Maps a side to its CSS property (`margin-top`, `padding-top`, or plain `top`). */
  propFor: (side: Side) => string;
  /**
   * Grows inward (padding): flip the drag direction and clamp at 0. Insets & margins grow
   * outward.
   */
  inward?: boolean;
  read: Read;
  busy: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
  // Report the in-flight drag value (affected props + display string) so the
  // matching labels mirror it live; onLiveEnd clears it on release.
  onLive: (props: string[], display: string) => void;
  onLiveEnd: () => void;
};

// Dragging a side, wherever the press lands: the band around it or the number
// written on it. Both are the same gesture — press, move along the side's axis,
// let go — so both run this. The value keeps the unit already in the field (rem
// when the field is empty or unitless), the canvas is written on every rAF, and
// the file once on release.
//
// `threshold` is what tells a drag from a press. The bands are nothing but drag
// handles, so they start at once; a number is also a button that opens the
// editor, so it waits a few pixels before it becomes a drag, and reports
// afterwards whether it did (`wasDrag`) so the click that follows can be
// ignored.
type SideDragOptions = {
  propFor: (side: Side) => string;
  inward: boolean;
  read: Read;
  busy: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
  onLive: (props: string[], display: string) => void;
  onLiveEnd: () => void;
  threshold?: number;
};

function useSideDrag({
  propFor,
  inward,
  read,
  busy,
  setProp,
  liveSetProp,
  onLive,
  onLiveEnd,
  threshold = 0,
}: SideDragOptions) {
  const dragRef = useRef<SideDrag | undefined>(undefined);
  const dragged = useRef(false);
  const frame = useLiveFrame(dragRef, liveSetProp);

  const apply = useDragApply({
    dragRef,
    draggedRef: dragged,
    propFor,
    inward,
    liveSetProp,
    onLive,
    frame,
  });
  useDragModifiers(dragRef, apply);

  const onPointerDown = (side: Side) => (event: React.PointerEvent) => {
    if (busy) {
      return;
    }
    // A band has nothing else to be, so it takes the press outright. A number is
    // a button: leave it its focus and its click until the pointer moves.
    if (threshold === 0) {
      event.preventDefault();
    }
    const shown = displayOf(read(propFor(side)));
    dragRef.current = startSideDrag({ side, shown, inward, threshold, event });
    dragged.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (followPointer(dragRef, event, threshold)) {
      apply();
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    frame.cancel();
    if (drag.active) {
      // One last apply: the sides the modifiers name at the moment of release
      // are the sides that get written.
      followPointer(dragRef, event, threshold);
      apply();
      frame.cancel();
    }
    const value = drag.active ? dragValue(drag, { inward }) : undefined;
    dragRef.current = undefined;
    // Pressed and let go without moving: that was a click, and the click handler
    // is the one that should hear about it.
    if (value === undefined) {
      return;
    }
    onLiveEnd();
    drag.props.forEach((prop) => setProp(prop, value, drag.important));
  };

  return { onPointerDown, onPointerMove, onPointerUp, wasDrag: () => dragged.current };
}

// Everything the drag does on any change — the pointer moving, or a modifier
// going down or up under a pointer that is standing still.
function useDragApply({
  dragRef,
  draggedRef,
  propFor,
  inward,
  liveSetProp,
  onLive,
  frame,
}: {
  dragRef: React.MutableRefObject<SideDrag | undefined>;
  draggedRef: React.MutableRefObject<boolean>;
  propFor: (side: Side) => string;
  inward: boolean;
  liveSetProp: LiveSetProp;
  onLive: (props: string[], display: string) => void;
  frame: { queue: (value: string) => void };
}) {
  return () => {
    const drag = dragRef.current;
    if (!drag?.active) {
      return;
    }
    draggedRef.current = true;
    const next = affectedSides(drag.side, drag).map((side) => propFor(side));
    // A side the modifier just dropped goes back to what it was. It was only
    // ever previewed — nothing has been written to the file yet — so putting it
    // back is undoing the live write, not another edit.
    for (const prop of drag.written) {
      if (!next.includes(prop)) {
        liveSetProp(prop, undefined, drag.important);
        drag.written.delete(prop);
      }
    }
    drag.props = next;
    for (const prop of next) {
      drag.written.add(prop);
    }
    const value = dragValue(drag, { inward });
    // Update the labels every time (cheap setState); throttle the canvas write to rAF.
    onLive(drag.props, drag.important ? `${value} !important` : value);
    frame.queue(value);
  };
}

// One drag in flight, from the press to the release.
type SideDrag = {
  side: Side;
  /** The props being written right now — the modifiers decide, and they
   *  are free to change halfway through. */
  props: string[];
  /** Every prop this drag has written live, so one that stops being
   *  affected can be put back. */
  written: Set<string>;
  unit: string;
  startAmount: number;
  axis: 'x' | 'y';
  sign: 1 | -1;
  startX: number;
  startY: number;
  /** Where the pointer is now, so a modifier pressed without moving still
   *  has somewhere to apply. */
  x: number;
  y: number;
  shiftKey: boolean;
  altKey: boolean;
  important: boolean;
  /** Past the threshold — this is a drag now, not a press. */
  active: boolean;
};

// The drag as it stands at the press: the side's current value (rem when the
// field is empty or unitless) and the direction that grows it.
function startSideDrag({
  side,
  shown,
  inward,
  threshold,
  event,
}: {
  side: Side;
  shown: Display;
  inward: boolean;
  threshold: number;
  event: React.PointerEvent;
}): SideDrag {
  const { amount, unit } = parseAmountUnit(shown.value);
  const sideAxis = SIDE_AXIS[side];
  // Outward grows away from centre; inward (padding) drags the opposite way
  // (Webflow flips the resize cursors to match).
  const sign: 1 | -1 = inward ? (sideAxis.sign === 1 ? -1 : 1) : sideAxis.sign;
  return {
    side,
    props: [],
    written: new Set(),
    unit: unit || 'rem',
    startAmount: amount,
    axis: sideAxis.axis,
    sign,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    important: shown.important,
    active: threshold === 0,
  };
}

// The value the drag has reached, formatted in its unit. Padding can't go
// negative; insets and margins can.
function dragValue(drag: SideDrag, { inward }: { inward: boolean }): string {
  assert(drag.unit !== '', 'dragValue: a drag always carries a unit (rem when none was set)');
  const px = (drag.axis === 'x' ? drag.x - drag.startX : drag.y - drag.startY) * drag.sign;
  const next = drag.startAmount + (px * DRAG_SENSITIVITY) / pxPerUnit(drag.unit);
  if (inward && next < 0) {
    return formatLength(0, drag.unit);
  }
  return formatLength(next, drag.unit);
}

// Records where the pointer and the modifiers are now. Returns whether the drag
// should apply: it is active, or this move just carried it past the threshold.
function followPointer(
  dragRef: React.MutableRefObject<SideDrag | undefined>,
  event: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean },
  threshold: number,
): boolean {
  const drag = dragRef.current;
  if (!drag) {
    return false;
  }
  drag.x = event.clientX;
  drag.y = event.clientY;
  drag.shiftKey = event.shiftKey;
  drag.altKey = event.altKey;
  if (drag.active) {
    return true;
  }
  const far =
    Math.abs(event.clientX - drag.startX) >= threshold ||
    Math.abs(event.clientY - drag.startY) >= threshold;
  if (far) {
    drag.active = true;
  }
  return far;
}

// The canvas write, throttled to one per animation frame: the latest queued
// value is written to every prop the drag holds when the frame comes round.
function useLiveFrame(
  dragRef: React.MutableRefObject<SideDrag | undefined>,
  liveSetProp: LiveSetProp,
) {
  const raf = useRef<number | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const cancel = () => {
    if (raf.current !== undefined) {
      cancelAnimationFrame(raf.current);
      raf.current = undefined;
    }
    pending.current = undefined;
  };
  useEffect(() => cancel, []);
  const flush = () => {
    raf.current = undefined;
    const drag = dragRef.current;
    const value = pending.current;
    if (drag && value !== undefined) {
      drag.props.forEach((prop) => liveSetProp(prop, value, drag.important));
    }
  };
  const queue = (value: string) => {
    pending.current = value;
    if (raf.current === undefined) {
      raf.current = requestAnimationFrame(flush);
    }
  };
  return { queue, cancel };
}

// While a drag is live, Shift and Option are read as they are pressed rather
// than as they were at the start: reach for one mid-drag and the other sides
// join in from that moment.
function useDragModifiers(
  dragRef: React.MutableRefObject<SideDrag | undefined>,
  apply: () => void,
): void {
  // The listeners below are registered once; this keeps them calling the
  // current `apply`, with the props of the render that is on screen.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const follow = ({ shiftKey, altKey }: { shiftKey: boolean; altKey: boolean }) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      if (drag.shiftKey === shiftKey && drag.altKey === altKey) {
        return;
      }
      drag.shiftKey = shiftKey;
      drag.altKey = altKey;
      applyRef.current();
    };
    // Read off any key event, not just the modifiers themselves, and through
    // the shared store — see the hover hook below for both reasons.
    const onKey = (event: KeyboardEvent) =>
      setModifiers({ shiftKey: event.shiftKey, altKey: event.altKey });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    const offModifiers = onModifiers(follow);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      offModifiers();
    };
  }, [dragRef]);
}

// Pointing at a side, as opposed to changing it. The canvas draws what the
// pointer is over — the strip of the page that side is holding open — so the
// panel has to say which sides those are, and keep saying it while Shift or
// Option change the answer under a pointer that hasn't moved.
function useSideHover({
  propFor,
  kind,
  read,
}: {
  propFor: (side: Side) => string;
  kind: 'padding' | 'margin';
  read: Read;
}) {
  const overRef = useRef<HoveredSide | undefined>(undefined);

  const report = () => {
    const hovered = overRef.current;
    if (!hovered) {
      getHost().onSpacingHover?.(undefined);
      return;
    }
    const sides = affectedSides(hovered.side, hovered);
    const labels: Record<string, string> = {};
    for (const side of sides) {
      try {
        const shown = displayOf(read(propFor(side)));
        labels[side] = shown.present ? shown.value : '0';
      } catch {
        // A value that can't be read is a missing label, not a missing band.
      }
    }
    getHost().onSpacingHover?.({ kind, sides, labels });
  };
  useHoverModifiers(overRef, report);

  return {
    onEnter: (side: Side) => (event: React.MouseEvent | React.PointerEvent) => {
      // A modifier held before the pointer arrived counts: the pointer event
      // knows what this window saw, the store knows what the canvas saw too.
      const held = getModifiers();
      overRef.current = {
        side,
        shiftKey: event.shiftKey || held.shiftKey,
        altKey: event.altKey || held.altKey,
      };
      report();
    },
    onLeave: () => {
      if (!overRef.current) {
        return;
      }
      overRef.current = undefined;
      report();
    },
    /** Follow a modifier held while the pointer moves within the same side. */
    onOver: (event: React.MouseEvent | React.PointerEvent) => {
      const hovered = overRef.current;
      if (!hovered) {
        return;
      }
      if (hovered.shiftKey === event.shiftKey && hovered.altKey === event.altKey) {
        return;
      }
      hovered.shiftKey = event.shiftKey;
      hovered.altKey = event.altKey;
      report();
    },
  };
}

// The side under the pointer, with the modifiers held while it is there.
type HoveredSide = { side: Side; shiftKey: boolean; altKey: boolean };

// Keeps the hovered sides following Shift and Option while the pointer stands
// still, and clears the canvas when the panel goes away mid-hover.
function useHoverModifiers(
  overRef: React.MutableRefObject<HoveredSide | undefined>,
  report: () => void,
): void {
  // The listener below is registered once; this keeps it calling the current
  // report, which reads the values as they are now rather than as they were when
  // the panel first rendered.
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    const follow = ({ shiftKey, altKey }: { shiftKey: boolean; altKey: boolean }) => {
      const hovered = overRef.current;
      if (!hovered) {
        return;
      }
      if (hovered.shiftKey === shiftKey && hovered.altKey === altKey) {
        return;
      }
      hovered.shiftKey = shiftKey;
      hovered.altKey = altKey;
      reportRef.current();
    };
    // Every key event, not only the modifier keys themselves: what is wanted is
    // the state of Shift and Option right now, and reading it off whatever
    // event just happened means a missed keyup (focus moved for a moment, a
    // shortcut ate the event) is corrected by the next one rather than leaving
    // the canvas lit up for a modifier nobody is holding.
    //
    // Captured rather than bubbled: a field in the panel that stops a key event
    // from travelling must not stop the canvas from following the modifier. And
    // the answer goes through the shared store, because the other place these
    // are pressed is the canvas — see setModifiers.
    const onKey = (event: KeyboardEvent) =>
      setModifiers({ shiftKey: event.shiftKey, altKey: event.altKey });
    const onBlur = () => setModifiers({ shiftKey: false, altKey: false });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    const offModifiers = onModifiers(follow);
    // Leaving the panel entirely (or unmounting mid-hover) must not leave the
    // canvas lit up with nothing pointing at it.
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      offModifiers();
      if (overRef.current) {
        overRef.current = undefined;
        getHost().onSpacingHover?.(undefined);
      }
    };
  }, [overRef]);
}

// Each trapezoid is also a drag handle: hovering brightens it (CSS), and dragging
// along its axis grows/shrinks that side's value.
export function SpacingFill({ frame, inward = false, ...dragOptions }: FillProps) {
  const geometry = FRAMES[frame];
  const maskId = 'sp-' + useId().replace(/:/g, '');
  const { onPointerDown, onPointerMove, onPointerUp } = useSideDrag({ ...dragOptions, inward });
  const hover = useSideHover({
    propFor: dragOptions.propFor,
    kind: inward ? 'padding' : 'margin',
    read: dragOptions.read,
  });

  return (
    <svg
      className="embed-editor_spacing-fill"
      viewBox={`0 0 ${geometry.w} ${geometry.h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <mask id={maskId} maskContentUnits="userSpaceOnUse">
        <rect
          x="0"
          y="0"
          width={geometry.w}
          height={geometry.h}
          rx={geometry.or}
          ry={geometry.or}
          fill="#fff"
        />
        <rect
          x={geometry.mask.x}
          y={geometry.mask.y}
          width={geometry.mask.w}
          height={geometry.mask.h}
          rx={geometry.ir}
          ry={geometry.ir}
          fill="#000"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        {(['top', 'right', 'bottom', 'left'] satisfies Side[]).map((side) => (
          <path
            key={side}
            className={`embed-editor_spacing-tri is-${side}`}
            d={geometry.paths[side]}
            onPointerDown={onPointerDown(side)}
            onPointerMove={(event) => {
              hover.onOver(event);
              onPointerMove(event);
            }}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerEnter={hover.onEnter(side)}
            onPointerLeave={hover.onLeave}
          />
        ))}
      </g>
    </svg>
  );
}

/** Label text: the value with its unit (the empty placeholder when unset), sans
 *  !important. The CSS truncates it to the band, so the unit shows when there's room. */
function labelFor(value: string, empty: string): string {
  const text = value.trim().replace(/\s*!important$/i, '');
  return text || empty;
}

function variableFor(value: string, variables: ProjectVariable[]): ProjectVariable | undefined {
  const raw = value.trim().replace(/\s*!important$/i, '');
  const binding = raw.match(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i)?.[0];
  // Purple is reserved for a direct variable value. Expressions that merely contain
  // a variable, such as `calc(var(--space) * 2)`, remain normal blue property values.
  if (binding) {
    return binding === raw ? variables.find((variable) => variable.binding === binding) : undefined;
  }
  return variables.find((variable) => {
    const fullName = variable.group ? `${variable.group}/${variable.name}` : variable.name;
    return raw === fullName || raw === variable.name;
  });
}

function isWrappedValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const raw = value.trim().replace(/\s*!important$/i, '');
  return /^(?!var\()[a-z-]+\(/i.test(raw);
}

/** `margin-top` -> `Margin top`, `top` -> `Top` for the click editor label. */
function humanLabel(prop: string): string {
  const spaced = prop.replace('-', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// The always-visible value: a label you can click or drag. Click opens the
// editor popover; Alt/Option-click clears the side; dragging it adjusts the
// value, the same gesture as dragging the band behind it — which is where most
// presses land, since the number sits on top of the band.
export function SpacingLabel(props: SpacingLabelProps) {
  const { prop, side, read, busy, clearProp, onEdit } = props;
  const look = labelLook({
    resolved: read(prop),
    override: props.override,
    emptyLabel: props.emptyLabel,
    variableLabels: props.variableLabels ?? false,
    variables: props.variables,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltip = useLabelTooltip({ hasValue: look.hasValue });
  const gesture = useLabelGesture(props);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`embed-editor_spacing-label embed-editor_spacing-${side} ${look.state}`}
        data-prop={prop}
        disabled={busy}
        onMouseEnter={tooltip.open}
        onMouseLeave={tooltip.close}
        onPointerEnter={gesture.hover.onEnter(side)}
        onPointerLeave={gesture.hover.onLeave}
        onFocus={tooltip.show}
        onBlur={tooltip.close}
        onPointerDown={(event) => {
          tooltip.close();
          gesture.onPointerDown(side)(event);
        }}
        onPointerMove={(event) => {
          gesture.hover.onOver(event);
          gesture.onPointerMove(event);
        }}
        onPointerUp={gesture.onPointerUp}
        onPointerCancel={gesture.onPointerUp}
        onClick={(event) => {
          tooltip.close();
          if (gesture.wasDrag()) {
            // That press was a drag; it has already been applied.
            return;
          }
          if (event.altKey) {
            // Alt/Option-click removes the value.
            clearProp(prop);
            return;
          }
          onEdit(prop, side);
        }}
      >
        {look.text}
      </button>
      {tooltip.shown && look.hasValue && buttonRef.current ? (
        <SpacingLabelTooltip anchor={buttonRef.current} look={look} />
      ) : undefined}
    </>
  );
}

// The label's tooltip: a variable's full name, an override's winner, or the
// value spelled out.
function SpacingLabelTooltip({
  anchor,
  look,
}: {
  anchor: HTMLElement;
  look: { variableFullName: string; tooltipContent: string };
}) {
  return (
    <HoverTooltip anchor={anchor}>
      <span className="embed-editor_spacing-tooltip">
        <span
          className={
            look.variableFullName
              ? 'embed-editor_spacing-tooltip-meta'
              : 'embed-editor_spacing-tooltip-value'
          }
        >
          {look.tooltipContent}
        </span>
      </span>
    </HoverTooltip>
  );
}

// The number drags like the band it sits on: `padding-top` → `padding-left`
// and friends, so Shift and Alt reach the other sides from here too. A few
// pixels of travel separate a drag from the click that opens the editor.
function useLabelGesture({
  prop,
  side,
  read,
  busy,
  setProp,
  liveSetProp,
  onLive,
  onLiveEnd,
}: Pick<
  SpacingLabelProps,
  'prop' | 'side' | 'read' | 'busy' | 'setProp' | 'liveSetProp' | 'onLive' | 'onLiveEnd'
>) {
  const propForSide = (other: Side) => siblingProps(prop, side, [other])[0] ?? prop;
  const drag = useSideDrag({
    propFor: propForSide,
    inward: prop.startsWith('padding'),
    read,
    busy,
    setProp,
    liveSetProp,
    onLive,
    onLiveEnd,
    threshold: 3,
  });
  // `padding-top` → padding, `margin-top` → margin, a bare inset (`top`) → the
  // box it is drawn in, which is the margin frame.
  const hover = useSideHover({
    propFor: propForSide,
    kind: prop.startsWith('padding') ? 'padding' : 'margin',
    read,
  });
  return { ...drag, hover };
}

type SpacingLabelProps = {
  prop: string;
  side: Side;
  override?: string | undefined;
  emptyLabel: string;
  read: Read;
  busy: boolean;
  clearProp: ClearProp;
  onEdit: (prop: string, side: Side) => void;
  variables: ProjectVariable[];
  variableLabels?: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
  onLive: (props: string[], display: string) => void;
  onLiveEnd: () => void;
};

// What a side's label shows and how it is coloured, from the resolved model and
// any live drag value (`override`).
function labelLook({
  resolved,
  override,
  emptyLabel,
  variableLabels,
  variables,
}: {
  resolved: ResolvedProp | undefined;
  override: string | undefined;
  emptyLabel: string;
  variableLabels: boolean;
  variables: ProjectVariable[];
}) {
  const display = displayOf(resolved);
  const value = override ?? (display.present ? withImportant(display) : '');
  // Native getProperties can collapse a calc(var(...)) selected value to a Variable
  // object even when the winning/embed fallback keeps the authored expression. Either
  // expression signal means this is a blue property value, not a direct purple variable.
  const hasWrappedValue = isWrappedValue(value) || isWrappedValue(resolved?.winner.value);
  // A live drag (override) always shows its own value plainly; otherwise reflect
  // the cascade — struck-through when a more specific selector overrides this side.
  // The native-variable/expression pair is one authored value represented through two
  // bridge layers, not a meaningful visual override, so keep its property label blue.
  const overridden = override === undefined && display.overridden && !hasWrappedValue;
  const selected = override !== undefined || (display.present && display.isSelected);
  const color = selected ? 'is-selected' : display.present ? 'is-other' : '';
  const variable =
    override === undefined && variableLabels && !hasWrappedValue
      ? variableFor(value, variables)
      : undefined;
  const state = `${color}${variable ? ' is-variable' : ''}${overridden ? ' is-overridden' : ''}`;
  const variableFullName = variable
    ? variable.group
      ? `${variable.group}/${variable.name}`
      : variable.name
    : '';
  const tooltipValue = variable ? variable.name : labelFor(value, emptyLabel);
  const tooltipContent =
    variableFullName || (overridden ? `Overridden by ${display.winnerSelector}` : tooltipValue);
  // A side with nothing set already reads "Auto" / "0" on its face; a tooltip saying
  // the same thing is noise over every empty side of the box. Only a value worth
  // spelling out — one that's authored, a variable's full name, an override — gets one.
  const hasValue = override !== undefined || display.present;
  const text = variable?.name ?? labelFor(value, emptyLabel);
  return { state, variableFullName, tooltipContent, hasValue, text };
}

// The label's tooltip: after a short hover, or at once on keyboard focus, and
// only for a side that has a value worth spelling out.
function useLabelTooltip({ hasValue }: { hasValue: boolean }) {
  const [shown, setShown] = useState(false);
  const tooltipTimer = useRef<number | undefined>(undefined);
  const clearTooltipTimer = () => {
    if (tooltipTimer.current !== undefined) {
      window.clearTimeout(tooltipTimer.current);
      tooltipTimer.current = undefined;
    }
  };
  useEffect(() => clearTooltipTimer, []);
  return {
    shown,
    open: () => {
      clearTooltipTimer();
      if (!hasValue) {
        return;
      }
      tooltipTimer.current = window.setTimeout(() => {
        tooltipTimer.current = undefined;
        setShown(true);
      }, 350);
    },
    show: () => {
      if (hasValue) {
        setShown(true);
      }
    },
    close: () => {
      clearTooltipTimer();
      setShown(false);
    },
  };
}

const withImportant = ({ value, important }: { value: string; important: boolean }) =>
  important ? `${value} !important` : value;

// The editor shown inside the popover: a live text input (number + unit, with the
// same arrow-step / !important handling as before). Commits + closes on blur.
export function SpacingEditor(props: SpacingEditorProps) {
  const { prop, placeholder, read, onSelectSelector, onClose } = props;
  const editor = useSpacingEditor(props);
  return (
    <div
      className="embed-editor_spacing-popover"
      ref={editor.rootRef}
      // Keep the input focused when pressing anywhere in the popover other than the
      // field itself, so an inside click never blurs → commits → closes. The field is
      // not always the <input>: a value with a variable in it draws the rich token
      // editor instead, and preventing that press left the value looking editable and
      // refusing the caret.
      onMouseDown={(event) => {
        const target = event.target;
        if (target === editor.inputRef.current) {
          return;
        }
        if (target instanceof Element && target.closest('.embed-editor_varconnect')) {
          return;
        }
        event.preventDefault();
      }}
      // Which sides the pending commit writes is decided HERE rather than on the
      // field: the rich editor answers Enter itself (it blurs, and that blur is what
      // commits), so the <input>'s own key handler never runs in code mode. Captured
      // so it is recorded before either field acts on the key.
      onKeyDownCapture={editor.keyDownCapture}
    >
      <div className="embed-editor_spacing-popover-row">
        <span className="embed-editor_spacing-popover-label" {...editor.scrub.label}>
          {humanLabel(prop)}
        </span>
        <VariableConnect
          code
          {...(isNonNegative(prop) ? { stepMin: 0 } : {})}
          ariaLabel={`Connect ${humanLabel(prop)} to a variable`}
          disabled={false}
          prop={prop}
          onPick={editor.pick}
        >
          <input
            {...editor.scrub.input}
            ref={editor.inputRef}
            className={`u-input embed-editor_spacing-editor`}
            value={editor.draft}
            placeholder={placeholder}
            onChange={(event) => editor.change(event.target.value)}
            onBlur={editor.blur}
            onKeyDown={editor.keyDown}
            spellCheck={false}
            aria-label={prop}
          />
        </VariableConnect>
      </div>
      {/* Which selectors set this side and which one wins (the winner reads full
          strength, the rest dimmed). Each row jumps to that selector. */}
      <ProvenanceList
        contributors={read(prop)?.contributors ?? []}
        prop={prop}
        onSelect={(selector, selectorProp) => {
          onSelectSelector(selector, selectorProp);
          onClose();
        }}
      />
      <SpacingResetButton onReset={editor.reset} />
    </div>
  );
}

type SpacingEditorProps = {
  prop: string;
  side: Side;
  placeholder: string;
  read: Read;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onSelectSelector: SelectSelector;
  onClose: () => void;
  /** Fired when the popover closes because its OWN side's label was pressed —
   *  lets the parent suppress that label's click from re-opening it (toggle). */
  onSameLabelPress: () => void;
};

// Reused Reset item — mousedown-preventDefault keeps input focus so the
// blur→commit path doesn't fire before the click clears the value.
function SpacingResetButton({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button"
      className="u-field-label-menu-item embed-editor_spacing-reset"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        onReset();
      }}
    >
      <svg className="u-field-label-menu-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5.2 5.2H2.2V2.2" />
        <path d="M2.6 5.2A5.5 5.5 0 1 1 4 12.2" />
      </svg>
      <span>Reset</span>
      <span className="u-field-label-menu-shortcut">Option + click</span>
    </button>
  );
}

// The editor's state and handlers: the draft (seeded once, when the popover
// opens), live writes while typing, and the single commit when it closes.
function useSpacingEditor({
  prop,
  side,
  read,
  setProp,
  clearProp,
  liveSetProp,
  onClose,
  onSameLabelPress,
}: SpacingEditorProps) {
  const external = spacingExternal(read(prop));
  const { draft, draftRef, setDraftValue } = useEditorDraft(external);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEditorFocus(rootRef, inputRef);
  const { cancelLive, liveNow, scheduleLive } = useDebouncedLive((value, important) =>
    liveSetProp(prop, value, important),
  );
  const commit = useSpacingCommit({ prop, side, external, draftRef, setProp, clearProp });
  // Commit the latest draft and close — once, so blur + outside-click can't
  // double-fire.
  const close = () => {
    if (commit.close()) {
      cancelLive();
      onClose();
    }
  };
  const abandon = () => {
    cancelLive();
    commit.abandon();
    onClose();
  };
  useOutsidePress({ rootRef, prop, onSameLabelPress, close });
  // A scrub only moves the draft: this popover's authoritative write happens when it
  // closes (see `close`), which is also what typing in it does.
  const scrub = useScrub({
    value: draft,
    onPreview: setDraftValue,
    onInput: liveNow,
    onCommit: setDraftValue,
  });
  const handlers = spacingEditorHandlers({
    prop,
    commit,
    rootRef,
    setDraftValue,
    scheduleLive,
    cancelLive,
    close,
    abandon,
    setProp,
    clearProp,
    onClose,
  });
  return { draft, rootRef, inputRef, scrub, ...handlers };
}

// The editor's event handlers, over the state `useSpacingEditor` owns.
function spacingEditorHandlers({
  prop,
  commit,
  rootRef,
  setDraftValue,
  scheduleLive,
  cancelLive,
  close,
  abandon,
  setProp,
  clearProp,
  onClose,
}: {
  prop: string;
  commit: ReturnType<typeof useSpacingCommit>;
  rootRef: React.RefObject<HTMLDivElement>;
  setDraftValue: (text: string) => void;
  scheduleLive: (text: string) => void;
  cancelLive: () => void;
  close: () => void;
  abandon: () => void;
  setProp: SetProp;
  clearProp: ClearProp;
  onClose: () => void;
}) {
  return {
    keyDownCapture: (event: ReactKeyboardEvent) => {
      if (commit.recordKey(event) === 'abandon') {
        abandon();
      }
    },
    keyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const recorded = commit.recordKey(event);
      if (recorded === 'commit') {
        event.preventDefault();
        // This field's blur closes the editor — Enter is done with it, so it
        // leaves rather than staying focused like a panel field.
        event.currentTarget.blur();
        return;
      }
      if (recorded === 'abandon') {
        abandon();
        return;
      }
      const stepped = stepSpacingKey(event, prop);
      if (stepped !== undefined) {
        setDraftValue(stepped);
        scheduleLive(stepped);
      }
    },
    change: (text: string) => {
      setDraftValue(text);
      scheduleLive(text);
    },
    pick: (binding: string) => {
      // The pick has to land in the field as well as on the element. This
      // popover seeds its draft once, when it opens, and does not follow the
      // model afterwards — so picking a variable styled the element while the
      // field it was picked in stayed empty, until the popover was closed and
      // opened again and the draft was seeded afresh.
      setDraftValue(binding);
      // And it must not be written a second time on the way out: `close()`
      // commits whenever the draft differs from what the popover opened with,
      // and the pick is already written by the setProp below.
      commit.rebase(binding);
      setProp(prop, binding, false);
    },
    blur: () => closeUnlessInPopup(rootRef, close),
    reset: () => {
      // Skip the commit path; we're clearing, not committing.
      commit.abandon();
      cancelLive();
      clearProp(prop);
      onClose();
    },
  };
}

// Losing focus to a popup this field opened — the variable picker takes focus
// for its search box, the big value editor takes it outright — is not leaving
// the editor. Closing there took the popup down with it before anything could
// be chosen. Checked a tick later because during a blur the focus has left one
// element and not yet reached the next.
function closeUnlessInPopup(rootRef: React.RefObject<HTMLDivElement>, close: () => void): void {
  window.setTimeout(() => {
    if (hasOwnedPopup(rootRef.current ?? undefined)) {
      return;
    }
    if (inOwnedPopup(document.activeElement ?? undefined, rootRef.current ?? undefined)) {
      return;
    }
    close();
  }, 0);
}

// The value the editor opens with: the side's own value, with its !important.
function spacingExternal(resolved: ResolvedProp | undefined): string {
  const display = displayOf(resolved);
  return display.present ? withImportant(display) : '';
}

// The draft, mirrored into a ref so listeners registered once still read the
// latest text.
function useEditorDraft(external: string) {
  const [draft, setDraft] = useState(external);
  const draftRef = useRef(draft);
  const setDraftValue = (text: string) => {
    draftRef.current = text;
    setDraft(text);
  };
  return { draft, draftRef, setDraftValue };
}

// When and what the editor writes. Only an explicit Enter or an actual edit is
// applied: opening the popover and clicking away (or blurring) must leave the
// side untouched — otherwise an inherited / other-selector value gets silently
// written onto the picked style.
function useSpacingCommit({
  prop,
  side,
  external,
  draftRef,
  setProp,
  clearProp,
}: {
  prop: string;
  side: Side;
  external: string;
  draftRef: React.MutableRefObject<string>;
  setProp: SetProp;
  clearProp: ClearProp;
}) {
  const closed = useRef(false);
  // The value when the popover opened, and whether Enter explicitly confirmed it.
  const originalRef = useRef(external);
  const commitRequested = useRef(false);
  // Which sides the pending commit writes. Enter alone writes this one; the drag
  // modifiers mean the same here — Option/Alt adds the opposite side, Shift takes
  // all four. Reset on every keystroke so a modifier only counts on the Enter that
  // held it, and left at this side alone for a commit that comes from a blur.
  const commitProps = useRef<string[]>([prop]);
  return {
    // Writes the draft if it should be written. Returns whether this call is the
    // one that closes the editor; later calls do nothing.
    close: (): boolean => {
      if (closed.current) {
        return false;
      }
      closed.current = true;
      const trimmed = draftRef.current.trim();
      const changed = trimmed !== originalRef.current.trim();
      if (commitRequested.current || changed) {
        const props = commitProps.current;
        if (!trimmed) {
          clearProp(props);
        } else {
          const parsed = parseImportant(trimmed);
          props.forEach((target) => setProp(target, parsed.value, parsed.important));
        }
      }
      return true;
    },
    // Closing without the commit path: Escape, or Reset clearing the side.
    abandon: () => {
      closed.current = true;
    },
    rebase: (value: string) => {
      originalRef.current = value;
    },
    recordKey: (event: {
      key: string;
      shiftKey: boolean;
      altKey: boolean;
    }): 'commit' | 'abandon' | 'none' => {
      if (event.key === 'Enter') {
        commitRequested.current = true;
        commitProps.current = siblingProps(prop, side, affectedSides(side, event));
        return 'commit';
      }
      if (event.key === 'Escape') {
        return 'abandon';
      }
      // A modifier only applies to the Enter that carries it.
      commitProps.current = [prop];
      return 'none';
    },
  };
}

// Any pointerdown outside the popover closes it — pointerdown (not mousedown/
// click) so it fires even when the target preventDefaults its press and thereby
// suppresses the compat mousedown + blur (e.g. the drag bands).
function useOutsidePress({
  rootRef,
  prop,
  onSameLabelPress,
  close,
}: {
  rootRef: React.RefObject<HTMLDivElement>;
  prop: string;
  onSameLabelPress: () => void;
  close: () => void;
}): void {
  // The listener is registered once, for the life of the popover; this keeps
  // it calling the current handlers.
  const latest = useRef({ prop, onSameLabelPress, close });
  latest.current = { prop, onSameLabelPress, close };
  useEffect(() => {
    const onDocumentDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (rootRef.current?.contains(target)) {
        return;
      }
      // The variable picker opens from the dot in this popover but portals to the
      // body, so a press in it is a press in here — see lib/popup-layer.
      if (inOwnedPopup(target, rootRef.current ?? undefined)) {
        return;
      }
      // Pressing this side's own label should net to a close (not reopen): flag it
      // so the label's click doesn't re-open the popover we're about to close.
      const labelProp =
        target instanceof Element
          ? target.closest('.embed-editor_spacing-label')?.getAttribute('data-prop')
          : undefined;
      if (labelProp === latest.current.prop) {
        latest.current.onSameLabelPress();
      }
      latest.current.close();
    };
    document.addEventListener('pointerdown', onDocumentDown);
    return () => document.removeEventListener('pointerdown', onDocumentDown);
  }, [rootRef]);
}

// Opened to be typed in: focus the field it actually shows. With a variable in the
// value that is the rich editor, and focusing the <input> hidden behind it left the
// popup looking focused while the caret was nowhere.
function useEditorFocus(
  rootRef: React.RefObject<HTMLDivElement>,
  inputRef: React.RefObject<HTMLInputElement>,
): void {
  useEffect(() => {
    const rich = rootRef.current?.querySelector<HTMLElement>('.embed-editor_varconnect-editor');
    if (rich) {
      rich.focus();
      const range = document.createRange();
      range.selectNodeContents(rich);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [rootRef, inputRef]);
}

// Live writes of typed text, split into value and `!important`: debounced while
// typing, undelayed for the scrub, which throttles its own — see useScrub.
function useDebouncedLive(write: (value: string, important: boolean) => void) {
  const liveTimer = useRef<number | undefined>(undefined);
  const cancelLive = () => {
    if (liveTimer.current !== undefined) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = undefined;
    }
  };
  useEffect(() => cancelLive, []);
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const parsed = parseImportant(trimmed);
    write(parsed.value, parsed.important);
  };
  const scheduleLive = (text: string) => {
    cancelLive();
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = undefined;
      liveNow(text);
    }, 100);
  };
  return { cancelLive, liveNow, scheduleLive };
}

// An arrow key steps the number under the caret and writes it straight into
// the input. Padding stops at 0; a margin or an inset is free to go negative,
// which is the whole point of pulling something out of its box. Returns the
// stepped text, if any.
function stepSpacingKey(
  event: ReactKeyboardEvent<HTMLInputElement>,
  prop: string,
): string | undefined {
  const stepped = handleArrowStep(event, isNonNegative(prop) ? 0 : undefined);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  const input = event.currentTarget;
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// ── Orchestration hook: drag-mirroring + which side's popover is open ─────────

type SharedProps = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onSelectSelector: SelectSelector;
};

// Wires the pieces together for one box (or a set of nested frames sharing a
// popover): returns a `label(prop, side)` renderer, the SpacingFill live handlers,
// and the editor node (or undefined when closed). `emptyLabel` is the placeholder for an
// unset side ("0" for margin/padding, "Auto" for inset).
export function useSpacingBox(
  shared: SharedProps,
  options?: { emptyLabel?: string; variableLabels?: boolean },
): {
  label: (prop: string, side: Side) => ReactNode;
  fillHandlers: { onLive: (props: string[], display: string) => void; onLiveEnd: () => void };
  editor: ReactNode;
} {
  const emptyLabel = options?.emptyLabel ?? '0';
  const { vars: variables } = useSharedVars({ active: !!options?.variableLabels });
  // The props the in-flight drag is writing and their shared live value, so every
  // matching label mirrors the drag in real time (only one drag runs at a time).
  const [liveDrag, setLiveDrag] = useState<{ props: string[]; value: string } | undefined>(
    undefined,
  );
  const onLive = (dragProps: string[], value: string) => setLiveDrag({ props: dragProps, value });
  const onLiveEnd = () => setLiveDrag(undefined);

  // The side whose editor popover is open (undefined = closed).
  const [editing, setEditing] = useState<{ prop: string; side: Side } | undefined>(undefined);
  // When the open popover is closed by pressing its own label, the label's click
  // must NOT re-open it — this holds that prop so onEdit skips the reopen once.
  const suppressReopen = useRef<string | undefined>(undefined);
  const onEdit = (prop: string, side: Side) => {
    if (suppressReopen.current === prop) {
      suppressReopen.current = undefined;
      return;
    }
    suppressReopen.current = undefined;
    setEditing({ prop, side });
  };

  const label = (prop: string, side: Side) => (
    <SpacingLabel
      key={prop}
      prop={prop}
      side={side}
      override={liveDrag?.props.includes(prop) ? liveDrag.value : undefined}
      emptyLabel={emptyLabel}
      read={shared.read}
      busy={shared.busy}
      clearProp={shared.clearProp}
      onEdit={onEdit}
      variables={variables}
      {...(options?.variableLabels === undefined ? {} : { variableLabels: options.variableLabels })}
      setProp={shared.setProp}
      liveSetProp={shared.liveSetProp}
      onLive={onLive}
      onLiveEnd={onLiveEnd}
    />
  );

  const editor = editing ? (
    <SpacingEditor
      key={editing.prop}
      prop={editing.prop}
      side={editing.side}
      placeholder={emptyLabel}
      read={shared.read}
      setProp={shared.setProp}
      clearProp={shared.clearProp}
      liveSetProp={shared.liveSetProp}
      onSelectSelector={shared.onSelectSelector}
      onClose={() => setEditing(undefined)}
      onSameLabelPress={() => {
        suppressReopen.current = editing.prop;
      }}
    />
  ) : undefined;

  return { label, fillHandlers: { onLive, onLiveEnd }, editor };
}
