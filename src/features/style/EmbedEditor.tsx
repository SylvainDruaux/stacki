import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { CodeEditor } from './components/CssCodeEditor';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import Select, { type SelectOption } from './components/Select';
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl';
import useScrub from './components/useScrub';
import DisplayControl, { DISPLAY_VALUES } from './DisplayControl';
import DirectionControl from './DirectionControl';
import AlignControl from './AlignControl';
import ElementTokenPicker from './ElementTokenPicker';
import { loadEmbedSource, saveEmbedSource } from './model/toolPreferences';
import { handleArrowStep } from './model/numberStep';
import { hslaToRgba } from './model/colorWrite';
import { clampNonNegative, filterCssProperties } from './model/cssProperties';
import { panelSpan } from './model/panelBox';
import { forgetComputedStyles, useHighlight } from './model/computedStyle';
import { forgetComputedColors } from './model/computedColor';
import SizeSection from './SizeSection';
import GapControl from './GapControl';
import GridControls from './GridControls';
import SpacingSection, { SpacingCenterButton } from './SpacingSection';
import BordersSection from './BordersSection';
import BackgroundSection from './BackgroundSection';
import PositionSection from './PositionSection';
import TypographySection, { GroupLabel } from './TypographySection';
import FlexChildSection from './FlexChildSection';
import EffectsSection from './EffectsSection';
import ProvenanceList, { ProvenanceEmbedNav } from './ProvenanceList';
import VariableConnect, { useSharedVars } from './VariableConnect';
import { computeRuleModel, type MatchedRule, type RuleModel } from './model/cascade';
import { cssTokens } from './model/cssCode';
import { buildCssRuleView, type CssRuleRange, type CssRuleView } from './model/cssRuleView';
import { groupProps } from './model/sections';
import {
  defaultSelectorTokens,
  selectorToClassTokens,
  snapshotTokens,
  tokensToSelector,
} from './model/elementTokens';
import {
  resolveStyle,
  indexContexts,
  contextKeyOf,
  listMatchedSelectors,
  selectorKey,
  selectorsMatch,
  stateForSelector,
  STATES,
  type ContextInfo,
  type ContextKey,
  type MatchedSelector,
  type ResolvedProp,
  type ResolvedStyle,
  type SourceKey,
  type StateKey,
  type StyleContext,
} from './model/resolved';
import {
  breakpointTier,
  buildStyleContexts,
  mediaParamsForBreakpoint,
  nativeContribsFor,
  nativeHasValues,
  nativeSelectorChips,
  optionsFor,
  selectedNativeIndexFor,
  type NativeStyleOptions,
} from './model/nativeStyles';
import type { AtRule, Declaration } from 'postcss';
import { assert } from '../../../shared/core/assert';
import {
  addDeclaration,
  appendDecl,
  directDecls,
  createRuleAtRoot,
  createRuleInAtRule,
  createNestedRule,
  createRuleInMedia,
  createRuleInQuery,
  ensureNestPath,
  ensureQueryBlock,
  listAtRuleBlocks,
  parseNestedInput,
  type NestStep,
  removeRule,
  removeRuleIfEmpty,
  renameAtRuleQuery,
  atRuleQueryText,
  queryKey,
  splitQuery,
  replaceRuleCss,
  splitRuleSelectorAt,
} from './model/css';
import {
  canonicalCompound,
  compareSpecificity,
  parseSelectorList,
  selectorDependsOnAncestor,
  type MatchTarget,
} from './model/selectors';
import { findNode, getHost, onHostChange, propText, type ClassOutcome } from './model/host';
import {
  applyNativePropertyAt,
  applyNativeToNewBaseClass,
  buildSnapshot,
  dedupeByKey,
  embedSourceClassSuffix,
  getCurrentBreakpoint,
  loadEmbedDocs,
  navigateToEmbed,
  readNativeStyleByName,
  readNativeStyles,
  onDocsReloaded,
  rebuildRules,
  removeNativePropertyAt,
  resolveIdentityElement,
  askCanvasAbout,
  primeDomMatches,
  resolveTarget,
  scanAllComponents,
  scanHasElement,
  scanPage,
  serializeElementId,
  liveSetNativeProperty,
  nativeStylingAvailable,
  webflowApi,
  webflowClassToCss,
  writeEmbedDocument,
  type EmbedDocument,
  type EmbedScan,
  type NativeWriteTarget,
} from './model/webflow';
import type {
  BreakpointId,
  ElementSnapshot,
  NativeModel,
  ParsedDeclaration,
  ParsedRule,
  Specificity,
} from './model/styleTypes';
import './embedEditor.css';
import { splitTopLevelSpaces } from './model/background';
import { useExternalDraft } from './model/fieldHooks';
import { parseImportant } from './model/styleDisplay';

type ScanState = {
  rootSnapshot: ElementSnapshot | undefined;
  model: RuleModel;
  /** Empty "add a rule here" scaffolds for queries that don't target the element yet. */
  placeholders: Placeholder[];
  embedCount: number;
  componentEmbedCount: number;
  /** Page-level embeds carried over from the last full page scan (in-component). */
  rememberedPageEmbedCount: number;
  errors: Array<{ label: string; message: string }>;
  inComponentContext: boolean;
};

type Phase = 'idle' | 'scanning' | 'ready' | 'no-selection' | 'unsupported';

// A write commits a value, with or without !important.
type SetProp = (prop: string, value: string, important: boolean) => void;

// One property's committed value, on its way to a native class style or an embed.
interface PropWrite {
  readonly prop: string;
  readonly value: string;
  readonly important: boolean;
}

// A live write previews a value without committing it; `undefined` drops the preview
// and puts back what the live writes overwrote.
type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;

function isBreakpointId(value: unknown): value is BreakpointId {
  return (
    value === 'xxl' ||
    value === 'xl' ||
    value === 'large' ||
    value === 'main' ||
    value === 'medium' ||
    value === 'small' ||
    value === 'tiny'
  );
}

// Placeholder resolved-style so the panel frame (chips, selectors, sections) can
// render immediately while embeds are still scanning — every section shows unset
// and fills in the moment the real resolved model arrives.
const EMPTY_RESOLVED: ResolvedStyle = {
  props: new Map(),
  selectedRule: undefined,
  contexts: [],
  states: STATES,
};
const EMPTY_RULE_MODEL: RuleModel = { base: [], conditional: [], matchedRuleCount: 0 };

// ─────────────────────────── Value helpers ───────────────────────────

// A selector Webflow can represent as one base class without an element carrying it.
// Interaction states remain native-capable; complex selectors and other pseudos need
// an embed because the Style API has no standalone selector object for them.
function standaloneNativeClass(selector: string): string | undefined {
  const match = selector.trim().match(/^\.([_a-z-][\w-]*)(?::(?:hover|focus|active))?$/i);
  return match ? webflowClassToCss(match[1] ?? '') : undefined;
}

// ─────────────────────────── Query scaffolds ───────────────────────────

// An empty "add a rule here" card for the selected element inside an existing
// conditional query (@media/@container/…) that doesn't target it yet.
type Placeholder = {
  key: string;
  atContext: string[];
  selector: string;
  embedKey: string;
  atRuleNode: AtRule;
};

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

// For each conditional query in the given (writable, current-context) embeds,
// offer a scaffold for the element's primary class and full combo chain —
// skipping any the query already contains.
function computePlaceholders(docs: EmbedDocument[], classList: string[]): Placeholder[] {
  if (!classList.length) {
    return [];
  }
  const primary = `.${classList[0]}`;
  const full = `.${classList.join('.')}`;
  const candidates = full === primary ? [primary] : [primary, full];

  const out: Placeholder[] = [];
  for (const embedDocument of docs) {
    embedDocument.regions.forEach((region, regionIndex) => {
      for (const block of listAtRuleBlocks(region)) {
        const existing = new Set(block.selectors.map(normalizeSelector));
        for (const selector of candidates) {
          if (existing.has(normalizeSelector(selector))) {
            continue;
          }
          out.push({
            key:
              `${embedDocument.source.key}:${regionIndex}:` +
              `${block.atContext.join('>')}:${selector}`,
            atContext: block.atContext,
            selector,
            embedKey: embedDocument.source.key,
            atRuleNode: block.node,
          });
        }
      }
    });
  }
  return out;
}

// ─────────────────────────── Icons ───────────────────────────

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
      <path
        d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const EMBED_ICON_SECOND_PATH =
  'M6.35352 6.85352L5.20703 8L6.35352 9.14648L5.64648 9.85352L3.79297 8L5.64648 6.14648' +
  'L6.35352 6.85352Z';
const EMBED_ICON_THIRD_PATH =
  'M12.207 8L10.3535 9.85352L9.64648 9.14648L10.793 8L9.64648 6.85352L10.3535 6.14648' +
  'L12.207 8Z';
const EMBED_ICON_FOURTH_PATH =
  'M13 2C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13' +
  'V3C2 2.44772 2.44772 2 3 2H13ZM3 13H13V3H3V13Z';

function EmbedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7.73438 11.5H6.70996L8.26562 4.5H9.29004L7.73438 11.5Z" fill="currentColor" />
      <path d={EMBED_ICON_SECOND_PATH} fill="currentColor" />
      <path d={EMBED_ICON_THIRD_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={EMBED_ICON_FOURTH_PATH} fill="currentColor" />
    </svg>
  );
}

const COMPONENT_ICON_PATH =
  'M8.47885 1.69144C8.18037 1.52863 7.81963 1.52863 7.52115 1.69144L2.52115 4.41871' +
  'C2.19989 4.59395 2 4.93066 2 5.29661V10.703C2 11.0689 2.19989 11.4056 2.52115 11.5809' +
  'L7.52115 14.3081C7.81963 14.471 8.18037 14.471 8.47885 14.3081L13.4789 11.5809' +
  'C13.8001 11.4056 14 11.0689 14 10.703V5.29661C14 4.93066 13.8001 4.59395 13.4789 4.41871' +
  'L8.47885 1.69144ZM3.54416 4.99979L8 2.56934L12.4558 4.99979L8 7.43025L3.54416 4.99979Z' +
  'M3 5.84206L3 10.703L7.5 13.1575V8.29661L3 5.84206ZM8.5 13.1575L13 10.703V5.84206' +
  'L8.5 8.29661V13.1575Z';

// Webflow's component glyph — labels a component subheader in the source dropdown.
function ComponentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={COMPONENT_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

// Header save state: spinner while writing, check when everything is saved, an
// error mark (with the reason on hover) if the last write failed, or an unsaved
// dot (reason on hover) when edits are deferred until you exit the component.
// Rendered into the tool header's accessory slot (replaces the "Pro" tag).
function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function UnsavedIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3.5" fill="currentColor" />
    </svg>
  );
}
function SaveIndicator({
  busy,
  error,
  pending,
}: {
  busy: boolean;
  error: string | undefined;
  pending: string | undefined;
}) {
  const [target, setTarget] = useState<HTMLElement | undefined>(undefined);
  // Re-acquire the slot every render (no dep array) so the indicator follows it if the
  // selector row remounts; the functional update no-ops when it's unchanged, so there's
  // no render loop. The slot sits next to the `div.test` label, right-aligned.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs every render on purpose
  useEffect(() => {
    const slot = document.getElementById('embed-editor_save-slot') ?? undefined;
    setTarget((previous) => (previous === slot ? previous : slot));
  });
  if (!target) {
    return undefined;
  }
  // Native `title` tooltips are unreliable inside the Designer iframe, so we
  // render our own hover/focus tooltip (styled to match the dark UI).
  const state = busy
    ? { cls: 'is-saving', tip: 'Saving…', icon: <SpinnerIcon /> }
    : error
      ? { cls: 'is-error', tip: error, icon: <span className="embed-editor_save-mark">!</span> }
      : pending
        ? { cls: 'is-unsaved', tip: pending, icon: <UnsavedIcon /> }
        : { cls: 'is-saved', tip: 'All changes saved', icon: <CheckIcon /> };
  const node = (
    <span className={`embed-editor_save ${state.cls}`} tabIndex={0} aria-label={state.tip}>
      {state.icon}
      <span className="embed-editor_tip" role="tooltip">
        {state.tip}
      </span>
    </span>
  );
  return createPortal(node, target);
}

const TABLET_BREAKPOINT_ICON_SECOND_PATH =
  'M3 3C3 2.44772 3.44772 2 4 2H12C12.5523 2 13 2.44772 13 3V13C13 13.5523 12.5523 14 12 14H4' +
  'C3.44772 14 3 13.5523 3 13V3ZM4 3H12V13H4V3Z';

// Webflow's native breakpoint glyphs (tablet / mobile-landscape / mobile),
// shown beside the responsive contexts in the style-context dropdown.
function TabletBreakpointIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 11H6.5V12H9.5V11Z" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={TABLET_BREAKPOINT_ICON_SECOND_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const MOBILE_LANDSCAPE_BREAKPOINT_ICON_SECOND_PATH =
  'M4 12C2.89543 12 2 11.1046 2 10L2 6C2 4.89543 2.89543 4 4 4L12 4C13.1046 4 14 4.89543 14 6' +
  'V10C14 11.1046 13.1046 12 12 12H4ZM3 10L3 6C3 5.44772 3.44772 5 4 5L12 5' +
  'C12.5523 5 13 5.44772 13 6V10C13 10.5523 12.5523 11 12 11L4 11C3.44772 11 3 10.5523 3 10Z';

function MobileLandscapeBreakpointIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M12 9V7H11V9H12Z" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={MOBILE_LANDSCAPE_BREAKPOINT_ICON_SECOND_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const MOBILE_BREAKPOINT_ICON_SECOND_PATH =
  'M4 4C4 2.89543 4.89543 2 6 2H10C11.1046 2 12 2.89543 12 4V12C12 13.1046 11.1046 14 10 14H6' +
  'C4.89543 14 4 13.1046 4 12V4ZM6 3H10C10.5523 3 11 3.44772 11 4V12' +
  'C11 12.5523 10.5523 13 10 13H6C5.44772 13 5 12.5523 5 12V4C5 3.44772 5.44772 3 6 3Z';

function MobileBreakpointIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7 12H9V11H7V12Z" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={MOBILE_BREAKPOINT_ICON_SECOND_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
const DESKTOP_BREAKPOINT_ICON_FIRST_PATH =
  'M12 5.36602L10.1519 6.43301L9.65192 5.56699L11.5 4.5L9.65193 3.43301L10.1519 2.56699' +
  'L12 3.63397V1.5H13V3.63397L14.8481 2.56699L15.3481 3.43301L13.5 4.5L15.3481 5.56699' +
  'L14.8481 6.43301L13 5.36602V7.5H12V5.36602Z';

function DesktopBreakpointIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={DESKTOP_BREAKPOINT_ICON_FIRST_PATH} fill="currentColor" />
      <path
        d="M3 4H8V5H3V12H13V9H14V12H16V13H0V12H2V5C2 4.44772 2.44772 4 3 4Z"
        fill="currentColor"
      />
    </svg>
  );
}
function breakpointIcon(id: BreakpointId | undefined): ReactNode {
  switch (id) {
    case 'main':
      return <DesktopBreakpointIcon />;
    case 'medium':
      return <TabletBreakpointIcon />;
    case 'small':
      return <MobileLandscapeBreakpointIcon />;
    case 'tiny':
      return <MobileBreakpointIcon />;
    case 'xxl':
    case 'xl':
    case 'large':
    case undefined:
      return undefined;
  }
}

// ─────────────────────────── Declaration row ───────────────────────────

// The value reads as a single scrollable line when idle. Once focused, it
// expands to a full-width, auto-height field the moment its content is too long
// to sit on one line — so long values wrap and grow tall instead of scrolling.
const ValueField = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    important: boolean;
    busy: boolean;
    /** Marks the field with [data-prop] so it can be focused programmatically. */
    dataProp?: string;
    onCommit: (value: string, important: boolean) => void;
    /** Fires (debounced) on every keystroke/step to push the value to the embed live. */
    onLiveCommit: (value: string, important: boolean) => void;
  }
>(function ValueField({ value, important, busy, dataProp, onCommit, onLiveCommit }, forwardedRef) {
  const external = important ? `${value} !important` : value;
  // Mirror external edits, but never clobber what the user is typing.
  const { draft, setDraft, focused } = useExternalDraft(external);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Keep the local ref (used for sizing/caret work) and hand the same node to
  // whoever wrapped us.
  const attachRef = mergedRef(ref, forwardedRef);

  // Undelayed live write for the scrub, which throttles its own — see useScrub.
  const liveNow = (text: string) => {
    const parsed = parseImportant(text);
    if (parsed.value) {
      onLiveCommit(parsed.value, parsed.important);
    }
  };
  // Push the current draft to the embed as you type/scrub — debounced so the
  // canvas updates in near-real-time without a write per keystroke.
  const { scheduleLive, cancelLive } = useLiveTimer(liveNow);
  const { expanded, setExpanded, maybeExpand } = useAutoExpand({ ref, focused, draft });

  const commit = (text = draft) => {
    const parsed = parseImportant(text);
    if (parsed.value && (parsed.value !== value || parsed.important !== important)) {
      onCommit(parsed.value, parsed.important);
    }
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
  const edited = (text: string) => {
    setDraft(text);
    maybeExpand();
    scheduleLive(text);
  };

  return (
    <textarea
      {...scrub.input}
      ref={attachRef}
      data-prop={dataProp}
      className={`u-input embed-editor_value-input ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      rows={1}
      value={draft}
      onChange={(event) => edited(event.target.value)}
      onFocus={() => {
        focused.current = true;
        maybeExpand();
      }}
      // Blur is the authoritative commit — cancel any pending live write first.
      onBlur={() => {
        focused.current = false;
        setExpanded(false);
        cancelLive();
        commit();
      }}
      // Enter commits — a CSS value is one line, so we never insert a hard break.
      // Up/Down scrub the number under the caret (Shift = ×10, Alt = per-px).
      onKeyDown={(event) => {
        const stepped = stepValueField(event);
        if (stepped !== undefined) {
          edited(stepped);
        }
      }}
      disabled={busy}
      spellCheck={false}
      aria-label="Value"
    />
  );
});

// One ref callback that sets both a local ref and whatever ref the caller forwarded.
function mergedRef<T>(
  localRef: React.RefObject<T>,
  forwardedRef: React.ForwardedRef<T>,
): React.RefCallback<T> {
  return (node) => {
    Reflect.set(localRef, 'current', node);
    if (typeof forwardedRef === 'function') {
      forwardedRef(node);
    } else if (forwardedRef) {
      Reflect.set(forwardedRef, 'current', node);
    }
  };
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
  const scheduleLive = (text: string) => {
    cancelLive();
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = undefined;
      liveNow(text);
    }, 100);
  };
  useEffect(() => cancelLive, []);
  return { scheduleLive, cancelLive };
}

// The value field's expansion: it expands the instant the collapsed single line can no
// longer hold the content, and grows to fit it (no inner scroll); collapsing resets it.
function useAutoExpand({
  ref,
  focused,
  draft,
}: {
  ref: React.RefObject<HTMLTextAreaElement>;
  focused: React.MutableRefObject<boolean>;
  draft: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const maybeExpand = () => {
    const field = ref.current;
    if (!field || !focused.current || expanded) {
      return;
    }
    if (field.scrollWidth > field.clientWidth + 1) {
      setExpanded(true);
    }
  };
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) {
      return;
    }
    if (expanded) {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    } else {
      field.style.height = '';
    }
  }, [expanded, draft, ref]);
  return { expanded, setExpanded, maybeExpand };
}

// Enter blurs (the commit); ↑/↓ step the number under the caret in place. Returns the
// stepped text, or undefined when the key did not step.
function stepValueField(event: React.KeyboardEvent<HTMLTextAreaElement>): string | undefined {
  const field = event.currentTarget;
  if (event.key === 'Enter') {
    event.preventDefault();
    field.blur();
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  field.value = stepped.text;
  field.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// ─────────────────────────── Add-property row ───────────────────────────

// The property-name field with an autocomplete of every CSS property. The suggestion
// list is portaled to <body> and positioned above the input (the add row sits at the
// panel bottom), flipping below only when there's more room there. Arrow keys move the
// highlight, Enter/Tab/click pick it; Enter with nothing highlighted submits the row and
// Escape closes the list (a second Escape cancels the row).
interface PropertyComboboxProps {
  value: string;
  /** This project's own custom properties, offered beside the standard ones. */
  custom: readonly string[];
  busy: boolean;
  onChange: (value: string) => void;
  onPick: (prop: string) => void;
  onEnter: () => void;
  onEscape: () => void;
}
function PropertyCombobox(props: PropertyComboboxProps) {
  const { value, custom, busy, onChange, onPick, onEnter, onEscape } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => filterCssProperties(value, custom), [value, custom]);
  const position = useSuggestPosition({ open, inputRef, matchCount: matches.length, value });

  // Reset the highlight to the top whenever the query (and so the list) changes.
  useEffect(() => {
    setActive(0);
  }, [value]);

  // Keep the highlighted option scrolled into view during keyboard nav.
  useEffect(() => {
    if (!open) {
      return;
    }
    const element = listRef.current?.children[active];
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [active, open]);

  const choose = (prop: string) => {
    onPick(prop);
    setOpen(false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) =>
    comboKeyDown(event, { open, active, matches, setOpen, setActive, choose, onEnter, onEscape });

  return (
    <div className="embed-editor_propcombo">
      <input
        ref={inputRef}
        className="u-input embed-editor_prop-input"
        value={value}
        autoFocus
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        disabled={busy}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="property"
        spellCheck={false}
        aria-label="New property name"
      />
      {open && matches.length ? (
        <PropertySuggestions
          listRef={listRef}
          position={position}
          matches={matches}
          active={active}
          setActive={setActive}
          choose={choose}
        />
      ) : undefined}
    </div>
  );
}

// The suggestion list, portaled to <body>.
function PropertySuggestions({
  listRef,
  position,
  matches,
  active,
  setActive,
  choose,
}: {
  listRef: React.RefObject<HTMLDivElement>;
  position: CSSProperties;
  matches: readonly string[];
  active: number;
  setActive: (index: number) => void;
  choose: (prop: string) => void;
}) {
  return createPortal(
    <div
      ref={listRef}
      className="embed-editor_propsuggest"
      style={position}
      role="listbox"
      aria-label="CSS properties"
    >
      {matches.map((prop, i) => (
        <button
          key={prop}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`embed-editor_propsuggest-item${i === active ? ' is-active' : ''}`}
          onMouseEnter={() => setActive(i)}
          // A mousedown (not click) + preventDefault, so the input never blurs first.
          onMouseDown={(event) => {
            event.preventDefault();
            choose(prop);
          }}
        >
          {prop}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// Position the list vertically against the input (above it, flipping below only when
// there's more room there); span the full panel width, like the variable picker, so
// long property names aren't truncated in the input's narrow column. The panel is
// measured — it's a column of the window here, not the window itself. Re-measured
// whenever the list opens or its contents change.
function useSuggestPosition({
  open,
  inputRef,
  matchCount,
  value,
}: {
  open: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  matchCount: number;
  value: string;
}): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
  });
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    const rect = input.getBoundingClientRect();
    const span = panelSpan(input);
    const margin = 8;
    const gap = 4;
    const spaceAbove = rect.top - margin;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const up = spaceAbove >= spaceBelow;
    const heightMax = Math.max(120, Math.min(340, (up ? spaceAbove : spaceBelow) - gap));
    const box = {
      position: 'fixed',
      left: span.left,
      width: span.width,
      visibility: 'visible',
    } as const;
    setPosition(
      up
        ? { ...box, bottom: window.innerHeight - rect.top + gap, maxHeight: heightMax }
        : { ...box, top: rect.bottom + gap, maxHeight: heightMax },
    );
  }, [open, matchCount, value, inputRef]);
  return position;
}

// The combobox's keys: ↓/↑ open the list and move the highlight, Enter/Tab pick the
// highlighted property (Enter with none submits the row), Escape closes the list and
// then cancels the row.
function comboKeyDown(
  event: ReactKeyboardEvent<HTMLInputElement>,
  combo: {
    open: boolean;
    active: number;
    matches: readonly string[];
    setOpen: (open: boolean) => void;
    setActive: React.Dispatch<React.SetStateAction<number>>;
    choose: (prop: string) => void;
    onEnter: () => void;
    onEscape: () => void;
  },
) {
  const { open, matches, setActive } = combo;
  const highlighted = open ? matches[combo.active] : undefined;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (!open) {
        combo.setOpen(true);
        return;
      }
      setActive((previous) => Math.min(previous + 1, matches.length - 1));
      return;
    case 'ArrowUp':
      event.preventDefault();
      if (open) {
        setActive((previous) => Math.max(previous - 1, 0));
      }
      return;
    case 'Enter':
      if (highlighted) {
        event.preventDefault();
        combo.choose(highlighted);
      } else {
        combo.onEnter();
      }
      return;
    case 'Tab':
      if (highlighted) {
        event.preventDefault();
        combo.choose(highlighted);
      }
      return;
    case 'Escape':
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        combo.setOpen(false);
      } else {
        combo.onEscape();
      }
      return;
    default:
      return;
  }
}

function AddPropertyRow({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (prop: string, value: string, important: boolean) => void;
}) {
  const row = useAddProperty(onAdd);
  const { expanded, prop, setProp, value, setValue, valueRef, ready, cancel, submit } = row;
  // The project's own custom properties are properties here too — this row is
  // where one gets set, and `--brand-500` is not in any list of standard CSS.
  // Only asked for while the row is open.
  const { vars } = useSharedVars({ active: expanded });
  const custom = useMemo(() => customPropertyNames(vars), [vars]);

  if (!expanded) {
    return <AddPropertyButton busy={busy} onOpen={() => row.setExpanded(true)} />;
  }

  return (
    <div className="embed-editor_decl is-add">
      <CancelAddButton onCancel={cancel} />
      <PropertyCombobox
        value={prop}
        custom={custom}
        busy={busy}
        onChange={setProp}
        onPick={(picked) => {
          setProp(picked);
          valueRef.current?.focus();
        }}
        onEnter={row.enterName}
        onEscape={cancel}
      />
      <NewValueInput
        valueRef={valueRef}
        value={value}
        setValue={setValue}
        submit={submit}
        cancel={cancel}
      />
      <button
        className="embed-editor_icon-btn"
        type="button"
        onClick={submit}
        disabled={busy || !ready}
        title="Add property"
        aria-label="Add property"
      >
        +
      </button>
    </div>
  );
}

// The add row's state: whether it is open, the name and value being typed, and what
// cancel, submit, and Enter on the name do.
function useAddProperty(onAdd: (prop: string, value: string, important: boolean) => void) {
  const [expanded, setExpanded] = useState(false);
  const [prop, setProp] = useState('');
  const [value, setValue] = useState('');
  const valueRef = useRef<HTMLInputElement>(null);
  const ready = prop.trim() !== '' && value.trim() !== '';

  const cancel = () => {
    setProp('');
    setValue('');
    setExpanded(false);
  };
  const submit = () => {
    if (!ready) {
      return;
    }
    const parsed = parseImportant(value);
    onAdd(prop.trim(), parsed.value, parsed.important);
    setProp(''); // keep the row open + cleared so several can be added in a row
    setValue('');
  };
  // Enter on a name is done with the name, not done with the row: a property with no
  // value is not a declaration, and submit had nothing to write, so the key did
  // nothing at all. It goes where the rest of the answer has to be typed.
  const enterName = () => {
    if (prop.trim() && !value.trim()) {
      valueRef.current?.focus();
      return;
    }
    submit();
  };

  return {
    expanded,
    setExpanded,
    prop,
    setProp,
    value,
    setValue,
    valueRef,
    ready,
    cancel,
    submit,
    enterName,
  };
}

function CancelAddButton({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      className="embed-editor_icon-btn"
      type="button"
      onClick={onCancel}
      title="Cancel"
      aria-label="Cancel adding property"
    >
      ✕
    </button>
  );
}

// The project's custom properties as property names (`--name`), sorted.
function customPropertyNames(vars: ReadonlyArray<{ name: string }>): string[] {
  return [...new Set(vars.map((variable) => `--${variable.name}`))].sort();
}

// The new declaration's value: Enter submits the row, Escape cancels it.
function NewValueInput({
  valueRef,
  value,
  setValue,
  submit,
  cancel,
}: {
  valueRef: React.RefObject<HTMLInputElement>;
  value: string;
  setValue: (value: string) => void;
  submit: () => void;
  cancel: () => void;
}) {
  return (
    <input
      ref={valueRef}
      className="u-input embed-editor_value-input"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          submit();
        }
        if (event.key === 'Escape') {
          cancel();
        }
      }}
      placeholder="value"
      spellCheck={false}
      aria-label="New value"
    />
  );
}

function AddPropertyButton({ busy, onOpen }: { busy: boolean; onOpen: () => void }) {
  return (
    <button className="embed-editor_add-btn" type="button" onClick={onOpen} disabled={busy}>
      <span className="embed-editor_add-plus" aria-hidden="true">
        +
      </span>{' '}
      Add property
    </button>
  );
}

// ─────────────────────────── Section block ───────────────────────────

type SectionToggleRequest = {
  readonly id: string;
  readonly ids: readonly string[];
  readonly next: 'open' | 'closed';
  readonly scope: 'one' | 'all';
};

function useSectionVisibility(): readonly [
  ReadonlySet<string>,
  (request: SectionToggleRequest) => void,
] {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(['flex-child']));
  const toggle = useCallback((request: SectionToggleRequest) => {
    setClosed((previous) => {
      if (request.scope === 'all') {
        return request.next === 'open' ? new Set() : new Set(request.ids);
      }
      const next = new Set(previous);
      if (request.next === 'open') {
        next.delete(request.id);
      } else {
        next.add(request.id);
      }
      return next;
    });
  }, []);
  return [closed, toggle];
}

// A collapsible section header (Webflow's chevron + label) wrapping a group of
// controls. Visibility is owned by the card so Shift-click can apply one
// header's next state to every section without a document-wide event channel.
function SectionBlock({
  label,
  headerAction,
  open,
  mark,
  onToggle,
  children,
}: {
  readonly label: string;
  readonly headerAction?: ReactNode;
  readonly open: boolean;
  readonly mark?: 'own' | 'other' | undefined;
  readonly onToggle: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className={`embed-editor_section-block ${open ? '' : 'is-collapsed'}`}>
      {/* A row (not one big button) so an optional action can sit next to the chevron
          without nesting a button inside a button. */}
      <div className="embed-editor_section-header">
        <button
          type="button"
          className="embed-editor_section-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="embed-editor_section-title">{label}</span>
        </button>
        {headerAction}
        {/* Only while closed, and beside the chevron rather than the label, so the
            right edge of every header reads as one column: what is in here, then
            open/closed. Open, the property labels inside are already saying it in
            these same two colours — orange for anything reaching the element at
            all, blue once the picked selector is one of the things setting it —
            and the dot would only be repeating them. */}
        {!open && mark ? (
          <span
            className={`embed-editor_section-dot ${mark === 'own' ? 'is-own' : ''}`}
            role="img"
            aria-label={
              mark === 'own'
                ? `${label} has styles on this selector`
                : `${label} has styles from another selector`
            }
            title={mark === 'own' ? 'Set on this selector' : 'Set on another selector'}
          />
        ) : undefined}
        <button
          type="button"
          className="embed-editor_section-chevron-btn"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
          onClick={onToggle}
        >
          <svg className="embed-editor_section-chevron" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4.2 6.2 8 10l3.8-3.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {open ? <div className="embed-editor_section-body">{children}</div> : undefined}
    </div>
  );
}

// ─────────────────────────── Provenance popover ───────────────────────────

// Lists every selector that sets an "orange" property (applied through a selector
// other than the picked one): its value + the cascade winner, so you can see who
// wins and where a style comes from.
function ProvenancePopover({
  prop,
  anchor,
  resolved,
  onClose,
  onAnchorReclick,
  onSelectSelector,
}: {
  prop: string;
  anchor: DOMRect;
  resolved: ResolvedProp;
  onClose: () => void;
  onAnchorReclick: (prop: string) => void;
  onSelectSelector: (selectorText: string, prop?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headerLabel = prop;
  const position = useAnchoredPosition(ref, anchor);
  useProvenanceDismiss({ ref, anchor, prop, onClose, onAnchorReclick });

  return createPortal(
    <div
      ref={ref}
      className="embed-editor_provenance"
      role="dialog"
      aria-label={`Selectors setting ${headerLabel}`}
      style={{ left: position.left, top: position.top }}
    >
      <div className="embed-editor_provenance-head">
        <code>{headerLabel}</code>
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <ProvenanceList
        contributors={resolved.contributors}
        prop={prop}
        onSelect={(selector, selectedProp) => {
          onSelectSelector(selector, selectedProp);
          onClose();
        }}
      />
    </div>,
    document.body,
  );
}

// Anchor to the clicked label's bottom-left, then clamp into the panel and flip above
// the label if it would run off the bottom. Portaled to the body so no card overflow /
// stacking context can clip it.
function useAnchoredPosition(ref: React.RefObject<HTMLDivElement>, anchor: DOMRect) {
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: anchor.left,
    top: anchor.bottom + 6,
  });
  useLayoutEffect(() => {
    const popover = ref.current;
    if (!popover) {
      return;
    }
    const margin = 8;
    const { width, height } = popover.getBoundingClientRect();
    // Horizontally the popover belongs to the panel, not the window — clamping
    // to the viewport would let it hang off the panel's left edge.
    const span = panelSpan(popover);
    let left = anchor.left;
    let top = anchor.bottom + 6;
    if (left + width > span.left + span.width) {
      left = span.left + span.width - width;
    }
    if (left < span.left) {
      left = span.left;
    }
    if (top + height > window.innerHeight - margin) {
      const above = anchor.top - 6 - height;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height);
    }
    setPosition({ left, top });
  }, [anchor, ref]);
  return position;
}

// Dismiss on a pointerdown anywhere outside the popover, or on Escape. Mounted after
// the opening click, so that click can't immediately close it.
function useProvenanceDismiss({
  ref,
  anchor,
  prop,
  onClose,
  onAnchorReclick,
}: {
  ref: React.RefObject<HTMLDivElement>;
  anchor: DOMRect;
  prop: string;
  onClose: () => void;
  onAnchorReclick: (prop: string) => void;
}) {
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) {
        return;
      }
      // Pressing back on the label that opened this popover toggles it closed —
      // flag it so that label's click doesn't immediately re-open it.
      if (
        event.clientX >= anchor.left &&
        event.clientX <= anchor.right &&
        event.clientY >= anchor.top &&
        event.clientY <= anchor.bottom
      ) {
        onAnchorReclick(prop);
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, onAnchorReclick, anchor, prop, ref]);
}

// ─────────────────────────── Resolved property row ───────────────────────────

// A generic property row from the resolved model: blue when the picked selector
// sets it (editable + removable), orange when another selector does (value from
// the cascade winner; clicking the label opens provenance; editing it adds the
// property to the picked selector — turning it blue).
function ResolvedRow({
  prop,
  resolved,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  resolved: ResolvedProp;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const isSelected = resolved.source === 'selected';
  const display =
    isSelected && resolved.selectedValue
      ? resolved.selectedValue
      : { value: resolved.winner.value, important: resolved.winner.important };
  const isDisplay = prop === 'display';

  return (
    <div className={`embed-editor_decl ${isDisplay ? 'is-control' : ''}`}>
      <ResolvedRowLabel
        prop={prop}
        resolved={resolved}
        busy={busy}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      {isDisplay ? (
        <DisplayControl
          value={display.value}
          important={display.important}
          busy={busy}
          onCommit={(value, important) => setProp(prop, value, important)}
        />
      ) : (
        <VariableConnect
          ariaLabel={`Connect ${prop} to a variable`}
          disabled={busy}
          prop={prop}
          onPick={(binding) => setProp(prop, binding, false)}
        >
          <ValueField
            value={display.value}
            important={display.important}
            busy={busy}
            dataProp={prop}
            onCommit={(value, important) => setProp(prop, value, important)}
            onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
          />
        </VariableConnect>
      )}
    </div>
  );
}

// A resolved row's label: blue and clearable when the picked selector sets the
// property, else an orange button that opens its provenance.
function ResolvedRowLabel({
  prop,
  resolved,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  resolved: ResolvedProp;
  busy: boolean;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  if (resolved.source !== 'selected') {
    return (
      <button
        type="button"
        className="embed-editor_prop-label embed-editor_prop-orange"
        disabled={busy}
        title={`Set by ${resolved.winner.selectorText} — click to see all selectors`}
        onClick={(event) => onProvenance(prop, event.currentTarget.getBoundingClientRect())}
      >
        {prop}
      </button>
    );
  }
  return (
    <FieldLabel
      className={'embed-editor_prop-label is-blue ' + (resolved.overridden ? 'is-overridden' : '')}
      active
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel="Remove property"
      {...(resolved.overridden ? { title: `Overridden by ${resolved.winner.selectorText}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={resolved.contributors}
          prop={prop}
          onSelect={(selector, selectedProp) => {
            onSelectSelector(selector, selectedProp);
            close();
          }}
        />
      )}
    >
      {prop}
    </FieldLabel>
  );
}

// The size-row label for a property that is always shown: dim when nothing sets it,
// blue and clearable when the picked selector does (flagged when overridden), orange
// with provenance when another selector does.
function SizeRowLabel({
  label,
  prop,
  resolved,
  busy,
  showOverride,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  resolved: ResolvedProp | undefined;
  busy: boolean;
  /** Mark (and title) the blue label when a more specific selector overrides it. */
  showOverride: boolean;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  if (!resolved) {
    return (
      <FieldLabel
        className="embed-editor_size-label"
        active={false}
        disabled={busy}
        onReset={() => {}}
        tooltip={<PropTip props={[prop]} />}
      >
        {label}
      </FieldLabel>
    );
  }
  if (resolved.source !== 'selected') {
    return (
      <ProvenanceLabel
        label={label}
        props={[prop]}
        busy={busy}
        onProvenance={onProvenance}
        note={`Set by ${resolved.winner.selectorText} — click to see all selectors`}
      />
    );
  }
  const overridden = showOverride && resolved.overridden;
  return (
    <FieldLabel
      className={overridden ? 'embed-editor_size-label is-overridden' : 'embed-editor_size-label'}
      active
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel="Remove property"
      tooltip={<PropTip props={[prop]} />}
      {...(overridden ? { title: `Overridden by ${resolved.winner.selectorText}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={resolved.contributors}
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

// The Display control is always shown (Webflow parity), even when no selector
// sets `display`. In that case it shows what the PAGE computes for the element —
// a `<span>` reads inline, a flex child of a component-authored rule reads what
// that rule says — falling back to `block` when there's no canvas to ask. The
// label stays dim either way, to signal it isn't set here.
function DisplayRow({
  resolved,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  resolved: ResolvedProp | undefined;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const isSelected = resolved?.source === 'selected';
  // Nothing declared → what the page renders as, held steady while it is asked
  // rather than guessed at (see useHighlight).
  const shown = useHighlight('', resolved ? '' : 'display', DISPLAY_VALUES, 'block');
  const current = resolved
    ? isSelected && resolved.selectedValue
      ? resolved.selectedValue
      : { value: resolved.winner.value, important: resolved.winner.important }
    : { value: shown, important: false };
  return (
    <div className="embed-editor_size-row">
      <SizeRowLabel
        label="Display"
        prop="display"
        resolved={resolved}
        busy={busy}
        showOverride={false}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <DisplayControl
        value={current.value}
        important={current.important}
        busy={busy}
        onCommit={(value, important) => setProp('display', value, important)}
      />
    </div>
  );
}

// Align Y = `vertical-align`. It only affects inline-level / table-cell boxes, so
// the whole row dims (but stays editable) when Display isn't one of those. Values
// mirror Webflow's dropdown.
const VALIGN_OPTIONS: readonly SelectOption<string>[] = [
  { value: 'baseline', label: 'Baseline' },
  { value: 'sub', label: 'Sub' },
  { value: 'super', label: 'Super' },
  { value: 'top', label: 'Top' },
  { value: 'text-top', label: 'Text top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'text-bottom', label: 'Text bottom' },
];
const VALIGN_VALUES = new Set(VALIGN_OPTIONS.map((option) => option.value));
// Display values for which `vertical-align` actually applies (else the row dims).
const VALIGN_DISPLAYS = new Set([
  'inline',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'inline-table',
  'table-cell',
]);

function VerticalAlignRow({
  resolved,
  dimmed,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  resolved: ResolvedProp | undefined;
  /** Display isn't inline/table-cell — fade the row but keep it editable. */
  dimmed: boolean;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const prop = 'vertical-align';
  const isSelected = resolved?.source === 'selected';
  const effective = resolved
    ? isSelected && resolved.selectedValue
      ? resolved.selectedValue
      : resolved.winner
    : undefined;
  const raw = effective ? effective.value.trim() : '';
  const matched = VALIGN_VALUES.has(raw.toLowerCase()) ? raw.toLowerCase() : undefined;

  // Surface a pre-existing non-preset value (e.g. a length) as a trailing option so
  // the trigger reflects it instead of silently snapping back to Baseline.
  const options: SelectOption<string>[] =
    matched === undefined && raw
      ? [...VALIGN_OPTIONS, { value: raw, label: raw }]
      : [...VALIGN_OPTIONS];
  const pick = (value: string) => setProp(prop, value, false);

  return (
    <div
      className={`embed-editor_size-row ${dimmed ? 'is-inactive' : ''}`}
      title={dimmed ? 'Align Y applies when Display is inline or table-cell' : undefined}
    >
      <SizeRowLabel
        label="Align Y"
        prop={prop}
        resolved={resolved}
        busy={busy}
        showOverride
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <Select
        value={matched ?? (raw || 'baseline')}
        options={options}
        onChange={pick}
        ariaLabel="Align Y"
        disabled={busy}
      />
    </div>
  );
}

// The effective (winner, else selected) value of a resolved prop, lowercased.
// Whether a value is one the property will actually accept (via CSS.supports).
// Gates LIVE writes so a half-typed / invalid value is never pushed at Webflow's
// native style API (which errors and gets stuck). var()/custom props pass; fails
// open only when CSS.supports is unavailable.
function isSupportedCssValue(prop: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return true;
  }
  try {
    return CSS.supports(prop, trimmed);
  } catch {
    return false;
  }
}

function effectiveValue(resolved: ResolvedProp | undefined): string {
  if (!resolved) {
    return '';
  }
  const effective =
    resolved.source === 'selected' && resolved.selectedValue
      ? resolved.selectedValue.value
      : resolved.winner.value;
  return effective.trim().toLowerCase();
}

// The effective raw value + !important flag (not lowercased) — for free-value fields.
function rawEffective(resolved: ResolvedProp | undefined): { value: string; important: boolean } {
  if (!resolved) {
    return { value: '', important: false };
  }
  const effective =
    resolved.source === 'selected' && resolved.selectedValue
      ? resolved.selectedValue
      : resolved.winner;
  return { value: effective.value, important: effective.important };
}

// The current flex flow as a normalized `<direction> [wrap]` string (matching the
// Direction control's option values). Prefers the `flex-direction` / `flex-wrap`
// longhands (what the control writes), falling back to any legacy `flex-flow`
// shorthand for each axis. `nowrap` is omitted (e.g. just `row`).
const FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse'];
const FLEX_WRAPS = ['nowrap', 'wrap', 'wrap-reverse'];
function currentFlexFlow(read: (prop: string) => ResolvedProp | undefined): string {
  let direction = 'row';
  let wrap = 'nowrap';
  const flowTokens = splitTopLevelSpaces(effectiveValue(read('flex-flow')));
  const directionValue = effectiveValue(read('flex-direction'));
  const wr = effectiveValue(read('flex-wrap'));
  if (FLEX_DIRECTIONS.includes(directionValue)) {
    direction = directionValue;
  } else {
    const directionToken = flowTokens.find((token) => FLEX_DIRECTIONS.includes(token));
    if (directionToken) {
      direction = directionToken;
    }
  }
  if (FLEX_WRAPS.includes(wr)) {
    wrap = wr;
  } else {
    const wrapToken = flowTokens.find((token) => FLEX_WRAPS.includes(token));
    if (wrapToken) {
      wrap = wrapToken;
    }
  }
  return wrap === 'nowrap' ? direction : `${direction} ${wrap}`;
}

// Layout props owned by dedicated controls (Display + Direction + Gap) — kept out of the
// generic property-row list so they aren't shown twice. Gap covers all three spellings:
// the modern longhands, the legacy `grid-*` aliases, and the shorthand — otherwise a rule
// using `row-gap` got a second, generic row for it beside the Gap control.
const LAYOUT_CONTROL_PROPS = new Set([
  'display',
  'vertical-align',
  'flex-flow',
  'flex-direction',
  'flex-wrap',
  'gap',
  'row-gap',
  'column-gap',
  'grid-gap',
  'grid-row-gap',
  'grid-column-gap',
]);

// Properties that can only apply as raw CSS — Webflow exposes no Designer API to
// populate its native Transitions UI, so `transition` (and its longhands) always
// write to the embed (custom code) rather than the native class.
const EMBED_ONLY_PROPS = new Set([
  'transition',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
]);
// Effects props owned by dedicated controls in EffectsSection — kept out of the
// generic fall-through rows (like TYPOGRAPHY_CONTROL_PROPS).
const EFFECTS_CONTROL_PROPS = new Set([
  'mix-blend-mode',
  'opacity',
  'outline-style',
  'outline-width',
  'outline-offset',
  'outline-color',
  'box-shadow',
  'transform',
  'filter',
  'backdrop-filter',
  'clip-path',
  '-webkit-clip-path',
  'cursor',
  'pointer-events',
  // The Transitions layered editor owns the shorthand + all its longhands.
  'transition',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'transition-behavior',
]);

// Typography props owned by dedicated controls in TypographySection — kept out of the
// generic row list. Anything else in the section (text-shadow, -webkit-text-stroke,
// …) still renders as a generic row below.
const TYPOGRAPHY_CONTROL_PROPS = new Set([
  'font-family',
  'font-weight',
  'font-size',
  'line-height',
  'color',
  'text-align',
  'letter-spacing',
  'text-indent',
  'column-count',
  'font-style',
  'text-transform',
  'direction',
  // The Decor bar + its "…" popover (line via the shorthand; thickness / skip-ink longhands).
  'text-decoration',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-color',
  'text-decoration-thickness',
  'text-decoration-skip-ink',
  // The Breaking row (Word / Line dropdowns) + the Wrap row.
  'word-break',
  'white-space',
  'overflow-wrap',
  // The multi-column "…" popover (Gap / divider rule / span).
  'column-gap',
  'column-rule-style',
  'column-rule-width',
  'column-rule-color',
  'column-span',
  // The Truncate / Stroke / Text-shadows rows.
  'text-overflow',
  '-webkit-text-stroke',
  '-webkit-text-stroke-width',
  '-webkit-text-stroke-color',
  'text-shadow',
]);

// The flex Direction control — only rendered when `display` is flex. Writes the
// `flex-direction` + `flex-wrap` longhands; the label clears them (and any legacy
// `flex-flow`).
function DirectionRow({
  read,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  return (
    <div className="embed-editor_size-row">
      <GroupLabel
        label="Direction"
        props={['flex-flow', 'flex-direction', 'flex-wrap']}
        read={read}
        busy={busy}
        onClear={() => clearProp(['flex-flow', 'flex-direction', 'flex-wrap'])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <DirectionControl
        value={currentFlexFlow(read)}
        rawDirection={rawEffective(read('flex-direction')).value}
        important={rawEffective(read('flex-direction')).important}
        busy={busy}
        onCommit={(direction, wrap) => {
          // Two longhand writes: safe together — native ops serialize, and two edits
          // to one embed rule both land before either save.
          setProp('flex-direction', direction, false);
          setProp('flex-wrap', wrap, false);
        }}
        onCommitCustom={(value, important) => setProp('flex-direction', value, important)}
      />
    </div>
  );
}

// The flex Align control — only rendered when `display` is flex. Its X / Y dropdowns
// write `justify-content` / `align-items` (mapped to the screen axis via the current
// flex-direction), and each carries its own clearable label so the two axes reset
// independently; the row's "Align" caption is inert.
const ALIGN_PROPS = new Set(['justify-content', 'align-items']);
// Grid props owned by the dedicated GridControls block (and the "Configure grid"
// panel) — kept out of the generic fall-through rows when the element is a grid
// container (they'd otherwise double up). grid-auto-columns/-rows live in Configure grid.
const GRID_CONTROL_PROPS = new Set([
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-flow',
  'grid-auto-columns',
  'grid-auto-rows',
  'justify-items',
  'align-items',
  'justify-content',
  'align-content',
]);

function AlignRow({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const column = currentFlexFlow(read).startsWith('column');
  return (
    <div className="embed-editor_size-row embed-editor_align-row">
      {/* Inert caption — the X / Y labels own clear / provenance per axis. */}
      <FieldLabel
        className="embed-editor_size-label"
        active={false}
        disabled={busy}
        onReset={() => {}}
        tooltip={<PropTip props={['justify-content', 'align-items']} />}
      >
        Align
      </FieldLabel>
      <AlignControl
        justify={effectiveValue(read('justify-content'))}
        align={effectiveValue(read('align-items'))}
        column={column}
        busy={busy}
        read={read}
        onSet={(prop, value) => setProp(prop, value, false)}
        onLive={(prop, value) => liveSetProp(prop, value, false)}
        onClear={(prop) => clearProp(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

const ChevronRightIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path
      d="M6 4l4 4-4 4"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Which layout-mode disclosure a Display value implies. `grid` wins over `inline` for
// `inline-grid`, `flex` over `inline` for `inline-flex`; a custom value (e.g.
// `grid !important`, `var(--grid)`) matches by substring so it still opens its section.
function layoutMode(display: string): 'grid' | 'flex' | 'inline' | undefined {
  const lowered = display.toLowerCase();
  if (lowered.includes('grid')) {
    return 'grid';
  }
  if (lowered.includes('flex')) {
    return 'flex';
  }
  if (lowered.includes('inline')) {
    return 'inline';
  }
  return undefined;
}

// A collapsible disclosure (Webflow's "More alignment options" button): a full-width
// header whose chevron rotates open to reveal its rows.
function LayoutDisclosure({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`embed-editor_disclosure ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="embed-editor_disclosure-btn"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={`embed-editor_disclosure-arrow ${open ? 'is-open' : ''}`}>
          <ChevronRightIcon />
        </span>
        <span className="embed-editor_disclosure-label">{label}</span>
      </button>
      {open ? <div className="embed-editor_disclosure-body">{children}</div> : undefined}
    </div>
  );
}

// Flex / Grid / Inline settings as collapsible disclosures. All three always render
// (nothing is hidden by Display); changing Display auto-opens the matching one and
// closes the others, while each stays hand-toggleable between Display changes.
interface LayoutRowProps {
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}

function LayoutModeSections({
  liveSetProp,
  activeSelector,
  ...rowProps
}: LayoutRowProps & {
  liveSetProp: LiveSetProp;
  activeSelector: string;
}) {
  const { read, busy, setProp, clearProp, onProvenance, onSelectSelector } = rowProps;
  const display = effectiveValue(read('display'));
  const mode = layoutMode(display);
  const [open, toggle] = useLayoutModeOpen(mode);
  // A gap set in ANY spelling keeps the Gap row visible (it reads all of them).
  const hasGridGap = ['row-gap', 'column-gap', 'grid-row-gap', 'grid-column-gap', 'gap'].some(
    (prop) => read(prop) !== undefined,
  );
  return (
    <>
      <LayoutDisclosure label="Flex settings" open={open.flex} onToggle={() => toggle('flex')}>
        <DirectionRow {...rowProps} />
        <AlignRow {...rowProps} liveSetProp={liveSetProp} />
      </LayoutDisclosure>
      <LayoutDisclosure label="Grid settings" open={open.grid} onToggle={() => toggle('grid')}>
        <GridControls {...rowProps} liveSetProp={liveSetProp} />
      </LayoutDisclosure>
      {/* Gap is shared by flex + grid — always mounted (keeps its link-toggle state),
          shown whenever the element is a flex/grid container. */}
      <GapControl
        key={activeSelector}
        show={mode === 'flex' || mode === 'grid' || hasGridGap}
        {...rowProps}
        liveSetProp={liveSetProp}
      />
      <LayoutDisclosure
        label="Inline settings"
        open={open.inline}
        onToggle={() => toggle('inline')}
      >
        {/* Align Y = vertical-align: the inline-level alignment property. Dimmed unless
            Display is inline-level or table-cell, where it actually applies. */}
        <VerticalAlignRow
          resolved={read('vertical-align')}
          dimmed={!VALIGN_DISPLAYS.has(display || 'block')}
          busy={busy}
          setProp={setProp}
          clearProp={clearProp}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
      </LayoutDisclosure>
    </>
  );
}

// Which disclosures are open. Changing Display's mode opens the matching one and
// closes the others; hand-toggles persist between changes.
function useLayoutModeOpen(mode: ReturnType<typeof layoutMode>) {
  const [open, setOpen] = useState({
    flex: mode === 'flex',
    grid: mode === 'grid',
    inline: mode === 'inline',
  });
  useEffect(() => {
    setOpen({ flex: mode === 'flex', grid: mode === 'grid', inline: mode === 'inline' });
  }, [mode]);
  const toggle = (key: 'flex' | 'grid' | 'inline') =>
    setOpen((previous) => ({ ...previous, [key]: !previous[key] }));
  return [open, toggle] as const;
}

// ─────────────────────────── Style card ───────────────────────────

// One entry in the source dropdown: the Webflow class layer, or a specific embed.
// `value` is 'native' or the embed's key; `marked` dots embeds that already carry
// a rule for this element; `fromComponent` flags a component-shared embed.
type SourceOption = {
  value: string;
  label: string;
  marked?: boolean;
  fromComponent?: boolean;
  /** A non-selectable component subheader grouping the embeds beneath it. */
  heading?: boolean;
  /** Nested under a component subheader (indented in the list). */
  indent?: boolean;
  /** Full name shown on the closed trigger (e.g. "Global Styles #1"), while the
   *  list row stays the group-scoped "Embed #1". */
  triggerLabel?: string;
};

// A selector the element can be targeted by, offered as an autocomplete suggestion:
// its tag, each class, each data attribute (presence then valued), and its combo
// class chains.
type SelectorSuggestion = {
  selector: string;
  kind: 'tag' | 'class' | 'attribute' | 'attribute-value' | 'combo';
};

// Every class in the project, kept in step with the app (the same list the Settings
// panel's class field autocompletes from).
function useProjectClasses(): string[] {
  const [list, setList] = useState<string[]>(() => getHost().projectClasses ?? []);
  useEffect(() => {
    const sync = () =>
      setList((previous) => {
        const next = getHost().projectClasses ?? [];
        return next.length === previous.length && next.every((name, i) => name === previous[i])
          ? previous
          : next;
      });
    sync();
    return onHostChange(sync);
  }, []);
  return list;
}
// How many project-wide classes the suggestion list will show for one query — enough
// to pick from, few enough that the list stays a list.
const PROJECT_CLASS_LIMIT = 30;

const SUGGESTION_KIND_LABEL: Record<SelectorSuggestion['kind'], string> = {
  tag: 'tag',
  class: 'class',
  attribute: 'attribute',
  'attribute-value': 'attribute',
  combo: 'combo',
};

// A selector made only from tags, universal selectors, and pseudos describes a
// project-wide group rather than this element's identity. A class, id, or attribute
// anywhere in the selector (including inside `:is(...)`) makes it specific.
function isGlobalSelector(text: string): boolean {
  return !/[.#[]/.test(text);
}

type ClassifiedSelector = {
  readonly selector: MatchedSelector;
  readonly global: boolean;
  readonly inherited: boolean;
};

function classifySelector(selector: MatchedSelector): ClassifiedSelector {
  const inherited = selectorDependsOnAncestor(selector.text);
  return {
    selector,
    // Parent-qualified selectors have the more useful category when the two
    // definitions overlap, so each reveal control owns a disjoint list.
    global: !inherited && isGlobalSelector(selector.text),
    inherited,
  };
}

function selectorAccessibleLabel(entry: ClassifiedSelector, label: string): string {
  const categories: string[] = [];
  if (entry.global) {
    categories.push('global');
  }
  if (entry.inherited) {
    categories.push('inherited');
  }
  if (entry.selector.fromComponent) {
    categories.push('component');
  }
  if (categories.length === 0) {
    return label;
  }
  return `${label}, ${categories.join(' and ')} selector`;
}

// The selector picker: a chip per selector that styles the element (its own
// classes, stateful, and complex/ancestor selectors), plus an input to add a new
// one. Clicking a chip makes it the edit target (like clicking a combo class);
// the active selector's chip is highlighted, a not-yet-created one dashed. The
// input offers an autocomplete list of the element's targetable selectors:
// ↑/↓ move, Enter applies the highlighted one (or the typed text), Tab fills it
// into the input to keep typing.
type SelectorPickerProps = {
  selectors: MatchedSelector[];
  suggestions: SelectorSuggestion[];
  activeSelector: string;
  /** True when the active selector is one the user clicked or typed, rather than
   *  the panel's auto-composed default. */
  activePicked: boolean;
  busy: boolean;
  /** Still scanning — the chips that will fill this well are on their way. */
  loading: boolean;
  onSelect: (selector: string) => void;
  onDeselect: () => void;
  onAdd: (selector: string) => void;
  onVisibleSelectorsChange?: (selectors: readonly string[]) => void;
};

export function SelectorPicker({
  selectors,
  suggestions,
  activeSelector,
  activePicked,
  busy,
  loading,
  onSelect,
  onDeselect,
  onAdd,
  onVisibleSelectorsChange,
}: SelectorPickerProps) {
  const view = useSelectorView({
    selectors,
    activeSelector,
    activePicked,
    onVisibleSelectorsChange,
  });
  const field = useAddSelectorField({
    selectors,
    suggestions,
    activeSelector,
    busy,
    onSelect,
    onDeselect,
    onAdd,
  });
  const { add, showInput } = field;

  return (
    <>
      <div className="embed-editor_selectors">
        {/* One grey well wraps the selector tags; clicking empty space reveals the add
          input at its bottom (the input has no chrome of its own). */}
        <div className="embed-editor_selector-well" onMouseDown={field.onWellMouseDown}>
          {/* Nothing to show yet and the scan still running: the well would read as
            "this element has no selectors", which is a different (and wrong) answer
            than "not counted yet". A spinner where the first chip will land says
            which one it is, and holds the box's height so nothing jumps when the
            chips arrive. */}
          {loading && !view.shownSelectors.length ? (
            <div className="embed-editor_selector-loading" aria-live="polite">
              <SpinnerIcon />
              <span className="u-sr-only">Finding the selectors that style this element…</span>
            </div>
          ) : undefined}
          {view.shownSelectors.length ? (
            <SelectorChips
              entries={view.shownSelectors}
              activeSelector={activeSelector}
              busy={busy}
              onSelect={onSelect}
              onDeselect={onDeselect}
            />
          ) : undefined}
          {showInput ? (
            <SelectorAddField
              add={add}
              inputRef={field.inputRef}
              listRef={field.listRef}
              busy={busy}
              onFocus={field.onFocus}
              onBlur={field.onBlur}
              apply={field.apply}
            />
          ) : undefined}
        </div>
      </div>
      <SelectorFilterToggles view={view} busy={busy} />
    </>
  );
}

// Keep the highlighted row visible while arrowing through a long list.
function useHighlightInView({
  listRef,
  highlight,
  showList,
}: {
  listRef: React.RefObject<HTMLDivElement>;
  highlight: number;
  showList: boolean;
}) {
  useEffect(() => {
    if (!showList || highlight < 0) {
      return;
    }
    const element = listRef.current?.children[highlight];
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight, showList, listRef]);
}

// The add-selector field's state: the draft, the suggestion list and its highlight,
// whether the input is revealed, and the selector to restore when the field is left
// without adding one.
function useAddSelectorField({
  selectors,
  suggestions,
  activeSelector,
  busy,
  onSelect,
  onDeselect,
  onAdd,
}: Pick<
  SelectorPickerProps,
  'selectors' | 'suggestions' | 'activeSelector' | 'busy' | 'onSelect' | 'onDeselect' | 'onAdd'
>) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [inputOpen, setInputOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  // The selector that was active when the add input took focus — restored on blur
  // if no new selector was added (cleared once one is, or a chip is clicked instead).
  const restoreRef = useRef<string | undefined>(undefined);

  // The add input stays hidden until you click into the well (like Webflow's Style
  // selector) — including while selectors are still loading, so the empty box shows
  // as just the black well (with its min-height) rather than an add-selector field.
  const showInput = inputOpen;
  const filtered = useSelectorSuggestions({ selectors, suggestions, draft });
  const showList = open && filtered.length > 0;

  // Keep the highlighted row visible while arrowing through a long list.
  useHighlightInView({ listRef, highlight, showList });

  // Focus the input once it's revealed by a well click (it may have just mounted).
  useEffect(() => {
    if (showInput && wantFocus.current) {
      wantFocus.current = false;
      inputRef.current?.focus();
    }
  }, [showInput]);

  const onWellMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!wellMouseDown(event, { busy, inputRef }, restoreRef)) {
      return;
    }
    if (showInput) {
      inputRef.current?.focus();
    } else {
      wantFocus.current = true;
      setInputOpen(true);
    }
  };
  const apply = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    restoreRef.current = undefined; // a new selector is now the active one — nothing to restore
    onAdd(trimmed);
    setDraft('');
    setOpen(false);
    setHighlight(-1);
  };
  const onFocus = () => {
    restoreRef.current = activeSelector || undefined;
    onDeselect();
    setOpen(true);
  };
  const onBlur = () => {
    setOpen(false);
    setDraft('');
    setHighlight(-1);
    setInputOpen(false);
    if (restoreRef.current) {
      onSelect(restoreRef.current);
      restoreRef.current = undefined;
    }
  };
  const add = { draft, setDraft, open, setOpen, highlight, setHighlight, filtered, showList };
  return { add, showInput, listRef, inputRef, onWellMouseDown, apply, onFocus, onBlur };
}

// Clicking empty space in the well reveals + focuses the add input; clicks on a chip
// (select/deselect), the input, or the suggestion list are left alone. Returns whether
// the add input should be revealed.
function wellMouseDown(
  event: ReactMouseEvent<HTMLDivElement>,
  well: { busy: boolean; inputRef: React.RefObject<HTMLInputElement> },
  restoreRef: React.MutableRefObject<string | undefined>,
): boolean {
  if (well.busy) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  // Clicking a chip selects/deselects it — don't let the input's blur restore the
  // previously-active selector over that choice.
  if (target.closest('.embed-editor_selector-chip')) {
    restoreRef.current = undefined;
    return false;
  }
  if (target.closest('.embed-editor_selector-suggest')) {
    return false;
  }
  const input = well.inputRef.current;
  if (input && target === input) {
    return false;
  }
  event.preventDefault(); // keep focus on the input rather than blurring it
  return true;
}

type SelectorView = ReturnType<typeof useSelectorView>;

// Broad selectors are folded away behind category toggles. A selector the user picked
// stays visible so the editor below always has an understandable target. The texts
// shown are reported to `onVisibleSelectorsChange`.
function useSelectorView({
  selectors,
  activeSelector,
  activePicked,
  onVisibleSelectorsChange,
}: Pick<SelectorPickerProps, 'selectors' | 'activeSelector' | 'activePicked'> & {
  onVisibleSelectorsChange: SelectorPickerProps['onVisibleSelectorsChange'] | undefined;
}) {
  const [showGlobals, setShowGlobals] = useState(false);
  const [showInherited, setShowInherited] = useState(false);
  const classified = useMemo(() => selectors.map(classifySelector), [selectors]);
  const globals = useMemo(() => classified.filter((entry) => entry.global), [classified]);
  const inherited = useMemo(() => classified.filter((entry) => entry.inherited), [classified]);
  const shownSelectors = useMemo(
    () =>
      classified.filter((entry) => {
        const picked = activePicked && selectorsMatch(entry.selector.text, activeSelector);
        const globalVisible = !entry.global || showGlobals;
        const inheritedVisible = !entry.inherited || showInherited;
        return picked || (globalVisible && inheritedVisible);
      }),
    [classified, showGlobals, showInherited, activeSelector, activePicked],
  );
  const visibleSelectorTexts = useMemo(
    () => shownSelectors.map((entry) => entry.selector.text),
    [shownSelectors],
  );
  useEffect(() => {
    onVisibleSelectorsChange?.(visibleSelectorTexts);
  }, [onVisibleSelectorsChange, visibleSelectorTexts]);
  return {
    globals,
    inherited,
    shownSelectors,
    showGlobals,
    setShowGlobals,
    showInherited,
    setShowInherited,
  };
}

// The element's own tokens first — they're what you're usually reaching for — then,
// once you've typed something, every other class in the project (the Settings panel's
// list), so styling a class this element doesn't carry yet is a matter of typing its
// first letters. They're held back while the box is empty: a project's whole class
// list would bury the handful that describe this element. Selectors already in the
// well aren't suggestions — picking one would just be the chip that's already sitting
// above the input.
function useSelectorSuggestions({
  selectors,
  suggestions,
  draft,
}: Pick<SelectorPickerProps, 'selectors' | 'suggestions'> & { draft: string }) {
  const projectClasses = useProjectClasses();
  const query = draft.trim().toLowerCase();
  const chipKeys = useMemo(
    () => new Set(selectors.map((entry) => selectorKey(entry.text))),
    [selectors],
  );
  return useMemo(() => {
    const own = suggestions.filter(
      (suggestion) =>
        (!query || suggestion.selector.toLowerCase().includes(query)) &&
        !chipKeys.has(selectorKey(suggestion.selector)),
    );
    if (!query) {
      return own;
    }
    const taken = new Set(own.map((suggestion) => suggestion.selector));
    const extra: SelectorSuggestion[] = [];
    for (const cls of projectClasses) {
      const selector = `.${cls}`;
      if (taken.has(selector) || chipKeys.has(selectorKey(selector))) {
        continue;
      }
      if (!cls.toLowerCase().includes(query.replace(/^\./, ''))) {
        continue;
      }
      taken.add(selector);
      extra.push({ selector, kind: 'class' });
      if (extra.length >= PROJECT_CLASS_LIMIT) {
        break;
      }
    }
    return [...own, ...extra];
  }, [suggestions, projectClasses, query, chipKeys]);
}

function SelectorChips({
  entries,
  activeSelector,
  busy,
  onSelect,
  onDeselect,
}: {
  entries: ClassifiedSelector[];
  activeSelector: string;
  busy: boolean;
  onSelect: (selector: string) => void;
  onDeselect: () => void;
}) {
  return (
    <div className="embed-editor_selector-chips">
      {entries.map((entry) => {
        const selectorText = entry.selector;
        const active = selectorsMatch(selectorText.text, activeSelector);
        const dimmed = selectorText.inContext === false;
        // Nested rules show their nesting (`.hero { .title }`); selection/matching
        // still uses the resolved selector (sel.text).
        const label = selectorText.display ?? selectorText.text;
        return (
          <button
            key={selectorText.key}
            type="button"
            className={chipClassName(entry, { active, dimmed })}
            disabled={busy}
            aria-pressed={active}
            aria-label={selectorAccessibleLabel(entry, label)}
            // Click the active chip again to deselect (show all winners read-only).
            onClick={() => (active ? onDeselect() : onSelect(selectorText.text))}
            title={chipTitle(label, entry, { active, dimmed })}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

interface ChipState {
  readonly active: boolean;
  readonly dimmed: boolean;
}

function chipClassName(entry: ClassifiedSelector, state: ChipState): string {
  return [
    'embed-editor_selector-chip',
    state.active && 'is-active',
    entry.selector.pending && 'is-pending',
    entry.selector.fromComponent && 'is-component',
    entry.global && 'is-global',
    entry.inherited && 'is-inherited',
    state.dimmed && 'is-dimmed',
  ]
    .filter(Boolean)
    .join(' ');
}

function chipTitle(label: string, entry: ClassifiedSelector, state: ChipState): string {
  if (state.active) {
    return `${label} — click to deselect`;
  }
  if (state.dimmed) {
    return `${label} — styled in another query`;
  }
  return entry.selector.pending ? `${label} — no styles yet` : label;
}

interface AddSelectorState {
  draft: string;
  setDraft: (draft: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  highlight: number;
  setHighlight: React.Dispatch<React.SetStateAction<number>>;
  filtered: SelectorSuggestion[];
  showList: boolean;
}

// The add input and its suggestion list.
function SelectorAddField({
  add,
  inputRef,
  listRef,
  busy,
  onFocus,
  onBlur,
  apply,
}: {
  add: AddSelectorState;
  inputRef: React.RefObject<HTMLInputElement>;
  listRef: React.RefObject<HTMLDivElement>;
  busy: boolean;
  onFocus: () => void;
  onBlur: () => void;
  apply: (text: string) => void;
}) {
  const { draft, highlight, setHighlight, filtered, showList } = add;
  return (
    <div className="embed-editor_selector-field">
      <input
        ref={inputRef}
        className="u-input embed-editor_selector-add"
        value={draft}
        placeholder="Add a selector (e.g. .card:hover)"
        spellCheck={false}
        disabled={busy}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        // Focusing the add field clears the active pick — you're composing a new
        // selector, so the panel drops back to showing all winners read-only. Stash
        // the previously-active selector to restore if you leave without adding one.
        onFocus={onFocus}
        // On blur the half-typed selector is abandoned: clicking away from it is
        // not a way of adding one (Enter and the suggestion list are), and text
        // left sitting in a collapsed-looking field reads as applied. Clear it,
        // collapse the input, and re-select whatever was active before focus.
        onBlur={onBlur}
        onChange={(event) => {
          add.setDraft(event.target.value);
          add.setOpen(true);
          setHighlight(-1);
        }}
        onKeyDown={(event) => selectorKeyDown(event, add, apply)}
        aria-label="Add a selector"
      />
      {showList ? (
        <div
          className="embed-editor_selector-suggest"
          ref={listRef}
          role="listbox"
          aria-label="Selector suggestions"
        >
          {filtered.map((suggestion, i) => (
            <button
              key={`${suggestion.kind}:${suggestion.selector}`}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className={`embed-editor_suggest-item ${i === highlight ? 'is-active' : ''}`}
              // Keep the input focused so its blur doesn't close the list before the click.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setHighlight(i)}
              onClick={() => apply(suggestion.selector)}
            >
              <span className="embed-editor_suggest-sel">{suggestion.selector}</span>
              <span className="embed-editor_suggest-kind">
                {SUGGESTION_KIND_LABEL[suggestion.kind]}
              </span>
            </button>
          ))}
        </div>
      ) : undefined}
    </div>
  );
}

// The add input's keys: ↓/↑ move the highlight (opening the list), Enter adds the
// highlighted suggestion or the typed text, Tab fills the highlighted (or first)
// suggestion in to keep editing, Escape closes the list.
function selectorKeyDown(
  event: ReactKeyboardEvent<HTMLInputElement>,
  add: AddSelectorState,
  apply: (text: string) => void,
) {
  const { highlight, filtered, showList } = add;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    add.setOpen(true);
    add.setHighlight((previous) => Math.min(previous + 1, filtered.length - 1));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    add.setHighlight((previous) => Math.max(previous - 1, -1));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const highlighted = showList && highlight >= 0 ? filtered[highlight] : undefined;
    apply(highlighted ? highlighted.selector : add.draft);
  } else if (event.key === 'Tab') {
    // Fill the highlighted (or first) suggestion into the input to keep editing.
    const pick = highlight >= 0 ? filtered[highlight] : filtered[0];
    if (showList && pick) {
      event.preventDefault();
      add.setDraft(pick.selector);
      add.setHighlight(-1);
    }
  } else if (event.key === 'Escape' && add.open) {
    event.preventDefault();
    add.setOpen(false);
    add.setHighlight(-1);
  }
}

// Outside the well's box — a view option, not one of the selectors. Always here, even
// with none to show: appearing when the scan lands moved everything under it down a
// row, so the panel rearranged itself under the pointer just as it became usable.
// With nothing to reveal it sits inert instead.
function SelectorFilterToggles({ view, busy }: { view: SelectorView; busy: boolean }) {
  const { globals, inherited } = view;
  return (
    <>
      <label
        className={
          'embed-editor_check embed-editor_selector-filter ' + (globals.length ? '' : 'is-empty')
        }
        title="Tags, universal selectors, and broad states can match many elements"
      >
        <input
          type="checkbox"
          checked={view.showGlobals && globals.length > 0}
          disabled={busy || !globals.length}
          onChange={(event) => view.setShowGlobals(event.target.checked)}
        />
        <span>Show global selectors ({globals.length})</span>
      </label>
      <label
        className={
          'embed-editor_check embed-editor_selector-filter ' + (inherited.length ? '' : 'is-empty')
        }
        title="Selectors that apply because this element is inside a matching parent or ancestor"
      >
        <input
          type="checkbox"
          checked={view.showInherited && inherited.length > 0}
          disabled={busy || !inherited.length}
          onChange={(event) => view.setShowInherited(event.target.checked)}
        />
        <span>Show inherited styles ({inherited.length})</span>
      </label>
    </>
  );
}

// What somebody typed, as a query. A bare condition is the common shorthand and
// means @media — `(width < 40em)` and `width < 40em` both do.
function asQuery(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('@')) {
    return trimmed;
  }
  return trimmed.startsWith('(') ? `@media ${trimmed}` : `@media (${trimmed})`;
}

// Sentinel option value for the "Add query" row in the context dropdown — a real
// context key is '' or an `@…` / `bp:…` string, so this can't collide.
const ADD_QUERY = '\0add-query';

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M8 3.5v9M3.5 8h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

const QUERY_MODES: SegmentedOption<'wrap' | 'nest'>[] = [
  { value: 'wrap', label: 'Wrap', tooltip: 'New block — @query { selector { … } }' },
  { value: 'nest', label: 'Nest', tooltip: 'Inside the selector — selector { @query { … } }' },
];

type QuerySuggestion = { query: string; kind: string };

// Common queries offered after any already used in the project — user-preference,
// interaction, orientation/aspect-ratio, container, and feature queries.
const COMMON_QUERIES: QuerySuggestion[] = [
  { query: '@media (hover: hover)', kind: 'hover' },
  { query: '@media (pointer: coarse)', kind: 'touch' },
  { query: '@media (pointer: fine)', kind: 'pointer' },
  { query: '@media (prefers-color-scheme: dark)', kind: 'dark mode' },
  { query: '@media (prefers-color-scheme: light)', kind: 'light mode' },
  { query: '@media (prefers-reduced-motion: reduce)', kind: 'reduced motion' },
  { query: '@media (prefers-contrast: more)', kind: 'contrast' },
  { query: '@media (orientation: landscape)', kind: 'orientation' },
  { query: '@media (orientation: portrait)', kind: 'orientation' },
  { query: '@media (min-aspect-ratio: 16 / 9)', kind: 'aspect ratio' },
  { query: '@container (width < 50em)', kind: 'container' },
  { query: '@container (width > 30em)', kind: 'container' },
  { query: '@media (min-width: 48em)', kind: 'width' },
  { query: '@media (max-width: 47.99em)', kind: 'width' },
  { query: '@supports (display: grid)', kind: 'supports' },
];

// A query field: type anything, with every query in the project (and a curated set
// of common ones) offered underneath. Free text is the point — the list is a
// shortcut, never a menu of the only allowed answers — so submitting takes what
// is typed unless a suggestion is explicitly highlighted.
interface QueryComboProps {
  draft: string;
  setDraft: (next: string) => void;
  onSubmit: (query: string) => void;
  onCancel: () => void;
  suggestions: QuerySuggestion[];
  ariaLabel: string;
  /** The query the field opened on, if it opened on one — a whole query rather
   *  than the start of one being typed. */
  initial?: string;
  /** Select the whole value on mount (editing) instead of parking the caret at
   *  the end of it (adding, where the value so far is just `@`). */
  selectOnFocus?: boolean;
}
function QueryCombo(props: QueryComboProps) {
  const { draft, setDraft, onSubmit, onCancel, suggestions, ariaLabel } = props;
  const { initial = '', selectOnFocus = false } = props;
  const [open, setOpen] = useState(true);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useFocusOnMount({ inputRef, selectOnFocus });

  const filtered = useMemo(
    () => filteredQueries(suggestions, draft, initial),
    [suggestions, draft, initial],
  );
  const showList = open && filtered.length > 0;
  useHighlightInView({ listRef, highlight, showList });

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && trimmed !== '@') {
      onSubmit(trimmed);
    }
  };
  const combo = { draft, setDraft, open, setOpen, highlight, setHighlight, filtered, showList };

  return (
    <div className="embed-editor_add-query-field">
      <input
        ref={inputRef}
        className="u-input embed-editor_add-query-input"
        value={draft}
        placeholder="@media (width < 50em)"
        spellCheck={false}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setDraft(event.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onKeyDown={(event) => queryKeyDown(event, combo, { submit, onCancel })}
        aria-label={ariaLabel}
      />
      {showList ? (
        <QuerySuggestionList
          listRef={listRef}
          filtered={filtered}
          highlight={highlight}
          setHighlight={setHighlight}
          submit={submit}
        />
      ) : undefined}
    </div>
  );
}

// Focus the field on mount: select the whole value (editing), or park the caret at
// its end (adding).
function useFocusOnMount({
  inputRef,
  selectOnFocus,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  selectOnFocus: boolean;
}) {
  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (selectOnFocus) {
      input.select();
    } else {
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [selectOnFocus, inputRef]);
}

function QuerySuggestionList({
  listRef,
  filtered,
  highlight,
  setHighlight,
  submit,
}: {
  listRef: React.RefObject<HTMLDivElement>;
  filtered: QuerySuggestion[];
  highlight: number;
  setHighlight: (index: number) => void;
  submit: (text: string) => void;
}) {
  return (
    <div
      className="embed-editor_selector-suggest"
      ref={listRef}
      role="listbox"
      aria-label="Query suggestions"
    >
      {filtered.map((suggestion, i) => (
        <button
          key={`${suggestion.kind}:${suggestion.query}`}
          type="button"
          role="option"
          aria-selected={i === highlight}
          className={`embed-editor_suggest-item ${i === highlight ? 'is-active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setHighlight(i)}
          onClick={() => submit(suggestion.query)}
        >
          <span className="embed-editor_suggest-sel">{suggestion.query}</span>
          <span className="embed-editor_suggest-kind">{suggestion.kind}</span>
        </button>
      ))}
    </div>
  );
}

// Filtering is for narrowing a query being typed. A field holding a WHOLE query — the
// one being renamed, or a suggestion just picked — has nothing left to narrow:
// matching it against itself leaves a list of one, hiding the very queries you opened
// the field to switch to. So a complete query shows them all.
function filteredQueries(
  suggestions: QuerySuggestion[],
  draft: string,
  initial: string,
): QuerySuggestion[] {
  const query = draft.trim().toLowerCase();
  const whole =
    query === initial.trim().toLowerCase() ||
    suggestions.some((suggestion) => suggestion.query.toLowerCase() === query);
  if (!query || query === '@' || whole) {
    return suggestions;
  }
  return suggestions.filter((suggestion) => suggestion.query.toLowerCase().includes(query));
}

// The query field's keys: ↓/↑ move the highlight (opening the list), Enter submits the
// highlighted suggestion or the typed query, Tab fills the highlighted (or first)
// suggestion in, Escape closes the list and then cancels the form.
function queryKeyDown(
  event: ReactKeyboardEvent<HTMLInputElement>,
  combo: {
    draft: string;
    setDraft: (next: string) => void;
    open: boolean;
    setOpen: (open: boolean) => void;
    highlight: number;
    setHighlight: React.Dispatch<React.SetStateAction<number>>;
    filtered: QuerySuggestion[];
    showList: boolean;
  },
  actions: { submit: (text: string) => void; onCancel: () => void },
) {
  const { highlight, filtered, showList } = combo;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    combo.setOpen(true);
    combo.setHighlight((previous) => Math.min(previous + 1, filtered.length - 1));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    combo.setHighlight((previous) => Math.max(previous - 1, -1));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const highlighted = showList && highlight >= 0 ? filtered[highlight] : undefined;
    actions.submit(highlighted ? highlighted.query : combo.draft);
  } else if (event.key === 'Tab') {
    const pick = highlight >= 0 ? filtered[highlight] : filtered[0];
    if (showList && pick) {
      event.preventDefault();
      combo.setDraft(pick.query);
      combo.setHighlight(-1);
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (combo.open && combo.draft.trim() !== '@') {
      combo.setOpen(false);
    } else {
      actions.onCancel();
    }
  }
}

// Inline form to add a custom query (@media/@container/@supports) to the current
// selector, choosing whether it WRAPS the selector (a new at-rule block) or NESTS
// inside the selector's existing rule (CSS nesting). Nesting needs a picked selector.
// The controls sit ABOVE the input so the suggestion list (opened below it) can't
// cover them; the input pre-fills `@` and offers project + common queries.
function AddQueryForm({
  canNest,
  suggestions,
  onAdd,
  onCancel,
}: {
  canNest: boolean;
  suggestions: QuerySuggestion[];
  onAdd: (query: string, mode: 'wrap' | 'nest') => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState('@');
  const [mode, setMode] = useState<'wrap' | 'nest'>('nest');
  const submit = (text: string) => onAdd(text, canNest ? mode : 'wrap');

  return (
    <div className="embed-editor_add-query">
      <div className="embed-editor_add-query-controls">
        <SegmentedControl
          className="embed-editor_add-query-mode"
          options={QUERY_MODES}
          value={canNest ? mode : 'wrap'}
          onChange={setMode}
          ariaLabel="How to add the query"
          disabled={!canNest}
          widthMode="hug"
        />
        <div className="embed-editor_add-query-actions">
          <button type="button" className="u-button is-ghost is-small" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="u-button is-primary is-small"
            onClick={() => submit(draft)}
            disabled={draft.trim() === '' || draft.trim() === '@'}
          >
            Add
          </button>
        </div>
      </div>
      {!canNest ? (
        <p className="embed-editor_add-query-note">Pick a selector to nest inside it.</p>
      ) : undefined}
      <QueryCombo
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        onCancel={onCancel}
        suggestions={suggestions}
        ariaLabel="Query to add"
      />
    </div>
  );
}

// Rename a query wherever this stylesheet spells it. A breakpoint is one idea
// written in several places — this component's four `@media (width >= 64rem)`
// blocks are one breakpoint — so editing it here rewrites every one of them, and
// the count says how many before you commit to it.
function EditQueryForm({
  query,
  uses,
  sourceLabel,
  suggestions,
  onRename,
  onCancel,
}: {
  query: string;
  uses: number;
  sourceLabel: string;
  suggestions: QuerySuggestion[];
  onRename: (from: string, to: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(query);
  const changed = draft.trim() !== '' && draft.trim() !== '@' && draft.trim() !== query;
  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && trimmed !== '@' && trimmed !== query) {
      onRename(query, trimmed);
    }
  };

  return (
    <div className="embed-editor_add-query is-rename">
      <div className="embed-editor_add-query-controls">
        <span
          className="embed-editor_add-query-count"
          title={`${uses === 1 ? '1 block' : `${uses} blocks`} in ${sourceLabel}`}
        >
          {uses === 1 ? '1 block' : `${uses} blocks`} in {sourceLabel}
        </span>
        <div className="embed-editor_add-query-actions">
          <button type="button" className="u-button is-ghost is-small" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="u-button is-primary is-small"
            onClick={() => submit(draft)}
            disabled={!changed}
          >
            Rename
          </button>
        </div>
      </div>
      <QueryCombo
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        onCancel={onCancel}
        suggestions={suggestions}
        ariaLabel="Query"
        initial={query}
        selectOnFocus
      />
    </div>
  );
}

function cssRuleMatchesSelector(matched: MatchedRule, selector: string): boolean {
  if (selectorsMatch(matched.rule.selectorText, selector)) {
    return true;
  }
  return matched.matchedSelectors.some((entry) => selectorsMatch(entry.text, selector));
}

function cssRuleMatchesVisibleSelector(
  matched: MatchedRule,
  visibleSelectors: readonly string[],
): boolean {
  return visibleSelectors.some((selector) => cssRuleMatchesSelector(matched, selector));
}

function cssSelectorLine(
  line: string,
  lineFrom: number,
  matchedRanges: readonly CssRuleRange[],
): ReactNode {
  const segments: ReactNode[] = [];
  let cursor = 0;
  for (const range of matchedRanges) {
    const from = Math.max(0, range.from - lineFrom);
    const to = Math.min(line.length, range.to - lineFrom);
    if (to <= from) {
      continue;
    }
    if (from > cursor) {
      segments.push(
        <span key={`plain:${cursor}`} className="embed-editor_css-code-selector-unmatched">
          {line.slice(cursor, from)}
        </span>,
      );
    }
    segments.push(
      <span key={`matched:${from}`} className="embed-editor_css-code-selector">
        {line.slice(from, to)}
      </span>,
    );
    cursor = to;
  }
  if (cursor < line.length) {
    segments.push(
      <span key={`plain:${cursor}`} className="embed-editor_css-code-selector-unmatched">
        {line.slice(cursor)}
      </span>,
    );
  }
  return segments;
}

// A code line that is not part of a selector list: a declaration, a rule's opening
// line, or punctuation.
function cssCodeLine(line: string): ReactNode {
  const declaration = line.match(/^(\s*)([-\w]+)(:\s*)(.*?)(;?)$/);
  if (declaration) {
    const [, spacing = '', property = '', colon = '', value = '', semicolon = ''] = declaration;
    return (
      <>
        {spacing}
        <span className="embed-editor_css-code-property">{property}</span>
        <span className="embed-editor_css-code-punctuation">{colon}</span>
        {cssTokens(value).map((token, index) => (
          <span key={`${index}:${token.kind}`} className={`cx-${token.kind}`}>
            {token.text}
          </span>
        ))}
        <span className="embed-editor_css-code-punctuation">{semicolon}</span>
      </>
    );
  }
  const brace = line.lastIndexOf('{');
  if (brace >= 0) {
    const selectorClass = line.trimStart().startsWith('@')
      ? 'embed-editor_css-code-context'
      : 'embed-editor_css-code-selector';
    return (
      <>
        <span className={selectorClass}>{line.slice(0, brace)}</span>
        <span className="embed-editor_css-code-punctuation">{'{'}</span>
      </>
    );
  }
  return <span className="embed-editor_css-code-punctuation">{line || ' '}</span>;
}

function CssCodePreview({ view, ariaLabel }: { view: CssRuleView; ariaLabel: string }) {
  let offset = 0;
  return (
    <pre className="embed-editor_css-code-preview" aria-label={ariaLabel} tabIndex={0}>
      {view.code.split('\n').map((line, index) => {
        const from = offset;
        const to = from + line.length;
        offset = to + 1;
        const overridden = view.highlights.some((range) => range.from < to && range.to > from);
        const selectorList = view.selectorLists.some((range) => range.from < to && range.to > from);
        const matchedRanges = view.selectors.filter((range) => range.from < to && range.to > from);
        return (
          <span
            key={`${index}:${line}`}
            className={`embed-editor_css-code-line ${overridden ? 'is-overridden' : ''}`}
          >
            {selectorList ? cssSelectorLine(line, from, matchedRanges) : cssCodeLine(line)}
          </span>
        );
      })}
    </pre>
  );
}

function EditableCssRule({
  rule,
  busy,
  onSave,
}: {
  readonly rule: ParsedRule;
  readonly busy: boolean;
  readonly onSave: (rule: ParsedRule, css: string) => void;
}) {
  const sourceCss = rule.node.toString();
  const [draft, setDraft] = useState(sourceCss);
  const attemptedDraftRef = useRef<string | undefined>(undefined);
  const previousSourceRef = useRef(sourceCss);

  // External style-panel edits replace a clean draft, while text currently being
  // authored stays untouched. After our own autosave, draft already equals sourceCss.
  useEffect(() => {
    setDraft((current) => (current === previousSourceRef.current ? sourceCss : current));
    previousSourceRef.current = sourceCss;
  }, [sourceCss]);

  // A short pause is the commit boundary. Busy saves serialize naturally: if a
  // newer draft arrives during one write, busy clearing schedules that latest text.
  useEffect(() => {
    if (draft === sourceCss) {
      attemptedDraftRef.current = undefined;
      return;
    }
    if (busy) {
      return;
    }
    if (draft === attemptedDraftRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      attemptedDraftRef.current = draft;
      onSave(rule, draft);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [busy, draft, onSave, rule, sourceCss]);

  return (
    <CodeEditor
      value={draft}
      language="css"
      ariaLabel={`Editable CSS for ${rule.selectorText}; changes save automatically`}
      minHeight="100px"
      onChange={setDraft}
      className="embed-editor_css-code-editor"
    />
  );
}

type CssCodeSectionProps = {
  readonly model: RuleModel;
  readonly activeSelector: string;
  readonly visibleSelectors: readonly string[];
  readonly editableRule: ParsedRule | undefined;
  readonly busy: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSave: (rule: ParsedRule, css: string) => void;
};

function CssCodeHeader({
  open,
  sourceLabel,
  onToggle,
}: {
  readonly open: boolean;
  readonly sourceLabel: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="embed-editor_css-code-header embed-editor_css-code-toggle"
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} CSS Code`}
      onClick={onToggle}
    >
      <span className="embed-editor_css-code-title">CSS Code</span>
      {sourceLabel ? (
        <span className="embed-editor_css-code-source" title={sourceLabel}>
          {sourceLabel}
        </span>
      ) : undefined}
      <span className="embed-editor_css-code-chevron" aria-hidden="true">
        <svg className="embed-editor_section-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4.2 6.2 8 10l3.8-3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}

function CssCodeSection({
  model,
  activeSelector,
  visibleSelectors,
  editableRule,
  busy,
  open,
  onToggle,
  onSave,
}: CssCodeSectionProps) {
  const rules = useMemo(() => {
    const visible = [...model.base, ...model.conditional].filter((rule) =>
      cssRuleMatchesVisibleSelector(rule, visibleSelectors),
    );
    if (!activeSelector) {
      return visible;
    }
    return visible.filter((rule) => cssRuleMatchesSelector(rule, activeSelector));
  }, [model, activeSelector, visibleSelectors]);
  const view = useMemo(() => buildCssRuleView(rules), [rules]);
  const sources = useMemo(() => [...new Set(rules.map((entry) => entry.rule.embedLabel))], [rules]);
  const sourceLabel = activeSelector ? (editableRule?.embedLabel ?? sources.join(', ')) : '';

  return (
    <section className={`embed-editor_css-code ${open ? 'is-open' : 'is-collapsed'}`}>
      <CssCodeHeader open={open} sourceLabel={sourceLabel} onToggle={onToggle} />
      {open ? (
        <div className="embed-editor_css-code-body">
          {activeSelector && editableRule ? (
            <EditableCssRule
              key={editableRule.ruleId}
              rule={editableRule}
              busy={busy}
              onSave={onSave}
            />
          ) : view.code ? (
            <CssCodePreview view={view} ariaLabel="CSS matching this element" />
          ) : (
            <p className="embed-editor_css-code-empty">No matching CSS rules.</p>
          )}
        </div>
      ) : undefined}
    </section>
  );
}

type StyleCardProps = {
  snapshot: ElementSnapshot | undefined;
  selectedSelector: string;
  activePicked: boolean;
  cssCodeOpen: boolean;
  onToggleCssCode: () => void;
  model: RuleModel;
  resolved: ResolvedStyle;
  contexts: StyleContext[];
  contextInfos: ContextInfo[];
  context: ContextKey;
  onContext: (context: ContextKey) => void;
  onAddQuery: (query: string, mode: 'wrap' | 'nest') => void;
  onRenameQuery: (from: string, to: string) => void;
  /** How many blocks in the source stylesheet each query is written in — the
   *  queries it's possible to rename from here, and how much a rename touches. */
  queryUses: Map<string, number>;
  sourceLabel: string;
  querySuggestions: QuerySuggestion[];
  selectors: MatchedSelector[];
  suggestions: SelectorSuggestion[];
  activeSelector: string;
  onSelectActive: (selector: string) => void;
  onDeselect: () => void;
  onAddSelector: (selector: string) => void;
  sourceValue: string;
  sourceOptions: SourceOption[];
  onSourceChange: (value: string) => void;
  sourceNote: string | undefined;
  nativeStyleName: string | undefined;
  /** Still fetching embeds — show a spinner in place of the source picker. */
  loading: boolean;
  /** Still working out which selectors style this element — the well says so
   *  rather than reading as "none". */
  resolving: boolean;
  busy: boolean;
  pending: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  liveSetProp: LiveSetProp;
  onSelectSelector: (selector: string, prop?: string) => void;
  onAdd: (prop: string, value: string, important: boolean) => void;
  onSaveCssRule: (rule: ParsedRule, css: string) => void;
  onRemoveRule: (rule: ParsedRule) => void;
};

function StyleCard(card: StyleCardProps) {
  const { resolved, busy, activeSelector, onSelectSelector } = card;
  const provenance = useProvenance();
  const [visibleSelectors, rememberVisibleSelectors] = useVisibleSelectors();
  const shown = provenance.shown;
  const provenanceResolved = shown ? resolved.props.get(shown.prop) : undefined;

  return (
    <div className="embed-editor_rule u-surface-surface">
      <StyleCardHead card={card} onVisibleSelectorsChange={rememberVisibleSelectors} />
      {card.sourceNote ? <p className="embed-editor_source-note">{card.sourceNote}</p> : undefined}

      <CssCodeSection
        model={card.model}
        activeSelector={activeSelector}
        visibleSelectors={visibleSelectors}
        editableRule={resolved.selectedRule ?? undefined}
        busy={busy}
        open={card.cssCodeOpen}
        onToggle={card.onToggleCssCode}
        onSave={card.onSaveCssRule}
      />

      <StyleSections card={card} openProvenance={provenance.openProvenance} />

      <div className="embed-editor_rule-foot">
        <AddPropertyRow busy={busy} onAdd={card.onAdd} />
      </div>

      {shown && provenanceResolved !== undefined ? (
        <ProvenancePopover
          prop={shown.prop}
          anchor={shown.rect}
          resolved={provenanceResolved}
          onClose={provenance.closeProvenance}
          onAnchorReclick={provenance.suppressProvenanceReopen}
          onSelectSelector={onSelectSelector}
        />
      ) : undefined}
    </div>
  );
}

// The open provenance popover: which prop + the clicked label's rect (so the popover
// anchors to the bottom of that label, not a fixed corner of the card).
function useProvenance() {
  const [shown, setShown] = useState<{ prop: string; rect: DOMRect } | undefined>(undefined);
  // When the popover is closed by pressing its own trigger label again, that
  // label's click must not re-open it — this holds that prop so openProvenance
  // skips the reopen once (toggle).
  const suppressProvenance = useRef<string | undefined>(undefined);
  const openProvenance = useCallback((prop: string, rect: DOMRect) => {
    if (suppressProvenance.current === prop) {
      suppressProvenance.current = undefined;
      return;
    }
    suppressProvenance.current = undefined;
    setShown({ prop, rect });
  }, []);
  const closeProvenance = useCallback(() => setShown(undefined), []);
  const suppressProvenanceReopen = useCallback((prop: string) => {
    suppressProvenance.current = prop;
  }, []);
  return { shown, openProvenance, closeProvenance, suppressProvenanceReopen };
}

// The selectors the well is showing, kept as the same array while they don't change.
function useVisibleSelectors() {
  const [visibleSelectors, setVisibleSelectors] = useState<readonly string[]>([]);
  const rememberVisibleSelectors = useCallback((next: readonly string[]) => {
    setVisibleSelectors((previous) => {
      const same =
        next.length === previous.length &&
        next.every((selector, index) => selector === previous[index]);
      return same ? previous : [...next];
    });
  }, []);
  return [visibleSelectors, rememberVisibleSelectors] as const;
}

// The card's sticky head: the query/context selector (with its add / rename forms),
// the element's identity, the selector well, and where edits go.
function StyleCardHead({
  card,
  onVisibleSelectorsChange,
}: {
  card: StyleCardProps;
  onVisibleSelectorsChange: (selectors: readonly string[]) => void;
}) {
  const { snapshot, activeSelector, busy } = card;
  // Whether the "Add query" form is open (below the context dropdown).
  const [addingQuery, setAddingQuery] = useState(false);
  // The query being renamed, if any — same slot as the add form, one at a time.
  const [editingQuery, setEditingQuery] = useState<string | undefined>(undefined);
  return (
    // The query/context selector leads the panel (and sticks to the top on scroll);
    // its "Add query" option opens the form right below it.
    <div className="embed-editor_head">
      <div className="embed-editor_switchers">
        {/* Always shown (even with only "Base") for a stable panel layout. The last
          option opens a form to add a custom query to the current selector. */}
        {card.contexts.length > 0 ? (
          <ContextSwitcher
            card={card}
            onAddQuery={() => {
              setEditingQuery(undefined);
              setAddingQuery(true);
            }}
            onEditQuery={(query) => {
              setAddingQuery(false);
              setEditingQuery(query);
            }}
          />
        ) : undefined}
      </div>
      <QueryForms
        card={card}
        addingQuery={addingQuery}
        editingQuery={editingQuery}
        setAddingQuery={setAddingQuery}
        setEditingQuery={setEditingQuery}
      />
      <div className="embed-editor_selector">
        <div className="embed-editor_selector-box">
          {snapshot ? (
            <ElementTokenPicker snapshot={snapshot} />
          ) : (
            <div className="embed-editor_element-id is-empty">No element selected</div>
          )}
          {/* Right-aligned slot the save indicator portals into — sits on the
            `div.test` row (see SaveIndicator). */}
          <span id="embed-editor_save-slot" className="embed-editor_selector-save" />
        </div>
      </div>

      {/* Every selector that styles this element — click to edit it (like a combo
        class); the input adds a new one (native for a class[:state], embed for a
        complex selector). Replaces the old None/Hover/Focus/Active switch. */}
      <SelectorPicker
        selectors={card.selectors}
        suggestions={card.suggestions}
        activeSelector={activeSelector}
        activePicked={card.activePicked}
        busy={busy}
        loading={card.resolving}
        onSelect={card.onSelectActive}
        onDeselect={card.onDeselect}
        onAdd={card.onAddSelector}
        onVisibleSelectorsChange={onVisibleSelectorsChange}
      />
      <SourcePickerRow card={card} />
    </div>
  );
}

// The style-context dropdown. Each context row can carry a pencil to rename its query;
// the last option adds a query.
function ContextSwitcher({
  card,
  onAddQuery,
  onEditQuery,
}: {
  card: StyleCardProps;
  onAddQuery: () => void;
  onEditQuery: (query: string) => void;
}) {
  const { contexts, contextInfos, queryUses } = card;
  const options = contexts.map((styleContext) => {
    // Editable when this stylesheet is where the query is written. A row can be here
    // for a query held in some other file (or for a native breakpoint, which is no
    // at-rule at all) — nothing to rename there, so no pencil. A nested chain's own
    // query is its last link; the ones before it are rows of their own.
    const query = (styleContext.embedAtContext || '').split(' › ').pop() || '';
    const uses = queryUses.get(queryKey(query)) ?? 0;
    return {
      value: styleContext.key,
      label: styleContext.label,
      icon: breakpointIcon(styleContext.breakpoint ?? undefined),
      marked: contextInfos.find((info) => info.key === styleContext.key)?.hasStyles ?? false,
      ...(uses > 0
        ? {
            action: {
              icon: <PencilIcon />,
              label: `Edit ${query}`,
              onSelect: () => onEditQuery(query),
            },
          }
        : {}),
    };
  });
  return (
    <Select
      className="embed-editor_context-select"
      value={card.context}
      options={[...options, { value: ADD_QUERY, label: 'Add query', icon: <PlusIcon /> }]}
      onChange={(next) => {
        if (next === ADD_QUERY) {
          onAddQuery();
        } else {
          card.onContext(next);
        }
      }}
      ariaLabel="Style context"
    />
  );
}

// The add-query and rename-query forms, one at a time, below the context dropdown.
function QueryForms({
  card,
  addingQuery,
  editingQuery,
  setAddingQuery,
  setEditingQuery,
}: {
  card: StyleCardProps;
  addingQuery: boolean;
  editingQuery: string | undefined;
  setAddingQuery: (adding: boolean) => void;
  setEditingQuery: (query: string | undefined) => void;
}) {
  return (
    <>
      {addingQuery ? (
        <AddQueryForm
          canNest={card.activeSelector.length > 0}
          suggestions={card.querySuggestions}
          onCancel={() => setAddingQuery(false)}
          onAdd={(query, mode) => {
            setAddingQuery(false);
            card.onAddQuery(query, mode);
          }}
        />
      ) : undefined}
      {editingQuery ? (
        <EditQueryForm
          query={editingQuery}
          uses={card.queryUses.get(queryKey(editingQuery)) ?? 0}
          sourceLabel={card.sourceLabel}
          suggestions={card.querySuggestions}
          onCancel={() => setEditingQuery(undefined)}
          onRename={(from, to) => {
            setEditingQuery(undefined);
            card.onRenameQuery(from, to);
          }}
        />
      ) : undefined}
    </>
  );
}

// Where edits go, as a compact text link: the Webflow class style or a specific embed
// (page embeds listed in cascade order). Sits under the selector input, mirroring the
// reference layout.
function SourcePickerRow({ card }: { card: StyleCardProps }) {
  return (
    <div className="embed-editor_selector-head">
      <div className="embed-editor_source-picker">
        <span className="embed-editor_source-prefix">Add custom styles in:</span>
        {/* Always rendered so it's openable while embeds are still fetching — it
          lists whatever's loaded so far (Webflow + page embeds); component
          embeds fill in as they arrive, flagged by the spinner beside it. */}
        <Select
          variant="link"
          searchable
          searchPlaceholder="Search embeds…"
          className="embed-editor_source-link"
          value={card.sourceValue}
          options={card.sourceOptions.map(sourceSelectOption)}
          onChange={(next) => card.onSourceChange(next)}
          ariaLabel="Style source — the Webflow class or embed edits go to"
        />
        {card.loading ? (
          <span className="embed-editor_source-loading" title="Fetching embeds…" aria-live="polite">
            <svg className="embed-editor_source-spinner" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
            </svg>
          </span>
        ) : undefined}
      </div>
      {card.pending ? (
        <span
          className="embed-editor_unsaved"
          title="Not yet saved — applies when you exit the component"
        >
          Unsaved
        </span>
      ) : undefined}
    </div>
  );
}

// A source as a dropdown option. Trigger tag: component embeds show the component icon
// in green, page-level embeds the embed icon in blue.
function sourceSelectOption(option: SourceOption) {
  return {
    value: option.value,
    label: option.label,
    marked: option.heading ? false : (option.marked ?? false),
    ...(option.heading === undefined ? {} : { heading: option.heading }),
    ...(option.indent === undefined ? {} : { indent: option.indent }),
    ...(option.triggerLabel === undefined ? {} : { triggerLabel: option.triggerLabel }),
    icon: option.heading ? <ComponentIcon /> : <EmbedIcon />,
    triggerIcon: option.fromComponent ? <ComponentIcon /> : <EmbedIcon />,
    tone: option.fromComponent ? ('component' as const) : ('embed' as const),
  };
}

// What every section's controls are handed.
type SectionCard = Pick<
  StyleCardProps,
  'busy' | 'setProp' | 'clearProp' | 'liveSetProp' | 'onSelectSelector' | 'activeSelector'
> & {
  read: (prop: string) => ResolvedProp | undefined;
  onProvenance: (prop: string, anchor: DOMRect) => void;
};

// The property sections, each collapsible (Shift-click applies to all).
function StyleSections({
  card,
  openProvenance,
}: {
  card: StyleCardProps;
  openProvenance: (prop: string, anchor: DOMRect) => void;
}) {
  const { resolved } = card;
  // Always show Layout + Size so the panel is consistent across elements, not
  // only those that already set a property in that section.
  const groups = groupProps([...resolved.props.keys()], SECTION_ORDER);
  const sectionIds = groups.map((group) => group.def.id);
  const [closedSectionIds, toggleSection] = useSectionVisibility();
  const read = (prop: string) => resolved.props.get(prop);
  const section: SectionCard = {
    read,
    busy: card.busy,
    setProp: card.setProp,
    clearProp: card.clearProp,
    liveSetProp: card.liveSetProp,
    onProvenance: openProvenance,
    onSelectSelector: card.onSelectSelector,
    activeSelector: card.activeSelector,
  };
  return (
    <div className="embed-editor_decls">
      {groups.map((group) => (
        <SectionBlock
          key={group.def.id}
          label={group.def.label}
          open={!closedSectionIds.has(group.def.id)}
          onToggle={(event) => {
            const open = !closedSectionIds.has(group.def.id);
            toggleSection({
              id: group.def.id,
              ids: sectionIds,
              next: open ? 'closed' : 'open',
              scope: event.shiftKey ? 'all' : 'one',
            });
          }}
          // A dot whenever anything in the section reaches the element, and
          // blue once the picked selector is one of the things setting it —
          // `source === 'selected'` is the same test every property label in
          // here makes.
          mark={
            group.props.some((prop) => read(prop)?.source === 'selected')
              ? 'own'
              : group.props.length
                ? 'other'
                : undefined
          }
          headerAction={
            group.def.id === 'spacing' ? (
              <SpacingCenterButton
                read={read}
                busy={card.busy}
                setProp={card.setProp}
                clearProp={card.clearProp}
              />
            ) : undefined
          }
        >
          {SECTION_CONTROLS[group.def.id]?.(section)}
          <FallThroughRows
            props={fallThroughProps(group.def.id, group.props)}
            emptyNote={isControlSection(group.def.id) ? undefined : EMPTY_CUSTOM_NOTE}
            resolved={resolved}
            section={section}
          />
        </SectionBlock>
      ))}
    </div>
  );
}

const SECTION_ORDER = [
  'flex-child',
  'layout',
  'position',
  'spacing',
  'size',
  'typography',
  'backgrounds',
  'borders',
  'effects',
  'other',
] as const;

const EMPTY_CUSTOM_NOTE = 'No custom properties — add one below.';

// Each section's dedicated controls, by section id. A section without an entry (the
// custom properties) is only its fall-through rows. The sections whose live writes
// still hand over a dropped preview as null (Typography, and Flex child through its
// props) get it converted to `undefined` here.
const SECTION_CONTROLS: Readonly<Record<string, (section: SectionCard) => ReactNode>> = {
  'flex-child': (section) => (
    <FlexChildSection
      key={section.activeSelector}
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={(prop, value, important) =>
        section.liveSetProp(prop, value ?? undefined, important)
      }
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  size: (section) => (
    <SizeSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  position: (section) => (
    <PositionSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  borders: (section) => (
    <BordersSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  spacing: (section) => (
    <SpacingSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  backgrounds: (section) => (
    <BackgroundSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  // Keyed by selector so the font/weight custom-mode state resets per element.
  typography: (section) => (
    <TypographySection
      key={section.activeSelector}
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={(prop, value, important) =>
        section.liveSetProp(prop, value ?? undefined, important)
      }
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  // Display always shows (defaults to block); Flex / Grid / Inline settings follow in
  // collapsible disclosures that auto-open for the current Display (never hidden).
  // Gap lives inside.
  layout: (section) => (
    <>
      <DisplayRow
        resolved={section.read('display')}
        busy={section.busy}
        setProp={section.setProp}
        clearProp={section.clearProp}
        onProvenance={section.onProvenance}
        onSelectSelector={section.onSelectSelector}
      />
      <LayoutModeSections
        read={section.read}
        busy={section.busy}
        setProp={section.setProp}
        clearProp={section.clearProp}
        liveSetProp={section.liveSetProp}
        onProvenance={section.onProvenance}
        onSelectSelector={section.onSelectSelector}
        activeSelector={section.activeSelector}
      />
    </>
  ),
  effects: (section) => (
    <EffectsSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
};

function isControlSection(id: string): boolean {
  return SECTION_CONTROLS[id] !== undefined;
}

// The props of a section that its dedicated controls don't own, shown as generic
// rows: typography props without a control (text-transform, font-style, the
// text-decoration shorthand, …); generic layout props (the align + grid props are
// owned by the disclosures, always); effects props without a control
// (transform-origin, perspective, will-change, …). The custom-properties section is
// all rows.
function fallThroughProps(id: string, props: readonly string[]): readonly string[] {
  switch (id) {
    case 'typography':
      return props.filter((prop) => !TYPOGRAPHY_CONTROL_PROPS.has(prop));
    case 'layout':
      return props.filter(
        (prop) =>
          !LAYOUT_CONTROL_PROPS.has(prop) &&
          !ALIGN_PROPS.has(prop) &&
          !GRID_CONTROL_PROPS.has(prop),
      );
    case 'effects':
      return props.filter((prop) => !EFFECTS_CONTROL_PROPS.has(prop));
    default:
      return isControlSection(id) ? [] : props;
  }
}

// Generic property rows. Every row's name came from `resolved.props.keys()`, so a miss
// is a broken grouping, not an absent property. With no rows, `emptyNote` (if given)
// says so.
function FallThroughRows({
  props,
  emptyNote,
  resolved,
  section,
}: {
  props: readonly string[];
  emptyNote: string | undefined;
  resolved: ResolvedStyle;
  section: SectionCard;
}) {
  if (!props.length) {
    return emptyNote === undefined ? undefined : (
      <p className="embed-editor_decls-empty">{emptyNote}</p>
    );
  }
  return props.map((prop) => {
    const found = resolved.props.get(prop);
    assert(found !== undefined, `Grouped property ${prop} is resolved`);
    return (
      <ResolvedRow
        key={prop}
        prop={prop}
        resolved={found}
        busy={section.busy}
        setProp={section.setProp}
        clearProp={section.clearProp}
        liveSetProp={section.liveSetProp}
        onProvenance={section.onProvenance}
        onSelectSelector={section.onSelectSelector}
      />
    );
  });
}

// Stream: accumulate docs as each embed is read and render them right away, rather
// than waiting for the whole batch. Emits are coalesced (≤ ~1/100ms) so the re-resolve
// per partial can't thrash. Dedupe by key because a page and component scan can
// surface the same embed. Returns the per-document callback.
function streamDocs(
  pageScan: EmbedScan,
  onPartial: ((content: Content) => void) | undefined,
): (embedDocument: EmbedDocument) => void {
  const streamed: EmbedDocument[] = [];
  const streamedKeys = new Set<string>();
  let lastEmitAt = 0;
  return (embedDocument) => {
    if (streamedKeys.has(embedDocument.source.key)) {
      return;
    }
    streamedKeys.add(embedDocument.source.key);
    streamed.push(embedDocument);
    if (!onPartial) {
      return;
    }
    const now = Date.now();
    if (now - lastEmitAt < 100) {
      return;
    }
    lastEmitAt = now;
    onPartial({
      scan: pageScan,
      docs: [...streamed],
      rules: [],
      errors: [],
      embedCount: 0,
      componentEmbedCount: 0,
      partial: true,
    });
  };
}

// The component embeds. Warm cache (and not a forced rescan): skip the DFS, just
// re-read the known component embeds' code — that's what catches external edits.
// Cold / forced: DFS every component for its embeds (streamed) and cache the sources
// for next time.
async function loadComponentDocs(
  { rescanComponents }: { readonly rescanComponents: boolean },
  onDocument: (embedDocument: EmbedDocument) => void,
): Promise<{ docs: EmbedDocument[]; errors: Content['errors'] }> {
  if (cachedComponentSources && !rescanComponents) {
    return loadEmbedDocs(cachedComponentSources, onDocument);
  }
  const sources: EmbedDocument['source'][] = [];
  const docs: EmbedDocument[] = [];
  const errors: Content['errors'] = [];
  await scanAllComponents(async (embeds) => {
    sources.push(...embeds);
    const result = await loadEmbedDocs(embeds, onDocument);
    docs.push(...result.docs);
    errors.push(...result.errors);
  });
  cachedComponentSources = sources;
  return { docs, errors };
}

// The full scan's content: page docs then component docs, each embed once.
function mergedContent(
  pageScan: EmbedScan,
  results: ReadonlyArray<{ docs: EmbedDocument[]; errors: Content['errors'] }>,
): Content {
  const seenDocs = new Set<string>();
  const docs = results
    .flatMap((result) => result.docs)
    .filter((embedDocument) => {
      if (seenDocs.has(embedDocument.source.key)) {
        return false;
      }
      seenDocs.add(embedDocument.source.key);
      return true;
    });
  const embeds = dedupeByKey(docs.map((embedDocument) => embedDocument.source));
  return {
    scan: { ...pageScan, embeds },
    docs,
    rules: [],
    errors: results.flatMap((result) => result.errors),
    embedCount: 0,
    componentEmbedCount: 0,
    partial: false,
  };
}

// The query scaffolds for an element's classes — only inside a component, from its own
// (writable) embeds.
function placeholdersFor(content: Content, classList: string[]): Placeholder[] {
  return content.scan.inComponentContext ? computePlaceholders(content.docs, classList) : [];
}

// What the Designer says about the selected element now: its match target and
// snapshot, its native class styles, and the canvas's answer the target came from.
// Undefined on a transient read failure.
async function readDesignerState(element: unknown, content: Content) {
  try {
    const asked = await askCanvasAbout(serializeElementId(element), content.rules);
    const resolved = await resolveTarget(element, content.scan, asked);
    // Read from the RESOLVED identity element (as refreshNative and the load effect
    // do), NOT the raw selection — reading the raw element yields a different model
    // for in-component selections, so its signature would never match the displayed
    // one and the poll would re-render every tick.
    const identity = await resolveIdentityElement(element);
    const native = await readNativeStyles(identity, STATES);
    return { target: resolved.target, snap: resolved.rootSnapshot, native, asked };
  } catch {
    return undefined;
  }
}

// A lone class typed into the selector box should also land on the element, the way a
// class field would. Anything more — a combinator, :is(), a state, a second token — is
// a selector being authored deliberately, so the element is left alone.
// canonicalCompound already draws that line. Returns the class name, if it is one.
function loneTypedClass(selector: string): string | undefined {
  const canon = canonicalCompound(selector);
  if (!canon.simple || !canon.oneCompound || canon.pseudoElement) {
    return undefined;
  }
  if (canon.pseudoClasses.length !== 0 || canon.tokens.length !== 1) {
    return undefined;
  }
  const token = canon.tokens[0] ?? '';
  return token.startsWith('class:') ? token.slice('class:'.length) : undefined;
}

interface ChipInputs {
  model: RuleModel | undefined;
  nativeModel: NativeModel | undefined;
  currentContext: StyleContext;
  activeSelector: string;
  selectedSelectorText: string | undefined;
  tokens: ReturnType<typeof snapshotTokens>;
  classList: string[];
  removedClasses: ReadonlySet<string>;
}

// Every selector (with styles) that targets the element in the current context, for
// the chip picker, in chip display order.
function chipsFor(inputs: ChipInputs): MatchedSelector[] {
  const { model, nativeModel, currentContext, removedClasses } = inputs;
  // Show EVERY selector that styles this element in any query. The picker dims the
  // ones not styled in the current query (inContext === false) rather than hiding
  // them — so switching queries keeps the full list visible instead of dropping
  // selectors that only have styles elsewhere.
  // A chip is a selector that targets THIS element. One that hangs off a class the
  // element no longer has doesn't any more — drop it now instead of leaving it in
  // the well until the next resolve. Complex selectors are left to that resolve:
  // the class may be an ancestor's, which this can't tell apart.
  const list = styledSelectorsFor(model, nativeModel, currentContext).filter((entry) => {
    if (!removedClasses.size) {
      return true;
    }
    const canon = canonicalCompound(entry.text);
    return !(canon.simple && canon.tokens.some((tok) => removedClasses.has(tok)));
  });
  const pending = pendingActiveChip(list, inputs);
  if (pending) {
    list.push(pending);
  }
  // Order for readability: tag → base class + pseudos → applied combo chain + pseudos
  // → standalone/global classes → data attributes → complex selectors.
  return inChipOrder(list, inputs.classList, { byOrder: true }).map((selector) =>
    // In a query context, show the display with an `@` at the query position;
    // on Base / other contexts show the plain nested display.
    currentContext.embedAtContext && selector.inContext !== false && selector.queryDisplay
      ? { ...selector, display: selector.queryDisplay }
      : selector,
  );
}

// Show the active selector as a pending (dashed/outlined) chip while it has no rule
// yet, so a freshly typed/picked selector stays visible until its first property
// lands (then it becomes a solid styled chip). We show it for a complex/typed
// selector always, and for the element's OWN classes only when the user explicitly
// typed or picked one (`selectedSelectorText` set) — the AUTO-composed default
// (`.card`, `div`) stays hidden since its token chip already indicates the pick.
// Switching elements/selectors clears `selectedSelectorText` + the active selector,
// so the pending chip disappears on its own when you move on without adding styles.
function pendingActiveChip(
  list: MatchedSelector[],
  inputs: Pick<ChipInputs, 'activeSelector' | 'selectedSelectorText' | 'tokens'>,
): MatchedSelector | undefined {
  const { activeSelector } = inputs;
  if (!activeSelector || list.some((entry) => selectorsMatch(entry.text, activeSelector))) {
    return undefined;
  }
  const ownTokens = new Set(inputs.tokens.map((token) => token.name));
  const canon = canonicalCompound(activeSelector);
  const own = canon.simple && canon.tokens.every((tok) => ownTokens.has(tok));
  if (own && inputs.selectedSelectorText === undefined) {
    return undefined;
  }
  return {
    text: activeSelector,
    specificity: [0, 0, 0],
    state: stateForSelector(activeSelector),
    simple: canon.simple,
    key: `active:${activeSelector}`,
    pending: true,
    inContext: true,
    fromComponent: false,
  };
}

// Selectors in chip display order (see selectorOrder), then by specificity; with
// `byOrder`, a selector's own source order breaks the tie before its text does.
function inChipOrder(
  selectors: MatchedSelector[],
  classList: string[],
  { byOrder }: { readonly byOrder: boolean },
): MatchedSelector[] {
  return selectors
    .map((entry) => ({ s: entry, rank: selectorOrder(entry.text, classList) }))
    .sort(
      (left, right) =>
        left.rank[0] - right.rank[0] ||
        left.rank[1] - right.rank[1] ||
        left.rank[2] - right.rank[2] ||
        compareSpecificity(left.s.specificity, right.s.specificity) ||
        (byOrder && left.s.order !== undefined && right.s.order !== undefined
          ? left.s.order - right.s.order
          : 0) ||
        left.s.text.localeCompare(right.s.text),
    )
    .map((ranked) => ranked.s);
}

// The selector a new element's default upgrades to, from the local selectors styled in
// the current context — or undefined to keep the default, when it is already styled.
function upgradedDefault(
  local: MatchedSelector[],
  element: {
    tokens: ReturnType<typeof snapshotTokens>;
    classList: string[];
    defaultTokens: string[];
  },
): MatchedSelector | undefined {
  const { tokens, classList } = element;
  const defaultSelector = tokensToSelector(element.defaultTokens, tokens);
  if (defaultSelector && local.some((entry) => selectorsMatch(entry.text, defaultSelector))) {
    return undefined;
  }
  // Fall back to the FIRST applied class that has styles (the primary block class in
  // Lumos) rather than styled[last] — utility classes (u-*) sort last by name and
  // shouldn't win the default just because their specificity ties the base class.
  //
  // Every class, not just the defaulted one: the default is now the first class
  // alone, and if THAT one has no styles the next one along is still a better
  // answer than a selector picked by specificity.
  const primaryStyled = tokens
    .filter((token) => token.kind === 'class')
    .map((token) => token.name)
    .flatMap((tok) => {
      const found = local.find((entry) =>
        selectorsMatch(entry.text, tokensToSelector([tok], tokens)),
      );
      return found ? [found] : [];
    })[0];
  // Otherwise the FIRST selector in chip display order after the tag — the element's
  // own class/nesting selector (`.hero_component > .hero_paragraph`), not the highest-
  // specificity one (a foreign `:not(…) > :is(…)` shouldn't win the default).
  const ordered = inChipOrder([...local], classList, { byOrder: false });
  const firstAfterTag = ordered.find((entry) => selectorOrder(entry.text, classList)[0] > 0);
  return primaryStyled ?? firstAfterTag ?? ordered[0] ?? local[local.length - 1];
}

type EmbedRegion = EmbedDocument['regions'][number];

// Where a new rule is written: the chosen embed when one is selected, otherwise the
// embed of a matching rule (in the current context, when `inContext` is given) or the
// first embed. The region is the anchor rule's block when it lives in the target doc,
// else that doc's first block. Undefined when there's no embed to write into.
function embedWriteTarget(
  target: {
    model: RuleModel | undefined;
    selectedEmbedKey: string | undefined;
    documentByKey: Map<string, EmbedDocument>;
  },
  inContext: ((rule: ParsedRule) => boolean) | undefined,
): { embedDocument: EmbedDocument; region: EmbedRegion } | undefined {
  const { model, selectedEmbedKey, documentByKey } = target;
  const matched = model ? [...model.base, ...model.conditional].map((entry) => entry.rule) : [];
  const ofSelected = (rule: ParsedRule) => rule.embedKey === selectedEmbedKey;
  let anchor: ParsedRule | undefined;
  if (inContext === undefined) {
    anchor = selectedEmbedKey ? matched.find(ofSelected) : matched[0];
  } else if (selectedEmbedKey) {
    anchor =
      matched.find((rule) => ofSelected(rule) && inContext(rule)) ?? matched.find(ofSelected);
  } else {
    anchor = matched.find(inContext) ?? matched[0];
  }
  const embedDocument = selectedEmbedKey
    ? documentByKey.get(selectedEmbedKey)
    : anchor
      ? documentByKey.get(anchor.embedKey)
      : [...documentByKey.values()][0];
  const region =
    anchor && embedDocument && anchor.embedKey === embedDocument.source.key
      ? embedDocument.regions[anchor.regionIndex]
      : embedDocument?.regions[0];
  return embedDocument && region ? { embedDocument, region } : undefined;
}

// Create the rule for a write: typed nested syntax writes real nested source; a
// Webflow-breakpoint context with no equivalent embed query writes into a synthesized
// @media block; otherwise the embed's base, or its existing query block (or a new one).
function createRuleForWrite(
  region: EmbedRegion,
  where: {
    nested: NestStep[] | undefined;
    bpMedia: string | undefined;
    embedContext: string | undefined;
    selector: string;
    write: PropWrite;
  },
): boolean {
  const { nested, bpMedia, embedContext, selector } = where;
  const { prop, value, important } = where.write;
  if (nested) {
    return createNestedRule(region, nested, prop, { value, important });
  }
  if (bpMedia) {
    return createRuleInMedia(region, bpMedia, selector, prop, { value, important });
  }
  if (!embedContext) {
    return createRuleAtRoot(region, selector, prop, { value, important });
  }
  const block = listAtRuleBlocks(region).find(
    (entry) => entry.atContext.join(' › ') === embedContext,
  );
  return block
    ? createRuleInAtRule(block.node, selector, prop, { value, important })
    : createRuleInQuery(region, embedContext, selector, prop, { value, important });
}

// A rule's own declarations of `prop`, looked up in the live postcss AST.
function declsFor(rule: ParsedRule, prop: string): Declaration[] {
  const key = prop.toLowerCase();
  return directDecls(rule.node).filter(
    (declaration) => declaration.prop.trim().toLowerCase() === key,
  );
}

// The last of them — the one that applies.
function lastDeclFor(rule: ParsedRule, prop: string): Declaration | undefined {
  const matches = declsFor(rule, prop);
  return matches[matches.length - 1];
}

// The scan state with no element selected: the embeds' counts through an empty model.
function unselectedScanState(content: Content, rememberedPageEmbedCount: number): ScanState {
  return {
    rootSnapshot: undefined,
    model: EMPTY_RULE_MODEL,
    placeholders: [],
    embedCount: content.embedCount,
    componentEmbedCount: content.componentEmbedCount,
    rememberedPageEmbedCount: content.scan.inComponentContext ? rememberedPageEmbedCount : 0,
    errors: content.errors,
    inComponentContext: content.scan.inComponentContext,
  };
}

// The scan state for a resolved element: its snapshot and model, the query scaffolds
// (inside a component only), and the scan's counts.
function scanStateFor(
  content: Content,
  resolvedElement: { rootSnapshot: ElementSnapshot; model: RuleModel },
  rememberedPageEmbedCount: number,
): ScanState {
  const { rootSnapshot, model } = resolvedElement;
  return {
    rootSnapshot,
    model,
    placeholders: content.scan.inComponentContext
      ? computePlaceholders(content.docs, rootSnapshot.classList)
      : [],
    embedCount: content.embedCount,
    componentEmbedCount: content.componentEmbedCount,
    rememberedPageEmbedCount: content.scan.inComponentContext ? rememberedPageEmbedCount : 0,
    errors: content.errors,
    inComponentContext: content.scan.inComponentContext,
  };
}

// The status line after a resolve: the matching-rule count, so far while component
// embeds are still loading.
function resolveStatus(content: Content, model: RuleModel): string {
  const count = model.matchedRuleCount;
  if (content.partial) {
    return count > 0
      ? `${count} matching rule${count === 1 ? '' : 's'} so far — scanning components…`
      : 'Scanning component embeds…';
  }
  if (count > 0) {
    return `${count} matching rule${count === 1 ? '' : 's'}.`;
  }
  return content.embedCount
    ? 'No embed styles target this element.'
    : 'No HTML embeds with <style> blocks found.';
}

// ─────────────────────────── Main component ───────────────────────────

// One native write attempt: whether it applied (and, creating a class, whether the class
// was new), and why not.
type NativeAttempt = { applied: boolean; created?: boolean; reason: string };
type EmbedWriteResult = Awaited<ReturnType<typeof writeEmbedDocument>>;
type NestedInput = NonNullable<ReturnType<typeof parseNestedInput>>;
type CanvasAnswer = Awaited<ReturnType<typeof askCanvasAbout>>;

// A forced rescan re-walks the component tree for embeds; otherwise the cached
// component sources are re-read.
type RescanOptions = { readonly rescanComponents?: boolean | undefined };

type Content = {
  scan: EmbedScan;
  docs: EmbedDocument[];
  rules: ParsedRule[];
  errors: Array<{ label: string; message: string }>;
  embedCount: number;
  componentEmbedCount: number;
  /** True for the page-only snapshot emitted before component embeds finish loading. */
  partial?: boolean;
};

// Re-read every embed no more than this often when just switching selection.
const BG_REFRESH_THROTTLE_MS = 4000;

/** Which stylesheets the host is offering, as a comparable string. */
function sheetSignature(): string {
  const host = getHost();
  return [...host.files, ...host.astroFiles].map((file) => file.path).join('|');
}
// How often to poll the Designer for out-of-app edits (classes / attributes /
// native styles). The API has no change events, so we re-read on this cadence and
// apply only when a signature actually differs.
const DESIGNER_SYNC_INTERVAL_MS = 1500;

/** The selectors currently in play, as one comparable string: what the canvas was
 *  last asked about. Values aren't in it — changing one doesn't change which rules
 *  target the element, so it doesn't warrant asking again. */
const selectorKeyOf = (rules: ParsedRule[]): string =>
  rules.map((rule) => rule.selectorText).join('\n');

// A fingerprint of the selected element's identity (tag + id + classes + attrs) —
// changes when a class or data attribute is added/removed in the Designer.
function snapshotSignature(snap: ElementSnapshot): string {
  return JSON.stringify([snap.tag, snap.id, snap.classes, snap.attributes]);
}
// A fingerprint of the element's native Webflow class styles — changes when a
// style value is edited on a class (even without touching the element's classes).
function nativeSignature(model: NativeModel | undefined): string {
  if (!model) {
    return '';
  }
  return model.styles
    .map(
      (style) =>
        `${style.className}:${[...style.propsByContext]
          .map(
            ([contextKey, props]) =>
              `${contextKey}{${[...props]
                .map(
                  ([prop, declared]) =>
                    `${prop}=${declared.value}${declared.isVariable ? '~' : ''}`,
                )
                .join(';')}}`,
          )
          .join('|')}`,
    )
    .join('||');
}

// The selectors that carry styles for the element in a given context: embed
// selectors matching it there, plus native class-style selectors with values at
// the context's breakpoint. Sorted weakest → strongest. Shared by the chip picker
// and the on-context-switch auto-select.
// Depth of the applied class chain a selector's classes form a PREFIX of (1 = the
// base class `.test`, 2 = `.test.is-2`, …), or 0 when they aren't that prefix (a
// standalone/global class like `.is-2`). `classList` is the element's applied
// classes, primary first.
function chainPrefixDepth(classes: string[], classList: string[]): number {
  const classCount = classes.length;
  if (!classCount || classCount > classList.length) {
    return 0;
  }
  const set = new Set(classes);
  if (set.size !== classCount) {
    return 0;
  }
  for (let i = 0; i < classCount; i += 1) {
    if (!set.has(classList[i] ?? '')) {
      return 0;
    }
  }
  return classCount;
}

// The chip display order: tag → base class (`.test`) → its pseudos (`.test:hover`,
// `.test:is(:hover,:focus)`) → the applied combo chain (`.test.is-2` → `.test.is-2.ready`
// + pseudos) → the element's remaining classes IN THE ORDER THEY'RE APPLIED →
// data attributes → complex/nested selectors (`body > .test`). Returns a
// comparable [category, depth, pseudo] tuple.
function selectorOrder(text: string, classList: string[]): [number, number, number] {
  const canon = canonicalCompound(text);
  const classes = canon.tokens
    .filter((token) => token.startsWith('class:'))
    .map((token) => token.slice('class:'.length));
  const hasTag = canon.tokens.some((token) => token.startsWith('tag:'));
  const hasAttr = canon.tokens.some((token) => token.startsWith('attr:'));
  const pseudo = text.includes(':') ? 1 : 0; // a pseudo variant sorts after its plain selector
  if (!canon.oneCompound) {
    return [4, 0, 0];
  } // complex / nested — last
  if (classes.length) {
    const depth = chainPrefixDepth(classes, classList);
    if (depth > 0) {
      return [1, depth, pseudo];
    } // element's own chain: base(1) → combos
    // Not a prefix chain of the applied classes. These all used to tie at 0 and
    // fall through to specificity, then alphabetical — so the chips came out in
    // an order the element knows nothing about. Rank them by where the class
    // actually sits in `class="…"` instead. A combo sorts by its last applied
    // class; a class that isn't on the element at all goes after them.
    let applied = -1;
    for (const cls of classes) {
      const at = classList.indexOf(cls);
      if (at > applied) {
        applied = at;
      }
    }
    return [2, applied === -1 ? classList.length : applied, pseudo];
  }
  if (hasAttr) {
    return [3, 0, pseudo];
  } // data attributes
  if (hasTag) {
    return [0, 0, 0];
  } // a tag that has styles — first
  return [4, 0, 0];
}

function styledSelectorsFor(
  model: RuleModel | undefined,
  nativeModel: NativeModel | undefined,
  context: StyleContext,
): MatchedSelector[] {
  const byKey = new Map<string, MatchedSelector>();
  const add = (chip: MatchedSelector) => {
    if (!byKey.has(chip.key)) {
      byKey.set(chip.key, chip);
    }
  };
  if (model) {
    for (const matched of listMatchedSelectors(model, context.embedAtContext ?? ' native-only')) {
      add(matched);
    }
  }
  // Native class styles have no per-query context — only breakpoints. List them in
  // EVERY context (dimmed when the current one is a query they can't target — e.g. a
  // container query — or a breakpoint they aren't styled at). inContext holds only
  // when the context IS a breakpoint the selector is actually styled at.
  for (const ns of nativeSelectorChips(nativeModel, context.breakpoint ?? 'main')) {
    const key = selectorKey(ns.text);
    const inContext = context.breakpoint ? ns.inContext : false;
    const existing = byKey.get(key);
    if (existing) {
      if (inContext) {
        existing.inContext = true;
      }
      continue;
    }
    const specificity: Specificity = [0, ns.classDepth, 0];
    byKey.set(key, {
      text: ns.text,
      specificity,
      state: ns.state,
      simple: true,
      key,
      inContext,
      fromComponent: false,
    });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      compareSpecificity(left.specificity, right.specificity) ||
      left.text.localeCompare(right.text),
  );
}

// The last completed embed scan, kept at module scope so it survives the tool being
// closed and reopened (ToolHost unmounts EmbedEditor on close, dropping its refs).
// Without this, every reopen re-scans every embed and the custom-code selector chips
// reappear only after that scan finishes. Restored into the refs on mount so those
// chips render from cache immediately; a background refresh still runs to catch edits,
// and scanHasElement guards against a stale page/component before reuse.
let persistedScan:
  | {
      content: Content;
      docs: EmbedDocument[];
      pageDocs: EmbedDocument[];
      inComponent: boolean;
      scanAt: number;
    }
  | undefined = undefined;

// The last RESOLVED view — the matched model and the element snapshot the selector
// chips are drawn from. persistedScan above keeps the parsed stylesheets; this keeps
// what they resolved to for the selected element. The panel is unmounted whenever the
// right tab isn't Style — and removing a class happens in Settings, which is exactly
// that — so without this, coming back blanks the selector well until a full re-resolve
// (a canvas round trip plus a re-match of every rule) lands. Restored only while the
// same element is still selected; a background refresh reconciles it either way.
let persistedView:
  | {
      /** Node id + the file it belongs to: ids are per-page, so the file has to match too. */
      hostId: string;
      filePath: string | undefined;
      elementKey: string;
      scan: ScanState;
      quick: ElementSnapshot | undefined;
    }
  | undefined = undefined;

const viewKeyMatches = (view: typeof persistedView) => {
  const host = getHost();
  return (
    !!view &&
    !!host.selectedId &&
    view.hostId === host.selectedId &&
    view.filePath === (host.openFilePath ?? undefined)
  );
};

// The selected node's authored classes, straight from the page model. A `class` set by
// an expression has no literal text to read, and reports none.
function authoredClasses(): string[] {
  const host = getHost();
  const node = host.selectedId ? findNode(host.nodes, host.selectedId) : undefined;
  return propText(node, 'class').trim().split(/\s+/).filter(Boolean);
}

/**
 * Classes the page model has just lost.
 *
 * The panel's snapshot unions the authored classes with the ones the PREVIEW last
 * reported (so classes added at runtime still show), and the preview goes on
 * reporting a removed class until the dev server re-renders the page. Left alone, a
 * class you just deleted sits in the selector well for that whole round trip — and
 * a re-scan in between puts it back. Anything that drops out of the authored list is
 * hidden from that moment; it returns if the class does, and is forgotten once the
 * preview stops reporting it too.
 */
export function useRemovedClasses(): ReadonlySet<string> {
  const [removed, setRemoved] = useState<ReadonlySet<string>>(EMPTY_CLASSES);
  const previousRef = useRef<string[]>(authoredClasses());
  const nodeRef = useRef(getHost().selectedId);
  useEffect(() => {
    const sync = () => {
      const host = getHost();
      const now = authoredClasses();
      const previous = previousRef.current;
      previousRef.current = now;
      // A different element: nothing carries over.
      if (host.selectedId !== nodeRef.current) {
        nodeRef.current = host.selectedId;
        setRemoved((old) => (old.size ? EMPTY_CLASSES : old));
        return;
      }
      setRemoved((old) => {
        const next = new Set(old);
        for (const cls of previous) {
          if (!now.includes(cls)) {
            next.add(cls);
          }
        }
        for (const cls of now) {
          next.delete(cls);
        }
        // Once the preview has caught up there is nothing left to hide.
        const rendered = host.renderedClasses || [];
        for (const cls of [...next]) {
          if (!rendered.includes(cls)) {
            next.delete(cls);
          }
        }
        if (next.size === old.size && [...next].every((name) => old.has(name))) {
          return old;
        }
        return next;
      });
    };
    sync();
    return onHostChange(sync);
  }, []);
  return removed;
}

const EMPTY_CLASSES: ReadonlySet<string> = new Set();

// The same snapshot without the classes that have just been removed — what the
// element is now, rather than what the preview last saw.
export function withoutClasses(
  snapshot: ElementSnapshot | undefined,
  hidden: ReadonlySet<string>,
): ElementSnapshot | undefined {
  if (!snapshot || !hidden.size) {
    return snapshot;
  }
  const classes = snapshot.classes.filter((name) => !hidden.has(name));
  const classList = snapshot.classList.filter((name) => !hidden.has(name));
  if (
    classes.length === snapshot.classes.length &&
    classList.length === snapshot.classList.length
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    classes,
    classList,
    attributes: { ...snapshot.attributes, class: classList.join(' ') },
  };
}

// Cache the component embed SOURCES (the expensive part: the per-component tree
// DFS to find embeds) at module scope, reused across page switches and reopens.
// The CODE is re-read on every build, so external edits to a component embed are
// picked up (our own edits are saved, so a fresh read reflects them too). A forced
// Rescan re-DFSes to catch added/removed component embeds.
let cachedComponentSources: EmbedDocument['source'][] | undefined = undefined;

// Native class styles are determined by an element's class signature, so cache the
// read NativeModel by that signature (module scope → survives reopen). A re-selected
// element serves instantly from here while a background re-read reconciles; cleared
// on any native edit, since a class change can affect every element that uses it.
const nativeModelCache = new Map<string, NativeModel>();

export default function EmbedEditor() {
  const editorFoundation = useEditorFoundation();
  const editorScanning = useEditorScanning(editorFoundation);
  const editorSelection = useEditorSelection(editorFoundation, editorScanning);
  const editorRuleEdits = useEditorRuleEdits(editorFoundation, editorSelection);
  const editorElement = useEditorElement(editorFoundation, editorRuleEdits);
  const editorContexts = useEditorContexts(editorFoundation, editorSelection, editorElement);
  const editorResolution = useEditorResolution(editorFoundation, editorElement, editorContexts);
  const editorRuleWrites = useEditorRuleWrites(
    editorFoundation,
    editorSelection,
    editorElement,
    editorContexts,
    editorResolution,
  );
  const editorNativeCalls = useEditorNativeCalls(
    editorFoundation,
    editorRuleEdits,
    editorElement,
    editorContexts,
    editorResolution,
    editorRuleWrites,
  );
  const editorPropWrites = useEditorPropWrites(
    editorFoundation,
    editorRuleEdits,
    editorElement,
    editorContexts,
    editorResolution,
    editorRuleWrites,
    editorNativeCalls,
  );
  const editorSources = useEditorSources(
    editorFoundation,
    editorRuleEdits,
    editorElement,
    editorContexts,
    editorResolution,
  );
  const editorCardView = useEditorCardView(
    editorFoundation,
    editorSelection,
    editorRuleEdits,
    editorElement,
    editorContexts,
    editorResolution,
    editorRuleWrites,
    editorNativeCalls,
    editorPropWrites,
    editorSources,
  );
  return <EditorRoot view={editorCardView.editorView.view} />;
}

// The panel's refs and state.
function useEditorFoundation() {
  const editorRefs = useEditorRefs();
  const busyState = useBusyState(editorRefs);
  const scanState = useScanState(editorRefs);
  const selectionState = useSelectionState();
  const nativeState = useNativeState(selectionState);
  const pendingWrites = usePendingWrites(editorRefs, busyState, scanState, nativeState);
  return { busyState, editorRefs, nativeState, pendingWrites, scanState, selectionState };
}

// Scanning the embeds and resolving the element against them.
function useEditorScanning(editorFoundation: ReturnType<typeof useEditorFoundation>) {
  const { editorRefs, nativeState, scanState } = editorFoundation;

  const contentBuild = useContentBuild(editorRefs);
  const contentStore = useContentStore(editorRefs, contentBuild);
  const contentRebuild = useContentRebuild(
    editorRefs,
    scanState,
    nativeState,
    contentBuild,
    contentStore,
  );
  const applyResolveHook = useApplyResolve(editorRefs, scanState);
  const backgroundRefreshHook = useBackgroundRefresh(
    editorRefs,
    scanState,
    contentRebuild,
    applyResolveHook,
  );
  const rematch = useRematch(editorRefs, scanState);
  const designerSync = useDesignerSync(editorRefs, nativeState, rematch);
  return { applyResolveHook, backgroundRefreshHook, contentRebuild, designerSync };
}

// Following the Designer's selection and keeping the panel in sync.
function useEditorSelection(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorScanning: ReturnType<typeof useEditorScanning>,
) {
  const { editorRefs, nativeState, scanState, selectionState } = editorFoundation;
  const { applyResolveHook, backgroundRefreshHook, contentRebuild, designerSync } = editorScanning;

  const elementReset = useElementReset(editorRefs, scanState, selectionState, nativeState);
  const scanWithoutSelectionHook = useScanWithoutSelection(editorRefs, scanState, contentRebuild);
  const scanSelectionHook = useScanSelection(
    editorRefs,
    scanState,
    contentRebuild,
    applyResolveHook,
    backgroundRefreshHook,
  );
  const refreshHook = useRefresh(
    editorRefs,
    elementReset,
    scanWithoutSelectionHook,
    scanSelectionHook,
  );
  useSelectionSubscriptions(editorRefs, scanState, nativeState, refreshHook);
  useChangeSubscriptions(scanState, backgroundRefreshHook, designerSync);
  const refreshDerivedHook = useRefreshDerived(editorRefs, scanState);
  return { refreshDerivedHook, refreshHook };
}

// Edits to embed rules.
function useEditorRuleEdits(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorSelection: ReturnType<typeof useEditorSelection>,
) {
  const { busyState, editorRefs, nativeState, pendingWrites, scanState } = editorFoundation;
  const { refreshDerivedHook } = editorSelection;

  const splitForEditHook = useSplitForEdit(nativeState);
  const applyEditHook = useApplyEdit(busyState, scanState, pendingWrites, refreshDerivedHook);
  const propEdits = usePropEdits(splitForEditHook, applyEditHook);
  const liveEdits = useLiveEdits(editorRefs, pendingWrites, splitForEditHook);
  const ruleActions = useRuleActions(
    editorRefs,
    busyState,
    pendingWrites,
    splitForEditHook,
    applyEditHook,
    liveEdits,
  );
  const openEmbed = useOpenEmbed(editorRefs, scanState, pendingWrites);
  return { applyEditHook, liveEdits, openEmbed, propEdits, ruleActions };
}

// The element's tokens, native styles, and picked selector.
function useEditorElement(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
) {
  const { editorRefs, nativeState, scanState, selectionState } = editorFoundation;
  const { applyEditHook } = editorRuleEdits;

  const elementTokens = useElementTokens(scanState);
  const tokenDefault = useTokenDefault(scanState, selectionState, elementTokens);
  const cachedNative = useCachedNative(nativeState);
  useNativeRead(editorRefs, nativeState, tokenDefault, cachedNative);
  const activeSelectorHook = useActiveSelector(
    scanState,
    selectionState,
    nativeState,
    elementTokens,
  );
  const selectorPick = useSelectorPick(editorRefs, selectionState, elementTokens);
  const typedSelector = useTypedSelector(editorRefs, selectionState, applyEditHook, selectorPick);
  const focusPropHook = useFocusProp(editorRefs, selectorPick);
  return {
    activeSelectorHook,
    elementTokens,
    focusPropHook,
    selectorPick,
    tokenDefault,
    typedSelector,
  };
}

// The source stylesheet, its queries, and the style contexts.
function useEditorContexts(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorSelection: ReturnType<typeof useEditorSelection>,
  editorElement: ReturnType<typeof useEditorElement>,
) {
  const { busyState, nativeState, pendingWrites, scanState, selectionState } = editorFoundation;
  const { refreshDerivedHook } = editorSelection;
  const { elementTokens, selectorPick } = editorElement;

  const sourceDocumentHook = useSourceDocument(nativeState, pendingWrites);
  const renameQuery = useRenameQuery(
    busyState,
    scanState,
    selectionState,
    pendingWrites,
    refreshDerivedHook,
    selectorPick,
    sourceDocumentHook,
  );
  const contextKeys = useContextKeys(
    pendingWrites,
    elementTokens,
    selectorPick,
    sourceDocumentHook,
  );
  const querySuggestionsHook = useQuerySuggestions(pendingWrites);
  const embedContexts = useEmbedContexts(
    selectionState,
    elementTokens,
    sourceDocumentHook,
    contextKeys,
  );
  const styleContextsHook = useStyleContexts(
    selectionState,
    nativeState,
    contextKeys,
    embedContexts,
  );
  const nativeTarget = useNativeTarget(selectionState, nativeState, pendingWrites);
  const componentSource = useComponentSource(scanState, nativeState, nativeTarget);
  return {
    componentSource,
    nativeTarget,
    querySuggestionsHook,
    renameQuery,
    sourceDocumentHook,
    styleContextsHook,
  };
}

// The resolved style, the selector chips, and the default pick.
function useEditorResolution(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
) {
  const { nativeState, scanState, selectionState } = editorFoundation;
  const { activeSelectorHook, elementTokens, selectorPick, tokenDefault } = editorElement;
  const { componentSource, nativeTarget, styleContextsHook } = editorContexts;

  const resolvedHook = useResolved(
    selectionState,
    nativeState,
    elementTokens,
    tokenDefault,
    activeSelectorHook,
    styleContextsHook,
    nativeTarget,
    componentSource,
  );
  const selectorChipsHook = useSelectorChips(
    scanState,
    selectionState,
    nativeState,
    elementTokens,
    activeSelectorHook,
    styleContextsHook,
  );
  const contextChange = useContextChange(
    selectionState,
    nativeState,
    elementTokens,
    activeSelectorHook,
    selectorPick,
    styleContextsHook,
  );
  useDefaultUpgrade(
    selectionState,
    nativeState,
    elementTokens,
    tokenDefault,
    selectorPick,
    styleContextsHook,
  );
  return { contextChange, resolvedHook, selectorChipsHook };
}

// Native reads and writes, and creating embed rules and queries.
function useEditorRuleWrites(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorSelection: ReturnType<typeof useEditorSelection>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
) {
  const { busyState, editorRefs, nativeState, pendingWrites, scanState } = editorFoundation;
  const { refreshDerivedHook, refreshHook } = editorSelection;
  const { activeSelectorHook, elementTokens, selectorPick } = editorElement;
  const { styleContextsHook } = editorContexts;
  const { resolvedHook } = editorResolution;

  const nativeRefresh = useNativeRefresh(editorRefs, nativeState);
  useFocusResync(editorRefs, refreshHook, nativeRefresh);
  const nativeOps = useNativeOps(editorRefs, busyState, scanState, nativeState, nativeRefresh);
  const writeNewRuleHook = useWriteNewRule(
    busyState,
    scanState,
    pendingWrites,
    refreshDerivedHook,
    selectorPick,
    resolvedHook,
  );
  const createRule = useCreateRule(
    scanState,
    pendingWrites,
    elementTokens,
    activeSelectorHook,
    styleContextsHook,
    resolvedHook,
    writeNewRuleHook,
  );
  const emptyContext = useEmptyContext(
    busyState,
    scanState,
    pendingWrites,
    refreshDerivedHook,
    elementTokens,
    resolvedHook,
  );
  return { createRule, emptyContext, nativeOps, nativeRefresh, writeNewRuleHook };
}

// Native property writes with their embed fallbacks.
function useEditorNativeCalls(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
  editorRuleWrites: ReturnType<typeof useEditorRuleWrites>,
) {
  const { busyState, editorRefs, nativeState, scanState, selectionState } = editorFoundation;
  const { propEdits } = editorRuleEdits;
  const { activeSelectorHook, selectorPick, typedSelector } = editorElement;
  const { nativeTarget, styleContextsHook } = editorContexts;
  const { resolvedHook } = editorResolution;
  const { createRule, emptyContext, nativeOps, nativeRefresh, writeNewRuleHook } = editorRuleWrites;

  const addQuery = useAddQuery(
    selectionState,
    nativeState,
    propEdits,
    activeSelectorHook,
    selectorPick,
    typedSelector,
    nativeTarget,
    resolvedHook,
    writeNewRuleHook,
    createRule,
    emptyContext,
  );
  const nativeAttempt = useNativeAttempt(
    editorRefs,
    busyState,
    scanState,
    selectionState,
    styleContextsHook,
    nativeOps,
  );
  const nativeSet = useNativeSet(
    editorRefs,
    scanState,
    selectionState,
    styleContextsHook,
    nativeRefresh,
    nativeOps,
    addQuery,
    nativeAttempt,
  );
  const createNativeClassHook = useCreateNativeClass(
    editorRefs,
    selectionState,
    nativeState,
    styleContextsHook,
    nativeRefresh,
    nativeOps,
  );
  const nativeCreate = useNativeCreate(
    scanState,
    nativeRefresh,
    nativeOps,
    addQuery,
    nativeAttempt,
    createNativeClassHook,
  );
  return { addQuery, nativeCreate, nativeSet };
}

// The property writes the sections call.
function useEditorPropWrites(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
  editorRuleWrites: ReturnType<typeof useEditorRuleWrites>,
  editorNativeCalls: ReturnType<typeof useEditorNativeCalls>,
) {
  const { nativeState, scanState, selectionState } = editorFoundation;
  const { liveEdits, propEdits, ruleActions } = editorRuleEdits;
  const { activeSelectorHook, elementTokens, selectorPick } = editorElement;
  const { nativeTarget, styleContextsHook } = editorContexts;
  const { resolvedHook } = editorResolution;
  const { createRule, nativeOps, writeNewRuleHook } = editorRuleWrites;
  const { addQuery, nativeCreate, nativeSet } = editorNativeCalls;

  const autoSelect = useAutoSelect(nativeState, elementTokens, selectorPick);
  const setPropHook = useSetProp(
    scanState,
    liveEdits,
    activeSelectorHook,
    nativeTarget,
    resolvedHook,
    createRule,
    addQuery,
    nativeSet,
    nativeCreate,
    autoSelect,
  );
  const clearPropHook = useClearProp(
    selectionState,
    propEdits,
    liveEdits,
    ruleActions,
    styleContextsHook,
    resolvedHook,
    nativeOps,
    writeNewRuleHook,
    addQuery,
  );
  const liveSetPropHook = useLiveSetProp(
    selectionState,
    nativeState,
    liveEdits,
    activeSelectorHook,
    styleContextsHook,
    nativeOps,
    writeNewRuleHook,
    addQuery,
    autoSelect,
    clearPropHook,
  );
  return { clearPropHook, liveSetPropHook, setPropHook };
}

// The source dropdown, embed navigation, and the card's selector props.
function useEditorSources(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
) {
  const { nativeState, selectionState } = editorFoundation;
  const { openEmbed } = editorRuleEdits;
  const { activeSelectorHook, elementTokens, focusPropHook, selectorPick, typedSelector } =
    editorElement;
  const { nativeTarget, styleContextsHook } = editorContexts;
  const { resolvedHook, selectorChipsHook } = editorResolution;

  const sourceOptionsHook = useSourceOptions(
    nativeState,
    elementTokens,
    styleContextsHook,
    nativeTarget,
    resolvedHook,
  );
  const embedNavHook = useEmbedNav(nativeState, openEmbed, sourceOptionsHook);
  const selectionCard = useSelectionCard(
    selectionState,
    elementTokens,
    activeSelectorHook,
    selectorPick,
    typedSelector,
    focusPropHook,
    selectorChipsHook,
  );
  return { embedNavHook, selectionCard, sourceOptionsHook };
}

// The card's remaining props and the root's view.
function useEditorCardView(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorSelection: ReturnType<typeof useEditorSelection>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
  editorRuleWrites: ReturnType<typeof useEditorRuleWrites>,
  editorNativeCalls: ReturnType<typeof useEditorNativeCalls>,
  editorPropWrites: ReturnType<typeof useEditorPropWrites>,
  editorSources: ReturnType<typeof useEditorSources>,
) {
  const { busyState, editorRefs, nativeState, scanState, selectionState } = editorFoundation;
  const { refreshHook } = editorSelection;
  const { ruleActions } = editorRuleEdits;
  const { elementTokens } = editorElement;
  const { nativeTarget, querySuggestionsHook, renameQuery, sourceDocumentHook, styleContextsHook } =
    editorContexts;
  const { contextChange, resolvedHook, selectorChipsHook } = editorResolution;
  const { writeNewRuleHook } = editorRuleWrites;
  const { addQuery } = editorNativeCalls;
  const { clearPropHook, liveSetPropHook, setPropHook } = editorPropWrites;
  const { embedNavHook, selectionCard, sourceOptionsHook } = editorSources;

  const contextCard = useContextCard(
    scanState,
    selectionState,
    elementTokens,
    sourceDocumentHook,
    renameQuery,
    querySuggestionsHook,
    styleContextsHook,
    resolvedHook,
    selectorChipsHook,
    contextChange,
    addQuery,
    embedNavHook,
  );
  const sourceCard = useSourceCard(
    busyState,
    scanState,
    nativeState,
    refreshHook,
    ruleActions,
    nativeTarget,
    writeNewRuleHook,
    setPropHook,
    clearPropHook,
    liveSetPropHook,
    sourceOptionsHook,
  );
  const editorView = useEditorView(
    editorRefs,
    busyState,
    scanState,
    nativeState,
    elementTokens,
    embedNavHook,
    selectionCard,
    contextCard,
    sourceCard,
  );
  return { editorView };
}

// The panel's refs: the selection, the scanned content, and the bookkeeping that
// async work reads without re-rendering.
function useEditorRefs() {
  const selectedRef = useRef<unknown>(undefined);
  // The view this panel had when it was last unmounted, if the same element is still
  // selected — the chips render from it on the first paint instead of an empty well.
  const restoredRef = useRef(viewKeyMatches(persistedView) ? persistedView : undefined);
  // Identity of the last element we reset the selection for — so a NEW element clears
  // the previous one's picked selector (the token signature isn't reliable: distinct
  // elements can share it, especially when classes aren't readable in a component).
  // Seeded from the restored view, so returning to the SAME element doesn't read as a
  // change and blank everything.
  const selectedElementKeyRef = useRef(restoredRef.current?.elementKey ?? '');
  // The panel root — used to focus a specific property's field by [data-prop].
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<Content | undefined>(persistedScan?.content);
  const docsRef = useRef<EmbedDocument[]>(persistedScan?.docs ?? []);
  // Page-level embeds from the last full page scan — kept alive across the
  // enter/exit-component boundary so their rules still match (and stay editable)
  // while a component is open, then flushed on exit.
  const pageDocsRef = useRef<EmbedDocument[]>(persistedScan?.pageDocs ?? []);
  // The current page's component instances — used to enter a component when
  // navigating to one of its (globally-read) embeds from a provenance chip.
  const pageInstancesRef = useRef<unknown[]>([]);
  const inComponentRef = useRef(persistedScan?.inComponent ?? false);
  const pendingKeysRef = useRef<Set<string>>(new Set());
  // Selected element's ordered classes — for recomputing query scaffolds on edit.
  const classListRef = useRef<string[]>([]);
  const targetRef = useRef<MatchTarget | undefined>(undefined);
  const seqRef = useRef(0);
  // Monotonic ordering key so a slow partial render can never overwrite the
  // fuller result that followed it (key = seq * 2 + (partial ? 0 : 1)).
  const appliedKeyRef = useRef(-1);
  const refreshingRef = useRef(false);
  const busyRef = useRef(false);
  // Defer the VISIBLE busy state (which disables controls + spins the save indicator)
  // so a quick save — the common case — never flashes the panel disabled. The poll
  // gate (busyRef) still flips immediately; only the on-screen disable waits out this
  // delay, so a genuinely slow/stuck write still locks the controls to stop edits
  // piling up. Most single writes finish well under this, so they never disable.
  const busyTimerRef = useRef<number | undefined>(undefined);
  // What the canvas was last asked about, and for which element — see
  // refreshDerived.
  const primedRef = useRef<{ target: MatchTarget; key: string } | undefined>(undefined);
  const lastSnapSigRef = useRef('');
  const lastScanAtRef = useRef(persistedScan?.scanAt ?? 0);
  return {
    appliedKeyRef,
    busyRef,
    busyTimerRef,
    classListRef,
    contentRef,
    docsRef,
    inComponentRef,
    lastScanAtRef,
    lastSnapSigRef,
    pageDocsRef,
    pageInstancesRef,
    pendingKeysRef,
    primedRef,
    refreshingRef,
    restoredRef,
    rootRef,
    selectedElementKeyRef,
    selectedRef,
    seqRef,
    targetRef,
  };
}

// The busy flag (shown, deferred) and the last save failure.
function useBusyState(editorRefs: ReturnType<typeof useEditorRefs>) {
  const { busyRef, busyTimerRef } = editorRefs;

  const [busy, setBusy] = useState(false);
  // Last save failure (surfaced by the header save indicator, not as body text).
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const setBusyBoth = useCallback(
    (value: boolean) => {
      busyRef.current = value; // gate the external-sync poll immediately (before any await)
      if (value) {
        setSaveError(undefined); // a new save starts → clear the last error
        if (busyTimerRef.current === undefined) {
          busyTimerRef.current = window.setTimeout(() => {
            busyTimerRef.current = undefined;
            setBusy(true);
          }, 300);
        }
      } else {
        if (busyTimerRef.current !== undefined) {
          window.clearTimeout(busyTimerRef.current);
          busyTimerRef.current = undefined;
        }
        setBusy(false);
      }
    },
    [busyRef, busyTimerRef],
  );
  useEffect(
    () => () => {
      if (busyTimerRef.current !== undefined) {
        window.clearTimeout(busyTimerRef.current);
      }
    },
    [busyTimerRef],
  );
  return { busy, saveError, setBusyBoth, setSaveError };
}

// The scan's phase and result, and the panel's status and notices.
function useScanState(editorRefs: ReturnType<typeof useEditorRefs>) {
  const { restoredRef } = editorRefs;

  const [phase, setPhase] = useState<Phase>('idle');
  const [scan, setScan] = useState<ScanState | undefined>(restoredRef.current?.scan);
  // A fast, scan-independent snapshot (tag + classes) read straight off the
  // selected element so the chips appear immediately, before the embed scan's
  // fuller rootSnapshot arrives.
  const [quickSnapshot, setQuickSnapshot] = useState<ElementSnapshot | undefined>(
    restoredRef.current?.quick,
  );
  // Classes removed since the panel last resolved — hidden from the chips at once.
  const removedClasses = useRemovedClasses();
  const [, setStatus] = useState('Select an element to inspect its embed styles.');
  // When a native (Webflow class) write can't apply and we fall back to an embed,
  // the reason — surfaced inline so the fallback isn't silent.
  const [nativeFallback, setNativeFallback] = useState<string | undefined>(undefined);
  const [, setRefreshing] = useState(false);
  // True between showing page-level rules and the component embeds finishing.
  const [scanningMore, setScanningMore] = useState(false);
  // Starts closed for each panel session, then stays as the user left it while
  // element changes rebuild the card beneath this persistent editor state.
  const [cssCodeOpen, setCssCodeOpen] = useState(false);
  return {
    cssCodeOpen,
    nativeFallback,
    phase,
    quickSnapshot,
    removedClasses,
    scan,
    scanningMore,
    setCssCodeOpen,
    setNativeFallback,
    setPhase,
    setQuickSnapshot,
    setRefreshing,
    setScan,
    setScanningMore,
    setStatus,
  };
}

// The picked tokens, selector, style context, and interaction state.
function useSelectionState() {
  // The tokens (tag / classes / attrs) chosen in the header ClassPicker, defaulted
  // to the element's classes and re-defaulted when the selected element changes.
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const tokenIdentityRef = useRef('');
  // Set when the element just changed, so once the model is ready we can upgrade the
  // raw all-classes default to the strongest selector actually STYLED in the current
  // context (cleared as soon as it's applied, or when the user picks something).
  const pendingDefaultRef = useRef(false);
  // A class typed into the selector box, on its way onto the element: when the
  // element's tokens next change to include it, that change is the user's own
  // edit landing, not a different element, so the typed pick stands.
  const typedClassRef = useRef<string | undefined>(undefined);
  // The token names the default effect just picked (its raw default) — read by the
  // smart-default effect to check if that default is styled (can't read state there:
  // it hasn't re-rendered yet in the same commit).
  const defaultTokensRef = useRef<string[]>([]);
  // The full selector currently being edited when it's picked from the matched-
  // selector chip list (or typed in) rather than composed from the token chips —
  // e.g. `.test:hover`, `.parent.is-active .test`, `:first-child`. Null → the
  // active selector is the token-composed one. `activeSelector` folds the two.
  const [selectedSelectorText, setSelectedSelectorText] = useState<string | undefined>(undefined);
  // The chosen style context (Base / a query) and interaction state (:hover, …).
  // stateKey follows the active selector's own pseudo-classes (see the selection
  // handlers) so native reads/writes target the right (breakpoint, pseudo).
  const [context, setContext] = useState<ContextKey>('');
  // The selected context's full object, remembered so the query stays selected when
  // the element changes (re-injected into the rebuilt list if the new element lacks it).
  const stickyContextRef = useRef<StyleContext | undefined>(undefined);
  const [stateKey, setStateKey] = useState<StateKey>('');
  return {
    context,
    defaultTokensRef,
    pendingDefaultRef,
    selectedSelectorText,
    selectedTokens,
    setContext,
    setSelectedSelectorText,
    setSelectedTokens,
    setStateKey,
    stateKey,
    stickyContextRef,
    tokenIdentityRef,
    typedClassRef,
  };
}

// Deferred page edits, the native class styles, and the chosen style source.
function useNativeState(selectionState: ReturnType<typeof useSelectionState>) {
  const { stateKey } = selectionState;

  // Keys of page-level embeds with edits that couldn't be written while a
  // component is open. Mirrored into pendingKeysRef for use inside callbacks.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());

  // Native Webflow class styles on the selected element (read via the Style API),
  // the layer being edited (Native/Embed), and the Designer's current breakpoint
  // (which defaults the context on load).
  const [nativeModel, setNativeModel] = useState<NativeModel | undefined>(undefined);
  // Undefined = follow the smart default (Native when the class already has native
  // values, else Embed so pre-existing embed CSS stays editable); a value = the
  // user's explicit choice, kept until the selected element changes.
  // The chosen style source: 'native' (Webflow class) or a specific embed's key.
  // Undefined = follow the default (Webflow when a class Style exists, else the first
  // embed). Reset when the selected element changes.
  // Restore the last-targeted embed so a chosen source (e.g. a global-CSS embed)
  // persists across reloads; effectiveSourceSel still falls back if it's unavailable.
  const [sourceSelection, setSourceSelection] = useState<string | undefined>(
    () => loadEmbedSource() ?? undefined,
  );
  // Auto-switch the "create styles in" source to the open component's embed while
  // inside a component, and restore the page pick on exit. Refs so the transition
  // effect reads live values without re-running on every source change.
  const sourceSelectionRef = useRef(sourceSelection);
  useEffect(() => {
    sourceSelectionRef.current = sourceSelection;
  }, [sourceSelection]);
  const previousInComponentRef = useRef(false);
  // The page pick, stashed while in a component.
  const pageSourceRef = useRef<string | undefined>(undefined);
  const wantCompSourceRef = useRef(false); // pending switch until the component embed loads
  const [currentBreakpoint, setCurrentBreakpoint] = useState<BreakpointId>('main');
  const nativeModelRef = useRef<NativeModel | undefined>(undefined);
  // The element identity `nativeModel` was last read for. Native styles load via a
  // separate async effect that lags the embed model on an element switch, so this lets
  // selector-defaulting wait until nativeModel matches the current element (otherwise
  // the previous element's native selectors briefly leak into the styled list and get
  // auto-picked). See the smart-default effect.
  const nativeIdentityRef = useRef('');
  const stateKeyRef = useRef<StateKey>('');
  useEffect(() => {
    stateKeyRef.current = stateKey;
  }, [stateKey]);
  // The selector the user is editing, read at write time by the split-on-edit
  // helpers (they run inside memoized handlers that would otherwise capture a
  // stale value). Synced from `activeSelector` once it's computed below.
  const activeSelectorRef = useRef('');
  return {
    activeSelectorRef,
    currentBreakpoint,
    nativeIdentityRef,
    nativeModel,
    nativeModelRef,
    pageSourceRef,
    pendingKeys,
    previousInComponentRef,
    setCurrentBreakpoint,
    setNativeModel,
    setPendingKeys,
    setSourceSelection,
    sourceSelection,
    sourceSelectionRef,
    wantCompSourceRef,
  };
}

// Page-embed edits held while a component is open, and the embeds by key.
function usePendingWrites(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
) {
  const { docsRef, inComponentRef, pendingKeysRef } = editorRefs;
  const { setSaveError } = busyState;
  const { scan, setStatus } = scanState;
  const { setPendingKeys } = nativeState;

  const markPending = useCallback(
    (key: string) => {
      if (pendingKeysRef.current.has(key)) {
        return;
      }
      const next = new Set(pendingKeysRef.current).add(key);
      pendingKeysRef.current = next;
      setPendingKeys(next);
    },
    [pendingKeysRef, setPendingKeys],
  );
  const clearPending = useCallback(
    (key: string) => {
      if (!pendingKeysRef.current.has(key)) {
        return;
      }
      const next = new Set(pendingKeysRef.current);
      next.delete(key);
      pendingKeysRef.current = next;
      setPendingKeys(next);
    },
    [pendingKeysRef, setPendingKeys],
  );
  // After an embed write. A page-level embed can't be written while a component is
  // open: the in-memory edit is kept and remembered — it flushes automatically on
  // exit. Any other failure is reported. Returns whether the write landed.
  const settleEmbedWrite = useCallback(
    (embedDocument: EmbedDocument, result: EmbedWriteResult, held: 'rule' | 'query'): boolean => {
      if (result.ok) {
        clearPending(embedDocument.source.key);
        return true;
      }
      if (inComponentRef.current && !embedDocument.source.fromComponent) {
        markPending(embedDocument.source.key);
        setStatus(
          `Held — this ${held} lives in the page, so the canvas shows it once you ` +
            'leave the component.',
        );
        return false;
      }
      setSaveError(result.error);
      return false;
    },
    [clearPending, markPending, inComponentRef, setSaveError, setStatus],
  );

  const documentByKey = useMemo(() => {
    const map = new Map<string, EmbedDocument>();
    docsRef.current.forEach((embedDocument) => map.set(embedDocument.source.key, embedDocument));
    return map;
    // Rebuilt per scan: docsRef refills with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed per scan, on purpose
  }, [scan, docsRef]);
  return { documentByKey, markPending, settleEmbedWrite };
}

// The expensive scan: walk the tree and read every embed.
function useContentBuild(editorRefs: ReturnType<typeof useEditorRefs>) {
  const { pageDocsRef, pageInstancesRef } = editorRefs;

  // The expensive part — walk the tree + read every embed. Cache the result.
  // Rules/counts are (re)derived in storeContent so they can fold in the
  // remembered page embeds; buildContent just does the raw scan + read.
  //
  // Two phases so results stream in: the page tree + page embeds (enough to
  // resolve ancestor chains and show page-level rules) render first via
  // onPartial, then component embeds fill in. Reads within each phase run
  // concurrently (bounded by the read limiter in webflow.ts).
  const buildContent = useCallback(
    async (
      { rescanComponents = false }: RescanOptions,
      onPartial?: (content: Content) => void,
    ): Promise<Content> => {
      const page = await scanPage();
      pageInstancesRef.current = page.instances;
      const pageScan: EmbedScan = {
        parentByKey: page.parentByKey,
        childrenByKey: page.childrenByKey,
        elementByKey: page.elementByKey,
        embeds: page.pageEmbeds,
        inComponentContext: page.inComponentContext,
      };
      const onDocument = streamDocs(pageScan, onPartial);
      // Page and component embeds both re-read their CODE fresh so out-of-app edits
      // show up; only the component tree DFS (finding which embeds exist) is cached.
      const [pageResult, componentResult] = await Promise.all([
        loadEmbedDocs(page.pageEmbeds, onDocument),
        loadComponentDocs({ rescanComponents }, onDocument),
      ]);
      return mergedContent(pageScan, [pageResult, componentResult]);
    },
    [pageInstancesRef],
  );

  // While a component is open, the scan can only see that component's own embeds
  // — the page tree is out of scope (getAllElements/getRootElement are scoped to
  // the entered component). Fold in the page embeds remembered from the last full
  // page scan (dedup by key) so page rules still match.
  const composeDocs = useCallback(
    (content: Content): EmbedDocument[] => {
      if (!content.scan.inComponentContext) {
        return content.docs;
      }
      const seen = new Set(content.docs.map((embedDocument) => embedDocument.source.key));
      const remembered = pageDocsRef.current.filter(
        (embedDocument) => !seen.has(embedDocument.source.key),
      );
      return [...content.docs, ...remembered];
    },
    [pageDocsRef],
  );
  return { buildContent, composeDocs };
}

// Store a scan's content, deriving its rules from the active embeds.
function useContentStore(
  editorRefs: ReturnType<typeof useEditorRefs>,
  contentBuild: ReturnType<typeof useContentBuild>,
) {
  const { contentRef, docsRef, inComponentRef, lastScanAtRef, pageDocsRef } = editorRefs;
  const { composeDocs } = contentBuild;

  // Returns the content with its rules and counts derived from the active embeds.
  const storeContent = useCallback(
    (scanned: Content): Content => {
      // Only a complete (non-partial) page scan refreshes the remembered page
      // embeds; while in a component we keep the previous ones (they hold any
      // unsaved edits), and a partial snapshot must not clobber them either.
      if (!scanned.scan.inComponentContext && !scanned.partial) {
        pageDocsRef.current = scanned.docs;
      }
      const active = composeDocs(scanned);
      const content: Content = {
        ...scanned,
        rules: rebuildRules(active),
        embedCount: active.length,
        componentEmbedCount: active.filter((embedDocument) => embedDocument.source.fromComponent)
          .length,
      };
      contentRef.current = content;
      docsRef.current = active;
      inComponentRef.current = content.scan.inComponentContext;
      lastScanAtRef.current = Date.now();
      // Persist completed scans so a reopen restores them (see persistedScan). Skip
      // partials — restoring a page-only snapshot would drop the component chips.
      if (!content.partial) {
        persistedScan = {
          content,
          docs: active,
          pageDocs: pageDocsRef.current,
          inComponent: content.scan.inComponentContext,
          scanAt: lastScanAtRef.current,
        };
      }
      return content;
    },
    [composeDocs, contentRef, docsRef, inComponentRef, lastScanAtRef, pageDocsRef],
  );
  return { storeContent };
}

// Rebuild and store content, flushing deferred page-embed edits first.
function useContentRebuild(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  contentBuild: ReturnType<typeof useContentBuild>,
  contentStore: ReturnType<typeof useContentStore>,
) {
  const { inComponentRef, pageDocsRef, pendingKeysRef } = editorRefs;
  const { setStatus } = scanState;
  const { setPendingKeys } = nativeState;
  const { buildContent } = contentBuild;
  const { storeContent } = contentStore;

  // Write out every page embed that was edited while a component was open, now
  // that the page is writable again. Best-effort: reported, then cleared.
  const flushPending = useCallback(async () => {
    const keys = [...pendingKeysRef.current];
    if (!keys.length) {
      return;
    }
    const byKey = new Map(
      pageDocsRef.current.map((embedDocument) => [embedDocument.source.key, embedDocument]),
    );
    let failed = 0;
    for (const key of keys) {
      const embedDocument = byKey.get(key);
      if (!embedDocument) {
        continue;
      }
      const result = await writeEmbedDocument(embedDocument);
      if (!result.ok) {
        failed += 1;
      }
    }
    pendingKeysRef.current = new Set();
    setPendingKeys(new Set());
    setStatus(
      failed
        ? `Saved your page-embed edits — ${failed} couldn't be written.`
        : 'Saved the page-embed edits you made inside the component.',
    );
  }, [pageDocsRef, pendingKeysRef, setPendingKeys, setStatus]);

  // Rebuild content, flushing any deferred page-embed edits the moment we detect
  // the component was closed (so the fresh page read reflects them). onPartial
  // (foreground only) renders the page-level rules as soon as they're ready,
  // before component embeds finish loading.
  const rebuildAndStore = useCallback(
    async (
      rescan: RescanOptions = {},
      onPartial?: (content: Content) => void,
    ): Promise<Content> => {
      const wasInComponent = inComponentRef.current;
      const emitPartial = onPartial
        ? (partial: Content) => onPartial(storeContent(partial))
        : undefined;
      let content = await buildContent(rescan, emitPartial);
      if (wasInComponent && !content.scan.inComponentContext && pendingKeysRef.current.size) {
        await flushPending();
        content = await buildContent(rescan);
      }
      return storeContent(content);
    },
    [buildContent, flushPending, storeContent, inComponentRef, pendingKeysRef],
  );
  return { rebuildAndStore };
}

// Resolve the selected element against the cached content.
function useApplyResolve(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
) {
  const { appliedKeyRef, classListRef, pageDocsRef, primedRef, seqRef, targetRef } = editorRefs;
  const { setPhase, setScan, setScanningMore, setStatus } = scanState;

  // The cheap part — resolve the selected element against cached content.
  const applyResolve = useCallback(
    async (element: unknown, content: Content, seq: number, silent = false) => {
      // Ask the rendered page first — it knows what components render and what
      // classes ran at runtime; the source tree can't see either. One question
      // covers both halves (identity + which selectors match), so the chips wait
      // out a single round trip rather than two back to back.
      const asked = await askCanvasAbout(serializeElementId(element), content.rules);
      const { target, rootSnapshot } = await resolveTarget(element, content.scan, asked);
      if (seq !== seqRef.current) {
        return;
      }
      targetRef.current = target;
      await primeDomMatches(target, content.rules, asked);
      primedRef.current = { target, key: selectorKeyOf(content.rules) };
      const model = await computeRuleModel(content.rules, target);
      if (seq !== seqRef.current) {
        return;
      }
      // Don't let a lagging partial clobber the final (partials share seq*2+0, the
      // final is seq*2+1 so it always wins; a late partial after it is dropped). A
      // background refresh reuses the same seq and re-applies (equal key ⇒ proceeds).
      const key = seq * 2 + (content.partial ? 0 : 1);
      if (key < appliedKeyRef.current) {
        return;
      }
      appliedKeyRef.current = key;
      // Scaffolds come from the current context's own (writable) embeds — the
      // component's embeds while inside one, the page's otherwise.
      classListRef.current = rootSnapshot.classList;
      setScan(scanStateFor(content, { rootSnapshot, model }, pageDocsRef.current.length));
      setPhase('ready');
      setScanningMore(!!content.partial);
      if (!silent) {
        setStatus(resolveStatus(content, model));
      }
    },
    [
      appliedKeyRef,
      classListRef,
      pageDocsRef,
      primedRef,
      seqRef,
      setPhase,
      setScan,
      setScanningMore,
      setStatus,
      targetRef,
    ],
  );
  return { applyResolve };
}

// Rebuild content in the background, then re-resolve the selection.
function useBackgroundRefresh(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  contentRebuild: ReturnType<typeof useContentRebuild>,
  applyResolveHook: ReturnType<typeof useApplyResolve>,
) {
  const { busyRef, lastScanAtRef, refreshingRef, selectedRef, seqRef } = editorRefs;
  const { setRefreshing } = scanState;
  const { rebuildAndStore } = contentRebuild;
  const { applyResolve } = applyResolveHook;

  // Rebuild content in the background (coalesced + throttled) to pick up embed
  // edits, then re-resolve the current selection — without blocking the UI.
  const backgroundRefresh = useCallback(
    async ({ now = false }: { now?: boolean } = {}) => {
      if (refreshingRef.current || busyRef.current) {
        return;
      }
      // `now` skips the throttle: something rewrote the files or the model out
      // from under the panel (an undo), and waiting out a polling interval to
      // notice is what made the panel trail the canvas.
      if (!now && Date.now() - lastScanAtRef.current < BG_REFRESH_THROTTLE_MS) {
        return;
      }
      refreshingRef.current = true;
      setRefreshing(true);
      try {
        const content = await rebuildAndStore();
        const element = selectedRef.current;
        if (element && scanHasElement(content.scan, element)) {
          await applyResolve(element, content, seqRef.current, true);
        }
      } catch {
        // Background failures are non-fatal — the cached view stays usable.
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    },
    [
      applyResolve,
      rebuildAndStore,
      busyRef,
      lastScanAtRef,
      refreshingRef,
      selectedRef,
      seqRef,
      setRefreshing,
    ],
  );
  return { backgroundRefresh };
}

// Re-match the selectors when the element's classes or attributes changed.
function useRematch(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
) {
  const { busyRef, classListRef, primedRef, selectedRef, targetRef } = editorRefs;
  const { setScan } = scanState;

  // Poll the Designer for out-of-app edits to the SELECTED element — added/removed
  // classes or data attributes, and native class-style changes — and reflect them
  // (the API has no change events). Cheap in steady state: it reads + compares
  // signatures and only touches state when something actually differs. Embed-code
  // edits are picked up separately by the (throttled) backgroundRefresh.
  // Classes / attributes changed → selectors re-match; re-resolve against the cached
  // embeds and refresh the header identity. Reuses the answer the identity read
  // already got back.
  const rematchChanged = useCallback(
    async (
      element: unknown,
      content: Content,
      read: { target: MatchTarget; snap: ElementSnapshot; asked: CanvasAnswer },
    ) => {
      const { target, snap } = read;
      await primeDomMatches(target, content.rules, read.asked);
      primedRef.current = { target, key: selectorKeyOf(content.rules) };
      const model = await computeRuleModel(content.rules, target);
      if (busyRef.current || element !== selectedRef.current) {
        return;
      }
      targetRef.current = target;
      classListRef.current = snap.classList;
      setScan((previous) =>
        previous
          ? {
              ...previous,
              rootSnapshot: snap,
              model,
              placeholders: placeholdersFor(content, snap.classList),
            }
          : previous,
      );
    },
    [busyRef, classListRef, primedRef, selectedRef, setScan, targetRef],
  );
  return { rematchChanged };
}

// Poll the Designer for out-of-app edits to the selected element.
function useDesignerSync(
  editorRefs: ReturnType<typeof useEditorRefs>,
  nativeState: ReturnType<typeof useNativeState>,
  rematch: ReturnType<typeof useRematch>,
) {
  const { busyRef, contentRef, lastSnapSigRef, refreshingRef, selectedRef } = editorRefs;
  const { nativeModelRef, setNativeModel } = nativeState;
  const { rematchChanged } = rematch;

  const syncFromDesigner = useCallback(async () => {
    if (busyRef.current || refreshingRef.current) {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }
    const element = selectedRef.current;
    const content = contentRef.current;
    if (!element || !content || !scanHasElement(content.scan, element)) {
      return;
    }
    const read = await readDesignerState(element, content);
    if (!read) {
      return; // transient read failure — try again next tick
    }
    const { target, snap, native, asked } = read;
    if (busyRef.current || element !== selectedRef.current) {
      return;
    } // a user edit / reselect began
    const snapSig = snapshotSignature(snap);
    // Compare against the model CURRENTLY DISPLAYED (nativeModelRef), not a separate
    // last-seen ref: every authoritative write (refreshNative) and the load effect
    // update nativeModelRef, so this stays in sync automatically. A stale ref here made
    // the poll re-apply an identical model — a redundant full-panel re-render (the
    // flicker) 0–1500ms after every value edit or reset.
    const snapChanged = snapSig !== lastSnapSigRef.current;
    const nativeChanged = nativeSignature(native) !== nativeSignature(nativeModelRef.current);
    if (!snapChanged && !nativeChanged) {
      return;
    }
    lastSnapSigRef.current = snapSig;
    if (nativeChanged) {
      nativeModelRef.current = native;
      setNativeModel(native);
    }
    if (snapChanged) {
      await rematchChanged(element, content, { target, snap, asked });
    }
  }, [
    rematchChanged,
    busyRef,
    contentRef,
    lastSnapSigRef,
    nativeModelRef,
    refreshingRef,
    selectedRef,
    setNativeModel,
  ]);
  return { syncFromDesigner };
}

// Forget the previous element's picks when another element is selected.
function useElementReset(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
) {
  const { selectedElementKeyRef } = editorRefs;
  const { setQuickSnapshot, setScan } = scanState;
  const {
    pendingDefaultRef,
    setSelectedSelectorText,
    setSelectedTokens,
    setStateKey,
    tokenIdentityRef,
  } = selectionState;
  const { nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;

  // A new element must not inherit the previous one's picked selector. Reset the
  // moment the SELECTED ELEMENT changes (not when its token signature does — those
  // can collide across elements), then the tokens effect re-defaults it.
  const resetForElement = useCallback(
    (element: unknown) => {
      const elementKey = element ? serializeElementId(element) : '';
      if (elementKey === selectedElementKeyRef.current) {
        return;
      }
      selectedElementKeyRef.current = elementKey;
      setSelectedSelectorText(undefined);
      setSelectedTokens([]);
      setStateKey('');
      setQuickSnapshot(undefined); // drop the previous element's chips
      // The chips are derived from these two models, and both are refilled by
      // async reads. Left alone they keep listing the PREVIOUS element's
      // selectors until those land — the list looks stale for as long as the
      // scan takes. Blank them now: an empty well for a moment is honest,
      // another element's selectors are not. A cached native model comes
      // straight back in the identity effect, so that case barely blinks.
      setScan((previous) => (previous ? { ...previous, model: EMPTY_RULE_MODEL } : previous));
      setNativeModel(undefined);
      nativeModelRef.current = undefined;
      nativeIdentityRef.current = '';
      // Force the tokens effect to re-default even if the new element shares the old
      // one's token signature (both classless divs, unreadable classes, …).
      tokenIdentityRef.current = '';
      pendingDefaultRef.current = true;
    },
    [
      nativeIdentityRef,
      nativeModelRef,
      pendingDefaultRef,
      selectedElementKeyRef,
      setNativeModel,
      setQuickSnapshot,
      setScan,
      setSelectedSelectorText,
      setSelectedTokens,
      setStateKey,
      tokenIdentityRef,
    ],
  );
  return { resetForElement };
}

// Keep the embeds scanned while no element is selected.
function useScanWithoutSelection(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  contentRebuild: ReturnType<typeof useContentRebuild>,
) {
  const { contentRef, pageDocsRef, selectedRef, seqRef } = editorRefs;
  const { setPhase, setScan, setScanningMore, setStatus } = scanState;
  const { rebuildAndStore } = contentRebuild;

  // The style panel does not depend on a canvas selection. Keep scanning embeds so
  // its source picker and custom-selector writes remain available, but project them
  // through an empty match model until the user types a selector.
  const scanWithoutSelection = useCallback(
    async (seq: number, options: { force?: boolean }) => {
      setPhase('no-selection');
      setScan(undefined);
      setStatus('No element selected — type a selector to style it directly.');
      const showContent = (content: Content) => {
        if (seq !== seqRef.current || selectedRef.current) {
          return;
        }
        setScan(unselectedScanState(content, pageDocsRef.current.length));
        setScanningMore(!!content.partial);
      };
      const cached = contentRef.current;
      if (cached) {
        showContent(cached);
      }
      setScanningMore(true);
      try {
        const content = await rebuildAndStore({ rescanComponents: options.force }, (partial) =>
          showContent(partial),
        );
        showContent(content);
      } catch (error: unknown) {
        if (seq !== seqRef.current || selectedRef.current) {
          return;
        }
        setScanningMore(false);
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [
      rebuildAndStore,
      contentRef,
      pageDocsRef,
      selectedRef,
      seqRef,
      setPhase,
      setScan,
      setScanningMore,
      setStatus,
    ],
  );
  return { scanWithoutSelection };
}

// Scan and resolve a selected element.
function useScanSelection(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  contentRebuild: ReturnType<typeof useContentRebuild>,
  applyResolveHook: ReturnType<typeof useApplyResolve>,
  backgroundRefreshHook: ReturnType<typeof useBackgroundRefresh>,
) {
  const { contentRef, seqRef } = editorRefs;
  const { setPhase, setQuickSnapshot, setScanningMore, setStatus } = scanState;
  const { rebuildAndStore } = contentRebuild;
  const { applyResolve } = applyResolveHook;
  const { backgroundRefresh } = backgroundRefreshHook;

  const scanSelection = useCallback(
    async (element: unknown, seq: number, options: { force?: boolean }) => {
      // Read a fast snapshot (tag + classes) straight off the element so the chips
      // render right away, before the (slower) embed scan produces the full model.
      void buildSnapshot(element)
        .then((snap) => {
          if (seq === seqRef.current) {
            setQuickSnapshot(snap);
          }
        })
        .catch(() => {});

      const cached = contentRef.current;
      const canReuse =
        !options.force && cached !== undefined && scanHasElement(cached.scan, element);

      if (canReuse && cached) {
        // Instant: re-match against cached content, then refresh in the background.
        await applyResolve(element, cached, seq);
        void backgroundRefresh();
        return;
      }

      // First load, a context switch, or a forced rescan → rebuild content.
      // Stream: render page-level rules as soon as the page scan finishes.
      setPhase('scanning');
      setStatus(cached ? 'Loading this view…' : 'Scanning embeds…');
      try {
        const content = await rebuildAndStore({ rescanComponents: options.force }, (partial) => {
          if (seq === seqRef.current) {
            void applyResolve(element, partial, seq);
          }
        });
        if (seq !== seqRef.current) {
          return;
        }
        await applyResolve(element, content, seq);
      } catch (error: unknown) {
        if (seq !== seqRef.current) {
          return;
        }
        setPhase('ready');
        setScanningMore(false);
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [
      applyResolve,
      backgroundRefresh,
      rebuildAndStore,
      contentRef,
      seqRef,
      setPhase,
      setQuickSnapshot,
      setScanningMore,
      setStatus,
    ],
  );
  return { scanSelection };
}

// Resolve a selection, counting the passes still in flight.
function useRefresh(
  editorRefs: ReturnType<typeof useEditorRefs>,
  elementReset: ReturnType<typeof useElementReset>,
  scanWithoutSelectionHook: ReturnType<typeof useScanWithoutSelection>,
  scanSelectionHook: ReturnType<typeof useScanSelection>,
) {
  const { selectedRef, seqRef } = editorRefs;
  const { resetForElement } = elementReset;
  const { scanWithoutSelection } = scanWithoutSelectionHook;
  const { scanSelection } = scanSelectionHook;

  const resolveSelection = useCallback(
    async (element: unknown, options: { force?: boolean } = {}) => {
      const seq = ++seqRef.current;
      selectedRef.current = element;
      resetForElement(element);
      if (!element) {
        await scanWithoutSelection(seq, options);
        return;
      }
      await scanSelection(element, seq, options);
    },
    [resetForElement, scanWithoutSelection, scanSelection, selectedRef, seqRef],
  );

  // Whether the panel is still working out what styles the selected element.
  //
  // The chips are blanked the moment the selection changes (another element's
  // selectors are worse than none) and refilled from canvas round trips, so in
  // between, the selector well is empty — and an empty well otherwise says "nothing
  // styles this". The wait needs to be able to say it is a wait. Counted rather than
  // flagged: reselecting starts a second pass before the first has unwound, and the
  // first one finishing does not mean the panel is settled.
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(0);

  const refresh = useCallback(
    async (element: unknown, options: { force?: boolean } = {}) => {
      resolvingRef.current += 1;
      setResolving(true);
      try {
        await resolveSelection(element, options);
      } finally {
        resolvingRef.current -= 1;
        if (resolvingRef.current === 0) {
          setResolving(false);
        }
      }
    },
    [resolveSelection],
  );
  return { refresh, resolving };
}

// Rescan when the stylesheets change, and follow the Designer's selection.
function useSelectionSubscriptions(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  refreshHook: ReturnType<typeof useRefresh>,
) {
  const { selectedRef, seqRef } = editorRefs;
  const { setPhase, setStatus } = scanState;
  const { setCurrentBreakpoint } = nativeState;
  const { refresh } = refreshHook;

  // The project's stylesheets are listed asynchronously (style:listFiles and the
  // Astro global-block scan), and the panel is usually mounted and finished
  // scanning before that list lands: it reads no files, matches nothing, and
  // calls itself ready with an empty well. It used to stay that way until the
  // next background refresh came round — throttled to 4s, which is exactly how
  // long the well sat empty on a layout. Rescan as soon as the list changes
  // instead.
  const sheetSigRef = useRef(sheetSignature());
  useEffect(
    () =>
      onHostChange(() => {
        const sig = sheetSignature();
        if (sig === sheetSigRef.current) {
          return;
        }
        sheetSigRef.current = sig;
        void refresh(selectedRef.current, { force: true });
      }),
    [refresh, selectedRef],
  );

  useEffect(() => {
    const api = webflowApi();
    if (!api?.getSelectedElement) {
      setPhase('unsupported');
      setStatus('The Webflow selection API is unavailable. Open this inside the Designer.');
      return;
    }
    void api.getSelectedElement().then((element) => refresh(element));
    void getCurrentBreakpoint().then(setCurrentBreakpoint);
    const unsubscribe = api.subscribe?.('selectedelement', (element) => void refresh(element));
    const unsubBreakpoint = api.subscribe?.('mediaquery', (bp) =>
      setCurrentBreakpoint(isBreakpointId(bp) ? bp : 'main'),
    );
    return () => {
      seqRef.current += 1;
      unsubscribe?.();
      unsubBreakpoint?.();
    };
  }, [refresh, seqRef, setCurrentBreakpoint, setPhase, setStatus]);
}

// Re-read after undo/redo and class changes, and poll while an element is shown.
function useChangeSubscriptions(
  scanState: ReturnType<typeof useScanState>,
  backgroundRefreshHook: ReturnType<typeof useBackgroundRefresh>,
  designerSync: ReturnType<typeof useDesignerSync>,
) {
  const { phase } = scanState;
  const { backgroundRefresh } = backgroundRefreshHook;
  const { syncFromDesigner } = designerSync;

  // Undo and redo rewrite the stylesheets and the page model directly, so the
  // panel's cached docs are stale the moment they run. The app bumps a counter;
  // re-read as soon as it moves rather than on the next poll.
  const historyRef = useRef(getHost().historyTick);
  useEffect(
    () =>
      onHostChange(() => {
        const tick = getHost().historyTick;
        if (tick === historyRef.current) {
          return;
        }
        historyRef.current = tick;
        void backgroundRefresh({ now: true });
      }),
    [backgroundRefresh],
  );

  // A class added to (or taken off) the selected element changes which selectors
  // target it — and nothing tells the panel. It used to find out on its next poll,
  // up to 1.5s later, which is the whole of that wait: the stylesheets are already
  // parsed in memory, so re-resolving is one canvas round trip and a re-match, no
  // disk. Nudge it the moment the model changes. The background rebuild that re-reads
  // the files still runs on its own throttle, for edits made outside the app.
  const classSigRef = useRef('');
  useEffect(() => {
    const onClasses = () => {
      const host = getHost();
      const sig = `${authoredClasses().join(' ')}|${(host.renderedClasses || []).join(' ')}`;
      if (sig === classSigRef.current) {
        return;
      }
      const first = classSigRef.current === '';
      classSigRef.current = sig;
      if (!first) {
        void syncFromDesigner();
      }
    };
    onClasses();
    return onHostChange(onClasses);
  }, [syncFromDesigner]);

  // While an element is shown, poll for out-of-app edits and keep the panel in sync.
  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }
    const id = window.setInterval(() => {
      void syncFromDesigner(); // classes / attributes / native styles
      void backgroundRefresh(); // embed-code edits (self-throttled)
    }, DESIGNER_SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [phase, syncFromDesigner, backgroundRefresh]);
}

// Rebuild the panel's model after an edit.
function useRefreshDerived(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
) {
  const { classListRef, contentRef, docsRef, primedRef, targetRef } = editorRefs;
  const { setScan } = scanState;

  const refreshDerived = useCallback(async () => {
    // The page's computed values were measured against the CSS as it was a
    // moment ago, and an edit is exactly what changes them. They used to be
    // forgotten only when the canvas re-walked its markers — which a CSS-only
    // edit never makes it do, because the dev server delivers CSS by swapping a
    // <style> in <head> rather than re-rendering the page.
    //
    // A control that shows a COMPUTED value while nothing declares its property
    // therefore went on showing the value from before the edit: clear
    // `text-align` and the segment for the old alignment stayed lit, while the
    // canvas behind it had already gone back to the inherited one.
    forgetComputedStyles();
    forgetComputedColors();
    const rules = rebuildRules(docsRef.current);
    if (contentRef.current) {
      contentRef.current.rules = rules;
    }
    const target = targetRef.current;
    if (!target) {
      return;
    }
    // Only re-ask the page when the question changed. domMatched is keyed by
    // selector text, so as long as the same element is selected and the same
    // selectors exist, the answers it holds are still the answers — and an
    // edit that only changed a VALUE (most of them) changes neither. Asking
    // anyway put a round trip, and its 1.5s ceiling, after every click.
    const key = selectorKeyOf(rules);
    if (!(primedRef.current?.target === target && primedRef.current.key === key)) {
      await primeDomMatches(target, rules);
      primedRef.current = { target, key };
    }
    const model = await computeRuleModel(rules, target);
    const placeholders = contentRef.current?.scan.inComponentContext
      ? computePlaceholders(contentRef.current.docs, classListRef.current)
      : [];
    setScan((previous) => (previous ? { ...previous, model, placeholders } : previous));
  }, [classListRef, contentRef, docsRef, primedRef, setScan, targetRef]);

  // An undo/redo rewrote a stylesheet and re-parsed its doc in place — re-resolve
  // so the fields show what the file now says.
  useEffect(
    () =>
      onDocsReloaded(() => {
        void refreshDerived();
      }),
    [refreshDerived],
  );
  return { refreshDerived };
}

// Scope an edit of a grouped rule to the active selector alone.
function useSplitForEdit(nativeState: ReturnType<typeof useNativeState>) {
  const { activeSelectorRef } = nativeState;

  // True when the active selector is ONE splittable member of a grouped rule
  // (`.a::before, .b::after { … }`) — i.e. an edit should be scoped to just that
  // selector rather than the whole comma-separated group. Complex grouped
  // selectors (shown as a single full-group chip) don't match any lone member and
  // so return false — they edit the whole rule.
  const isGroupedSplittable = useCallback(
    (rule: ParsedRule): boolean => {
      const selectors = rule.node.selectors;
      const active = activeSelectorRef.current;
      if (!selectors || selectors.length <= 1 || !active) {
        return false;
      }
      return selectors.some(
        (selector) => selectorsMatch(selector, active) && canonicalCompound(selector).splittable,
      );
    },
    [activeSelectorRef],
  );
  // Isolate the active selector out of a grouped rule before editing so the change
  // only affects the selected chip, leaving the group's other selectors untouched.
  // Returns the rule to edit (the isolated clone, or the original when there's
  // nothing to split) plus a remapper from an original decl to its clone
  // counterpart (declarations are cloned in the same order) for decl-addressed edits.
  const splitForEdit = useCallback(
    (
      rule: ParsedRule,
    ): {
      rule: ParsedRule;
      remap: (decl: ParsedDeclaration) => ParsedDeclaration;
    } => {
      const identity = { rule, remap: (declaration: ParsedDeclaration) => declaration };
      const selectors = rule.node.selectors;
      const active = activeSelectorRef.current;
      if (!selectors || selectors.length <= 1 || !active) {
        return identity;
      }
      const index = selectors.findIndex(
        (selector) => selectorsMatch(selector, active) && canonicalCompound(selector).splittable,
      );
      if (index < 0) {
        return identity;
      }
      const origNodes: Declaration[] = [];
      rule.node.walkDecls((declaration) => {
        origNodes.push(declaration);
      });
      const clone = splitRuleSelectorAt(rule.node, index);
      if (!clone) {
        return identity;
      }
      const cloneNodes: Declaration[] = [];
      clone.walkDecls((declaration) => {
        cloneNodes.push(declaration);
      });
      const editRule: ParsedRule = {
        ...rule,
        node: clone,
        selectorText: clone.selector,
        selectors: parseSelectorList(clone.selector),
        declarations: rule.declarations.map((declaration, i) => ({
          ...declaration,
          node: cloneNodes[i] ?? declaration.node,
        })),
      };
      const remap = (decl: ParsedDeclaration): ParsedDeclaration => {
        const i = origNodes.indexOf(decl.node);
        return i >= 0 ? (editRule.declarations[i] ?? decl) : decl;
      };
      return { rule: editRule, remap };
    },
    [activeSelectorRef],
  );
  return { isGroupedSplittable, splitForEdit };
}

// Apply an edit to an embed rule and persist it.
function useApplyEdit(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  refreshDerivedHook: ReturnType<typeof useRefreshDerived>,
) {
  const { setBusyBoth, setSaveError } = busyState;
  const { setStatus } = scanState;
  const { documentByKey, settleEmbedWrite } = pendingWrites;
  const { refreshDerived } = refreshDerivedHook;

  // Classes typed into the selector box whose page edit has not answered yet,
  // by selector: the rule for one is written only once its class is on the
  // element (step 6, plan §3.3 — the dependent write is outcome-gated).
  const classGatesRef = useRef(new Map<string, Promise<ClassOutcome>>());

  // A rule for a class typed into the selector box waits for that class's page edit.
  // Never submitted when refused: a rule for a class the element does not carry would
  // be half a gesture. The page's own notice says why its edit failed.
  const passesClassGate = useCallback(
    async (rule: ParsedRule): Promise<boolean> => {
      const gate = classGatesRef.current.get(rule.selectorText);
      if (!gate) {
        return true;
      }
      const outcome = await gate;
      classGatesRef.current.delete(rule.selectorText);
      if (outcome.tag !== 'refused') {
        return true;
      }
      const why = `${rule.selectorText} is not on the element (${outcome.message})`;
      setSaveError(`${why}, so its rule was not written.`);
      return false;
    },
    [setSaveError],
  );

  // Run a synchronous AST mutation, refresh the model, then persist the embed.
  const applyEdit = useCallback(
    async (rule: ParsedRule, mutate: () => boolean | void) => {
      const embedDocument = documentByKey.get(rule.embedKey);
      if (!embedDocument) {
        setStatus('Lost track of the source embed — try Rescan.');
        return;
      }
      if (!(await passesClassGate(rule))) {
        return;
      }
      setBusyBoth(true);
      setStatus('Saving…');
      // try/finally so `busy` ALWAYS clears — a throw here (e.g. materializing a complex
      // nested selector) must not leave the panel stuck busy, which disables every button.
      try {
        const result = mutate();
        if (result === false) {
          setStatus('Nothing to save.');
          return;
        }
        // Persist FIRST, then rebuild the panel's own model. The write is what the canvas
        // sees, and refreshDerived re-resolves every rule against the element — running it
        // first put a full model rebuild (and, for a <style> node, the page save behind it)
        // between the click and the canvas, so the edit showed up seconds late.
        const writeResult = await writeEmbedDocument(embedDocument);
        await refreshDerived();
        if (!settleEmbedWrite(embedDocument, writeResult, 'rule')) {
          return;
        }
        setStatus(
          rule.fromComponent
            ? 'Saved. This embed is shared by every instance of ' +
                `${rule.componentName ?? 'the component'}.`
            : 'Saved to embed.',
        );
      } finally {
        setBusyBoth(false);
      }
    },
    [documentByKey, passesClassGate, refreshDerived, setBusyBoth, settleEmbedWrite, setStatus],
  );
  return { applyEdit, classGatesRef };
}

// Set and clear a property on an embed rule.
function usePropEdits(
  splitForEditHook: ReturnType<typeof useSplitForEdit>,
  applyEditHook: ReturnType<typeof useApplyEdit>,
) {
  const { splitForEdit } = splitForEditHook;
  const { applyEdit } = applyEditHook;

  // Property-addressed writes for always-rendered controls. We look up nodes in
  // the live postcss AST (not rule.declarations) so these stay correct after a
  // live edit appended a node the model hasn't rebuilt yet — otherwise a blur
  // commit would double-add. Update-or-add on set; remove every match on clear.
  const onSetProp = useCallback(
    (rule: ParsedRule, prop: string, value: string, important: boolean) => {
      void applyEdit(rule, () => {
        const { rule: editRule } = splitForEdit(rule);
        const target = lastDeclFor(editRule, prop);
        if (target) {
          target.value = value;
          target.important = important;
          return;
        }
        return addDeclaration(editRule, prop, { value, important });
      });
    },
    [applyEdit, splitForEdit],
  );
  const onClearProp = useCallback(
    (rule: ParsedRule, prop: string | string[]) => {
      const props = Array.isArray(prop) ? prop : [prop];
      void applyEdit(rule, () => {
        const { rule: editRule } = splitForEdit(rule);
        const targets: Declaration[] = [];
        directDecls(editRule.node).forEach((decl) => {
          if (props.includes(decl.prop)) {
            targets.push(decl);
          }
        });
        if (!targets.length) {
          return false;
        }
        targets.forEach((decl) => decl.remove());
        removeRuleIfEmpty(editRule);
        return;
      });
    },
    [applyEdit, splitForEdit],
  );
  return { onClearProp, onSetProp };
}

// Live writes to an embed rule while typing or scrubbing.
function useLiveEdits(
  editorRefs: ReturnType<typeof useEditorRefs>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  splitForEditHook: ReturnType<typeof useSplitForEdit>,
) {
  const { inComponentRef } = editorRefs;
  const { documentByKey, markPending } = pendingWrites;
  const { isGroupedSplittable } = splitForEditHook;

  // What a live write overwrote, per property — captured on the FIRST live write since
  // the last commit, so onRevertProp can put it back if the edit is abandoned (scrubbing
  // out of a dropdown without picking). `undefined` records "the property wasn't there".
  const liveOriginRef = useRef(
    new Map<string, { value: string; important: boolean } | undefined>(),
  );
  // Live set while typing: mutate (or append) the AST node and write straight to
  // the embed so the canvas updates in real time — no busy flag, no model rebuild
  // (blur runs the authoritative onSetProp). Mirrors onLiveCommitValue.
  const onLiveSetProp = useCallback(
    (rule: ParsedRule, prop: string, value: string, important: boolean) => {
      // Defer grouped-splittable edits to the blur commit (onSetProp splits first).
      if (isGroupedSplittable(rule)) {
        return;
      }
      const embedDocument = documentByKey.get(rule.embedKey);
      if (!embedDocument) {
        return;
      }
      const matches = declsFor(rule, prop);
      const target = matches[matches.length - 1];
      if (!liveOriginRef.current.has(prop)) {
        liveOriginRef.current.set(
          prop,
          target ? { value: target.value, important: !!target.important } : undefined,
        );
      }
      if (target) {
        target.value = value;
        target.important = important;
      } else {
        appendDecl(rule.node, prop, { value, important });
      }
      void writeEmbedDocument(embedDocument, true).then((result) => {
        if (!result.ok && inComponentRef.current && !embedDocument.source.fromComponent) {
          markPending(embedDocument.source.key);
        }
      });
    },
    [documentByKey, markPending, isGroupedSplittable, inComponentRef],
  );
  return { liveOriginRef, onLiveSetProp };
}

// Revert live writes, remove a rule, and save a rule's CSS.
function useRuleActions(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  splitForEditHook: ReturnType<typeof useSplitForEdit>,
  applyEditHook: ReturnType<typeof useApplyEdit>,
  liveEdits: ReturnType<typeof useLiveEdits>,
) {
  const { inComponentRef } = editorRefs;
  const { setSaveError } = busyState;
  const { documentByKey, markPending } = pendingWrites;
  const { splitForEdit } = splitForEditHook;
  const { applyEdit } = applyEditHook;
  const { liveOriginRef } = liveEdits;

  // Undo the live writes for `prop` — restore the value they overwrote, or remove the
  // declaration again if there wasn't one. The rule itself is left alone even if that
  // empties it: an abandoned preview must not delete anything the user had.
  const onRevertProp = useCallback(
    (rule: ParsedRule, prop: string) => {
      if (!liveOriginRef.current.has(prop)) {
        return;
      }
      const origin = liveOriginRef.current.get(prop);
      liveOriginRef.current.delete(prop);
      const embedDocument = documentByKey.get(rule.embedKey);
      if (!embedDocument) {
        return;
      }
      const matches = declsFor(rule, prop);
      const target = matches[matches.length - 1];
      if (origin) {
        if (target) {
          target.value = origin.value;
          target.important = origin.important;
        } else {
          appendDecl(rule.node, prop, { value: origin.value, important: origin.important });
        }
      } else if (target) {
        target.remove();
      }
      void writeEmbedDocument(embedDocument, true).then((result) => {
        if (!result.ok && inComponentRef.current && !embedDocument.source.fromComponent) {
          markPending(embedDocument.source.key);
        }
      });
    },
    [documentByKey, markPending, inComponentRef, liveOriginRef],
  );
  const onRemoveRule = useCallback(
    (rule: ParsedRule) => {
      void applyEdit(rule, () => removeRule(splitForEdit(rule).rule));
    },
    [applyEdit, splitForEdit],
  );
  const onSaveCssRule = useCallback(
    (rule: ParsedRule, css: string) => {
      void applyEdit(rule, () => {
        const result = replaceRuleCss(rule, css);
        if (!result.ok) {
          setSaveError(`Invalid CSS: ${result.error}`);
          return false;
        }
        return true;
      });
    },
    [applyEdit, setSaveError],
  );
  return { onRemoveRule, onRevertProp, onSaveCssRule };
}

// Open an embed on the canvas, and keep the resolved view for the next mount.
function useOpenEmbed(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
) {
  const { pageInstancesRef, selectedElementKeyRef } = editorRefs;
  const { quickSnapshot, scan, setStatus } = scanState;
  const { documentByKey } = pendingWrites;

  // Select the source embed on the Webflow canvas (from a provenance embed chip).
  // Component embeds carry no page instance, so pass the current page's instances
  // for navigateToEmbed to find one to enter.
  const openEmbedByKey = useCallback(
    (embedKey: string) => {
      const embedDocument = documentByKey.get(embedKey);
      if (!embedDocument) {
        setStatus('Lost track of the source embed — try Rescan.');
        return;
      }
      void navigateToEmbed(embedDocument.source, pageInstancesRef.current).then((result) => {
        if (!result.ok) {
          setStatus(`Couldn't open it on the canvas: ${result.error}`);
        }
      });
    },
    [documentByKey, pageInstancesRef, setStatus],
  );

  // Keep the resolved view at module scope so the next mount starts from it (see
  // persistedView). Written as it changes rather than on unmount, which React skips
  // when the whole tree goes.
  useEffect(() => {
    const host = getHost();
    if (!host.selectedId || !scan) {
      return;
    }
    persistedView = {
      hostId: host.selectedId,
      filePath: host.openFilePath,
      elementKey: selectedElementKeyRef.current,
      scan,
      quick: quickSnapshot,
    };
  }, [scan, quickSnapshot, selectedElementKeyRef]);
  return { openEmbedByKey };
}

// The element's snapshot, tokens, and selector suggestions.
function useElementTokens(scanState: ReturnType<typeof useScanState>) {
  const { quickSnapshot, removedClasses, scan } = scanState;

  // Prefer the scan's full rootSnapshot; fall back to the fast quick snapshot so
  // the chips show while the scan is still running. Either can still carry a class
  // the element has just lost (both union in what the preview last reported), so
  // those are taken out here rather than waited out.
  const snapshot = useMemo(
    () => withoutClasses(scan?.rootSnapshot ?? quickSnapshot ?? undefined, removedClasses),
    [scan, quickSnapshot, removedClasses],
  );

  const model = scan?.model;
  const tokens = useMemo(() => snapshotTokens(snapshot), [snapshot]);

  // Autocomplete suggestions for the add-selector input: the element's tag, each
  // class, each data attribute (presence, then valued), then its combo class chains
  // (cumulative in applied order, like Webflow combos).
  const selectorSuggestions = useMemo<SelectorSuggestion[]>(() => {
    const out: SelectorSuggestion[] = [];
    const tagTok = tokens.find((token) => token.kind === 'tag');
    if (tagTok) {
      out.push({ selector: tagTok.label ?? tagTok.name, kind: 'tag' });
    }
    const classNames = tokens
      .filter((token) => token.kind === 'class')
      .map((token) => token.label ?? token.name.slice('class:'.length));
    for (const cls of classNames) {
      out.push({ selector: `.${cls}`, kind: 'class' });
    }
    const attrNames = tokens
      .filter((token) => token.kind === 'attribute')
      .map((token) => token.label ?? token.name.slice('attr:'.length));
    for (const name of attrNames) {
      out.push({ selector: `[${name}]`, kind: 'attribute' });
    }
    for (const name of attrNames) {
      const value = snapshot?.attributes?.[name];
      if (value) {
        out.push({ selector: `[${name}="${value}"]`, kind: 'attribute-value' });
      }
    }
    for (let i = 2; i <= classNames.length; i += 1) {
      out.push({
        selector: classNames
          .slice(0, i)
          .map((name) => `.${name}`)
          .join(''),
        kind: 'combo',
      });
    }
    return out;
  }, [tokens, snapshot]);
  return { model, selectorSuggestions, snapshot, tokens };
}

// Re-default the picked selector when the element changes.
function useTokenDefault(
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
) {
  const { setNativeFallback } = scanState;
  const {
    defaultTokensRef,
    pendingDefaultRef,
    setSelectedSelectorText,
    setSelectedTokens,
    setStateKey,
    tokenIdentityRef,
    typedClassRef,
  } = selectionState;
  const { tokens } = elementTokens;

  // Re-default the picked selector when the element changes: the element's FIRST
  // class → else last data attribute → else the tag. Also reset context/state.
  //
  // It used to be every class the element has, joined — Webflow's model, where
  // a combo IS the thing being styled. Here it meant the first property written
  // created `.layout.card.theme-dark.flex-grow.theme-brand { … }`, and because
  // the combo then counted as "already styled", the upgrade below kept it and
  // every property after it landed there too. A five-class rule nothing else can
  // reuse, built one property at a time, from a default nobody chose.
  //
  // The primary class is what a class system is authored against; a combo is a
  // deliberate act, so it takes picking that chip.
  useEffect(() => {
    const identity = tokens.map((token) => token.name).join('|');
    if (identity === tokenIdentityRef.current) {
      return;
    }
    tokenIdentityRef.current = identity;
    const typedClass = typedClassRef.current;
    if (typedClass !== undefined) {
      if (tokens.some((token) => token.name === `class:${typedClass}`)) {
        // The class the user typed reached the element: the same element, with
        // the selector they chose already active.
        typedClassRef.current = undefined;
        return;
      }
    }
    const next = defaultSelectorTokens(tokens);
    setSelectedTokens(next);
    setSelectedSelectorText(undefined);
    defaultTokensRef.current = next;
    pendingDefaultRef.current = true;
    // Keep the current query (context) — switching elements stays on the same
    // breakpoint/query so you can style a different element within it. It only
    // changes when you pick a different query yourself.
    setStateKey('');
    // Keep the picked source embed too: switching elements shouldn't forget where
    // the user chose to add new styles. (It falls back to the first embed only if
    // that source isn't available for the new element — see effectiveSourceSel.)
    setNativeFallback(undefined);
  }, [
    tokens,
    defaultTokensRef,
    pendingDefaultRef,
    setNativeFallback,
    setSelectedSelectorText,
    setSelectedTokens,
    setStateKey,
    tokenIdentityRef,
    typedClassRef,
  ]);

  // The element's identity (tag + classes + attrs) as a stable key — drives the
  // native-style read so it re-runs on selection or class changes, not on every
  // background embed refresh.
  const elementIdentity = useMemo(() => tokens.map((token) => token.name).join('|'), [tokens]);
  return { elementIdentity };
}

// Serve a cached native model for an element's class signature.
function useCachedNative(nativeState: ReturnType<typeof useNativeState>) {
  const { nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;

  // Read the selected element's native class styles across every Webflow breakpoint
  // AND every interaction state — the selector-chip picker lists stateful selectors
  // (`.test:hover`) regardless of the current view, so all states must be read.
  // Re-reads only on element / class change (not on state, which is now derived).
  // Instant: serve the cached model for this class-signature while re-reading in the
  // background, so re-selecting an element doesn't re-lag its native chips.
  const serveCachedNative = useCallback(
    (identity: string) => {
      const cached = nativeModelCache.get(identity);
      if (!cached && nativeModelRef.current) {
        // A class change on the same element: the model in hand describes the old
        // class list, so it can't stand in while the new one loads.
        nativeModelRef.current = undefined;
        nativeIdentityRef.current = '';
        setNativeModel(undefined);
      }
      if (cached) {
        // Show the cached chips immediately, but do NOT advance nativeIdentityRef here:
        // setNativeModel is async, so the ref would outrun the model the smart-default
        // effect still sees this render and let it default off a stale nativeModel. The
        // ref only advances in the async read below, where it moves with the model.
        nativeModelRef.current = cached;
        setNativeModel(cached);
      }
      return cached;
    },
    [nativeIdentityRef, nativeModelRef, setNativeModel],
  );
  return { serveCachedNative };
}

// Read the selected element's native class styles.
function useNativeRead(
  editorRefs: ReturnType<typeof useEditorRefs>,
  nativeState: ReturnType<typeof useNativeState>,
  tokenDefault: ReturnType<typeof useTokenDefault>,
  cachedNative: ReturnType<typeof useCachedNative>,
) {
  const { selectedRef } = editorRefs;
  const { nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;
  const { elementIdentity } = tokenDefault;
  const { serveCachedNative } = cachedNative;

  useEffect(() => {
    const selectedElement = selectedRef.current;
    if (!selectedElement) {
      setNativeModel(undefined);
      nativeModelRef.current = undefined;
      nativeIdentityRef.current = '';
      return;
    }
    const cached = serveCachedNative(elementIdentity);
    let cancelled = false;
    // On a cold read (no cache), stream each scan phase into the UI so the selected
    // element's class styles + selectors appear as they're found, not after the whole
    // scan. On a cache hit the shown model is already complete, so skip partials (they
    // would flash a less-complete model) and just swap in the fresh final model.
    const onPartial = cached
      ? undefined
      : (partial: NativeModel) => {
          if (cancelled) {
            return;
          }
          // Update the ref too, so a write mid-scan targets what's shown. Leave
          // nativeIdentityRef to the final model, so the smart-default selection is picked
          // off the COMPLETE model rather than an early partial.
          nativeModelRef.current = partial;
          setNativeModel(partial);
        };
    // Read native styles from the RESOLVED identity element (a component instance's
    // root), not the raw selection — the instance wrapper carries no classes of its
    // own, so reading it directly yields nothing outside the component.
    void resolveIdentityElement(selectedElement)
      .then((identity) => readNativeStyles(identity, STATES, onPartial))
      .then((model) => {
        if (cancelled) {
          return;
        }
        nativeModelCache.set(elementIdentity, model);
        nativeModelRef.current = model;
        nativeIdentityRef.current = elementIdentity;
        setNativeModel(model);
      });
    return () => {
      cancelled = true;
    };
  }, [
    elementIdentity,
    serveCachedNative,
    nativeIdentityRef,
    nativeModelRef,
    selectedRef,
    setNativeModel,
  ]);
}

// The selector being edited, and a typed standalone class's native styles.
function useActiveSelector(
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
) {
  const { phase } = scanState;
  const { selectedSelectorText, selectedTokens } = selectionState;
  const { activeSelectorRef, nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;
  const { tokens } = elementTokens;

  const selectedSelector = useMemo(
    () => tokensToSelector(selectedTokens, tokens),
    [selectedTokens, tokens],
  );
  // The full selector currently being edited: an explicit chip/typed pick when set,
  // else the one composed from the token chips.
  const activeSelector = selectedSelectorText ?? selectedSelector;
  useEffect(() => {
    activeSelectorRef.current = activeSelector;
  }, [activeSelector, activeSelectorRef]);

  // With no canvas selection, a typed standalone class is still a complete native
  // target: look it up directly in the project's Style API so its values and state
  // styles can be shown and edited just like an applied class.
  const standaloneClass =
    phase === 'no-selection' ? standaloneNativeClass(activeSelector) : undefined;
  useEffect(() => {
    if (phase !== 'no-selection') {
      return;
    }
    if (!standaloneClass) {
      nativeModelRef.current = undefined;
      nativeIdentityRef.current = '';
      setNativeModel(undefined);
      return;
    }
    let cancelled = false;
    void readNativeStyleByName(standaloneClass, STATES).then((next) => {
      if (cancelled) {
        return;
      }
      nativeModelRef.current = next;
      nativeIdentityRef.current = `standalone:${standaloneClass}`;
      setNativeModel(next);
    });
    return () => {
      cancelled = true;
    };
  }, [phase, standaloneClass, nativeIdentityRef, nativeModelRef, setNativeModel]);
  return { activeSelector };
}

// Pick a selector, or a typed nested one, as the edit target.
function useSelectorPick(
  editorRefs: ReturnType<typeof useEditorRefs>,
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
) {
  const { selectedRef } = editorRefs;
  const { pendingDefaultRef, setContext, setSelectedSelectorText, setSelectedTokens, setStateKey } =
    selectionState;
  const { tokens } = elementTokens;

  // Pick any matched selector (a chip, an override-note jump, or a typed one) as the
  // edit target. Sync the token pick + interaction state so native editing (class +
  // pseudo) still resolves; a complex selector clears the tokens (embed-only) and
  // its rule is created in the selected embed on first edit.
  // Queries typed into the add-selector field that may not exist in an embed yet —
  // kept so they're selectable in the dropdown until the rule is created.
  const [typedContexts, setTypedContexts] = useState<string[]>([]);
  // The nesting path from a typed selector (`.hero { @container { .title } }`), so the
  // first edit writes NESTED source into the embed rather than a flat selector.
  const typedPathRef = useRef<{ selector: string; ctx: string; path: NestStep[] } | undefined>(
    undefined,
  );
  const selectActiveSelector = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      pendingDefaultRef.current = false;
      typedPathRef.current = undefined; // a manual pick cancels a typed nesting path
      setSelectedSelectorText(trimmed);
      const simple = canonicalCompound(trimmed).simple;
      const matchedTokens = simple ? selectorToClassTokens(trimmed, tokens) : undefined;
      const standalone = !selectedRef.current ? standaloneNativeClass(trimmed) : undefined;
      setSelectedTokens(matchedTokens ?? (standalone ? [`class:${standalone}`] : []));
      setStateKey(stateForSelector(trimmed));
    },
    [
      tokens,
      pendingDefaultRef,
      selectedRef,
      setSelectedSelectorText,
      setSelectedTokens,
      setStateKey,
    ],
  );
  // Add a selector typed in the field — supports CSS nesting / a query, e.g.
  // `.hero { .title }`, `.hero { @container (width < 50em) { .title } }`, or
  // `.hero { @container (width < 50em) }`: resolve to the deepest selector + its query
  // context and select it there. A plain selector (no braces) is used as-is.
  // A selector typed with nesting / a query: select its deepest selector in its query
  // context, and remember the path so the first edit writes NESTED source, not a flat
  // rule.
  const selectNested = useCallback(
    (parsed: NestedInput) => {
      const contextKey = parsed.atContext.join(' › ');
      if (contextKey) {
        setTypedContexts((previous) =>
          previous.includes(contextKey) ? previous : [...previous, contextKey],
        );
        setContext(contextKey);
      } else {
        setContext('');
      }
      selectActiveSelector(parsed.selector);
      if (parsed.path.length >= 2) {
        typedPathRef.current = {
          selector: parsed.selector,
          ctx: contextKey,
          path: parsed.path,
        };
      }
    },
    [selectActiveSelector, setContext],
  );
  return { selectActiveSelector, selectNested, setTypedContexts, typedContexts, typedPathRef };
}

// Add a typed selector, or deselect.
function useTypedSelector(
  editorRefs: ReturnType<typeof useEditorRefs>,
  selectionState: ReturnType<typeof useSelectionState>,
  applyEditHook: ReturnType<typeof useApplyEdit>,
  selectorPick: ReturnType<typeof useSelectorPick>,
) {
  const { primedRef } = editorRefs;
  const {
    pendingDefaultRef,
    setSelectedSelectorText,
    setSelectedTokens,
    setStateKey,
    typedClassRef,
  } = selectionState;
  const { classGatesRef } = applyEditHook;
  const { selectActiveSelector, selectNested } = selectorPick;

  const addTypedSelector = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }
      if (trimmed.includes('{')) {
        const parsed = parseNestedInput(trimmed);
        if (parsed) {
          selectNested(parsed);
          return;
        }
      }
      const loneClass = loneTypedClass(trimmed);
      if (loneClass !== undefined) {
        typedClassRef.current = loneClass;
        const gate = getHost().addClass?.(loneClass);
        // The rule this selector will get depends on the page edit: its first
        // write waits for that edit's outcome (step 6, plan §3.3).
        if (gate) {
          classGatesRef.current.set(trimmed, gate);
        }
        // The element itself changed, so the matches the canvas gave us for these
        // same selectors no longer hold — ask again on the next refresh.
        primedRef.current = undefined;
      }
      selectActiveSelector(trimmed);
    },
    [selectActiveSelector, selectNested, classGatesRef, primedRef, typedClassRef],
  );
  // Deselect (click the active chip again): no selector is picked, so the panel
  // shows every property's cascade winner read-only. The first edit re-picks a
  // default target (see autoSelectForEdit).
  const deselect = useCallback(() => {
    pendingDefaultRef.current = false;
    setSelectedTokens([]);
    setSelectedSelectorText(undefined);
    setStateKey('');
  }, [pendingDefaultRef, setSelectedSelectorText, setSelectedTokens, setStateKey]);
  return { addTypedSelector, deselect };
}

// Jump to a selector and focus one of its property fields.
function useFocusProp(
  editorRefs: ReturnType<typeof useEditorRefs>,
  selectorPick: ReturnType<typeof useSelectorPick>,
) {
  const { rootRef } = editorRefs;
  const { selectActiveSelector } = selectorPick;

  // A pending "focus this property's input" request — set when you click an override
  // tag, consumed once the newly-picked selector has rendered.
  const [focusProp, setFocusProp] = useState<string | undefined>(undefined);
  // Jump the pick to the selector that overrides the current value (e.g. click
  // `.test.is-2` in the override note) so you can edit whatever actually wins, then
  // focus that property's field.
  const onSelectSelector = useCallback(
    (selectorText: string, prop?: string) => {
      selectActiveSelector(selectorText);
      if (prop) {
        setFocusProp(prop);
      }
    },
    [selectActiveSelector],
  );
  useEffect(() => {
    if (!focusProp) {
      return;
    }
    // Wait a frame so the re-picked selector's fields have rendered, then focus.
    const raf = requestAnimationFrame(() => {
      const field = rootRef.current?.querySelector<HTMLElement>(`[data-prop="${focusProp}"]`);
      field?.focus();
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.select();
      }
      setFocusProp(undefined);
    });
    return () => cancelAnimationFrame(raf);
  }, [focusProp, rootRef]);
  return { onSelectSelector };
}

// The stylesheet new rules land in, and its queries' uses.
function useSourceDocument(
  nativeState: ReturnType<typeof useNativeState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
) {
  const { sourceSelection } = nativeState;
  const { documentByKey } = pendingWrites;

  // The stylesheet a new rule would land in: the user's pick, or the first embed
  // in page order — the same default `effectiveSourceSel` settles on below, worked
  // out here because the queries dropdown needs it before that line runs.
  const sourceDocument = useMemo<EmbedDocument | undefined>(() => {
    if (sourceSelection && documentByKey.has(sourceSelection)) {
      return documentByKey.get(sourceSelection);
    }
    return [...documentByKey.values()].sort(
      (left, right) => left.source.order - right.source.order,
    )[0];
  }, [sourceSelection, documentByKey]);
  // How many blocks in that stylesheet each query is written in. Drives the edit
  // pencil in the query dropdown (a query this file doesn't hold can't be renamed
  // from here) and the "3 blocks in ContentWrapper" count on the rename form.
  const queryUses = useMemo(() => {
    const uses = new Map<string, number>();
    if (!sourceDocument) {
      return uses;
    }
    for (const region of sourceDocument.regions) {
      region.root?.walkAtRules((at) => {
        const name = at.name.toLowerCase();
        if (name !== 'media' && name !== 'supports' && name !== 'container') {
          return;
        }
        // Keyed so two spellings of one query count as one — the pencil on
        // either row then reports, and renames, both.
        const text = queryKey(atRuleQueryText(at));
        uses.set(text, (uses.get(text) ?? 0) + 1);
      });
    }
    return uses;
  }, [sourceDocument]);
  return { queryUses, sourceDocument };
}

// Rename a query everywhere the source stylesheet spells it.
function useRenameQuery(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  refreshDerivedHook: ReturnType<typeof useRefreshDerived>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  sourceDocumentHook: ReturnType<typeof useSourceDocument>,
) {
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { setContext } = selectionState;
  const { settleEmbedWrite } = pendingWrites;
  const { refreshDerived } = refreshDerivedHook;
  const { setTypedContexts } = selectorPick;
  const { sourceDocument } = sourceDocumentHook;

  // Rename a query everywhere the source stylesheet spells it. A breakpoint lives
  // in a file as several identical `@media` lines — changing one of them by hand
  // splits the breakpoint in two — so this rewrites all of them in one write, and
  // the panel follows the query it was showing to its new name.
  const onRenameQuery = (from: string, to: string) => {
    const embedDocument = sourceDocument;
    if (!embedDocument) {
      return;
    }
    const next = asQuery(to);
    if (!splitQuery(next)) {
      setStatus('A query starts with @ — @media, @container or @supports.');
      return;
    }
    if (next === from) {
      return;
    }
    void (async () => {
      setBusyBoth(true);
      setStatus('Renaming query…');
      // try/finally so a throw mid-rename can't leave every button disabled.
      try {
        let count = 0;
        for (const region of embedDocument.regions) {
          count += renameAtRuleQuery(region, from, next);
        }
        if (!count) {
          setStatus('That query isn’t in this file any more.');
          return;
        }
        await refreshDerived();
        const result = await writeEmbedDocument(embedDocument);
        if (!settleEmbedWrite(embedDocument, result, 'query')) {
          return;
        }
        // The context key is the at-rule chain; only the renamed link changes, so
        // a nested context stays selected too.
        const swap = (key: ContextKey) =>
          key
            .split(' › ')
            .map((part) => (part === from ? next : part))
            .join(' › ');
        setTypedContexts((previous) => previous.map(swap));
        setContext((previous) => swap(previous));
        setStatus(count === 1 ? `Renamed to ${next}.` : `Renamed ${count} blocks to ${next}.`);
      } finally {
        setBusyBoth(false);
      }
    })();
  };
  return { onRenameQuery };
}

// Every embed query the element could switch to.
function useContextKeys(
  pendingWrites: ReturnType<typeof usePendingWrites>,
  elementTokens: ReturnType<typeof useElementTokens>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  sourceDocumentHook: ReturnType<typeof useSourceDocument>,
) {
  const { documentByKey } = pendingWrites;
  const { model } = elementTokens;
  const { typedContexts } = selectorPick;
  const { sourceDocument } = sourceDocumentHook;

  // Every embed query the picked element could switch to: Base + each
  // @media/@container block in the embeds whose rules match this element.
  const allContextKeys = useMemo<ContextKey[]>(() => {
    const keys: ContextKey[] = [''];
    const seen = new Set<ContextKey>(['']);
    const take = (embedDocument: EmbedDocument) => {
      for (const region of embedDocument.regions) {
        for (const block of listAtRuleBlocks(region)) {
          const contextLabel = block.atContext.join(' › ');
          if (!seen.has(contextLabel)) {
            seen.add(contextLabel);
            keys.push(contextLabel);
          }
        }
      }
    };
    if (model) {
      const matchedDocumentKeys = new Set(
        [...model.base, ...model.conditional].map((matched) => matched.rule.embedKey),
      );
      for (const [key, embedDocument] of documentByKey) {
        if (!matchedDocumentKeys.has(key)) {
          continue;
        }
        take(embedDocument);
      }
    }
    // Every query the file being written into already uses, whether or not this
    // element has a rule in one. That dropdown is where a query is chosen to
    // write into, and a stylesheet's own queries are the ones worth offering: a
    // component with a `prefers-reduced-motion` block should offer it on every
    // element in that component, not only on the ones already inside it.
    if (sourceDocument) {
      take(sourceDocument);
    }
    // Queries typed into the add-selector field (may not exist in any embed yet).
    for (const typedContext of typedContexts) {
      if (!seen.has(typedContext)) {
        seen.add(typedContext);
        keys.push(typedContext);
      }
    }
    return keys;
  }, [model, documentByKey, typedContexts, sourceDocument]);
  return { allContextKeys };
}

// Suggestions for the add-query form.
function useQuerySuggestions(pendingWrites: ReturnType<typeof usePendingWrites>) {
  const { documentByKey } = pendingWrites;

  // Suggestions for the "Add query" form: every @media/@container/@supports already
  // used ANYWHERE in the project's embeds (labeled "used"), then a curated set of
  // common queries — deduped (normalized), project ones first.
  const querySuggestions = useMemo<QuerySuggestion[]>(() => {
    const seen = new Set<string>();
    const out: QuerySuggestion[] = [];
    const add = (query: string, kind: string) => {
      const norm = query.trim();
      const key = norm.replace(/\s+/g, ' ').toLowerCase();
      if (!norm || seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push({ query: norm, kind });
    };
    for (const embedDocument of documentByKey.values()) {
      for (const region of embedDocument.regions) {
        // Each LINK of a nesting chain, not the chain — `@media A › @supports B`
        // is how the panel names a context, but only `@media A` and `@supports B`
        // are queries somebody can write into a file.
        for (const block of listAtRuleBlocks(region)) {
          for (const part of block.atContext) {
            add(part, 'used');
          }
        }
      }
    }
    for (const common of COMMON_QUERIES) {
      add(common.query, common.kind);
    }
    // Size first. Breakpoints are what this list is reached for nearly every time
    // — a layout has several and they get edited together — while hover, pointer
    // and the prefers-* queries are set once and left. Sorting is stable, so
    // within each group the file's own queries still come before the suggested
    // ones, in the order the file has them.
    const bySize = (query: string) =>
      /@container\b/.test(query) || /\b(width|height)\b/.test(query) ? 0 : 1;
    return out.sort((left, right) => bySize(left.query) - bySize(right.query));
  }, [documentByKey]);
  return { querySuggestions };
}

// The queries the source file holds and the ones styling the element.
function useEmbedContexts(
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  sourceDocumentHook: ReturnType<typeof useSourceDocument>,
  contextKeys: ReturnType<typeof useContextKeys>,
) {
  const { context } = selectionState;
  const { model } = elementTokens;
  const { sourceDocument } = sourceDocumentHook;
  const { allContextKeys } = contextKeys;

  // Embed queries where THIS element actually has styles — so custom @media /
  // @container (and up-breakpoints) only appear in the dropdown when used. The
  // current context is kept so viewing an empty query doesn't hide itself.
  // The at-contexts the file being written into holds — the component's own
  // queries, as opposed to ones reaching this element from a page stylesheet.
  const sourceContexts = useMemo(() => {
    const set = new Set<string>();
    if (sourceDocument) {
      for (const region of sourceDocument.regions) {
        for (const block of listAtRuleBlocks(region)) {
          set.add(block.atContext.join(' › '));
        }
      }
    }
    return set;
  }, [sourceDocument]);
  const styledEmbedContexts = useMemo(() => {
    const set = new Set<string>();
    if (model) {
      for (const info of indexContexts(model, allContextKeys)) {
        if (info.hasStyles) {
          set.add(info.key);
        }
      }
    }
    if (context) {
      set.add(context);
    }
    // …plus the queries the file being written into already uses. Those are
    // offered for any element in it: the dropdown is how you get INTO a query
    // to write the first rule there, so hiding a query until something is
    // already in it is a door that only opens from the far side.
    for (const key of sourceContexts) {
      set.add(key);
    }
    return set;
  }, [model, allContextKeys, context, sourceContexts]);
  return { sourceContexts, styledEmbedContexts };
}

// The unified context list and the current context.
function useStyleContexts(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  contextKeys: ReturnType<typeof useContextKeys>,
  embedContexts: ReturnType<typeof useEmbedContexts>,
) {
  const { context, stickyContextRef } = selectionState;
  const { currentBreakpoint, nativeModel } = nativeState;
  const { allContextKeys } = contextKeys;
  const { sourceContexts, styledEmbedContexts } = embedContexts;

  // The unified context list: Base + the default Webflow breakpoints (always) +
  // breakpoints/queries the element uses. Drives the dropdown and which breakpoint
  // native reads/writes target.
  const styleContexts = useMemo<StyleContext[]>(() => {
    const list = buildStyleContexts(
      allContextKeys,
      nativeModel,
      currentBreakpoint,
      styledEmbedContexts,
      sourceContexts,
    );
    // Keep the manually-selected query available on any element — even one with no
    // styles there yet — so switching elements stays on it and you can add a style.
    // Only needed for custom @media/@container (breakpoints are always built).
    const sticky = stickyContextRef.current;
    if (
      context &&
      sticky &&
      sticky.key === context &&
      !list.some((entry) => entry.key === context)
    ) {
      list.push(sticky);
    }
    return list;
  }, [
    allContextKeys,
    nativeModel,
    currentBreakpoint,
    styledEmbedContexts,
    sourceContexts,
    context,
    stickyContextRef,
  ]);
  const currentContext = useMemo<StyleContext>(
    () =>
      styleContexts.find((entry) => entry.key === context) ??
      styleContexts[0] ?? { key: '', label: 'Base', breakpoint: 'main', embedAtContext: '' },
    [styleContexts, context],
  );
  // Remember the selected context object so it survives an element switch (the list
  // rebuilds per element; a custom query the new element lacks gets re-injected above).
  useEffect(() => {
    if (currentContext.key === context) {
      stickyContextRef.current = currentContext;
    }
  }, [currentContext, context, stickyContextRef]);
  return { currentContext, styleContexts };
}

// Which native class style the pick maps to, and the embeds that could style it.
function useNativeTarget(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
) {
  const { selectedTokens } = selectionState;
  const { nativeModel, sourceSelection } = nativeState;
  const { documentByKey } = pendingWrites;

  // Which native class style the picked class tokens map to (if any), whether the
  // Native layer is available, and the layer actually in effect (Native falls back
  // to Embed for the tag / attributes / complex selectors that have no class Style).
  const nativeIndex = useMemo(
    () => selectedNativeIndexFor(nativeModel, selectedTokens),
    [nativeModel, selectedTokens],
  );
  const nativeAvailable = nativeIndex !== undefined;
  // A single class with no class Style yet (e.g. one that exists only as a combo,
  // like `is-2`) can still be edited natively — we create its base class on the
  // first edit. `creatableClass` is that class's display name.
  const creatableClass = useMemo<string | undefined>(() => {
    if (nativeIndex !== undefined || selectedTokens.length !== 1) {
      return undefined;
    }
    const token = selectedTokens[0] ?? '';
    return token.startsWith('class:') ? token.slice('class:'.length) : undefined;
  }, [nativeIndex, selectedTokens]);
  // …but only when a native styling system exists. Without one (a plain CSS
  // project) every property is authored into the stylesheet instead, or the
  // first edit on an unstyled class would route to a native write that cannot
  // happen and fail silently.
  const canNative = nativeStylingAvailable() && (nativeAvailable || creatableClass !== undefined);

  // Every embed that could style this element, in page/cascade order — later embeds
  // win (their CSS is injected after Webflow's stylesheet and after earlier embeds).
  const embedList = useMemo(
    () => [...documentByKey.values()].sort((left, right) => left.source.order - right.source.order),
    [documentByKey],
  );

  // The dropdown picks the fallback embed only — Webflow is never a choice. Styles
  // always try to apply natively first; whatever the class can't take natively
  // lands in the selected embed. The user's pick (sourceSel) overrides the default
  // (first embed in page order) and persists across element switches.
  const sourceKeys = useMemo(
    () => embedList.map((embedDocument) => embedDocument.source.key),
    [embedList],
  );
  // The source dropdown only picks where NEW styles are created — it does not scope
  // which existing rule is editable. So it just tracks the user's pick, defaulting to
  // the first embed in page order.
  const effectiveSourceSelection =
    sourceSelection && sourceKeys.includes(sourceSelection)
      ? sourceSelection
      : (sourceKeys[0] ?? '');
  return { canNative, creatableClass, effectiveSourceSelection, embedList, nativeIndex };
}

// Point the style source at an open component's own embed.
function useComponentSource(
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
) {
  const { scan } = scanState;
  const {
    pageSourceRef,
    previousInComponentRef,
    setSourceSelection,
    sourceSelectionRef,
    wantCompSourceRef,
  } = nativeState;
  const { embedList } = nativeTarget;

  // Open a component → point the source at that component's own embed; close it →
  // restore the page pick. The switch is in-memory only (persistence stays the page
  // pick). Component embeds stream in after the page tree, so a pending switch waits
  // for the component embed to appear rather than firing once on the transition.
  const inComponentContext = scan?.inComponentContext ?? false;
  useEffect(() => {
    const componentSourceKey = embedList.find((embedDocument) => embedDocument.source.fromComponent)
      ?.source.key;
    if (inComponentContext !== previousInComponentRef.current) {
      previousInComponentRef.current = inComponentContext;
      if (inComponentContext) {
        // Stash the page pick to restore on exit.
        pageSourceRef.current = sourceSelectionRef.current;
        wantCompSourceRef.current = true;
      } else {
        wantCompSourceRef.current = false;
        setSourceSelection(pageSourceRef.current);
      }
    }
    // Fulfill a pending switch once the open component's embed has loaded.
    if (inComponentContext && wantCompSourceRef.current && componentSourceKey) {
      wantCompSourceRef.current = false;
      setSourceSelection(componentSourceKey);
    }
  }, [
    inComponentContext,
    embedList,
    pageSourceRef,
    previousInComponentRef,
    setSourceSelection,
    sourceSelectionRef,
    wantCompSourceRef,
  ]);
  return { inComponentContext };
}

// The layer edits go to, and the resolved style for the pick.
function useResolved(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  tokenDefault: ReturnType<typeof useTokenDefault>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  componentSource: ReturnType<typeof useComponentSource>,
) {
  const { stateKey } = selectionState;
  const { nativeModel, setSourceSelection } = nativeState;
  const { model } = elementTokens;
  const { elementIdentity } = tokenDefault;
  const { activeSelector } = activeSelectorHook;
  const { currentContext } = styleContextsHook;
  const { canNative, effectiveSourceSelection, nativeIndex } = nativeTarget;
  const { inComponentContext } = componentSource;

  // Webflow's native style system only supports its own breakpoints (Base/Tablet/…)
  // and interaction states — NOT a custom `@media`/`@container` the user added (those
  // have no `breakpoint`). Editing in a custom query must go to the embed, or the
  // native write silently lands on Base instead of the query.
  const nativeContextOk = currentContext.breakpoint !== undefined;
  // Native is the primary layer whenever the selection can carry a class Style AND the
  // context is native-capable; otherwise (tag / attribute / complex selector, or a
  // custom query) the embed is the only target.
  const effectiveSource: SourceKey = canNative && nativeContextOk ? 'native' : 'embed';
  // The chosen embed: always the fallback target, and the editable layer for props
  // the native class doesn't set.
  const selectedEmbedKey = effectiveSourceSelection || undefined;
  const selectedNativeIndex = canNative && nativeContextOk ? nativeIndex : undefined;

  // Native contributions for the current context + state, folded into the model.
  const nativeContribs = useMemo(
    () => nativeContribsFor(nativeModel, currentContext, stateKey),
    [nativeModel, currentContext, stateKey],
  );

  const resolved = useMemo(
    () =>
      resolveStyle(
        model ?? EMPTY_RULE_MODEL,
        currentContext.embedAtContext ?? ' native-only',
        activeSelector,
        {
          source: effectiveSource,
          contribs: nativeContribs,
          selectedIndex: selectedNativeIndex,
          selectedEmbedKey,
          ...(currentContext.breakpoint
            ? { currentTier: breakpointTier(currentContext.breakpoint) }
            : {}),
        },
      ),
    [
      model,
      currentContext,
      activeSelector,
      effectiveSource,
      nativeContribs,
      selectedNativeIndex,
      selectedEmbedKey,
    ],
  );

  // The stylesheet the active selector's rule already lives in. resolveStyle
  // picks selectedRule by selector identity and explicitly does NOT scope it to
  // the source dropdown, so reading it here can't feed back into itself.
  const homeEmbedKey = resolved.selectedRule?.embedKey;

  // Selecting an element points "Add custom styles in" at the file that already
  // defines its selector, so a new declaration joins the rule that's there
  // instead of landing in whichever stylesheet happens to be first in page
  // order. An explicit pick still wins: the effect only re-runs when the element
  // or the selector's home changes, not on every render. Left alone inside a
  // component, where the source is pinned to that component's own embed.
  useEffect(() => {
    if (!homeEmbedKey || inComponentContext) {
      return;
    }
    setSourceSelection((previous) => (previous === homeEmbedKey ? previous : homeEmbedKey));
  }, [elementIdentity, activeSelector, homeEmbedKey, inComponentContext, setSourceSelection]);
  return { effectiveSource, nativeContextOk, resolved, selectedEmbedKey, selectedNativeIndex };
}

// The chip picker's selectors and the context dropdown's info.
function useSelectorChips(
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
) {
  const { removedClasses } = scanState;
  const { selectedSelectorText } = selectionState;
  const { nativeModel } = nativeState;
  const { model, snapshot, tokens } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { currentContext, styleContexts } = styleContextsHook;

  // Every selector (with styles) that targets this element in the current context —
  // the element's own classes, stateful, and complex/ancestor selectors — for the
  // chip picker. Include the active selector even when it has no rule yet (a fresh
  // pick/typed one) so it shows as selected while you add its first property.
  const selectorChips = useMemo<MatchedSelector[]>(
    () =>
      chipsFor({
        model,
        nativeModel,
        currentContext,
        activeSelector,
        selectedSelectorText,
        tokens,
        classList: snapshot?.classList ?? [],
        removedClasses,
      }),
    [
      model,
      nativeModel,
      currentContext,
      activeSelector,
      selectedSelectorText,
      tokens,
      snapshot,
      removedClasses,
    ],
  );

  // Per-context dropdown info: embed hasStyles/combos (for the dot + auto-highlight)
  // plus whether the breakpoint carries native values.
  const contextInfos = useMemo<ContextInfo[]>(() => {
    const projectedModel = model ?? EMPTY_RULE_MODEL;
    const embedKeys = [
      ...new Set(
        styleContexts
          .map((styleContext) => styleContext.embedAtContext)
          .filter((atContext): atContext is string => atContext !== undefined),
      ),
    ];
    const embedByKey = new Map(
      indexContexts(projectedModel, embedKeys).map((info) => [info.key, info]),
    );
    return styleContexts.map((sc) => {
      const embed = sc.embedAtContext !== undefined ? embedByKey.get(sc.embedAtContext) : undefined;
      const nativeHas = sc.breakpoint ? nativeHasValues(nativeModel, sc.breakpoint) : false;
      return {
        key: sc.key,
        hasStyles: (embed?.hasStyles ?? false) || nativeHas,
        styledCombos: embed?.styledCombos ?? [],
        bestTokens: embed?.bestTokens,
      };
    });
  }, [model, styleContexts, nativeModel]);
  return { contextInfos, selectorChips };
}

// Switch context, keeping or re-picking a selector styled there.
function useContextChange(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
) {
  const { pendingDefaultRef, setContext } = selectionState;
  const { nativeModel } = nativeState;
  const { model } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { selectActiveSelector } = selectorPick;
  const { styleContexts } = styleContextsHook;

  // Switching context auto-selects a selector that has styles in the new query:
  // keep the current pick if it's styled there, otherwise jump to the strongest.
  const onContextChange = useCallback(
    (next: ContextKey) => {
      pendingDefaultRef.current = false;
      setContext(next);
      const nextContext = styleContexts.find((entry) => entry.key === next);
      if (!nextContext || !model) {
        return;
      }
      // Only selectors with styles IN this context (drop the dimmed other-context ones).
      // Never jump to a global selector (`:focus-visible`, `*`): editing one edits
      // most of the site, and it isn't about this element.
      const styled = styledSelectorsFor(model, nativeModel, nextContext).filter(
        (entry) => entry.inContext !== false && !isGlobalSelector(entry.text),
      );
      if (!styled.length) {
        return;
      }
      if (activeSelector && styled.some((entry) => selectorsMatch(entry.text, activeSelector))) {
        return;
      }
      const strongest = styled[styled.length - 1];
      if (strongest !== undefined) {
        selectActiveSelector(strongest.text);
      }
    },
    [
      styleContexts,
      model,
      nativeModel,
      activeSelector,
      selectActiveSelector,
      pendingDefaultRef,
      setContext,
    ],
  );
  return { onContextChange };
}

// Upgrade a new element's default selector to one styled in the context.
function useDefaultUpgrade(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  tokenDefault: ReturnType<typeof useTokenDefault>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
) {
  const { context, defaultTokensRef, pendingDefaultRef } = selectionState;
  const { nativeIdentityRef, nativeModel } = nativeState;
  const { model, snapshot, tokens } = elementTokens;
  const { elementIdentity } = tokenDefault;
  const { selectActiveSelector } = selectorPick;
  const { styleContexts } = styleContextsHook;

  // On selecting a new element, upgrade the raw all-classes default to the strongest
  // selector actually STYLED in the current context — so if `.media_card_title` is
  // styled in `@container (…)` but the full combo isn't, we land on `.media_card_title`.
  // Runs once the model is ready for the new element; skips if you already picked.
  useEffect(() => {
    if (!pendingDefaultRef.current || !model) {
      return;
    }
    // Wait until nativeModel is the CURRENT element's — it loads via a separate async
    // effect and lags the embed model on a switch. Defaulting off a stale nativeModel
    // would pick the previous element's native selectors (and clobber pendingDefaultRef),
    // leaving that selector stuck as a pending chip. Re-runs when nativeModel catches up.
    if (nativeIdentityRef.current !== elementIdentity) {
      return;
    }
    const activeContext = styleContexts.find((entry) => entry.key === context);
    if (!activeContext) {
      return;
    }
    const styled = styledSelectorsFor(model, nativeModel, activeContext).filter(
      (entry) => entry.inContext !== false,
    );
    // Nothing styled yet — likely mid-scan (embeds still streaming). Leave the default
    // armed so we retry as they arrive, instead of committing to the unstyled combo.
    if (!styled.length) {
      return;
    }
    pendingDefaultRef.current = false;
    // A global selector must never become the default. It matches nearly every
    // element, so picking one would both force its (hidden) chip back on screen
    // and point the style fields at a rule that isn't about this element —
    // editing `:focus-visible` here would restyle the whole site. With only
    // globals styling this element, the composed token selector stays the pick.
    const local = styled.filter((entry) => !isGlobalSelector(entry.text));
    if (!local.length) {
      return;
    }
    // Use the FRESH default the effect just set (not `activeSelector`, which is still
    // the previous element's here).
    const initial = upgradedDefault(local, {
      tokens,
      classList: snapshot?.classList ?? [],
      defaultTokens: defaultTokensRef.current,
    });
    if (initial !== undefined) {
      selectActiveSelector(initial.text);
    }
  }, [
    model,
    nativeModel,
    context,
    styleContexts,
    tokens,
    elementIdentity,
    snapshot,
    selectActiveSelector,
    defaultTokensRef,
    nativeIdentityRef,
    pendingDefaultRef,
  ]);
}

// Re-read the native class styles after a native write.
function useNativeRefresh(
  editorRefs: ReturnType<typeof useEditorRefs>,
  nativeState: ReturnType<typeof useNativeState>,
) {
  const { selectedRef } = editorRefs;
  const { activeSelectorRef, nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;

  // Native (Webflow class style) writes.
  const refreshNative = useCallback(async () => {
    const selectedElement = selectedRef.current;
    if (!selectedElement) {
      const className = standaloneNativeClass(activeSelectorRef.current);
      if (!className) {
        return;
      }
      const next = await readNativeStyleByName(className, STATES);
      nativeModelRef.current = next;
      nativeIdentityRef.current = `standalone:${className}`;
      setNativeModel(next);
      return;
    }
    nativeModelCache.clear(); // a class edit can change any element that uses it
    const identity = await resolveIdentityElement(selectedElement);
    const model = await readNativeStyles(identity, STATES);
    nativeModelRef.current = model;
    setNativeModel(model);
  }, [activeSelectorRef, nativeIdentityRef, nativeModelRef, selectedRef, setNativeModel]);
  return { refreshNative };
}

// Re-read the selection when the panel regains focus.
function useFocusResync(
  editorRefs: ReturnType<typeof useEditorRefs>,
  refreshHook: ReturnType<typeof useRefresh>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
) {
  const { busyRef } = editorRefs;
  const { refresh } = refreshHook;
  const { refreshNative } = nativeRefresh;

  // Sync back edits made in the Designer itself — adding/removing a class, changing
  // a value in Webflow's native style panel, or editing another embed. Webflow fires
  // no event for these, so re-read the current selection whenever the panel regains
  // focus (the user returns to it after acting on the canvas / native panel). refresh
  // re-reads the element's classes + embeds (class changes flow through to the native
  // read via elementIdentity); refreshNative catches native value edits that leave the
  // class set unchanged.
  useEffect(() => {
    const api = webflowApi();
    if (!api?.getSelectedElement) {
      return;
    }
    let timer: number | undefined = undefined;
    const resync = () => {
      // Don't fight an in-progress write or an active edit inside the panel.
      if (busyRef.current) {
        return;
      }
      const active =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      if (
        active &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
      ) {
        return;
      }
      if (timer !== undefined) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        void api.getSelectedElement?.().then((element) => {
          if (!element || busyRef.current) {
            return;
          }
          void refresh(element);
          void refreshNative();
        });
      }, 150);
    };
    const onVisible = () => {
      if (!document.hidden) {
        resync();
      }
    };
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      window.removeEventListener('focus', resync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, refreshNative, busyRef]);
}

// Serialized native writes: clear and live-set a class style's properties.
function useNativeOps(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
) {
  const { selectedRef } = editorRefs;
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { nativeModelRef } = nativeState;
  const { refreshNative } = nativeRefresh;

  // Serialize native writes. Each write does read-handle → setProperties → commit →
  // refresh; `busy` clears before the refresh finishes, so a rapid second edit (e.g.
  // overflow-x then overflow-y) could overlap the first and clobber it via racing
  // setStyles commits. Chaining every op guarantees strict ordering.
  const nativeOpChain = useRef<Promise<unknown>>(Promise.resolve());
  const runNativeOp = useCallback(<T,>(op: () => Promise<T>): Promise<T> => {
    const next = nativeOpChain.current.then(op, op);
    nativeOpChain.current = next.catch(() => {});
    return next;
  }, []);
  // Build the write target for the native style at `index`: applied combos write
  // by their getStyles position; standalone (attribute-only) classes have no such
  // position, so they resolve by name via getStyleByName.
  const nativeWriteTargetAt = useCallback(
    (index: number): NativeWriteTarget => {
      const style = nativeModelRef.current?.styles[index];
      return { namePath: style?.namePath ?? [], index: style && style.applied ? index : undefined };
    },
    [nativeModelRef],
  );
  const nativeClearAt = useCallback(
    (index: number, props: string[], options?: NativeStyleOptions) =>
      runNativeOp(async () => {
        let ok = true;
        try {
          setBusyBoth(true);
          setStatus('Saving…');
          const result = await removeNativePropertyAt(
            selectedRef.current,
            nativeWriteTargetAt(index),
            props,
            options,
          );
          ok = result.ok;
        } finally {
          setBusyBoth(false);
        }
        await refreshNative();
        setStatus(
          ok
            ? 'Removed from the Webflow class style.'
            : 'Couldn’t remove from the Webflow class style.',
        );
      }),
    [refreshNative, setBusyBoth, nativeWriteTargetAt, runNativeOp, selectedRef, setStatus],
  );
  // Live scrub: Webflow updates the canvas itself; skip the model refresh (blur commits).
  const nativeLiveSet = useCallback(
    (handle: unknown, prop: string, value: string, options?: NativeStyleOptions) => {
      // Serialize live writes through the native op chain (like commits do). Firing
      // several setProperty calls on one style in a single tick — the four linked
      // border-radius corners, or linked gap's row/column longhands — races inside
      // Webflow's API and only the last sticks; chaining applies each in order.
      void runNativeOp(async () => {
        await liveSetNativeProperty(handle, prop, value, options);
      });
    },
    [runNativeOp],
  );
  return { nativeClearAt, nativeLiveSet, nativeWriteTargetAt, runNativeOp };
}

// Create the picked selector's rule in an embed.
function useWriteNewRule(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  refreshDerivedHook: ReturnType<typeof useRefreshDerived>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  resolvedHook: ReturnType<typeof useResolved>,
) {
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { settleEmbedWrite } = pendingWrites;
  const { refreshDerived } = refreshDerivedHook;
  const { typedPathRef } = selectorPick;
  const { resolved } = resolvedHook;

  // Writes target the picked selector's rule in the current context/state, and
  // create that rule on the first edit when it doesn't exist yet.
  const selectedRule = resolved?.selectedRule ?? undefined;
  // Create the picked selector's rule in the target embed, write the embed, and
  // refresh the panel's model.
  const writeNewRule = async (
    where: {
      embedDocument: EmbedDocument;
      region: EmbedRegion;
      embedContext: string | undefined;
      bpMedia: string | undefined;
      selector: string;
    },
    write: PropWrite,
  ) => {
    const { embedDocument, region, embedContext, bpMedia } = where;
    const fullSelector = where.selector;
    setBusyBoth(true);
    setStatus('Saving…');
    // try/finally so `busy` always clears even if creating the rule / writing throws
    // (a stuck busy would disable every button in the panel).
    try {
      const typed = typedPathRef.current;
      const nested =
        typed && typed.selector === fullSelector && typed.ctx === (embedContext ?? '')
          ? typed.path
          : undefined;
      if (nested) {
        typedPathRef.current = undefined;
      }
      const ok = createRuleForWrite(region, {
        nested,
        bpMedia,
        embedContext,
        selector: fullSelector,
        write,
      });
      if (!ok) {
        setStatus('Nothing to save.');
        return;
      }
      const result = await writeEmbedDocument(embedDocument);
      await refreshDerived();
      if (!settleEmbedWrite(embedDocument, result, 'rule')) {
        return;
      }
      setStatus(`Added ${fullSelector}.`);
    } finally {
      setBusyBoth(false);
    }
  };
  return { selectedRule, writeNewRule };
}

// Create a rule for the pick in the current context.
function useCreateRule(
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  elementTokens: ReturnType<typeof useElementTokens>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  resolvedHook: ReturnType<typeof useResolved>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
) {
  const { setStatus } = scanState;
  const { documentByKey } = pendingWrites;
  const { model } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { currentContext } = styleContextsHook;
  const { selectedEmbedKey } = resolvedHook;
  const { writeNewRule } = writeNewRuleHook;

  const createSelectedRule = (write: PropWrite, selectorOverride?: string) => {
    // A Webflow-breakpoint context with no equivalent embed query yet writes into a
    // synthesized @media block; otherwise the embed's base or existing query block.
    const embedContext = currentContext.embedAtContext;
    const bpMedia =
      embedContext === undefined &&
      currentContext.breakpoint &&
      currentContext.breakpoint !== 'main'
        ? mediaParamsForBreakpoint(currentContext.breakpoint)
        : undefined;
    // Write into the chosen embed when one is selected; otherwise the embed of a
    // matching rule in this context (or the first embed).
    const where = embedWriteTarget(
      { model, selectedEmbedKey, documentByKey },
      (rule) => contextKeyOf(rule) === (embedContext ?? ''),
    );
    if (!where) {
      setStatus('No embed here to write to — add an HTML embed first.');
      return;
    }
    const fullSelector = selectorOverride ?? activeSelector;
    void writeNewRule({ ...where, embedContext, bpMedia, selector: fullSelector }, write);
  };
  return { createSelectedRule };
}

// Scaffold a just-typed query into the embed.
function useEmptyContext(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  refreshDerivedHook: ReturnType<typeof useRefreshDerived>,
  elementTokens: ReturnType<typeof useElementTokens>,
  resolvedHook: ReturnType<typeof useResolved>,
) {
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { documentByKey, settleEmbedWrite } = pendingWrites;
  const { refreshDerived } = refreshDerivedHook;
  const { model } = elementTokens;
  const { selectedEmbedKey } = resolvedHook;

  // Add a just-typed query to the embed IMMEDIATELY as an empty block, so it persists and
  // reads back as a real context without waiting for the first property. `ctxKey` (wrap)
  // scaffolds a top-level `@query {}`; `path` (nest) scaffolds `selector { @query {} }`.
  // Targets the same embed createSelectedRule would; if there's no embed to write into
  // yet, it no-ops and the query stays a pending local context until the first edit.
  const writeEmptyContext = ({
    path,
    contextKey,
  }: {
    readonly path?: NestStep[];
    readonly contextKey?: string;
  }) => {
    const where = embedWriteTarget({ model, selectedEmbedKey, documentByKey }, undefined);
    // No embed here yet — keep it as a pending local context.
    if (!where) {
      return;
    }
    const { embedDocument, region } = where;
    void (async () => {
      setBusyBoth(true);
      setStatus('Adding query…');
      // try/finally so a throw while scaffolding the query block can't leave `busy` stuck
      // true — that would wrongly disable every add button (transforms, shadows, …).
      try {
        const ok = path
          ? ensureNestPath(region, path)
          : contextKey
            ? ensureQueryBlock(region, contextKey)
            : false;
        if (!ok) {
          setStatus('Couldn’t add the query.');
          return;
        }
        await refreshDerived();
        const result = await writeEmbedDocument(embedDocument);
        if (!settleEmbedWrite(embedDocument, result, 'rule')) {
          return;
        }
        setStatus('Query added.');
      } finally {
        setBusyBoth(false);
      }
    })();
  };
  return { writeEmptyContext };
}

// Add a query, and route a property write to its layer.
function useAddQuery(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  propEdits: ReturnType<typeof usePropEdits>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  typedSelector: ReturnType<typeof useTypedSelector>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  resolvedHook: ReturnType<typeof useResolved>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
  createRule: ReturnType<typeof useCreateRule>,
  emptyContext: ReturnType<typeof useEmptyContext>,
) {
  const { setContext } = selectionState;
  const { nativeModel } = nativeState;
  const { onSetProp } = propEdits;
  const { activeSelector } = activeSelectorHook;
  const { setTypedContexts, typedPathRef } = selectorPick;
  const { addTypedSelector } = typedSelector;
  const { canNative } = nativeTarget;
  const { nativeContextOk, resolved, selectedNativeIndex } = resolvedHook;
  const { selectedRule } = writeNewRuleHook;
  const { createSelectedRule } = createRule;
  const { writeEmptyContext } = emptyContext;

  // Add a custom query (@media/@container/@supports) to the current selector from the
  // query dropdown's "Add query" form. `wrap` registers the query as a context and
  // switches to it — the first edit creates a new `@query { selector { … } }` block;
  // `nest` reuses the typed nesting path so the edit writes `selector { @query { … } }`
  // inside the selector's own rule. A bare `(…)` / condition defaults to `@media`.
  const onAddQuery = (raw: string, mode: 'wrap' | 'nest') => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    const query = asQuery(trimmed);
    if (mode === 'nest' && activeSelector) {
      const nestedInput = `${activeSelector} { ${query} }`;
      addTypedSelector(nestedInput);
      // Scaffold the empty nested query block (`selector { @query {} }`) into the embed
      // now, so the query persists without waiting for the first property.
      const parsed = parseNestedInput(nestedInput);
      if (parsed && parsed.path.length) {
        writeEmptyContext({ path: parsed.path });
      }
      return;
    }
    typedPathRef.current = undefined;
    setTypedContexts((previous) => (previous.includes(query) ? previous : [...previous, query]));
    setContext(query);
    // Scaffold the empty top-level query block (`@query {}`) into the embed now.
    writeEmptyContext({ contextKey: query });
  };
  // Write a property to the embed for the picked selector — its existing rule, or a
  // new one. Also the fallback target when a native value won't apply.
  const writeEmbedProp = (write: PropWrite) => {
    if (selectedRule) {
      onSetProp(selectedRule, write.prop, write.value, write.important);
    } else {
      createSelectedRule(write);
    }
  };

  // Native edits go to the picked class style. Webflow accepts nearly any
  // property/value (storing unsupported ones as custom properties), so "regular"
  // and "custom property" are one call; we verify it actually applied and, if not,
  // move the property to custom code (an embed) — the try-native-else-custom-code chain.
  const nativeHandle = () =>
    nativeModel && selectedNativeIndex !== undefined
      ? nativeModel.styles[selectedNativeIndex]?.style
      : undefined;
  // Where a property's edit goes: the layer that currently holds its editable
  // value (native when the class sets it, the picked embed when it fell back);
  // a brand-new property defaults to native-first when the selection allows it.
  const propLayer = (prop: string): SourceKey => {
    // Transitions have no native Designer API — always write them to the embed.
    if (EMBED_ONLY_PROPS.has(prop)) {
      return 'embed';
    }
    // A custom query can't be written natively — always target the embed there.
    if (!nativeContextOk) {
      return 'embed';
    }
    const resolvedProp = resolved?.props.get(prop);
    if (resolvedProp?.source === 'selected' && resolvedProp.selectedOrigin) {
      return resolvedProp.selectedOrigin;
    }
    return canNative ? 'native' : 'embed';
  };
  return { nativeHandle, onAddQuery, propLayer, writeEmbedProp };
}

// Native write attempts, and clearing a coerced value after a failed one.
function useNativeAttempt(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeOps: ReturnType<typeof useNativeOps>,
) {
  const { selectedRef } = editorRefs;
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { stateKey } = selectionState;
  const { currentContext } = styleContextsHook;
  const { nativeWriteTargetAt } = nativeOps;

  // Webflow's native API rejects hsl()/hsla(), so a value on its way THERE is
  // normalized to rgb. Only there: this used to run on every write, which meant
  // CSS written to a file or an embed — everything, in this app, where native
  // styling is not available at all — could never come out as `hsl(…)`. Picking
  // HSL in the colour picker changed the numbers on screen and left `rgb(224, 4,
  // 4)` in the file, because the notation was converted back out on the way
  // past.
  // Run one native write attempt with the panel busy. The busy flag disables every
  // control — it must always clear, even if the Designer call hangs or throws, or the
  // panel freezes. A throw is a failed attempt, with its message as the reason.
  const attemptNative = async (
    status: string,
    attempt: () => Promise<NativeAttempt>,
  ): Promise<NativeAttempt> => {
    try {
      setBusyBoth(true);
      setStatus(status);
      return await attempt();
    } catch (error: unknown) {
      return { applied: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      setBusyBoth(false);
    }
  };
  // The failed native write may have left a COERCED value on the class — Webflow stores
  // an unparseable calc()/function as `0` rather than nothing — which would shadow the
  // embed value about to be written (e.g. width stuck at 0px). Clear it first so only
  // the embed declaration applies. Best-effort: a no-op when Webflow stored nothing
  // (the common drop case).
  const clearCoercedNative = async (index: number, prop: string) => {
    try {
      setBusyBoth(true);
      await removeNativePropertyAt(
        selectedRef.current,
        nativeWriteTargetAt(index),
        [prop],
        optionsFor(currentContext, stateKey),
      );
    } catch {
      /* best-effort cleanup */
    } finally {
      setBusyBoth(false);
    }
  };
  return { attemptNative, clearCoercedNative };
}

// Set a property natively, falling back to an embed.
function useNativeSet(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
  nativeOps: ReturnType<typeof useNativeOps>,
  addQuery: ReturnType<typeof useAddQuery>,
  nativeAttempt: ReturnType<typeof useNativeAttempt>,
) {
  const { selectedRef } = editorRefs;
  const { setNativeFallback, setStatus } = scanState;
  const { stateKey } = selectionState;
  const { currentContext } = styleContextsHook;
  const { refreshNative } = nativeRefresh;
  const { nativeWriteTargetAt, runNativeOp } = nativeOps;
  const { writeEmbedProp } = addQuery;
  const { attemptNative, clearCoercedNative } = nativeAttempt;

  const nativeSetOrFallback = (index: number, write: PropWrite) => {
    const { prop } = write;
    const value = hslaToRgba(write.value);
    void runNativeOp(async () => {
      setNativeFallback(undefined); // clear any prior fallback notice as this edit begins
      const { applied, reason } = await attemptNative('Saving…', async () => {
        const result = await applyNativePropertyAt(
          selectedRef.current,
          nativeWriteTargetAt(index),
          prop,
          value,
          optionsFor(currentContext, stateKey),
        );
        return { applied: result.applied, reason: result.error ?? '' };
      });
      if (applied) {
        await refreshNative();
        setStatus('Saved to Webflow class style.');
        return;
      }
      await clearCoercedNative(index, prop);
      setStatus(
        `Couldn’t set ${prop} as a Webflow style${reason ? ` (${reason})` : ''}` +
          ' — moving it to an embed.',
      );
      // The status line isn't rendered, so surface the reason inline — otherwise the
      // fall-through to an embed is invisible and looks like "it always writes code".
      setNativeFallback(
        `Webflow wouldn’t apply ${prop} to this class natively${reason ? ` (${reason})` : ''}` +
          ' — saved it to the embed instead.',
      );
      writeEmbedProp({ ...write, value });
    });
  };
  return { nativeSetOrFallback };
}

// Create a class natively, recovering when it already exists.
function useCreateNativeClass(
  editorRefs: ReturnType<typeof useEditorRefs>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
  nativeOps: ReturnType<typeof useNativeOps>,
) {
  const { selectedRef } = editorRefs;
  const { stateKey } = selectionState;
  const { nativeModelRef } = nativeState;
  const { currentContext } = styleContextsHook;
  const { refreshNative } = nativeRefresh;
  const { nativeWriteTargetAt } = nativeOps;

  const createNativeClass = async (className: string, write: PropWrite): Promise<NativeAttempt> => {
    const options = optionsFor(currentContext, stateKey);
    const result = await applyNativeToNewBaseClass(
      selectedRef.current,
      className,
      write.prop,
      write.value,
      options,
    );
    const reason = result.error ?? '';
    // The class already exists — almost always because the edit landed before the
    // native scan finished, so we didn't yet know `.className` was a real Webflow
    // class (nativeIndex was undefined → it looked creatable). Recover by re-reading and
    // writing to the existing base class instead of wrongly spilling into an embed.
    if (result.applied || !/duplicate/i.test(reason)) {
      return { applied: result.applied, created: result.applied, reason };
    }
    await refreshNative();
    const baseIndex =
      nativeModelRef.current?.styles.findIndex(
        (entry) => !entry.isCombo && entry.namePath.length === 1 && entry.className === className,
      ) ?? -1;
    if (baseIndex < 0) {
      return { applied: false, created: false, reason };
    }
    const retry = await applyNativePropertyAt(
      selectedRef.current,
      nativeWriteTargetAt(baseIndex),
      write.prop,
      write.value,
      options,
    );
    return { applied: retry.applied, created: false, reason: retry.error ?? '' };
  };
  return { createNativeClass };
}

// Create a class natively for its first property, falling back to an embed.
function useNativeCreate(
  scanState: ReturnType<typeof useScanState>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
  nativeOps: ReturnType<typeof useNativeOps>,
  addQuery: ReturnType<typeof useAddQuery>,
  nativeAttempt: ReturnType<typeof useNativeAttempt>,
  createNativeClassHook: ReturnType<typeof useCreateNativeClass>,
) {
  const { setNativeFallback, setStatus } = scanState;
  const { refreshNative } = nativeRefresh;
  const { runNativeOp } = nativeOps;
  const { writeEmbedProp } = addQuery;
  const { attemptNative } = nativeAttempt;
  const { createNativeClass } = createNativeClassHook;

  // First edit on a class that has no base Style yet: create the base class in
  // Webflow, write the property, then refresh (subsequent edits use the normal
  // native path once the style resolves). Falls back to an embed if creation fails.
  const nativeCreateAndSet = (className: string, write: PropWrite) => {
    const value = hslaToRgba(write.value); // see nativeSetOrFallback
    void runNativeOp(async () => {
      setNativeFallback(undefined);
      const { applied, created, reason } = await attemptNative(
        'Creating Webflow class…',
        async () => createNativeClass(className, { ...write, value }),
      );
      if (applied) {
        await refreshNative();
        setStatus(
          created ? `Created Webflow class .${className}.` : 'Saved to Webflow class style.',
        );
        return;
      }
      setStatus(
        `Couldn’t create .${className} as a Webflow class${reason ? ` (${reason})` : ''}` +
          ' — moving it to an embed.',
      );
      setNativeFallback(
        `Webflow wouldn’t create .${className} as a class${reason ? ` (${reason})` : ''}` +
          ' — saved it to the embed instead.',
      );
      writeEmbedProp({ ...write, value });
    });
  };
  return { nativeCreateAndSet };
}

// Pick a default target for a first edit with no chip selected.
function useAutoSelect(
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  selectorPick: ReturnType<typeof useSelectorPick>,
) {
  const { nativeModelRef } = nativeState;
  const { snapshot } = elementTokens;
  const { selectActiveSelector } = selectorPick;

  // First edit with no chip selected: pick a default target — the element's first
  // applied Webflow class (edit it natively), else its tag (edit it in an embed) —
  // select it for the UI and return the route to write THIS edit to (state won't
  // update in time). Undefined → nothing to style.
  const autoSelectForEdit = (): { native: number } | { embedSelector: string } | undefined => {
    const styles = nativeModelRef.current?.styles ?? [];
    const baseIndex = styles.findIndex((style) => style.applied);
    const base = styles[baseIndex];
    if (base) {
      selectActiveSelector(`.${base.className}`);
      return { native: baseIndex };
    }
    const tag = snapshot?.tag;
    if (tag) {
      selectActiveSelector(tag);
      return { embedSelector: tag };
    }
    return undefined;
  };
  return { autoSelectForEdit };
}

// Commit a property to the pick's layer.
function useSetProp(
  scanState: ReturnType<typeof useScanState>,
  liveEdits: ReturnType<typeof useLiveEdits>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  resolvedHook: ReturnType<typeof useResolved>,
  createRule: ReturnType<typeof useCreateRule>,
  addQuery: ReturnType<typeof useAddQuery>,
  nativeSet: ReturnType<typeof useNativeSet>,
  nativeCreate: ReturnType<typeof useNativeCreate>,
  autoSelect: ReturnType<typeof useAutoSelect>,
) {
  const { setStatus } = scanState;
  const { liveOriginRef } = liveEdits;
  const { activeSelector } = activeSelectorHook;
  const { creatableClass } = nativeTarget;
  const { selectedNativeIndex } = resolvedHook;
  const { createSelectedRule } = createRule;
  const { propLayer, writeEmbedProp } = addQuery;
  const { nativeSetOrFallback } = nativeSet;
  const { nativeCreateAndSet } = nativeCreate;
  const { autoSelectForEdit } = autoSelect;

  const setProp: SetProp = (prop, typed, important) => {
    // A gap or a padding cannot go below zero. Here rather than in the fields
    // themselves: a value reaches this point from a typed edit, an arrow step, a
    // drag, a variable pick and the add-property row, and a rule enforced in one
    // field is a rule the other four ways around it don't have.
    const write: PropWrite = { prop, value: clampNonNegative(prop, typed), important };
    // A commit is the new baseline: whatever a live write overwrote on the way here is
    // no longer what "revert" should restore.
    liveOriginRef.current.delete(prop);
    if (!activeSelector) {
      const route = autoSelectForEdit();
      if (route && 'native' in route) {
        nativeSetOrFallback(route.native, write);
        return;
      }
      if (route && 'embedSelector' in route) {
        createSelectedRule(write, route.embedSelector);
        return;
      }
      setStatus('Nothing to style here — add a class in Webflow first.');
      return;
    }
    if (propLayer(prop) === 'native') {
      if (selectedNativeIndex !== undefined) {
        nativeSetOrFallback(selectedNativeIndex, write);
        return;
      }
      if (creatableClass) {
        nativeCreateAndSet(creatableClass, write);
        return;
      }
    }
    writeEmbedProp(write);
  };
  return { setProp };
}

// Clear, revert, and live-set a property.
function useClearProp(
  selectionState: ReturnType<typeof useSelectionState>,
  propEdits: ReturnType<typeof usePropEdits>,
  liveEdits: ReturnType<typeof useLiveEdits>,
  ruleActions: ReturnType<typeof useRuleActions>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  resolvedHook: ReturnType<typeof useResolved>,
  nativeOps: ReturnType<typeof useNativeOps>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
  addQuery: ReturnType<typeof useAddQuery>,
) {
  const { stateKey } = selectionState;
  const { onClearProp } = propEdits;
  const { liveOriginRef } = liveEdits;
  const { onRevertProp } = ruleActions;
  const { currentContext } = styleContextsHook;
  const { selectedNativeIndex } = resolvedHook;
  const { nativeClearAt } = nativeOps;
  const { selectedRule } = writeNewRuleHook;
  const { propLayer } = addQuery;

  const clearProp = (prop: string | string[]) => {
    const props = Array.isArray(prop) ? prop : [prop];
    props.forEach((prop) => liveOriginRef.current.delete(prop)); // clearing is a commit too
    const nativeProps = props.filter((prop) => propLayer(prop) === 'native');
    const embedProps = props.filter((prop) => propLayer(prop) === 'embed');
    if (nativeProps.length && selectedNativeIndex !== undefined) {
      void nativeClearAt(selectedNativeIndex, nativeProps, optionsFor(currentContext, stateKey));
    }
    if (embedProps.length && selectedRule) {
      onClearProp(selectedRule, embedProps);
    }
  };
  // Abandon the live writes for `prop` and put back what they overwrote — the dropdown
  // hover-scrub's counterpart to liveSetProp (closing the list without picking).
  const revertProp = (prop: string) => {
    if (propLayer(prop) === 'native' || !selectedRule) {
      return;
    }
    onRevertProp(selectedRule, prop);
  };
  return { clearProp, revertProp };
}

// Live-set a property on the pick’s layer.
function useLiveSetProp(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  liveEdits: ReturnType<typeof useLiveEdits>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeOps: ReturnType<typeof useNativeOps>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
  addQuery: ReturnType<typeof useAddQuery>,
  autoSelect: ReturnType<typeof useAutoSelect>,
  clearPropHook: ReturnType<typeof useClearProp>,
) {
  const { stateKey } = selectionState;
  const { nativeModelRef } = nativeState;
  const { onLiveSetProp } = liveEdits;
  const { activeSelector } = activeSelectorHook;
  const { currentContext } = styleContextsHook;
  const { nativeLiveSet } = nativeOps;
  const { selectedRule } = writeNewRuleHook;
  const { nativeHandle, propLayer } = addQuery;
  const { autoSelectForEdit } = autoSelect;
  const { revertProp } = clearPropHook;

  const liveSetProp: LiveSetProp = (prop, typed, important) => {
    // `undefined` = abandon this property's live writes and put back what they
    // overwrote — the hover-scrub's counterpart (a dropdown closed without picking, a
    // field's edit cancelled). Nothing to undo if no live write happened.
    if (typed === undefined) {
      revertProp(prop);
      return;
    }
    const value = clampNonNegative(prop, typed);
    // Don't push half-typed / invalid values live: Webflow's native API errors on
    // them and gets stuck. Keep the last valid value applied until a complete valid
    // one is typed; the blur commit still runs authoritatively.
    if (!isSupportedCssValue(prop, value)) {
      return;
    }
    if (!activeSelector) {
      // Select the default target so the blur commit + later edits land on it; live-
      // preview natively when it's a class (an embed rule doesn't exist yet to scrub).
      const route = autoSelectForEdit();
      if (route && 'native' in route) {
        const handle = nativeModelRef.current?.styles[route.native]?.style;
        if (handle) {
          nativeLiveSet(handle, prop, hslaToRgba(value), optionsFor(currentContext, stateKey));
        }
      }
      return;
    }
    if (propLayer(prop) === 'native') {
      const handle = nativeHandle();
      if (handle) {
        nativeLiveSet(handle, prop, hslaToRgba(value), optionsFor(currentContext, stateKey));
        return;
      }
    }
    if (selectedRule) {
      onLiveSetProp(selectedRule, prop, value, important);
    }
  };
  return { liveSetProp };
}

// The source dropdown: every embed, grouped by component.
function useSourceOptions(
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  resolvedHook: ReturnType<typeof useResolved>,
) {
  const { nativeModel } = nativeState;
  const { model } = elementTokens;
  const { currentContext } = styleContextsHook;
  const { creatableClass, embedList } = nativeTarget;
  const { effectiveSource, selectedNativeIndex } = resolvedHook;

  // The name to badge when editing a native class style.
  const nativeStyleName =
    effectiveSource === 'native'
      ? selectedNativeIndex !== undefined && nativeModel
        ? nativeModel.styles[selectedNativeIndex]?.displayName ||
          nativeModel.styles[selectedNativeIndex]?.className ||
          ''
        : creatableClass
      : undefined;
  const sourceNote: string | undefined = undefined;

  // Which embeds carry a rule for this element in the current context (dropdown dot).
  const embedsWithRules = useMemo(() => {
    const set = new Set<string>();
    if (!model || currentContext.embedAtContext === undefined) {
      return set;
    }
    for (const matched of [...model.base, ...model.conditional]) {
      if (contextKeyOf(matched.rule) === currentContext.embedAtContext) {
        set.add(matched.rule.embedKey);
      }
    }
    return set;
  }, [model, currentContext]);

  // The source dropdown: every embed in page order (later embeds win the cascade).
  // Webflow isn't a choice — styles apply natively first and fall back to the
  // picked embed. This just chooses which embed catches that fallback. Page-level
  // embeds lead; component embeds are grouped under a component subheader so it's
  // clear which embeds belong to which component.
  const sourceOptions = useMemo<SourceOption[]>(() => {
    const embedOption = (embedDocument: EmbedDocument, indent = false): SourceOption => ({
      value: embedDocument.source.key,
      label: embedDocument.source.label,
      marked: embedsWithRules.has(embedDocument.source.key),
      fromComponent: embedDocument.source.fromComponent,
      indent,
    });
    const optionList: SourceOption[] = [];
    for (const embedDocument of embedList) {
      if (!embedDocument.source.fromComponent) {
        optionList.push(embedOption(embedDocument));
      }
    }
    const byComponent = new Map<string, EmbedDocument[]>();
    for (const embedDocument of embedList) {
      if (!embedDocument.source.fromComponent) {
        continue;
      }
      const name = embedDocument.source.componentName ?? 'Component';
      byComponent.set(name, [...(byComponent.get(name) ?? []), embedDocument]);
    }
    for (const [name, docs] of byComponent) {
      optionList.push({ value: `__component__${name}`, label: name, heading: true });
      docs.forEach((embedDocument, i) => {
        // List row: group-scoped "Embed #1"; closed trigger: full "Global Styles #1".
        const triggerName = docs.length > 1 ? `${name} #${i + 1}` : name;
        optionList.push({
          ...embedOption(embedDocument, true),
          triggerLabel: `${triggerName}${embedSourceClassSuffix(embedDocument.source)}`,
        });
      });
    }
    return optionList;
  }, [embedList, embedsWithRules]);
  return { nativeStyleName, sourceNote, sourceOptions };
}

// Embed labels and navigation for the provenance chips.
function useEmbedNav(
  nativeState: ReturnType<typeof useNativeState>,
  openEmbed: ReturnType<typeof useOpenEmbed>,
  sourceOptionsHook: ReturnType<typeof useSourceOptions>,
) {
  const { nativeModel } = nativeState;
  const { openEmbedByKey } = openEmbed;
  const { sourceOptions } = sourceOptionsHook;

  // The full embed label per key (e.g. "Global Styles #1" for a component embed),
  // matching the source dropdown's trigger — used by provenance chips.
  const embedLabelByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of sourceOptions) {
      if (option.heading) {
        continue;
      }
      map.set(option.value, option.triggerLabel ?? option.label);
    }
    return map;
  }, [sourceOptions]);

  // Provided to every ProvenanceList so its embed chips can name (full label) and
  // navigate to the source embed on the canvas.
  const embedNav = useMemo(
    () => ({ open: openEmbedByKey, labelFor: (key: string) => embedLabelByKey.get(key) ?? key }),
    [openEmbedByKey, embedLabelByKey],
  );

  const nativeHasAny = nativeModel?.styles.some((style) => style.propsByContext.size > 0) ?? false;
  return { embedLabelByKey, embedNav, nativeHasAny };
}

// The card's selector props.
function useSelectionCard(
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  typedSelector: ReturnType<typeof useTypedSelector>,
  focusPropHook: ReturnType<typeof useFocusProp>,
  selectorChipsHook: ReturnType<typeof useSelectorChips>,
) {
  const { selectedSelectorText } = selectionState;
  const { selectorSuggestions, snapshot } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { selectActiveSelector } = selectorPick;
  const { addTypedSelector, deselect } = typedSelector;
  const { onSelectSelector } = focusPropHook;
  const { selectorChips } = selectorChipsHook;

  const cardSelection = {
    snapshot,
    selectedSelector: activeSelector,
    activePicked: selectedSelectorText !== undefined,
    selectors: selectorChips,
    suggestions: selectorSuggestions,
    activeSelector,
    onSelectActive: selectActiveSelector,
    onDeselect: deselect,
    onAddSelector: addTypedSelector,
    onSelectSelector,
  };
  return { cardSelection };
}

// The card's context and query props.
function useContextCard(
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  sourceDocumentHook: ReturnType<typeof useSourceDocument>,
  renameQuery: ReturnType<typeof useRenameQuery>,
  querySuggestionsHook: ReturnType<typeof useQuerySuggestions>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  resolvedHook: ReturnType<typeof useResolved>,
  selectorChipsHook: ReturnType<typeof useSelectorChips>,
  contextChange: ReturnType<typeof useContextChange>,
  addQuery: ReturnType<typeof useAddQuery>,
  embedNavHook: ReturnType<typeof useEmbedNav>,
) {
  const { cssCodeOpen, setCssCodeOpen } = scanState;
  const { context } = selectionState;
  const { model } = elementTokens;
  const { queryUses, sourceDocument } = sourceDocumentHook;
  const { onRenameQuery } = renameQuery;
  const { querySuggestions } = querySuggestionsHook;
  const { styleContexts } = styleContextsHook;
  const { resolved } = resolvedHook;
  const { contextInfos } = selectorChipsHook;
  const { onContextChange } = contextChange;
  const { onAddQuery } = addQuery;
  const { embedLabelByKey } = embedNavHook;

  const cardContexts = {
    cssCodeOpen,
    onToggleCssCode: () => setCssCodeOpen((open) => !open),
    model: model ?? EMPTY_RULE_MODEL,
    resolved: resolved ?? EMPTY_RESOLVED,
    contexts: styleContexts,
    contextInfos,
    context,
    onContext: onContextChange,
    onAddQuery,
    onRenameQuery,
    queryUses,
    // The name the source pill below shows for the same file, so the two lines agree
    // on what "ContentWrapper" is called.
    sourceLabel:
      (sourceDocument && embedLabelByKey.get(sourceDocument.source.key)) ??
      sourceDocument?.source.label ??
      'this file',
    querySuggestions,
  };
  return { cardContexts };
}

// The card's source and write props.
function useSourceCard(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  refreshHook: ReturnType<typeof useRefresh>,
  ruleActions: ReturnType<typeof useRuleActions>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
  setPropHook: ReturnType<typeof useSetProp>,
  clearPropHook: ReturnType<typeof useClearProp>,
  liveSetPropHook: ReturnType<typeof useLiveSetProp>,
  sourceOptionsHook: ReturnType<typeof useSourceOptions>,
) {
  const { busy } = busyState;
  const { phase, scanningMore } = scanState;
  const { pendingKeys, setSourceSelection } = nativeState;
  const { resolving } = refreshHook;
  const { onRemoveRule, onSaveCssRule } = ruleActions;
  const { effectiveSourceSelection } = nativeTarget;
  const { selectedRule } = writeNewRuleHook;
  const { setProp } = setPropHook;
  const { clearProp } = clearPropHook;
  const { liveSetProp } = liveSetPropHook;
  const { nativeStyleName, sourceNote, sourceOptions } = sourceOptionsHook;

  const cardSource = {
    sourceValue: effectiveSourceSelection,
    sourceOptions,
    onSourceChange: (value: string) => {
      setSourceSelection(value);
      saveEmbedSource(value);
    },
    sourceNote,
    nativeStyleName,
    loading: phase === 'scanning' || scanningMore,
    resolving,
    busy,
    pending: selectedRule ? pendingKeys.has(selectedRule.embedKey) : false,
  };
  const cardWrites = {
    setProp,
    clearProp,
    liveSetProp,
    onAdd: setProp,
    onSaveCssRule,
    onRemoveRule,
  };
  return { cardSource, cardWrites };
}

// What the panel's root renders from.
function useEditorView(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  embedNavHook: ReturnType<typeof useEmbedNav>,
  selectionCard: ReturnType<typeof useSelectionCard>,
  contextCard: ReturnType<typeof useContextCard>,
  sourceCard: ReturnType<typeof useSourceCard>,
) {
  const { rootRef } = editorRefs;
  const { busy, saveError } = busyState;
  const { nativeFallback, phase, scan, scanningMore, setNativeFallback } = scanState;
  const { pendingKeys } = nativeState;
  const { model } = elementTokens;
  const { embedNav, nativeHasAny } = embedNavHook;
  const { cardSelection } = selectionCard;
  const { cardContexts } = contextCard;
  const { cardSource, cardWrites } = sourceCard;

  const card: StyleCardProps = { ...cardSelection, ...cardContexts, ...cardSource, ...cardWrites };
  const view: EditorView = {
    embedNav,
    rootRef,
    busy,
    saveError,
    pendingCount: pendingKeys.size,
    nativeFallback,
    dismissFallback: () => setNativeFallback(undefined),
    phase,
    card,
    scanningMore,
    model,
    nativeHasAny,
    scan,
  };
  return { view };
}

// What the panel's root renders from.
interface EditorView {
  embedNav: { open: (embedKey: string) => void; labelFor: (key: string) => string };
  rootRef: React.RefObject<HTMLDivElement>;
  busy: boolean;
  saveError: string | undefined;
  pendingCount: number;
  nativeFallback: string | undefined;
  dismissFallback: () => void;
  phase: Phase;
  card: StyleCardProps;
  scanningMore: boolean;
  model: RuleModel | undefined;
  nativeHasAny: boolean;
  scan: ScanState | undefined;
}

function EditorRoot({ view }: { view: EditorView }) {
  const { phase, model, pendingCount } = view;
  return (
    <ProvenanceEmbedNav.Provider value={view.embedNav}>
      <div className="embed-editor_root" ref={view.rootRef}>
        {/* Save/context state lives in the header (spinner / check / error /
          in-component warning) — hover the header icon for details, no body text. */}
        <SaveIndicator
          busy={view.busy}
          error={view.saveError}
          pending={
            pendingCount
              ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} ` +
                "to the page's styles — not on the canvas until you leave this component"
              : undefined
          }
        />
        <PendingNote count={pendingCount} />
        {view.nativeFallback ? (
          <FallbackNote note={view.nativeFallback} onDismiss={view.dismissFallback} />
        ) : undefined}

        {/* The panel is always usable once Webflow responds, including when no canvas
          element is selected. Embeds and native class values fill in as they load. */}
        {phase === 'scanning' || phase === 'ready' || phase === 'no-selection' ? (
          <section className="embed-editor_section">
            <div className="embed-editor_list">
              <StyleCard {...view.card} />
            </div>
          </section>
        ) : undefined}

        {phase === 'ready' &&
        !view.scanningMore &&
        model &&
        model.matchedRuleCount === 0 &&
        !view.nativeHasAny ? (
          <EmptyScanNote scan={view.scan} />
        ) : undefined}
      </div>
    </ProvenanceEmbedNav.Provider>
  );
}

// Edits to the page's own <style> blocks held while a component is open.
function PendingNote({ count }: { count: number }) {
  if (!count) {
    return undefined;
  }
  return (
    <p className="embed-editor_pending-note">
      {count} change{count === 1 ? '' : 's'} to the page's own &lt;style&gt; block
      {count === 1 ? '' : 's'} {count === 1 ? 'is' : 'are'} held here — the canvas won't show{' '}
      {count === 1 ? 'it' : 'them'} until you leave this component, and{' '}
      {count === 1 ? 'it saves' : 'they save'} when you do.
    </p>
  );
}

// Why a native write fell back to an embed, until dismissed.
function FallbackNote({ note, onDismiss }: { note: string; onDismiss: () => void }) {
  return (
    <p className="embed-editor_fallback-note" role="status">
      {note}
      <button
        type="button"
        className="embed-editor_fallback-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ✕
      </button>
    </p>
  );
}

// Nothing targets the element: how many embeds were scanned, or that there were none.
function EmptyScanNote({ scan }: { scan: ScanState | undefined }) {
  return (
    <div className="embed-editor_empty">
      {scan?.embedCount
        ? `Scanned ${scan.embedCount} embed${scan.embedCount === 1 ? '' : 's'}` +
          (scan.componentEmbedCount ? ` (${scan.componentEmbedCount} in components)` : '') +
          ', but none target this element.'
        : 'No HTML embeds with <style> blocks were found on this page.'}
    </div>
  );
}
