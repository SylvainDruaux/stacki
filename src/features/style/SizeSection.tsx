import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import { useHighlight } from './model/computedStyle';
import { type SegmentedOption, HoverTooltip } from './components/SegmentedControl';
import Select, { type SelectOption } from './components/Select';
import useScrub, { type ScrubHandlers } from './components/useScrub';
import { handleArrowStep } from './model/numberStep';

function tooltipArrowStyle(
  arrowRight: number,
): CSSProperties & { readonly '--tip-arrow-right': string } {
  return { '--tip-arrow-right': `${arrowRight}px` };
}
import { useFieldDraft } from './model/fieldDraft';
import ProvenanceList from './ProvenanceList';
import VariableConnect from './VariableConnect';
import type { Contributor, ResolvedProp } from './model/resolved';
import { splitTopLevelSpaces } from './model/background';
import SegmentPill from './components/SegmentPill';
import { commitInPlace } from './model/commitInPlace';

// The Size section of the style panel. Every control is always rendered (Webflow
// parity), driven by the resolved model: a property is blue when the picked
// selector sets it, orange when another selector does (click the label for
// provenance), or empty when unset. Text fields update the CSS live as you type
// (liveSetProp) and run the authoritative commit on blur. All writes target the
// picked selector (creating its rule on first edit, handled by the parent).

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
  /** Switch the panel's pick to the given selector (click the override note tag). */
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

// A size control's label: blue (picked selector sets it) → FieldLabel with a
// clear menu; orange (another selector) → a button opening provenance; unset →
// a dim caption. When the picked selector sets it but a more specific selector
// wins, the label goes red + struck through and its menu names the winner.
function SizeLabel({
  label,
  prop,
  display,
  contributors,
  busy,
  scrubProps,
  onClear,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  display: Display;
  contributors: Contributor[];
  busy: boolean;
  scrubProps?: ScrubHandlers;
  onClear: () => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  if (display.present && !display.isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={display.isSelected}
      disabled={busy}
      onReset={onClear}
      resetLabel="Clear"
      tooltip={<PropTip props={[prop]} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={contributors}
          prop={prop}
          onSelect={(selector, selectorProp) => {
            onSelectSelector(selector, selectorProp);
            close();
          }}
        />
      )}
      {...(scrubProps === undefined ? {} : { scrubProps })}
    >
      {label}
    </FieldLabel>
  );
}

// ─────────────────── Live text field (plain input) ───────────────────

function LivePropField({
  prop,
  label,
  placeholder,
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  label: string;
  placeholder: string;
} & Props) {
  const display = displayOf(read(prop));
  const field = useLivePropEditing({ prop, display, busy, setProp, clearProp, liveSetProp });
  return (
    <>
      <SizeLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        scrubProps={field.scrub.label}
        onClear={field.clear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <VariableConnect
        code
        ariaLabel={`Connect ${label} to a variable`}
        disabled={busy}
        prop={prop}
        onPick={(binding) => setProp(prop, binding, false)}
      >
        <input
          {...field.scrub.input}
          className="u-input embed-editor_size-input"
          data-prop={prop}
          value={field.draft}
          onChange={(event) => field.change(event.target.value)}
          onFocus={field.focus}
          onBlur={field.blur}
          onKeyDown={field.keyDown}
          disabled={busy}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
        />
      </VariableConnect>
    </>
  );
}

// The length field's editing state: the draft that follows the model while
// nobody is typing, live writes while someone is, and the commit on blur.
function useLivePropEditing({
  prop,
  display,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  prop: string;
  display: Display;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
}) {
  const external = display.present ? withImportant(display) : '';
  const { draft, setDraft, focused, cleared } = useFieldDraft(external, { busy });
  const { cancelLive, liveNow, scheduleLive } = useDebouncedLive((value, important) =>
    liveSetProp(prop, value, important),
  );
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      clearProp(prop);
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: (text) => {
      setDraft(text);
      commit(text);
    },
  });
  return {
    draft,
    scrub,
    clear: () => {
      cleared();
      clearProp(prop);
    },
    change: (text: string) => {
      setDraft(text);
      scheduleLive(text);
    },
    focus: () => {
      focused.current = true;
    },
    blur: () => {
      focused.current = false;
      cancelLive();
      commit();
    },
    keyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const stepped = stepSizeKey(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        scheduleLive(stepped);
      }
    },
  };
}

// ─────────────────── Shared field plumbing ───────────────────

const withImportant = ({ value, important }: { value: string; important: boolean }) =>
  important ? `${value} !important` : value;

// A draft that follows `value` while the field is not focused, so an edit made
// elsewhere shows up without overwriting what someone is typing.
function useFollowingDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  return { draft, setDraft, focused };
}

// Live writes of typed text, split into value and `!important`. `scheduleLive`
// debounces typing; `liveNow` is the undelayed write for a scrub, which does its
// own throttling — a debounce reset by every mouse move would never fire
// mid-drag. Blank text is never written live.
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

// Enter commits in place; an arrow key steps the number under the caret and
// writes it straight into the input. Returns the stepped text, if any.
function stepSizeKey(event: ReactKeyboardEvent<HTMLInputElement>): string | undefined {
  if (event.key === 'Enter') {
    commitInPlace(event.currentTarget);
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  const input = event.currentTarget;
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

const LENGTH_FIELDS: ReadonlyArray<{ prop: string; label: string; placeholder: string }> = [
  { prop: 'width', label: 'Width', placeholder: 'Auto' },
  { prop: 'height', label: 'Height', placeholder: 'Auto' },
  { prop: 'min-width', label: 'Min W', placeholder: '0px' },
  { prop: 'min-height', label: 'Min H', placeholder: '0px' },
  { prop: 'max-width', label: 'Max W', placeholder: 'None' },
  { prop: 'max-height', label: 'Max H', placeholder: 'None' },
];

// ─────────────────────────── Overflow ───────────────────────────

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
const SHOW_ICON_FIRST_PATH =
  'M8 9.5C8.82843 9.5 9.5 8.82843 9.5 8C9.5 7.17157 8.82843 6.5 8 6.5' +
  'C7.17157 6.5 6.5 7.17157 6.5 8C6.5 8.82843 7.17157 9.5 8 9.5Z';
const SHOW_ICON_SECOND_PATH =
  'M8.00004 4C5.37598 4 3.11613 5.55492 2.08964 7.79148' +
  'C2.02887 7.92388 2.02888 8.07621 2.08965 8.20861C3.11615 10.4451 5.37597 12 8.00001 12' +
  'C10.6241 12 12.8839 10.4451 13.9104 8.20852' +
  'C13.9712 8.07612 13.9712 7.92379 13.9104 7.79139C12.8839 5.55488 10.6241 4 8.00004 4Z' +
  'M8.00001 11C5.86346 11 4.01048 9.78173 3.09961 8.00004C4.01047 6.21831 5.86347 5 8.00004 5' +
  'C10.1366 5 11.9896 6.21827 12.9004 7.99996C11.9896 9.78169 10.1366 11 8.00001 11Z';

function ShowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={SHOW_ICON_FIRST_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={SHOW_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}
const HIDE_ICON_FIRST_PATH =
  'M10.705 11.4122L13.6465 14.3536L14.3536 13.6465L2.35356 1.64648L1.64645 2.35359' +
  'L4.3881 5.09524C3.39355 5.76124 2.5932 6.69436 2.08965 7.79152' +
  'C2.02888 7.92392 2.02888 8.07624 2.08965 8.20865C3.11616 10.4452 5.37598 12 8.00001 12' +
  'C8.9654 12 9.8815 11.7896 10.705 11.4122ZM9.94073 10.6479L5.11152 5.81865' +
  'C4.25765 6.3466 3.55888 7.10172 3.09962 8.00007C4.01049 9.78177 5.86347 11 8.00001 11' +
  'C8.68308 11 9.33716 10.8755 9.94073 10.6479Z';
const HIDE_ICON_SECOND_PATH =
  'M13.9104 8.20856C13.5777 8.93353 13.1154 9.58688 12.5531 10.1389L11.846 9.43184' +
  'C12.2702 9.01685 12.6276 8.5337 12.9004 8C11.9896 6.21831 10.1366 5.00004 8.00005 5.00004' +
  'C7.81174 5.00004 7.62562 5.0095 7.44217 5.02798L6.57167 4.15749' +
  'C7.03127 4.05443 7.50929 4.00004 8.00005 4.00004' +
  'C10.6241 4.00004 12.8839 5.55491 13.9104 7.79143' +
  'C13.9712 7.92383 13.9712 8.07616 13.9104 8.20856Z';

function HideIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={HIDE_ICON_FIRST_PATH} fill="currentColor" />
      <path d={HIDE_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}
const CROP_ICON_PATH =
  'M12 12C12.5523 12 13 11.5523 13 11V5H15.5V4H13V1.5H12V4H5C4.44772 4 4 4.44772 4 5V11H1.5' +
  'V12H4V14.5H5V12H12ZM5 11H12V5H5V11Z';

function CropIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={CROP_ICON_PATH} fill="currentColor" />
    </svg>
  );
}
const SCROLL_ICON_FOURTH_PATH =
  'M12 11.2929L10.3536 9.64645L9.64645 10.3536L12.5 13.2071L15.3536 10.3536L14.6464 9.64645' +
  'L13 11.2929V5H12V11.2929Z';

function ScrollIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path opacity="0.3" d="M3 3H8V11H3V3Z" fill="currentColor" />
      <g opacity="0.67">
        <path d="M1 2H15V3L1 3V2Z" fill="currentColor" />
        <path d="M1 11H8V12H1V11Z" fill="currentColor" />
        <path d={SCROLL_ICON_FOURTH_PATH} fill="currentColor" />
      </g>
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

// Icon segments matching Webflow's overflow control (Auto is text). Reuses the
// display control's segmented-bar CSS.
const OVERFLOW_SEGS: ReadonlyArray<{ value: string; icon?: ReactNode; label: string }> = [
  { value: 'visible', icon: <ShowIcon />, label: 'Visible' },
  { value: 'hidden', icon: <HideIcon />, label: 'Hidden' },
  { value: 'clip', icon: <CropIcon />, label: 'Clip' },
  { value: 'scroll', icon: <ScrollIcon />, label: 'Scroll' },
  { value: 'auto', label: 'Auto' },
];
const OVERFLOW_VALUES = OVERFLOW_SEGS.map((seg) => seg.value);

// Editable free-value field (unset, var(), …) shown in a segment bar's custom mode.
function SegmentCustomInput({
  value,
  busy,
  inputRef,
  onCommit,
  onLiveCommit,
  onClear,
  ariaLabel,
  placeholder = 'custom value',
}: {
  value: string;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  onCommit: (value: string, important: boolean) => void;
  onLiveCommit: (value: string, important: boolean) => void;
  onClear: () => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const { cancelLive, scheduleLive } = useDebouncedLive(onLiveCommit);
  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      onClear();
      return;
    }
    const parsed = parseImportant(trimmed);
    onCommit(parsed.value, parsed.important);
  };
  return (
    <input
      ref={inputRef}
      className="embed-editor_value-input embed-editor_display-input"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        scheduleLive(event.target.value);
      }}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        cancelLive();
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commitInPlace(event.currentTarget);
        }
      }}
      disabled={busy}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );
}

// Delayed hover tooltips per overflow value (reuses the segmented-control tooltip CSS).
const TOOLTIP_DELAY_MS = 500;
const OVERFLOW_TOOLTIPS: Record<string, ReactNode> = {
  visible: (
    <>
      <strong>Visible</strong> shows content that overflows its container.
    </>
  ),
  hidden: (
    <>
      <strong>Hidden</strong> hides overflowing content without adding a scrollbar.
    </>
  ),
  clip: (
    <>
      <strong>Clip</strong> clips content to the element's padding box, similar to{' '}
      <strong>hidden</strong>, but it also prevents any scrolling of the overflowed content,
      including programmatic scrolling.
    </>
  ),
  scroll: (
    <>
      <strong>Scroll</strong> always displays a scrollbar for overflowing content.
    </>
  ),
  auto: (
    <>
      <strong>Auto</strong> only displays a scrollbar when content overflows.
    </>
  ),
};

// One segment of a bar: its value, what the button shows, how it is announced,
// and how the menu lists it.
type BarSegment = { value: string; content: ReactNode; ariaLabel: string; menuLabel: string };

// What distinguishes one segment bar from another: its segments, the value an
// unset property shows, per-value tooltips, and its accessible names.
type SegmentBarConfig = {
  segments: readonly BarSegment[];
  fallback: string;
  tooltips: Record<string, ReactNode>;
  groupLabel: string;
  moreLabel: string;
  customLabel: string;
};

// Segmented icon bar (visible/hidden/clip/scroll/auto) + a dropdown arrow whose
// menu offers Custom; a free value shows the editable field. Mirrors DisplayControl.
// No overflow set → CSS defaults to `visible`, so that segment shows as active.
const OVERFLOW_BAR: SegmentBarConfig = {
  segments: OVERFLOW_SEGS.map((seg) => ({
    value: seg.value,
    content: seg.icon ?? seg.label,
    ariaLabel: seg.label,
    menuLabel: seg.label,
  })),
  fallback: 'visible',
  tooltips: OVERFLOW_TOOLTIPS,
  groupLabel: 'Overflow',
  moreLabel: 'More overflow options',
  customLabel: 'Overflow value',
};

type SegmentBarProps = {
  config: SegmentBarConfig;
  value: string;
  busy: boolean;
  onCommit: (value: string, important: boolean) => void;
  onLiveCommit: (value: string, important: boolean) => void;
  onClear: () => void;
};

// A segmented bar with a trailing dropdown arrow whose menu offers Custom; a
// free value (var(), `unset`, …) shows the editable field instead of segments.
function SegmentBar({ config, value, busy, onCommit, onLiveCommit, onClear }: SegmentBarProps) {
  const current = value.trim().toLowerCase() || config.fallback;
  const customMode = !config.segments.some((segment) => segment.value === current);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useMenuDismiss({ open, rootRef, setOpen });
  const { inputRef, requestFocus } = useCustomFocus({ customMode, busy });
  const tip = useSegmentTooltip({ rootRef, tooltips: config.tooltips });

  const pick = (next: string) => {
    setOpen(false);
    if (next !== current) {
      onCommit(next, false);
    }
  };
  const enterCustom = () => {
    setOpen(false);
    requestFocus();
    onCommit('unset', false);
  };

  return (
    <div
      ref={rootRef}
      className={`embed-editor_display ${customMode ? 'is-custom' : ''}`}
      role="group"
      aria-label={config.groupLabel}
    >
      <SegmentPill />
      {customMode ? (
        <SegmentCustomInput
          value={value}
          busy={busy}
          inputRef={inputRef}
          onCommit={onCommit}
          onLiveCommit={onLiveCommit}
          onClear={onClear}
          ariaLabel={config.customLabel}
        />
      ) : (
        <SegmentButtons
          segments={config.segments}
          current={current}
          busy={busy}
          onPick={pick}
          onHoverStart={tip.startHover}
          onHoverEnd={tip.endHover}
        />
      )}
      <SegmentMenu
        open={open}
        moreLabel={config.moreLabel}
        busy={busy}
        customMode={customMode}
        current={current}
        segments={config.segments}
        onToggle={() => setOpen((previous) => !previous)}
        onPick={pick}
        onEnterCustom={enterCustom}
      />
      <SegmentTooltip
        content={tip.hoveredValue === undefined ? undefined : config.tooltips[tip.hoveredValue]}
        arrowRight={tip.arrowRight}
      />
    </div>
  );
}

// The hovered segment's tooltip, its arrow pointing down at that segment.
function SegmentTooltip({ content, arrowRight }: { content: ReactNode; arrowRight: number }) {
  if (!content) {
    return undefined;
  }
  return (
    <div className="u-segmented-tooltip" role="tooltip" style={tooltipArrowStyle(arrowRight)}>
      {content}
      <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
    </div>
  );
}

// The bar's segments; a press ends any pending tooltip before it picks.
function SegmentButtons({
  segments,
  current,
  busy,
  onPick,
  onHoverStart,
  onHoverEnd,
}: {
  segments: readonly BarSegment[];
  current: string;
  busy: boolean;
  onPick: (value: string) => void;
  onHoverStart: (value: string, element: HTMLElement) => void;
  onHoverEnd: () => void;
}) {
  return segments.map((segment) => (
    <button
      key={segment.value}
      type="button"
      role="radio"
      aria-checked={current === segment.value}
      className={`embed-editor_display-seg ${current === segment.value ? 'is-selected' : ''}`}
      disabled={busy}
      aria-label={segment.ariaLabel}
      onClick={() => {
        onHoverEnd();
        onPick(segment.value);
      }}
      onMouseEnter={(event) => onHoverStart(segment.value, event.currentTarget)}
      onMouseLeave={onHoverEnd}
    >
      {segment.content}
    </button>
  ));
}

// The trailing arrow and its menu: "Custom" from the bar, or the listed values
// to switch back to from a custom value.
function SegmentMenu({
  open,
  moreLabel,
  busy,
  customMode,
  current,
  segments,
  onToggle,
  onPick,
  onEnterCustom,
}: {
  open: boolean;
  moreLabel: string;
  busy: boolean;
  customMode: boolean;
  current: string;
  segments: readonly BarSegment[];
  onToggle: () => void;
  onPick: (value: string) => void;
  onEnterCustom: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={moreLabel}
        disabled={busy}
        onClick={onToggle}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode ? (
            segments.map((segment) => (
              <MenuItem
                key={segment.value}
                label={segment.menuLabel}
                selected={current === segment.value}
                onClick={() => onPick(segment.value)}
              />
            ))
          ) : (
            <MenuItem label="Custom" selected={false} onClick={onEnterCustom} />
          )}
        </div>
      ) : undefined}
    </>
  );
}

// While the menu is open, a press outside the bar or Escape closes it.
function useMenuDismiss({
  open,
  rootRef,
  setOpen,
}: {
  open: boolean;
  rootRef: React.RefObject<HTMLDivElement>;
  setOpen: (open: boolean) => void;
}): void {
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

// Focus the custom field after switching to Custom, once its `unset` write
// settles: the request is remembered until the field exists and is enabled.
function useCustomFocus({ customMode, busy }: { customMode: boolean; busy: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [customMode, busy]);
  return {
    inputRef,
    requestFocus: () => {
      wantFocus.current = true;
    },
  };
}

// Delayed hover tooltip, right-anchored with a down-arrow to the hovered segment.
function useSegmentTooltip({
  rootRef,
  tooltips,
}: {
  rootRef: React.RefObject<HTMLDivElement>;
  tooltips: Record<string, ReactNode>;
}) {
  const [hoveredValue, setHoveredValue] = useState<string | undefined>(undefined);
  const [arrowRight, setArrowRight] = useState(0);
  const hoverTimer = useRef<number | undefined>(undefined);
  const clearHoverTimer = () => {
    if (hoverTimer.current !== undefined) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
  };
  useEffect(() => clearHoverTimer, []);
  const startHover = (segmentValue: string, element: HTMLElement) => {
    if (!tooltips[segmentValue]) {
      return;
    }
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      const root = rootRef.current;
      if (root) {
        const trackRect = root.getBoundingClientRect();
        const buttonRect = element.getBoundingClientRect();
        setArrowRight(trackRect.right - (buttonRect.left + buttonRect.width / 2));
      }
      setHoveredValue(segmentValue);
    }, TOOLTIP_DELAY_MS);
  };
  const endHover = () => {
    clearHoverTimer();
    setHoveredValue(undefined);
  };
  return { hoveredValue, arrowRight, startHover, endHover };
}

// One overflow control row bound to a single property. `fallback` is the value it
// shows when its own longhand isn't set (the main `overflow` value), so Overflow
// X / Y mirror the shorthand until overridden.
function OverflowRow({
  label,
  prop,
  display,
  contributors,
  fallback,
  toggle,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  display: Display;
  contributors: Contributor[];
  fallback: string;
  /** Optional disclosure control rendered next to the label (main row only). */
  toggle?: ReactNode;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  // Nothing authored here → the page's own computed overflow, then the caller's
  // fallback (the shorthand's value, for the X / Y rows).
  const value = useHighlight(
    display.present ? display.value.toLowerCase() : fallback || '',
    prop,
    OVERFLOW_VALUES,
    '',
  );
  const labelElement = (
    <SizeLabel
      label={label}
      prop={prop}
      display={{ ...display, value, important: false }}
      contributors={contributors}
      busy={busy}
      onClear={() => clearProp(prop)}
      onProvenance={onProvenance}
      onSelectSelector={onSelectSelector}
    />
  );
  return (
    <div className="embed-editor_size-row">
      {toggle ? (
        <div className="embed-editor_overflow-head">
          {labelElement}
          {toggle}
        </div>
      ) : (
        labelElement
      )}
      <SegmentBar
        config={OVERFLOW_BAR}
        value={value}
        busy={busy}
        onCommit={(next, important) => setProp(prop, next, important)}
        onLiveCommit={(next, important) => liveSetProp(prop, next, important)}
        onClear={() => clearProp(prop)}
      />
    </div>
  );
}

function OverflowField({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Props) {
  const shorthand = displayOf(read('overflow'));
  const x = displayOf(read('overflow-x'));
  const y = displayOf(read('overflow-y'));
  // The main overflow value drives Overflow X / Y until they're individually set.
  const mainValue = shorthand.present ? shorthand.value.toLowerCase() : '';
  const rowProps = { busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector };

  // Overflow X / Y hide behind a disclosure, opened by default when either is set.
  const [expanded, setExpanded] = useState(x.present || y.present);
  useEffect(() => {
    if (x.present || y.present) {
      setExpanded(true);
    }
  }, [x.present, y.present]);

  const toggle = (
    <button
      type="button"
      className={`embed-editor_overflow-toggle ${expanded ? 'is-open' : ''}`}
      onClick={() => setExpanded((open) => !open)}
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide overflow X and Y' : 'Show overflow X and Y'}
      title="Per-axis overflow (X / Y)"
    >
      <ChevronIcon />
    </button>
  );

  return (
    <>
      <OverflowRow
        label="Overflow"
        prop="overflow"
        display={shorthand}
        contributors={read('overflow')?.contributors ?? []}
        fallback=""
        toggle={toggle}
        {...rowProps}
      />
      {expanded ? (
        <>
          <OverflowRow
            label="Overflow X"
            prop="overflow-x"
            display={x}
            contributors={read('overflow-x')?.contributors ?? []}
            fallback={mainValue}
            {...rowProps}
          />
          <OverflowRow
            label="Overflow Y"
            prop="overflow-y"
            display={y}
            contributors={read('overflow-y')?.contributors ?? []}
            fallback={mainValue}
            {...rowProps}
          />
        </>
      ) : undefined}
    </>
  );
}

// ─────────────────────────── Box sizing ───────────────────────────

const BORDER_BOX_ICON_FIRST_PATH =
  'M4 5C3.44772 5 3 5.44772 3 6V10C3 10.5523 3.44772 11 4 11H12C12.5523 11 13 10.5523 13 10V6' +
  'C13 5.44772 12.5523 5 12 5H4ZM12 6H4V10H12V6Z';
const BORDER_BOX_ICON_SECOND_PATH =
  'M4 2C3.44772 2 3 2.44772 3 3V13C3 13.5523 3.44772 14 4 14H12C12.5523 14 13 13.5523 13 13V3' +
  'C13 2.44772 12.5523 2 12 2H4ZM12 3H4V13H12V3Z';

function BorderBoxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={BORDER_BOX_ICON_FIRST_PATH}
        fill="currentColor"
      />
      <path
        opacity="0.4"
        fillRule="evenodd"
        clipRule="evenodd"
        d={BORDER_BOX_ICON_SECOND_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const CONTENT_BOX_ICON_FIRST_PATH =
  'M3 5C2.44772 5 2 5.44772 2 6V10C2 10.5523 2.44772 11 3 11H13C13.5523 11 14 10.5523 14 10V6' +
  'C14 5.44772 13.5523 5 13 5H3ZM13 6H3L3 10H13V6Z';
const CONTENT_BOX_ICON_SECOND_PATH =
  'M3 2C2.44772 2 2 2.44772 2 3V13C2 13.5523 2.44772 14 3 14H10C10.5523 14 11 13.5523 11 13V3' +
  'C11 2.44772 10.5523 2 10 2H3ZM10 3H3L3 13H10V3Z';

function ContentBoxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={CONTENT_BOX_ICON_FIRST_PATH}
        fill="currentColor"
      />
      <path
        opacity="0.4"
        fillRule="evenodd"
        clipRule="evenodd"
        d={CONTENT_BOX_ICON_SECOND_PATH}
        fill="currentColor"
      />
    </svg>
  );
}

const BOX_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  {
    value: 'border-box',
    label: <BorderBoxIcon />,
    ariaLabel: 'Border box',
    tooltip: (
      <>
        <strong>Border-box</strong> makes the width and height of the element include the content,
        padding, and border. The overall dimensions of the box do not increase regardless of padding
        and border sizes.
      </>
    ),
  },
  {
    value: 'content-box',
    label: <ContentBoxIcon />,
    ariaLabel: 'Content box',
    tooltip: (
      <>
        <strong>Content-box</strong> makes the width and height of the element include only the
        content. Padding and border sizes are added to the outside of the box's dimensions.
      </>
    ),
  },
];
// Segmented icon bar (border-box / content-box) + a dropdown arrow whose menu offers
// Custom; a free value (`inherit`, `unset`, var(…)…) shows the editable field — the
// same bar as Overflow, so box-sizing matches the Overflow / Display controls. No
// box-sizing set → Webflow assumes border-box, so that segment shows as active.
const BOX_SIZING_BAR: SegmentBarConfig = {
  segments: BOX_OPTIONS.map((option) => ({
    value: option.value,
    content: option.label,
    ariaLabel: option.ariaLabel ?? option.value,
    menuLabel: option.ariaLabel ?? option.value,
  })),
  fallback: 'border-box',
  tooltips: Object.fromEntries(BOX_OPTIONS.map((option) => [option.value, option.tooltip])),
  groupLabel: 'Box sizing',
  moreLabel: 'More box-sizing options',
  customLabel: 'Box sizing value',
};

// ─────────────────────────── Aspect ratio ───────────────────────────

const RATIO_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '2.39 / 1', label: 'Anamorphic (2.39:1)' },
  { value: '2 / 1', label: 'Univisium/Netflix (2:1)' },
  { value: '16 / 9', label: 'Widescreen (16:9)' },
  { value: '3 / 2', label: 'Landscape (3:2)' },
  { value: '2 / 3', label: 'Portrait (2:3)' },
  { value: '1 / 1', label: 'Square (1:1)' },
];

// Parse an aspect-ratio value into width/height numbers (single number → n/1).
function parseRatio(value: string): { width: string; height: string } | undefined {
  const text = value.trim().toLowerCase();
  if (!text || text === 'auto') {
    return undefined;
  }
  if (text.includes('/')) {
    const [width, height] = text.split('/').map((part) => part.trim());
    if (width && /^[\d.]+$/.test(width) && (!height || /^[\d.]+$/.test(height))) {
      return { width, height: height || '1' };
    }
    return undefined;
  }
  return /^[\d.]+$/.test(text) ? { width: text, height: '1' } : undefined;
}

// Which dropdown option the value represents: 'auto', a preset value, 'custom'
// (a non-preset numeric ratio → the W:H pair) or 'other' (a free value like
// unset / var(--x) / calc(…) → the plain text field).
function ratioKeyOf(value: string): string {
  const text = value.trim().toLowerCase();
  if (!text || text === 'auto') {
    return 'auto';
  }
  const parsed = parseRatio(value);
  if (!parsed) {
    return 'other';
  }
  const match = RATIO_PRESETS.find(
    (preset) => preset.value === `${parsed.width} / ${parsed.height}`,
  );
  return match ? match.value : 'custom';
}

// A number-only field (no unit) that live-updates as you type and on ↑/↓.
function RatioNumberInput({
  value,
  busy,
  ariaLabel,
  onLive,
  onCommit,
}: {
  value: string;
  busy: boolean;
  ariaLabel: string;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const sanitize = (raw: string) => raw.replace(/[^\d.]/g, '');
  const commitScrub = (text: string) => {
    setDraft(text);
    onCommit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: onLive,
    onCommit: commitScrub,
  });

  return (
    <input
      {...scrub.input}
      className="u-input embed-editor_ratio-input"
      value={draft}
      inputMode="decimal"
      onChange={(event) => {
        const next = sanitize(event.target.value);
        setDraft(next);
        onLive(next);
      }}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        onCommit(draft);
      }}
      onKeyDown={(event) => {
        const stepped = stepSizeKey(event);
        if (stepped !== undefined) {
          setDraft(stepped);
          onLive(stepped);
        }
      }}
      disabled={busy}
      spellCheck={false}
      aria-label={ariaLabel}
    />
  );
}

// Free-text value field for the Ratio "Other" mode — mirrors the Display/Overflow
// custom fields. Any value (unset, var(--x), calc(…), …) live-updates as you type
// and commits on blur; emptying it clears the property. Focuses itself when the
// mode is first entered (once the seeding write clears `busy`) — and only then.
type RatioOtherInputProps = {
  value: string;
  busy: boolean;
  /** The CSS property being edited — filters the variable list to what fits it. */
  prop: string;
  /** Take the caret — true only when this mode was just chosen from the menu. */
  autoFocus?: boolean;
  onCommit: (value: string, important: boolean) => void;
  onLiveCommit: (value: string, important: boolean) => void;
  onClear: () => void;
  ariaLabel?: string;
  placeholder?: string;
};

export function RatioOtherInput({
  value,
  busy,
  prop,
  autoFocus = false,
  onCommit,
  onLiveCommit,
  onClear,
  ariaLabel = 'Aspect ratio value',
  placeholder = 'unset, var(--x)…',
}: RatioOtherInputProps) {
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const { cancelLive, scheduleLive } = useDebouncedLive(onLiveCommit);
  const inputRef = useRef<HTMLInputElement>(null);
  const didFocus = useRef(false);

  // Only when this field was ASKED for — picking "Other" from the menu, where
  // the next thing anyone does is type. It used to focus on mount whatever
  // brought it here, and the other thing that brings it here is selecting an
  // element whose ratio is already a free value (`var(--_visual-ratio)`): the
  // field appeared, took the caret, and selected its text, so clicking an
  // element on the canvas left you typing into the style panel.
  useEffect(() => {
    if (!autoFocus || didFocus.current || busy) {
      return;
    }
    didFocus.current = true;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [autoFocus, busy]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      onClear();
      return;
    }
    const parsed = parseImportant(trimmed);
    onCommit(parsed.value, parsed.important);
  };

  // Wrapped like every other field in the panel: a `var(--x)` in here is the
  // same thing it is in Width or Gap, and it should read as the same chip. This
  // one was a bare <input>, so the one place a variable is MOST likely to be —
  // the field you land in precisely because the value is not a plain one — was
  // the one place it was shown as raw text.
  return (
    <VariableConnect
      code
      ariaLabel={`Connect ${ariaLabel} to a variable`}
      disabled={busy}
      prop={prop}
      onPick={(binding) => onCommit(binding, false)}
    >
      <input
        ref={inputRef}
        className="u-select-custom-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          scheduleLive(event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          cancelLive();
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitInPlace(event.currentTarget);
          }
        }}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </VariableConnect>
  );
}

const RATIO_OPTIONS: SelectOption<string>[] = [
  { value: 'auto', label: 'Auto' },
  ...RATIO_PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
  { value: 'custom', label: 'Custom' },
  { value: 'other', label: 'Other' },
];

function AspectRatioField({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Props) {
  const display = displayOf(read('aspect-ratio'));
  const current = display.present ? display.value : '';
  const derivedKey = display.present ? ratioKeyOf(current) : 'auto';
  const { key, askedForOther, onSelect, clear } = useRatioMode({
    current,
    derivedKey,
    setProp,
    clearProp,
  });

  return (
    <>
      <div className="embed-editor_size-row">
        <SizeLabel
          label="Ratio"
          prop="aspect-ratio"
          display={{ ...display, value: current }}
          contributors={read('aspect-ratio')?.contributors ?? []}
          busy={busy}
          onClear={clear}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <Select
          className="embed-editor_ratio-select"
          value={key}
          options={RATIO_OPTIONS}
          ariaLabel="Aspect ratio"
          disabled={busy}
          onChange={onSelect}
          onPreview={(choice) =>
            liveSetProp(
              'aspect-ratio',
              choice === 'custom' || choice === 'other' ? undefined : (choice ?? undefined),
              false,
            )
          }
          customInput={
            key === 'other' ? (
              <RatioOtherInput
                value={display.present ? withImportant({ ...display, value: current }) : ''}
                busy={busy}
                prop="aspect-ratio"
                autoFocus={askedForOther.current}
                onCommit={(value, important) => setProp('aspect-ratio', value, important)}
                onLiveCommit={(value, important) => liveSetProp('aspect-ratio', value, important)}
                onClear={clear}
              />
            ) : undefined
          }
        />
      </div>
      {key === 'custom' ? (
        <RatioPair current={current} busy={busy} setProp={setProp} liveSetProp={liveSetProp} />
      ) : undefined}
    </>
  );
}

// Which option the ratio dropdown shows. Custom (W:H pair) and Other (free text)
// stick once chosen — even when the value happens to match a preset (1 / 1 vs
// Square) — until a preset/Auto is picked. Everything else derives straight from
// the value.
function useRatioMode({
  current,
  derivedKey,
  setProp,
  clearProp,
}: {
  current: string;
  derivedKey: string;
  setProp: SetProp;
  clearProp: ClearProp;
}) {
  const [forced, setForced] = useState<'custom' | 'other' | undefined>(undefined);
  // Whether "Other" was just chosen here, as opposed to the value simply being
  // one the bar can't show. Only the first of those wants the caret.
  const askedForOther = useRef(false);
  const onSelect = (choice: string) => {
    // "Auto" writes the explicit `aspect-ratio: auto` (the CSS initial value);
    // removing the property is the label's Clear action, not this.
    askedForOther.current = false;
    if (choice === 'auto') {
      setForced(undefined);
      setProp('aspect-ratio', 'auto', false);
      return;
    }
    if (choice === 'custom') {
      setForced('custom');
      const ratio = parseRatio(current);
      setProp('aspect-ratio', ratio ? `${ratio.width} / ${ratio.height}` : '1 / 1', false);
      return;
    }
    if (choice === 'other') {
      setForced('other');
      askedForOther.current = true;
      // Keep an existing free value; otherwise seed with `unset` to type over.
      if (ratioKeyOf(current) !== 'other') {
        setProp('aspect-ratio', 'unset', false);
      }
      return;
    }
    setForced(undefined);
    setProp('aspect-ratio', choice, false);
  };
  const clear = () => {
    setForced(undefined);
    clearProp('aspect-ratio');
  };
  return { key: forced ?? derivedKey, askedForOther, onSelect, clear };
}

// The Custom W:H pair: two number fields that write `W / H` (a blank side as 0).
function RatioPair({
  current,
  busy,
  setProp,
  liveSetProp,
}: {
  current: string;
  busy: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
}) {
  const parsed = parseRatio(current) ?? { width: '1', height: '1' };
  const write = (width: string, height: string, mode: 'live' | 'commit') => {
    const value = `${width || '0'} / ${height || '0'}`;
    if (mode === 'live') {
      liveSetProp('aspect-ratio', value, false);
    } else {
      setProp('aspect-ratio', value, false);
    }
  };
  return (
    <div className="embed-editor_ratio-custom">
      <div className="embed-editor_ratio-pair">
        <div className="embed-editor_ratio-cell">
          <RatioNumberInput
            value={parsed.width}
            busy={busy}
            ariaLabel="Ratio width"
            onLive={(width) => write(width, parsed.height, 'live')}
            onCommit={(width) => write(width, parsed.height, 'commit')}
          />
          <span className="embed-editor_ratio-caption">Width</span>
        </div>
        <span className="embed-editor_ratio-colon">:</span>
        <div className="embed-editor_ratio-cell">
          <RatioNumberInput
            value={parsed.height}
            busy={busy}
            ariaLabel="Ratio height"
            onLive={(height) => write(parsed.width, height, 'live')}
            onCommit={(height) => write(parsed.width, height, 'commit')}
          />
          <span className="embed-editor_ratio-caption">Height</span>
        </div>
      </div>
    </div>
  );
}

function BoxSizingField({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Props) {
  const display = displayOf(read('box-sizing'));
  return (
    <div className="embed-editor_size-row">
      <SizeLabel
        label="Box size"
        prop="box-sizing"
        display={display}
        contributors={read('box-sizing')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('box-sizing')}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegmentBar
        config={BOX_SIZING_BAR}
        value={display.present ? display.value : ''}
        busy={busy}
        onCommit={(next, important) => setProp('box-sizing', next, important)}
        onLiveCommit={(next, important) => liveSetProp('box-sizing', next, important)}
        onClear={() => clearProp('box-sizing')}
      />
    </div>
  );
}

// ─────────────────────── Image fit (object-fit / object-position) ───────────────────────

const FIT_OPTIONS: SelectOption<string>[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'contain', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'none', label: 'None' },
  { value: 'scale-down', label: 'Scale Down' },
];
const FIT_CUSTOM = '__custom__';

const OBJECT_POSITION_PERCENTS = ['0%', '50%', '100%'];
// Which of the 3 grid columns/rows a position token lands on (−1 = a custom offset).
// Empty → center: object-position's initial value is 50% 50%, so an unset position
// reads as centered (unlike background-position, which defaults to the top-left).
function objectPositionAxis(token: string): number {
  const normalized = token.trim().toLowerCase();
  if (normalized === '' || normalized === 'center' || normalized === '50%') {
    return 1;
  }
  if (
    normalized === 'left' ||
    normalized === 'top' ||
    normalized === '0' ||
    normalized === '0%' ||
    normalized === '0px'
  ) {
    return 0;
  }
  if (normalized === 'right' || normalized === 'bottom' || normalized === '100%') {
    return 2;
  }
  return -1;
}

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="12.5" cy="8" r="1.35" />
    </svg>
  );
}

// A position offset field. The same field the rest of the panel uses — it was its
// own smaller control with a bordered box and an inline "%" chip, which made this
// popup read as a different app. The input holds the RAW value, so any unit works
// (10px, 50%, unset, var(--x)…); a bare number still commits as a percentage, which
// is what the placeholder says.
function ObjectPositionInput({
  value,
  busy,
  label,
  onLive,
  onCommit,
}: {
  value: string;
  busy: boolean;
  label: string;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const commitScrub = (text: string) => {
    setDraft(text);
    onCommit(asPositionOffset(text));
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: (text) => onLive(asPositionOffset(text)),
    onCommit: commitScrub,
  });
  return (
    <VariableConnect
      code
      ariaLabel={`Connect ${label} to a variable`}
      disabled={busy}
      prop="object-position"
      onPick={(binding) => onCommit(binding)}
    >
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input"
        value={draft}
        placeholder="50%"
        aria-label={label}
        disabled={busy}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          onLive(asPositionOffset(event.target.value));
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          onCommit(asPositionOffset(draft));
        }}
        onKeyDown={(event) => {
          const stepped = stepSizeKey(event);
          if (stepped !== undefined) {
            setDraft(stepped);
            onLive(asPositionOffset(stepped));
          }
        }}
      />
    </VariableConnect>
  );
}

// A typed offset as written: a bare number is a percentage, anything else (a
// unit, a keyword, a var()) passes through, and blank stays blank.
function asPositionOffset(typed: string): string {
  const text = typed.trim();
  if (text === '') {
    return '';
  }
  return /^-?[\d.]+$/.test(text) ? `${text}%` : text;
}

// Popup shell over the panel — the same darkening backdrop the transform / shadow
// editors use; closes on backdrop click or Escape.
function PositionModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="embed-editor_bg-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="embed-editor_bg-modal embed-editor_pos-modal u-surface-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Object position"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ImageFitField({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Props) {
  const fit = displayOf(read('object-fit'));
  const positionDisplay = displayOf(read('object-position'));
  const [positionOpen, setPositionOpen] = useState(false);
  const positionRaw = positionDisplay.present ? positionDisplay.value.trim() : '';
  const positionSet = positionRaw !== '' && positionRaw.toLowerCase() !== 'unset';

  return (
    <>
      <div className="embed-editor_size-row">
        <SizeLabel
          label="Image fit"
          prop="object-fit"
          display={fit}
          contributors={read('object-fit')?.contributors ?? []}
          busy={busy}
          onClear={() => clearProp('object-fit')}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <div className="embed-editor_imgfit-controls">
          <ObjectFitSelect
            fit={fit}
            busy={busy}
            setProp={setProp}
            clearProp={clearProp}
            liveSetProp={liveSetProp}
          />
          <ObjectPositionButton
            busy={busy}
            positionSet={positionSet}
            positionOpen={positionOpen}
            onToggle={() => setPositionOpen((open) => !open)}
          />
        </div>
      </div>
      {positionOpen ? (
        <PositionModal onClose={() => setPositionOpen(false)}>
          <ObjectPositionEditor
            positionRaw={positionRaw}
            positionSet={positionSet}
            busy={busy}
            setProp={setProp}
            clearProp={clearProp}
            liveSetProp={liveSetProp}
          />
        </PositionModal>
      ) : undefined}
    </>
  );
}

// The "…" button that opens the object-position popup, lit while a position is
// set, with a delayed hover tooltip (the same rich popup the segmented controls
// use).
function ObjectPositionButton({
  busy,
  positionSet,
  positionOpen,
  onToggle,
}: {
  busy: boolean;
  positionSet: boolean;
  positionOpen: boolean;
  onToggle: () => void;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const tip = useDelayedTip();
  return (
    <>
      <button
        ref={moreRef}
        type="button"
        className={
          'embed-editor_icon-btn embed-editor_imgfit-more ' + (positionSet ? 'is-active' : '')
        }
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={positionOpen}
        aria-label="Object position settings"
        onClick={() => {
          tip.end();
          onToggle();
        }}
        onMouseEnter={tip.start}
        onMouseLeave={tip.end}
      >
        <DotsIcon />
      </button>
      {tip.open && moreRef.current && !positionOpen ? (
        <HoverTooltip anchor={moreRef.current}>Object position settings</HoverTooltip>
      ) : undefined}
    </>
  );
}

// A tooltip that opens after a hover delay and closes the moment the pointer
// leaves (or the anchor is pressed).
function useDelayedTip() {
  const [open, setOpen] = useState(false);
  const tipTimer = useRef<number | undefined>(undefined);
  const clearTip = () => {
    if (tipTimer.current !== undefined) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = undefined;
    }
  };
  useEffect(() => clearTip, []);
  const start = () => {
    clearTip();
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = undefined;
      setOpen(true);
    }, 400);
  };
  const end = () => {
    clearTip();
    setOpen(false);
  };
  return { open, start, end };
}

// The object-fit dropdown. "Custom" as the last option: seed `unset` and reveal
// a free-text field for any value (a var()/keyword/etc. Webflow doesn't offer in
// the preset list).
function ObjectFitSelect({
  fit,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  fit: Display;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
}) {
  const [forceCustom, setForceCustom] = useState(false);
  const fitValue = fit.value.trim().toLowerCase();
  const knownFit = FIT_OPTIONS.some((option) => option.value === fitValue);
  const fitCustom = forceCustom || (fit.present && fitValue !== '' && !knownFit);
  // Chosen from the menu, as opposed to a value the list can't show — the field
  // is the same either way, but only the first wants the caret.
  const askedForCustom = useRef(false);
  const pickFit = (choice: string) => {
    if (choice === FIT_CUSTOM) {
      setForceCustom(true);
      askedForCustom.current = true;
      setProp('object-fit', 'unset', false);
      return;
    }
    askedForCustom.current = false;
    setForceCustom(false);
    setProp('object-fit', choice, false);
  };
  return (
    <Select
      className="embed-editor_imgfit-select"
      value={fitCustom ? FIT_CUSTOM : fit.present ? fitValue : 'fill'}
      options={[...FIT_OPTIONS, { value: FIT_CUSTOM, label: 'Custom' }]}
      ariaLabel="Object fit"
      disabled={busy}
      onChange={pickFit}
      onPreview={(choice) =>
        liveSetProp('object-fit', choice === FIT_CUSTOM ? undefined : (choice ?? undefined), false)
      }
      customInput={
        fitCustom ? (
          <RatioOtherInput
            value={fit.present ? withImportant(fit) : ''}
            busy={busy}
            prop="object-fit"
            autoFocus={askedForCustom.current}
            ariaLabel="Object fit value"
            onCommit={(value, important) => setProp('object-fit', value, important)}
            onLiveCommit={(value, important) => liveSetProp('object-fit', value, important)}
            onClear={() => {
              setForceCustom(false);
              clearProp('object-fit');
            }}
          />
        ) : undefined
      }
    />
  );
}

// The object-position popup: a 3×3 preset grid beside Left / Top offset fields.
function ObjectPositionEditor({
  positionRaw,
  positionSet,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  positionRaw: string;
  positionSet: boolean;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
}) {
  const positionParts = splitTopLevelSpaces(positionRaw).filter(Boolean);
  const left = positionParts[0] ?? '';
  const top = positionParts[1] ?? '';
  // A live write only previews a value; a commit of nothing clears the property.
  const writePosition = (value: string, mode: 'live' | 'commit') => {
    if (mode === 'live') {
      if (value) {
        liveSetProp('object-position', value, false);
      }
      return;
    }
    if (value) {
      setProp('object-position', value, false);
    } else {
      clearProp('object-position');
    }
  };
  return (
    <div className="embed-editor_imgfit-pos">
      <FieldLabel
        className="embed-editor_imgfit-pos-label"
        active={positionSet}
        disabled={busy}
        onReset={() => clearProp('object-position')}
        resetLabel="Clear"
        tooltip={<PropTip props={['object-position']} />}
      >
        Position
      </FieldLabel>
      <div className="embed-editor_bg-position">
        <ObjectPositionGrid
          activeColumn={objectPositionAxis(left)}
          activeRow={objectPositionAxis(top)}
          busy={busy}
          onPick={(value) => writePosition(value, 'commit')}
        />
        {/* Divs, not labels. The field these hold is the rich token editor with
          the real <input> hidden behind it — and a <label> hands a click to the
          control it wraps, so clicking into the editor focused that hidden input
          instead and the caret vanished the instant it appeared. The inputs carry
          their own aria-label. */}
        <ObjectPositionFields left={left} top={top} busy={busy} writePosition={writePosition} />
      </div>
    </div>
  );
}

// The Left / Top offset fields. A live edit previews both sides (a blank side as
// 50%); a commit writes both, or clears the position when both are blank.
function ObjectPositionFields({
  left,
  top,
  busy,
  writePosition,
}: {
  left: string;
  top: string;
  busy: boolean;
  writePosition: (value: string, mode: 'live' | 'commit') => void;
}) {
  return (
    <div className="embed-editor_bg-posfields">
      <div className="embed-editor_bg-posfield">
        <span className="embed-editor_bg-posfield-cap">Left</span>
        <ObjectPositionInput
          value={left}
          busy={busy}
          label="Object position left"
          onLive={(value) => writePosition(`${value || '50%'} ${top || '50%'}`, 'live')}
          onCommit={(value) =>
            writePosition(value || top ? `${value || '50%'} ${top || '50%'}` : '', 'commit')
          }
        />
      </div>
      <div className="embed-editor_bg-posfield">
        <span className="embed-editor_bg-posfield-cap">Top</span>
        <ObjectPositionInput
          value={top}
          busy={busy}
          label="Object position top"
          onLive={(value) => writePosition(`${left || '50%'} ${value || '50%'}`, 'live')}
          onCommit={(value) =>
            writePosition(left || value ? `${left || '50%'} ${value || '50%'}` : '', 'commit')
          }
        />
      </div>
    </div>
  );
}

// The 3×3 preset grid: each cell pins the image to that column and row.
function ObjectPositionGrid({
  activeColumn,
  activeRow,
  busy,
  onPick,
}: {
  activeColumn: number;
  activeRow: number;
  busy: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <div className="embed-editor_bg-posgrid" role="group" aria-label="Object position preset">
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((column) => (
          <button
            key={`${row}-${column}`}
            type="button"
            className={
              'embed-editor_bg-poscell ' +
              (activeColumn === column && activeRow === row ? 'is-active' : '')
            }
            disabled={busy}
            aria-label={
              `${['Left', 'Center', 'Right'][column]} ` + `${['top', 'center', 'bottom'][row]}`
            }
            onClick={() =>
              onPick(`${OBJECT_POSITION_PERCENTS[column]} ${OBJECT_POSITION_PERCENTS[row]}`)
            }
          />
        )),
      )}
    </div>
  );
}

// ─────────────────────────── Section ───────────────────────────

export default function SizeSection(props: Props) {
  return (
    <div className="embed-editor_size">
      <div className="embed-editor_size-grid">
        {LENGTH_FIELDS.map((field) => (
          <Fragment key={field.prop}>
            <LivePropField
              prop={field.prop}
              label={field.label}
              placeholder={field.placeholder}
              {...props}
            />
          </Fragment>
        ))}
      </div>
      <OverflowField {...props} />
      <AspectRatioField {...props} />
      <BoxSizingField {...props} />
      <ImageFitField {...props} />
    </div>
  );
}
