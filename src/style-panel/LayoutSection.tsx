import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useGapHover, type GapAxis } from './lib/gap-hover';
import FieldLabel from './components/FieldLabel';
import Select, { type SelectOption } from './components/Select';
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl';
import useScrub from './components/useScrub';
import DisplayControl from './DisplayControl';
import VariableConnect from './VariableConnect';
import { handleArrowStep } from './lib/number-step';
import { cap, readProp } from './lib/prop-read';
import type { ParsedRule } from './lib/types';
import { splitTopLevelSpaces } from './lib/background';

// The Layout section of the style panel. The Display control is always shown;
// the rest (flex vs grid controls) conditionally appears based on the current
// `display` value. Every control is addressed by property name and reads the
// live declaration each render (declIds regenerate on every rebuild).

type SetProp = (prop: string, value: string, important: boolean) => void;
type ClearProp = (prop: string | string[]) => void;
type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;

type Props = {
  rule: ParsedRule;
  busy: boolean;
  onSetProp: SetProp;
  onClearProp: ClearProp;
  onLiveSetProp: LiveSetProp;
};

// Nicer labels for the enumerated values; anything else is capitalized.
const LABELS: Record<string, string> = {
  'flex-start': 'Start',
  'flex-end': 'End',
  'space-between': 'Space between',
  'space-around': 'Space around',
  'space-evenly': 'Space evenly',
  start: 'Start',
  end: 'End',
  center: 'Center',
  stretch: 'Stretch',
  baseline: 'Baseline',
  nowrap: 'No wrap',
  wrap: 'Wrap',
  'wrap-reverse': 'Wrap reverse',
};
const optionLabel = (value: string) => LABELS[value] ?? cap(value);

const WRAP = ['nowrap', 'wrap', 'wrap-reverse'];
const JUSTIFY_FLEX = [
  'flex-start',
  'center',
  'flex-end',
  'space-between',
  'space-around',
  'space-evenly',
];
const ALIGN_FLEX = ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'];
const JUSTIFY_GRID = ['stretch', 'start', 'center', 'end'];

const FLEX_DIRECTION: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'row', label: '→', ariaLabel: 'Row' },
  { value: 'column', label: '↓', ariaLabel: 'Column' },
  { value: 'row-reverse', label: '←', ariaLabel: 'Row reverse' },
  { value: 'column-reverse', label: '↑', ariaLabel: 'Column reverse' },
];
const GRID_FLOW: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'row', label: '→', ariaLabel: 'Rows' },
  { value: 'column', label: '↓', ariaLabel: 'Columns' },
];

function buildOptions(known: string[], current: string): SelectOption<string>[] {
  const options: SelectOption<string>[] = [
    { value: '', label: '—' },
    ...known.map((value) => ({ value, label: optionLabel(value) })),
  ];
  if (current && !known.includes(current)) {
    options.push({ value: current, label: current });
  }
  return options;
}

function SelectRow({
  rule,
  busy,
  prop,
  label,
  values,
  onSetProp,
  onClearProp,
  onLiveSetProp,
}: {
  rule: ParsedRule;
  busy: boolean;
  prop: string;
  label: string;
  values: string[];
  onSetProp: SetProp;
  onClearProp: ClearProp;
  onLiveSetProp: LiveSetProp;
}) {
  const found = readProp(rule, prop);
  const current = found ? found.value.trim().toLowerCase() : '';
  return (
    <div className="embed-editor_size-row">
      <FieldLabel
        className="embed-editor_size-label"
        active={Boolean(found)}
        disabled={busy}
        onReset={() => onClearProp(prop)}
        resetLabel="Clear"
      >
        {label}
      </FieldLabel>
      <Select
        value={current}
        options={buildOptions(values, current)}
        ariaLabel={label}
        disabled={busy}
        onChange={(choice) => (choice ? onSetProp(prop, choice, false) : onClearProp(prop))}
        onPreview={(choice) => onLiveSetProp(prop, choice || undefined, false)}
      />
    </div>
  );
}

function SegRow({
  rule,
  busy,
  prop,
  label,
  options,
  onSetProp,
  onClearProp,
}: {
  rule: ParsedRule;
  busy: boolean;
  prop: string;
  label: string;
  options: ReadonlyArray<SegmentedOption<string>>;
  onSetProp: SetProp;
  onClearProp: ClearProp;
}) {
  const found = readProp(rule, prop);
  const value = found ? found.value.trim().toLowerCase() : '';
  return (
    <div className="embed-editor_size-row">
      <FieldLabel
        className="embed-editor_size-label"
        active={Boolean(found)}
        disabled={busy}
        onReset={() => onClearProp(prop)}
        resetLabel="Clear"
      >
        {label}
      </FieldLabel>
      <SegmentedControl
        value={value}
        options={options}
        ariaLabel={label}
        onChange={(choice) => onSetProp(prop, choice, false)}
      />
    </div>
  );
}

// ─────────────────────────── Gap ───────────────────────────

function LockedIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6" rx="1.5" fill="currentColor" />
      <path
        d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
function UnlockedIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6" rx="1.5" fill="currentColor" />
      <path
        d="M5.5 7V5.2a2.5 2.5 0 0 1 4.9-.6"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Split a `gap` value into its row / column parts. One token → both equal (a
// linked gap); two tokens → `gap: <row> <column>` per the CSS shorthand.
function parseGap(value: string): { row: string; column: string } {
  const parts = splitTopLevelSpaces(value).filter(Boolean);
  if (parts.length === 0) {
    return { row: '', column: '' };
  }
  if (parts.length === 1) {
    return { row: parts[0] ?? '', column: parts[0] ?? '' };
  }
  return { row: parts[0] ?? '', column: parts[1] ?? '' };
}

// A length field with live-as-you-type updates, a commit on blur, and ↑/↓ number
// stepping — the shared gap-cell input (mirrors PropField, minus the property binding).
type GapInputProps = {
  value: string;
  busy: boolean;
  ariaLabel: string;
  /** Which spaces on the page this field holds open — see gap-hover.ts. */
  axes: GapAxis[];
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
};
function GapInput({ value, busy, ariaLabel, axes, onLive, onCommit }: GapInputProps) {
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const { cancelLive, scheduleLive } = useDebouncedLive(onLive);
  const gapHover = useGapHover(axes, draft || value);
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
    <VariableConnect
      ariaLabel={`Connect ${ariaLabel} to a variable`}
      disabled={busy}
      className="is-fill"
      prop="gap"
      onPick={(binding) => onCommit(binding)}
    >
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          scheduleLive(event.target.value);
          gapHover.onValue(event.target.value);
        }}
        {...gapHover.handlers}
        onFocus={() => {
          focused.current = true;
          gapHover.onFocus();
        }}
        onBlur={() => {
          focused.current = false;
          gapHover.onBlur();
          cancelLive();
          onCommit(draft);
        }}
        onKeyDown={(event) => {
          const stepped = stepGapKey(event);
          if (stepped !== undefined) {
            setDraft(stepped);
            scheduleLive(stepped);
          }
        }}
        disabled={busy}
        spellCheck={false}
        placeholder="0"
        aria-label={ariaLabel}
      />
    </VariableConnect>
  );
}

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

// Live previews on a debounce, so typing a value does not write every keystroke.
function useDebouncedLive(onLive: (value: string) => void) {
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
      onLive(text);
    }, 100);
  };
  return { cancelLive, scheduleLive };
}

// Enter commits by blurring; an arrow key steps the number under the caret and
// writes it straight into the input. Returns the stepped text, if any.
function stepGapKey(event: KeyboardEvent<HTMLInputElement>): string | undefined {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
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

// The Gap control: a lock toggle plus one field (linked → `gap: 2rem`) or two
// fields (unlinked → `gap: 2rem 3rem`, i.e. `gap: <row> <column>`). The link
// state derives from the value (equal parts = linked) but the user can override it.
function GapControl({
  rule,
  busy,
  onSetProp,
  onClearProp,
  onLiveSetProp,
}: {
  rule: ParsedRule;
  busy: boolean;
  onSetProp: SetProp;
  onClearProp: ClearProp;
  onLiveSetProp: LiveSetProp;
}) {
  const found = readProp(rule, 'gap');
  const value = found ? found.value.trim() : '';
  const { row, column } = parseGap(value);
  const [linkOverride, setLinkOverride] = useState<boolean | undefined>(undefined);
  const linked = linkOverride ?? row === column;

  // A blank value clears the gap on commit and previews nothing while live.
  const write = (next: string, mode: WriteMode) => {
    if (!next) {
      if (mode === 'commit') {
        onClearProp('gap');
      }
      return;
    }
    (mode === 'live' ? onLiveSetProp : onSetProp)('gap', next, false);
  };

  const toggleLink = () => {
    if (linked) {
      setLinkOverride(false);
      return;
    }
    setLinkOverride(true);
    const single = row || column;
    if (single) {
      onSetProp('gap', single, false);
    } else {
      onClearProp('gap');
    }
  };

  return (
    <div className="embed-editor_size-row">
      <FieldLabel
        className="embed-editor_size-label"
        active={Boolean(found)}
        disabled={busy}
        onReset={() => {
          setLinkOverride(undefined);
          onClearProp('gap');
        }}
        resetLabel="Clear"
      >
        Gap
      </FieldLabel>
      <div className="embed-editor_gap">
        <GapFields linked={linked} row={row} column={column} busy={busy} write={write} />
        <GapLinkButton linked={linked} busy={busy} onToggle={toggleLink} />
      </div>
    </div>
  );
}

// Whether a gap write is a live preview or the committed value.
type WriteMode = 'live' | 'commit';

// One field for a linked gap, or a column field and a row field for a split one.
function GapFields({
  linked,
  row,
  column,
  busy,
  write,
}: {
  linked: boolean;
  row: string;
  column: string;
  busy: boolean;
  write: (next: string, mode: WriteMode) => void;
}) {
  if (linked) {
    return (
      <GapInput
        value={row}
        busy={busy}
        ariaLabel="Gap"
        axes={['row', 'column']}
        onLive={(next) => write(next.trim(), 'live')}
        onCommit={(next) => write(next.trim(), 'commit')}
      />
    );
  }
  return (
    <>
      <div className="embed-editor_gap-cell">
        <GapInput
          value={column}
          busy={busy}
          ariaLabel="Column gap"
          axes={['column']}
          onLive={(next) => write(splitGap(row, next), 'live')}
          onCommit={(next) => write(splitGap(row, next), 'commit')}
        />
        <span className="embed-editor_gap-caption">Columns</span>
      </div>
      <div className="embed-editor_gap-cell">
        <GapInput
          value={row}
          busy={busy}
          ariaLabel="Row gap"
          axes={['row']}
          onLive={(next) => write(splitGap(next, column), 'live')}
          onCommit={(next) => write(splitGap(next, column), 'commit')}
        />
        <span className="embed-editor_gap-caption">Rows</span>
      </div>
    </>
  );
}

// `gap: <row> <column>`, with a blank side written as 0; blank when both are.
function splitGap(row: string, column: string): string {
  if (!row.trim() && !column.trim()) {
    return '';
  }
  return `${row.trim() || '0'} ${column.trim() || '0'}`;
}

// The lock that links or unlinks the row and column gaps.
function GapLinkButton({
  linked,
  busy,
  onToggle,
}: {
  linked: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`embed-editor_icon-btn embed-editor_gap-link ${linked ? 'is-active' : ''}`}
      disabled={busy}
      aria-pressed={linked}
      title={
        linked ? 'Linked — one gap for rows and columns' : 'Unlinked — separate row and column gaps'
      }
      onClick={onToggle}
    >
      {linked ? <LockedIcon /> : <UnlockedIcon />}
    </button>
  );
}

// ─────────────────────────── Grid ───────────────────────────

// justify-content / align-content values (how the TRACKS distribute in the container).
const GRID_CONTENT = [
  'start',
  'center',
  'end',
  'stretch',
  'space-between',
  'space-around',
  'space-evenly',
];

// Split a grid-template track list on TOP-LEVEL whitespace so repeat(…)/minmax(…)
// and [line-name] tokens stay intact.
function splitTracks(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value.trim()) {
    if (ch === '(' || ch === '[') {
      depth += 1;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}
// The number of tracks a grid-template value defines — expands `repeat(n, …)` and
// ignores [line-name] tokens. 0 when unset / none.
function countTracks(value: string): number {
  const text = value.trim().toLowerCase();
  if (!text || text === 'none') {
    return 0;
  }
  let count = 0;
  for (const track of splitTracks(text)) {
    if (track.startsWith('[')) {
      continue;
    }
    const rep = track.match(/^repeat\(\s*(\d+)\s*,(.*)\)$/i);
    if (rep) {
      count +=
        parseInt(rep[1] ?? '0', 10) *
        Math.max(1, splitTracks(rep[2] ?? '').filter((x) => !x.startsWith('[')).length);
    } else {
      count += 1;
    }
  }
  return count;
}
// The count stepper writes N UNIFORM tracks of the axis default — every column is
// minmax(0px, 1fr) (fills its share but can shrink to nothing so content can't overflow),
// every row is auto (content-sized). The min needs a unit (`0px`, not bare `0`) or Webflow
// reads the whole grid-template as a custom value. Mirrors GridControls' count stepper.
const NEW_COLUMN = 'minmax(0px, 1fr)';
const NEW_ROW = 'auto';
const uniformTracks = (count: number, fill: string) =>
  Array.from({ length: Math.max(0, count) }, () => fill).join(' ');

// grid-auto-flow is a direction (row | column) optionally packed `dense`.
type Flow = { direction: string; dense: boolean };
function parseFlow(value: string): Flow {
  const text = value.toLowerCase();
  return { direction: text.includes('column') ? 'column' : 'row', dense: text.includes('dense') };
}
const buildFlow = ({ direction, dense }: Flow) => (dense ? `${direction} dense` : direction);

const ChevUp = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="12" height="12">
    <path
      d="M4.6 9.4 8 6l3.4 3.4"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const ChevDown = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="12" height="12">
    <path
      d="M4.6 6.6 8 10l3.4-3.4"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const DENSE_ICON_FIRST_PATH =
  'M14.8535 11.1465 14.1465 11.8535 12.5 10.207V14H11.5v-3.793' +
  'L9.85352 11.8535 9.14648 11.1465 12 8.29297 14.8535 11.1465Z';
const DENSE_ICON_SECOND_PATH =
  'M14.1025 1.005C14.6067 1.056 15 1.482 15 2v4l-.005.103c-.048.47-.422.844-.892.892L14 7h-4' +
  'c-.518 0-.944-.393-.995-.897L9 6V2c0-.552.448-1 1-1h4l.103.005ZM10 6h4V2h-4v4Z';
const DENSE_ICON_FOURTH_PATH =
  'M7.103 1.005C7.607 1.056 8 1.482 8 2v4l-.005.103c-.048.47-.422.844-.892.892L7 7H3' +
  'c-.518 0-.944-.393-.995-.897L2 6V2c0-.552.448-1 1-1h4l.103.005ZM3 6h4V2H3v4Z';

const DenseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <path d={DENSE_ICON_FIRST_PATH} fill="currentColor" />
    <path fillRule="evenodd" clipRule="evenodd" d={DENSE_ICON_SECOND_PATH} fill="currentColor" />
    <path
      opacity="0.4"
      d="M9 9H3v4h6v1H3l-.103-.005c-.47-.048-.844-.422-.892-.892L2 13V9c0-.552.448-1 1-1h6v1Z"
      fill="currentColor"
    />
    <path
      opacity="0.4"
      fillRule="evenodd"
      clipRule="evenodd"
      d={DENSE_ICON_FOURTH_PATH}
      fill="currentColor"
    />
  </svg>
);

// A whole-number track-count field with ▲▼ steppers (Webflow's Columns/Rows inputs).
function CountField({
  value,
  busy,
  ariaLabel,
  onCommit,
}: {
  value: number;
  busy: boolean;
  ariaLabel: string;
  onCommit: (count: number) => void;
}) {
  const [text, setText] = useState(value > 0 ? String(value) : '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(value > 0 ? String(value) : '');
    }
  }, [value]);
  const commit = (typed: string) => {
    const count = parseInt(typed, 10);
    if (Number.isNaN(count)) {
      setText(value > 0 ? String(value) : '');
      return;
    }
    onCommit(clampCount(count));
  };
  const step = (delta: number) => onCommit(clampCount((value || 0) + delta));
  return (
    <div className="embed-editor_grid-count">
      <input
        className="u-input embed-editor_size-input"
        value={text}
        inputMode="numeric"
        spellCheck={false}
        disabled={busy}
        aria-label={ariaLabel}
        placeholder="0"
        onChange={(event) => setText(event.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit(text);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            step(1);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            step(-1);
          }
        }}
      />
      <CountSteppers busy={busy} onStep={step} />
    </div>
  );
}

// A track count is at least one and at most 500 — past that the grid is a
// mistake, not a layout.
const clampCount = (count: number) => Math.min(500, Math.max(1, count));

// The ▲▼ buttons beside a count field; out of the tab order, like Webflow's.
function CountSteppers({ busy, onStep }: { busy: boolean; onStep: (delta: number) => void }) {
  return (
    <div className="embed-editor_grid-count-steppers">
      <button
        type="button"
        tabIndex={-1}
        disabled={busy}
        aria-label="Increase"
        onClick={() => onStep(1)}
      >
        <ChevUp />
      </button>
      <button
        type="button"
        tabIndex={-1}
        disabled={busy}
        aria-label="Decrease"
        onClick={() => onStep(-1)}
      >
        <ChevDown />
      </button>
    </div>
  );
}

// Columns + Rows track counts. Each count writes N equal `1fr` tracks; the wrench
// track editor (custom sizing) isn't built yet — use the value field for that.
function GridTracksRow({
  rule,
  busy,
  onSetProp,
  onClearProp,
}: {
  rule: ParsedRule;
  busy: boolean;
  onSetProp: SetProp;
  onClearProp: ClearProp;
}) {
  const colsFound = readProp(rule, 'grid-template-columns');
  const rowsFound = readProp(rule, 'grid-template-rows');
  const cols = colsFound ? countTracks(colsFound.value) : 0;
  const rows = rowsFound ? countTracks(rowsFound.value) : 0;
  return (
    <div className="embed-editor_size-row embed-editor_bg-row-top">
      <FieldLabel
        className="embed-editor_size-label"
        active={Boolean(colsFound || rowsFound)}
        disabled={busy}
        onReset={() => onClearProp(['grid-template-columns', 'grid-template-rows'])}
        resetLabel="Clear"
      >
        Grid
      </FieldLabel>
      <div className="embed-editor_grid-tracks">
        <div className="embed-editor_gap-cell">
          <CountField
            value={cols}
            busy={busy}
            ariaLabel="Grid columns"
            onCommit={(count) =>
              onSetProp('grid-template-columns', uniformTracks(count, NEW_COLUMN), false)
            }
          />
          <span className="embed-editor_gap-caption">Columns</span>
        </div>
        <div className="embed-editor_gap-cell">
          <CountField
            value={rows}
            busy={busy}
            ariaLabel="Grid rows"
            onCommit={(count) =>
              onSetProp('grid-template-rows', uniformTracks(count, NEW_ROW), false)
            }
          />
          <span className="embed-editor_gap-caption">Rows</span>
        </div>
      </div>
    </div>
  );
}

// grid-auto-flow: a row/column segmented control + a `dense` toggle.
function GridDirectionRow({
  rule,
  busy,
  onSetProp,
  onClearProp,
}: {
  rule: ParsedRule;
  busy: boolean;
  onSetProp: SetProp;
  onClearProp: ClearProp;
}) {
  const found = readProp(rule, 'grid-auto-flow');
  const { direction, dense } = found ? parseFlow(found.value) : { direction: 'row', dense: false };
  return (
    <div className="embed-editor_size-row">
      <FieldLabel
        className="embed-editor_size-label"
        active={Boolean(found)}
        disabled={busy}
        onReset={() => onClearProp('grid-auto-flow')}
        resetLabel="Clear"
      >
        Direction
      </FieldLabel>
      <div className="embed-editor_grid-direction">
        <SegmentedControl
          value={direction}
          options={GRID_FLOW}
          ariaLabel="Grid direction"
          disabled={busy}
          onChange={(next) =>
            onSetProp('grid-auto-flow', buildFlow({ direction: next, dense }), false)
          }
        />
        <button
          type="button"
          className={`embed-editor_icon-btn ${dense ? 'is-active' : ''}`}
          disabled={busy}
          aria-pressed={dense}
          title="Dense — backfill earlier gaps in the grid"
          onClick={() =>
            onSetProp('grid-auto-flow', buildFlow({ direction, dense: !dense }), false)
          }
        >
          <DenseIcon />
        </button>
      </div>
    </div>
  );
}

// Item alignment inside cells: X = justify-items, Y = align-items.
function GridAlignRow({
  rule,
  busy,
  onSetProp,
  onClearProp,
  onLiveSetProp,
}: {
  rule: ParsedRule;
  busy: boolean;
  onSetProp: SetProp;
  onClearProp: ClearProp;
  onLiveSetProp: LiveSetProp;
}) {
  const ji = readProp(rule, 'justify-items');
  const ai = readProp(rule, 'align-items');
  const axis = (axisLabel: string, prop: string) => {
    const found = readProp(rule, prop);
    const current = found ? found.value.trim().toLowerCase() : '';
    return (
      <div className="embed-editor_grid-axis">
        <span className="embed-editor_grid-axis-label">{axisLabel}</span>
        <Select
          value={current}
          options={buildOptions(JUSTIFY_GRID, current)}
          ariaLabel={`Align ${axisLabel}`}
          disabled={busy}
          onChange={(choice) => (choice ? onSetProp(prop, choice, false) : onClearProp(prop))}
          onPreview={(choice) => onLiveSetProp(prop, choice || undefined, false)}
        />
      </div>
    );
  };
  return (
    <div className="embed-editor_size-row embed-editor_bg-row-top">
      <FieldLabel
        className="embed-editor_size-label"
        active={Boolean(ji || ai)}
        disabled={busy}
        onReset={() => onClearProp(['justify-items', 'align-items'])}
        resetLabel="Clear"
      >
        Align
      </FieldLabel>
      <div className="embed-editor_grid-align">
        {axis('X', 'justify-items')}
        {axis('Y', 'align-items')}
      </div>
    </div>
  );
}

export default function LayoutSection({
  rule,
  busy,
  onSetProp,
  onClearProp,
  onLiveSetProp,
}: Props) {
  const displayFound = readProp(rule, 'display');
  const display = displayFound ? displayFound.value.trim().toLowerCase() : '';
  const isFlex = display === 'flex' || display === 'inline-flex';
  const isGrid = display === 'grid' || display === 'inline-grid';
  const rowProps = { rule, busy, onSetProp, onClearProp, onLiveSetProp };

  return (
    <div className="embed-editor_layout">
      {/* Display — always shown. */}
      <div className="embed-editor_size-row">
        <FieldLabel
          className="embed-editor_size-label"
          active={Boolean(displayFound)}
          disabled={busy}
          onReset={() => onClearProp('display')}
          resetLabel="Clear"
        >
          Display
        </FieldLabel>
        <DisplayControl
          value={displayFound?.value ?? ''}
          important={displayFound?.important ?? false}
          busy={busy}
          onCommit={(value, important) => onSetProp('display', value, important)}
        />
      </div>
      {isFlex ? <FlexRows {...rowProps} /> : undefined}
      {isGrid ? <GridRows {...rowProps} /> : undefined}
    </div>
  );
}

// The flex container's controls.
function FlexRows(props: Props) {
  return (
    <>
      <SegRow
        rule={props.rule}
        busy={props.busy}
        prop="flex-direction"
        label="Direction"
        options={FLEX_DIRECTION}
        onSetProp={props.onSetProp}
        onClearProp={props.onClearProp}
      />
      <SelectRow {...props} prop="flex-wrap" label="Wrap" values={WRAP} />
      <SelectRow {...props} prop="justify-content" label="Justify" values={JUSTIFY_FLEX} />
      <SelectRow {...props} prop="align-items" label="Align" values={ALIGN_FLEX} />
      <GapControl {...props} />
    </>
  );
}

// The grid container's controls.
function GridRows(props: Props) {
  return (
    <>
      <GridTracksRow
        rule={props.rule}
        busy={props.busy}
        onSetProp={props.onSetProp}
        onClearProp={props.onClearProp}
      />
      <GridDirectionRow
        rule={props.rule}
        busy={props.busy}
        onSetProp={props.onSetProp}
        onClearProp={props.onClearProp}
      />
      <GridAlignRow {...props} />
      <GapControl {...props} />
      <SelectRow {...props} prop="justify-content" label="Justify content" values={GRID_CONTENT} />
      <SelectRow {...props} prop="align-content" label="Align content" values={GRID_CONTENT} />
    </>
  );
}
