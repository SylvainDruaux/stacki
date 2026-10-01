import React, { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import DataPicker from './DataPicker';
import type { DataPickerProps } from './DataPicker';
import { dataTree } from '../../editor/dataSuggest';
import type { DataContext } from '../../editor/dataSuggest';
import { resolvePick } from '../../editor/bindings';
import { deleteChipAtCaret } from './chipKeys';
import { ElementLinkIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { nodesToHtml, isChippable, domToNodes, isDOMElement } from './richContentModel';
import type { InlineNode } from './richContentModel';
export {
  INLINE_TAGS,
  isSimpleExpr,
  isInlineOnly,
  isChippable,
  nodesToHtml,
} from './richContentModel';
export type { InlineNode } from './richContentModel';

export interface RichContext extends DataContext {
  readonly entryNav?: DataPickerProps['entries'];
  readonly onStepItem?: DataPickerProps['onStepItem'];
  readonly onNeedSample?: (collection: string) => void;
  readonly ensureQuery?: (collection: string) => string | undefined;
}
export interface RichInsertAPI {
  readonly insert: (path: string) => void;
}
interface RichContentProps {
  readonly nodes: readonly InlineNode[];
  readonly onChange: (nodes: InlineNode[]) => void;
  readonly bindContext?: RichContext | undefined;
  readonly insertRef?: MutableRefObject<RichInsertAPI | undefined>;
}
interface Bubble {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}
interface BubblePosition {
  readonly left: number;
  readonly top: number;
  readonly below: boolean;
  readonly arrowX: number;
}
interface ChipMenu {
  readonly chip: Element;
  readonly left: number;
  readonly top: number;
  readonly current: string;
}
interface FormatState {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly superscript?: boolean;
  readonly subscript?: boolean;
  readonly code?: boolean;
  readonly span?: boolean;
  readonly link?: boolean;
}
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

export default function RichContent({ nodes, onChange, bindContext, insertRef }: RichContentProps) {
  const state = useRichState();
  const { hostRef } = state;
  const emit = () => richEmit(state, onChange);
  const { onChipMouseDown, pickExpr } = richChipActions(state, emit);
  useRichSync(nodes, state);
  useRichCaret(state);
  useRichInsertion(insertRef, state, emit);
  useRichSelection(state);
  useRichPosition(state);
  useRichChipDismiss(state);
  const onBlur = useRichBlur(state);
  return (
    <>
      <div
        ref={hostRef}
        className="rich-content"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={onBlur}
        onInput={emit}
        onMouseDown={onChipMouseDown}
        onKeyDown={(event) => {
          // Keep formatting shortcuts local; Enter inserts <br> (inline field).
          if (event.key === 'Enter') {
            event.preventDefault();
            document.execCommand('insertHTML', false, '<br>');
            emit();
            return;
          }
          // Backspace against a chip takes that chip, and only that chip —
          // not the sentence it sits in.
          if (deleteChipAtCaret(hostRef.current ?? undefined, event)) {
            event.preventDefault();
            emit();
          }
        }}
      />
      <RichChipMenu state={state} bindContext={bindContext} pickExpr={pickExpr} />
      <RichBubble state={state} emit={emit} />
    </>
  );
}

function useRichState() {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const lastEmittedRef = useRef<string | undefined>(undefined);
  const savedRangeRef = useRef<Range | undefined>(undefined);
  const [bubble, setBubble] = useState<Bubble | undefined>(undefined);
  const [position, setPosition] = useState<BubblePosition | undefined>(undefined);
  const [states, setStates] = useState<FormatState>({}); // {bold, italic, …} at the selection
  const [linkMode, setLinkMode] = useState(false);
  // The chip menu: {chip, left, top, current}.
  const [chipMenu, setChipMenu] = useState<ChipMenu | undefined>(undefined);
  const [linkUrl, setLinkUrl] = useState('');

  const caretRef = useRef<Range | undefined>(undefined);
  return {
    hostRef,
    bubbleRef,
    lastEmittedRef,
    savedRangeRef,
    caretRef,
    bubble,
    setBubble,
    pos: position,
    setPos: setPosition,
    states,
    setStates,
    linkMode,
    setLinkMode,
    chipMenu,
    setChipMenu,
    linkUrl,
    setLinkUrl,
  };
}

type RichState = ReturnType<typeof useRichState>;
function useRichSync(nodes: readonly InlineNode[], state: RichState) {
  const { hostRef, lastEmittedRef } = state;
  const html = nodesToHtml(nodes, isChippable);

  // Load / external updates. lastEmittedRef holds the canonical html of the
  // nodes this editor last emitted, so an incoming value that matches it is
  // just our own edit echoing back through the app — leave the DOM (and the
  // caret) alone. Anything else is a real external change: an undo, a file
  // reload, a chip switched from elsewhere. Keying this off document focus
  // instead used to drop those updates whenever the field happened to hold
  // focus, which is exactly when an undo arrives.
  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    if (html !== lastEmittedRef.current) {
      element.innerHTML = html;
      lastEmittedRef.current = html;
    }
  }, [html, hostRef, lastEmittedRef]);
}
function richEmit(state: RichState, onChange: RichContentProps['onChange']): void {
  const { hostRef, lastEmittedRef } = state;
  const element = hostRef.current;
  if (!element) {
    return;
  }
  let next = domToNodes(element);
  // Deleting the last character leaves a <br> behind: a contentEditable
  // needs one line for the caret to sit on, so the browser puts a
  // placeholder there. It isn't content, and writing it out means the
  // component still receives slot content — a heading emptied in the panel
  // would keep rendering, holding a line break. A lone <br> is that
  // placeholder and nothing else, so it clears to nothing.
  if (next.length === 1 && next[0]?.kind === 'element' && next[0].name === 'br') {
    next = [];
  }
  // Canonical, not el.innerHTML: the app hands the nodes back with ids
  // added and the browser normalises markup as you type, so only the
  // serialised form is comparable on the way back in.
  lastEmittedRef.current = nodesToHtml(next, isChippable);
  onChange(next);
}
// The wrapper of `tag` the whole selection sits inside, or null. Both ends
// are resolved down to the node they point AT, rather than reading
// sel.anchorNode: a range can select an element from its parent — start
// (parent, i), end (parent, i+1) — and that is exactly what surrounding the
// selection leaves behind, so asking the anchor (the parent) whether it is
// inside `tag` answers no about the tag it just made.
function richTagAround(host: HTMLElement | undefined, tag: string): Element | undefined {
  const selection = window.getSelection();
  if (!host || !selection || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  const at = (container: Node, offset: number) => {
    const node = container.nodeType === 1 ? container.childNodes[offset] || container : container;
    const element = isDOMElement(node) ? node : node.parentElement;
    return element ? element.closest(tag) : undefined;
  };
  // The end boundary points just PAST its node, so step back one.
  const start = at(range.startContainer, range.startOffset);
  const end = at(range.endContainer, range.endOffset - (range.endContainer.nodeType === 1 ? 1 : 0));
  const element = start && start === end ? start : undefined;
  return element && host.contains(element) && element !== host ? element : undefined;
}
// Formatting state at the current selection, for highlighting buttons.
function richReadStates(host: HTMLElement | undefined): FormatState {
  const inTag = (tag: string) => !!richTagAround(host, tag);
  let states: FormatState = {};
  try {
    states = {
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      superscript: document.queryCommandState('superscript'),
      subscript: document.queryCommandState('subscript'),
    };
  } catch {
    states = {};
  }
  return { ...states, code: inTag('code'), span: inTag('span'), link: inTag('a') };
}
function useRichCaret(state: RichState): void {
  const { hostRef, caretRef } = state;
  // Where the caret is, saved whenever it is inside the editor. The bubble
  // below only tracks real selections; inserting data needs the collapsed
  // caret too, and by the time the picker is open focus has left the editor.

  useEffect(() => {
    const onSelectionChange = () => {
      const element = hostRef.current;
      const selection = window.getSelection();
      if (!element || !selection?.rangeCount) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (element.contains(range.commonAncestorContainer)) {
        caretRef.current = range.cloneRange();
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [hostRef, caretRef]);
}
function useRichInsertion(
  insertRef: RichContentProps['insertRef'],
  state: RichState,
  emit: () => void,
) {
  const { hostRef, caretRef } = state;
  // Dropping data in from outside — the Content field's own insert button.
  useEffect(() => {
    if (!insertRef) {
      return undefined;
    }
    insertRef.current = {
      insert(path: string) {
        const element = hostRef.current;
        if (!element) {
          return;
        }
        element.focus();
        const selection = window.getSelection();
        const saved = caretRef.current;
        const range = document.createRange();
        if (saved && element.contains(saved.commonAncestorContainer)) {
          range.setStart(saved.startContainer, saved.startOffset);
          range.setEnd(saved.endContainer, saved.endOffset);
        } else {
          range.selectNodeContents(element);
          range.collapse(false);
        }
        if (!selection) {
          return;
        }
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand(
          'insertHTML',
          false,
          `<span class="expr-chip" contenteditable="false" data-expr="{${path}}">${path}</span>`,
        );
        emit();
      },
    };
    return () => {
      insertRef.current = undefined;
    };
  });
}
function useRichSelection(state: RichState): void {
  const { linkMode, hostRef, savedRangeRef, setBubble, setStates } = state;
  // Selection bubble: track selections anchored inside the editor.
  useEffect(() => {
    const onSelectionChange = () => {
      if (linkMode) {
        return;
      } // keep the bubble while typing a URL
      const element = hostRef.current;
      const selection = window.getSelection();
      if (
        !element ||
        !selection ||
        selection.rangeCount === 0 ||
        selection.isCollapsed ||
        !element.contains(selection.anchorNode) ||
        !element.contains(selection.focusNode)
      ) {
        setBubble(undefined);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setBubble(undefined);
        return;
      }
      savedRangeRef.current = selection.getRangeAt(0).cloneRange();
      setBubble({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
      setStates(richReadStates(hostRef.current ?? undefined));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [hostRef, savedRangeRef, linkMode, setBubble, setStates]);
}
function useRichPosition(state: RichState): void {
  const { bubbleRef, bubble, linkMode, setPos: setPosition } = state;
  // Measure the rendered bubble and keep it inside the window: clamp
  // horizontally, flip below the selection when it would hit the titlebar,
  // and keep the arrow pointing at the selection midpoint.
  React.useLayoutEffect(() => {
    const element = bubbleRef.current;
    if (!bubble || !element) {
      setPosition(undefined);
      return;
    }
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const margin = 8;
    const left = clamp(bubble.x, margin + width / 2, window.innerWidth - margin - width / 2);
    const below = bubble.top - height - 10 < 48;
    const top = below ? bubble.bottom + 10 : bubble.top - 10;
    const arrowX = clamp(bubble.x - (left - width / 2), 12, width - 12);
    setPosition({ left, top, below, arrowX });
  }, [bubble, linkMode, bubbleRef, setPosition]);
}
// Snapshot the live selection as the range the next press restores.
// Every action below re-reads it rather than leaving that to the
// `selectionchange` listener, because that event is fired from a queued
// task: a second press landing in the same task would otherwise act on the
// range from before the first one, which by then has been dragged along by
// the DOM edit and no longer means what it did. That is how pressing Code
// twice quickly used to nest a <code> inside a <code>.
function richSaveSelection(state: RichState): void {
  const { hostRef, savedRangeRef } = state;
  const host = hostRef.current;
  const selection = window.getSelection();
  if (!host || !selection || selection.rangeCount === 0) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (host.contains(range.commonAncestorContainer)) {
    savedRangeRef.current = range.cloneRange();
  }
}
function richRestoreSelection(state: RichState): void {
  const { savedRangeRef } = state;
  const range = savedRangeRef.current;
  if (!range) {
    return;
  }
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  // A clone: addRange can adopt the very range it is handed, and then
  // surroundContents below would rewrite the saved one as a side effect.
  selection.addRange(range.cloneRange());
}
function richExec(state: RichState, command: string, emit: () => void): void {
  state.hostRef.current?.focus();
  richRestoreSelection(state);
  document.execCommand(command, false);
  emit();
  richSaveSelection(state);
  state.setStates(richReadStates(state.hostRef.current ?? undefined));
}
// Take the selection out of the nearest `tag` around it, leaving its text
// where it was. The button is a toggle — pressing one that is already lit has
// to turn it off, and for a <span> that is the only way back: a span with no
// attributes on it yet is invisible, so one added by mistake could otherwise
// only be removed by editing the file.
function richUnwrapTag(state: RichState, tag: string): boolean {
  const selection = window.getSelection();
  const element = richTagAround(state.hostRef.current ?? undefined, tag);
  if (!element) {
    return false;
  }
  const parent = element.parentNode;
  assert(parent !== null, 'RichContent: inline wrapper has a parent');
  const first = element.firstChild;
  const last = element.lastChild;
  assert(
    element.childNodes.length <= LIMITS.treeNodesMax,
    'RichContent: unwrap child limit exceeded',
  );
  for (const child of Array.from(element.childNodes)) {
    parent.insertBefore(child, element);
  }
  parent.removeChild(element);
  // Keep the text selected, so the bubble stays up and the next press acts on
  // the same words.
  if (first && last) {
    const wrappedRange = document.createRange();
    wrappedRange.setStartBefore(first);
    wrappedRange.setEndAfter(last);
    selection?.removeAllRanges();
    selection?.addRange(wrappedRange);
  }
  return true;
}
// No execCommand for <code> or <span> — wrap the selection manually.
function richWrapTag(state: RichState, tag: string, emit: () => void): void {
  state.hostRef.current?.focus();
  richRestoreSelection(state);
  // Already inside one: the press means "stop".
  if (richUnwrapTag(state, tag)) {
    emit();
    richSaveSelection(state);
    state.setStates(richReadStates(state.hostRef.current ?? undefined));
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return;
  }
  const range = selection.getRangeAt(0);
  const element = document.createElement(tag);
  try {
    range.surroundContents(element);
  } catch {
    // Selection crosses element boundaries — extract and rewrap.
    element.appendChild(range.extractContents());
    range.insertNode(element);
  }
  selection.removeAllRanges();
  const contentsRange = document.createRange();
  contentsRange.selectNodeContents(element);
  selection.addRange(contentsRange);
  emit();
  richSaveSelection(state);
  state.setStates(richReadStates(state.hostRef.current ?? undefined));
}
function richApplyLink(state: RichState, emit: () => void): void {
  const { linkUrl, setLinkMode, setLinkUrl, hostRef, setStates } = state;
  const url = linkUrl.trim();
  setLinkMode(false);
  setLinkUrl('');
  if (!url) {
    return;
  }
  hostRef.current?.focus();
  richRestoreSelection(state);
  document.execCommand('createLink', false, url);
  emit();
  richSaveSelection(state);
  setStates(richReadStates(hostRef.current ?? undefined));
}
// Buttons use onMouseDown+preventDefault so the text selection survives.
const richButton = (
  label: React.ReactNode,
  title: string,
  { active }: { readonly active: boolean | undefined },
  onAct: () => void,
) => (
  <button
    key={title}
    type="button"
    className={active ? 'on' : ''}
    title={title}
    onMouseDown={(event) => {
      event.preventDefault();
      onAct();
    }}
  >
    {label}
  </button>
);

function richChipActions(state: RichState, emit: () => void) {
  const { chipMenu, setChipMenu } = state;
  // Clicking a chip offers the other values in scope. mousedown rather than
  // click, and preventDefault, so the caret never lands inside the chip.
  const onChipMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const ElementType = event.currentTarget.ownerDocument.defaultView?.Element;
    const chip =
      ElementType && event.target instanceof ElementType
        ? event.target.closest('.expr-chip')
        : undefined;
    if (!chip) {
      return;
    }
    event.preventDefault();
    const rect = chip.getBoundingClientRect();
    setChipMenu({
      chip,
      left: rect.left,
      top: rect.bottom + 4,
      current: (chip.getAttribute('data-expr') || '').replace(/^\{|\}$/g, ''),
    });
  };

  const pickExpr = (insert: string) => {
    const chip = chipMenu?.chip;
    setChipMenu(undefined);
    if (!chip) {
      return;
    }
    chip.setAttribute('data-expr', '{' + insert + '}');
    chip.textContent = insert;
    emit();
  };

  return { onChipMouseDown, pickExpr };
}
function useRichChipDismiss(state: RichState): void {
  const { chipMenu, setChipMenu } = state;
  useEffect(() => {
    if (!chipMenu) {
      return;
    }
    const close = (event: MouseEvent) => {
      // Chips are excluded, not just the menu: React flushes this effect
      // synchronously for a discrete event, so the listener is live while the
      // very mousedown that opened the menu is still propagating to document.
      // Without the exclusion the menu closes on the click that opened it —
      // and clicking straight from one chip to another would too.
      const ElementType = chipMenu.chip.ownerDocument.defaultView?.Element;
      if (ElementType && event.target instanceof ElementType) {
        if (event.target.closest('.bind-menu, .expr-chip')) {
          return;
        }
      }
      setChipMenu(undefined);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setChipMenu(undefined);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [chipMenu, setChipMenu]);
}
function RichChipMenu({
  state,
  bindContext,
  pickExpr,
}: {
  readonly state: RichState;
  readonly bindContext: RichContext | undefined;
  readonly pickExpr: (path: string) => void;
}) {
  const { chipMenu } = state;
  if (!chipMenu) {
    return undefined;
  }
  return (
    <div
      className="dd-popup bind-menu"
      style={{ left: chipMenu.left, top: chipMenu.top, width: 260 }}
    >
      <DataPicker
        tree={dataTree(bindContext || {})}
        current={chipMenu.current}
        entries={bindContext?.entryNav ?? undefined}
        {...(bindContext?.onStepItem ? { onStepItem: bindContext.onStepItem } : {})}
        onPick={(path, query) =>
          pickExpr(resolvePick(path, query ?? undefined, bindContext ?? undefined))
        }
        onExpand={(node) => node.query && bindContext?.onNeedSample?.(node.query.collection)}
        footer={false}
      />
    </div>
  );
}
type BubbleStyle = React.CSSProperties & { readonly '--arrow-x': string };
function RichBubble({ state, emit }: { readonly state: RichState; readonly emit: () => void }) {
  const { bubble, bubbleRef, pos: position, linkMode } = state;
  if (!bubble) {
    return undefined;
  }
  const style: BubbleStyle = {
    left: position ? position.left : bubble.x,
    top: position ? position.top : bubble.top - 10,
    visibility: position ? 'visible' : 'hidden',
    '--arrow-x': position ? `${position.arrowX}px` : '50%',
  };
  return (
    <div
      ref={bubbleRef}
      className={`rich-bubble ${position?.below ? 'below' : ''}`}
      style={style}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {linkMode ? (
        <RichLinkInput state={state} emit={emit} />
      ) : (
        <RichButtons state={state} emit={emit} />
      )}
    </div>
  );
}
function RichLinkInput({ state, emit }: { readonly state: RichState; readonly emit: () => void }) {
  const { linkUrl, setLinkUrl, setLinkMode } = state;
  const applyLink = () => richApplyLink(state, emit);
  return (
    <input
      autoFocus
      className="rich-bubble-url"
      placeholder="https://…  (Enter to apply)"
      value={linkUrl}
      onChange={(event) => setLinkUrl(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          applyLink();
        }
        if (event.key === 'Escape') {
          setLinkMode(false);
          setLinkUrl('');
        }
      }}
    />
  );
}
function RichButtons({ state, emit }: { readonly state: RichState; readonly emit: () => void }) {
  const { states, setLinkMode } = state;
  const exec = (command: string) => richExec(state, command, emit);
  const wrapTag = (tag: string) => richWrapTag(state, tag, emit);
  const button = (
    label: React.ReactNode,
    title: string,
    status: { readonly active: boolean | undefined },
    onAct: () => void,
  ) => richButton(label, title, status, onAct);
  return (
    <>
      {button(<b>B</b>, 'Bold', { active: states.bold }, () => exec('bold'))}
      {button(<i>I</i>, 'Italic', { active: states.italic }, () => exec('italic'))}
      {button(
        <span>
          X<sup>2</sup>
        </span>,
        'Superscript',
        { active: states.superscript },
        () => exec('superscript'),
      )}
      {button(
        <span>
          X<sub>2</sub>
        </span>,
        'Subscript',
        { active: states.subscript },
        () => exec('subscript'),
      )}
      {button(<span className="mono">{'</>'}</span>, 'Code', { active: states.code }, () =>
        wrapTag('code'),
      )}
      {/* A span is the hook for everything else: wrap some words, then
                  give that node a class and style it like any other. Nothing is
                  written on it here — an empty span IS the useful result. */}
      {button(<span className="mono">span</span>, 'Wrap in a span', { active: states.span }, () =>
        wrapTag('span'),
      )}
      {/* The app's own link icon, not the emoji: an emoji is drawn by
                  the system in its own colours and at its own weight, so it sat
                  in this row as the one thing that hadn't been designed. */}
      {button(<ElementLinkIcon size={14} />, 'Link', { active: states.link }, () =>
        setLinkMode(true),
      )}
    </>
  );
}
function useRichBlur(state: RichState): () => void {
  const { linkMode, setBubble } = state;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
    },
    [],
  );
  return () => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setBubble((bubble) => (linkMode ? bubble : undefined));
    }, 150);
  };
}
