import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import ColorSwatch from './components/ColorSwatch';
import {
  angleToDegrees,
  degreesToAngle,
  gradientCenter,
  serializeGradient,
  stopPercent,
  stopsBarCss,
  type Gradient,
  type GradientPatch,
  type GradientStop,
  type GradientStopPatch,
} from './model/gradient';
import { commitInPlace } from './model/commitInPlace';
import { PositionGrid, NumberField } from './components/PositionGrid';
import { assert } from '../../../shared/core/assert';

function tooltipArrowStyle(
  arrowRight: number,
): CSSProperties & { readonly '--tip-arrow-right': string } {
  return { '--tip-arrow-right': `${arrowRight}px` };
}

function gradientBarStyle(image: string): CSSProperties & { readonly '--grad-image': string } {
  return { '--grad-image': image };
}

function stopStyle(
  left: number,
  color: string,
): CSSProperties & { readonly '--stop-color': string } {
  return { left: `${left}%`, '--stop-color': color };
}

// Webflow-style visual gradient editor: a position grid + size presets (radial),
// an angle dial (linear/conic), a draggable stops bar, a repeat toggle, and the
// selected stop's color + position. Edits the gradient's INTERNAL structure and
// re-serializes it to the layer's background-image (see BackgroundSection).
//
// Local `draft` is the source of truth while dragging/typing (live writes don't
// rebuild the model, so the `gradient` prop stays stale mid-interaction); it syncs
// back from the prop whenever we aren't actively editing.

type Props = {
  gradient: Gradient;
  busy: boolean;
  onChange: (g: Gradient, live: boolean) => void;
};

const RADIAL_SIZES = [
  {
    value: 'closest-side',
    label: 'Closest side',
    tip: 'Closest side extends the gradient from the defined position to the closest side.',
  },
  {
    value: 'closest-corner',
    label: 'Closest corner',
    tip: 'Closest corner extends the gradient from the defined position to the closest corner.',
  },
  {
    value: 'farthest-side',
    label: 'Farthest side',
    tip: 'Farthest side extends the gradient from the defined position to the farthest side.',
  },
  {
    value: 'farthest-corner',
    label: 'Farthest corner',
    tip: 'Farthest corner extends the gradient from the defined position to the farthest corner.',
  },
] as const;

const RADIAL_SIZE_FARTHEST_SIDE_SECOND_PATH =
  'M13.85 5a7.465 7.465 0 00-1.35-3H2v10.5A7.503 7.503 0 0013.85 8H8.5a2.5 2.5 0 110-3h5.35z';

// Webflow's radial-extent icons (closest/farthest × side/corner).
const RADIAL_SIZE_ICONS: Record<string, ReactNode> = {
  'closest-side': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path
        opacity=".6"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1 3v12h14V3h-1v11H2V3H1z"
        fill="currentColor"
      />
      <path
        opacity=".4"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 4.5a2.5 2.5 0 11-3 0V2H3.337A5.53 5.53 0 002 3.337v6.326A5.5 5.5 0 109.663 2H8v2.5z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1 1h14v1H7v2.05a2.51 2.51 0 00-1 0V2H1V1z"
        fill="currentColor"
      />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
    </svg>
  ),
  'closest-corner': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path
        opacity=".6"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14 2H5V1h10v14H1V5h1v9h12V2z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 1H1v3h1V2.707L4.414 5.12c.186-.28.427-.52.707-.706L2.71 2H4V1H2z"
        fill="currentColor"
      />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
      <path
        opacity=".4"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 5v6.19A6.5 6.5 0 0011.19 2H5v.88l1.146 1.145a2.5 2.5 0 11-2.12 2.12L2.878 5H2z"
        fill="currentColor"
      />
    </svg>
  ),
  'farthest-side': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path
        opacity=".6"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M13 2H2v12h11v1H1V1h12v1z"
        fill="currentColor"
      />
      <path
        opacity=".4"
        fillRule="evenodd"
        clipRule="evenodd"
        d={RADIAL_SIZE_FARTHEST_SIDE_SECOND_PATH}
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14 1h1v14h-1V7H8.95a2.513 2.513 0 000-1H14V1z"
        fill="currentColor"
      />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
    </svg>
  ),
  'farthest-corner': (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path
        opacity=".6"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14 2H2v12h9v1H1V1h14v10h-1V2z"
        fill="currentColor"
      />
      <path
        opacity=".4"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11 13.12V14H2V2h12v9h-.88L8.976 6.854a2.5 2.5 0 10-2.12 2.12L11 13.122z"
        fill="currentColor"
      />
      <circle cx="1.5" cy="1.5" r="1.5" transform="translate(5 5)" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.586 7.88c-.186.28-.427.52-.707.706L13.29 14H12v1h3v-3h-1v1.293L8.586 7.88z"
        fill="currentColor"
      />
    </svg>
  ),
};

// Radial extent presets with Webflow's icons + delayed description tooltips.
function RadialSizeControl({
  value,
  busy,
  onChange,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [arrowRight, setArrowRight] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const clearTimer = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  useEffect(() => clearTimer, []);
  const start = (size: string, element: HTMLElement) => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const root = rootRef.current;
      if (root) {
        const track = root.getBoundingClientRect();
        const button = element.getBoundingClientRect();
        setArrowRight(track.right - (button.left + button.width / 2));
      }
      setHovered(size);
    }, 500);
  };
  const end = () => {
    clearTimer();
    setHovered(undefined);
  };
  const tip = RADIAL_SIZES.find((size) => size.value === hovered)?.tip;
  return (
    <div ref={rootRef} className="embed-editor_grad-sizes" role="group" aria-label="Gradient size">
      {RADIAL_SIZES.map((size) => {
        const active = value === size.value;
        return (
          <button
            key={size.value}
            type="button"
            className={`embed-editor_grad-size ${active ? 'is-active' : ''}`}
            disabled={busy}
            aria-label={size.label}
            aria-pressed={active}
            onClick={() => {
              end();
              onChange(size.value);
            }}
            onMouseEnter={(event) => start(size.value, event.currentTarget)}
            onMouseLeave={end}
          >
            {RADIAL_SIZE_ICONS[size.value]}
          </button>
        );
      })}
      {hovered && tip ? (
        <div className="u-segmented-tooltip" role="tooltip" style={tooltipArrowStyle(arrowRight)}>
          {tip}
          <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
        </div>
      ) : undefined}
    </div>
  );
}

const RepeatIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path
      d="M11.5 5.5A4 4 0 0 0 4 6.5M4.5 10.5A4 4 0 0 0 12 9.5M12 4v2h-2M4 12v-2h2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const RotateCcwIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path
      d="M4 4v3h3"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4.2 7A4.4 4.4 0 1 1 3.9 9.6"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);
const RotateCwIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path
      d="M12 4v3H9"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11.8 7A4.4 4.4 0 1 0 12.1 9.6"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

// The angle dial (linear): drag the dot around the circle to set the gradient's
// direction (0° = up, 90° = right — CSS convention), matching Webflow's control.
function AngleDial({
  deg,
  busy,
  onChange,
}: {
  deg: number;
  busy: boolean;
  onChange: (deg: number, live: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  const angleFrom = (event: React.PointerEvent) => {
    // Pointer events only reach the dial through its mounted button.
    const button = ref.current;
    assert(button !== null, 'The angle dial is mounted while it receives pointer events');
    const rect = button.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    return Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
  };
  const onDown = (event: React.PointerEvent) => {
    if (busy) {
      return;
    }
    event.preventDefault();
    dragging.current = true;
    ref.current?.setPointerCapture(event.pointerId);
    onChange(angleFrom(event), true);
  };
  const onMove = (event: React.PointerEvent) => {
    if (dragging.current) {
      onChange(angleFrom(event), true);
    }
  };
  const onUp = (event: React.PointerEvent) => {
    if (!dragging.current) {
      return;
    }
    dragging.current = false;
    onChange(angleFrom(event), false);
  };
  const rad = (deg * Math.PI) / 180;
  return (
    <button
      ref={ref}
      type="button"
      className="embed-editor_grad-dial"
      disabled={busy}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      aria-label="Gradient angle"
      title="Drag to set the angle"
    >
      <span
        className="embed-editor_grad-dial-dot"
        style={{ left: `${50 + 38 * Math.sin(rad)}%`, top: `${50 - 38 * Math.cos(rad)}%` }}
      />
    </button>
  );
}

// How an edit lands: live while dragging or typing, or committed.
interface WriteOptions {
  readonly live: boolean;
}

// Linear angle control: the dial + ±45° rotate buttons + a DEG number field.
export function AngleControl({
  angle,
  busy,
  onChange,
}: {
  angle: string;
  busy: boolean;
  onChange: (angle: string, live: boolean) => void;
}) {
  const deg = angleToDegrees(angle);
  const set = (degrees: number, options: WriteOptions) =>
    onChange(degreesToAngle(degrees), options.live);
  return (
    <div className="embed-editor_grad-angle">
      <AngleDial deg={deg} busy={busy} onChange={(degrees, live) => set(degrees, { live })} />
      <button
        type="button"
        className="embed-editor_grad-rotate"
        disabled={busy}
        title="Rotate −45°"
        aria-label="Rotate counterclockwise"
        onClick={() => set(deg - 45, { live: false })}
      >
        <RotateCcwIcon />
      </button>
      <button
        type="button"
        className="embed-editor_grad-rotate"
        disabled={busy}
        title="Rotate +45°"
        aria-label="Rotate clockwise"
        onClick={() => set(deg + 45, { live: false })}
      >
        <RotateCwIcon />
      </button>
      <NumberField
        value={String(Math.round(deg))}
        unit="deg"
        label="Gradient angle"
        busy={busy}
        onLive={(next) => set(angleToDegrees(next), { live: true })}
        onCommit={(next) => set(angleToDegrees(next), { live: false })}
      />
    </div>
  );
}

export default function GradientEditor({ gradient, busy, onChange }: Props) {
  const draft = useGradientDraft(gradient, onChange);
  const { patch, patchStops, setStop, editingRef } = draft;
  const current = draft.gradient;
  const stops = current.stops;
  const [selected, setSelected] = useState(0);
  const selectedIndex = Math.max(0, Math.min(selected, stops.length - 1));
  const sortStops = (keep: number) => {
    const sorted = sortedStops(stops, keep);
    setSelected(sorted.selected);
    patchStops(sorted.stops, { live: false });
  };
  const removeStop = (index: number) => {
    if (stops.length <= 2) {
      return;
    }
    patchStops(
      stops.filter((_, other) => other !== index),
      { live: false },
    );
    setSelected((previous) => Math.max(0, Math.min(previous, stops.length - 2)));
  };
  useDeleteStopKey({ busy, selectedIndex, stopCount: stops.length, removeStop });
  const stop = stops[selectedIndex] ?? { color: '', pos: '' };

  return (
    <div className="embed-editor_grad">
      {/* Geometry: radial = position grid + size presets; conic = angle + grid;
          linear = angle only. */}
      <GradientGeometry gradient={current} busy={busy} patch={patch} />
      <StopsBar
        stops={stops}
        busy={busy}
        selectedIndex={selectedIndex}
        editingRef={editingRef}
        setSelected={setSelected}
        setStop={setStop}
        patchStops={patchStops}
        sortStops={sortStops}
        removeStop={removeStop}
      />
      <RepeatRow gradient={current} busy={busy} patch={patch} patchStops={patchStops} />
      <StopFields
        stop={stop}
        stops={stops}
        selectedIndex={selectedIndex}
        busy={busy}
        editingRef={editingRef}
        setStop={setStop}
        sortStops={sortStops}
      />
    </div>
  );
}

type Patch = (patch: GradientPatch, options?: WriteOptions) => void;
type PatchStops = (next: GradientStop[], options?: WriteOptions) => void;
type SetStop = (index: number, patch: GradientStopPatch, options?: WriteOptions) => void;

// The local draft: the source of truth while dragging/typing (live writes don't rebuild
// the model, so the `gradient` prop stays stale mid-interaction). It syncs back from
// the prop whenever `editing` is not held. Every write goes to both the draft and
// `onChange`; a write is committed unless its options say live.
function useGradientDraft(gradient: Gradient, onChange: Props['onChange']) {
  const external = useMemo(() => serializeGradient(gradient), [gradient]);
  const [draft, setDraft] = useState<Gradient>(gradient);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      setDraft(gradient);
    }
    // Keyed on the serialized value, not the object: a re-created but equal gradient
    // must not reset a live draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized value
  }, [external]);
  const push = (next: Gradient, options: WriteOptions) => {
    setDraft(next);
    onChange(next, options.live);
  };
  const patch: Patch = (changes, options = { live: false }) =>
    push({ ...draft, ...changes }, options);
  const patchStops: PatchStops = (next, options = { live: false }) =>
    push({ ...draft, stops: next }, options);
  const setStop: SetStop = (index, changes, options = { live: false }) =>
    patchStops(
      draft.stops.map((stop, other) => (other === index ? { ...stop, ...changes } : stop)),
      options,
    );
  return { gradient: draft, editingRef: editing, patch, patchStops, setStop };
}

// Stops sorted by position (ties keep their order), and where the stop at `keep` lands.
function sortedStops(
  stops: GradientStop[],
  keep: number,
): { stops: GradientStop[]; selected: number } {
  const tagged = stops.map((stop, index) => ({
    stop,
    index,
    percent: stopPercent(stops, index),
  }));
  tagged.sort((left, right) => left.percent - right.percent || left.index - right.index);
  return {
    stops: tagged.map((entry) => entry.stop),
    selected: tagged.findIndex((entry) => entry.index === keep),
  };
}

// The stops after inserting one at `percent`, sorted by position, with the new stop's
// color copied from the nearest existing stop.
function insertedStops(
  stops: GradientStop[],
  percent: number,
): { stops: GradientStop[]; selected: number } {
  let nearest = 0;
  let best = Infinity;
  stops.forEach((_, index) => {
    const distance = Math.abs(stopPercent(stops, index) - percent);
    if (distance < best) {
      best = distance;
      nearest = index;
    }
  });
  const next = [...stops, { color: stops[nearest]?.color ?? '#000000', pos: `${percent}%` }];
  const tagged = next.map((stop, index) => ({
    stop,
    percent: index === next.length - 1 ? percent : stopPercent(next, index),
  }));
  tagged.sort((left, right) => left.percent - right.percent);
  const sorted = tagged.map((entry) => entry.stop);
  return { stops: sorted, selected: sorted.findIndex((stop) => stop.pos === `${percent}%`) };
}

// Where along the bar a pointer is, as a whole percentage clamped to 0–100.
function barPercent(bar: HTMLElement, clientX: number): number {
  const rect = bar.getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
}

// Delete / Backspace removes the selected stop (a gradient needs ≥ 2, so it's a no-op
// below that). Window-scoped because the handle can't hold focus (its pointerdown
// preventDefaults), but guarded so it never steals the keystroke while a text field
// (color / position) is focused. The listener reads the latest render's values
// through a ref, so it is added once.
function useDeleteStopKey(state: {
  busy: boolean;
  selectedIndex: number;
  stopCount: number;
  removeStop: (index: number) => void;
}) {
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { busy, selectedIndex, stopCount, removeStop } = latest.current;
      if (busy || (event.key !== 'Delete' && event.key !== 'Backspace')) {
        return;
      }
      if (isTextEntry(document.activeElement ?? undefined)) {
        return;
      }
      if (selectedIndex < 0 || selectedIndex >= stopCount || stopCount <= 2) {
        return;
      }
      event.preventDefault();
      removeStop(selectedIndex);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// Whether the focused element takes typing (a field, a list, editable text).
function isTextEntry(element: Element | undefined): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    return true;
  }
  return element.tagName === 'SELECT' || element.isContentEditable;
}

// Radial = position grid + size presets; linear = the angle control; conic = its
// `from` angle.
function GradientGeometry({
  gradient,
  busy,
  patch,
}: {
  gradient: Gradient;
  busy: boolean;
  patch: Patch;
}) {
  if (gradient.type === 'radial') {
    return (
      <>
        <RadialPosition gradient={gradient} busy={busy} patch={patch} />
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Size</span>
          <RadialSizeControl
            value={gradient.size.trim() || 'farthest-corner'}
            busy={busy}
            onChange={(size) => patch({ size })}
          />
        </div>
      </>
    );
  }
  if (gradient.type === 'linear') {
    return (
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Angle</span>
        <AngleControl
          angle={gradient.angle}
          busy={busy}
          onChange={(angle, live) => patch({ angle }, { live })}
        />
      </div>
    );
  }
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Angle</span>
      <NumberField
        value={gradient.from.replace(/deg$/i, '') || '0'}
        unit="deg"
        label="Gradient angle"
        busy={busy}
        onLive={(next) => patch({ from: next }, { live: true })}
        onCommit={(next) => patch({ from: next })}
      />
    </div>
  );
}

function RadialPosition({
  gradient,
  busy,
  patch,
}: {
  gradient: Gradient;
  busy: boolean;
  patch: Patch;
}) {
  const center = gradientCenter(gradient);
  return (
    <div className="embed-editor_size-row embed-editor_grad-pos-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Position</span>
      <div className="embed-editor_grad-pos">
        <PositionGrid
          x={center.x}
          y={center.y}
          busy={busy}
          onPick={(px, py) => patch({ posX: px, posY: py })}
        />
        <div className="embed-editor_grad-pos-fields">
          {/* A <div>, not a <label>: the field here is VariableConnect's contenteditable
              editor, and the plain input behind it is opacity:0 / pointer-events:none.
              A <label> forwards a press to its labelable control — which is that
              invisible input — so clicking the field you can see moved the caret
              into one you cannot. The caption is decorative; the input carries its
              own aria-label. */}
          <div className="embed-editor_grad-pos-field">
            <span>Left</span>
            <NumberField
              value={center.x}
              unit="%"
              label="Position left"
              busy={busy}
              onLive={(next) => patch({ posX: next }, { live: true })}
              onCommit={(next) => patch({ posX: next })}
            />
          </div>
          <div className="embed-editor_grad-pos-field">
            <span>Top</span>
            <NumberField
              value={center.y}
              unit="%"
              label="Position top"
              busy={busy}
              onLive={(next) => patch({ posY: next }, { live: true })}
              onCommit={(next) => patch({ posY: next })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// The stops bar: click the background to insert a stop there, drag a handle along it
// (live, then commit + sort on release), click a handle to select it, double-click it
// to remove it.
function StopsBar({
  stops,
  busy,
  selectedIndex,
  editingRef,
  setSelected,
  setStop,
  patchStops,
  sortStops,
  removeStop,
}: {
  stops: GradientStop[];
  busy: boolean;
  selectedIndex: number;
  editingRef: React.MutableRefObject<boolean>;
  setSelected: (index: number) => void;
  setStop: SetStop;
  patchStops: PatchStops;
  sortStops: (keep: number) => void;
  removeStop: (index: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useStopDrag({ barRef, busy, editingRef, setSelected, setStop, sortStops });
  // Click the bar background → insert a stop there (color = nearest stop's).
  const onBarClick = (event: React.MouseEvent) => {
    const bar = barRef.current;
    if (busy || drag.dragStop.current !== undefined || !bar) {
      return;
    }
    const inserted = insertedStops(stops, barPercent(bar, event.clientX));
    setSelected(inserted.selected);
    patchStops(inserted.stops, { live: false });
  };
  return (
    <div
      ref={barRef}
      className="embed-editor_grad-bar"
      style={gradientBarStyle(stopsBarCss(stops))}
      onClick={onBarClick}
      onPointerMove={drag.onHandleMove}
      onPointerUp={drag.onHandleUp}
    >
      {stops.map((stop, i) => (
        <button
          key={i}
          type="button"
          className={`embed-editor_grad-handle ${i === selectedIndex ? 'is-active' : ''}`}
          style={stopStyle(stopPercent(stops, i), stop.color.trim() || 'transparent')}
          disabled={busy}
          aria-label={`Stop ${i + 1} at ${stopPercent(stops, i)}%`}
          onClick={(event) => {
            event.stopPropagation();
            setSelected(i);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            removeStop(i);
          }}
          onPointerDown={drag.onHandleDown(i)}
        />
      ))}
    </div>
  );
}

// Drag a stop along the bar (live), commit + sort on release. `dragStop` holds the
// index being dragged, so a click that ends a drag does not also insert a stop.
function useStopDrag({
  barRef,
  busy,
  editingRef,
  setSelected,
  setStop,
  sortStops,
}: {
  barRef: React.RefObject<HTMLDivElement>;
  busy: boolean;
  editingRef: React.MutableRefObject<boolean>;
  setSelected: (index: number) => void;
  setStop: SetStop;
  sortStops: (keep: number) => void;
}) {
  const dragStop = useRef<number | undefined>(undefined);
  const onHandleDown = (index: number) => (event: React.PointerEvent) => {
    if (busy) {
      return;
    }
    event.preventDefault();
    setSelected(index);
    dragStop.current = index;
    editingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHandleMove = (event: React.PointerEvent) => {
    const index = dragStop.current;
    const bar = barRef.current;
    if (index === undefined || !bar) {
      return;
    }
    setStop(index, { pos: `${barPercent(bar, event.clientX)}%` }, { live: true });
  };
  const onHandleUp = (event: React.PointerEvent) => {
    const index = dragStop.current;
    if (index === undefined) {
      return;
    }
    dragStop.current = undefined;
    editingRef.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    sortStops(index);
  };
  return { dragStop, onHandleDown, onHandleMove, onHandleUp };
}

// The repeat toggle and the reverse-stops button.
function RepeatRow({
  gradient,
  busy,
  patch,
  patchStops,
}: {
  gradient: Gradient;
  busy: boolean;
  patch: Patch;
  patchStops: PatchStops;
}) {
  const stops = gradient.stops;
  return (
    <div className="embed-editor_size-row embed-editor_grad-repeat">
      <label className="embed-editor_grad-check">
        <input
          type="checkbox"
          checked={gradient.repeating}
          disabled={busy}
          onChange={(event) => patch({ repeating: event.target.checked })}
        />
        <span>Repeat</span>
      </label>
      <button
        type="button"
        className="embed-editor_icon-btn"
        disabled={busy}
        title="Reverse stops"
        aria-label="Reverse gradient stops"
        onClick={() =>
          patchStops(
            [...stops].reverse().map((stop, i) => ({
              ...stop,
              pos: stop.pos.trim() ? `${100 - stopPercent(stops, stops.length - 1 - i)}%` : '',
            })),
          )
        }
      >
        <RepeatIcon />
      </button>
    </div>
  );
}

// The selected stop's color (swatch + text) and position.
function StopFields({
  stop,
  stops,
  selectedIndex,
  busy,
  editingRef,
  setStop,
  sortStops,
}: {
  stop: GradientStop;
  stops: GradientStop[];
  selectedIndex: number;
  busy: boolean;
  editingRef: React.MutableRefObject<boolean>;
  setStop: SetStop;
  sortStops: (keep: number) => void;
}) {
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Color</span>
      <div className="embed-editor_grad-stop">
        <ColorSwatch
          value={stop.color}
          busy={busy}
          ariaLabel="Stop color"
          onChange={(color, live) => {
            editingRef.current = live;
            setStop(selectedIndex, { color }, { live });
          }}
        />
        <input
          className="u-input embed-editor_grad-color"
          value={stop.color}
          spellCheck={false}
          disabled={busy}
          aria-label="Stop color"
          onFocus={() => {
            editingRef.current = true;
          }}
          onChange={(event) =>
            setStop(selectedIndex, { color: event.target.value }, { live: true })
          }
          onBlur={() => {
            editingRef.current = false;
            setStop(selectedIndex, { color: stop.color });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitInPlace(event.currentTarget);
            }
          }}
        />
        <NumberField
          value={stop.pos || `${Math.round(stopPercent(stops, selectedIndex))}%`}
          unit="%"
          label="Stop position"
          busy={busy}
          onLive={(next) => setStop(selectedIndex, { pos: next }, { live: true })}
          onCommit={(next) => {
            setStop(selectedIndex, { pos: next });
            sortStops(selectedIndex);
          }}
        />
      </div>
    </div>
  );
}
