import { useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

function sliderStyle(percent: number): CSSProperties & { readonly '--pct': string } {
  return { '--pct': `${percent}%` };
}

// A thin, pointer-driven slider bar (Webflow's shadow/opacity sliders): the WHOLE
// track is draggable start→end, with arrow-key support (Shift = ×10, Home/End =
// min/max). Drag emits live values via onInput; release (and keys) commit via
// onCommit. Purely numeric — the caller maps the number to CSS (px, %, 0..1, …).
//
// While dragging, the thumb tracks a LOCAL value: a live write previews to the
// canvas but doesn't refresh the model, so the prop-derived `value` only catches up
// on commit. We re-sync from `value` whenever we're not mid-drag.
export default function DragSlider({
  value,
  min,
  max,
  disabled = false,
  ariaLabel,
  className,
  onPreview,
  onInput,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  /** Fires EVERY animation frame during a drag with the live value — for cheap UI
   *  (a number readout tracking the thumb). Unlike onInput it is not throttled. */
  onPreview?: (n: number) => void;
  onInput: (n: number) => void;
  onCommit: (n: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) {
      setLocal(value);
    }
  }, [value]);

  const valueAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) {
      return local;
    }
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) {
      return local;
    }
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(min + ratio * (max - min));
  };

  // A pointer fires far faster than Webflow's async style write can drain (high-Hz
  // mice/trackpads emit many moves per frame). Emitting onInput on every move backs
  // the writes up into a growing lag. So we coalesce: the thumb (local state) updates
  // once per animation frame, and the actual write is time-throttled to WRITE_MS —
  // fast enough to feel live, slow enough never to queue. The final position always
  // commits on release, so no move is lost.
  const WRITE_MS = 50;
  const rafId = useRef<number | null>(null);
  const latestX = useRef(0);
  const lastWriteAt = useRef(0);
  useEffect(
    () => () => {
      if (rafId.current != null) {
        cancelAnimationFrame(rafId.current);
      }
    },
    [],
  );

  const frame = () => {
    rafId.current = null;
    const next = valueAt(latestX.current);
    setLocal(next);
    onPreview?.(next); // every frame — cheap UI (number readout) tracks the thumb
    const now = performance.now();
    if (now - lastWriteAt.current >= WRITE_MS) {
      lastWriteAt.current = now;
      onInput(next);
    }
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    latestX.current = event.clientX;
    lastWriteAt.current = performance.now();
    const next = valueAt(event.clientX);
    setLocal(next);
    onPreview?.(next);
    onInput(next);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Once a drag is in progress (pointer captured), keep tracking even if `disabled`
    // toggles mid-drag: a commit may briefly flip the caller's busy flag, and that must
    // not freeze the thumb. The drag only STARTS when enabled (see `down`).
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    latestX.current = event.clientX;
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(frame);
    }
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    dragging.current = false;
    const next = valueAt(event.clientX);
    setLocal(next);
    onCommit(next);
  };
  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = local - step;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = local + step;
    } else if (event.key === 'Home') {
      next = min;
    } else if (event.key === 'End') {
      next = max;
    }
    if (next == null) {
      return;
    }
    event.preventDefault();
    const clamped = Math.min(max, Math.max(min, next));
    setLocal(clamped);
    onCommit(clamped);
  };
  const pct = max > min ? Math.min(100, Math.max(0, ((local - min) / (max - min)) * 100)) : 0;
  return (
    <div
      ref={trackRef}
      className={['u-drag-slider', disabled ? 'is-disabled' : '', className]
        .filter(Boolean)
        .join(' ')}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={local}
      aria-disabled={disabled || undefined}
      style={sliderStyle(pct)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    >
      <span className="u-drag-slider-fill" aria-hidden="true" />
      <span className="u-drag-slider-thumb" aria-hidden="true" />
    </div>
  );
}
