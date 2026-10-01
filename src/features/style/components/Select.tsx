import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { panelBounds } from '../model/panelBox';
import { isHTMLElementInDocument, isNodeInDocument } from '../model/dom';
import { endDragNotes, hoverNote } from '../../../ui/sound';

export type SelectOption<T extends string> = {
  value: T;
  /** Plain-text label — also used for type-ahead matching. */
  label: string;
  /** Optional leading icon (e.g. a preset glyph). */
  icon?: ReactNode;
  /** Show a trailing status dot (white on the selected row, accent otherwise). */
  marked?: boolean;
  /** Render as a non-selectable group subheader — skipped by keyboard nav,
   *  type-ahead, and selection. Its `value` just needs to be unique. */
  heading?: boolean;
  /** Indent the option to show it nests under the preceding heading. */
  indent?: boolean;
  /** Text for the closed trigger when this option is selected — use when the
   *  list label is context-scoped (e.g. "Embed #1" under a group) but the trigger
   *  needs the full name ("Global Styles #1"). Falls back to `label`. */
  triggerLabel?: string;
  /** Icon for the closed trigger when this option is selected. Falls back to
   *  `icon` — use when the trigger icon differs from the list-row icon. */
  triggerIcon?: ReactNode;
  /** Opaque tone token exposed on the trigger as `data-tone` when this option is
   *  selected, so the consumer can color the trigger per option (via its CSS). */
  tone?: string;
  /** A control on the row itself — an edit pencil, say. Pressing it closes the
   *  menu and runs `onSelect` WITHOUT choosing the option: it acts on the option
   *  rather than picking it. Shown on the hovered/active row only. */
  action?: { icon: ReactNode; label: string; onSelect: () => void };
};

type Props<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  ariaLabel?: string;
  /** id of an external element that labels this control (aria-labelledby). */
  labelId?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  /** When provided, the trigger renders this editable field in place of the
   *  value label; the chevron still opens the option list. Turns the closed
   *  control into an input+arrow chip (mirroring the Display control's custom
   *  mode). The field owns its own value/commit logic. */
  customInput?: ReactNode;
  /** 'default' renders the pill trigger; 'link' renders a compact text-link
   *  trigger (label + small chevron, no fill) that still opens the same list. */
  variant?: 'default' | 'link';
  /** Show a filter input pinned to the top of the open list — matches option
   *  labels (substring, case-insensitive) and keeps a group heading only when one
   *  of its options matches. Arrow/Enter/Escape still drive the list while typing. */
  searchable?: boolean;
  /** Placeholder for the search input (searchable only). */
  searchPlaceholder?: string;
  /** Render the closed trigger with its label only, even when the selected option
   *  has an icon (the icons still show in the open list). */
  hideTriggerIcon?: boolean;
  /** Live-preview the highlighted option while the list is open (Webflow's hover
   *  scrub): called with a value as the pointer / arrow keys land on it, and with
   *  `undefined` when the list closes WITHOUT a pick — meaning put the original back.
   *  Highlighting the already-selected row re-emits its value, so scrubbing back
   *  over it restores what was there. A pick fires `onChange` instead, and never a
   *  trailing `undefined`: the commit is the value. */
  onPreview?: (value: T | undefined) => void;
};

/**
 * Custom listbox dropdown modeled on the clip-path preset picker: a pill button
 * showing the current value (optional icon + label + chevron) that opens a
 * floating, rounded option list. Full keyboard support (arrows / Home / End /
 * Enter / Escape / Tab / type-ahead), click-outside to close, and auto flip-up
 * when there isn't room below. Reusable across tools. Optionally searchable.
 */
export default function Select<T extends string>(props: Props<T>) {
  const select = useSelectState(props);
  const { open, refs } = select;
  const keys = selectKeyHandlers(select);
  const toggle = () => (open ? select.cancelMenu() : select.openMenu());
  return (
    <div ref={refs.root} className={selectClass(props, { open })}>
      <SelectTrigger
        props={props}
        selectedOption={select.selectedOption}
        open={open}
        buttonRef={refs.button}
        onToggle={toggle}
        onKeyDown={keys.onButtonKeyDown}
      />
      {open ? (
        <SelectList
          props={props}
          listRef={refs.list}
          searchRef={refs.search}
          dropUp={select.dropUp}
          baseId={select.baseId}
          displayed={select.displayed}
          activeIndex={select.activeIndex}
          query={select.query}
          onQuery={select.setQuery}
          onListKeyDown={keys.onListKeyDown}
          onSearchKeyDown={keys.onSearchKeyDown}
          onActivate={select.setActiveIndex}
          onChoose={select.choose}
          onCancel={select.cancelMenu}
        />
      ) : undefined}
    </div>
  );
}

// Everything the control tracks: whether it is open, the filter, the highlight, the
// hover preview, and the handlers that move between them.
function useSelectState<T extends string>(props: Props<T>) {
  const { value, options, searchable = false, variant = 'default' } = props;
  const baseId = useId();
  const refs = useSelectRefs();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // The trigger always reflects the real selected value, independent of any filter.
  const selectedOption = useMemo(
    () =>
      options.find((option) => !option.heading && option.value === value) ??
      options.find((option) => !option.heading),
    [options, value],
  );
  const displayed = useMemo(
    () => filterOptions(options, query, { searchable }),
    [options, query, searchable],
  );
  const { firstSelectable, lastSelectable } = selectableBounds(displayed);
  const found = displayed.findIndex((option) => !option.heading && option.value === value);
  const selectedIndex = found >= 0 ? found : firstSelectable;
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const preview = useHoverPreview({ open, activeIndex, displayed, value, props });
  // Close without picking — Escape, Tab, click-outside, or toggling the trigger — puts
  // the original value back.
  const { cancelPreview } = preview;
  const cancelMenu = useCallback(() => {
    setOpen(false);
    cancelPreview();
  }, [cancelPreview]);
  useHighlightSound({ open, activeIndex, displayed });
  const menu = useMenuActions({ props, refs, displayed, selectedIndex, setActiveIndex, setOpen });
  const choose = (index: number) => menu.choose(index, preview.commit);
  const runTypeahead = useTypeahead(activeIndex, displayed, setActiveIndex);
  useMenuResets({
    open,
    query,
    searchable,
    selectedIndex,
    firstSelectable,
    setActiveIndex,
    setQuery,
  });
  useDismissOutside({ open, rootRef: refs.root, cancelMenu });
  const dropUp = useListPlacement({ open, activeIndex, query, variant, refs });
  return {
    open,
    setOpen,
    refs,
    baseId,
    searchable,
    selectedOption,
    displayed,
    firstSelectable,
    lastSelectable,
    activeIndex,
    setActiveIndex,
    query,
    setQuery,
    dropUp,
    choose,
    cancelMenu,
    openMenu: menu.openMenu,
    move: menu.move,
    runTypeahead,
  };
}

function useSelectRefs(): SelectRefs {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  return useMemo(() => ({ root, button, list, search }), []);
}

type SelectRefs = {
  readonly root: RefObject<HTMLDivElement>;
  readonly button: RefObject<HTMLButtonElement>;
  readonly list: RefObject<HTMLDivElement>;
  readonly search: RefObject<HTMLInputElement>;
};

function selectClass<T extends string>(props: Props<T>, state: { readonly open: boolean }) {
  return [
    'u-select',
    props.variant === 'link' ? 'is-link' : '',
    state.open ? 'is-open' : '',
    props.disabled ? 'is-disabled' : '',
    props.className,
  ]
    .filter(Boolean)
    .join(' ');
}

// The rows shown in the open list — filtered while searching. A row shows when the
// query matches its GROUP HEADING (e.g. the component name) — in which case the
// whole group shows — or the row's own label. The heading is included whenever any
// of its rows show. This lets you search by component name even when every embed
// in a group has the same label ("Embed", "Embed #1", …).
function filterOptions<T extends string>(
  options: SelectOption<T>[],
  query: string,
  mode: { readonly searchable: boolean },
): SelectOption<T>[] {
  if (!mode.searchable || !query.trim()) {
    return options;
  }
  const normalized = query.trim().toLowerCase();
  const out: SelectOption<T>[] = [];
  let heading: SelectOption<T> | undefined;
  let headingMatches = false;
  let headingPushed = false;
  for (const option of options) {
    if (option.heading) {
      heading = option;
      headingMatches = option.label.toLowerCase().includes(normalized);
      headingPushed = false;
      if (headingMatches) {
        out.push(option);
        headingPushed = true;
      }
      continue;
    }
    if (headingMatches || option.label.toLowerCase().includes(normalized)) {
      if (heading && !headingPushed) {
        out.push(heading);
        headingPushed = true;
      }
      out.push(option);
    }
  }
  return out;
}

// Headings are non-selectable — resolve the first/last real rows.
function selectableBounds<T extends string>(displayed: SelectOption<T>[]) {
  const firstSelectable = Math.max(
    0,
    displayed.findIndex((option) => !option.heading),
  );
  let lastSelectable = 0;
  for (let i = displayed.length - 1; i >= 0; i -= 1) {
    if (!displayed[i]?.heading) {
      lastSelectable = i;
      break;
    }
  }
  return { firstSelectable, lastSelectable };
}

// ── Hover preview ──────────────────────────────────────────────────────────
function useHoverPreview<T extends string>({
  open,
  activeIndex,
  displayed,
  value,
  props,
}: {
  open: boolean;
  activeIndex: number;
  displayed: SelectOption<T>[];
  value: T;
  props: Props<T>;
}) {
  // Read the callback through a ref: consumers pass an inline arrow, so depending on
  // its identity would re-run the emit effect (and re-emit) on every render.
  const onPreviewRef = useRef(props.onPreview);
  onPreviewRef.current = props.onPreview;
  // The value the preview last emitted — seeded with the committed value on open, so the
  // first emit only happens once the highlight moves off the selected row.
  const shownRef = useRef<T | undefined>(undefined);
  // Whether anything was previewed this session. The revert is driven off THIS, not off a
  // comparison with `value`: a live preview write can be picked up by the panel's periodic
  // rescan, which moves `value` onto the previewed value — and then a comparison would
  // conclude there was nothing to undo and leave the preview applied. The consumer knows
  // what the preview overwrote, so asking it to restore is always safe.
  const emittedRef = useRef(false);
  const cancelPreview = useCallback(() => {
    shownRef.current = undefined;
    if (!emittedRef.current) {
      return;
    }
    emittedRef.current = false;
    onPreviewRef.current?.(undefined);
  }, []);
  // A pick replaces the preview: nothing to revert.
  const commit = useCallback(() => {
    shownRef.current = undefined;
    emittedRef.current = false;
  }, []);

  // Emit as the highlight moves. Headings can't be highlighted, so anything landed on
  // is a real option; re-emitting the committed value is exactly how scrubbing back to
  // the selected row undoes the preview.
  useEffect(() => {
    if (!open || !onPreviewRef.current) {
      return;
    }
    const option = displayed[activeIndex];
    if (!option || option.heading) {
      return;
    }
    if (shownRef.current === undefined) {
      shownRef.current = value;
    } // baseline for this session
    if (option.value === shownRef.current) {
      return;
    }
    shownRef.current = option.value;
    emittedRef.current = true;
    onPreviewRef.current(option.value);
  }, [open, activeIndex, displayed, value]);

  // A preview must never outlive the menu: revert if this control unmounts (the section
  // collapsed, the selection changed) while one is showing.
  useEffect(
    () => () => {
      if (emittedRef.current) {
        onPreviewRef.current?.(undefined);
      }
    },
    [],
  );
  return { cancelPreview, commit };
}

// The highlight moving is a sound, pitched by how far down the list it is: the
// first row is the top of the scale, the last is the bottom. Driven off the
// highlight rather than off the pointer, so arrowing through a menu sounds
// the same as running down it with the mouse — it is the same movement.
//
// Not on the way in: opening a menu already parks the highlight on the
// selected row, and a note for a highlight nobody moved would sound like the
// menu answering a question that hadn't been asked.
function useHighlightSound<T extends string>({
  open,
  activeIndex,
  displayed,
}: {
  readonly open: boolean;
  readonly activeIndex: number;
  readonly displayed: SelectOption<T>[];
}): void {
  const placedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      // Only on the way closed, never merely WHILE closed. `displayed` is a new
      // array each render, so this effect runs on every render of every Select
      // in the panel — and the panel is full of them. Resetting from here
      // unconditionally meant a closed dropdown wiped the note the open one had
      // just played, and the open one then played the same row again: two notes
      // for one row, from a control nobody was touching.
      if (placedRef.current) {
        placedRef.current = false;
        endDragNotes(); // the next menu sounds its first row, wherever it opens
      }
      return;
    }
    if (!placedRef.current) {
      placedRef.current = true;
      return;
    }
    if (displayed[activeIndex]) {
      hoverNote(activeIndex, displayed.length);
    }
  }, [open, activeIndex, displayed]);
}

type MenuActionsInput<T extends string> = {
  readonly props: Props<T>;
  readonly refs: SelectRefs;
  readonly displayed: SelectOption<T>[];
  readonly selectedIndex: number;
  readonly setActiveIndex: (index: number) => void;
  readonly setOpen: (open: boolean) => void;
};

function useMenuActions<T extends string>(input: MenuActionsInput<T>) {
  const { props, refs, displayed, selectedIndex, setActiveIndex, setOpen } = input;
  const { disabled, searchable = false, onChange } = props;
  const openMenu = useCallback(
    (index = selectedIndex) => {
      if (disabled) {
        return;
      }
      setActiveIndex(firstRealRow(displayed, clampIndex(index, displayed.length)));
      setOpen(true);
      window.requestAnimationFrame(() =>
        (searchable ? refs.search.current : refs.list.current)?.focus({ preventScroll: true }),
      );
    },
    [disabled, displayed, selectedIndex, searchable, refs, setActiveIndex, setOpen],
  );

  const choose = useCallback(
    (index: number, commitPreview: () => void) => {
      const option = displayed[index];
      if (!option || option.heading) {
        return;
      }
      commitPreview(); // committed — the pick replaces the preview, no revert
      onChange(option.value);
      setOpen(false);
      window.requestAnimationFrame(() => refs.button.current?.focus({ preventScroll: true }));
    },
    [displayed, onChange, refs, setOpen],
  );

  // Move the highlight `direction` steps, skipping heading rows and wrapping around.
  const move = useCallback(
    (from: number, direction: number) => {
      const count = displayed.length;
      if (count === 0) {
        return;
      }
      for (let step = 1; step <= count; step += 1) {
        const i = (((from + direction * step) % count) + count) % count;
        if (!displayed[i]?.heading) {
          setActiveIndex(i);
          return;
        }
      }
    },
    [displayed, setActiveIndex],
  );
  return { openMenu, choose, move };
}

// Never park the highlight on a heading — hop to the next real option.
function firstRealRow<T extends string>(displayed: SelectOption<T>[], start: number): number {
  if (!displayed[start]?.heading) {
    return start;
  }
  for (let step = 1; step <= displayed.length; step += 1) {
    const i = (start + step) % displayed.length;
    if (!displayed[i]?.heading) {
      return i;
    }
  }
  return start;
}

function useTypeahead<T extends string>(
  activeIndex: number,
  displayed: SelectOption<T>[],
  setActiveIndex: (index: number) => void,
) {
  const typeahead = useRef('');
  const typeaheadTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (typeaheadTimer.current !== undefined) {
        window.clearTimeout(typeaheadTimer.current);
      }
    },
    [],
  );
  return useCallback(
    (key: string): boolean => {
      if (key.length !== 1 || !/\S/.test(key)) {
        return false;
      }
      if (typeaheadTimer.current !== undefined) {
        window.clearTimeout(typeaheadTimer.current);
      }
      const typed = `${typeahead.current}${key}`.toLowerCase();
      typeahead.current = typed;
      typeaheadTimer.current = window.setTimeout(() => {
        typeahead.current = '';
        typeaheadTimer.current = undefined;
      }, 500);
      // On the first keystroke, start searching after the active option so
      // repeated presses cycle; while a query is building, match from it.
      const start = (activeIndex + (typed.length === 1 ? 1 : 0)) % displayed.length;
      for (let i = 0; i < displayed.length; i += 1) {
        const index = (start + i) % displayed.length;
        const option = displayed[index];
        if (option && !option.heading && option.label.toLowerCase().startsWith(typed)) {
          setActiveIndex(index);
          return true;
        }
      }
      return false;
    },
    [activeIndex, displayed, setActiveIndex],
  );
}

function useMenuResets({
  open,
  query,
  searchable,
  selectedIndex,
  firstSelectable,
  setActiveIndex,
  setQuery,
}: {
  readonly open: boolean;
  readonly query: string;
  readonly searchable: boolean;
  readonly selectedIndex: number;
  readonly firstSelectable: number;
  readonly setActiveIndex: (index: number) => void;
  readonly setQuery: (query: string) => void;
}): void {
  // Keep the highlighted option in sync with the selected value while closed.
  useEffect(() => {
    if (!open) {
      setActiveIndex(selectedIndex);
    }
  }, [selectedIndex, open, setActiveIndex]);

  // Reset the filter when the menu closes so the next open shows the full list.
  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open, setQuery]);

  // Re-highlight the first match whenever the query changes (deps intentionally just
  // `query`: firstSelectable is read from this render's filtered list).
  useEffect(() => {
    if (open && searchable) {
      setActiveIndex(firstSelectable);
    }
    // Only a new query re-highlights: opening, or the options changing, keeps the highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a stale firstSelectable is intended.
  }, [query]);
}

// Close when clicking outside the control.
function useDismissOutside({
  open,
  rootRef,
  cancelMenu,
}: {
  readonly open: boolean;
  readonly rootRef: RefObject<HTMLDivElement>;
  readonly cancelMenu: () => void;
}): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (
        root &&
        isNodeInDocument(event.target, root.ownerDocument) &&
        root.contains(event.target)
      ) {
        return;
      }
      cancelMenu();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, rootRef, cancelMenu]);
}

// Flip above the button when there isn't room below; keep the active option
// visible; and clamp horizontally so the menu never overflows the panel.
function useListPlacement({
  open,
  activeIndex,
  query,
  variant,
  refs,
}: {
  readonly open: boolean;
  readonly activeIndex: number;
  readonly query: string;
  readonly variant: 'default' | 'link';
  readonly refs: SelectRefs;
}): boolean {
  const [dropUp, setDropUp] = useState(false);
  // Distinguishes the open transition from in-list navigation (drives the one-time
  // "scroll the selected option near the top" on open).
  const wasOpenRef = useRef(false);
  const { root: rootRef, list: listRef } = refs;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const trigger = rootRef.current;
    const opening = !wasOpenRef.current; // true only on the open→(measure) transition
    wasOpenRef.current = true;
    if (trigger && list) {
      const rect = trigger.getBoundingClientRect();
      const listHeight = list.offsetHeight;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setDropUp(spaceBelow < listHeight + 8 && spaceAbove > spaceBelow);
      if (variant === 'link') {
        clampLinkMenu(trigger, list);
      }
    }
    if (list) {
      scrollActiveIntoList(list, { opening });
    }
    // `activeIndex` and `query` are what move the active row; the effect reads it
    // from the DOM rather than from them.
  }, [open, activeIndex, query, variant, rootRef, listRef]);
  return dropUp;
}

// Clamp horizontally ONLY for the link variant — its menu is fixed-width and
// anchored to the trigger's left, so it can run off the panel edge. The default
// variant stretches to the trigger's own width (left:0/right:0) and is already
// inside the panel, so it must NOT be nudged. Applied imperatively — a state-driven
// transform paints the menu at its natural position for a frame first (a jump). x is
// derived from the TRIGGER (stable) + the menu's width, not the just-mounted list's
// rect (which measured wrong on the first open). Bounds = the app's scroll container
// (the panel can be a sub-region of a wider Designer window).
function clampLinkMenu(trigger: HTMLDivElement, listElement: HTMLDivElement): void {
  const margin = 8;
  const rect = trigger.getBoundingClientRect();
  const bounds = panelBounds(trigger);
  const naturalLeft = rect.left; // menu is anchored left:0 to the trigger
  const naturalRight = rect.left + listElement.offsetWidth;
  const next =
    naturalRight > bounds.right - margin
      ? bounds.right - margin - naturalRight
      : naturalLeft < bounds.left + margin
        ? bounds.left + margin - naturalLeft
        : 0;
  listElement.style.transform = next ? `translateX(${next}px)` : '';
}

// Vertical scroll — only the LIST's own overflow (never scrollIntoView, whose inline
// axis would slide the whole panel sideways). On OPEN, bring the selected option's
// group heading right under the (sticky) search so the selection sits near the top;
// while navigating, just keep the active option in view.
function scrollActiveIntoList(
  listElement: HTMLDivElement,
  moment: { readonly opening: boolean },
): void {
  const active = listElement.querySelector<HTMLElement>('[data-active="true"]');
  if (!active) {
    return;
  }
  const searchHeight =
    listElement.querySelector<HTMLElement>('.u-select-search')?.offsetHeight ?? 0;
  if (moment.opening) {
    let node = active.previousElementSibling;
    while (
      isHTMLElementInDocument(node, active.ownerDocument) &&
      !node.classList.contains('u-select-heading')
    ) {
      node = node.previousElementSibling;
    }
    const heading = isHTMLElementInDocument(node, active.ownerDocument) ? node : undefined;
    const anchor = heading ?? active;
    listElement.scrollTop = Math.max(0, anchor.offsetTop - searchHeight);
    return;
  }
  const listRect = listElement.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  if (activeRect.top < listRect.top + searchHeight) {
    listElement.scrollTop -= listRect.top + searchHeight - activeRect.top;
  } else if (activeRect.bottom > listRect.bottom) {
    listElement.scrollTop += activeRect.bottom - listRect.bottom;
  }
}

type KeyInput = {
  readonly searchable: boolean;
  readonly activeIndex: number;
  readonly firstSelectable: number;
  readonly lastSelectable: number;
  readonly openMenu: (index?: number) => void;
  readonly move: (from: number, direction: number) => void;
  readonly choose: (index: number) => void;
  readonly cancelMenu: () => void;
  readonly runTypeahead: (key: string) => boolean;
  readonly setActiveIndex: (index: number) => void;
  readonly setOpen: (open: boolean) => void;
  readonly refs: SelectRefs;
};

function selectKeyHandlers(input: KeyInput) {
  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        input.openMenu();
        return;
      case 'ArrowUp':
      case 'End':
        event.preventDefault();
        input.openMenu(input.lastSelectable);
        return;
      case 'Home':
        event.preventDefault();
        input.openMenu(input.firstSelectable);
        return;
      default:
        if (!input.searchable && input.runTypeahead(event.key)) {
          event.preventDefault();
          input.setOpen(true);
          window.requestAnimationFrame(() =>
            input.refs.list.current?.focus({ preventScroll: true }),
          );
        }
    }
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ') {
      event.preventDefault();
      input.choose(input.activeIndex);
      return;
    } // list has no text input
    if (navigateByKey(event, input)) {
      return;
    }
    if (input.runTypeahead(event.key)) {
      event.preventDefault();
    }
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter/Space handling: Space types into the input, so only Enter selects.
    if (event.key === ' ') {
      return;
    }
    navigateByKey(event, input);
  };
  return { onButtonKeyDown, onListKeyDown, onSearchKeyDown };
}

// Nav keys shared by the list (non-searchable) and the search input (searchable).
function navigateByKey(event: KeyboardEvent<HTMLElement>, input: KeyInput): boolean {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      input.move(input.activeIndex, 1);
      return true;
    case 'ArrowUp':
      event.preventDefault();
      input.move(input.activeIndex, -1);
      return true;
    case 'Home':
      event.preventDefault();
      input.setActiveIndex(input.firstSelectable);
      return true;
    case 'End':
      event.preventDefault();
      input.setActiveIndex(input.lastSelectable);
      return true;
    case 'Enter':
    case ' ':
      event.preventDefault();
      input.choose(input.activeIndex);
      return true;
    case 'Escape':
      event.preventDefault();
      input.cancelMenu();
      input.refs.button.current?.focus({ preventScroll: true });
      return true;
    case 'Tab':
      input.cancelMenu();
      return true;
    default:
      return false;
  }
}

// A ReactNode given as null by a caller means "none", the same as leaving it out.
const present = (node: ReactNode): boolean => (node ?? undefined) !== undefined;

const CHEVRON = (
  <svg className="u-select-chevron" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4.2 6.2 8 10l3.8-3.8" />
  </svg>
);

function SelectTrigger<T extends string>({
  props,
  selectedOption,
  open,
  buttonRef,
  onToggle,
  onKeyDown,
}: {
  props: Props<T>;
  selectedOption: SelectOption<T> | undefined;
  open: boolean;
  buttonRef: RefObject<HTMLButtonElement>;
  onToggle: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const triggerLabel = selectedOption ? (selectedOption.triggerLabel ?? selectedOption.label) : '';
  const triggerIcon = selectedOption?.triggerIcon ?? selectedOption?.icon;
  const shared = {
    ref: buttonRef,
    id: props.id,
    type: 'button' as const,
    'aria-haspopup': 'listbox' as const,
    'aria-expanded': open,
    'aria-label': props.ariaLabel,
    'aria-labelledby': props.labelId,
    disabled: props.disabled,
    onClick: onToggle,
    onKeyDown,
  };
  const icon =
    !props.hideTriggerIcon && present(triggerIcon) ? (
      <span className="u-select-icon">{triggerIcon}</span>
    ) : undefined;
  if (present(props.customInput)) {
    return (
      <div className="u-select-button is-custom">
        {props.customInput}
        <button {...shared} className="u-select-chevron-btn">
          {CHEVRON}
        </button>
      </div>
    );
  }
  if (props.variant === 'link') {
    return (
      <button {...shared} className="u-select-link" data-tone={selectedOption?.tone}>
        {icon}
        <span className="u-select-label">{triggerLabel}</span>
        {CHEVRON}
      </button>
    );
  }
  return (
    <button {...shared} className="u-select-button" data-tone={selectedOption?.tone}>
      <span className="u-select-value">
        {icon}
        <span className="u-select-label">{triggerLabel}</span>
      </span>
      {CHEVRON}
    </button>
  );
}

type SelectListProps<T extends string> = {
  props: Props<T>;
  listRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  dropUp: boolean;
  baseId: string;
  displayed: SelectOption<T>[];
  activeIndex: number;
  query: string;
  onQuery: (query: string) => void;
  onListKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onActivate: (index: number) => void;
  onChoose: (index: number) => void;
  onCancel: () => void;
};

const optionId = (baseId: string, index: number) => `${baseId}-opt-${index}`;

function SelectList<T extends string>(list: SelectListProps<T>) {
  const { props, displayed } = list;
  const { ariaLabel, labelId, searchable = false } = props;
  return (
    <div
      ref={list.listRef}
      className={['u-select-list', list.dropUp ? 'is-up' : ''].filter(Boolean).join(' ')}
      role="listbox"
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-labelledby={labelId}
      aria-activedescendant={optionId(list.baseId, list.activeIndex)}
      onKeyDown={searchable ? undefined : list.onListKeyDown}
    >
      {searchable ? (
        <div className="u-select-search">
          <input
            ref={list.searchRef}
            type="text"
            className="u-select-search-input"
            placeholder={props.searchPlaceholder ?? 'Search…'}
            value={list.query}
            onChange={(event) => list.onQuery(event.target.value)}
            onKeyDown={list.onSearchKeyDown}
            aria-label={ariaLabel ? `Search ${ariaLabel}` : 'Search'}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      ) : undefined}
      {displayed.length === 0 ? (
        <div className="u-select-empty" role="presentation">
          No matches
        </div>
      ) : (
        displayed.map((option, index) => (
          <SelectRow
            key={option.value}
            option={option}
            id={optionId(list.baseId, index)}
            selected={option.value === props.value}
            active={index === list.activeIndex}
            onActivate={() => list.onActivate(index)}
            onChoose={() => list.onChoose(index)}
            onCancel={list.onCancel}
          />
        ))
      )}
    </div>
  );
}

function SelectRow<T extends string>({
  option,
  id,
  selected,
  active,
  onActivate,
  onChoose,
  onCancel,
}: {
  option: SelectOption<T>;
  id: string;
  selected: boolean;
  active: boolean;
  onActivate: () => void;
  onChoose: () => void;
  onCancel: () => void;
}) {
  const icon = present(option.icon) ? (
    <span className="u-select-icon">{option.icon}</span>
  ) : undefined;
  if (option.heading) {
    return (
      <div className="u-select-heading" role="presentation">
        {icon}
        <span className="u-select-heading-label">{option.label}</span>
      </div>
    );
  }
  return (
    <div
      id={id}
      className={[
        'u-select-option',
        active ? 'is-active' : '',
        selected ? 'is-selected' : '',
        option.indent ? 'is-indented' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="option"
      aria-selected={selected}
      data-active={active || undefined}
      onMouseEnter={onActivate}
      onClick={onChoose}
    >
      <span className="u-select-check" aria-hidden="true">
        {selected ? CHECK : undefined}
      </span>
      {icon}
      <span className="u-select-label">{option.label}</span>
      {option.marked ? <span className="u-select-dot" aria-hidden="true" /> : undefined}
      {option.action ? <RowAction action={option.action} onCancel={onCancel} /> : undefined}
    </div>
  );
}

const CHECK = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
    <path
      d="M13.5 4.5 6.5 11.5 3 8"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function RowAction({
  action,
  onCancel,
}: {
  action: NonNullable<SelectOption<string>['action']>;
  onCancel: () => void;
}) {
  return (
    <button
      type="button"
      className="u-select-action"
      title={action.label}
      aria-label={action.label}
      // The listbox owns arrow-key focus; this is reached with the
      // pointer (and by name from a screen reader), not by tabbing
      // out of the list mid-navigation.
      tabIndex={-1}
      // The menu closes on an outside pointerdown and picks on click;
      // this row is inside it, so only the click needs stopping — and
      // it has to stop before `choose` runs, or acting on an option
      // would also select it.
      onClick={(event) => {
        event.stopPropagation();
        const run = action.onSelect;
        onCancel();
        run();
      }}
    >
      {action.icon}
    </button>
  );
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(length - 1, Math.max(0, index));
}
