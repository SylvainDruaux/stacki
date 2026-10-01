import React, { useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Completion } from '@codemirror/autocomplete';
import type { Attr } from '../../../shared/page-node';
import type { FieldDefinition } from './propRules';
import type { TemplateHole } from '../../editor/bindings';
import type { RichContext } from './RichContent';
import type { BindInputHandle } from './BindInput';
import type { ChipsOf, ExprInputAPI } from '../../ui/ExprInput';
import type { PickerNode } from './DataPicker';
import { assert } from '../../../shared/assert';
import { LIMITS } from '../../../shared/limits';
import { definedFields } from '../../../shared/boundary';
import {
  dataTree,
  findDeclaration,
  findImportOf,
  scopeChips,
  scopeCompletions,
} from '../../editor/dataSuggest';
import {
  partsFromValue,
  resolvePick,
  templateHoles,
  valueFromParts,
  valueModeOf,
} from '../../editor/bindings';
import { checkStatement } from './jsCheck';
import BindInput from './BindInput';
import DataPicker from './DataPicker';
import ExprInput from '../../ui/ExprInput';
import { CodeIcon, CloseIcon, PencilIcon, PlusIcon } from '../../ui/Icons';

export interface FieldPosition {
  readonly left: number;
  readonly top: number;
  readonly width?: number;
}
export interface SourceContext {
  readonly frontmatter?: string | undefined;
  readonly imports?: unknown;
  readonly onSetFrontmatter?: ((source: string) => void) | undefined;
  readonly onOpenSymbol?: ((name: string) => void) | undefined;
}
export type ValueChange = (value: Attr | undefined, immediate?: boolean) => void;
export interface InsertAPI {
  readonly insert: (path: string) => void;
}
type Chip = Element | TemplateHole;
interface ChipPick {
  readonly chip: TemplateHole | undefined;
  readonly pos: FieldPosition;
}
interface BindingContextProps {
  readonly bindContext?: RichContext | undefined;
  readonly dataContext?: SourceContext | undefined;
}
interface SourceEditButtonProps {
  readonly name: string;
  readonly dataContext?: SourceContext | undefined;
  readonly anchorRef?: RefObject<HTMLElement>;
  readonly className?: string;
}
interface ExprValueFieldProps extends BindingContextProps {
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly onChange: ValueChange;
}
interface ConditionFieldProps extends BindingContextProps {
  readonly test: string;
  readonly scope: readonly Completion[];
  readonly chipsOf: ChipsOf;
  readonly onSetText: (value: string) => void;
}
interface ExpressionBindingFieldProps extends BindingContextProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}
interface BindHandleProps {
  readonly active: boolean;
  readonly onOpen: (host: Element | undefined) => void;
}
interface FieldDataPickerProps extends BindingContextProps {
  readonly pos: FieldPosition;
  readonly current?: string | undefined;
  readonly tree?: readonly PickerNode[] | undefined;
  readonly onPick: (path: string) => void;
  readonly onWrite?: (() => void) | undefined;
  readonly onClose: () => void;
}
interface BindFieldProps extends BindingContextProps {
  readonly value?: Attr | undefined;
  readonly field?: FieldDefinition;
  readonly placeholder?: string | undefined;
  readonly wrapCode?: boolean;
  readonly apiRef?: MutableRefObject<InsertAPI | undefined>;
  readonly onChange: ValueChange;
}
interface ValueCodeEditorProps extends BindingContextProps {
  readonly pos: FieldPosition;
  readonly name: string;
  readonly value: string;
  readonly scope: readonly Completion[];
  readonly chipsOf: ChipsOf;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
}
interface VarSourceEditorProps {
  readonly pos: FieldPosition;
  readonly name: string;
  readonly code: string;
  readonly onChangeCode?: ((source: string) => void) | undefined;
  readonly onClose: () => void;
}

export function referencedName(expr: unknown) {
  const match = String(expr ?? '')
    .trim()
    .match(/^([A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/);
  return match?.[1] ?? '';
}

function symbolTarget(name: string, dataContext: SourceContext | undefined) {
  if (!name || !dataContext) {
    return undefined;
  }
  if (dataContext?.onSetFrontmatter && findDeclaration(dataContext?.frontmatter || '', name)) {
    return 'local';
  }
  if (dataContext.onOpenSymbol && findImportOf(dataContext.imports || '', name)) {
    return 'file';
  }
  return undefined;
}

export function SourceEditButton({
  name,
  dataContext,
  anchorRef,
  className = 'attr-asset-toggle',
}: SourceEditButtonProps) {
  const [position, setPosition] = useState<FieldPosition | undefined>(undefined);
  const target = symbolTarget(name, dataContext);
  if (!target) {
    return undefined;
  }

  const open = () => {
    if (target === 'file') {
      dataContext?.onOpenSymbol?.(name);
      return;
    }
    const rect = anchorRef?.current?.getBoundingClientRect();
    const width = Math.max(rect?.width ?? 240, 260);
    setPosition({
      top: Math.min((rect?.bottom ?? 200) + 6, Math.max(60, window.innerHeight - 240)),
      left: Math.min(rect?.left ?? 0, window.innerWidth - width - 12),
      width,
    });
  };

  return (
    <>
      <button
        className={`${className} ${position ? 'on' : ''}`}
        title={target === 'file' ? `Open where ${name} is defined` : `Edit ${name}`}
        onClick={() => (position ? setPosition(undefined) : open())}
      >
        <PencilIcon size={12} />
      </button>
      {position && (
        <VarSourceEditor
          pos={position}
          name={name}
          code={dataContext?.frontmatter || ''}
          onChangeCode={dataContext?.onSetFrontmatter}
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}

export function ExprValueField({ value, placeholder, dataContext, onChange }: ExprValueFieldProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const name = referencedName(value);

  return (
    <div className="prop-expr-row" ref={wrapRef}>
      <ExprInput
        value={value}
        syncValue={value}
        // Empty when nothing is known, like every other field. The old
        // generic "expression" described the input format, not the fallback,
        // and in a column of placeholders that all name real values it read as
        // if the value itself were the word.
        placeholder={placeholder || ''}
        onChange={(draft) => onChange({ type: 'expr', value: draft })}
        onCommit={(committed) =>
          committed !== value && onChange({ type: 'expr', value: committed }, true)
        }
      />
      <SourceEditButton name={name} dataContext={dataContext} anchorRef={wrapRef} />
    </div>
  );
}

export function ConditionField({
  test,
  scope,
  chipsOf,
  bindContext,
  onSetText,
}: ConditionFieldProps) {
  const [pick, setPick] = useState<ChipPick | undefined>(undefined); // {chip, pos}
  const apiRef = useRef<ExprInputAPI | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);

  const open = (chip: TemplateHole | undefined) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPick({
      chip: chip || undefined,
      pos: {
        left: rect.left,
        top: Math.min(rect.bottom + 4, Math.max(60, window.innerHeight - 340)),
        width: Math.max(rect.width, 240),
      },
    });
  };

  return (
    <>
      <div className="props-cond-field attr-value-field" ref={wrapRef}>
        <ExprInput
          value={test}
          syncValue={test}
          placeholder="e.g. logo.src"
          completions={scope}
          apiRef={apiRef}
          // The values a condition names, drawn as the same purple chips the rest
          // of the panel shows data in — and pressing one opens the list to swap
          // it, rather than retyping a name inside a boolean.
          chipsOf={chipsOf}
          onChipClick={(chip) => open(chip)}
          onCommit={(committed) =>
            committed.trim() && committed !== test && onSetText(committed.trim())
          }
        />
        {/* And the way a new one gets in: the same purple dot every bindable field
            has, inserting at the caret. */}
        <BindHandle active={!!pick} onOpen={() => (pick ? setPick(undefined) : open(undefined))} />
      </div>
      {pick ? (
        <FieldDataPicker
          pos={pick.pos}
          bindContext={bindContext}
          current={pick.chip?.path ?? undefined}
          onPick={(path) => {
            const chip = pick.chip;
            setPick(undefined);
            const next = chip
              ? apiRef.current?.replaceRange(chip.from, chip.to, path)
              : apiRef.current?.insert(path);
            if (next !== undefined) {
              onSetText(next);
            }
          }}
          onClose={() => setPick(undefined)}
        />
      ) : undefined}
    </>
  );
}

export function ExpressionBindingField({
  value,
  placeholder,
  bindContext,
  onChange,
}: ExpressionBindingFieldProps) {
  const [pick, setPick] = useState<ChipPick | undefined>(undefined);
  const apiRef = useRef<ExprInputAPI | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scope = scopeCompletions(bindContext || {});
  const scopeNames = new Set(scope.map((item) => item.label.split('.')[0] ?? ''));
  const chipsOf = (text: string) => scopeChips(text, scopeNames);
  const open = (chip: TemplateHole | undefined): void => {
    const rectangle = wrapRef.current?.getBoundingClientRect();
    if (!rectangle) {
      return;
    }
    setPick({
      chip,
      pos: {
        left: rectangle.left,
        top: Math.min(rectangle.bottom + 4, Math.max(60, window.innerHeight - 340)),
        width: Math.max(rectangle.width, 240),
      },
    });
  };
  return (
    <>
      <div className="property-expression-binding attr-value-field" ref={wrapRef}>
        <ExprInput
          value={value}
          syncValue={value}
          {...definedFields({ placeholder })}
          multiline
          wrap={false}
          completions={scope}
          apiRef={apiRef}
          chipsOf={chipsOf}
          onChipClick={open}
          onChange={onChange}
        />
        <BindHandle active={!!pick} onOpen={() => (pick ? setPick(undefined) : open(undefined))} />
      </div>
      {pick ? (
        <FieldDataPicker
          pos={pick.pos}
          bindContext={bindContext}
          current={pick.chip?.path ?? undefined}
          onPick={(path) => {
            const chip = pick.chip;
            setPick(undefined);
            if (chip) {
              apiRef.current?.replaceRange(chip.from, chip.to, path);
            } else {
              apiRef.current?.insert(path);
            }
          }}
          onClose={() => setPick(undefined)}
        />
      ) : undefined}
    </>
  );
}

export function BindHandle({ active, onOpen }: BindHandleProps) {
  return (
    <button
      type="button"
      className={`bind-handle${active ? ' on' : ''}`}
      title="Insert data — a component prop, a CMS field"
      aria-label="Insert data"
      onClick={(event) => onOpen(event.currentTarget.closest('.props-field') ?? undefined)}
    >
      <span className="bind-dot" />
      <PlusIcon size={10} className="bind-plus" />
    </button>
  );
}

export function FieldDataPicker({
  pos: position,
  bindContext,
  current,
  tree,
  onPick,
  onWrite,
  onClose,
}: FieldDataPickerProps) {
  const pick = (path: string, query: PickerNode['query'] | undefined) =>
    onPick(resolvePick(path, query ?? undefined, bindContext ?? undefined));
  useEffect(() => {
    const close = (event: MouseEvent) => {
      // The thing that opened it is not "outside": letting the mousedown close
      // it would leave the click that follows to open it straight back up.
      //
      // A chip is in that list because it opens the picker ON MOUSEDOWN — the
      // caret must not land inside a name — and React flushes this effect
      // synchronously for a discrete event, so the listener below is live
      // while the very mousedown that opened the picker is still on its way up
      // to document. Without the chip here, pressing it opened the picker and
      // closed it again before the button came back up, which looked like a
      // chip that did nothing at all. Clicking it again still closes, through
      // the same toggle that opened it.
      if (eventElement(event.target)?.closest('.bind-menu, .bind-handle, .dd-source, .cm-chip')) {
        return;
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    const onScroll = (event: Event) => {
      if (eventElement(event.target)?.closest('.bind-menu')) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      className="dd-popup bind-menu"
      style={{ left: position.left, top: position.top, width: position.width }}
    >
      <DataPicker
        tree={tree || dataTree(bindContext || {})}
        current={current ?? undefined}
        entries={bindContext?.entryNav ?? undefined}
        {...definedFields({ onStepItem: bindContext?.onStepItem })}
        onPick={pick}
        onExpand={(node) => node.query && bindContext?.onNeedSample?.(node.query.collection)}
        {...definedFields({ onWrite })}
        footer={!!onWrite}
      />
    </div>
  );
}

function chipExpr(chip: Chip | undefined) {
  if (!chip) {
    return '';
  }
  if ('path' in chip) {
    return chip.path;
  }
  if ('getAttribute' in chip) {
    return chip.getAttribute('data-expr') || '';
  }
  return '';
}

function chipPath(chip: Chip | undefined) {
  if (chip && 'getAttribute' in chip) {
    return chip.getAttribute('data-full') || chip.getAttribute('data-expr') || '';
  }
  return chipExpr(chip);
}

export function BindField(props: BindFieldProps) {
  const state = useBindFieldModel(props);
  const actions = useBindFieldActions(state);
  useBindFieldDismiss(state);
  useBindFieldAPI(state);
  return <BindFieldView state={{ ...state, ...actions }} />;
}
function useBindFieldModel(props: BindFieldProps) {
  const { value, field, bindContext } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<BindInputHandle>(null);
  const [menu, setMenu] = useState<
    (FieldPosition & { readonly chip: Chip | undefined }) | undefined
  >(undefined);
  // Editing a `const` from this file happens right under the field, the way the
  // pencil used to open it — it is the menu that asks for it now.
  const [source, setSource] = useState<(FieldPosition & { readonly name: string }) | undefined>(
    undefined,
  );
  // The code editor, so a chip pressed inside it can be repointed in place.
  const exprApiRef = useRef<ExprInputAPI | undefined>(undefined);
  const [raw, setRaw] = useState(false);
  // What the code editor draws as chips: every `${…}` hole naming a path, plus
  // every value in scope the code names outright.
  const scopeNames = new Set(
    scopeCompletions(bindContext || {}).map((completion) => completion.label.split('.')[0] ?? ''),
  );
  const codeChips = (text: string) => {
    const holes = templateHoles(text);
    const taken = (from: number, to: number) =>
      holes.some((hole) => from < hole.to && to > hole.from);
    return [
      ...holes,
      ...scopeChips(text, scopeNames).filter((chip) => !taken(chip.from, chip.to)),
    ].sort((left, right) => left.from - right.from);
  };
  // Typing must not move the field out from under the caret: an expression
  // half-way to becoming a call reads as code the moment the bracket lands,
  // and swapping in the code editor mid-word would take the text with it.
  const [editing, setEditing] = useState(false);
  const text = value && value.type !== 'bare' ? value.value : '';
  assert(text.length <= LIMITS.attrCharsMax, 'BindField: value limit exceeded');
  const parts = partsFromValue(value ?? undefined);
  assert((parts?.length ?? 0) <= LIMITS.attrCharsMax, 'BindField: parts limit exceeded');
  const expr = value?.type === 'expr' ? String(value.value ?? '').trim() : '';
  // Code no field of chips and text can hold keeps the code editor.
  const showInput = !raw && (parts !== undefined || editing);
  // What the parts mean when they are written back — content, or an
  // expression with data in it. The value decides, so a field never changes
  // the meaning of what it was opened on.
  const mode = valueModeOf(value ?? undefined);
  // Written as an expression rather than as text. Booleans and numbers are the
  // obvious ones — `cols={3}` — and a prop that takes an array or an object is
  // the same thing: typing `["Designer", "Developer"]` into it has to write
  // `options={["Designer", "Developer"]}`, not `options="[\"Designer\", …]"`,
  // which is a string the component then calls .map on. It also cost the field
  // its own editor: a string is text, so the panel showed the array in a plain
  // box with no highlighting, and there was no way to type one that stayed code.
  const numeric = !!(
    field?.type === 'number' ||
    field?.type === 'boolean' ||
    field?.type === 'code' ||
    (field?.type === 'enum' && field?.numeric)
  );

  return {
    ...props,
    wrapRef,
    inputRef,
    menu,
    setMenu,
    source,
    setSource,
    exprApiRef,
    setRaw,
    codeChips,
    setEditing,
    parts,
    expr,
    showInput,
    mode,
    numeric,
  };
}
type BindingState = ReturnType<typeof useBindFieldModel>;
function useBindFieldActions(state: BindingState) {
  const {
    menu,
    wrapRef,
    setMenu,
    dataContext,
    setSource,
    bindContext,
    showInput,
    exprApiRef,
    onChange,
    setRaw,
    inputRef,
  } = state;
  const open = (chip: Chip | undefined) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setMenu({
      left: rect.left,
      // Below the field, or above it when the field sits near the bottom of
      // the panel — the popup is fixed, so it would otherwise run off-screen.
      top: Math.min(rect.bottom + 4, Math.max(60, window.innerHeight - 340)),
      width: Math.max(rect.width, 240),
      chip: chip || undefined,
    });
  };

  // What the menu's Edit row does, for the chip it was opened on. Null when the
  // menu wasn't opened on a chip, or when nothing in reach defines that name —
  // and then the row isn't drawn at all, rather than drawn and inert.
  const editName = referencedName(chipExpr(menu?.chip));
  const editTarget = symbolTarget(editName, dataContext);
  const editChip = () => {
    setMenu(undefined);
    if (editTarget === 'file') {
      dataContext?.onOpenSymbol?.(editName);
      return;
    }
    const rect = wrapRef.current?.getBoundingClientRect();
    const width = Math.max(rect?.width ?? 240, 260);
    setSource({
      name: editName,
      top: Math.min((rect?.bottom ?? 200) + 6, Math.max(60, window.innerHeight - 240)),
      left: Math.min(rect?.left ?? 0, window.innerWidth - width - 12),
      width,
    });
  };

  const pick = (rawPath: string, query: PickerNode['query'] | undefined) => {
    const chip = menu?.chip;
    const path = resolvePick(rawPath, query ?? undefined, bindContext ?? undefined);
    setMenu(undefined);
    if (!showInput) {
      // A hole in the code was pressed: repoint THAT hole and leave the program
      // around it alone. Replacing the whole expression — which is what a pick
      // used to do, since the code editor holds one — would throw away the
      // ternary the hole was written inside.
      if (chip && 'from' in chip) {
        const next = exprApiRef.current?.replaceRange(chip.from, chip.to, `\${${path}}`);
        if (next !== undefined) {
          onChange({ type: 'expr', value: next }, true);
        }
        return;
      }
      // The code editor holds one expression, so a pick replaces it.
      setRaw(false);
      onChange({ type: 'expr', value: path }, true);
      return;
    }
    if (chip && 'getAttribute' in chip) {
      inputRef.current?.replace(chip, path);
    } else {
      inputRef.current?.insert(path);
    }
  };

  return { open, editName, editTarget, editChip, pick };
}
function useBindFieldDismiss({ menu, setMenu, wrapRef }: BindingState) {
  useEffect(() => {
    if (!menu) {
      return undefined;
    }
    const close = (event: MouseEvent) => {
      if (eventElement(event.target)?.closest('.bind-menu, .bind-pick')) {
        return;
      }
      // `.cm-chip` for the same reason as the rest: a chip opens this picker on
      // mousedown, and this listener is live before that mousedown has finished
      // reaching document — so a chip missing from the list opens the picker and
      // closes it in the one press. Only a chip in THIS field, though: pressing
      // one somewhere else is how you move on, and leaving both open left two
      // pickers over the panel, one of them about a value nobody was looking at.
      const chip = eventElement(event.target)?.closest('.expr-chip, .cm-chip');
      if (chip && wrapRef.current?.contains(chip)) {
        return;
      }
      setMenu(undefined);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setMenu(undefined);
    const onScroll = (event: Event) => {
      // The list scrolls inside itself; the panel behind it moves the field
      // out from under it, so that one closes it.
      if (eventElement(event.target)?.closest('.bind-menu')) {
        return;
      }
      setMenu(undefined);
    };
    const onResize = () => setMenu(undefined);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [menu, setMenu, wrapRef]);
}
function useBindFieldAPI({ apiRef, showInput, inputRef }: BindingState) {
  // The field's handle inserts through here, so one picker serves both the
  // chip already in the field and the next one. Null while the code editor is
  // up: that holds one expression, so a pick replaces it instead.
  useEffect(() => {
    if (!apiRef) {
      return undefined;
    }
    apiRef.current = showInput ? { insert: (path) => inputRef.current?.insert(path) } : undefined;
    return () => {
      apiRef.current = undefined;
    };
  });
}
type BindingViewState = BindingState & ReturnType<typeof useBindFieldActions>;
function BindFieldMenu({ state }: { readonly state: BindingViewState }) {
  const {
    menu,
    bindContext,
    showInput,
    expr,
    pick,
    editTarget,
    editChip,
    editName,
    setMenu,
    setRaw,
  } = state;
  return (
    menu && (
      <div
        className="dd-popup bind-menu"
        style={{ left: menu.left, top: menu.top, width: menu.width }}
      >
        {/* Built on every render rather than captured when the popup opened:
          stepping to another entry from inside it changes what the data IS,
          and a snapshot would go on showing the entry you stepped away from. */}
        <DataPicker
          tree={dataTree(bindContext || {})}
          current={menu.chip ? chipPath(menu.chip) : showInput ? undefined : expr}
          entries={bindContext?.entryNav ?? undefined}
          {...definedFields({ onStepItem: bindContext?.onStepItem })}
          onPick={pick}
          onExpand={(node) => node.query && bindContext?.onNeedSample?.(node.query.collection)}
          onEdit={editTarget ? editChip : undefined}
          editLabel={
            editTarget === 'file' ? `Open where ${editName} is defined` : `Edit ${editName}`
          }
          onWrite={() => {
            setMenu(undefined);
            setRaw(true);
          }}
        />
      </div>
    )
  );
}
function BindFieldSource({ state }: { readonly state: BindingState }) {
  const { source, dataContext, setSource } = state;
  return (
    source && (
      <VarSourceEditor
        pos={source}
        name={source.name}
        code={dataContext?.frontmatter || ''}
        onChangeCode={dataContext?.onSetFrontmatter}
        onClose={() => setSource(undefined)}
      />
    )
  );
}
function BindFieldView({ state }: { readonly state: BindingViewState }) {
  const {
    showInput,
    wrapRef,
    inputRef,
    parts,
    placeholder,
    onChange,
    numeric,
    field,
    mode,
    open,
    setEditing,
    expr,
    exprApiRef,
    codeChips,
    wrapCode,
  } = state;
  const list = <BindFieldMenu state={state} />;
  const sourceEditor = <BindFieldSource state={state} />;
  if (showInput) {
    return (
      <div className="prop-expr-row bind-row" ref={wrapRef}>
        <BindInput
          ref={inputRef}
          parts={parts}
          placeholder={placeholder || 'Type, or insert data'}
          // A code prop's parts join as code: text beside a chip is an
          // expression with a value in it, not a sentence with one quoted into
          // it, so `[...items, other]` stays what was typed.
          onChange={(next) =>
            onChange(
              valueFromParts(next, { numeric, mode: field?.type === 'code' ? 'code' : mode }),
            )
          }
          onChipClick={(chip) => open(chip)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
        />
        {list}
        {sourceEditor}
      </div>
    );
  }

  return (
    <div className="prop-expr-row" ref={wrapRef}>
      {/* Code, with the data in it still shown as data: an expression this
          field can't hold as chips and text — a ternary, a template, a call —
          keeps the editor, and every `${…}` hole naming a plain path is drawn
          as a chip inside it. Pressing one repoints that hole and leaves the
          program around it exactly as written. */}
      <ExprInput
        value={expr}
        syncValue={expr}
        placeholder={placeholder || ''}
        apiRef={exprApiRef}
        // Both kinds of data in one field: a `${…}` hole in a template, and a
        // value named outright — `variantClasses` in a class list is as much a
        // binding as `${post.title}` in a sentence, and only one of them used to
        // look like one.
        chipsOf={codeChips}
        onChipClick={(hit) => open(hit)}
        // Expanded editors keep authored line structure. Compact inline callers
        // can opt into wrapping so the whole value remains readable in the panel.
        wrap={wrapCode ?? false}
        onChange={(draft) => onChange({ type: 'expr', value: draft })}
        onCommit={(committed) =>
          committed !== expr && onChange({ type: 'expr', value: committed }, true)
        }
      />
      {list}
      {sourceEditor}
    </div>
  );
}

function useValueCodeEditor(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ExprInputAPI | undefined>(undefined);
  const [pick, setPick] = useState<ChipPick | undefined>(undefined); // {chip, pos}
  useValueCodeEditorDismiss(ref, onClose);
  const open = (chip: TemplateHole | undefined) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPick({
      chip: chip || undefined,
      pos: {
        left: rect.left,
        top: Math.min(rect.bottom + 4, Math.max(60, window.innerHeight - 340)),
        width: Math.max(rect.width, 240),
      },
    });
  };
  return { ref, apiRef, pick, setPick, open };
}
function useValueCodeEditorDismiss(ref: RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (
        ref.current &&
        !(event.target instanceof window.Node && ref.current.contains(event.target))
      ) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, ref]);
}
export function ValueCodeEditor({
  pos: position,
  name,
  value,
  scope,
  chipsOf,
  bindContext,
  onChange,
  onClose,
}: ValueCodeEditorProps) {
  const { ref, apiRef, pick, setPick, open } = useValueCodeEditor(onClose);

  return (
    <div
      ref={ref}
      className="attr-editor var-src"
      style={{ top: position.top, left: position.left, width: position.width }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <SourceEditorHeader name={name} onClose={onClose} />
      <ExprInput
        multiline
        autoFocus
        // Code opened to be read keeps its shape: the indentation says what is
        // nested in what, and wrapping every long line throws that away.
        wrap={false}
        className="var-src-code"
        value={value}
        syncValue={value}
        completions={scope}
        apiRef={apiRef}
        chipsOf={chipsOf}
        onChipClick={open}
        onChange={onChange}
      />
      {pick ? (
        <FieldDataPicker
          pos={pick.pos}
          bindContext={bindContext}
          current={pick.chip?.path ?? undefined}
          onPick={(path) => {
            const chip = pick.chip;
            setPick(undefined);
            const next = chip
              ? apiRef.current?.replaceRange(chip.from, chip.to, path)
              : apiRef.current?.insert(path);
            if (next !== undefined) {
              onChange(next);
            }
          }}
          onClose={() => setPick(undefined)}
        />
      ) : undefined}
    </div>
  );
}

function VarSourceEditor(props: VarSourceEditorProps) {
  const state = useVarSourceEditor(props);
  useVarSourceEditorDismiss(state);
  return <VarSourceEditorView state={state} />;
}
function useVarSourceEditor(props: VarSourceEditorProps) {
  const { code, name, onChangeCode } = props;
  const ref = useRef<HTMLDivElement>(null);
  assert(code.length <= LIMITS.ipcFieldCharsMax, 'Source editor: source limit exceeded');
  const codeRef = useRef(code);
  codeRef.current = code;
  const [draft, setDraft] = useState(() => findDeclaration(code, name)?.statement ?? '');
  // What is wrong with the draft, once there has been a reason to say. Empty
  // until the first commit: a statement is unfinished for most of the time it
  // takes to type one, and going red at every keystroke would be nagging about
  // a mistake that hasn't been made yet.
  const [error, setError] = useState('');
  const rangeRef = useRef<{ readonly start: number; readonly end: number } | undefined>(undefined);

  const apply = (text: string) => {
    const source = codeRef.current;
    // Re-locate on every write: the surrounding code can shift under us (an
    // undo, an edit elsewhere). Renaming the variable inside this editor is
    // the one case the lookup can't follow — fall back to where we last wrote.
    const found = findDeclaration(source, name);
    const range = found ? { start: found.start, end: found.end } : rangeRef.current;
    if (!range) {
      return;
    }
    assert(range.start >= 0, 'Source editor: declaration starts inside source');
    assert(range.end <= source.length, 'Source editor: declaration ends inside source');
    rangeRef.current = { start: range.start, end: range.start + text.length };
    onChangeCode?.(source.slice(0, range.start) + text + source.slice(range.end));
  };

  // Nothing is written while typing. This is code being spliced into a file the
  // site is compiled from, so every keystroke used to be compiled — and the
  // half-finished shape of a statement is a build error, which replaced the
  // preview with a stack trace you then had to wait out. It goes in when you
  // leave the field, and only if it parses.
  const commit = (text: string) => {
    if (text === draft && error) {
      return false;
    }
    const verdict = checkStatement(text);
    if (!verdict.ok) {
      setError(verdict.message);
      return false;
    }
    setError('');
    if (text !== (findDeclaration(codeRef.current, name)?.statement ?? '')) {
      apply(text);
    }
    return true;
  };

  // Capture phase: what's inside is CodeMirror and what's around it is the
  // panel's own pointer/key handling, either of which can stop an event before
  // a bubbling listener on the document would see it.
  // Read by the document listener above, which is registered once per render
  // and must not close over a stale draft.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Outside edits (undo) reach the editor as a changed statement; our own
  // writes come back identical, so typing isn't fought.
  const external = findDeclaration(code, name)?.statement;

  return { ...props, ref, draft, setDraft, error, setError, commit, draftRef, external };
}
type SourceEditorState = ReturnType<typeof useVarSourceEditor>;
function useVarSourceEditorDismiss({ ref, commit, draftRef, onClose }: SourceEditorState) {
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (
        !ref.current ||
        (event.target instanceof window.Node && ref.current.contains(event.target))
      ) {
        return;
      }
      // A press outside commits, the way leaving any field does — and if that
      // fails, the popup stays up holding the message. Closing on the press
      // that produced the error would be showing it to nobody. Escape and the
      // × still close, so this is a reason to stay, not a trap.
      if (commit(draftRef.current)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  });
}
function VarSourceEditorView({ state }: { readonly state: SourceEditorState }) {
  const {
    ref,
    pos: position,
    onClose,
    name,
    draft,
    external,
    error,
    setDraft,
    setError,
    commit,
  } = state;
  return (
    <div
      ref={ref}
      className="attr-editor var-src"
      style={{ top: position.top, left: position.left, width: position.width }}
      // Escape typed inside the code editor closes the popup, independently of
      // the document listener above.
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <SourceEditorHeader name={name} onClose={onClose} />
      <ExprInput
        multiline
        autoFocus
        className="var-src-code"
        value={draft}
        syncValue={external ?? draft}
        invalid={!!error}
        onChange={(text) => {
          setDraft(text);
          // Only once it has already gone red: then it is a correction being
          // watched for, not a running commentary on an unfinished line.
          if (error) {
            setError(checkStatement(text).ok ? '' : error);
          }
        }}
        onCommit={commit}
      />
      {error ? (
        <div className="var-src-error" role="alert">
          {error}
        </div>
      ) : undefined}
    </div>
  );
}

function eventElement(target: unknown): Element | undefined {
  return target instanceof window.Element ? target : undefined;
}

function SourceEditorHeader({
  name,
  onClose,
}: {
  readonly name: string;
  readonly onClose: () => void;
}) {
  return (
    <div className="var-src-head">
      <CodeIcon size={12} />
      <span className="var-src-name">{name}</span>
      <span style={{ flex: 1 }} />
      <button className="ghost" title="Close" onClick={onClose}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
