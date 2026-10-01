import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useFieldDraft } from './lib/field-draft';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/PropTip';
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl';
import Select from './components/Select';
import useScrub, { type ScrubHandlers } from './components/useScrub';
import { handleArrowStep } from './lib/number-step';
import ProvenanceList from './ProvenanceList';
import {
  blankLayer,
  colorOverlayImage,
  colorOverlayOf,
  layerKind,
  layerLabel,
  parseLayers,
  serializeLayers,
  splitBackgroundShorthand,
  splitTopLevelSpaces,
  type BgLayer,
  type LayerKind,
} from './lib/background';
import LayerList from './LayerList';
import VariableConnect from './VariableConnect';
import {
  blankGradientOf,
  parseGradient,
  serializeGradient,
  type GradientType,
} from './lib/gradient';
import { requestAsset } from '../ui/assetPick';
import { assetValueFor } from '../ui/assetPath';
import { sourceCandidates } from '../ui/AssetThumb';
import { getHost } from './lib/host';
import GradientEditor from './GradientEditor';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './lib/live-color';
import type { Contributor, ResolvedProp } from './lib/resolved';
import { commitInPlace } from './lib/commit-in-place';

// The Backgrounds section — Webflow parity. `background` is a stack of layers
// (images + gradients) painted over a single background-color. The layer list
// reorders / adds / removes / edits layers; each layer edit re-serializes the
// five comma-separated longhands (see lib/background). Color and Clipping are
// single-value controls. Everything is driven by the resolved model (blue when
// the picked selector sets it, orange via another selector, clear menu, etc.).
//
// Deferred (still editable as raw text where relevant): the asset picker for
// images and a visual gradient editor — a layer's value is edited as its CSS.

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

// How a write lands: live while typing or dragging, or committed.
interface WriteOptions {
  readonly live: boolean;
}

// The layers with one layer's fields replaced.
function replaceLayer<K extends keyof BgLayer>(
  layers: BgLayer[],
  index: number,
  patch: Pick<BgLayer, K>,
): BgLayer[] {
  return layers.map((layer, i) => (i === index ? { ...layer, ...patch } : layer));
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

// A field's draft: it mirrors external edits, but never clobbers what the user is
// typing (while `focused` holds).
function useExternalDraft(external: string) {
  const [draft, setDraft] = useState(external);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(external);
    }
  }, [external]);
  return { draft, setDraft, focused };
}

// Debounces live writes while typing: the text reaches `liveNow` 100ms after the last
// keystroke; `cancelLive` drops a pending one.
function useLiveTimer(liveNow: (text: string) => void) {
  const liveTimer = useRef<number | undefined>(undefined);
  const cancelLive = () => {
    if (liveTimer.current !== undefined) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = undefined;
    }
  };
  useEffect(() => cancelLive, []);
  const scheduleLive = (text: string) => {
    cancelLive();
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = undefined;
      liveNow(text);
    }, 100);
  };
  return { scheduleLive, cancelLive };
}

// ─────────────────────────── Shared label ───────────────────────────

function BgLabel({
  label,
  prop,
  d: display,
  contributors,
  busy,
  scrubProps,
  onClear,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  d: Display;
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
          onSelect={(selector, selectedProp) => {
            onSelectSelector(selector, selectedProp);
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

// A live text field bound to one property (Color, and inside the layer editor).
function BgField({
  prop,
  label,
  placeholder,
  prefix,
  swatchLabel,
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
  prefix?: ReactNode;
  /** Render a colour swatch before the field, editing this same property. Owned
   *  here rather than passed in as `prefix` so a drag on it shows in the field. */
  swatchLabel?: string;
} & Props) {
  const display = displayOf(read(prop));
  const external = display.present
    ? display.important
      ? `${display.value} !important`
      : display.value
    : '';
  const field = useBgFieldEditing({ prop, external, busy, setProp, clearProp, liveSetProp });
  const input = <BgFieldInput prop={prop} label={label} placeholder={placeholder} field={field} />;
  const swatch = swatchLabel ? (
    <ColorSwatch
      value={field.shown}
      busy={busy}
      ariaLabel={swatchLabel}
      onChange={(color, live) => field.swatchChange(color, { live })}
    />
  ) : undefined;
  const before = swatch ?? prefix;

  return (
    <>
      <BgLabel
        label={label}
        prop={prop}
        d={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        scrubProps={field.scrub.label}
        onClear={() => {
          field.cleared();
          clearProp(prop);
        }}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      {before ? (
        <div className="embed-editor_bg-inline">
          {before}
          {input}
        </div>
      ) : (
        input
      )}
    </>
  );
}

type BgFieldEditing = ReturnType<typeof useBgFieldEditing>;

// The field's own handlers, spread onto the input after the scrub's: typing drops any
// live swatch colour and schedules a live write, blur commits, ↑/↓ step in place.
function bgInputHandlers({
  focusedRef,
  noteLive,
  setDraft,
  scheduleLive,
  cancelLive,
  commit,
}: {
  focusedRef: React.MutableRefObject<boolean>;
  noteLive: ReturnType<typeof useLiveColor>[1];
  setDraft: (draft: string) => void;
  scheduleLive: (text: string) => void;
  cancelLive: () => void;
  commit: () => void;
}) {
  return {
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      noteLive(undefined);
      setDraft(event.target.value);
      scheduleLive(event.target.value);
    },
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: () => {
      focusedRef.current = false;
      cancelLive();
      commit();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepInPlace(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        scheduleLive(stepped);
      }
    },
  };
}

// The field's editing state: the draft (and a live colour drag shown over it), live
// writes 100ms after typing stops (undelayed for the scrub, which throttles its own —
// see useScrub), and the commit on blur, which clears the property when emptied.
function useBgFieldEditing({
  prop,
  external,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: Pick<Props, 'busy' | 'setProp' | 'clearProp' | 'liveSetProp'> & {
  prop: string;
  external: string;
}) {
  const { draft, setDraft, focused, cleared } = useFieldDraft(external, { busy });
  const [shown, noteLive] = useLiveColor(draft);
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const parsed = parseImportant(trimmed);
    liveSetProp(prop, parsed.value, parsed.important);
  };
  const { scheduleLive, cancelLive } = useLiveTimer(liveNow);
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
  const inputHandlers = bgInputHandlers({
    focusedRef: focused,
    noteLive,
    setDraft,
    scheduleLive,
    cancelLive,
    commit,
  });
  const pick = (binding: string) => setProp(prop, binding, false);
  // Show a swatch drag in the field as it happens; the model only hears about it when
  // the drag ends, and only then is `shown` handed back to it.
  const swatchChange = (color: string, options: WriteOptions) => {
    noteLive(options.live ? color : undefined);
    if (options.live) {
      liveSetProp(prop, color, false);
      return;
    }
    setDraft(color);
    setProp(prop, color, false);
  };
  return { busy, shown, cleared, scrub, inputHandlers, pick, swatchChange };
}

function BgFieldInput({
  prop,
  label,
  placeholder,
  field,
}: {
  prop: string;
  label: string;
  placeholder: string;
  field: BgFieldEditing;
}) {
  return (
    <VariableConnect
      code
      ariaLabel={`Connect ${label} to a variable`}
      disabled={field.busy}
      prop={prop}
      onPick={field.pick}
    >
      <input
        {...field.scrub.input}
        className="u-input embed-editor_size-input"
        data-prop={prop}
        value={field.shown}
        {...field.inputHandlers}
        disabled={field.busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
      />
    </VariableConnect>
  );
}

// ─────────────────────────── Icons ───────────────────────────

const PlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

// The layer editor lives in a full-width popup over the panel (dark backdrop),
// rather than expanding inline. Portaled to <body> so it escapes the panel's
// clipping / stacking; closes on backdrop click or Escape. No header — the rows
// (label left / control right, divider-separated) run edge to edge like Webflow.
function LayerEditorModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
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
        className="embed-editor_bg-modal u-surface-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Background layer"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ─────────────────────────── Layer editor ───────────────────────────

// A field bound to one longhand of one layer. Recomputes that longhand's whole
// comma list from `layers` (with the edit applied) and writes it live / on blur.
function LayerLonghandField({
  field,
  prop,
  label,
  placeholder,
  ...fieldProps
}: LayerFieldProps & {
  field: keyof BgLayer;
  prop: string;
  label: string;
  placeholder: string;
}) {
  const { layers, index, busy, setProp } = fieldProps;
  const { draft, setDraft, focused } = useExternalDraft(layers[index]?.[field] ?? '');

  const commit = (options: WriteOptions, text = draft) => {
    const trimmed = text.trim();
    const next = layers.map((layer, i) => (i === index ? { ...layer, [field]: trimmed } : layer));
    const list = serializeLayers(next)[field === 'image' ? 'image' : field];
    writeLayerList(prop, list, options, fieldProps);
  };
  const commitScrub = (text: string) => {
    setDraft(text);
    commit({ live: false }, text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: (text) => commit({ live: true }, text),
    onCommit: commitScrub,
  });

  return (
    <VariableConnect
      code
      ariaLabel={`Connect ${label} to a variable`}
      disabled={busy}
      prop={prop}
      onPick={(binding) => setProp(prop, binding, false)}
    >
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          commit({ live: true }, event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit({ live: false });
        }}
        onKeyDown={(event) => {
          const stepped = stepInPlace(event);
          if (stepped !== undefined) {
            setDraft(stepped);
          }
        }}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
      />
    </VariableConnect>
  );
}

// Write one longhand's whole comma list: live writes skip an empty list; a committed
// empty list clears the property.
function writeLayerList(
  prop: string,
  list: string,
  options: WriteOptions,
  writers: Pick<LayerFieldProps, 'setProp' | 'clearProp' | 'liveSetProp'>,
) {
  if (options.live) {
    if (list) {
      writers.liveSetProp(prop, list, false);
    }
    return;
  }
  if (list) {
    writers.setProp(prop, list, false);
  } else {
    writers.clearProp(prop);
  }
}

const BACKGROUND_IMAGE_ICON_FIRST_PATH =
  'M6 7C6.55228 7 7 6.55228 7 6C7 5.44772 6.55228 5 6 5C5.44772 5 5 5.44772 5 6' +
  'C5 6.55228 5.44772 7 6 7Z';
const BACKGROUND_IMAGE_ICON_SECOND_PATH =
  'M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3' +
  'C2.44772 14 2 13.5523 2 13V3ZM13 3L3 3V12.2929L8 7.29289L13 12.2929V3ZM8 8.70711' +
  'L12.2929 13H3.70711L8 8.70711Z';

// Layer-type icons (Webflow's), currentColor-driven. Gradient icons use a useId
// gradient id so multiple instances never collide.
function BgImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={BACKGROUND_IMAGE_ICON_FIRST_PATH} fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={BACKGROUND_IMAGE_ICON_SECOND_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const BACKGROUND_LINEAR_ICON_PATH =
  'M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3' +
  'C2.44772 14 2 13.5523 2 13V3Z';

function BgLinearIcon() {
  const id = useId();
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={BACKGROUND_LINEAR_ICON_PATH} fill={`url(#${id})`} />
      <defs>
        <linearGradient id={id} x1="14" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
const BACKGROUND_RADIAL_ICON_PATH =
  'M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3' +
  'C2.44772 14 2 13.5523 2 13V3Z';

function BgRadialIcon() {
  const id = useId();
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={BACKGROUND_RADIAL_ICON_PATH} fill={`url(#${id})`} />
      <defs>
        <radialGradient
          id={id}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(8 8) rotate(90) scale(6)"
        >
          <stop stopColor="currentColor" stopOpacity="0" />
          <stop offset="0.166246" stopColor="currentColor" stopOpacity="0" />
          <stop offset="1" stopColor="currentColor" />
        </radialGradient>
      </defs>
    </svg>
  );
}
const BACKGROUND_COLOR_ICON_PATH =
  'M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3' +
  'C2.44772 14 2 13.5523 2 13V3Z';

function BgColorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={BACKGROUND_COLOR_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

const TYPE_OPTIONS: ReadonlyArray<SegmentedOption<LayerKind>> = [
  { value: 'image', label: <BgImageIcon />, ariaLabel: 'Image', tooltip: 'Image' },
  {
    value: 'linear',
    label: <BgLinearIcon />,
    ariaLabel: 'Linear gradient',
    tooltip: 'Linear gradient',
  },
  {
    value: 'radial',
    label: <BgRadialIcon />,
    ariaLabel: 'Radial gradient',
    tooltip: 'Radial gradient',
  },
  { value: 'color', label: <BgColorIcon />, ariaLabel: 'Color overlay', tooltip: 'Color overlay' },
];

type LayerFieldProps = {
  layers: BgLayer[];
  index: number;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
};

// A small draft input (live-as-you-type + commit-on-blur) for one part of a compound
// longhand (Size's width/height, Position's left/top). The parent maps the part back
// into the full comma list; this just owns the field's local text + arrow-stepping.
function BgPartInput({
  value,
  placeholder,
  label,
  busy,
  disabled,
  onLive,
  onCommit,
}: {
  value: string;
  placeholder: string;
  label: string;
  busy: boolean;
  disabled?: boolean;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const { draft, setDraft, focused } = useExternalDraft(value);
  const commitScrub = (text: string) => {
    setDraft(text);
    onCommit(text.trim());
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy || disabled === true,
    onPreview: setDraft,
    onInput: (text) => onLive(text.trim()),
    onCommit: commitScrub,
  });
  return (
    <input
      {...scrub.input}
      className={`u-input embed-editor_size-input ${disabled ? 'is-inactive' : ''}`}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      disabled={busy || disabled}
      spellCheck={false}
      onChange={(event) => {
        setDraft(event.target.value);
        onLive(event.target.value.trim());
      }}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        onCommit(draft.trim());
      }}
      onKeyDown={(event) => {
        const stepped = stepInPlace(event);
        if (stepped !== undefined) {
          setDraft(stepped);
          onLive(stepped.trim());
        }
      }}
    />
  );
}

// Size: Custom | Cover | Contain, with Width/Height when Custom.
type SizeMode = 'custom' | 'cover' | 'contain';
function parseSize(size: string): { mode: SizeMode; width: string; height: string } {
  const normalized = size.trim().toLowerCase();
  if (normalized === 'cover') {
    return { mode: 'cover', width: '', height: '' };
  }
  if (normalized === 'contain') {
    return { mode: 'contain', width: '', height: '' };
  }
  const parts = splitTopLevelSpaces(size.trim());
  return { mode: 'custom', width: parts[0] ?? '', height: parts[1] ?? '' };
}
function serializeSize(mode: SizeMode, width: string, height: string): string {
  if (mode === 'cover') {
    return 'cover';
  }
  if (mode === 'contain') {
    return 'contain';
  }
  const widthPart = width.trim();
  const heightPart = height.trim();
  if (!widthPart && !heightPart) {
    return '';
  }
  return `${widthPart || 'auto'} ${heightPart || 'auto'}`;
}
const SIZE_MODE_OPTIONS: ReadonlyArray<SegmentedOption<SizeMode>> = [
  { value: 'custom', label: 'Custom' },
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
];
function LayerSizeField({ layers, index, busy, setProp, clearProp, liveSetProp }: LayerFieldProps) {
  const parsed = parseSize(layers[index]?.size ?? '');
  const writeSize = (value: string, options: WriteOptions) => {
    const list = serializeLayers(replaceLayer(layers, index, { size: value })).size;
    writeLayerList('background-size', list, options, { setProp, clearProp, liveSetProp });
  };
  // Cover / Contain size the image for you, so the Width/Height fields stay visible
  // but disabled (Webflow parity) — showing "Auto" since neither axis is authored.
  const isCustom = parsed.mode === 'custom';
  return (
    <div className="embed-editor_bg-stack">
      <SegmentedControl
        options={SIZE_MODE_OPTIONS}
        value={parsed.mode}
        onChange={(mode) =>
          writeSize(serializeSize(mode, parsed.width, parsed.height), { live: false })
        }
        ariaLabel="Background size"
        disabled={busy}
      />
      <div className="embed-editor_bg-pair">
        <label className="embed-editor_bg-pair-field">
          <BgPartInput
            value={parsed.width}
            placeholder="Auto"
            label="Width"
            busy={busy}
            disabled={!isCustom}
            onLive={(next) =>
              writeSize(serializeSize('custom', next, parsed.height), { live: true })
            }
            onCommit={(next) =>
              writeSize(serializeSize('custom', next, parsed.height), { live: false })
            }
          />
          <span className="embed-editor_bg-pair-cap">Width</span>
        </label>
        <label className="embed-editor_bg-pair-field">
          <BgPartInput
            value={parsed.height}
            placeholder="Auto"
            label="Height"
            busy={busy}
            disabled={!isCustom}
            onLive={(next) =>
              writeSize(serializeSize('custom', parsed.width, next), { live: true })
            }
            onCommit={(next) =>
              writeSize(serializeSize('custom', parsed.width, next), { live: false })
            }
          />
          <span className="embed-editor_bg-pair-cap">Height</span>
        </label>
      </div>
    </div>
  );
}

// Position: a 3×3 preset grid + Left/Top offsets.
function axisIndex(token: string): number {
  const normalized = token.trim().toLowerCase();
  if (
    normalized === '' ||
    normalized === 'left' ||
    normalized === 'top' ||
    normalized === '0' ||
    normalized === '0%' ||
    normalized === '0px'
  ) {
    return 0;
  }
  if (normalized === 'center' || normalized === '50%') {
    return 1;
  }
  if (normalized === 'right' || normalized === 'bottom' || normalized === '100%') {
    return 2;
  }
  return -1;
}
const AXIS_PERCENTS = ['0%', '50%', '100%'];
function LayerPositionField({
  layers,
  index,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: LayerFieldProps) {
  const parts = splitTopLevelSpaces((layers[index]?.position ?? '').trim());
  const x = parts[0] ?? '';
  const y = parts[1] ?? '';
  const writePosition = (value: string, options: WriteOptions) => {
    const list = serializeLayers(replaceLayer(layers, index, { position: value })).position;
    writeLayerList('background-position', list, options, { setProp, clearProp, liveSetProp });
  };
  const offset = (left: string, top: string) => `${left || '0%'} ${top || '0%'}`;
  return (
    <div className="embed-editor_bg-position">
      <PositionPresets x={x} y={y} busy={busy} writePosition={writePosition} />
      <div className="embed-editor_bg-posfields">
        <label className="embed-editor_bg-posfield">
          <span className="embed-editor_bg-posfield-cap">Left</span>
          <BgPartInput
            value={x}
            placeholder="0px"
            label="Left"
            busy={busy}
            onLive={(next) => writePosition(offset(next, y), { live: true })}
            onCommit={(next) => writePosition(next || y ? offset(next, y) : '', { live: false })}
          />
        </label>
        <label className="embed-editor_bg-posfield">
          <span className="embed-editor_bg-posfield-cap">Top</span>
          <BgPartInput
            value={y}
            placeholder="0px"
            label="Top"
            busy={busy}
            onLive={(next) => writePosition(offset(x, next), { live: true })}
            onCommit={(next) => writePosition(x || next ? offset(x, next) : '', { live: false })}
          />
        </label>
      </div>
    </div>
  );
}

// The 3×3 preset grid: left / center / right × top / center / bottom.
function PositionPresets({
  x,
  y,
  busy,
  writePosition,
}: {
  x: string;
  y: string;
  busy: boolean;
  writePosition: (value: string, options: WriteOptions) => void;
}) {
  const activeCol = axisIndex(x);
  const activeRow = axisIndex(y);
  return (
    <div className="embed-editor_bg-posgrid" role="group" aria-label="Position preset">
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((col) => (
          <button
            key={`${row}-${col}`}
            type="button"
            className={
              'embed-editor_bg-poscell ' +
              (activeCol === col && activeRow === row ? 'is-active' : '')
            }
            disabled={busy}
            aria-label={`${['Left', 'Center', 'Right'][col]} ${['top', 'center', 'bottom'][row]}`}
            onClick={() =>
              writePosition(`${AXIS_PERCENTS[col]} ${AXIS_PERCENTS[row]}`, { live: false })
            }
          />
        )),
      )}
    </div>
  );
}

// Tile (background-repeat) + Fixed (background-attachment).
const TileAllIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </svg>
);
const TileXIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="1" y="5.5" width="4" height="5" rx="1" />
    <rect x="6" y="5.5" width="4" height="5" rx="1" />
    <rect x="11" y="5.5" width="4" height="5" rx="1" />
  </svg>
);
const TileYIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="5.5" y="1" width="5" height="4" rx="1" />
    <rect x="5.5" y="6" width="5" height="4" rx="1" />
    <rect x="5.5" y="11" width="5" height="4" rx="1" />
  </svg>
);
const TileNoneIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
const TILE_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'repeat', label: <TileAllIcon />, ariaLabel: 'Tile', tooltip: 'Tile' },
  { value: 'repeat-x', label: <TileXIcon />, ariaLabel: 'Tile horizontally', tooltip: 'Tile X' },
  { value: 'repeat-y', label: <TileYIcon />, ariaLabel: 'Tile vertically', tooltip: 'Tile Y' },
  { value: 'no-repeat', label: <TileNoneIcon />, ariaLabel: 'No tile', tooltip: 'None' },
];
const FIXED_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'scroll', label: 'Not fixed' },
];

// Image: thumbnail + name + dimensions + Choose image (asset picker).
function imageUrlOf(image: string): string | undefined {
  const match = image.match(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/i);
  return match?.[1];
}

// Where on disk a CSS url points.
//
// A background's url is written for the SITE — `/lumos-background.svg` is
// served out of public/ by the dev server. The style panel is not the site: it
// runs in the app's own window, on the app's own origin, where that path is a
// 404 and every preview came up empty.
//
// The path is worked out rather than looked up. There is no list of the
// project's assets in the style panel (`host.files` is the STYLESHEETS), and
// fetching one would make a thumbnail wait on a round trip. A root-relative
// url is public/ or it is the project root, so both are offered and the img
// falls through to the next when one does not load — the same fallback
// AssetThumb already uses for its two url schemes.
function assetSourceCandidates(url: string | undefined): string[] {
  if (!url) {
    return [];
  }
  const clean = url.split(/[?#]/)[0] ?? '';
  // Hosted elsewhere, or inline: not a file, and shown from where it points.
  if (/^(https?:)?\/\//.test(clean) || clean.startsWith('data:')) {
    return [clean];
  }
  const root = getHost().projectPath;
  if (!root) {
    return [clean];
  }
  const rel = clean.replace(/^\/+/, '');
  const base = root.replace(/[\\/]+$/, '');
  // public/ first: a leading-slash url is nearly always served from there.
  // The project root second, which is where `/src/...` lands.
  return [`${base}/public/${rel}`, `${base}/${rel}`].flatMap((abs) => sourceCandidates(abs));
}

// An <img> that works through a list of sources until one loads.
function FallbackImg({
  srcs,
  alt = '',
  onLoad,
}: {
  srcs: string[];
  alt?: string;
  onLoad?: (size: { w: number; h: number }) => void;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  // A new list starts again from its first source.
  const sourcesKey = srcs.join('|');
  useEffect(() => {
    setSourceIndex(0);
  }, [sourcesKey]);
  if (!srcs.length || sourceIndex >= srcs.length) {
    return undefined;
  }
  return (
    <img
      src={srcs[sourceIndex]}
      alt={alt}
      draggable={false}
      onLoad={(event) =>
        onLoad?.({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })
      }
      onError={() => setSourceIndex((previous) => previous + 1)}
    />
  );
}

function LayerImageField({
  layers,
  index,
  busy,
  applyLayers,
}: {
  layers: BgLayer[];
  index: number;
  busy: boolean;
  applyLayers: (layers: BgLayer[]) => void;
}) {
  const image = layers[index]?.image ?? '';
  const url = imageUrlOf(image);
  const name = url ? (url.split('?')[0] ?? '').split(/[\\/]/).pop() || url : '';
  const [dims, setDims] = useState('');
  const srcs = assetSourceCandidates(url);
  useEffect(() => {
    setDims('');
  }, [url]);
  const pick = (assetUrl: string) => {
    applyLayers(replaceLayer(layers, index, { image: `url("${assetUrl}")` }));
  };
  return (
    <div className="embed-editor_bg-image">
      <div className="embed-editor_bg-image-row">
        <span className="embed-editor_bg-thumb">
          <FallbackImg srcs={srcs} onLoad={(size) => setDims(`${size.w} × ${size.h}`)} />
        </span>
        <div className="embed-editor_bg-image-meta">
          <span className="embed-editor_bg-image-name" title={url ?? ''}>
            {name || 'No image'}
          </span>
          {dims ? <span className="embed-editor_bg-image-dim">{dims}</span> : undefined}
        </div>
      </div>
      {/* Asks the Assets panel, the same way every other "Choose…" in the app
          does (see assetPick.js). A grid of thumbnails crammed into a 320px
          style panel could show a handful at a time and had none of what makes
          the real panel usable — search, folders, uploading — so picking a
          background meant a different, worse version of a thing the app
          already had. */}
      <button
        type="button"
        className="u-button is-small embed-editor_bg-choose"
        disabled={busy}
        onClick={() =>
          requestAsset({
            mediaKind: 'image',
            current: url ?? '',
            onPick: (pickedRel: string) => pick(assetValueFor(pickedRel)),
          })
        }
      >
        {url ? 'Replace image…' : 'Choose image…'}
      </button>
    </div>
  );
}

// A colour field that reads/writes a color-overlay layer (a solid-fill gradient).
function LayerColorField({
  layers,
  index,
  busy,
  setProp,
  liveSetProp,
}: {
  layers: BgLayer[];
  index: number;
  busy: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
}) {
  const { draft, setDraft, focused } = useExternalDraft(
    colorOverlayOf(layers[index]?.image ?? '') ?? '',
  );

  const listFor = (color: string): string =>
    serializeLayers(replaceLayer(layers, index, { image: colorOverlayImage(color) })).image;
  // An empty colour writes the overlay's default tint.
  const write = (color: string, options: WriteOptions) => {
    const value = listFor(color.trim() || 'rgba(0, 0, 0, 0.5)');
    if (options.live) {
      liveSetProp('background-image', value, false);
    } else {
      setProp('background-image', value, false);
    }
  };

  return (
    <div className="embed-editor_bg-inline">
      <ColorSwatch
        value={draft}
        busy={busy}
        ariaLabel="Overlay color"
        onChange={(color, live) => {
          setDraft(color);
          write(color, { live });
        }}
      />
      <VariableConnect
        ariaLabel="Connect overlay color to a variable"
        disabled={busy}
        className="is-fill"
        prop="background-color"
        onPick={(binding) => {
          setDraft(binding);
          setProp('background-image', listFor(binding), false);
        }}
      >
        <OverlayColorInput
          draft={draft}
          busy={busy}
          focusedRef={focused}
          setDraft={setDraft}
          write={write}
        />
      </VariableConnect>
    </div>
  );
}

type LayerEditorProps = LayerFieldProps & { applyLayers: (layers: BgLayer[]) => void };

// The overlay colour as text. A keystroke live-writes the draft as it stood before that
// keystroke; blur commits the draft.
function OverlayColorInput({
  draft,
  busy,
  focusedRef,
  setDraft,
  write,
}: {
  draft: string;
  busy: boolean;
  focusedRef: React.MutableRefObject<boolean>;
  setDraft: (draft: string) => void;
  write: (color: string, options: WriteOptions) => void;
}) {
  return (
    <input
      className="u-input embed-editor_size-input"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        write(draft, { live: true });
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        write(draft, { live: false });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commitInPlace(event.currentTarget);
        }
      }}
      disabled={busy}
      spellCheck={false}
      placeholder="rgba(0, 0, 0, 0.5)"
      aria-label="Overlay color"
    />
  );
}

function LayerEditor(props: LayerEditorProps) {
  const { layers, index, busy, setProp, liveSetProp } = props;
  const layer = layers[index];
  if (!layer) {
    return undefined;
  }
  const kind = layerKind(layer.image);
  const displayKind = displayKindOf(kind);
  const typeRow = (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
      <SegmentedControl
        options={TYPE_OPTIONS}
        value={displayKind}
        onChange={(next) => setLayerKind({ next, displayKind, props })}
        ariaLabel="Layer type"
        disabled={busy}
      />
    </div>
  );

  // A colour overlay is a solid fill — just Type + Colour (no size/position/tile).
  if (displayKind === 'color') {
    return (
      <div className="embed-editor_bg-editor">
        {typeRow}
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Color</span>
          <LayerColorField
            layers={layers}
            index={index}
            busy={busy}
            setProp={setProp}
            liveSetProp={liveSetProp}
          />
        </div>
      </div>
    );
  }

  // A gradient layer gets Webflow's visual editor (position grid, size presets,
  // stops bar, repeat) — its Size/Position edit the gradient's INTERNAL geometry,
  // not the background-size/position longhands. A gradient we can't parse falls
  // back to the raw text fields below.
  const isGradient = kind === 'linear' || kind === 'radial' || kind === 'conic';
  const gradient = isGradient ? parseGradient(layer.image) : undefined;
  const writeImage = (image: string, options: WriteOptions) => {
    const list = serializeLayers(replaceLayer(layers, index, { image })).image;
    if (options.live) {
      liveSetProp('background-image', list, false);
    } else {
      setProp('background-image', list, false);
    }
  };

  return (
    <div className="embed-editor_bg-editor">
      {typeRow}
      {gradient ? (
        <GradientEditor
          gradient={gradient}
          busy={busy}
          onChange={(next, live) => writeImage(serializeGradient(next), { live })}
        />
      ) : (
        <LayerRawFields displayKind={displayKind} props={props} />
      )}
      {/* Tile (background-repeat) + Fixed (background-attachment) apply to image
          layers only — Webflow omits them for gradients (which have their own
          repeat toggle inside the gradient editor). */}
      {!isGradient ? <LayerTileFields layer={layer} props={props} /> : undefined}
    </div>
  );
}

// The Type buttons show four kinds; a conic/unknown value maps to the nearest.
function displayKindOf(kind: ReturnType<typeof layerKind>): LayerKind {
  if (kind === 'color' || kind === 'linear' || kind === 'radial') {
    return kind;
  }
  return kind === 'conic' ? 'linear' : 'image';
}

const isGradientType = (value: LayerKind): value is GradientType =>
  value === 'linear' || value === 'radial' || value === 'conic';

// Switch a layer's kind. Switching between gradient kinds keeps the colours.
//
// The stops are the work — picked, positioned, adjusted — and the kind is just how
// they are painted. Seeding a blank layer threw them away, so trying radial to see how
// it looked cost the whole gradient and there was no way back to it.
//
// The geometry does NOT carry, because it does not mean the same thing: an angle is a
// direction for a linear gradient and nothing at all for a radial one, and a centre
// point is the reverse. Each kind starts on its own defaults and keeps the colours.
function setLayerKind({
  next,
  displayKind,
  props,
}: {
  next: LayerKind;
  displayKind: LayerKind;
  props: LayerEditorProps;
}) {
  const { layers, index, applyLayers } = props;
  const layer = layers[index];
  if (next === displayKind || layer === undefined) {
    return;
  }
  if (isGradientType(next) && isGradientType(displayKind)) {
    const current = parseGradient(layer.image);
    if (current?.stops?.length) {
      const carried = serializeGradient({
        ...blankGradientOf(next),
        repeating: current.repeating,
        stops: current.stops,
      });
      applyLayers(replaceLayer(layers, index, { image: carried }));
      return;
    }
  }
  const seeded = blankLayer(next);
  applyLayers(replaceLayer(layers, index, { image: seeded.image }));
}

// An image layer's picker, or an unparsed gradient's raw text; then Size and Position.
function LayerRawFields({
  displayKind,
  props,
}: {
  displayKind: LayerKind;
  props: LayerEditorProps;
}) {
  const { applyLayers, ...fieldProps } = props;
  return (
    <>
      <div className="embed-editor_size-row embed-editor_bg-row-top">
        <span className="embed-editor_size-label embed-editor_bg-caption">
          {displayKind === 'image' ? 'Image' : 'Gradient'}
        </span>
        {displayKind === 'image' ? (
          <LayerImageField
            layers={fieldProps.layers}
            index={fieldProps.index}
            busy={fieldProps.busy}
            applyLayers={applyLayers}
          />
        ) : (
          <LayerLonghandField
            {...fieldProps}
            field="image"
            prop="background-image"
            label="Layer value"
            placeholder="gradient(…)"
          />
        )}
      </div>
      <div className="embed-editor_size-row embed-editor_bg-row-top">
        <span className="embed-editor_size-label embed-editor_bg-caption">Size</span>
        <LayerSizeField {...fieldProps} />
      </div>
      <div className="embed-editor_size-row embed-editor_bg-row-top">
        <span className="embed-editor_size-label embed-editor_bg-caption">Position</span>
        <LayerPositionField {...fieldProps} />
      </div>
    </>
  );
}

// Tile (background-repeat) and Fixed (background-attachment); each default is written
// as an empty value.
function LayerTileFields({ layer, props }: { layer: BgLayer; props: LayerEditorProps }) {
  const { layers, index, busy, applyLayers } = props;
  return (
    <>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Tile</span>
        <SegmentedControl
          options={TILE_OPTIONS}
          value={
            ['repeat-x', 'repeat-y', 'no-repeat'].includes(layer.repeat.trim())
              ? layer.repeat.trim()
              : 'repeat'
          }
          onChange={(next) =>
            applyLayers(replaceLayer(layers, index, { repeat: next === 'repeat' ? '' : next }))
          }
          ariaLabel="Layer tile"
          disabled={busy}
        />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Fixed</span>
        <SegmentedControl
          options={FIXED_OPTIONS}
          value={layer.attachment.trim() === 'fixed' ? 'fixed' : 'scroll'}
          onChange={(next) =>
            applyLayers(replaceLayer(layers, index, { attachment: next === 'scroll' ? '' : next }))
          }
          ariaLabel="Layer fixed"
          disabled={busy}
        />
      </div>
    </>
  );
}

// ─────────────────────────── Section ───────────────────────────

export default function BackgroundSection(props: Props) {
  const { read, busy, setProp, clearProp, onProvenance, onSelectSelector } = props;
  const stack = useLayerStack(props);
  const { layers, applyLayers, openLayer, setOpenLayer } = stack;
  return (
    <div className="embed-editor_size embed-editor_background">
      {/* Image & gradient — the layer stack (top layer first). */}
      <div className="embed-editor_bg-layers-head">
        <BgLabel
          label="Image & gradient"
          prop="background-image"
          d={displayOf(read('background-image'))}
          contributors={read('background-image')?.contributors ?? []}
          busy={busy}
          onClear={() => applyLayers([])}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={stack.addLayer}
          disabled={busy}
          title="Add a layer"
          aria-label="Add a background layer"
        >
          <PlusIcon />
        </button>
      </div>

      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel="Background layers"
        onOpen={(i) => setOpenLayer((current) => (current === i ? undefined : i))}
        onReorder={stack.reorder}
        onRemove={stack.removeLayer}
        renderRow={(i) => layerRow(layers, i)}
      />

      {openLayer !== undefined && layers[openLayer] ? (
        <LayerEditorModal onClose={() => setOpenLayer(undefined)}>
          <LayerEditor
            layers={layers}
            index={openLayer}
            busy={busy}
            setProp={setProp}
            clearProp={clearProp}
            liveSetProp={props.liveSetProp}
            applyLayers={applyLayers}
          />
        </LayerEditorModal>
      ) : undefined}

      {/* Colour — painted behind every layer. */}
      <div className="embed-editor_size-row">
        <BgField
          {...props}
          prop="background-color"
          label="Color"
          placeholder="transparent"
          swatchLabel="Background color"
        />
      </div>

      <ClippingRow {...props} />
    </div>
  );
}

// Clipping — background-clip. "None" writes border-box explicitly.
function ClippingRow(props: Props) {
  const { read, busy, setProp, clearProp } = props;
  const clipDisplay = displayOf(read('background-clip'));
  const clip = clipDisplay.present ? clipDisplay.value.trim() : 'border-box';
  return (
    <div className="embed-editor_size-row">
      <BgLabel
        label="Clipping"
        prop="background-clip"
        d={clipDisplay}
        contributors={read('background-clip')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('background-clip')}
        onProvenance={props.onProvenance}
        onSelectSelector={props.onSelectSelector}
      />
      <Select
        value={clip}
        options={CLIP_OPTIONS}
        onChange={(next) => setProp('background-clip', next, false)}
        onPreview={(next) => props.liveSetProp('background-clip', next ?? undefined, false)}
        ariaLabel="Background clipping"
        disabled={busy}
      />
    </div>
  );
}

const CLIP_OPTIONS = [
  { value: 'border-box', label: 'None' },
  { value: 'padding-box', label: 'Clip background to padding' },
  { value: 'content-box', label: 'Clip background to content' },
  { value: 'text', label: 'Clip background to text' },
];

// A row of the layer list: its thumbnail and its label.
function layerRow(layers: BgLayer[], i: number) {
  const layer = layers[i];
  if (layer === undefined) {
    throw new Error(`Background layer ${i} is missing`);
  }
  return { preview: <LayerPreview image={layer.image} />, label: layerLabel(layer.image) };
}

// A layer's thumbnail in the list.
function LayerPreview({ image }: { image: string }) {
  const url = imageUrlOf(image);
  // A gradient is CSS this window paints as it stands.
  if (!url) {
    return (
      <span
        className="embed-editor_bg-layer-preview"
        style={{
          background: image,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
        aria-hidden="true"
      />
    );
  }
  // An image comes off disk, and through an <img> rather than a CSS
  // background — the file can be reached by more than one url scheme
  // and only an element can try the next one when the first does not
  // load. A background that fails just paints nothing, with no way to
  // tell that from an image that is genuinely blank.
  return (
    <span className="embed-editor_bg-layer-preview is-image" aria-hidden="true">
      <FallbackImg srcs={assetSourceCandidates(url)} />
    </span>
  );
}

// The layer stack, which layer's editor is open, and the edits that write the stack
// back to the longhands.
function useLayerStack({ read, setProp, clearProp }: Props) {
  const valueOf = (prop: string) => displayOf(read(prop)).value;

  // Prefer the individual longhands; if the background is set via the `background`
  // SHORTHAND (Webflow emits it that way after adding a colour-overlay layer), fall
  // back to parsing that so the layers still load. Editing then migrates to
  // longhands (the shorthand is cleared) so writes are unambiguous.
  const rawImage = valueOf('background-image').trim();
  const shorthand = valueOf('background').trim();
  const fromShorthand = (!rawImage || rawImage.toLowerCase() === 'none') && !!shorthand;
  const longhands = fromShorthand
    ? splitBackgroundShorthand(shorthand)
    : {
        image: valueOf('background-image'),
        size: valueOf('background-size'),
        position: valueOf('background-position'),
        repeat: valueOf('background-repeat'),
        attachment: valueOf('background-attachment'),
        color: '',
      };
  const layers = parseLayers(longhands);

  // When sourced from the shorthand, replace it: clear `background` and preserve its
  // colour into background-color.
  const applyLayers = (next: BgLayer[]) => {
    writeLonghands(serializeLayers(next), { read, setProp, clearProp });
    if (fromShorthand) {
      clearProp('background');
      if (longhands.color && !valueOf('background-color').trim()) {
        setProp('background-color', longhands.color, false);
      }
    }
  };

  const [openLayer, setOpenLayer] = useState<number | undefined>(undefined);
  const addLayer = () => {
    // Default a new layer to an image (Webflow parity) — switch to a gradient via Type.
    applyLayers([blankLayer('image'), ...layers]);
    setOpenLayer(0);
  };
  const removeLayer = (index: number) => {
    applyLayers(layers.filter((_, i) => i !== index));
    setOpenLayer((current) => openAfterRemoval(current, index));
  };
  const reorder = (from: number, to: number) => {
    if (from === to) {
      return;
    }
    const next = [...layers];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) {
      return;
    }
    next.splice(to, 0, moved);
    applyLayers(next);
    setOpenLayer((current) => (current === from ? to : current));
  };
  return { layers, applyLayers, openLayer, setOpenLayer, addLayer, removeLayer, reorder };
}

// Write the stack back to the five longhands, but only those whose value actually
// changed on the picked selector. Each setProp/clearProp is a separate native op that
// toggles busy + re-reads from Webflow, so rewriting all five longhands on every change
// flashes the panel and echoes unchanged values back to Webflow.
function writeLonghands(
  serialized: ReturnType<typeof serializeLayers>,
  { read, setProp, clearProp }: Pick<Props, 'read' | 'setProp' | 'clearProp'>,
) {
  // The value the PICKED selector itself sets for `prop` (undefined when it doesn't set
  // it — a value inherited from another selector doesn't count).
  const ownValue = (prop: string): string | undefined => {
    const display = displayOf(read(prop));
    return display.present && display.isSelected ? display.value.trim() : undefined;
  };
  const write = (prop: string, value: string) => {
    const own = ownValue(prop);
    const trimmed = value.trim();
    if (trimmed) {
      if (own !== trimmed) {
        setProp(prop, trimmed, false);
      }
    } else if (own !== undefined) {
      clearProp(prop);
    }
  };
  write('background-image', serialized.image);
  write('background-size', serialized.size);
  write('background-position', serialized.position);
  write('background-repeat', serialized.repeat);
  write('background-attachment', serialized.attachment);
}

// The open editor after removing layer `removed`: closed if it was that layer's,
// shifted down one if it was a later layer's.
function openAfterRemoval(open: number | undefined, removed: number): number | undefined {
  if (open === undefined) {
    return undefined;
  }
  if (open === removed) {
    return undefined;
  }
  return open > removed ? open - 1 : open;
}
