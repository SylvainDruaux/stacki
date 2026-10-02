// Opacity: a percent with a slider and a number field (EffectsSection.tsx).

import DragSlider from './components/DragSlider';
import useScrub from './components/useScrub';
import { useComputedValue } from './model/computedStyle';
import VariableConnect from './VariableConnect';
import { useExternalDraft } from './model/fieldHooks';
import { displayOf } from './model/styleDisplay';
import { type SetProp, type Props, stepInPlace, EffLabel } from './EffectsKit';

// ─────────────────────────── Rows ───────────────────────────

/** The percentage a value reads as, or undefined when it isn't a number at all. */
export function percentOf(value: string): number | undefined {
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
export const opacityCss = (percent: number) =>
  percent >= 100 ? '1' : percent <= 0 ? '0' : String(Math.round(percent) / 100);
export const clampPercent = (percent: number) => Math.min(100, Math.max(0, Math.round(percent)));
// The unit is part of the value the field shows — `100%`, the way it reads in CSS —
// rather than a chip pinned beside it.
export const percentText = (percent: number) => `${percent}%`;
// Typing the % (or leaving it off) both work: the parse only wants the number.
export function parsePercent(text: string): number | undefined {
  const amount = parseFloat(text);
  return Number.isNaN(amount) ? undefined : clampPercent(amount);
}

export function OpacityRow({ props }: { props: Props }) {
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
export interface OpacityFieldProps {
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

export function OpacityNumberField(props: OpacityFieldProps) {
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
export function useOpacityField({
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
