import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import FieldLabel from './components/FieldLabel';
import useScrub from './components/useScrub';
import { useFieldDraft } from './lib/field-draft';
import { handleArrowStep } from './lib/number-step';
import { parseImportant, readProp, withImportant } from './lib/prop-read';
import type { ParsedRule } from './lib/types';

// A labeled text field bound to a single CSS property on a rule, with live
// (debounced) canvas updates as you type, an authoritative commit on blur, and
// arrow-key number stepping. Shared by the bespoke section controls.
export default function PropField({
  rule,
  busy,
  prop,
  label,
  placeholder = '—',
  labelClassName = 'embed-editor_size-label',
  inputClassName = 'embed-editor_size-input',
  onSetProp,
  onClearProp,
  onLiveSetProp,
}: PropFieldProps) {
  const field = usePropFieldEditing({ rule, busy, prop, onSetProp, onClearProp, onLiveSetProp });
  return (
    <>
      <FieldLabel
        className={labelClassName}
        active={field.active}
        disabled={busy}
        onReset={field.reset}
        resetLabel="Clear"
        scrubProps={field.scrub.label}
      >
        {label}
      </FieldLabel>
      <input
        {...field.scrub.input}
        className={`u-input ${inputClassName}`}
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
    </>
  );
}

type PropFieldProps = {
  rule: ParsedRule;
  busy: boolean;
  prop: string;
  label: string;
  placeholder?: string;
  labelClassName?: string;
  inputClassName?: string;
  onSetProp: (prop: string, value: string, important: boolean) => void;
  onClearProp: (prop: string | string[]) => void;
  onLiveSetProp: (prop: string, value: string, important: boolean) => void;
};

// The field's editing state: the draft that follows the rule while nobody is
// typing, live previews while someone is, and the commit on blur or scrub end.
function usePropFieldEditing({
  rule,
  busy,
  prop,
  onSetProp,
  onClearProp,
  onLiveSetProp,
}: Pick<PropFieldProps, 'rule' | 'busy' | 'prop' | 'onSetProp' | 'onClearProp' | 'onLiveSetProp'>) {
  const found = readProp(rule, prop);
  const external = found ? withImportant(found) : '';
  const { draft, setDraft, focused, cleared } = useFieldDraft(external, { busy });
  const { cancelLive, liveNow, scheduleLive } = useLiveProp(prop, onLiveSetProp);

  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onClearProp(prop);
      return;
    }
    const parsed = parseImportant(trimmed);
    onSetProp(prop, parsed.value, parsed.important);
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
    active: Boolean(found),
    draft,
    scrub,
    reset: () => {
      cleared();
      onClearProp(prop);
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
    keyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepFieldKey(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        scheduleLive(stepped);
      }
    },
  };
}

// Enter commits by blurring; an arrow key steps the number under the caret and
// writes it straight into the input. Returns the stepped text, if any.
function stepFieldKey(event: KeyboardEvent<HTMLInputElement>): string | undefined {
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

// Live canvas previews for one property. Typing previews on a debounce; a scrub
// previews on its own throttle and needs the write itself, undelayed — a debounce
// that keeps being reset by the next mouse move would never fire until the drag
// stopped.
function useLiveProp(
  prop: string,
  onLiveSetProp: (prop: string, value: string, important: boolean) => void,
) {
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
    onLiveSetProp(prop, parsed.value, parsed.important);
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
