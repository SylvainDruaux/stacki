import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/PropTip';
import type { SegmentedOption } from './components/SegmentedControl';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './lib/live-color';
import ProvenanceList from './ProvenanceList';
import VariableConnect from './VariableConnect';
import type { ResolvedProp } from './lib/resolved';
import { splitTopLevelSpaces } from './lib/background';
import { useHighlight } from './lib/computed-style';
import SegmentPill from './components/SegmentPill';
import { commitInPlace } from './lib/commit-in-place';
import SharedLiveInput from './components/LiveInput';

// The Borders section: a corner-radius control (linked / per-corner) and a border
// control scoped to a side (all / top / right / bottom / left) with style, width,
// and color. Driven by the resolved model like the Size/Spacing sections — blue
// when the picked selector sets it, orange when another does, dim when unset.

type SetProp = (prop: string, value: string, important: boolean) => void;
type ClearProp = (prop: string | string[]) => void;
type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;
type Read = (prop: string) => ResolvedProp | undefined;

type Props = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
};

type Display = {
  present: boolean;
  isSelected: boolean;
  overridden: boolean;
  winnerSelector: string;
  value: string;
  important: boolean;
};

function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) {
    return {
      present: false,
      isSelected: false,
      overridden: false,
      winnerSelector: '',
      value: '',
      important: false,
    };
  }
  const isSelected = resolved.source === 'selected';
  const source = isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner;
  return {
    present: true,
    isSelected,
    overridden: resolved.overridden,
    winnerSelector: resolved.winner.selectorText,
    value: source.value,
    important: source.important,
  };
}

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i);
  if (match) {
    return { value: input.slice(0, match.index).trim(), important: true };
  }
  return { value: input.trim(), important: false };
}

const stripImportant = (value: string) => value.replace(/\s*!important\s*$/i, '').trim();
const joinImportant = (parsed: { readonly value: string; readonly important: boolean }) =>
  parsed.important ? `${parsed.value} !important` : parsed.value;

// ─────────────────── Provenance-aware label (mirrors SizeLabel) ───────────────────

function OverrideNote({ selector, onSelect }: { selector: string; onSelect: () => void }) {
  return (
    <div className="embed-editor_override-note">
      <span>Overridden by a more specific selector:</span>
      <button
        type="button"
        className="embed-editor_override-note-sel"
        title="Select this selector"
        onClick={onSelect}
      >
        {selector}
      </button>
    </div>
  );
}

function PropLabel({
  label,
  prop,
  clearProps,
  className = '',
  read,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  label: ReactNode;
  prop: string;
  clearProps?: string[];
  /** Extra class on the label — the corner glyphs use it to size their pill. */
  className?: string;
} & Pick<Props, 'read' | 'busy' | 'clearProp' | 'onProvenance' | 'onSelectSelector'>) {
  const resolved = read(prop);
  const display = displayOf(resolved);
  const contributors = resolved?.contributors ?? [];
  // A grouped label (the four corners, all four edges) names every property it
  // writes in its tooltip; a single-property one just names its own.
  const tip = clearProps ?? [prop];
  if (display.present && !display.isSelected) {
    return (
      <ProvenanceLabel
        label={label}
        props={tip}
        className={`embed-editor_size-label ${className}`}
        anchorProp={prop}
        busy={busy}
        onProvenance={onProvenance}
      />
    );
  }
  const overriddenClass = display.overridden ? 'is-overridden' : '';
  return (
    <FieldLabel
      className={`embed-editor_size-label ${className} ${overriddenClass}`}
      active={display.isSelected}
      disabled={busy}
      onReset={() => clearProp(clearProps ?? prop)}
      resetLabel="Clear"
      tooltip={<PropTip props={tip} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <>
          {display.overridden ? (
            <OverrideNote
              selector={display.winnerSelector}
              onSelect={() => {
                onSelectSelector(display.winnerSelector, prop);
                close();
              }}
            />
          ) : undefined}
          <ProvenanceList
            contributors={contributors}
            prop={prop}
            onSelect={(selector, selectedProp) => {
              onSelectSelector(selector, selectedProp);
              close();
            }}
          />
        </>
      )}
    >
      {label}
    </FieldLabel>
  );
}

// ─────────────────── Live value field ───────────────────

// The panel's shared field (components/LiveInput), in this section's own box —
// the border rows lay their fields out beside a swatch, so the wrapper is theirs
// while the field itself is the same one every other row uses.
export function LiveInput(props: Omit<Parameters<typeof SharedLiveInput>[0], 'wrapClassName'>) {
  return (
    <SharedLiveInput wrapClassName="embed-editor_field embed-editor_border-field" {...props} />
  );
}

// ─────────────────────────── Icons ───────────────────────────

// Webflow's corner glyphs: the box drawn dim, with the one rounded corner this
// field controls picked out in full strength.
function CornerIcon({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  const box = {
    tl: [
      'M14 14V9H13V13H9V14H14Z',
      'M7 14V13H3V9H2V14H7Z',
      'M2 7H3V6.5C3 4.567 4.567 3 6.5 3H7V2H6.5C4.01472 2 2 4.01472 2 6.5V7Z',
      'M9 2V3H13V7H14V2H9Z',
    ],
    tr: [
      'M2 14V9H3V13H7V14H2Z',
      'M9 14V13H13V9H14V14H9Z',
      'M14 7H13V6.5C13 4.567 11.433 3 9.5 3H9V2H9.5C11.9853 2 14 4.01472 14 6.5V7Z',
      'M7 2V3H3V7H2V2H7Z',
    ],
    bl: [
      'M2 2V7H3V3H7V2H2Z',
      'M9 2V3H13V7H14V2H9Z',
      'M14 9H13V13H9V14H14V9Z',
      'M7 14V13H6.5C4.567 13 3 11.433 3 9.5V9H2V9.5C2 11.9853 4.01472 14 6.5 14H7Z',
    ],
    br: [
      'M2 2V7H3V3H7V2H2Z',
      'M9 2V3H13V7H14V2H9Z',
      'M14 9H13V11.5C13 12.3284 12.3284 13 11.5 13H9V14H11.5C12.8807 14 14 12.8807 14 11.5V9Z',
      'M7 14V13H3V9H2V14H7Z',
    ],
  }[corner];
  const arc = {
    tl: 'M2.5 7V6.5C2.5 4.29086 4.29086 2.5 6.5 2.5H7',
    tr: 'M13.5 7V6.5C13.5 4.29086 11.7091 2.5 9.5 2.5H9',
    bl: 'M2.5 9V9.5C2.5 11.7091 4.29086 13.5 6.5 13.5H7',
    br: 'M13.5 9V9.5C13.5 11.7091 11.7091 13.5 9.5 13.5H9',
  }[corner];
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g opacity="0.4">
        {box.map((path, i) => (
          <path key={i} d={path} fill="currentColor" />
        ))}
      </g>
      <path d={arc} stroke="currentColor" />
    </svg>
  );
}

// ─────────────────────────── Radius ───────────────────────────

const RADIUS = 'border-radius';
const CORNERS = [
  { prop: 'border-top-left-radius', corner: 'tl' as const, name: 'Top left' },
  { prop: 'border-top-right-radius', corner: 'tr' as const, name: 'Top right' },
  { prop: 'border-bottom-left-radius', corner: 'bl' as const, name: 'Bottom left' },
  { prop: 'border-bottom-right-radius', corner: 'br' as const, name: 'Bottom right' },
];

type Corners = { tl: string; tr: string; bl: string; br: string };

// Parse a `border-radius` shorthand into our four corners. Only the horizontal
// radii drive per-corner editing (the elliptical `/ y…` part, if present, is
// dropped). 1–4 values expand per spec: 1 → all; 2 → tl/br=a, tr/bl=b;
// 3 → tl=a, tr/bl=b, br=c; 4 → tl tr br bl.
function parseRadius(shorthand: string): Corners {
  const parts = splitTopLevelSpaces(stripImportant(shorthand).split('/')[0] ?? '').filter(Boolean);
  return {
    tl: parts[0] ?? '',
    tr: parts[1] ?? parts[0] ?? '',
    br: parts[2] ?? parts[0] ?? '',
    bl: parts[3] ?? parts[1] ?? parts[0] ?? '',
  };
}

interface RadiusWrite {
  readonly onLive: (next: string) => void;
  readonly onCommit: (next: string) => void;
}

// The Radius control: one field per property — the `border-radius` shorthand first,
// then the four corner longhands. A corner left empty inherits the shorthand, which
// its placeholder shows; typing in it writes that corner's longhand (which wins over
// the shorthand in the cascade), and clearing it hands the corner back.
function RadiusControl(props: Props) {
  const { read, busy } = props;
  const radiusDisplay = displayOf(read(RADIUS));
  const fromShorthand = parseRadius(radiusDisplay.value);
  const write = (prop: string): RadiusWrite => ({
    onLive: (next: string) => {
      const trimmed = next.trim();
      if (trimmed) {
        const { value, important } = parseImportant(trimmed);
        props.liveSetProp(prop, value, important);
      }
    },
    onCommit: (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) {
        props.clearProp(prop);
        return;
      }
      const { value, important } = parseImportant(trimmed);
      props.setProp(prop, value, important);
    },
  });
  return (
    <>
      <div className="embed-editor_size-row">
        {/* This label belongs to the field beside it — the `border-radius` shorthand
            and nothing else; each corner glyph below owns its own longhand. */}
        <PropLabel
          label="Radius"
          prop={RADIUS}
          read={read}
          busy={busy}
          clearProp={props.clearProp}
          onProvenance={props.onProvenance}
          onSelectSelector={props.onSelectSelector}
        />
        <div className="embed-editor_radius-head">
          <LiveInput
            value={radiusDisplay.present ? joinImportant(radiusDisplay) : ''}
            busy={busy}
            ariaLabel="Border radius"
            prop={RADIUS}
            {...write(RADIUS)}
          />
        </div>
      </div>
      <div className="embed-editor_radius-grid">
        {CORNERS.map((field) => (
          <CornerField
            key={field.prop}
            field={field}
            placeholder={fromShorthand[field.corner] || '0'}
            props={props}
            write={write(field.prop)}
          />
        ))}
      </div>
    </>
  );
}

// One corner's longhand field, with its corner glyph as the label.
function CornerField({
  field,
  placeholder,
  props,
  write,
}: {
  field: (typeof CORNERS)[number];
  placeholder: string;
  props: Props;
  write: RadiusWrite;
}) {
  const { read, busy } = props;
  const display = displayOf(read(field.prop));
  return (
    <div className="embed-editor_radius-corner">
      {/* The corner glyph IS the label: blue when the picked selector sets this
          corner, orange when another does, dim when it only inherits the
          shorthand. Its menu clears just this corner. */}
      <PropLabel
        label={
          <>
            <CornerIcon corner={field.corner} />
            <span className="u-sr-only">{field.name} radius</span>
          </>
        }
        prop={field.prop}
        className="embed-editor_radius-corner-label"
        read={read}
        busy={busy}
        clearProp={props.clearProp}
        onProvenance={props.onProvenance}
        onSelectSelector={props.onSelectSelector}
      />
      <LiveInput
        value={display.present ? joinImportant(display) : ''}
        busy={busy}
        ariaLabel={`${field.name} radius`}
        placeholder={placeholder}
        prop={field.prop}
        {...write}
      />
    </div>
  );
}

// ─────────────────────────── Border side + style/width/color ───────────────────────────

type Side = 'all' | 'top' | 'right' | 'bottom' | 'left';
type Facet = 'style' | 'width' | 'color';
const EDGES = ['top', 'right', 'bottom', 'left'] as const;

// Props the label clears — for 'all', all four edges plus any leftover shorthand.
const facetClear = (facet: Facet, side: Side): string[] =>
  side === 'all'
    ? [`border-${facet}`, ...EDGES.map((edge) => `border-${edge}-${facet}`)]
    : [`border-${side}-${facet}`];
// Representative property to read / label. A single side owns its edge longhand;
// "all" owns only the border facet shorthand. It must not borrow a side value — doing
// so makes the center selector show (and edit) Bottom when only Bottom is configured.
function facetRead(facet: Facet, side: Side, read: Read): { d: Display; prop: string } {
  const prop = side === 'all' ? `border-${facet}` : `border-${side}-${facet}`;
  return { d: displayOf(read(prop)), prop };
}
const facetExternal = (display: Display) =>
  display.present ? (display.important ? `${display.value} !important` : display.value) : '';
// How a facet write lands: live while typing or dragging, or committed.
interface WriteOptions {
  readonly live: boolean;
}
type FacetWrite = (next: string, options: WriteOptions) => void;

function facetWrite(facet: Facet, side: Side, props: Props): FacetWrite {
  return (next, { live }) => {
    const trimmed = next.trim();
    if (!trimmed) {
      if (!live) {
        props.clearProp(facetClear(facet, side));
      }
      return;
    }
    const { value, important } = parseImportant(trimmed);
    const set = live ? props.liveSetProp : props.setProp;
    if (side === 'all') {
      // Write the SINGLE `border-<facet>` shorthand — not the four edge longhands.
      // Webflow groups the sides, so setting them one at a time makes it drop/flash
      // the others (the read/write thrash the radius control avoids by writing one
      // `border-radius`). One property → one native write → no flicker.
      set(`border-${facet}`, value, important);
      // On commit, drop any stray per-side longhands so the shorthand stays the source
      // — but only when some exist, so a plain "all" edit stays a single write.
      if (!live) {
        const strays = EDGES.map((edge) => `border-${edge}-${facet}`).filter(
          (prop) => displayOf(props.read(prop)).present,
        );
        if (strays.length) {
          props.clearProp(strays);
        }
      }
    } else {
      set(`border-${side}-${facet}`, value, important);
    }
  };
}

// A blue edge means the picked selector actually sets that side. Keep this separate
// from `side` (the neutral raised button), which only says which side's fields are
// currently open. This lets Bottom remain visibly applied while All is being viewed.
function appliedBorderSides(read: Read): Set<Side> {
  const applied = new Set<Side>();
  const owns = (prop: string) => displayOf(read(prop)).isSelected;
  if (['border', 'border-style', 'border-width', 'border-color'].some(owns)) {
    applied.add('all');
  }
  for (const side of EDGES) {
    if (
      [
        `border-${side}`,
        `border-${side}-style`,
        `border-${side}-width`,
        `border-${side}-color`,
      ].some(owns)
    ) {
      applied.add(side);
    }
  }
  return applied;
}

function SideSelector({
  side,
  applied,
  onPick,
}: {
  side: Side;
  applied: ReadonlySet<Side>;
  onPick: (s: Side) => void;
}) {
  const sideButton = (option: Side, label: string) => (
    <button
      type="button"
      className={
        `embed-editor_border-side is-${option} ${side === option ? 'is-active' : ''} ` +
        (applied.has(option) ? 'is-applied' : '')
      }
      aria-pressed={side === option}
      aria-label={option === 'all' ? 'All borders' : `${label} border`}
      onClick={() => onPick(option)}
    >
      <span className="embed-editor_border-side-mark" />
    </button>
  );
  return (
    <div className="embed-editor_border-sides" role="group" aria-label="Border side">
      {sideButton('top', 'Top')}
      <div className="embed-editor_border-sides-mid">
        {sideButton('left', 'Left')}
        {sideButton('all', 'All')}
        {sideButton('right', 'Right')}
      </div>
      {sideButton('bottom', 'Bottom')}
    </div>
  );
}

const STYLE_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'none', label: '✕', ariaLabel: 'None' },
  {
    value: 'solid',
    label: <span className="embed-editor_border-style-line is-solid" />,
    ariaLabel: 'Solid',
  },
  {
    value: 'dashed',
    label: <span className="embed-editor_border-style-line is-dashed" />,
    ariaLabel: 'Dashed',
  },
  {
    value: 'dotted',
    label: <span className="embed-editor_border-style-line is-dotted" />,
    ariaLabel: 'Dotted',
  },
];
const STYLE_VALUES = new Set(STYLE_OPTIONS.map((option) => option.value));

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.2 6.2 8 10l3.8-3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function MenuItem({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`embed-editor_display-menu-item ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// The border-style segmented bar (None / Solid / Dashed / Dotted) + a chevron menu
// whose Custom item enters a free-value mode (double / groove / var()…) and offers
// the presets to switch back — mirroring the Display / Float / Clear controls. Writes
// go through the side-aware `write` (which handles the `border-style` shorthand for
// "all" vs a per-side longhand).
function StyleControl({
  value,
  prop,
  busy,
  write,
  clear,
}: {
  value: string;
  /** The property this bar edits (side-aware) — its computed value highlights an
   *  unset control, so an inherited or UA style shows instead of an empty bar. */
  prop: string;
  busy: boolean;
  write: FacetWrite;
  clear: () => void;
}) {
  const lower = value.trim().toLowerCase();
  // Unset → what the page draws: its computed border style, or `none` (the initial
  // value) when there's no canvas to ask.
  const shown = useHighlight(
    lower,
    prop,
    STYLE_OPTIONS.map((option) => option.value),
    'none',
  );
  const customMode = !!lower && !STYLE_VALUES.has(lower);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useMenuDismiss({ open, rootRef, setOpen });
  const requestFocus = useFocusOnceReady({ customMode, busy, inputRef });

  const pick = (next: string) => {
    setOpen(false);
    if (next !== lower) {
      write(next, { live: false });
    }
  };
  const enterCustom = () => {
    setOpen(false);
    requestFocus();
    write('unset', { live: false });
  };

  return (
    <div
      ref={rootRef}
      className={`embed-editor_display embed-editor_border-style ${customMode ? 'is-custom' : ''}`}
      role="group"
      aria-label="Border style"
    >
      <SegmentPill />
      {customMode ? (
        <StyleCustomField
          value={value}
          busy={busy}
          inputRef={inputRef}
          write={write}
          clear={clear}
        />
      ) : (
        <StyleSegments shown={shown} busy={busy} pick={pick} />
      )}
      <StyleMenu
        open={open}
        customMode={customMode}
        shown={shown}
        busy={busy}
        onToggle={() => setOpen((wasOpen) => !wasOpen)}
        pick={pick}
        enterCustom={enterCustom}
      />
    </div>
  );
}

// None / Solid / Dashed / Dotted.
function StyleSegments({
  shown,
  busy,
  pick,
}: {
  shown: string;
  busy: boolean;
  pick: (next: string) => void;
}) {
  return STYLE_OPTIONS.map((seg) => (
    <button
      key={seg.value}
      type="button"
      role="radio"
      aria-checked={shown === seg.value}
      className={`embed-editor_display-seg ${shown === seg.value ? 'is-selected' : ''}`}
      disabled={busy}
      title={seg.ariaLabel}
      aria-label={seg.ariaLabel}
      onClick={() => pick(seg.value)}
    >
      {seg.label}
    </button>
  ));
}

// Focus the custom field once its `unset` write settles (the input is disabled
// mid-save). Returns the request to make when entering custom mode.
function useFocusOnceReady({
  customMode,
  busy,
  inputRef,
}: {
  customMode: boolean;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const wantFocus = useRef(false);
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [customMode, busy, inputRef]);
  return () => {
    wantFocus.current = true;
  };
}

// Closes the open menu on an outside click or Escape.
function useMenuDismiss({
  open,
  rootRef,
  setOpen,
}: {
  open: boolean;
  rootRef: React.RefObject<HTMLDivElement>;
  setOpen: (open: boolean) => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, rootRef, setOpen]);
}

// The free-value field of custom mode: live-writes while typing, commits on blur
// (clearing the property when emptied). It mounts only in custom mode, starting from
// the current value, and mirrors external edits unless the user is typing.
function StyleCustomField({
  value,
  busy,
  inputRef,
  write,
  clear,
}: {
  value: string;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  write: FacetWrite;
  clear: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const commitCustom = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      clear();
      return;
    }
    const { value: styleValue, important } = parseImportant(trimmed);
    write(important ? `${styleValue} !important` : styleValue, { live: false });
  };
  return (
    <VariableConnect
      ariaLabel="Connect border style to a variable"
      disabled={busy}
      prop="border-style"
      onPick={(binding) => write(binding, { live: false })}
    >
      <input
        ref={inputRef}
        className="embed-editor_value-input embed-editor_display-input"
        value={draft}
        placeholder="custom value"
        spellCheck={false}
        disabled={busy}
        onChange={(event) => {
          setDraft(event.target.value);
          const trimmed = event.target.value.trim();
          if (trimmed) {
            write(trimmed, { live: true });
          }
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commitCustom();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitInPlace(event.currentTarget);
          }
        }}
        aria-label="Border style value"
      />
    </VariableConnect>
  );
}

// The chevron and its menu: the presets from custom mode, or Custom from the bar.
function StyleMenu({
  open,
  customMode,
  shown,
  busy,
  onToggle,
  pick,
  enterCustom,
}: {
  open: boolean;
  customMode: boolean;
  shown: string;
  busy: boolean;
  onToggle: () => void;
  pick: (next: string) => void;
  enterCustom: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More border style options"
        disabled={busy}
        onClick={onToggle}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode ? (
            STYLE_OPTIONS.map((seg) => (
              <MenuItem
                key={seg.value}
                label={seg.ariaLabel ?? seg.value}
                selected={shown === seg.value}
                onClick={() => pick(seg.value)}
              />
            ))
          ) : (
            <MenuItem label="Custom" selected={false} onClick={enterCustom} />
          )}
        </div>
      ) : undefined}
    </>
  );
}

export function ColorVariableInput({
  value,
  swatchValue = value,
  busy,
  ariaLabel,
  prop = 'color',
  onLive,
  onCommit,
  onVariablePick,
}: {
  value: string;
  swatchValue?: string;
  busy: boolean;
  ariaLabel: string;
  prop?: string;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
  onVariablePick?: (binding: string) => void;
}) {
  // A live drag writes to the canvas, not to the model this field reads — so the
  // value it emitted is what both show until the model catches up.
  const [shown, noteLive] = useLiveColor(value);
  return (
    <div className="embed-editor_border-color">
      <ColorSwatch
        value={stripImportant(shown === value ? swatchValue : shown)}
        busy={busy}
        ariaLabel={ariaLabel}
        onChange={(color, live) => {
          noteLive(live ? color : undefined);
          if (live) {
            onLive(color);
          } else {
            onCommit(color);
          }
        }}
      />
      <LiveInput
        value={shown}
        busy={busy}
        ariaLabel={ariaLabel}
        placeholder="black"
        prop={prop}
        onLive={onLive}
        onCommit={onCommit}
        {...(onVariablePick === undefined ? {} : { onVariablePick })}
      />
    </div>
  );
}

function ColorField({ side, props }: { side: Side; props: Props }) {
  const value = facetExternal(facetRead('color', side, props.read).d);
  const write = facetWrite('color', side, props);
  return (
    <ColorVariableInput
      value={value}
      busy={props.busy}
      ariaLabel={`${side} border color`}
      prop="border-color"
      onLive={(next) => write(next, { live: true })}
      onCommit={(next) => write(next, { live: false })}
    />
  );
}

function BorderControl(props: Props) {
  const { busy } = props;
  const [side, setSide] = useState<Side>('all');
  const applied = appliedBorderSides(props.read);
  const styleFacet = facetRead('style', side, props.read);
  const widthFacet = facetRead('width', side, props.read);
  const colorFacet = facetRead('color', side, props.read);
  const writeStyle = facetWrite('style', side, props);
  const writeWidth = facetWrite('width', side, props);

  return (
    <div className="embed-editor_border-body">
      <SideSelector side={side} applied={applied} onPick={setSide} />
      <div className="embed-editor_border-fields">
        <div className="embed-editor_size-row">
          <PropLabel
            label="Style"
            prop={styleFacet.prop}
            clearProps={facetClear('style', side)}
            {...props}
          />
          <StyleControl
            value={styleFacet.d.present ? styleFacet.d.value.trim() : ''}
            prop={styleFacet.prop}
            busy={busy}
            write={writeStyle}
            clear={() => props.clearProp(facetClear('style', side))}
          />
        </div>
        <div className="embed-editor_size-row">
          <PropLabel
            label="Width"
            prop={widthFacet.prop}
            clearProps={facetClear('width', side)}
            {...props}
          />
          <LiveInput
            value={facetExternal(widthFacet.d)}
            busy={busy}
            ariaLabel={`${side} border width`}
            prop="border-width"
            onLive={(next) => writeWidth(next, { live: true })}
            onCommit={(next) => writeWidth(next, { live: false })}
          />
        </div>
        <div className="embed-editor_size-row">
          <PropLabel
            label="Color"
            prop={colorFacet.prop}
            clearProps={facetClear('color', side)}
            {...props}
          />
          <ColorField side={side} props={props} />
        </div>
      </div>
    </div>
  );
}

export default function BordersSection(props: Props) {
  return (
    <div className="embed-editor_borders">
      <RadiusControl {...props} />
      <div className="embed-editor_border-heading">Borders</div>
      <BorderControl {...props} />
    </div>
  );
}
