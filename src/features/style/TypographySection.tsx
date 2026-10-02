import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import Select, { type SelectOption } from './components/Select';
import SegmentedControl from './components/SegmentedControl';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './model/liveColor';
import useScrub from './components/useScrub';
import { ShadowLength, ShadowColorRow } from './ShadowFields';
import { handleArrowStep } from './model/numberStep';
import { panelBounds } from './model/panelBox';
import { getProjectFontFamilies } from './model/webflow';
import {
  parseShadows,
  serializeShadows,
  blankShadow,
  shadowLabel,
  type Shadow,
} from './model/textShadow';
import { parseHideable, serializeHideable, type Hideable } from './model/hideable';
import LayerList from './LayerList';
import LayerPopover from './LayerPopover';
import ProvenanceList from './ProvenanceList';
import VariableConnect from './VariableConnect';
import type { Contributor, ResolvedProp } from './model/resolved';
import { splitTopLevelSpaces } from './model/background';
import { useHighlight } from './model/computedStyle';
import SegmentPill from './components/SegmentPill';
import { commitInPlace } from './model/commitInPlace';
import { ChevronIcon, MenuItem } from './components/MenuParts';
import { displayOf, parseImportant, type Display } from './model/styleDisplay';

// The Typography section of the style panel. Like the Size section, every control
// is always rendered and driven by the resolved model: a property is blue when the
// picked selector sets it, orange when another selector does (click the label for
// provenance), or empty when unset. Text fields update the CSS live as you type and
// commit authoritatively on blur. All writes target the picked selector.

type SetProp = (prop: string, value: string, important: boolean) => void;
type ClearProp = (prop: string | string[]) => void;
type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;
type Read = (prop: string) => ResolvedProp | undefined;

export type Props = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
};

const joinImportant = ({ value, important }: { value: string; important: boolean }) =>
  important ? `${value} !important` : value;

const CUSTOM = '__custom__';

// ─────────────────────────── Icons ───────────────────────────

function AlignLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1 3H15V4H1V3Z" fill="currentColor" />
      <path d="M1 7H9V8H1V7Z" fill="currentColor" />
      <path d="M11 11H1V12H11V11Z" fill="currentColor" />
    </svg>
  );
}
function AlignCenterIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1 3H15V4H1V3Z" fill="currentColor" />
      <path d="M4 7H12V8H4V7Z" fill="currentColor" />
      <path d="M13 11H3V12H13V11Z" fill="currentColor" />
    </svg>
  );
}
function AlignRightIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1 3H15V4H1V3Z" fill="currentColor" />
      <path d="M7 7H15V8H7V7Z" fill="currentColor" />
      <path d="M15 11H5V12H15V11Z" fill="currentColor" />
    </svg>
  );
}
function AlignJustifyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1 3H15V4H1V3Z" fill="currentColor" />
      <path d="M1 7H15V8H1V7Z" fill="currentColor" />
      <path d="M15 11H1V12H15V11Z" fill="currentColor" />
    </svg>
  );
}
const DECORATION_NONE_ICON_PATH =
  'M8.70708 8.00004L12.3535 4.35359L11.6464 3.64648L7.99998 7.29293' +
  'L4.35353 3.64648L3.64642 4.35359L7.29287 8.00004L3.64642 11.6465L4.35353 12.3536' +
  'L7.99998 8.70714L11.6464 12.3536L12.3535 11.6465L8.70708 8.00004Z';

function DecorNoneIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={DECORATION_NONE_ICON_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
function DecorStrikeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 12H8V9H9V12Z" fill="currentColor" />
      <path d="M12 5H9V7H14V8H3V7H8V5H5V4H12V5Z" fill="currentColor" />
    </svg>
  );
}
function DecorUnderlineIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5 4.5H8.5M8.5 4.5H12M8.5 4.5V12M3 14.5H14" stroke="currentColor" />
    </svg>
  );
}
function DecorOverlineIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 1V2H14V1H3Z" fill="currentColor" />
      <path d="M5 5H8V12H9V5H12V4H5V5Z" fill="currentColor" />
    </svg>
  );
}
// Italicize (font-style)
function FontStyleRegularIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10.5 4H9V12H10.5V13H6.5V12H8V4H6.5V3H10.5V4Z" fill="currentColor" />
    </svg>
  );
}
function FontStyleItalicIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8.80629 4H7V3H12V4H9.86038L7.19371 12H9V13H4V12H6.13962L8.80629 4Z"
        fill="currentColor"
      />
    </svg>
  );
}
const TRANSFORM_CAPS_ICON_PATH =
  'M4.12583 4H5.87413L8.00003 11.2279L10.1258 4H11.8741L14.2271 12H13.1848' +
  'L12.5965 9.99994H9.40354L8.8153 12H7.18477L6.5965 9.99994H3.40354L2.8153 12' +
  'H1.77295L4.12583 4ZM6.30238 8.99994L5.12587 4.9999H4.8741L3.69765 8.99994' +
  'H6.30238ZM12.3024 8.99994L11.1259 4.9999H10.8741L9.69765 8.99994H12.3024Z';

// Capitalize (text-transform)
function TransformCapsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={TRANSFORM_CAPS_ICON_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const TRANSFORM_CAPITALIZE_UPPER_PATH =
  'M4.12583 4H5.87413L8.22713 12H7.18477L6.5965 9.99994H3.40354L2.8153 12H1.77295' +
  'L4.12583 4ZM6.30238 8.99994L5.12587 4.9999H4.8741L3.69765 8.99994H6.30238Z';
const TRANSFORM_CAPITALIZE_LOWER_PATH =
  'M12.5 7H10V6H12.5C13.3284 6 14 6.67157 14 7.5V12H13V11.2909C12.4911 ' +
  '11.7327 11.8268 12 11.1 12H11C9.89543 12 9 11.1046 9 10C9 8.89543 9.89543 8 11 8' +
  'H13V7.5C13 7.22386 12.7761 7 12.5 7ZM13 9V9.1C13 10.1493 12.1493 11 11.1 11' +
  'H11C10.4477 11 10 10.5523 10 10C10 9.44772 10.4477 9 11 9H13Z';

function TransformCapitalizeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={TRANSFORM_CAPITALIZE_UPPER_PATH}
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={TRANSFORM_CAPITALIZE_LOWER_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const TRANSFORM_LOWERCASE_LEFT_PATH =
  'M4 7H6.5C6.77614 7 7 7.22386 7 7.5V8H5C3.89543 8 3 8.89543 3 10C3 11.1046 3.89543 12 5 12' +
  'H5.1C5.82677 12 6.49109 11.7327 7 11.2909V12H8V7.5C8 6.67157 7.32843 6 6.5 6H4V7ZM5 9' +
  'H7V9.1C7 10.1493 6.14934 11 5.1 11H5C4.44772 11 4 10.5523 4 10C4 9.44772 4.44772 9 5 9Z';
const TRANSFORM_LOWERCASE_RIGHT_PATH =
  'M10 7H12.5C12.7761 7 13 7.22386 13 7.5V8H11C9.89543 8 9 8.89543 9 10' +
  'C9 11.1046 9.89543 12 11 12H11.1C11.8268 12 12.4911 11.7327 13 11.2909V12' +
  'H14V7.5C14 6.67157 13.3284 6 12.5 6H10V7ZM11 9H13V9.1C13 10.1493 12.1493 ' +
  '11 11.1 11H11C10.4477 11 10 10.5523 10 10C10 9.44772 10.4477 9 11 9Z';

function TransformLowercaseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={TRANSFORM_LOWERCASE_LEFT_PATH}
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={TRANSFORM_LOWERCASE_RIGHT_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const DIRECTION_LTR_ARROW_PATH =
  'M5 12L12.3111 12L10.6484 10.3555L11.3516 9.64453L14.2071 12.4688' +
  'L11.3555 15.3516L10.6445 14.6484L12.2751 13L5 13L5 12Z';
const DIRECTION_LTR_MARK_PATH =
  'M4.23463 2.15224C4.47728 2.05173 4.73736 2 5 2L5 6C4.73736 6 4.47728 5.94827 ' +
  '4.23463 5.84776C3.99198 5.74725 3.7715 5.59993 3.58579 5.41421C3.40007 5.2285 ' +
  '3.25275 5.00802 3.15224 4.76537C3.05173 4.52272 3 4.26264 3 4C3 3.73736 3.05173 ' +
  '3.47728 3.15224 3.23463C3.25275 2.99198 3.40007 2.7715 3.58579 2.58579' +
  'C3.7715 2.40007 3.99198 2.25275 4.23463 2.15224ZM5 6L5 2H11V3H9V10H8V3H6V10H5L5 6Z';

// Direction icons.
function DirectionLTRIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={DIRECTION_LTR_ARROW_PATH} fill="currentColor" />
      <path
        opacity="0.6"
        fillRule="evenodd"
        clipRule="evenodd"
        d={DIRECTION_LTR_MARK_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const DIRECTION_RTL_ARROW_PATH =
  'M11.0001 12L3.689 12L5.35169 10.3555L4.64848 9.64453L1.79297 12.4688' +
  'L4.64462 15.3516L5.35556 14.6484L3.72502 13L11.0001 13V12Z';
const DIRECTION_RTL_MARK_PATH =
  'M6.23463 2.15224C6.47728 2.05173 6.73736 2 7 2L7 6C6.73736 6 6.47728 5.94827 ' +
  '6.23463 5.84776C5.99198 5.74725 5.7715 5.59993 5.58579 5.41421C5.40007 5.2285 ' +
  '5.25275 5.00802 5.15224 4.76537C5.05173 4.52272 5 4.26264 5 4C5 3.73736 5.05173 ' +
  '3.47728 5.15224 3.23463C5.25275 2.99198 5.40007 2.7715 5.58579 2.58579' +
  'C5.7715 2.40007 5.99198 2.25275 6.23463 2.15224ZM7 6L7 2H13V3H11V10H10V3H8V10H7L7 6Z';

function DirectionRTLIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={DIRECTION_RTL_ARROW_PATH} fill="currentColor" />
      <path
        opacity="0.6"
        fillRule="evenodd"
        clipRule="evenodd"
        d={DIRECTION_RTL_MARK_PATH}
        fill="currentColor"
      />
    </svg>
  );
}

// ─────────────────────────── Label ───────────────────────────

// A typography control's label: blue (picked selector sets it) → FieldLabel with a
// clear menu; orange (another selector) → a button opening provenance; unset → a
// dim caption. Mirrors the Size section's SizeLabel.
export function PropLabel({
  label,
  prop,
  tipProps,
  display: display,
  contributors,
  busy,
  onClear,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  /** Properties named in the hover tooltip — defaults to the one `prop` shown. */
  tipProps?: readonly string[];
  display: Display;
  contributors: Contributor[];
  busy: boolean;
  onClear: () => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const tip = tipProps ?? [prop];
  if (display.present && !display.isSelected) {
    return (
      <ProvenanceLabel
        label={label}
        props={tip}
        anchorProp={prop}
        busy={busy}
        onProvenance={onProvenance}
      />
    );
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={display.isSelected}
      disabled={busy}
      onReset={onClear}
      resetLabel="Clear"
      tooltip={<PropTip props={tip} />}
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
    >
      {label}
    </FieldLabel>
  );
}

// A PropLabel for a control backed by SEVERAL properties (Gap = row/column gaps,
// Direction = flex-direction/-wrap, …). Picks the representative property — one the
// picked selector sets first (blue), else any that's set at all (orange + provenance),
// else the first (grey/unset) — so these grouped labels get the same blue/orange/clear
// states as single-property ones. `onClear` clears the whole group.
export function GroupLabel({
  label,
  props,
  read,
  busy,
  onClear,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  props: readonly string[];
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  onClear: () => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const prop =
    props.find((name) => read(name)?.source === 'selected') ??
    props.find((name) => read(name) !== undefined) ??
    props[0];
  if (prop === undefined) {
    throw new Error('Group label requires at least one property');
  }
  return (
    <PropLabel
      label={label}
      prop={prop}
      tipProps={props}
      display={displayOf(read(prop))}
      contributors={read(prop)?.contributors ?? []}
      busy={busy}
      onClear={onClear}
      onProvenance={onProvenance}
      onSelectSelector={onSelectSelector}
    />
  );
}

// ─────────────────────────── Live text input ───────────────────────────

// Shared draft/live/commit input. Live-updates the canvas ~100ms after a keystroke
// (when onLiveCommit is given) and runs the authoritative commit on blur/Enter.
export function LiveInput({
  value,
  busy,
  placeholder,
  ariaLabel,
  className,
  dataProp,
  prop,
  inputRef,
  autoFocus,
  onCommit,
  onLiveCommit,
  onClear,
}: LiveInputProps) {
  const field = useLiveInputEditing({ value, busy, onCommit, onLiveCommit, onClear });
  return (
    <VariableConnect
      code
      ariaLabel={`Connect ${ariaLabel || 'value'} to a variable`}
      disabled={busy}
      {...(prop === undefined ? {} : { prop })}
      onPick={(binding) => onCommit(binding, false)}
    >
      <input
        {...field.scrub.input}
        ref={inputRef}
        className={className}
        data-prop={dataProp}
        value={field.draft}
        onChange={(event) => field.change(event.target.value)}
        onFocus={field.focus}
        onBlur={field.blur}
        onKeyDown={field.keyDown}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
      />
    </VariableConnect>
  );
}

type LiveInputProps = {
  value: string;
  busy: boolean;
  placeholder?: string;
  ariaLabel: string;
  className: string;
  dataProp?: string;
  /** The CSS property being edited — filters the variable picker to types that fit
   *  it (color props → Color only; font-family → FontFamily; else no color/font). */
  prop?: string;
  inputRef?: React.RefObject<HTMLInputElement>;
  autoFocus?: boolean;
  onCommit: (value: string, important: boolean) => void;
  onLiveCommit?: (value: string, important: boolean) => void;
  onClear: () => void;
};

// The input's editing state: a draft that follows `value` while nobody is
// typing, live writes while someone is, and the commit (or clear) on blur.
function useLiveInputEditing({
  value,
  busy,
  onCommit,
  onLiveCommit,
  onClear,
}: Pick<LiveInputProps, 'value' | 'busy' | 'onCommit' | 'onClear'> & {
  onLiveCommit: LiveInputProps['onLiveCommit'] | undefined;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const { cancelLive, liveNow, scheduleLive } = useDebouncedLive(onLiveCommit);
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onClear();
      return;
    }
    const parsed = parseImportant(trimmed);
    onCommit(parsed.value, parsed.important);
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
    keyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepLiveKey(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        scheduleLive(stepped);
      }
    },
  };
}

// Live writes of typed text, split into value and `!important` — none at all
// without a writer. `scheduleLive` debounces typing; `liveNow` is the undelayed
// write for the scrub, which throttles its own — see useScrub.
function useDebouncedLive(write: ((value: string, important: boolean) => void) | undefined) {
  const liveTimer = useRef<number | undefined>(undefined);
  const cancelLive = () => {
    if (liveTimer.current !== undefined) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = undefined;
    }
  };
  useEffect(() => cancelLive, []);
  const liveNow = (text: string) => {
    if (!write) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const parsed = parseImportant(trimmed);
    write(parsed.value, parsed.important);
  };
  const scheduleLive = (text: string) => {
    if (!write) {
      return;
    }
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
function stepLiveKey(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
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

// A label + text field bound to one property. An optional swatch (color field)
// renders inside the field to the left of the input.
type TextFieldProps = {
  prop: string;
  label: string;
  placeholder?: string;
  swatch?: ReactNode;
  /** Render a colour swatch for this same property before the field. Owned here
   *  rather than passed in as `swatch` so a drag on it shows in the field: the
   *  drag writes to the canvas, not to the model this field reads. */
  swatchLabel?: string;
} & Props;

function TextField(props: TextFieldProps) {
  const { prop, label, placeholder, swatch, swatchLabel, read, busy } = props;
  const { setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read(prop));
  const external = display.present ? joinImportant(display) : '';
  const [shown, noteLive] = useLiveColor(external);
  const ownSwatch = swatchLabel ? (
    <ColorSwatch
      value={shown}
      busy={busy}
      ariaLabel={swatchLabel}
      onChange={(color, live) => {
        noteLive(live ? color : undefined);
        if (live) {
          liveSetProp(prop, color, false);
        } else {
          setProp(prop, color, false);
        }
      }}
    />
  ) : undefined;
  const input = (
    <LiveInput
      value={shown}
      busy={busy}
      {...(placeholder === undefined ? {} : { placeholder })}
      ariaLabel={label}
      className="u-input embed-editor_size-input"
      dataProp={prop}
      prop={prop}
      onCommit={(value, important) => setProp(prop, value, important)}
      onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
      onClear={() => clearProp(prop)}
    />
  );
  const fieldSwatch = ownSwatch ?? swatch;
  return (
    <>
      <PropLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      {fieldSwatch ? (
        <div className="embed-editor_type-field">
          {fieldSwatch}
          {input}
        </div>
      ) : (
        input
      )}
    </>
  );
}

// A stacked cell for the three-up bottom row: the input on top with its clickable
// label centered underneath (Webflow's Letter spacing / Text indent / Columns
// layout). DOM order (input, then label) doesn't affect the label's popup, which
// positions relative to its own wrap and clamps into the panel.
export function StackedField({
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
  placeholder?: string;
} & Props) {
  const display = displayOf(read(prop));
  const external = display.present ? joinImportant(display) : '';
  return (
    <div className="embed-editor_type-cell">
      <LiveInput
        value={external}
        busy={busy}
        {...(placeholder === undefined ? {} : { placeholder })}
        ariaLabel={label}
        className="u-input embed-editor_size-input"
        dataProp={prop}
        prop={prop}
        onCommit={(value, important) => setProp(prop, value, important)}
        onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
        onClear={() => clearProp(prop)}
      />
      <PropLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

// ─────────────────────────── Font family ───────────────────────────

// Webflow's built-in web fonts — real project fonts, so picking one applies natively
// (an arbitrary web-safe name Webflow doesn't stock would be dropped on the native write).
const WEB_FONTS = [
  'Arial',
  'Georgia',
  'Impact',
  'Palatino Linotype',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'system-ui',
];

// Webflow's Google fonts.
const GOOGLE_FONTS = [
  'Bitter',
  'Changa One',
  'Droid Sans',
  'Droid Serif',
  'Exo',
  'Great Vibes',
  'Inconsolata',
  'Lato',
  'Merriweather',
  'Montserrat',
  'Open Sans',
  'Oswald',
  'PT Sans',
  'PT Serif',
  'Ubuntu',
  'Varela',
  'Varela Round',
  'Vollkorn',
];

// The primary family of a font-family value (first list entry, unquoted, lowered) —
// used to match a CSS value like `"General Sans", sans-serif` back to a menu option.
function primaryFamily(value: string): string {
  const first = value.split(',')[0] ?? value;
  return first
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
}
// Quote a family name that needs it (spaces / non-identifier chars) when writing.
function quoteFamily(name: string): string {
  return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(name) ? name : `"${name}"`;
}

function FontFamilyField(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read('font-family'));
  const fonts = useProjectFonts();
  const [forceCustom, setForceCustom] = useState(false);
  const { options, byPrimary } = fontOptions(fonts);
  const current = display.present ? display.value : '';
  const matched = current ? byPrimary.get(primaryFamily(current)) : undefined;
  const customMode = forceCustom || (display.present && !matched);

  const pick = (value: string) => {
    if (value === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    if (!value) {
      clearProp('font-family');
      return;
    }
    setProp('font-family', quoteFamily(value), false);
  };
  const clear = () => {
    setForceCustom(false);
    clearProp('font-family');
  };

  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Font"
        prop="font-family"
        display={display}
        contributors={read('font-family')?.contributors ?? []}
        busy={busy}
        onClear={clear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <Select
        value={customMode ? CUSTOM : (matched ?? '')}
        options={options}
        onChange={pick}
        onPreview={(value) => {
          const previewed = value ?? undefined;
          const font = previewed && previewed !== CUSTOM ? quoteFamily(previewed) : undefined;
          liveSetProp('font-family', font, false);
        }}
        ariaLabel="Font family"
        disabled={busy}
        searchable
        searchPlaceholder="Search fonts…"
        customInput={
          customMode ? (
            <LiveInput
              // Start empty when switching to Custom from a NAMED font (so typing doesn't
              // append onto e.g. "Montserrat" → "Montserratunset"); keep the current value
              // when it's already a custom one being edited.
              value={forceCustom && matched ? '' : display.present ? joinImportant(display) : ''}
              busy={busy}
              placeholder="font-family"
              ariaLabel="Font family"
              className="u-select-custom-input"
              prop="font-family"
              autoFocus={forceCustom}
              onCommit={(value, important) => setProp('font-family', value, important)}
              onLiveCommit={(value, important) => liveSetProp('font-family', value, important)}
              onClear={clear}
            />
          ) : undefined
        }
      />
    </div>
  );
}

// The project's discovered font families (variables + fonts used on any style),
// empty until they have loaded.
function useProjectFonts(): string[] {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void getProjectFontFamilies().then((list) => {
      if (live) {
        setFonts(list);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}

// The dropdown's options, grouped under headings, and every named font by its
// primary family. The project's fonts minus the ones already listed under
// Google/Web are what's left: the project's own custom fonts.
function fontOptions(fonts: string[]) {
  const builtInLower = new Set([...GOOGLE_FONTS, ...WEB_FONTS].map((font) => font.toLowerCase()));
  const customFonts = fonts.filter((font) => !builtInLower.has(font.toLowerCase()));
  const named = [...customFonts, ...GOOGLE_FONTS, ...WEB_FONTS];
  const byPrimary = new Map(named.map((font) => [primaryFamily(font), font]));
  const options: SelectOption<string>[] = [{ value: '', label: 'Default' }];
  const group = (heading: string, list: string[]) => {
    if (!list.length) {
      return;
    }
    options.push({ value: `__head_${heading}`, label: heading, heading: true });
    for (const font of list) {
      options.push({ value: font, label: font, indent: true });
    }
  };
  group('Custom fonts', customFonts);
  group('Google fonts', GOOGLE_FONTS);
  group('Web fonts', WEB_FONTS);
  options.push({ value: CUSTOM, label: 'Custom…' });
  return { options, byPrimary };
}

// ─────────────────────────── Font weight ───────────────────────────

const WEIGHTS: ReadonlyArray<[string, string]> = [
  ['100', '100 - Thin'],
  ['200', '200 - Extra Light'],
  ['300', '300 - Light'],
  ['400', '400 - Normal'],
  ['500', '500 - Medium'],
  ['600', '600 - Semi Bold'],
  ['700', '700 - Bold'],
  ['800', '800 - Extra Bold'],
  ['900', '900 - Black'],
];
const WEIGHT_VALUES = new Set(WEIGHTS.map(([weight]) => weight));
const WEIGHT_OPTIONS: SelectOption<string>[] = [
  { value: '', label: 'Default' },
  ...WEIGHTS.map(([value, label]) => ({ value, label })),
  { value: CUSTOM, label: 'Custom…' },
];
// Map the CSS keywords onto the numeric scale so they select the right option.
function normalizeWeight(value: string): string {
  const text = value.trim().toLowerCase();
  if (text === 'normal') {
    return '400';
  }
  if (text === 'bold') {
    return '700';
  }
  return text;
}

function WeightField(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read('font-weight'));
  const [forceCustom, setForceCustom] = useState(false);
  const normalized = display.present ? normalizeWeight(display.value) : '';
  const matched = WEIGHT_VALUES.has(normalized) ? normalized : undefined;
  const customMode = forceCustom || (display.present && !matched);

  const pick = (value: string) => {
    if (value === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    if (!value) {
      clearProp('font-weight');
      return;
    }
    setProp('font-weight', value, false);
  };

  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Weight"
        prop="font-weight"
        display={display}
        contributors={read('font-weight')?.contributors ?? []}
        busy={busy}
        onClear={() => {
          setForceCustom(false);
          clearProp('font-weight');
        }}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <Select
        value={customMode ? CUSTOM : (matched ?? '')}
        options={WEIGHT_OPTIONS}
        onChange={pick}
        onPreview={(value) =>
          liveSetProp('font-weight', value === CUSTOM ? undefined : (value ?? undefined), false)
        }
        ariaLabel="Font weight"
        disabled={busy}
        customInput={
          customMode ? (
            <LiveInput
              value={display.present ? joinImportant(display) : ''}
              busy={busy}
              placeholder="font-weight"
              ariaLabel="Font weight"
              className="u-select-custom-input"
              prop="font-weight"
              autoFocus={forceCustom}
              onCommit={(value, important) => setProp('font-weight', value, important)}
              onLiveCommit={(value, important) => liveSetProp('font-weight', value, important)}
              onClear={() => {
                setForceCustom(false);
                clearProp('font-weight');
              }}
            />
          ) : undefined
        }
      />
    </div>
  );
}

// ─────────────────────────── Segmented bar (align / decor) ───────────────────────────

export type Seg = { value: string; icon: ReactNode; label: string };

// A segmented icon bar + a dropdown arrow whose menu offers Custom; a free value
// (anything outside the segments) shows an editable field. Mirrors the Size
// section's overflow bar, reusing the Display control's segmented-bar CSS.
export function SegBar(props: SegBarProps) {
  const { segs, current, ariaLabel, busy, onCommit, moreSegment, moreValue = 'unset' } = props;
  const supported = new Set(segs.map((segment) => segment.value));
  // `forceCustom` keeps the input open even when the seeded value happens to match a
  // segment (e.g. Order seeds `1`, which is also the "Last" preset) — the user
  // explicitly asked for a custom value, so don't collapse back to that segment.
  const [forceCustom, setForceCustom] = useState(false);
  // The just-seeded custom value. `current` derives from the committed style, which
  // lags a beat behind the write (and won't sync into the focused input), so the seed
  // drives the field until the user edits it or picks a segment.
  const [seed, setSeed] = useState<string | undefined>(undefined);
  const customMode = forceCustom || !supported.has(current);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useSegMenuDismiss({ open, rootRef, setOpen });
  const dropUp = useSegMenuClamp({ open, customMode, rootRef, menuRef });
  const { inputRef, requestFocus } = useSegCustomFocus({ customMode, busy });

  // Always commit — `current` may be a CSS default (unset) or an inherited value
  // from another selector, so clicking the shown segment must still apply it to the
  // picked selector (turning it blue), not be treated as a no-op.
  const pick = (next: string) => {
    setForceCustom(false);
    setSeed(undefined);
    setOpen(false);
    onCommit(next, false);
  };
  const enterCustom = (value: string) => {
    setOpen(false);
    requestFocus();
    setForceCustom(true);
    setSeed(value);
    onCommit(value, false);
  };

  return (
    <div
      ref={rootRef}
      className={`embed-editor_display ${customMode ? 'is-custom' : ''}`}
      role="group"
      aria-label={ariaLabel}
    >
      <SegmentPill />
      {customMode ? (
        <SegBarCustomInput
          bar={props}
          seed={seed}
          inputRef={inputRef}
          onSeedDone={() => setSeed(undefined)}
          onBackToBar={() => setForceCustom(false)}
        />
      ) : (
        <SegBarSegments
          segs={segs}
          current={current}
          ariaLabel={ariaLabel}
          busy={busy}
          onPick={pick}
          onMore={moreSegment ? () => enterCustom(moreValue) : undefined}
        />
      )}
      <SegBarMenu
        open={open}
        dropUp={dropUp}
        menuRef={menuRef}
        ariaLabel={ariaLabel}
        busy={busy}
        customMode={customMode}
        segs={segs}
        current={current}
        onToggle={() => setOpen((value) => !value)}
        onPick={pick}
        onEnterCustom={() => enterCustom(moreValue)}
      />
    </div>
  );
}

type SegBarProps = {
  segs: readonly Seg[];
  /** The resolved value, already defaulted to a concrete segment when unset. */
  current: string;
  ariaLabel: string;
  /** The CSS property being edited — filters the custom-value variable picker. */
  prop: string;
  busy: boolean;
  onCommit: (value: string, important: boolean) => void;
  onLiveCommit: (value: string, important: boolean) => void;
  onClear: () => void;
  /** Append a full-size "…" segment that switches straight to a custom value
      (in addition to the dropdown arrow). */
  moreSegment?: boolean;
  /** Value seeded into the custom input when switching to custom — via the "…"
      segment or the dropdown's "Custom" item. Lets a control preset a sensible
      starting value (e.g. `2` for Order); defaults to `unset` (e.g. Align). */
  moreValue?: string;
};

// The free-value field of a bar in custom mode. Typing a value that matches a
// segment collapses back to the bar; clearing/emptying the field does too. Either
// way the seed override is done.
function SegBarCustomInput({
  bar,
  seed,
  inputRef,
  onSeedDone,
  onBackToBar,
}: {
  bar: SegBarProps;
  seed: string | undefined;
  inputRef: React.RefObject<HTMLInputElement>;
  onSeedDone: () => void;
  onBackToBar: () => void;
}) {
  const supported = new Set(bar.segs.map((segment) => segment.value));
  return (
    <LiveInput
      value={seed ?? bar.current}
      busy={bar.busy}
      placeholder="custom value"
      ariaLabel={bar.ariaLabel}
      className="embed-editor_value-input embed-editor_display-input"
      prop={bar.prop}
      inputRef={inputRef}
      onCommit={(value, important) => {
        onSeedDone();
        if (supported.has(value.trim().toLowerCase())) {
          onBackToBar();
        }
        bar.onCommit(value, important);
      }}
      onLiveCommit={bar.onLiveCommit}
      onClear={() => {
        onBackToBar();
        onSeedDone();
        bar.onClear();
      }}
    />
  );
}

// The bar's segments, and the trailing "…" segment when the bar has one.
function SegBarSegments({
  segs,
  current,
  ariaLabel,
  busy,
  onPick,
  onMore,
}: {
  segs: readonly Seg[];
  current: string;
  ariaLabel: string;
  busy: boolean;
  onPick: (value: string) => void;
  onMore: (() => void) | undefined;
}) {
  return (
    <>
      {segs.map((seg) => (
        <button
          key={seg.value}
          type="button"
          role="radio"
          aria-checked={current === seg.value}
          className={`embed-editor_display-seg ${current === seg.value ? 'is-selected' : ''}`}
          disabled={busy}
          aria-label={seg.label}
          title={seg.label}
          onClick={() => onPick(seg.value)}
        >
          {seg.icon}
        </button>
      ))}
      {onMore ? (
        <button
          type="button"
          className="embed-editor_display-seg"
          disabled={busy}
          aria-label={`Custom ${ariaLabel}`}
          title={`Custom ${ariaLabel}`}
          onClick={onMore}
        >
          <MoreIcon />
        </button>
      ) : undefined}
    </>
  );
}

// The dropdown arrow and its menu: "Custom" from the bar, or the segments to
// switch back to from a custom value.
function SegBarMenu({
  open,
  dropUp,
  menuRef,
  ariaLabel,
  busy,
  customMode,
  segs,
  current,
  onToggle,
  onPick,
  onEnterCustom,
}: {
  open: boolean;
  dropUp: boolean;
  menuRef: React.RefObject<HTMLDivElement>;
  ariaLabel: string;
  busy: boolean;
  customMode: boolean;
  segs: readonly Seg[];
  current: string;
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
        aria-label={`More ${ariaLabel} options`}
        disabled={busy}
        onClick={onToggle}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={`embed-editor_display-menu ${dropUp ? 'is-up' : ''}`}
          role="menu"
        >
          {customMode ? (
            segs.map((seg) => (
              <MenuItem
                key={seg.value}
                label={seg.label}
                selected={current === seg.value}
                onClick={() => onPick(seg.value)}
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
function useSegMenuDismiss({
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

// Keep the (right-anchored) dropdown inside the panel: shift it right when its left
// edge would run off (a narrow column), and flip it above when it would overflow the
// bottom (this is the bottom row). Mirrors FieldLabel's menu clamp. Returns whether
// the menu drops up.
function useSegMenuClamp({
  open,
  customMode,
  rootRef,
  menuRef,
}: {
  open: boolean;
  customMode: boolean;
  rootRef: React.RefObject<HTMLDivElement>;
  menuRef: React.RefObject<HTMLDivElement>;
}): boolean {
  const [dropUp, setDropUp] = useState(false);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const root = rootRef.current;
    if (!open || !menu || !root) {
      return;
    }
    const margin = 8;
    const bounds = panelBounds(root);
    const rootRect = root.getBoundingClientRect();
    const naturalLeft = rootRect.right - menu.offsetWidth;
    const naturalRight = rootRect.right;
    const shift =
      naturalLeft < bounds.left + margin
        ? bounds.left + margin - naturalLeft
        : naturalRight > bounds.right - margin
          ? bounds.right - margin - naturalRight
          : 0;
    menu.style.transform = shift ? `translateX(${shift}px)` : '';
    const overflowsBelow = rootRect.bottom + menu.offsetHeight + margin > bounds.bottom;
    setDropUp(overflowsBelow && rootRect.top - bounds.top > bounds.bottom - rootRect.bottom);
  }, [open, customMode, rootRef, menuRef]);
  return dropUp;
}

// Focus the custom field after switching to Custom, once its seeded write
// settles: the request is remembered until the field exists and is enabled.
function useSegCustomFocus({ customMode, busy }: { customMode: boolean; busy: boolean }) {
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

const ALIGN_SEGS: readonly Seg[] = [
  { value: 'left', icon: <AlignLeftIcon />, label: 'Left' },
  { value: 'center', icon: <AlignCenterIcon />, label: 'Center' },
  { value: 'right', icon: <AlignRightIcon />, label: 'Right' },
  { value: 'justify', icon: <AlignJustifyIcon />, label: 'Justify' },
];

function AlignRow({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Props) {
  const display = displayOf(read('text-align'));
  // Nothing set here → what the page computes for this element (text-align inherits,
  // so that's usually a parent's), falling back to `left` (start, LTR).
  const current = useHighlight(
    display.present ? display.value.trim().toLowerCase() : '',
    'text-align',
    ALIGN_SEGS.map((segment) => segment.value),
    'left',
  );
  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Align"
        prop="text-align"
        display={display}
        contributors={read('text-align')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('text-align')}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegBar
        segs={ALIGN_SEGS}
        current={current}
        ariaLabel="Text align"
        prop="text-align"
        busy={busy}
        onCommit={(value, important) => setProp('text-align', value, important)}
        onLiveCommit={(value, important) => liveSetProp('text-align', value, important)}
        onClear={() => clearProp('text-align')}
      />
    </div>
  );
}

const DECOR_SEGS: readonly Seg[] = [
  { value: 'none', icon: <DecorNoneIcon />, label: 'None' },
  { value: 'line-through', icon: <DecorStrikeIcon />, label: 'Strikethrough' },
  { value: 'underline', icon: <DecorUnderlineIcon />, label: 'Underline' },
  { value: 'overline', icon: <DecorOverlineIcon />, label: 'Overline' },
];
const DECOR_KEYWORDS = ['underline', 'overline', 'line-through', 'none'];

function DecorRow(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  // Webflow's native Style model stores the `text-decoration` SHORTHAND — writing the
  // `text-decoration-line` longhand is silently dropped by the Style API — so edits /
  // clear target the shorthand. Display reads the shorthand, falling back to the
  // longhand an embed might use.
  const display = displayOf(read('text-decoration'));
  const raw = display.present ? display.value : displayOf(read('text-decoration-line')).value;
  const parts = parseDecoration(raw);
  // The bar reflects only the line facet — a single keyword, or None (X). Combos and
  // the divider style/color live in the "…" popover, so picking a segment recomposes
  // the shorthand while preserving any style/color already set.
  const current = parts.lines.length
    ? (LINE_ORDER.find((line) => parts.lines.includes(line)) ?? 'none')
    : 'none';
  const writeLine = (
    { value, important }: { value: string; important: boolean },
    mode: 'live' | 'commit',
  ) => {
    const put = mode === 'live' ? liveSetProp : setProp;
    const low = value.trim().toLowerCase();
    if (DECOR_KEYWORDS.includes(low)) {
      put(
        'text-decoration',
        composeDecoration({ ...parts, lines: low === 'none' ? [] : [low] }),
        important,
      );
    } else {
      // A custom value typed in the bar.
      put('text-decoration', value, important);
    }
  };
  const anySet = DECOR_PROPS.some((prop) => read(prop)?.source === 'selected');
  return (
    <div className="embed-editor_size-row embed-editor_more-row">
      <PropLabel
        label="Decor"
        prop="text-decoration"
        display={display}
        contributors={read('text-decoration')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(['text-decoration', 'text-decoration-line'])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <div className="embed-editor_more-control">
        <SegBar
          segs={DECOR_SEGS}
          current={current}
          ariaLabel="Text decoration"
          prop="text-decoration"
          busy={busy}
          onCommit={(value, important) => writeLine({ value, important }, 'commit')}
          onLiveCommit={(value, important) => writeLine({ value, important }, 'live')}
          onClear={() => clearProp(['text-decoration', 'text-decoration-line'])}
        />
        <MorePopover title="Decoration & underline" active={anySet} busy={busy}>
          <DecorationPopover {...props} />
        </MorePopover>
      </div>
    </div>
  );
}

// ─────────────── Stacked segmented cells (italicize / capitalize / direction) ───────────────

const ITALIC_SEGS: readonly Seg[] = [
  { value: 'normal', icon: <FontStyleRegularIcon />, label: 'Regular' },
  { value: 'italic', icon: <FontStyleItalicIcon />, label: 'Italic' },
];
const TRANSFORM_SEGS: readonly Seg[] = [
  { value: 'none', icon: <DecorNoneIcon />, label: 'None' },
  { value: 'uppercase', icon: <TransformCapsIcon />, label: 'ALL CAPS' },
  { value: 'capitalize', icon: <TransformCapitalizeIcon />, label: 'Capitalize Every Word' },
  { value: 'lowercase', icon: <TransformLowercaseIcon />, label: 'lowercase' },
];
const DIRECTION_SEGS: readonly Seg[] = [
  { value: 'ltr', icon: <DirectionLTRIcon />, label: 'Left to right' },
  { value: 'rtl', icon: <DirectionRTLIcon />, label: 'Right to left' },
];

// A segmented icon bar stacked over its clickable label, for the three-up bottom
// row (mirrors StackedField). `fallback` is the CSS default shown active when unset.
function SegCell({
  prop,
  label,
  ariaLabel,
  segs,
  fallback,
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
  ariaLabel: string;
  segs: readonly Seg[];
  fallback: string;
} & Props) {
  const display = displayOf(read(prop));
  const current = useHighlight(
    display.present ? display.value.trim().toLowerCase() : '',
    prop,
    segs.map((segment) => segment.value),
    fallback,
  );
  return (
    <div className="embed-editor_type-cell">
      <SegBar
        segs={segs}
        current={current}
        ariaLabel={ariaLabel}
        prop={prop}
        busy={busy}
        onCommit={(value, important) => setProp(prop, value, important)}
        onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
        onClear={() => clearProp(prop)}
      />
      <PropLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

// ─────────────────────────── Color ───────────────────────────

function ColorField(props: Props) {
  return (
    <div className="embed-editor_size-row">
      <TextField
        prop="color"
        label="Color"
        placeholder="currentColor"
        swatchLabel="Text color"
        {...props}
      />
    </div>
  );
}

// ─────────────────────────── Columns advanced options ───────────────────────────

// The multi-column properties owned by the "…" popover — used to light the trigger
// when any is set on the picked selector (they're also excluded from the generic
// row list in EmbedEditor's TYPOGRAPHY_CONTROL_PROPS).
const COLUMN_MORE_PROPS = [
  'column-gap',
  'column-rule-style',
  'column-rule-width',
  'column-rule-color',
  'column-span',
] as const;

function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="13" cy="8" r="1.35" fill="currentColor" />
    </svg>
  );
}
// column-rule-style glyphs — a vertical divider drawn solid / dashed / dotted.
function RuleSolidIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="7.25" y="2" width="1.5" height="12" fill="currentColor" />
    </svg>
  );
}
function RuleDashedIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="7.25" y="2.5" width="1.5" height="4" fill="currentColor" />
      <rect x="7.25" y="9.5" width="1.5" height="4" fill="currentColor" />
    </svg>
  );
}
function RuleDottedIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1" fill="currentColor" />
    </svg>
  );
}

const RULE_STYLE_SEGS: readonly Seg[] = [
  { value: 'none', icon: <DecorNoneIcon />, label: 'None' },
  { value: 'solid', icon: <RuleSolidIcon />, label: 'Solid' },
  { value: 'dashed', icon: <RuleDashedIcon />, label: 'Dashed' },
  { value: 'dotted', icon: <RuleDottedIcon />, label: 'Dotted' },
];

// The clearable label for popover rows — same provenance behavior as the panel's
// PropLabel: orange (set via another selector) opens the provenance popover; blue
// (set on the picked selector) opens a reset menu that also lists every contributing
// selector + whether it's a Webflow style or an embed; unset is a dim caption.
// `active` / `onClear` can be overridden for a control that edits one facet of a
// shorthand (e.g. the divider Style within `text-decoration`).
function PopLabel({
  label,
  prop,
  read,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
  active,
  onClear,
}: {
  label: string;
  prop: string;
  active?: boolean;
  onClear?: () => void;
} & Pick<Props, 'read' | 'busy' | 'clearProp' | 'onProvenance' | 'onSelectSelector'>) {
  const resolved = read(prop);
  const display = displayOf(resolved);
  if (display.present && !display.isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={active ?? display.isSelected}
      disabled={busy}
      onReset={onClear ?? (() => clearProp(prop))}
      resetLabel="Clear"
      tooltip={<PropTip props={[prop]} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={resolved?.contributors ?? []}
          prop={prop}
          onSelect={(selector, selectorProp) => {
            onSelectSelector(selector, selectorProp);
            close();
          }}
        />
      )}
    >
      {label}
    </FieldLabel>
  );
}

// A length-field row inside the popover (Gap / divider Width).
function LengthRow({
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
} & Pick<
  Props,
  'read' | 'busy' | 'setProp' | 'clearProp' | 'liveSetProp' | 'onProvenance' | 'onSelectSelector'
>) {
  const display = displayOf(read(prop));
  const external = display.present ? joinImportant(display) : '';
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label={label}
        prop={prop}
        read={read}
        busy={busy}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <LiveInput
        value={external}
        busy={busy}
        placeholder={placeholder}
        ariaLabel={label}
        className="u-input embed-editor_size-input"
        dataProp={prop}
        prop={prop}
        onCommit={(value, important) => setProp(prop, value, important)}
        onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
        onClear={() => clearProp(prop)}
      />
    </div>
  );
}

function RuleStyleRow({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Pick<
  Props,
  'read' | 'busy' | 'setProp' | 'clearProp' | 'liveSetProp' | 'onProvenance' | 'onSelectSelector'
>) {
  const display = displayOf(read('column-rule-style'));
  const current = useHighlight(
    display.present ? display.value.trim().toLowerCase() : '',
    'column-rule-style',
    RULE_STYLE_SEGS.map((segment) => segment.value),
    'none',
  );
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label="Style"
        prop="column-rule-style"
        read={read}
        busy={busy}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegBar
        segs={RULE_STYLE_SEGS}
        current={current}
        ariaLabel="Divider style"
        prop="column-rule-style"
        busy={busy}
        onCommit={(value, important) => setProp('column-rule-style', value, important)}
        onLiveCommit={(value, important) => liveSetProp('column-rule-style', value, important)}
        onClear={() => clearProp('column-rule-style')}
      />
    </div>
  );
}

function RuleColorRow({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Pick<
  Props,
  'read' | 'busy' | 'setProp' | 'clearProp' | 'liveSetProp' | 'onProvenance' | 'onSelectSelector'
>) {
  const display = displayOf(read('column-rule-color'));
  const external = display.present ? joinImportant(display) : '';
  // A live drag writes to the canvas, not to the model this row reads — so the
  // colour it emitted is what the swatch and the field show until the model
  // catches up. Without this the page moved under the pointer while the number
  // beside it sat still (see liveColor.ts).
  const [shown, noteLive] = useLiveColor(external);
  const swatch = (
    <ColorSwatch
      value={shown.replace(/\s*!important\s*$/i, '').trim()}
      busy={busy}
      ariaLabel="Divider color"
      onChange={(color, live) => {
        noteLive(live ? color : undefined);
        if (live) {
          liveSetProp('column-rule-color', color, false);
        } else {
          setProp('column-rule-color', color, false);
        }
      }}
    />
  );
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label="Color"
        prop="column-rule-color"
        read={read}
        busy={busy}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <div className="embed-editor_type-field">
        {swatch}
        <LiveInput
          value={shown}
          busy={busy}
          placeholder="Set a color"
          ariaLabel="Divider color"
          className="u-input embed-editor_size-input"
          dataProp="column-rule-color"
          prop="column-rule-color"
          onCommit={(value, important) => setProp('column-rule-color', value, important)}
          onLiveCommit={(value, important) => liveSetProp('column-rule-color', value, important)}
          onClear={() => clearProp('column-rule-color')}
        />
      </div>
    </div>
  );
}

function SpanRow({
  read,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
}: Pick<Props, 'read' | 'busy' | 'setProp' | 'clearProp' | 'onProvenance' | 'onSelectSelector'>) {
  const display = displayOf(read('column-span'));
  const value =
    useHighlight(
      display.present ? display.value.trim().toLowerCase() : '',
      'column-span',
      ['none', 'all'],
      'none',
    ) === 'all'
      ? 'all'
      : 'none';
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label="Span"
        prop="column-span"
        read={read}
        busy={busy}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegmentedControl
        options={[
          { value: 'none', label: "Don't" },
          { value: 'all', label: 'Do' },
        ]}
        value={value}
        onChange={(next) => setProp('column-span', next, false)}
        ariaLabel="Column span"
        disabled={busy}
      />
    </div>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// A "…" trigger button that toggles an anchored options popover. The popover is
// absolutely positioned (left/right:0) against the nearest positioned ancestor —
// the caller's row wrapper — so it spans the full row and never overflows the
// panel. Reused by the Columns and Decoration advanced controls.
function MorePopover({
  title,
  active,
  busy,
  children,
}: {
  title: string;
  active: boolean;
  busy: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useMorePopoverDismiss({ open, rootRef, setOpen });
  return (
    <div ref={rootRef} className="embed-editor_more">
      <button
        type="button"
        className={`embed-editor_more-btn ${open ? 'is-open' : ''} ${active ? 'is-set' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className="embed-editor_more-popover" role="dialog" aria-label={title}>
          <div className="embed-editor_more-head">
            <span className="embed-editor_more-title">{title}</span>
            <button
              type="button"
              className="embed-editor_more-close"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
          {children}
        </div>
      ) : undefined}
    </div>
  );
}

// While the popover is open, a press outside it (other than in the provenance
// popover one of its labels opened) or Escape closes it.
function useMorePopoverDismiss({
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
      const target = event.target;
      if (!(target instanceof Element)) {
        setOpen(false);
        return;
      }
      if (rootRef.current?.contains(target)) {
        return;
      }
      // A label inside the popover can open the provenance popover, which is portaled
      // to <body> (outside this wrapper) — clicks there must not close the popover.
      if (target.closest('.embed-editor_provenance')) {
        return;
      }
      setOpen(false);
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

// The advanced-columns popover body: multi-column Gap, the column-rule divider
// (style / width / color), and the child column-span. Every field reads/writes
// through the same resolved model as the rest of the panel; unset props read empty.
function ColumnsPopover(props: Props) {
  return (
    <>
      <div className="embed-editor_more-group">
        <LengthRow prop="column-gap" label="Gap" placeholder="0px" {...props} />
      </div>
      <div className="embed-editor_more-group">
        <p className="embed-editor_more-heading">Divider settings</p>
        <RuleStyleRow {...props} />
        <LengthRow prop="column-rule-width" label="Width" placeholder="0px" {...props} />
        <RuleColorRow {...props} />
      </div>
      <div className="embed-editor_more-group">
        <p className="embed-editor_more-heading">Column child</p>
        <SpanRow {...props} />
      </div>
    </>
  );
}

// The Letter spacing / Text indent / Columns three-up row, with a trailing "…"
// button opening the advanced-columns popover (mirrors Webflow's Columns UI).
function ColumnsRow(props: Props) {
  const anySet = COLUMN_MORE_PROPS.some((prop) => props.read(prop)?.source === 'selected');
  return (
    <div className="embed-editor_columns">
      <div className="embed-editor_type-triple">
        <StackedField prop="letter-spacing" label="Letter spacing" placeholder="0em" {...props} />
        <StackedField prop="text-indent" label="Text indent" placeholder="0px" {...props} />
        <StackedField prop="column-count" label="Columns" placeholder="Auto" {...props} />
      </div>
      <MorePopover title="Columns" active={anySet} busy={props.busy}>
        <ColumnsPopover {...props} />
      </MorePopover>
    </div>
  );
}

// ─────────────────────────── Text-decoration advanced options ───────────────────────────

// Webflow (and this control) stores line + style + color in the `text-decoration`
// shorthand; thickness + skip-ink are separate longhands. Splitting the shorthand
// lets the popover's Line / Style / Color each edit one facet without touching the
// others — and it stays in sync with the Decor segmented bar (same property).
const DECOR_LINE_KW = ['underline', 'overline', 'line-through', 'blink'];
const DECOR_STYLE_KW = ['solid', 'double', 'dotted', 'dashed', 'wavy'];
const LINE_ORDER = ['underline', 'overline', 'line-through'];
const DECOR_PROPS = [
  'text-decoration',
  'text-decoration-thickness',
  'text-decoration-skip-ink',
] as const;

type DecorParts = { lines: string[]; style: string; color: string };

function parseDecoration(value: string): DecorParts {
  const lines: string[] = [];
  let style = '';
  const color: string[] = [];
  for (const tok of splitTopLevelSpaces(value).filter(Boolean)) {
    const low = tok.toLowerCase();
    if (low === 'none') {
      continue;
    }
    if (DECOR_LINE_KW.includes(low)) {
      if (!lines.includes(low)) {
        lines.push(low);
      }
    } else if (DECOR_STYLE_KW.includes(low)) {
      style = low;
    } else {
      color.push(tok);
    }
  }
  return { lines, style, color: color.join(' ') };
}
function composeDecoration({ lines, style, color }: DecorParts): string {
  const ordered = LINE_ORDER.filter((line) => lines.includes(line));
  return [...ordered, style, color].filter(Boolean).join(' ').trim() || 'none';
}
// The canonical Line-select key for a parsed value (ordered keywords, or 'none').
function lineKey(lines: string[]): string {
  const ordered = LINE_ORDER.filter((line) => lines.includes(line));
  return ordered.length ? ordered.join(' ') : 'none';
}

// Small horizontal glyphs for the Style select (a decoration line drawn each way).
function StyleGlyph({ variant }: { variant: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy' }) {
  if (variant === 'double') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 6h12M2 10h12" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  if (variant === 'wavy') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 8q1.5-2 3 0t3 0 3 0 3 0" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  const dash = variant === 'dotted' ? '1 2' : variant === 'dashed' ? '3 2' : undefined;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 8h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeDasharray={dash}
      />
    </svg>
  );
}

const DECOR_LINE_OPTIONS: SelectOption<string>[] = [
  { value: 'none', label: 'None', icon: <DecorNoneIcon /> },
  { value: 'line-through', label: 'Strikethrough', icon: <DecorStrikeIcon /> },
  { value: 'underline', label: 'Underline', icon: <DecorUnderlineIcon /> },
  { value: 'overline', label: 'Overline', icon: <DecorOverlineIcon /> },
  { value: 'underline overline', label: 'Underline + Overline' },
  { value: 'underline line-through', label: 'Underline + Strikethrough' },
  { value: 'overline line-through', label: 'Overline + Strikethrough' },
  { value: 'underline overline line-through', label: 'All' },
];
const DECOR_STYLE_OPTIONS: SelectOption<string>[] = [
  { value: 'solid', label: 'Solid', icon: <StyleGlyph variant="solid" /> },
  { value: 'double', label: 'Double', icon: <StyleGlyph variant="double" /> },
  { value: 'dotted', label: 'Dotted', icon: <StyleGlyph variant="dotted" /> },
  { value: 'dashed', label: 'Dashed', icon: <StyleGlyph variant="dashed" /> },
  { value: 'wavy', label: 'Wavy', icon: <StyleGlyph variant="wavy" /> },
];
const SKIP_INK_OPTIONS: SelectOption<string>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None' },
];

// The Decoration & underline popover body: Line / Style / Color compose the
// `text-decoration` shorthand; Thick and Skip ink are their own longhands.
function DecorationPopover(props: Props) {
  const { read, busy, setProp, liveSetProp } = props;
  const display = displayOf(read('text-decoration'));
  const raw = display.present ? display.value : displayOf(read('text-decoration-line')).value;
  const parts = parseDecoration(raw);
  const write: DecorationWrite = (next, mode = 'commit') =>
    (mode === 'live' ? liveSetProp : setProp)(
      'text-decoration',
      composeDecoration(next),
      display.important,
    );
  // A preview that ends (the menu closed without a pick) puts the live write back.
  const preview = (value: string | undefined, next: (value: string) => DecorParts) => {
    if (value === undefined) {
      liveSetProp('text-decoration', undefined, display.important);
    } else {
      write(next(value), 'live');
    }
  };
  const rowProps = { props, parts, shorthandSet: display.isSelected, write };
  const skip = displayOf(read('text-decoration-skip-ink'));

  return (
    <div className="embed-editor_more-group">
      <DecorationSelectRow
        {...rowProps}
        label="Line"
        facet="lines"
        value={lineKey(parts.lines)}
        options={DECOR_LINE_OPTIONS}
        toParts={(value) => ({ ...parts, lines: value === 'none' ? [] : value.split(' ') })}
        preview={preview}
      />
      <DecorationSelectRow
        {...rowProps}
        label="Style"
        facet="style"
        value={parts.style || 'solid'}
        options={DECOR_STYLE_OPTIONS}
        toParts={(value) => ({ ...parts, style: value === 'solid' ? '' : value })}
        preview={preview}
      />
      <LengthRow prop="text-decoration-thickness" label="Thick" placeholder="Auto" {...props} />
      <DecorationColorRow {...rowProps} />
      <div className="embed-editor_size-row">
        <PopLabel label="Skip ink" prop="text-decoration-skip-ink" {...props} />
        <Select
          value={skip.present ? skip.value.trim().toLowerCase() : 'auto'}
          options={SKIP_INK_OPTIONS}
          onChange={(value) => setProp('text-decoration-skip-ink', value, false)}
          onPreview={(value) => liveSetProp('text-decoration-skip-ink', value ?? undefined, false)}
          ariaLabel="Skip ink"
          disabled={busy}
        />
      </div>
      <p className="embed-editor_more-note">
        The browser will try to interrupt overlines and underlines to prevent drawing over glyphs.
      </p>
    </div>
  );
}

// Writes the `text-decoration` shorthand composed from its facets, committed by
// default or as a live preview.
type DecorationWrite = (next: DecorParts, mode?: 'live' | 'commit') => void;

type DecorationRowProps = {
  props: Props;
  parts: DecorParts;
  /** Whether the picked selector sets the shorthand these rows edit. */
  shorthandSet: boolean;
  write: DecorationWrite;
};

// The Line or Style row: one facet of the shorthand, picked from a dropdown.
function DecorationSelectRow({
  props,
  parts,
  shorthandSet,
  write,
  label,
  facet,
  value,
  options,
  toParts,
  preview,
}: DecorationRowProps & {
  label: string;
  facet: 'lines' | 'style';
  value: string;
  options: SelectOption<string>[];
  toParts: (value: string) => DecorParts;
  preview: (value: string | undefined, next: (value: string) => DecorParts) => void;
}) {
  // The Line label clears the whole shorthand (and the longhand an embed may use);
  // the Style label clears only its own facet.
  const lines = facet === 'lines';
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label={label}
        prop="text-decoration"
        {...props}
        active={lines ? shorthandSet : shorthandSet && parts.style !== ''}
        onClear={() =>
          lines
            ? props.clearProp(['text-decoration', 'text-decoration-line'])
            : write({ ...parts, style: '' })
        }
      />
      <Select
        value={value}
        options={options}
        onChange={(next) => write(toParts(next))}
        onPreview={(next) => preview(next ?? undefined, toParts)}
        ariaLabel={lines ? 'Decoration line' : 'Decoration style'}
        disabled={props.busy}
      />
    </div>
  );
}

// The Color row: a swatch and a field for the shorthand's colour facet.
function DecorationColorRow({ props, parts, shorthandSet, write }: DecorationRowProps) {
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label="Color"
        prop="text-decoration"
        {...props}
        active={shorthandSet && parts.color !== ''}
        onClear={() => write({ ...parts, color: '' })}
      />
      <div className="embed-editor_type-field">
        <ColorSwatch
          value={parts.color}
          busy={props.busy}
          ariaLabel="Decoration color"
          onChange={(color, live) => write({ ...parts, color }, live ? 'live' : 'commit')}
        />
        <LiveInput
          value={parts.color}
          busy={props.busy}
          placeholder="Set a color"
          ariaLabel="Decoration color"
          className="u-input embed-editor_size-input"
          prop="color"
          onCommit={(value) => write({ ...parts, color: value })}
          onLiveCommit={(value) => write({ ...parts, color: value }, 'live')}
          onClear={() => write({ ...parts, color: '' })}
        />
      </div>
    </div>
  );
}

// ─────────────── Breaking (word-break / white-space) ───────────────

// One "Breaking" row holds two dropdowns — Word (word-break) and Line
// (white-space) — each stacked over its own clickable label (mirrors Webflow).
type BreakDefinition = {
  prop: string;
  label: string;
  ariaLabel: string;
  /** CSS default shown selected when unset (the label stays dim until set). */
  fallback: string;
  /** [css value, menu label] pairs, in Webflow's order. */
  options: ReadonlyArray<readonly [string, string]>;
};

const WORD_BREAK: BreakDefinition = {
  prop: 'word-break',
  label: 'Word',
  ariaLabel: 'Word breaking',
  fallback: 'normal',
  options: [
    ['normal', 'Normal'],
    ['break-all', 'Break all'],
    ['keep-all', 'Keep all'],
  ],
};
const WHITE_SPACE: BreakDefinition = {
  prop: 'white-space',
  label: 'Line',
  ariaLabel: 'Line breaking',
  fallback: 'normal',
  options: [
    ['normal', 'Normal'],
    ['nowrap', 'No wrap'],
    ['pre', 'Pre'],
    ['pre-wrap', 'Pre wrap'],
    ['pre-line', 'Pre line'],
    ['break-spaces', 'Break spaces'],
  ],
};

// A single-property value dropdown with the shared blue/orange resolved model: it
// shows the matched option (or the CSS default when unset), and drops into Custom
// mode with a free-text field for an unknown value (mirrors WeightField). Writes
// target the picked selector; the caller owns `forceCustom` so its label's Clear
// can also drop out of custom mode.
type EnumSelectProps = {
  prop: string;
  ariaLabel: string;
  fallback: string;
  options: ReadonlyArray<readonly [string, string]>;
  forceCustom: boolean;
  setForceCustom: (value: boolean) => void;
} & Pick<Props, 'read' | 'busy' | 'setProp' | 'clearProp' | 'liveSetProp'>;

function EnumSelect(props: EnumSelectProps) {
  const { prop, ariaLabel, fallback, options: choices, forceCustom, setForceCustom } = props;
  const { read, busy, setProp, clearProp, liveSetProp } = props;
  const display = displayOf(read(prop));
  const values = new Set(choices.map(([value]) => value));
  const current = display.present ? display.value.trim().toLowerCase() : '';
  const matched = values.has(current) ? current : undefined;
  // Unset → show what the page computes for this element (an inherited value, a rule
  // the panel's matcher can't see), and only then the CSS default.
  const shownComputed = useHighlight(
    '',
    matched ? '' : prop,
    choices.map(([value]) => value),
    fallback,
  );
  const customMode = forceCustom || (display.present && !matched);

  const options: SelectOption<string>[] = [
    ...choices.map(([value, optionLabel]) => ({ value, label: optionLabel })),
    { value: CUSTOM, label: 'Custom…' },
  ];

  // Focus + select the custom field once its `unset` write settles (busy clears), so
  // its draft has synced to `unset` — autoFocus would grab it before the write lands.
  const { inputRef, requestFocus } = useSegCustomFocus({ customMode, busy });

  const pick = (value: string) => {
    if (value === CUSTOM) {
      // Always seed Custom with `unset` — a valid default that applies immediately and
      // that the user can type over (selected on focus), rather than a blank/stale field.
      requestFocus();
      setForceCustom(true);
      setProp(prop, 'unset', false);
      return;
    }
    setForceCustom(false);
    setProp(prop, value, false);
  };

  return (
    <Select
      value={customMode ? CUSTOM : (matched ?? shownComputed)}
      options={options}
      onChange={pick}
      onPreview={(value) =>
        liveSetProp(prop, value === CUSTOM ? undefined : (value ?? undefined), false)
      }
      ariaLabel={ariaLabel}
      disabled={busy}
      customInput={
        customMode ? (
          <LiveInput
            inputRef={inputRef}
            value={display.present ? joinImportant(display) : 'unset'}
            busy={busy}
            placeholder={prop}
            ariaLabel={ariaLabel}
            className="u-select-custom-input"
            prop={prop}
            onCommit={(value, important) => setProp(prop, value, important)}
            onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
            onClear={() => {
              setForceCustom(false);
              clearProp(prop);
            }}
          />
        ) : undefined
      }
    />
  );
}

// A dropdown cell: the value Select stacked over its clickable label.
function BreakSelect({
  definition,
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: { definition: BreakDefinition } & Props) {
  const { prop, label, ariaLabel, fallback, options } = definition;
  const [forceCustom, setForceCustom] = useState(false);
  const display = displayOf(read(prop));
  const onClear = () => {
    setForceCustom(false);
    clearProp(prop);
  };
  return (
    <div className="embed-editor_type-cell">
      <EnumSelect
        prop={prop}
        ariaLabel={ariaLabel}
        fallback={fallback}
        options={options}
        forceCustom={forceCustom}
        setForceCustom={setForceCustom}
        read={read}
        busy={busy}
        setProp={setProp}
        clearProp={clearProp}
        liveSetProp={liveSetProp}
      />
      <PropLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        onClear={onClear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

// The Breaking row: a static "Breaking" label in the shared label column, then the
// Word + Line dropdowns sharing the control area.
function BreakingRow(props: Props) {
  return (
    <div className="embed-editor_break-row">
      <span className="embed-editor_size-label embed-editor_break-title">Breaking</span>
      <div className="embed-editor_break-pair">
        <BreakSelect definition={WORD_BREAK} {...props} />
        <BreakSelect definition={WHITE_SPACE} {...props} />
      </div>
    </div>
  );
}

// ─────────────── Wrap (overflow-wrap) ───────────────

const WRAP_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['normal', 'Normal'],
  ['anywhere', 'Anywhere'],
  ['break-word', 'Break word'],
];

// A single full-width row: the "Wrap" label + the overflow-wrap dropdown.
function WrapRow({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Props) {
  const [forceCustom, setForceCustom] = useState(false);
  const display = displayOf(read('overflow-wrap'));
  const onClear = () => {
    setForceCustom(false);
    clearProp('overflow-wrap');
  };
  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Wrap"
        prop="overflow-wrap"
        display={display}
        contributors={read('overflow-wrap')?.contributors ?? []}
        busy={busy}
        onClear={onClear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <EnumSelect
        prop="overflow-wrap"
        ariaLabel="Text wrap"
        fallback="normal"
        options={WRAP_OPTIONS}
        forceCustom={forceCustom}
        setForceCustom={setForceCustom}
        read={read}
        busy={busy}
        setProp={setProp}
        clearProp={clearProp}
        liveSetProp={liveSetProp}
      />
    </div>
  );
}

// ─────────────────────────── Section ───────────────────────────

// ─────────────── Truncate (text-overflow) ───────────────

function TruncateRow({ read, busy, setProp, clearProp, onProvenance, onSelectSelector }: Props) {
  const display = displayOf(read('text-overflow'));
  const shownOverflow = useHighlight(
    '',
    display.present ? '' : 'text-overflow',
    ['clip', 'ellipsis'],
    'clip',
  );
  const current = display.present
    ? display.value.trim().toLowerCase() === 'ellipsis'
      ? 'ellipsis'
      : 'clip'
    : shownOverflow;
  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Truncate"
        prop="text-overflow"
        display={display}
        contributors={read('text-overflow')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('text-overflow')}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegmentedControl
        options={[
          { value: 'clip', label: 'Clip' },
          { value: 'ellipsis', label: 'Ellipsis' },
        ]}
        value={current}
        onChange={(value) => setProp('text-overflow', value, false)}
        ariaLabel="Truncate"
        disabled={busy}
      />
    </div>
  );
}

// ─────────────── Stroke (-webkit-text-stroke) ───────────────

function StrokeRow(props: Props) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = props;
  const widthDisplay = displayOf(read('-webkit-text-stroke-width'));
  const colorDisplay = displayOf(read('-webkit-text-stroke-color'));
  // The "Stroke" title reflects either longhand being set and clears both; each cell's
  // caption (Width/Color) owns its own provenance/clear.
  const combined = eitherDisplay(widthDisplay, colorDisplay);
  return (
    <div className="embed-editor_break-row">
      <PropLabel
        label="Stroke"
        prop="-webkit-text-stroke-width"
        display={combined}
        contributors={read('-webkit-text-stroke-width')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(['-webkit-text-stroke-width', '-webkit-text-stroke-color'])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <div className="embed-editor_break-pair embed-editor_stroke-pair">
        <div className="embed-editor_type-cell">
          <StrokeInput
            prop="-webkit-text-stroke-width"
            display={widthDisplay}
            placeholder="0px"
            ariaLabel="Stroke width"
            {...props}
          />
          <StrokeCaption
            label="Width"
            prop="-webkit-text-stroke-width"
            display={widthDisplay}
            {...props}
          />
        </div>
        <div className="embed-editor_type-cell">
          <div className="embed-editor_type-field">
            <ColorSwatch
              value={colorDisplay.present ? colorDisplay.value : ''}
              busy={busy}
              ariaLabel="Stroke color"
              onChange={(color, live) => {
                if (live) {
                  props.liveSetProp('-webkit-text-stroke-color', color, false);
                } else {
                  props.setProp('-webkit-text-stroke-color', color, false);
                }
              }}
            />
            <StrokeInput
              prop="-webkit-text-stroke-color"
              display={colorDisplay}
              placeholder="black"
              ariaLabel="Stroke color"
              {...props}
            />
          </div>
          <StrokeCaption
            label="Color"
            prop="-webkit-text-stroke-color"
            display={colorDisplay}
            {...props}
          />
        </div>
      </div>
    </div>
  );
}

// A label state for two longhands at once: set when either is, blue when either
// is set on the picked selector.
function eitherDisplay(first: Display, second: Display): Display {
  return {
    present: first.present || second.present,
    isSelected: first.isSelected || second.isSelected,
    overridden: false,
    winnerSelector: '',
    value: '',
    important: false,
  };
}

// The field for one stroke longhand.
function StrokeInput({
  prop,
  display,
  placeholder,
  ariaLabel,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  prop: string;
  display: Display;
  placeholder: string;
  ariaLabel: string;
} & Props) {
  return (
    <LiveInput
      value={display.present ? joinImportant(display) : ''}
      busy={busy}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      className="u-input embed-editor_size-input"
      dataProp={prop}
      prop={prop}
      onCommit={(value, important) => setProp(prop, value, important)}
      onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
      onClear={() => clearProp(prop)}
    />
  );
}

// The caption under one stroke cell, which owns that longhand's provenance/clear.
function StrokeCaption({
  label,
  prop,
  display,
  read,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
}: { label: string; prop: string; display: Display } & Props) {
  return (
    <PropLabel
      label={label}
      prop={prop}
      display={display}
      contributors={read(prop)?.contributors ?? []}
      busy={busy}
      onClear={() => clearProp(prop)}
      onProvenance={onProvenance}
      onSelectSelector={onSelectSelector}
    />
  );
}

// ─────────────── Text shadows (layered text-shadow) ───────────────

const ShadowPlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

type ShadowPatch = { x?: string; y?: string; blur?: string; color?: string };

function ShadowEditor({
  shadow,
  busy,
  onChange,
}: {
  shadow: Shadow;
  busy: boolean;
  onChange: (patch: ShadowPatch, live: boolean) => void;
}) {
  return (
    <div className="embed-editor_type-shadow-editor">
      <ShadowLength
        label="X"
        value={shadow.x}
        busy={busy}
        onCommit={(value) => onChange({ x: value }, false)}
        onLive={(value) => onChange({ x: value }, true)}
      />
      <ShadowLength
        label="Y"
        value={shadow.y}
        busy={busy}
        onCommit={(value) => onChange({ y: value }, false)}
        onLive={(value) => onChange({ y: value }, true)}
      />
      <ShadowLength
        label="Blur"
        value={shadow.blur}
        busy={busy}
        onCommit={(value) => onChange({ blur: value }, false)}
        onLive={(value) => onChange({ blur: value }, true)}
      />
      <ShadowColorRow
        color={shadow.color}
        busy={busy}
        onChange={(color, live) => onChange({ color: color }, live)}
      />
    </div>
  );
}

// The transparency checkerboard drawn beneath each shadow's colour swatch.
const SHADOW_PREVIEW_CHECKERBOARD =
  'conic-gradient(#8883 25%, transparent 0 50%, #8883 0 75%, transparent 0) 0 0 / 10px 10px';

function TextShadowsRow(props: Props) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read('text-shadow'));
  const rows = parseHideable(display.present ? display.value : '', ',', parseShadows);
  const shadows = rows.map((row) => row.item);
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | undefined>(undefined);
  const edit = shadowRowEdits({ rows, props, setOpenIndex });
  const openShadow = openIndex === undefined ? undefined : shadows[openIndex];

  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <PropLabel
          label="Text shadows"
          prop="text-shadow"
          display={display}
          contributors={read('text-shadow')?.contributors ?? []}
          busy={busy}
          onClear={() => clearProp('text-shadow')}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={edit.add}
          disabled={busy}
          title="Add a shadow"
          aria-label="Add a text shadow"
        >
          <ShadowPlusIcon />
        </button>
      </div>
      <LayerList
        count={shadows.length}
        busy={busy}
        ariaLabel="Text shadows"
        onOpen={(i, element) => {
          setOpenIndex((current) => (current === i ? undefined : i));
          setAnchorElement(element);
        }}
        onReorder={edit.reorder}
        onRemove={edit.remove}
        isHidden={(i) => rows[i]?.hidden ?? false}
        onToggleHidden={edit.toggle}
        renderRow={(i) => shadowLayerRow(shadows[i], i)}
      />
      {openIndex !== undefined && anchorElement && openShadow ? (
        <LayerPopover
          anchorEl={anchorElement}
          ariaLabel="Text shadow"
          onClose={() => setOpenIndex(undefined)}
        >
          <ShadowEditor
            shadow={openShadow}
            busy={busy}
            onChange={(shadowPatch, live) =>
              edit.patch(openIndex, shadowPatch, live ? 'live' : 'commit')
            }
          />
        </LayerPopover>
      ) : undefined}
    </div>
  );
}

// A shadow's row in the layer list: its colour over a checkerboard, and its label.
function shadowLayerRow(shadow: Shadow | undefined, index: number) {
  if (shadow === undefined) {
    throw new Error(`Text shadow ${index} is missing`);
  }
  const colorLayer = `linear-gradient(${shadow.color}, ${shadow.color})`;
  return {
    preview: (
      <span
        className="embed-editor_bg-layer-preview"
        style={{
          background: `${colorLayer}, ${SHADOW_PREVIEW_CHECKERBOARD}`,
        }}
        aria-hidden="true"
      />
    ),
    label: shadowLabel(shadow),
  };
}

// The edits the shadow list makes, each written back as the whole `text-shadow`
// value; the open editor's index follows the row it belongs to.
function shadowRowEdits({
  rows,
  props,
  setOpenIndex,
}: {
  rows: Array<Hideable<Shadow>>;
  props: Props;
  setOpenIndex: React.Dispatch<React.SetStateAction<number | undefined>>;
}) {
  const write = (next: Array<Hideable<Shadow>>, mode: 'live' | 'commit') => {
    const value = serializeHideable(next, ',', serializeShadows);
    if (mode === 'live') {
      if (value) {
        props.liveSetProp('text-shadow', value, false);
      }
      return;
    }
    if (value) {
      props.setProp('text-shadow', value, false);
    } else {
      props.clearProp('text-shadow');
    }
  };
  return {
    add: () => {
      const next = [...rows, { item: blankShadow(), hidden: false }];
      write(next, 'commit');
      setOpenIndex(next.length - 1);
    },
    remove: (i: number) => {
      write(
        rows.filter((_, j) => j !== i),
        'commit',
      );
      setOpenIndex((current) => {
        if (current === i) {
          return undefined;
        }
        return current !== undefined && current > i ? current - 1 : current;
      });
    },
    reorder: (from: number, to: number) => {
      if (from === to) {
        return;
      }
      const next = [...rows];
      const [moved] = next.splice(from, 1);
      if (moved === undefined) {
        return;
      }
      next.splice(to, 0, moved);
      write(next, 'commit');
      setOpenIndex((current) => (current === from ? to : current));
    },
    patch: (i: number, shadowPatch: ShadowPatch, mode: 'live' | 'commit') =>
      write(
        rows.map((row, j) => (j === i ? { ...row, item: { ...row.item, ...shadowPatch } } : row)),
        mode,
      ),
    toggle: (i: number) =>
      write(
        rows.map((row, j) => (j === i ? { ...row, hidden: !row.hidden } : row)),
        'commit',
      ),
  };
}

// ─────────────────────────── Section ───────────────────────────

export default function TypographySection(props: Props) {
  return (
    <div className="embed-editor_size embed-editor_type">
      <FontFamilyField {...props} />
      <WeightField {...props} />
      <div className="embed-editor_size-grid">
        <TextField prop="font-size" label="Size" placeholder="1rem" {...props} />
        <TextField prop="line-height" label="Height" placeholder="1.5" {...props} />
      </div>
      <ColorField {...props} />
      <AlignRow {...props} />
      <DecorRow {...props} />
      <ColumnsRow {...props} />
      <div className="embed-editor_type-triple embed-editor_type-segs">
        <SegCell
          prop="font-style"
          label="Italicize"
          ariaLabel="Font style"
          segs={ITALIC_SEGS}
          fallback="normal"
          {...props}
        />
        <SegCell
          prop="text-transform"
          label="Capitalize"
          ariaLabel="Text transform"
          segs={TRANSFORM_SEGS}
          fallback="none"
          {...props}
        />
        <SegCell
          prop="direction"
          label="Direction"
          ariaLabel="Text direction"
          segs={DIRECTION_SEGS}
          fallback="ltr"
          {...props}
        />
      </div>
      <BreakingRow {...props} />
      <WrapRow {...props} />
      <TruncateRow {...props} />
      <StrokeRow {...props} />
      <TextShadowsRow {...props} />
    </div>
  );
}
