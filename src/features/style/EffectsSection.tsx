import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { parseHideable, serializeHideable, type Hideable } from './model/hideable';
import TransformSettings from './TransformSettings';
import { takeSelfPerspective, withSelfPerspective } from './model/transformSettings';
import { createPortal } from 'react-dom';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import Select, { type SelectOption } from './components/Select';
import DragSlider from './components/DragSlider';
import LiveInput from './components/LiveInput';
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl';
import useScrub from './components/useScrub';
import SegmentedField, { type SegOption } from './SegmentedField';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './model/liveColor';
import LayerList from './LayerList';
import LayerPopover from './LayerPopover';
import { CURSOR_ICONS } from './cursorIcons';
import { useComputedValue, useHighlight } from './model/computedStyle';
import { ShadowLength, ShadowColorRow } from './ShadowFields';
import {
  parseBoxShadows,
  serializeBoxShadows,
  blankBoxShadow,
  boxShadowLabel,
  type BoxShadow,
  type BoxShadowPatch,
} from './model/boxShadow';
import { handleArrowStep } from './model/numberStep';
import {
  parseTransforms,
  serializeTransforms,
  blankTransform,
  retypeTransform,
  transformLabel,
  hasZ,
  IDENTITY,
  type Transform,
  type TransformPatch,
  type TransformType,
} from './model/transform';
import { transformAxisIcon, transformTypeIcon, LockIcon, UnlockIcon } from './transformIcons';
import ProvenanceList from './ProvenanceList';
import VariableConnect from './VariableConnect';
import type { Contributor, ResolvedProp } from './model/resolved';
import EasingEditor from './EasingEditor';
import {
  parseTransitions,
  serializeTransitions,
  blankTransition,
  transitionLabel,
  easingToBezier,
  TRANSITION_GROUPS,
  type Transition,
  type TransitionPatch,
} from './model/transition';
import {
  parseFilters,
  serializeFilters,
  blankFilter,
  filterLabel,
  type Filter,
} from './model/filter';
import FilterEditor from './FilterFields';
import { commitInPlace } from './model/commitInPlace';
import { PlusIcon } from './components/MenuParts';
import { openAfterRemoval, useExternalDraft } from './model/fieldHooks';
import { displayOf, parseImportant } from './model/styleDisplay';

// The Effects section (Webflow parity): blending, opacity, outline, box shadows,
// transforms, transitions, filters, backdrop filters, cursor, and pointer-events.
// Each control is driven by the resolved model (blue when the picked selector sets
// it, orange via another selector, a clear menu on the label). The list-style
// effects (shadows/transforms/…) edit their raw CSS value for now.

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

// How a write lands: live while typing or dragging, or committed.
interface WriteOptions {
  readonly live: boolean;
}

// Debounces live writes while typing: the text reaches `liveNow` 100ms after the last
// keystroke; `cancel` drops a pending one.
function useLiveTimer(liveNow: (text: string) => void) {
  const timer = useRef<number | undefined>(undefined);
  const cancel = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  useEffect(() => cancel, []);
  const live = (text: string) => {
    cancel();
    timer.current = window.setTimeout(() => liveNow(text), 100);
  };
  return { live, cancel };
}

// Enter commits in place; ↑/↓ step the number under the caret (unit preserved) in the
// field itself. Returns the stepped text, or undefined when the key did not step.
function stepInPlace(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
  const input = event.currentTarget;
  if (event.key === 'Enter') {
    commitInPlace(input);
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// A draft field's own handlers, spread onto the input after the scrub's: typing
// schedules a live write, blur cancels it and commits, ↑/↓ step in place.
function draftInputHandlers({
  focusedRef,
  setDraft,
  live,
  cancel,
  commit,
}: {
  focusedRef: React.MutableRefObject<boolean>;
  setDraft: (draft: string) => void;
  live: (text: string) => void;
  cancel: () => void;
  commit: () => void;
}) {
  return {
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
      live(event.target.value);
    },
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: () => {
      focusedRef.current = false;
      cancel();
      commit();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepInPlace(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        live(stepped);
      }
    },
  };
}

// Write a whole property value: live writes skip an empty value; a committed empty
// value clears the property.
function writeValue(
  prop: string,
  value: string,
  options: WriteOptions,
  writers: Pick<Props, 'setProp' | 'clearProp' | 'liveSetProp'>,
) {
  if (options.live) {
    if (value) {
      writers.liveSetProp(prop, value, false);
    }
    return;
  }
  if (value) {
    writers.setProp(prop, value, false);
  } else {
    writers.clearProp(prop);
  }
}

// A layered effect's rows (see lib/hideable.ts) and which row's editor popover is open:
// add, remove, reorder, hide, and edit a row, each written back through `write`.
function useLayerRows<T>({
  rows,
  blank,
  write,
}: {
  rows: Array<Hideable<T>>;
  blank: () => T;
  write: (next: Array<Hideable<T>>, options: WriteOptions) => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | undefined>(undefined);
  const add = () => {
    const next = [...rows, { item: blank(), hidden: false }];
    write(next, { live: false });
    setOpenIndex(next.length - 1);
  };
  const remove = (i: number) => {
    write(
      rows.filter((_, other) => other !== i),
      { live: false },
    );
    setOpenIndex((previous) => openAfterRemoval(previous, i));
  };
  const reorder = (from: number, to: number) => {
    if (from === to) {
      return;
    }
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) {
      return;
    }
    next.splice(to, 0, moved);
    write(next, { live: false });
    setOpenIndex((previous) => (previous === from ? to : previous));
  };
  const update = (i: number, options: WriteOptions, change: (item: T) => T) =>
    write(
      rows.map((row, other) => (other === i ? { ...row, item: change(row.item) } : row)),
      options,
    );
  const toggle = (i: number) =>
    write(
      rows.map((row, other) => (other === i ? { ...row, hidden: !row.hidden } : row)),
      { live: false },
    );
  const open = (i: number, element: HTMLElement) => {
    setOpenIndex((previous) => (previous === i ? undefined : i));
    setAnchorElement(element);
  };
  const close = () => setOpenIndex(undefined);
  const isHidden = (i: number) => rows[i]?.hidden ?? false;
  return { openIndex, anchorElement, add, remove, reorder, update, toggle, open, close, isHidden };
}

// The property label: blue/active when the picked selector sets it (with a clear
// menu + provenance), orange when it's set through another selector.
function EffLabel({ label, prop, props }: { label: string; prop: string; props: Props }) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read(prop));
  const contributors: Contributor[] = read(prop)?.contributors ?? [];
  if (display.present && !display.isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={display.isSelected}
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel="Clear"
      tooltip={<PropTip props={[prop]} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={contributors}
          prop={prop}
          onSelect={(selector, selectedProp) => {
            onSelectSelector(selector, selectedProp);
            close();
          }}
        />
      )}
    >
      {label}
    </FieldLabel>
  );
}

// The outline's colour: the swatch and the field beside it, both showing a drag
// as it happens. The drag writes to the canvas, not to the model the field
// reads, so without this the page moves under the pointer while the number
// sits still (see liveColor.ts).
function OutlineColor({ props, value }: { props: Props; value: string }) {
  const { busy, setProp, liveSetProp } = props;
  const [shown, noteLive] = useLiveColor(value);
  return (
    <>
      <ColorSwatch
        value={shown}
        busy={busy}
        ariaLabel="Outline color"
        onChange={(color, live) => {
          noteLive(live ? color : undefined);
          if (live) {
            liveSetProp('outline-color', color, false);
          } else {
            setProp('outline-color', color, false);
          }
        }}
      />
      <LiveText
        prop="outline-color"
        placeholder="currentColor"
        props={props}
        {...(shown === value ? {} : { dragging: shown })}
      />
    </>
  );
}

// A live text field bound to one property (raw CSS value editors).
function LiveText({
  prop,
  placeholder,
  props,
  dragging,
}: {
  prop: string;
  placeholder: string;
  props: Props;
  dragging?: string;
}) {
  const { read, busy, setProp, clearProp, liveSetProp } = props;
  const display = displayOf(read(prop));
  // `dragging` is what a swatch beside this field is showing mid-drag.
  const written = display.important ? `${display.value} !important` : display.value;
  const external = dragging ?? (display.present ? written : '');
  const { draft, setDraft, focused } = useExternalDraft(external);
  // Undelayed live write for the scrub, which throttles its own — see useScrub.
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) {
      const parsed = parseImportant(trimmed);
      liveSetProp(prop, parsed.value, parsed.important);
    }
  };
  const { live, cancel } = useLiveTimer(liveNow);
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      clearProp(prop);
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
  };
  const commitScrub = (text: string) => {
    setDraft(text);
    commit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: commitScrub,
  });
  return (
    <VariableConnect
      code
      className="is-fill"
      ariaLabel={`Connect ${prop} to a variable`}
      disabled={busy}
      prop={prop}
      onPick={(binding) => setProp(prop, binding, false)}
    >
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input embed-editor_eff-value"
        data-prop={prop}
        value={draft}
        {...draftInputHandlers({ focusedRef: focused, setDraft, live, cancel, commit })}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={prop}
      />
    </VariableConnect>
  );
}

// ─────────────────────────── Option lists ───────────────────────────

const BLEND_MODES: SelectOption<string>[] = [
  'normal',
  'darken',
  'multiply',
  'color-burn',
  'lighten',
  'screen',
  'color-dodge',
  'overlay',
  'soft-light',
  'hard-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
].map((mode) => ({
  value: mode,
  label:
    mode === 'color-burn'
      ? 'Color burn'
      : mode === 'color-dodge'
        ? 'Color dodge'
        : mode === 'soft-light'
          ? 'Soft light'
          : mode === 'hard-light'
            ? 'Hard light'
            : (mode[0] ?? '').toUpperCase() + mode.slice(1),
}));

// Grouped like Webflow's cursor menu: a non-selectable heading per group, each
// cursor indented and shown with its Webflow glyph.
const CURSOR_GROUPS: ReadonlyArray<{ heading: string; values: string[] }> = [
  { heading: 'General', values: ['auto', 'default', 'none'] },
  {
    heading: 'Links & Status',
    values: ['pointer', 'not-allowed', 'wait', 'progress', 'help', 'context-menu'],
  },
  { heading: 'Selection', values: ['cell', 'crosshair', 'text', 'vertical-text'] },
  { heading: 'Drag & Drop', values: ['grab', 'grabbing', 'alias', 'copy', 'move'] },
  { heading: 'Zoom', values: ['zoom-in', 'zoom-out'] },
  {
    heading: 'Resize',
    values: [
      'col-resize',
      'row-resize',
      'nesw-resize',
      'nwse-resize',
      'ew-resize',
      'ns-resize',
      'n-resize',
      'w-resize',
      's-resize',
      'e-resize',
      'nw-resize',
      'ne-resize',
      'sw-resize',
      'se-resize',
    ],
  },
];
const CURSORS: SelectOption<string>[] = CURSOR_GROUPS.flatMap((group) => [
  { value: `__${group.heading}`, label: group.heading, heading: true },
  ...group.values.map((cursor) => ({
    value: cursor,
    label: cursor,
    icon: CURSOR_ICONS[cursor],
    indent: true,
  })),
]);

const OUTLINE_OPTIONS: readonly SegOption[] = [
  { value: 'none', label: '✕', menuLabel: 'None', ariaLabel: 'None' },
  {
    value: 'solid',
    label: <span className="embed-editor_border-style-line is-solid" />,
    menuLabel: 'Solid',
    ariaLabel: 'Solid',
  },
  {
    value: 'dashed',
    label: <span className="embed-editor_border-style-line is-dashed" />,
    menuLabel: 'Dashed',
    ariaLabel: 'Dashed',
  },
  {
    value: 'dotted',
    label: <span className="embed-editor_border-style-line is-dotted" />,
    menuLabel: 'Dotted',
    ariaLabel: 'Dotted',
  },
];
const EVENTS_OPTIONS: readonly SegOption[] = [
  { value: 'auto', label: 'Auto', menuLabel: 'Auto' },
  { value: 'none', label: 'None', menuLabel: 'None' },
];

// The "Custom…" sentinel + preset value sets (values that ARE listed in the dropdown,
// so anything else counts as a custom value that opens the input).
const CUSTOM = '__custom__';
const BLEND_SET = new Set(BLEND_MODES.map((option) => option.value));
const CURSOR_SET = new Set(CURSOR_GROUPS.flatMap((group) => group.values));

// The free-text input the Select swaps in when "Custom…" is picked (or the current
// value isn't a listed preset). Empty when just switched from a preset, so you type
// a fresh value; committing empty clears the property and returns to the dropdown.
interface CustomInputProps {
  prop: string;
  value: string;
  placeholder: string;
  busy: boolean;
  autoFocus: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
  clearProp: ClearProp;
  onExit: () => void;
}
function CustomInput(props: CustomInputProps) {
  const { prop, value, placeholder, busy, setProp, liveSetProp, clearProp, onExit } = props;
  const { draft, setDraft, focused } = useExternalDraft(value);
  const { live, cancel } = useLiveTimer((text) => {
    const trimmed = text.trim();
    if (trimmed) {
      const parsed = parseImportant(trimmed);
      liveSetProp(prop, parsed.value, parsed.important);
    }
  });
  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      clearProp(prop);
      onExit();
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
  };
  return (
    <VariableConnect
      ariaLabel={`Connect ${prop} to a variable`}
      disabled={busy}
      prop={prop}
      onPick={(binding) => setProp(prop, binding, false)}
    >
      <input
        className="u-input u-select-custom-input"
        value={draft}
        autoFocus={props.autoFocus}
        onChange={(event) => {
          setDraft(event.target.value);
          live(event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          cancel();
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
        aria-label={prop}
      />
    </VariableConnect>
  );
}

// A preset dropdown whose last option is "Custom…" — picking it (or an existing
// value not in the list) swaps the trigger for a free-text input.
interface PresetSelectRowProps {
  prop: string;
  label: string;
  options: SelectOption<string>[];
  presets: Set<string>;
  fallback: string;
  placeholder: string;
  props: Props;
  /** Offer a "Custom…" free-value option. Off for enumerated props (e.g. cursor)
   *  where Webflow won't store arbitrary/CSS-wide values anyway. */
  allowCustom?: boolean;
}
function PresetSelectRow(row: PresetSelectRowProps) {
  const { prop, label, options, presets, props, allowCustom = true } = row;
  const { read, busy, setProp, liveSetProp, clearProp } = props;
  const display = displayOf(read(prop));
  const current = display.present ? display.value.trim() : '';
  // Nothing authored → highlight what the page actually computes for this element,
  // falling back to the CSS initial value when there's no canvas to ask.
  const shown = useHighlight(
    current,
    prop,
    options.map((option) => option.value),
    row.fallback,
  );
  const isPreset = !current || presets.has(current);
  const [forceCustom, setForceCustom] = useState(false);
  const customMode = allowCustom && (forceCustom || (display.present && !isPreset));
  const pick = (choice: string) => {
    if (choice === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    setProp(prop, choice, false);
  };
  // "Custom…" has no value of its own to show, so landing on it reverts the preview.
  const preview = (option: string | undefined) =>
    liveSetProp(prop, option === CUSTOM ? undefined : option, false);
  const written = display.important ? `${display.value} !important` : display.value;
  const inputValue = forceCustom && isPreset ? '' : display.present ? written : '';
  const selectOptions = presetSelectOptions({
    options,
    allowCustom,
    stray: display.present && !isPreset ? current : undefined,
  });
  return (
    <div className="embed-editor_size-row">
      <EffLabel label={label} prop={prop} props={props} />
      <Select
        value={customMode ? CUSTOM : shown}
        options={selectOptions}
        onChange={pick}
        onPreview={(option) => preview(option ?? undefined)}
        ariaLabel={label}
        disabled={busy}
        customInput={
          customMode ? (
            <CustomInput
              prop={prop}
              value={inputValue}
              placeholder={row.placeholder}
              busy={busy}
              autoFocus={forceCustom}
              setProp={setProp}
              liveSetProp={liveSetProp}
              clearProp={clearProp}
              onExit={() => setForceCustom(false)}
            />
          ) : undefined
        }
      />
    </div>
  );
}

// The dropdown's options: the presets, then "Custom…". With Custom off, a pre-existing
// non-preset value (`stray`) is still surfaced so the trigger shows it (rather than
// silently falling back to the first option).
function presetSelectOptions({
  options,
  allowCustom,
  stray,
}: {
  options: SelectOption<string>[];
  allowCustom: boolean;
  stray: string | undefined;
}): SelectOption<string>[] {
  if (allowCustom) {
    return [...options, { value: CUSTOM, label: 'Custom…' }];
  }
  if (stray !== undefined) {
    return [...options, { value: stray, label: stray }];
  }
  return options;
}

// ─────────────────────────── Rows ───────────────────────────

/** The percentage a value reads as, or undefined when it isn't a number at all. */
function percentOf(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const amount = parseFloat(trimmed);
  if (Number.isNaN(amount) || !/^[-+]?[\d.]+%?$/.test(trimmed)) {
    return undefined;
  }
  return Math.round(trimmed.includes('%') ? amount : amount * 100);
}
const opacityCss = (percent: number) =>
  percent >= 100 ? '1' : percent <= 0 ? '0' : String(Math.round(percent) / 100);
const clampPercent = (percent: number) => Math.min(100, Math.max(0, Math.round(percent)));
// The unit is part of the value the field shows — `100%`, the way it reads in CSS —
// rather than a chip pinned beside it.
const percentText = (percent: number) => `${percent}%`;
// Typing the % (or leaving it off) both work: the parse only wants the number.
function parsePercent(text: string): number | undefined {
  const amount = parseFloat(text);
  return Number.isNaN(amount) ? undefined : clampPercent(amount);
}

function OpacityRow({ props }: { props: Props }) {
  const { read, busy, setProp, liveSetProp } = props;
  const display = displayOf(read('opacity'));
  const raw = display.present ? display.value.trim() : '';
  const authored = percentOf(raw);
  // `opacity: var(--fade)` is a number the panel can't read — but the page can, and
  // a slider parked at 100% while the element is half faded is just wrong. Ask for
  // the computed value in that case (only then: a plain `0.4` needs no round trip).
  const computed = percentOf(useComputedValue(authored === undefined && raw ? 'opacity' : ''));
  const percent = authored ?? computed ?? 100;
  // A value the panel can't express as a number stays in the field as it was
  // written, so the variable chip shows and editing around it doesn't flatten it.
  const asNumber = authored !== undefined || !raw;
  // Drag previews live (DragSlider already throttles the writes); release commits.
  const live = (value: number) => liveSetProp('opacity', opacityCss(clampPercent(value)), false);
  const commit = (value: number) => setProp('opacity', opacityCss(clampPercent(value)), false);

  // The number field's local draft: typing previews live; blur / Enter commits.
  const fieldText = asNumber ? percentText(percent) : raw;
  const field = useExternalDraft(fieldText);

  return (
    <div className="embed-editor_size-row">
      <EffLabel label="Opacity" prop="opacity" props={props} />
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={percent}
          min={0}
          max={100}
          disabled={busy}
          ariaLabel="Opacity"
          onPreview={(value) => {
            if (!field.focused.current) {
              field.setDraft(percentText(value));
            }
          }}
          onInput={live}
          onCommit={(value) => {
            if (!field.focused.current) {
              field.setDraft(percentText(value));
            }
            commit(value);
          }}
        />
        <OpacityNumberField
          text={field.draft}
          setText={field.setDraft}
          focusedRef={field.focused}
          fieldText={fieldText}
          percent={percent}
          busy={busy}
          live={live}
          commit={commit}
          setProp={setProp}
        />
      </div>
    </div>
  );
}

// The opacity percent as text: typing and stepping preview live; blur commits a
// number as an opacity and anything else (a var(), a calc()) as written.
interface OpacityFieldProps {
  text: string;
  setText: (text: string) => void;
  focusedRef: React.MutableRefObject<boolean>;
  fieldText: string;
  percent: number;
  busy: boolean;
  live: (value: number) => void;
  commit: (value: number) => void;
  setProp: SetProp;
}

function OpacityNumberField(props: OpacityFieldProps) {
  const { text, setText, focusedRef, busy, live, setProp } = props;
  const { scrub, commitTyped } = useOpacityField(props);
  return (
    <div className="embed-editor_field embed-editor_grad-num embed-editor_opacity-num">
      <VariableConnect
        className="is-fill"
        ariaLabel="Connect Opacity to a variable"
        disabled={busy}
        prop="opacity"
        onPick={(binding) => setProp('opacity', binding, false)}
      >
        <input
          {...scrub.input}
          className="u-input embed-editor_size-input"
          value={text}
          inputMode="decimal"
          spellCheck={false}
          disabled={busy}
          aria-label="Opacity percent"
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(event) => {
            setText(event.target.value);
            const value = percentOf(event.target.value);
            if (value !== undefined) {
              live(value);
            }
          }}
          onBlur={() => {
            focusedRef.current = false;
            commitTyped();
          }}
          onKeyDown={(event) => {
            const stepped = stepInPlace(event);
            if (stepped === undefined) {
              return;
            }
            setText(stepped);
            const value = parsePercent(stepped);
            if (value !== undefined) {
              live(value);
            }
          }}
        />
      </VariableConnect>
    </div>
  );
}

// The field's scrub (a scrub commits a number, or puts the percent back) and its
// commit on blur.
function useOpacityField({
  text,
  setText,
  fieldText,
  percent,
  busy,
  live,
  commit,
  setProp,
}: OpacityFieldProps) {
  const commitScrub = (next: string) => {
    setText(next);
    const value = parsePercent(next);
    if (value !== undefined) {
      commit(value);
    } else {
      setText(String(percent));
    }
  };
  const scrub = useScrub({
    value: text,
    disabled: busy,
    onPreview: setText,
    onInput: (next) => {
      const value = parsePercent(next);
      if (value !== undefined) {
        live(value);
      }
    },
    onCommit: commitScrub,
  });
  const commitTyped = () => {
    const trimmed = text.trim();
    // Untouched — a var()/expression stays as it is.
    if (trimmed === fieldText) {
      return;
    }
    const value = percentOf(trimmed);
    // A number becomes an opacity; anything else (a var(), a calc()) is
    // written as it stands, so a variable typed in here survives.
    if (value !== undefined) {
      commit(value);
      setText(percentText(clampPercent(value)));
    } else if (trimmed) {
      setProp('opacity', trimmed, false);
    } else {
      setText(fieldText);
    }
  };
  return { scrub, commitTyped };
}

// ─────────────── 2D & 3D transforms (layered, mirrors text-shadow) ───────────────

const TRANSFORM_TYPES: ReadonlyArray<SegmentedOption<TransformType>> = [
  { value: 'move', label: 'Move' },
  { value: 'scale', label: 'Scale' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'skew', label: 'Skew' },
];

const MoreIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="4" cy="8" r="1.15" fill="currentColor" />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" />
    <circle cx="12" cy="8" r="1.15" fill="currentColor" />
  </svg>
);
const TransformPlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const FilterGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph">
    <path
      d="M2.5 4h11l-4.2 5v3.5L6.7 14V9L2.5 4Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

// The Filters / Backdrop filters row: a stack of filter functions (blur/brightness/…/
// drop-shadow) edited as one CSS `filter` value. Mirrors TransformsRow.
function FiltersRow({ prop, label, props }: { prop: string; label: string; props: Props }) {
  const { read, busy } = props;
  const display = displayOf(read(prop));
  // Shared by Filters and Backdrop filters, so both get the eye from here.
  const rows = parseHideable(display.present ? display.value : '', ' ', parseFilters);
  const layers = rows.map((row) => row.item);
  const write = (next: Array<Hideable<Filter>>, options: WriteOptions) =>
    writeValue(prop, serializeHideable(next, ' ', serializeFilters), options, props);
  const stack = useLayerRows({ rows, blank: blankFilter, write });
  const { openIndex } = stack;
  const openLayer = openIndex === undefined ? undefined : layers[openIndex];
  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label={label} prop={prop} props={props} />
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={stack.add}
          disabled={busy}
          title={`Add a ${label.toLowerCase()} filter`}
          aria-label="Add a filter"
        >
          <TransformPlusIcon />
        </button>
      </div>
      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel={label}
        onOpen={stack.open}
        onReorder={stack.reorder}
        onRemove={stack.remove}
        isHidden={stack.isHidden}
        onToggleHidden={stack.toggle}
        renderRow={(i) => {
          const layer = layers[i];
          if (layer === undefined) {
            throw new Error(`Filter layer ${i} is missing`);
          }
          return { preview: <FilterGlyph />, label: filterLabel(layer) };
        }}
      />
      {openIndex !== undefined && stack.anchorElement && openLayer ? (
        <LayerPopover anchorEl={stack.anchorElement} ariaLabel={label} onClose={stack.close}>
          <FilterEditor
            filter={openLayer}
            busy={busy}
            onChange={(next, live) => stack.update(openIndex, { live }, () => next)}
          />
        </LayerPopover>
      ) : undefined}
    </div>
  );
}

// Per-type slider config: the unit the slider re-attaches, its coarse range (in value
// units), and how many slider steps map to one unit. The slider is integer-only, so
// `scale` (0–2) runs in hundredths for sub-integer precision; the number field always
// allows a precise value outside the range.
const AXIS_CONFIG: Record<
  TransformType,
  { unit: string; min: number; max: number; steps: number }
> = {
  // Move is in rem unless the value itself says otherwise — `steps` is how many
  // slider notches make one unit, so 100 gives hundredths of a rem across a
  // range wide enough to push something off its own width.
  move: { unit: 'rem', min: -20, max: 20, steps: 100 },
  scale: { unit: '', min: 0, max: 2, steps: 100 },
  rotate: { unit: 'deg', min: -180, max: 180, steps: 1 },
  skew: { unit: 'deg', min: -90, max: 90, steps: 1 },
};

// Split "10px" / "1.5" / "45deg" into number + unit (bare number → the type's default
// unit); undefined for var()/calc()/… so the slider disables but the field stays editable.
function parseAxis(value: string, fallbackUnit: string): { num: number; unit: string } | undefined {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
  if (!match) {
    return undefined;
  }
  // `none` isn't a real axis unit — never re-attach it (that's what produces `1none`).
  const unit = match[2] ?? '';
  const raw = unit.toLowerCase() === 'none' ? '' : unit;
  return { num: parseFloat(match[1] ?? ''), unit: raw || fallbackUnit };
}

// One transform axis (X / Y / Z): a coarse drag slider beside a precise number field,
// mirroring text-shadow's ShadowLength. The slider drives the numeric part and re-attaches
// the value's unit; the field holds the full value (e.g. `10px`) so var()/calc() and any
// unit survive.
interface AxisInputProps {
  type: TransformType;
  label: 'X' | 'Y' | 'Z';
  value: string;
  placeholder: string;
  busy: boolean;
  /** Per-frame during a slider drag (before the throttled onLive) — lets a linked pair
   *  mirror this axis smoothly, not just on the throttled write. */
  onPreview?: (value: string) => void;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}
function AxisInput(props: AxisInputProps) {
  const { type, label, value, placeholder, busy, onPreview, onLive, onCommit } = props;
  const config = AXIS_CONFIG[type];
  const parsed = parseAxis(value, config.unit);
  const unit = parsed?.unit ?? config.unit;
  const fmt = (slider: number): string => `${Number((slider / config.steps).toFixed(4))}${unit}`;
  const { draft, setDraft, focused } = useExternalDraft(value);
  const field = useAxisField({
    draft,
    setDraft,
    focused,
    placeholder,
    busy,
    onPreview,
    onLive,
    onCommit,
  });
  return (
    <div className="embed-editor_size-row">
      <span
        className="embed-editor_size-label embed-editor_bg-caption embed-editor_transform-axis"
        aria-hidden="true"
      >
        {transformAxisIcon(type, label === 'X' ? 'x' : label === 'Y' ? 'y' : 'z')}
      </span>
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={Math.round((parsed?.num ?? 0) * config.steps)}
          min={config.min * config.steps}
          max={config.max * config.steps}
          disabled={busy || !parsed}
          ariaLabel={label}
          onPreview={(slider) => {
            const formatted = fmt(slider);
            if (!focused.current) {
              setDraft(formatted);
            }
            onPreview?.(formatted);
          }}
          onInput={(slider) => onLive(fmt(slider))}
          onCommit={(slider) => onCommit(fmt(slider))}
        />
        <input
          {...field.scrub.input}
          className="u-input embed-editor_size-input embed-editor_shadow-num"
          value={draft}
          {...field.handlers}
          disabled={busy}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
        />
      </div>
    </div>
  );
}

// The axis field's typing behavior: live writes 100ms after typing stops (undelayed for
// the scrub, which also previews every frame), commit on blur (an empty field commits
// the placeholder), and ↑/↓ stepping. The handlers spread after the scrub's.
function useAxisField({
  draft,
  setDraft,
  focused,
  placeholder,
  busy,
  onPreview,
  onLive,
  onCommit,
}: {
  draft: string;
  setDraft: (draft: string) => void;
  focused: React.MutableRefObject<boolean>;
  placeholder: string;
  busy: boolean;
  onPreview: ((value: string) => void) | undefined;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) {
      onLive(trimmed);
    }
  };
  const { live, cancel } = useLiveTimer(liveNow);
  const commit = (text = draft) => {
    onCommit(text.trim() || placeholder);
  };
  const previewScrub = (text: string) => {
    setDraft(text);
    onPreview?.(text);
  };
  const commitScrub = (text: string) => {
    setDraft(text);
    commit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: previewScrub,
    onInput: liveNow,
    onCommit: commitScrub,
  });
  const handlers = draftInputHandlers({ focusedRef: focused, setDraft, live, cancel, commit });
  return { scrub, handlers };
}

// The per-layer editor: a Type toggle (Move/Scale/Rotate/Skew) + X/Y/Z fields (Z is
// hidden for Skew, which is 2D). Switching Type resets the axes to that type's identity.
function TransformEditor({
  layer,
  busy,
  onChange,
}: {
  layer: Transform;
  busy: boolean;
  onChange: (patch: TransformPatch, live: boolean) => void;
}) {
  const placeholder = IDENTITY[layer.type];
  // Scale defaults to linked X & Y (uniform scale, like Webflow); the lock toggles it.
  const [locked, setLocked] = useState(true);
  const linkXY = layer.type === 'scale' && locked;
  const { values, bump } = useAxisValues(layer);
  // An axis field's handlers, given the patch one of its edits makes.
  const emit = (patch: TransformPatch, options: WriteOptions) => {
    bump(patch);
    onChange(patch, options.live);
  };
  const handlersFor = (patchOf: (value: string) => TransformPatch) => ({
    onPreview: (value: string) => bump(patchOf(value)),
    onLive: (value: string) => emit(patchOf(value), { live: true }),
    onCommit: (value: string) => emit(patchOf(value), { live: false }),
  });
  const axes = axisFields({ values, linkXY, handlersFor });
  const retype = (type: TransformType) => emit(retypeTransform(type), { live: false });
  const shared = { placeholder, busy };
  return (
    <div className="embed-editor_type-shadow-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
        <SegmentedControl
          value={layer.type}
          options={TRANSFORM_TYPES}
          onChange={retype}
          ariaLabel="Transform type"
        />
      </div>
      {layer.type === 'scale' ? (
        <div className="embed-editor_transform-lock-group">
          <div className="embed-editor_transform-lock-rows">
            <AxisInput type="scale" label="X" {...shared} {...axes.x} />
            <AxisInput type="scale" label="Y" {...shared} {...axes.y} />
          </div>
          <ScaleLock
            locked={locked}
            busy={busy}
            onToggle={() => setLocked((wasLocked) => !wasLocked)}
          />
        </div>
      ) : (
        <>
          <AxisInput type={layer.type} label="X" {...shared} {...axes.x} />
          <AxisInput type={layer.type} label="Y" {...shared} {...axes.y} />
        </>
      )}
      {!hasZ(layer.type) ? undefined : layer.type === 'scale' ? (
        // Z reserves the same right gutter the lock button occupies, so its slider +
        // number field line up with X and Y.
        <div className="embed-editor_transform-lock-group">
          <div className="embed-editor_transform-lock-rows">
            <AxisInput type="scale" label="Z" {...shared} {...axes.z} />
          </div>
          <span className="embed-editor_transform-lock-spacer" aria-hidden="true" />
        </div>
      ) : (
        <AxisInput type={layer.type} label="Z" {...shared} {...axes.z} />
      )}
    </div>
  );
}

// One axis edit → the axes it actually drives (X and Y move together when linked).
function axisFields({
  values,
  linkXY,
  handlersFor,
}: {
  values: { x: string; y: string; z: string };
  linkXY: boolean;
  handlersFor: (patchOf: (value: string) => TransformPatch) => Omit<AxisField, 'value'>;
}): AxisFields {
  const xPatch = (value: string): TransformPatch =>
    linkXY ? { x: value, y: value } : { x: value };
  const yPatch = (value: string): TransformPatch =>
    linkXY ? { x: value, y: value } : { y: value };
  return {
    x: { value: values.x, ...handlersFor(xPatch) },
    y: { value: values.y, ...handlersFor(yPatch) },
    z: { value: values.z, ...handlersFor((value) => ({ z: value })) },
  };
}

// One axis field's value and the handlers its edits call.
interface AxisField {
  value: string;
  onPreview: (value: string) => void;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}
type AxisFields = Record<'x' | 'y' | 'z', AxisField>;

// Optimistic axis values so a LINKED drag moves BOTH sliders together, every frame. A
// live/preview write previews to the canvas but doesn't refresh the read model `layer`
// derives from, so the partner slider (driven by its value prop) would otherwise sit
// still until release. Every edit is mirrored here (`bump`) and these feed the fields.
function useAxisValues(layer: Transform) {
  const [values, setValues] = useState<{ x: string; y: string; z: string }>({
    x: layer.x,
    y: layer.y,
    z: layer.z,
  });
  useEffect(() => {
    setValues({ x: layer.x, y: layer.y, z: layer.z });
  }, [layer.x, layer.y, layer.z]);
  const bump = (patch: TransformPatch) =>
    setValues((current) => {
      const next = { ...current, ...patch };
      return { x: next.x, y: next.y, z: next.z };
    });
  return { values, bump };
}

function ScaleLock({
  locked,
  busy,
  onToggle,
}: {
  locked: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`embed-editor_transform-lock ${locked ? 'is-locked' : ''}`}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={locked}
      title={locked ? 'Unlink X & Y' : 'Link X & Y'}
      aria-label={locked ? 'Unlink X and Y' : 'Link X and Y'}
    >
      {locked ? LockIcon : UnlockIcon}
    </button>
  );
}

// The transform stack: header + add, a reorderable/removable layer list, and the
// per-layer editor in a popup — the same layer + component functionality as text-shadow.
function TransformsRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp } = props;
  const display = displayOf(read('transform'));
  // A self perspective lives in this same value, as a perspective() function,
  // and parseTransforms drops every function it doesn't recognise — so lift it
  // out before the layers are read and put it back in front on the way out, or
  // it vanishes the next time any layer is touched. See lib/transform-settings.
  const { distance: selfPerspective, rest } = takeSelfPerspective(
    display.present ? display.value : '',
  );
  // Rows rather than bare layers: a hidden one is still in the list and still
  // in the CSS, commented out (see lib/hideable.ts).
  const rows = parseHideable(rest, ' ', parseTransforms);
  const layers = rows.map((row) => row.item);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const put = (next: Array<Hideable<Transform>>, distance: string, options: WriteOptions) => {
    const value = withSelfPerspective(serializeHideable(next, ' ', serializeTransforms), distance);
    writeValue('transform', value, options, props);
  };
  const write = (next: Array<Hideable<Transform>>, options: WriteOptions) =>
    put(next, selfPerspective, options);
  const stack = useLayerRows({ rows, blank: blankTransform, write });
  const { openIndex } = stack;
  const openLayer = openIndex === undefined ? undefined : layers[openIndex];
  return (
    <div className="embed-editor_type-shadows">
      <TransformsHead
        props={props}
        settingsOpen={settingsOpen}
        settingsRef={settingsRef}
        onToggleSettings={() => setSettingsOpen((wasOpen) => !wasOpen)}
        onAdd={stack.add}
      />
      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel="Transforms"
        onOpen={stack.open}
        onReorder={stack.reorder}
        onRemove={stack.remove}
        isHidden={stack.isHidden}
        onToggleHidden={stack.toggle}
        renderRow={(i) => transformRow(layers, i)}
      />
      {openIndex !== undefined && stack.anchorElement && openLayer ? (
        <LayerPopover anchorEl={stack.anchorElement} ariaLabel="Transform" onClose={stack.close}>
          <TransformEditor
            layer={openLayer}
            busy={busy}
            onChange={(patch, live) =>
              stack.update(openIndex, { live }, (item) => ({ ...item, ...patch }))
            }
          />
        </LayerPopover>
      ) : undefined}
      {settingsOpen && settingsRef.current ? (
        <LayerPopover
          anchorEl={settingsRef.current}
          ariaLabel="Transform settings"
          onClose={() => setSettingsOpen(false)}
        >
          <TransformSettings
            read={read}
            busy={busy}
            setProp={setProp}
            clearProp={clearProp}
            selfPerspective={selfPerspective}
            onSelfPerspective={(distance, live) => put(rows, distance, { live })}
          />
        </LayerPopover>
      ) : undefined}
    </div>
  );
}

// A row of the transform list: its type's glyph and its label.
function transformRow(layers: Transform[], i: number) {
  const layer = layers[i];
  if (layer === undefined) {
    throw new Error(`Transform layer ${i} is missing`);
  }
  return { preview: transformTypeIcon(layer.type), label: transformLabel(layer) };
}

// The transforms header: the label, the settings (⋯) toggle, and add.
function TransformsHead({
  props,
  settingsOpen,
  settingsRef,
  onToggleSettings,
  onAdd,
}: {
  props: Props;
  settingsOpen: boolean;
  settingsRef: React.RefObject<HTMLButtonElement>;
  onToggleSettings: () => void;
  onAdd: () => void;
}) {
  const { busy } = props;
  return (
    <div className="embed-editor_bg-layers-head">
      <EffLabel label="2D & 3D transforms" prop="transform" props={props} />
      <div className="embed-editor_bg-layers-actions">
        <button
          type="button"
          ref={settingsRef}
          className={`embed-editor_icon-btn ${settingsOpen ? 'is-active' : ''}`}
          onClick={onToggleSettings}
          disabled={busy}
          title="Transform settings"
          aria-label="Transform settings"
          aria-expanded={settingsOpen}
        >
          <MoreIcon />
        </button>
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={onAdd}
          disabled={busy}
          title="Add a transform"
          aria-label="Add a transform"
        >
          <TransformPlusIcon />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────── Transitions ───────────────────────────

const ClockIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M8 5v3l2 1.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
function EaseCurveIcon({ timing }: { timing: string }) {
  const bezier = easingToBezier(timing || 'ease');
  const size = 16;
  const pt = (x: number, y: number) => `${(x * size).toFixed(1)} ${(size - y * size).toFixed(1)}`;
  return (
    <svg viewBox={`-2 -5 ${size + 4} ${size + 10}`} width="16" height="16" aria-hidden="true">
      <path
        d={`M ${pt(0, 0)} C ${pt(bezier[0], bezier[1])} ${pt(bezier[2], bezier[3])} ${pt(1, 1)}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function durationToMs(value: string): number {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(-?[\d.]+)(ms|s)?$/);
  if (!match) {
    return 0;
  }
  const amount = parseFloat(match[1] ?? '');
  return match[2] === 's' ? Math.round(amount * 1000) : Math.round(amount);
}
// The value's current time unit (so the slider keeps writing seconds when the value
// is in seconds instead of silently rewriting 1.2s → 1200ms). Non-time values → ms.
function durationUnit(value: string): 'ms' | 's' {
  return /^-?[\d.]+s$/i.test(value.trim()) ? 's' : 'ms';
}
// Format a slider's ms value back into the given unit (seconds rounded to 2 dp).
function fmtDuration(ms: number, unit: 'ms' | 's'): string {
  return unit === 's' ? `${parseFloat((ms / 1000).toFixed(2))}s` : `${Math.round(ms)}ms`;
}

// Duration: a slider (numeric ms) alongside a free-text input holding the raw value,
// so the unit lives inside the field and you can type 0.2s, var(), inherit, unset, etc.
function DurationField({
  value,
  busy,
  onCommit,
  onLive,
}: {
  value: string;
  busy: boolean;
  onCommit: (v: string) => void;
  onLive: (v: string) => void;
}) {
  const ms = durationToMs(value);
  const unit = durationUnit(value);
  // While the slider is being dragged the field shows where it is; the rest of
  // the time it shows what is set. The field is the panel's own (components/
  // LiveInput), so a duration can be a variable here like anywhere else.
  const [preview, setPreview] = useState<string | undefined>(undefined);
  return (
    <div className="embed-editor_trans-duration">
      <DragSlider
        value={ms}
        min={0}
        max={2000}
        disabled={busy}
        ariaLabel="Duration"
        onPreview={(milliseconds) => setPreview(fmtDuration(milliseconds, unit))}
        onInput={(milliseconds) => onLive(fmtDuration(milliseconds, unit))}
        onCommit={(milliseconds) => {
          setPreview(undefined);
          onCommit(fmtDuration(milliseconds, unit));
        }}
      />
      <LiveInput
        value={preview ?? value}
        busy={busy}
        ariaLabel="Duration"
        placeholder="0ms"
        prop="transition-duration"
        onLive={(next) => onLive(next.trim() || '0ms')}
        onCommit={(next) => onCommit(next.trim() || '0ms')}
      />
    </div>
  );
}

// The easing control: a curve-icon button opens the visual editor, and the text
// input takes any CSS timing value — keywords, cubic-bezier(), or inherit/unset/var().
function EasingField({
  value,
  busy,
  onCommit,
  onEditEasing,
}: {
  value: string;
  busy: boolean;
  onCommit: (v: string) => void;
  onEditEasing: () => void;
}) {
  return (
    <div className="embed-editor_trans-easing">
      <button
        type="button"
        className="embed-editor_trans-easing-btn"
        onClick={onEditEasing}
        disabled={busy}
        title="Edit easing"
        aria-label="Edit easing"
      >
        <EaseCurveIcon timing={value} />
      </button>
      <LiveInput
        value={value}
        busy={busy}
        ariaLabel="Easing"
        placeholder="ease"
        prop="transition-timing-function"
        onLive={() => {}}
        onCommit={(next) => onCommit(next.trim() || 'ease')}
      />
    </div>
  );
}

function TransitionEditor({
  transition,
  busy,
  onChange,
  onEditEasing,
}: {
  transition: Transition;
  busy: boolean;
  onChange: (p: TransitionPatch, live: boolean) => void;
  onEditEasing: () => void;
}) {
  const options = TRANSITION_GROUPS.flatMap<SelectOption<string>>((group) => [
    { value: `__h_${group.heading}`, label: group.heading, heading: true },
    ...group.items.map((item) => ({ value: item.value, label: item.label, indent: true })),
  ]);
  return (
    <div className="embed-editor_trans-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
        <Select
          value={transition.property}
          options={options}
          onChange={(next) => onChange({ property: next }, false)}
          ariaLabel="Transition type"
          disabled={busy}
          searchable
        />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Duration</span>
        <DurationField
          value={transition.duration}
          busy={busy}
          onCommit={(next) => onChange({ duration: next }, false)}
          onLive={(next) => onChange({ duration: next }, true)}
        />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Easing</span>
        <EasingField
          value={transition.timing}
          busy={busy}
          onCommit={(next) => onChange({ timing: next }, false)}
          onEditEasing={onEditEasing}
        />
      </div>
    </div>
  );
}

function TransitionsRow({ props }: { props: Props }) {
  const { read, busy } = props;
  const display = displayOf(read('transition'));
  // `transition` is comma-separated, unlike transform and filter.
  const rows = parseHideable(display.present ? display.value : '', ',', parseTransitions);
  const list = rows.map((row) => row.item);
  const [easingOpen, setEasingOpen] = useState(false);
  const write = (next: Array<Hideable<Transition>>, options: WriteOptions) =>
    writeValue('transition', serializeHideable(next, ',', serializeTransitions), options, props);
  const stack = useLayerRows({ rows, blank: blankTransition, write });
  const { openIndex } = stack;
  const current = openIndex !== undefined ? list[openIndex] : undefined;
  const patch = (changes: TransitionPatch, options: WriteOptions) => {
    if (openIndex !== undefined) {
      stack.update(openIndex, options, (item) => ({ ...item, ...changes }));
    }
  };

  return (
    <div className="embed-editor_type-shadows embed-editor_transitions">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label="Transitions" prop="transition" props={props} />
        <button
          type="button"
          className="embed-editor_icon-btn"
          disabled={busy}
          title="Add transition"
          aria-label="Add transition"
          onClick={stack.add}
        >
          <PlusIcon />
        </button>
      </div>
      <LayerList
        count={list.length}
        busy={busy}
        ariaLabel="Transitions"
        onOpen={stack.open}
        onReorder={stack.reorder}
        onRemove={stack.remove}
        isHidden={stack.isHidden}
        onToggleHidden={stack.toggle}
        renderRow={(i) => ({
          preview: (
            <span className="embed-editor_trans-clock" aria-hidden="true">
              <ClockIcon />
            </span>
          ),
          label: transitionLabel(list[i] ?? blankTransition()),
        })}
      />
      {openIndex !== undefined && stack.anchorElement && current ? (
        <LayerPopover anchorEl={stack.anchorElement} ariaLabel="Transition" onClose={stack.close}>
          <TransitionEditor
            transition={current}
            busy={busy}
            onChange={(changes, live) => patch(changes, { live })}
            onEditEasing={() => setEasingOpen(true)}
          />
        </LayerPopover>
      ) : undefined}
      {easingOpen && current ? (
        <EasingEditor
          value={current.timing || 'ease'}
          onClose={() => setEasingOpen(false)}
          onChange={(timing) => patch({ timing }, { live: false })}
        />
      ) : undefined}
    </div>
  );
}

// ─────────────── Box shadows (layered box-shadow, mirrors text-shadow) ───────────────

const BOX_SHADOW_TYPES: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'outset', label: 'Outside' },
  { value: 'inset', label: 'Inside' },
];

// The per-shadow editor: Type (Outside/Inside) + X/Y/Blur/Size length rows + Color —
// the same components the text-shadow editor uses.
function BoxShadowEditor({
  shadow,
  busy,
  onChange,
}: {
  shadow: BoxShadow;
  busy: boolean;
  onChange: (patch: BoxShadowPatch, live: boolean) => void;
}) {
  return (
    <div className="embed-editor_type-shadow-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
        <SegmentedControl
          value={shadow.inset ? 'inset' : 'outset'}
          options={BOX_SHADOW_TYPES}
          onChange={(next) => onChange({ inset: next === 'inset' }, false)}
          ariaLabel="Shadow type"
          disabled={busy}
        />
      </div>
      <ShadowLength
        label="X"
        value={shadow.x}
        busy={busy}
        onCommit={(next) => onChange({ x: next }, false)}
        onLive={(next) => onChange({ x: next }, true)}
      />
      <ShadowLength
        label="Y"
        value={shadow.y}
        busy={busy}
        onCommit={(next) => onChange({ y: next }, false)}
        onLive={(next) => onChange({ y: next }, true)}
      />
      <ShadowLength
        label="Blur"
        value={shadow.blur}
        busy={busy}
        onCommit={(next) => onChange({ blur: next }, false)}
        onLive={(next) => onChange({ blur: next }, true)}
      />
      <ShadowLength
        label="Size"
        value={shadow.spread}
        busy={busy}
        onCommit={(next) => onChange({ spread: next }, false)}
        onLive={(next) => onChange({ spread: next }, true)}
      />
      <ShadowColorRow
        color={shadow.color}
        busy={busy}
        onChange={(color, live) => onChange({ color: color }, live)}
      />
    </div>
  );
}

// The transparency checkerboard drawn beneath each box-shadow layer's color preview.
const BOX_SHADOW_PREVIEW_CHECKERBOARD =
  'conic-gradient(#8883 25%, transparent 0 50%, #8883 0 75%, transparent 0) 0 0 / 10px 10px';

// The box-shadow stack: header + add, a reorderable/removable layer list, and the
// per-shadow editor in a popup — the same layer + component functionality as text-shadow.
function BoxShadowsRow({ props }: { props: Props }) {
  const { read, busy } = props;
  const display = displayOf(read('box-shadow'));
  const rows = parseHideable(display.present ? display.value : '', ',', parseBoxShadows);
  const shadows = rows.map((row) => row.item);
  const write = (next: Array<Hideable<BoxShadow>>, options: WriteOptions) =>
    writeValue('box-shadow', serializeHideable(next, ',', serializeBoxShadows), options, props);
  const stack = useLayerRows({ rows, blank: blankBoxShadow, write });
  const { openIndex } = stack;
  const openShadow = openIndex === undefined ? undefined : shadows[openIndex];
  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label="Box shadows" prop="box-shadow" props={props} />
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={stack.add}
          disabled={busy}
          title="Add a shadow"
          aria-label="Add a box shadow"
        >
          <PlusIcon />
        </button>
      </div>
      <LayerList
        count={shadows.length}
        busy={busy}
        ariaLabel="Box shadows"
        onOpen={stack.open}
        onReorder={stack.reorder}
        onRemove={stack.remove}
        isHidden={stack.isHidden}
        onToggleHidden={stack.toggle}
        renderRow={(i) => boxShadowRow(shadows, i)}
      />
      {openIndex !== undefined && stack.anchorElement && openShadow ? (
        <LayerPopover anchorEl={stack.anchorElement} ariaLabel="Box shadow" onClose={stack.close}>
          <BoxShadowEditor
            shadow={openShadow}
            busy={busy}
            onChange={(patch, live) =>
              stack.update(openIndex, { live }, (item) => ({ ...item, ...patch }))
            }
          />
        </LayerPopover>
      ) : undefined}
    </div>
  );
}

// A row of the box-shadow list: its colour over a transparency checkerboard, and its
// label.
function boxShadowRow(shadows: BoxShadow[], i: number) {
  const shadow = shadows[i];
  if (shadow === undefined) {
    throw new Error(`Box shadow ${i} is missing`);
  }
  return {
    preview: (
      <span
        className="embed-editor_bg-layer-preview"
        style={{
          background:
            `linear-gradient(${shadow.color}, ${shadow.color}), ` + BOX_SHADOW_PREVIEW_CHECKERBOARD,
        }}
        aria-hidden="true"
      />
    ),
    label: boxShadowLabel(shadow),
  };
}

// ─────────────────────────── Section ───────────────────────────

// ─────────────────────────── Clip path ───────────────────────────

// The full clip-path editor is large (~340 KB); lazy-load it so it only enters the
// bundle when the popup opens. It's fully self-contained (reads the selected element
// and writes `clip-path` to its native class style itself — no props).
const ClipPathEditor = lazy(() => import('./clipPath/ClipPath'));

const ClipCloseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const ClipEditIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M10.5 2.5 13.5 5.5 6 13l-3.5.5L3 10l7.5-7.5Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

const CLIP_GLYPH_SHAPE_PATH =
  'M8 .5c.4 4.3 2.8 6.8 7.5 7.5-4.7.7-7.1 3.2-7.5 7.5-.4-4.3-2.8-6.8-7.5-7.5' +
  'C5.2 7.3 7.6 4.8 8 .5Z';

// Canonical shape glyphs mirroring the editor's preset picker, so the trigger reads at
// a glance. Local (not imported from the editor) to keep that module out of the bundle.
function ClipGlyph({ type }: { type: string }) {
  const cls = 'embed-editor_clip-trigger-glyph';
  switch (type) {
    case 'None':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 12 12 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'Polygon':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" />
        </svg>
      );
    case 'Inset':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" rx="2.5" fill="currentColor" />
        </svg>
      );
    case 'Circle':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="4.75" fill="currentColor" />
        </svg>
      );
    case 'Ellipse':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <ellipse cx="8" cy="8" rx="6" ry="4.25" fill="currentColor" />
        </svg>
      );
    case 'Shape':
      return (
        <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
          <path d={CLIP_GLYPH_SHAPE_PATH} fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2.5 8Q5 4 8 8T13.5 8"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

// A cheap classifier for the trigger label — names the shape without pulling the huge
// editor module (and its full parser) into the main bundle.
function clipPathType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'none') {
    return 'None';
  }
  if (normalized.startsWith('polygon')) {
    return 'Polygon';
  }
  if (normalized.startsWith('circle')) {
    return 'Circle';
  }
  if (normalized.startsWith('ellipse')) {
    return 'Ellipse';
  }
  if (
    normalized.startsWith('inset') ||
    normalized.startsWith('rect') ||
    normalized.startsWith('xywh')
  ) {
    return 'Inset';
  }
  if (normalized.startsWith('path')) {
    return 'Path';
  }
  if (normalized.startsWith('shape')) {
    return 'Shape';
  }
  if (normalized.startsWith('url')) {
    return 'SVG';
  }
  if (normalized.startsWith('var')) {
    return 'Variable';
  }
  return 'Custom';
}

// The editor in a full-panel modal, portaled to <body> and rendered at the panel's
// own scale (it used to re-apply moden's compact zoom — see embedEditor.css). The
// editor's clip-path writes are routed to the panel's selected selector via
// setProp/clearProp (so its own class picker is hidden).
function ClipPathModal({ props, onClose }: { props: Props; onClose: () => void }) {
  const { onApply, onClear } = useSettledClipPath(props);
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
        className="embed-editor_clip-modal u-surface-page"
        role="dialog"
        aria-modal="true"
        aria-label="Clip path"
      >
        <div className="embed-editor_clip-modal-head">
          <span className="embed-editor_clip-modal-title">Clip path</span>
          <div className="embed-editor_clip-modal-actions">
            {/* Portal target for the editor's shortcut-help control (it renders nothing
                when this is absent). Provided here since it's no longer a hosted tool. */}
            <div id="clip-path_header-shortcuts" />
            <button
              type="button"
              className="embed-editor_bg-modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              <ClipCloseIcon />
            </button>
          </div>
        </div>
        <div className="embed-editor_clip-modal-body">
          <Suspense fallback={<div className="embed-editor_clip-loading">Loading editor…</div>}>
            <ClipPathEditor onApply={onApply} onClear={onClear} hideClassPicker />
          </Suspense>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Stream fast previews as the shape is dragged; commit authoritatively (with the
// panel's native→embed fallback) once edits settle, so a drag doesn't fire a read-back
// per frame. Any un-committed edit is flushed when the popup closes before it settles.
function useSettledClipPath({ setProp, liveSetProp, clearProp }: Props) {
  const pending = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const commit = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (pending.current !== undefined) {
      setProp('clip-path', pending.current, false);
      pending.current = undefined;
    }
  };
  // The unmount flush calls the latest render's commit, through a ref, so the effect
  // runs once.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => () => commitRef.current(), []);
  const onApply = (value: string) => {
    liveSetProp('clip-path', value, false);
    pending.current = value;
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(commit, 350);
  };
  const onClear = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    pending.current = undefined;
    clearProp('clip-path');
  };
  return { onApply, onClear };
}

// The Clip row: the label (blue/clear/provenance like every other prop) + a button
// showing the current clip-path type. Clicking opens the visual editor popup.
function ClipPathRow({ props }: { props: Props }) {
  const { read, busy } = props;
  const display = displayOf(read('clip-path'));
  const raw = display.present ? display.value : displayOf(read('-webkit-clip-path')).value;
  const [open, setOpen] = useState(false);
  const type = clipPathType(raw);
  return (
    <div className="embed-editor_size-row">
      <EffLabel label="Clip" prop="clip-path" props={props} />
      <button
        type="button"
        className="embed-editor_clip-trigger"
        disabled={busy}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="embed-editor_clip-trigger-type">
          <ClipGlyph type={type} />
          <span className="embed-editor_clip-trigger-label">{type}</span>
        </span>
        <ClipEditIcon />
      </button>
      {open ? <ClipPathModal props={props} onClose={() => setOpen(false)} /> : undefined}
    </div>
  );
}

export default function EffectsSection(props: Props) {
  const { read, busy, setProp } = props;
  const events = displayOf(read('pointer-events'));

  return (
    <div className="embed-editor_size embed-editor_effects">
      <PresetSelectRow
        prop="mix-blend-mode"
        label="Blending"
        options={BLEND_MODES}
        presets={BLEND_SET}
        fallback="normal"
        placeholder="mix-blend-mode"
        props={props}
      />

      <OpacityRow props={props} />
      <OutlineRows props={props} />

      <BoxShadowsRow props={props} />
      <TransformsRow props={props} />
      <TransitionsRow props={props} />
      <FiltersRow prop="filter" label="Filters" props={props} />
      <FiltersRow prop="backdrop-filter" label="Backdrop filters" props={props} />

      <ClipPathRow props={props} />

      <PresetSelectRow
        prop="cursor"
        label="Cursor"
        options={CURSORS}
        presets={CURSOR_SET}
        fallback="auto"
        placeholder="cursor"
        props={props}
        allowCustom={false}
      />

      <div className="embed-editor_size-row">
        <EffLabel label="Events" prop="pointer-events" props={props} />
        <SegmentedField
          value={events.present ? events.value : ''}
          important={events.important}
          options={EVENTS_OPTIONS}
          prop="pointer-events"
          fallback="auto"
          busy={busy}
          onCommit={(next, imp) => setProp('pointer-events', next, imp)}
          ariaLabel="Pointer events"
        />
      </div>
    </div>
  );
}

// Outline: its style, width and offset, and colour.
function OutlineRows({ props }: { props: Props }) {
  const { read, busy, setProp } = props;
  const outline = displayOf(read('outline-style'));
  const outlineColor = displayOf(read('outline-color'));
  return (
    <>
      <div className="embed-editor_size-row">
        <EffLabel label="Outline" prop="outline-style" props={props} />
        <SegmentedField
          value={outline.present ? outline.value : ''}
          important={outline.important}
          options={OUTLINE_OPTIONS}
          prop="outline-style"
          fallback="none"
          busy={busy}
          onCommit={(next, imp) => setProp('outline-style', next, imp)}
          ariaLabel="Outline style"
        />
      </div>
      <div className="embed-editor_size-row">
        <EffLabel label="Width" prop="outline-width" props={props} />
        <div className="embed-editor_eff-outline-pair">
          <LiveText prop="outline-width" placeholder="0" props={props} />
          <EffLabel label="Offset" prop="outline-offset" props={props} />
          <LiveText prop="outline-offset" placeholder="0" props={props} />
        </div>
      </div>
      <div className="embed-editor_size-row">
        <EffLabel label="Color" prop="outline-color" props={props} />
        <div className="embed-editor_bg-inline">
          <OutlineColor props={props} value={outlineColor.present ? outlineColor.value : ''} />
        </div>
      </div>
    </>
  );
}
