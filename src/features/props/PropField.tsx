import React, { useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { Attr } from '../../../shared/page-node';
import type { FieldDefinition, PropValues } from './propRules';
import type { RichContext } from './RichContent';
import type { SourceContext, ValueChange, FieldPosition, InsertAPI } from './propBindings';
import type { AssetDimensions } from '../../ui/AssetThumb';
import type { PickedAsset } from '../../ui/AssetField';
import { assert } from '../../../shared/assert';
import { LIMITS } from '../../../shared/limits';
import { definedFields } from '../../../shared/boundary';
import { resolveAssetImport } from '../../ipc/assetBridge';
import { findImportOf } from '../../editor/dataSuggest';
import { arrayItems, objectFields } from './arrayValue';
import { partsFromValue, valueFromParts } from '../../editor/bindings';
import { BindField, BindHandle, FieldDataPicker, ExprValueField } from './propBindings';
import { ObjectAttrsField, parseObjectLiteral, serializeObjectLiteral } from './propAttributes';
import { looksLikeAssetPath, mediaKindFor } from '../../ui/AssetThumb';
import AssetField from '../../ui/AssetField';
import LinkField from './LinkField';
import ListField from './ListField';
import ObjectField from './ObjectField';
import ClassInput from './ClassInput';
import PropTip from './PropTip';
import Dropdown from '../../ui/Dropdown';
import AutoTextarea from '../../ui/AutoTextarea';
import SegSwitch from './SegSwitch';
import StyleEditor, { collapseDeclarations } from './StyleEditor';
import {
  ResetIcon,
  FieldNumberIcon,
  ComponentPropertiesIcon,
  FieldSwitchIcon,
  BracesIcon,
  CodeIcon,
  ElementSlotIcon,
  VariableTextSizeIcon,
  ChevronDownIcon,
  CornerIcon,
} from '../../ui/Icons';

export interface AssetContext {
  readonly projectPath?: string | undefined;
  readonly filePath?: string | undefined;
  readonly nodeName?: string | undefined;
  readonly srcDims?: AssetDimensions | undefined;
  readonly siblingProps?: PropValues | undefined;
  readonly srcKind?: 'svg' | 'public' | 'asset' | 'remote' | undefined;
  readonly onPickAsset?: ((name: string, picked: PickedAsset) => void) | false | undefined;
  readonly onPickDimensions?: ((name: string, dimensions: AssetDimensions) => void) | undefined;
  readonly onSrcDimensions?: ((dimensions: AssetDimensions) => void) | undefined;
}
interface AssetBinding {
  readonly ident: string;
  readonly spec: string;
}
interface AssetImportFieldProps {
  readonly binding: AssetBinding;
  readonly name: string;
  readonly assetContext: AssetContext;
  readonly onChange: ValueChange;
}
export interface PropFieldProps {
  readonly field: FieldDefinition;
  readonly branchDefault?: string | number | undefined;
  readonly value?: Attr | undefined;
  readonly nodeKey?: string | undefined;
  readonly bindContext?: RichContext | undefined;
  readonly slotOptions?: readonly string[] | undefined;
  readonly projectClasses?: readonly string[] | undefined;
  readonly assetContext?: AssetContext | undefined;
  readonly linkContext?: ComponentProps<typeof LinkField>['context'] | undefined;
  readonly dataContext?: SourceContext | undefined;
  readonly onChange: ValueChange;
}
interface ResetMenuProps {
  readonly position: FieldPosition;
  readonly onReset: () => void;
  readonly onUnbind?: (() => void) | undefined;
  readonly unbindLabel: string;
  readonly onClose: () => void;
}
const noLabelActivation = (event: React.MouseEvent<HTMLLabelElement>) => event.preventDefault();
function attrText(value: Attr | undefined): string | undefined {
  return value?.type === 'bare' ? undefined : value?.value;
}

function isHrefName(name: string) {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words[words.length - 1] === 'href';
}

const MEDIA_IMPORT_RE =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|m4v|ogg|mp3|wav)(\?.*)?$/i;

export function assetImportOf(expr: unknown, frontmatter: unknown) {
  const match = String(expr ?? '')
    .trim()
    .match(/^([A-Za-z_$][\w$]*)(?:\.src)?$/);
  if (!match || !frontmatter) {
    return undefined;
  }
  const imported = findImportOf(frontmatter, match[1]);
  if (!imported || !MEDIA_IMPORT_RE.test(imported.spec)) {
    return undefined;
  }
  return { ident: match[1] ?? '', spec: imported.spec };
}

function AssetImportField({ binding, name, assetContext, onChange }: AssetImportFieldProps) {
  const [rel, setRel] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setRel(undefined);
    if (!assetContext.projectPath || !assetContext.filePath) {
      return undefined;
    }
    void resolveAssetImport(assetContext.projectPath, assetContext.filePath, binding.spec).then(
      (result) => {
        if (live) {
          setRel(result.ok ? result.rel : undefined);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [binding.spec, assetContext.projectPath, assetContext.filePath]);

  return (
    <AssetField
      value=""
      srcRel={rel}
      mediaKind={/\.(mp4|webm|mov|m4v)$/i.test(binding.spec) ? 'video' : 'image'}
      initialMode="asset"
      plainLabel="URL"
      projectPath={assetContext.projectPath ?? ''}
      onChange={(next, immediate) =>
        next === ''
          ? onChange(undefined, immediate)
          : onChange({ type: 'string', value: next }, immediate)
      }
      onPickEntry={
        assetContext.onPickAsset &&
        ((picked) => assetContext.onPickAsset && assetContext.onPickAsset(name, picked))
      }
      onDimensions={(dimensions) => assetContext.onPickDimensions?.(name, dimensions)}
      onCurrentDimensions={(dimensions) =>
        /^src$/i.test(name) && assetContext.onSrcDimensions?.(dimensions)
      }
    />
  );
}

const MEDIA_WORDS = new Set([
  'src',
  'image',
  'poster',
  'icon',
  'logo',
  'avatar',
  'thumb',
  'thumbnail',
  'photo',
  'banner',
  'cover',
  'video',
  'audio',
]);

function mediaWord(name: string) {
  const words = String(name || '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    .split(/\s+/);
  return words[words.length - 1] || '';
}

function isMediaName(name: string) {
  return MEDIA_WORDS.has(mediaWord(name));
}

function boundsHint(field: FieldDefinition) {
  const { min, max, step, minExclusive, maxExclusive } = field;
  const parts = [];
  if (min !== undefined && max !== undefined) {
    parts.push(`${minExclusive ? '>' : ''}${min}–${maxExclusive ? '<' : ''}${max}`);
  } else if (min !== undefined) {
    parts.push(minExclusive ? `greater than ${min}` : `${min} or more`);
  } else if (max !== undefined) {
    parts.push(maxExclusive ? `less than ${max}` : `${max} or less`);
  }
  if (step === 1) {
    parts.push('whole numbers');
  } else if (step !== undefined) {
    parts.push(`steps of ${step}`);
  }
  return parts.length ? `Accepts ${parts.join(', ')}` : undefined;
}

function isBoundValue(field: FieldDefinition, value: Attr | undefined) {
  if (!value || value.type !== 'expr') {
    return false;
  }
  const source = String(value.value).trim();
  if (field.type === 'boolean') {
    return !/^(true|false)$/.test(source);
  }
  if (field.type === 'number') {
    return !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(source);
  }
  if (field.type === 'enum') {
    return !(field.options || []).includes(source);
  }
  // A list of plain items is a list, and the list control writes exactly that.
  // Anything else an array prop can hold — a name, a spread, an object per item
  // — is a program, and the code editor is the only field that can show one.
  if (field.type === 'code') {
    return arrayItems(source) === undefined;
  }
  return true;
}

function valueFromExpr(field: FieldDefinition, raw: string): Attr | undefined {
  const source = String(raw ?? '').trim();
  const quoted = source.match(/^(['"])((?:[^\\]|\\.)*)\1$/);
  if (quoted) {
    if (field.type === 'boolean' || field.type === 'number') {
      return undefined;
    }
    const text = (quoted[2] ?? '').replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1');
    return field.type === 'enum' && !(field.options || []).includes(text)
      ? undefined
      : { type: 'string', value: text };
  }
  if (field.type === 'boolean') {
    return /^(true|false)$/.test(source) ? { type: 'expr', value: source } : undefined;
  }
  if (field.type === 'number') {
    return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(source) ? { type: 'expr', value: source } : undefined;
  }
  if (field.type === 'enum') {
    return (field.options || []).includes(source)
      ? { type: field.numeric ? 'expr' : 'string', value: source }
      : undefined;
  }
  // An array of plain items survives the trip: the list can show it, so going
  // back to the control keeps the value rather than dropping the prop.
  if (field.type === 'code' && arrayItems(source)) {
    return { type: 'expr', value: source };
  }
  return undefined;
}

function controlWord(field: FieldDefinition) {
  if (field.type === 'boolean') {
    return 'toggle';
  }
  if (field.type === 'code') {
    return 'list';
  }
  if (field.type === 'enum' && field.options?.length) {
    return 'options list';
  }
  if (field.type === 'style') {
    return 'CSS editor';
  }
  if (isMediaName(field.name)) {
    return 'asset picker';
  }
  if (isHrefName(field.name)) {
    return 'link settings';
  }
  return 'normal field';
}

export default function PropField(props: PropFieldProps) {
  const state = usePropField(props);
  if (state.reason && !state.isSet) {
    return undefined;
  }
  return <PropFieldControls state={state} />;
}
function usePropField(props: PropFieldProps) {
  const state = usePropFieldModel(props);
  return { ...state, ...propFieldActions(state) };
}
function usePropFieldModel(props: PropFieldProps) {
  const {
    field,
    branchDefault,
    value,
    nodeKey,

    assetContext,

    dataContext,
  } = props;
  const placeholderFor = (target: FieldDefinition) =>
    propFieldPlaceholder(target, assetContext, branchDefault);
  const { name, type } = field;
  const isSet = value !== undefined;
  const [menuPosition, setMenuPosition] = useState<FieldPosition | undefined>(undefined);
  const lastGoodRef = useRef('');
  const [custom, setCustom] = useState(false);
  const [insertAt, setInsertAt] = useState<FieldPosition | undefined>(undefined);
  // A ref prop: BindField fills it with its caret API while it is mounted.
  const bindApiRef = useRef<InsertAPI | undefined>(undefined);
  useEffect(() => setCustom(false), [nodeKey, name]);
  const bindable = type !== 'attrs' && name !== 'slot';
  const valueText = attrText(value) ?? '';
  const assetBinding = assetImportOf(valueText, dataContext?.imports);
  const shownAsAsset =
    value?.type === 'expr' && assetBinding && assetContext?.projectPath && assetContext?.filePath;
  const showExpr = bindable && (custom || (isBoundValue(field, value) && !shownAsAsset));
  const reason =
    !/^(quality|format|formats|fallbackFormat|densities|widths|sizes)$/i.test(name) ||
    !assetContext?.srcKind
      ? undefined
      : assetContext.srcKind === 'svg'
        ? 'SVG sources are passed through unoptimized, so this has no effect.'
        : assetContext.srcKind === 'public'
          ? 'Files in public/ are served as-is — import from src/assets to optimize.'
          : undefined;
  assert(valueText.length <= LIMITS.attrCharsMax, 'PropField: value limit exceeded');
  assert((field.options?.length ?? 0) <= LIMITS.propOptionsMax, 'PropField: option limit exceeded');
  const isExpr = value?.type === 'expr' || (type === 'code' && value?.type !== 'string');
  const isMediaAttr = isMediaName(name);
  return {
    ...props,
    name,
    type,
    isSet,
    menuPosition,
    setMenuPosition,
    lastGoodRef,
    custom,
    setCustom,
    insertAt,
    setInsertAt,
    bindApiRef,
    bindable,
    valueText,
    assetBinding,
    shownAsAsset,
    showExpr,
    reason,
    placeholderFor,
    isExpr,
    isMediaAttr,
  };
}
function propFieldActions(state: ReturnType<typeof usePropFieldModel>) {
  const { setMenuPosition, onChange, setCustom, value, field, isSet, showExpr } = state;
  const reset = () => {
    setMenuPosition(undefined);
    onChange(undefined, true);
  };
  const fromCustom = () => {
    setCustom(false);
    if (value?.type === 'expr') {
      onChange(valueFromExpr(field, value.value), true);
    }
  };
  const onLabelClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    // A field switched to a value has something to offer even before anything
    // is set: the way back to its control.
    if (!isSet && !showExpr) {
      return;
    }
    if (event.altKey) {
      reset();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPosition({ left: rect.left, top: rect.bottom + 4 });
  };
  return { reset, fromCustom, onLabelClick };
}
type PropState = ReturnType<typeof usePropField>;
type PropControlState = PropState & {
  readonly label: React.ReactNode;
  readonly pill: React.ReactNode;
  readonly menu: React.ReactNode;
};
function PropFieldControls({ state }: { readonly state: PropState }) {
  const pill = <PropFieldPill state={state} />;
  const menu = <PropFieldMenu state={state} />;
  const label = (
    <>
      <PropFieldLabelRow state={state} />
      <PropFieldPicker state={state} />
    </>
  );
  const view = { ...state, pill, menu, label };
  return propFieldControl(view);
}
function propFieldControl(view: PropControlState) {
  const {
    field,
    value,
    slotOptions,
    assetContext,
    linkContext,
    name,
    type,
    isSet,
    valueText,
    assetBinding,
    showExpr,
    isExpr,
    isMediaAttr,
  } = view;
  if (showExpr) {
    return <BindingControl state={view} />;
  }
  if (type === 'style' && (!isSet || value?.type === 'string')) {
    return <StyleControl state={view} />;
  }
  if (type === 'attrs') {
    const control = AttributeControl({ state: view });
    if (control !== undefined) {
      return control;
    }
  }
  if (
    /class(es)?$/i.test(name) &&
    name !== 'slot' &&
    (type === 'string' || type === 'other') &&
    value?.type !== 'expr'
  ) {
    return <ClassControl state={view} />;
  }
  if (name === 'slot' && slotOptions?.length) {
    return <SlotControl state={view} />;
  }
  if (type === 'enum' && field.options?.length) {
    return <EnumControl state={view} />;
  }
  if (type === 'boolean') {
    return <BooleanControl state={view} />;
  }
  if (type === 'number') {
    return <NumberControl state={view} />;
  }
  if (isHrefName(name) && !isExpr && linkContext && (type === 'string' || type === 'other')) {
    return <LinkControl state={view} />;
  }
  if (!isExpr && assetContext?.projectPath && (isMediaAttr || looksLikeAssetPath(valueText))) {
    return <MediaControl state={view} />;
  }
  if (isExpr && assetBinding && assetContext?.projectPath && assetContext?.filePath) {
    return <ImportedAssetControl state={view} />;
  }
  if (type === 'code' && !showExpr && valueText && objectFields(valueText)) {
    return <ObjectControl state={view} />;
  }
  if (type === 'code' && !showExpr && (value === undefined || arrayItems(valueText))) {
    return <ListControl state={view} />;
  }
  if (isExpr) {
    return <ExpressionControl state={view} />;
  }
  return <TextControl state={view} />;
}
function propFieldPlaceholder(
  field: FieldDefinition,
  assetContext: AssetContext | undefined,
  branchDefault: string | number | undefined,
): string {
  const siblingNumber = (propName: string) => {
    const sibling = assetContext?.siblingProps?.[propName];
    if (!sibling) {
      return undefined;
    }
    const parsed = parseFloat(attrText(sibling) ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  if (field.default !== undefined) {
    return String(field.default);
  }
  if (branchDefault !== undefined) {
    return String(branchDefault);
  }
  const dimensions = assetContext?.srcDims;
  if (dimensions) {
    const isWidth = /^width$/i.test(field.name);
    const isHeight = /^height$/i.test(field.name);
    if ((isWidth || isHeight) && dimensions.w && dimensions.h) {
      // Setting one dimension makes the other follow the source's aspect
      // ratio — that, not the asset's own size, is what leaving this field
      // empty now means.
      const other = siblingNumber(isWidth ? 'height' : 'width');
      if (other) {
        const ratio = isWidth ? dimensions.w / dimensions.h : dimensions.h / dimensions.w;
        return String(Math.round(other * ratio));
      }
    }
    if (isWidth && dimensions.w) {
      return String(dimensions.w);
    }
    if (isHeight && dimensions.h) {
      return String(dimensions.h);
    }
  }
  return field.hint || '';
}
function BindingControl({ state }: { readonly state: PropControlState }) {
  const {
    field,
    value,
    bindContext,
    dataContext,
    onChange,
    setCustom,
    bindApiRef,
    placeholderFor,
    label,
  } = state;

  return (
    <div className="props-field">
      {label}
      <BindField
        value={value}
        field={field}
        apiRef={bindApiRef}
        placeholder={placeholderFor(field)}
        bindContext={bindContext}
        dataContext={dataContext}
        onChange={(next, immediate) => {
          // Editing holds the field open: clearing a binding on the way to
          // another one shouldn't snap the control back mid-edit. An empty
          // value unsets the prop and leaves the field where it is.
          setCustom(true);
          onChange(next, immediate);
        }}
      />
    </div>
  );
}
function StyleControl({ state }: { readonly state: PropControlState }) {
  const { value, onChange, label } = state;

  return (
    <div className="props-field">
      {label}
      <StyleEditor
        value={attrText(value) || ''}
        placeholder="color: red;"
        onChange={(text) => {
          const flat = collapseDeclarations(text);
          // Nothing left in it means no attribute at all — an element never
          // asked for an empty style="" and shouldn't carry one.
          if (!flat) {
            onChange(undefined, true);
          } else {
            onChange({ type: 'string', value: flat }, false);
          }
        }}
      />
    </div>
  );
}
function AttributeControl({ state }: { readonly state: PropControlState }) {
  const { field, value, bindContext, assetContext, onChange, pill, menu } = state;

  const source = value?.type === 'expr' ? value.value : undefined;
  const entries =
    source !== undefined
      ? parseObjectLiteral(source)
      : (parseObjectLiteral(typeof field.default === 'string' ? field.default : '{}') ?? []);
  if (entries) {
    return (
      <ObjectAttrsField
        pill={pill}
        menu={menu}
        entries={entries}
        bindContext={bindContext}
        projectPath={assetContext?.projectPath}
        onCommit={(next) =>
          next.length
            ? onChange({ type: 'expr', value: serializeObjectLiteral(next) }, true)
            : onChange(undefined, true)
        }
      />
    );
  }
  // Unparsable (nested objects, spreads) — fall through to the generic
  // expression field below.

  return undefined;
}
function ClassControl({ state }: { readonly state: PropControlState }) {
  const { value, projectClasses, onChange, label } = state;

  return (
    <div className="props-field">
      {label}
      <ClassInput
        value={attrText(value) || ''}
        suggestions={projectClasses || []}
        onChange={(next, immediate) =>
          next.trim()
            ? onChange({ type: 'string', value: next }, immediate)
            : onChange(undefined, true)
        }
      />
    </div>
  );
}
function SlotControl({ state }: { readonly state: PropControlState }) {
  const { value, slotOptions, onChange, label } = state;
  assert(slotOptions?.length, 'Slot control: slots exist');

  const raw = attrText(value);
  const named = slotOptions.filter((slot) => slot !== 'default');
  // Keep an out-of-list current value selectable rather than losing it.
  const choices = [
    { value: '', label: 'default', dim: true },
    ...(raw && raw !== 'default' && !named.includes(raw) ? [{ value: raw, label: raw }] : []),
    ...named.map((slot) => ({ value: slot, label: slot })),
  ];
  return (
    <div className="props-field">
      {label}
      <Dropdown
        value={raw && raw !== 'default' ? raw : ''}
        options={choices}
        onChange={(next) =>
          next === '' ? onChange(undefined, true) : onChange({ type: 'string', value: next }, true)
        }
      />
    </div>
  );
}
function EnumControl({ state }: { readonly state: PropControlState }) {
  const { field, value, onChange, placeholderFor, label } = state;
  assert(field.options?.length, 'Enum control: options exist');

  const defaultText = field.default !== undefined ? String(field.default) : undefined;
  const raw = attrText(value);
  // Exactly two options, one of them the default: the same shape as a
  // boolean — an either/or with a known resting state — so it reads as one.
  // Only when what's set is one of the two; an out-of-schema value has to
  // stay visible, and the dropdown is the only field that can show it.
  if (
    field.options.length === 2 &&
    defaultText !== undefined &&
    field.options.includes(defaultText) &&
    (raw === undefined || field.options.includes(raw))
  ) {
    const current = raw ?? defaultText;
    return (
      <div className="props-field">
        {label}
        <SegSwitch
          options={field.options.map((option) => ({ value: option, label: option }))}
          current={current}
          onPick={(next) =>
            // Picking the default clears the prop, exactly as the dropdown
            // does — an untouched component stays untouched in the markup.
            next === defaultText
              ? onChange(undefined, true)
              : onChange({ type: field.numeric ? 'expr' : 'string', value: next }, true)
          }
        />
      </div>
    );
  }
  // The default option is encoded as '' (= prop not set), so an unset prop
  // shows its default as the selected option and picking the default
  // resets the prop rather than writing it out explicitly.
  const selected = raw === undefined || raw === defaultText ? '' : raw;
  // Keep an out-of-schema current value selectable rather than losing it.
  const choices =
    raw === undefined || field.options.includes(raw) ? field.options : [raw, ...field.options];
  return (
    <div className="props-field">
      {label}
      <Dropdown
        value={selected}
        // Says what happens when nothing is picked. For a conditional
        // default that's the condition itself — better than naming one of
        // the two answers as if it were the only one.
        placeholder={placeholderFor(field) || '(not set)'}
        options={choices.map((option) => ({
          value: option === defaultText ? '' : option,
          label: option,
        }))}
        // A union of numbers is still numbers: the component is typed for one,
        // so it has to be written `cols={3}`, not `cols="3"`.
        onChange={(next) =>
          next === ''
            ? onChange(undefined, true)
            : onChange({ type: field.numeric ? 'expr' : 'string', value: next }, true)
        }
      />
    </div>
  );
}
function BooleanControl({ state }: { readonly state: PropControlState }) {
  const { field, value, onChange, label } = state;

  // A checkbox can only say on/off, and a boolean prop has three states:
  // true, false, and unset (= whatever the component defaults to). Two
  // segments say which one is in effect, and picking the default clears the
  // prop rather than writing it out — the same rule the enum dropdown uses,
  // so an untouched component stays untouched in the markup.
  // A boolean that isn't there is false — that's what the component sees for
  // an undeclared default, so false IS the default unless the component says
  // otherwise. Picking it clears the prop instead of writing `x={false}`,
  // which would mark the field set and put `false` in the markup to say what
  // its absence already said.
  const fallback = field.default === undefined ? false : !!field.default;
  const current = value ? value.type !== 'expr' || value.value === 'true' : fallback;
  return (
    <div className="props-field">
      {label}
      <SegSwitch
        options={[
          { value: true, label: 'True' },
          { value: false, label: 'False' },
        ]}
        current={current}
        onPick={(next) =>
          next === fallback
            ? onChange(undefined, true)
            : onChange({ type: 'expr', value: next ? 'true' : 'false' }, true)
        }
      />
    </div>
  );
}
function NumberControl({ state }: { readonly state: PropControlState }) {
  const model = numberControlState(state);
  return <NumberControlView state={model} />;
}
function numberControlState(state: PropControlState) {
  const { field, value, onChange, lastGoodRef, placeholderFor } = state;

  const numberText = value?.type === 'expr' ? value.value : (attrText(value) ?? '');
  // What the component says it will accept (see numberRules): a bound the
  // type can't express, read from the doc comment. Typing stays free — you
  // have to be able to pass through "-" or "1." on the way to a real number
  // — and the check happens when the value is committed, on Enter or on
  // leaving the field.
  const { bounded, allows, clamp } = numberControlBounds(field);
  // The last value that was allowed, to fall back to. An empty field is
  // allowed — it means "unset", and the component's own default applies.
  if (numberText === '' || allows(parseFloat(numberText))) {
    lastGoodRef.current = numberText;
  }
  const revertIfRejected = () => {
    if (!bounded || numberText === '' || allows(parseFloat(numberText))) {
      return;
    }
    const back = lastGoodRef.current;
    onChange(back === '' ? undefined : { type: 'expr', value: back }, true);
  };
  // One place decides what a step does, so the arrow keys and the buttons
  // can't drift apart. Shift ×10, Option ÷10 — the modifiers the style
  // panel's number fields already use.
  const step = (
    direction: number,
    mods: { readonly shiftKey: boolean; readonly altKey: boolean },
    from: string,
  ) => {
    const size = mods.shiftKey ? 10 : mods.altKey ? 0.1 : 1;
    const current = parseFloat(from);
    // An empty field steps from the value it is SHOWING — the placeholder is
    // the effective value (the source image's 115, the component's default),
    // so ▲ on a blank width goes to 116, not 1.
    const shown = parseFloat(placeholderFor(field));
    const base = Number.isFinite(current)
      ? current
      : Number.isFinite(shown)
        ? shown
        : parseFloat(String(field.default)) || 0;
    // Round away float noise (e.g. 38.1 + 0.1 = 38.199999…), then keep the
    // result inside what the component accepts — a step is an applied value,
    // so it should never land somewhere the field would reject.
    const next = Math.round((base + direction * size) * 1e6) / 1e6;
    onChange({ type: 'expr', value: String(bounded ? clamp(next) : next) });
  };
  const onStepKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      revertIfRejected();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    step(event.key === 'ArrowUp' ? 1 : -1, event, event.currentTarget.value);
  };
  return { ...state, numberText, revertIfRejected, onStepKey, step };
}
function NumberControlView({ state }: { readonly state: ReturnType<typeof numberControlState> }) {
  const { label, numberText, placeholderFor, field, onStepKey, revertIfRejected, onChange, step } =
    state;

  return (
    <div className="props-field">
      {label}
      {/* type=text, not number: the native spinner can't be styled, ignores
            the modifier steps, and its scroll-to-change fires while scrolling
            the panel. inputMode keeps the numeric keypad on touch. */}
      <div className="num-field">
        <input
          type="text"
          inputMode="decimal"
          value={numberText}
          placeholder={placeholderFor(field)}
          onKeyDown={onStepKey}
          onBlur={revertIfRejected}
          title={boundsHint(field)}
          onChange={(event) =>
            event.target.value === ''
              ? onChange(undefined)
              : onChange({ type: 'expr', value: event.target.value })
          }
        />
        <span className="num-steppers">
          {[1, -1].map((direction) => (
            <button
              key={direction}
              type="button"
              tabIndex={-1}
              aria-label={direction > 0 ? 'Increase' : 'Decrease'}
              title={`${direction > 0 ? 'Increase' : 'Decrease'} — ⇧ by 10, ⌥ by 0.1`}
              onClick={(event) => step(direction, event, numberText)}
            >
              <ChevronDownIcon
                size={11}
                style={direction > 0 ? { transform: 'rotate(180deg)' } : undefined}
              />
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
function LinkControl({ state }: { readonly state: PropControlState }) {
  const { value, assetContext, linkContext, onChange, label } = state;
  assert(linkContext, 'Link control: context exists');

  return (
    <div className="props-field">
      {label}
      <LinkField
        {...(value === undefined ? {} : { value })}
        context={{ ...linkContext, projectPath: assetContext?.projectPath ?? '' }}
        onChange={onChange}
      />
    </div>
  );
}
function MediaControl({ state }: { readonly state: PropControlState }) {
  const { assetContext, onChange, name, valueText, isMediaAttr, label } = state;
  assert(assetContext?.projectPath, 'Media control: project exists');

  const nodeName = String(assetContext.nodeName || '').toLowerCase();
  const mediaKind = looksLikeAssetPath(valueText)
    ? mediaKindFor(valueText)
    : /^(poster|image|logo|icon|avatar|thumb|thumbnail|photo|banner|cover)$/.test(mediaWord(name))
      ? 'image'
      : mediaWord(name) === 'video'
        ? 'video'
        : mediaWord(name) === 'audio'
          ? 'audio'
          : nodeName === 'video'
            ? 'video'
            : nodeName === 'audio'
              ? 'audio'
              : ['img', 'source', 'picture', 'image'].includes(nodeName)
                ? 'image'
                : 'asset';
  return (
    <div className="props-field">
      {label}
      <AssetField
        value={valueText}
        mediaKind={mediaKind}
        // A non-media prop only lands here because its value is an asset
        // path, so open in asset mode; "Text" is the way back out.
        {...definedFields({ initialMode: isMediaAttr ? undefined : ('asset' as const) })}
        plainLabel={isMediaAttr ? 'URL' : 'Text'}
        projectPath={assetContext.projectPath ?? ''}
        onChange={(next, immediate) =>
          next === ''
            ? onChange(undefined, immediate)
            : onChange({ type: 'string', value: next }, immediate)
        }
        onPickEntry={
          assetContext.onPickAsset &&
          ((picked) => assetContext.onPickAsset && assetContext.onPickAsset(name, picked))
        }
        onDimensions={(dimensions) => assetContext.onPickDimensions?.(name, dimensions)}
        onCurrentDimensions={(dimensions) =>
          /^src$/i.test(name) && assetContext.onSrcDimensions?.(dimensions)
        }
      />
    </div>
  );
}
function ImportedAssetControl({ state }: { readonly state: PropControlState }) {
  const { assetContext, onChange, name, assetBinding, label } = state;
  assert(assetContext, 'Imported asset: context exists');
  assert(assetBinding, 'Imported asset: binding exists');

  return (
    <div className="props-field">
      {label}
      <AssetImportField
        binding={assetBinding}
        name={name}
        assetContext={assetContext}
        onChange={onChange}
      />
    </div>
  );
}
function ObjectControl({ state }: { readonly state: PropControlState }) {
  const { onChange, valueText, label } = state;

  return (
    <div className="props-field">
      {label}
      <ObjectField
        value={valueText}
        onChange={(text, immediate) => onChange({ type: 'expr', value: text }, immediate)}
      />
    </div>
  );
}
function ListControl({ state }: { readonly state: PropControlState }) {
  const { field, onChange, valueText, placeholderFor, label } = state;

  return (
    <div className="props-field">
      {label}
      <ListField
        value={valueText}
        placeholder={placeholderFor(field)}
        onChange={(text, immediate) => onChange({ type: 'expr', value: text }, immediate)}
      />
    </div>
  );
}
function ExpressionControl({ state }: { readonly state: PropControlState }) {
  const { field, dataContext, onChange, valueText, placeholderFor, label } = state;

  return (
    <div className="props-field">
      {label}
      <ExprValueField
        value={valueText}
        placeholder={placeholderFor(field)}
        dataContext={dataContext}
        onChange={onChange}
      />
    </div>
  );
}
function TextControl({ state }: { readonly state: PropControlState }) {
  const { field, onChange, name, valueText, placeholderFor, label } = state;
  // A bare attribute has no authored text value; preserve that absence in the input.
  const text = state.value?.type === 'bare' ? undefined : valueText;
  const long =
    String(valueText).length > 48 || /text|description|content|body|paragraph/i.test(name);
  return (
    <div className="props-field">
      {label}
      {long ? (
        <AutoTextarea
          value={text}
          placeholder={placeholderFor(field)}
          onChange={(event) => onChange({ type: 'string', value: event.target.value })}
        />
      ) : (
        <input
          value={text}
          placeholder={placeholderFor(field)}
          onChange={(event) => onChange({ type: 'string', value: event.target.value })}
        />
      )}
    </div>
  );
}
function PropFieldPill({ state }: { readonly state: PropState }) {
  const { name, type, isSet, showExpr, onLabelClick } = state;

  return (
    <span
      className={`prop-label${isSet ? ' set' : ''}`}
      title={isSet ? '⌥-click to reset to default' : showExpr ? 'Click for options' : undefined}
      onClick={onLabelClick}
    >
      {type === 'number' && <FieldNumberIcon size={12} className="prop-label-icon" />}
      {type === 'boolean' && <FieldSwitchIcon size={12} className="prop-label-icon" />}
      {type === 'enum' && <ComponentPropertiesIcon size={12} className="prop-label-icon" />}
      {type === 'attrs' && <BracesIcon size={12} className="prop-label-icon" />}
      {(type === 'code' || type === 'style') && <CodeIcon size={12} className="prop-label-icon" />}
      {(type === 'slot' || name === 'slot') && (
        <ElementSlotIcon size={12} className="prop-label-icon" />
      )}
      {(type === 'string' || type === 'other') && name !== 'slot' && (
        <VariableTextSizeIcon size={12} className="prop-label-icon" />
      )}
      {name}
    </span>
  );
}
function PropFieldMenu({ state }: { readonly state: PropState }) {
  const { field, menuPosition, setMenuPosition, showExpr, reset, fromCustom } = state;

  return (
    menuPosition && (
      <ResetMenu
        position={menuPosition}
        onReset={reset}
        // Only while the field is showing a value instead of its own control —
        // it is the way back, and there is nothing to go back FROM otherwise.
        {...(showExpr ? { onUnbind: fromCustom } : {})}
        unbindLabel={`Use the ${controlWord(field)}`}
        onClose={() => setMenuPosition(undefined)}
      />
    )
  );
}
function PropFieldLabelRow({ state }: { readonly state: PropState }) {
  const {
    field,

    setCustom,
    insertAt,
    setInsertAt,
    bindable,
    showExpr,
    reason,
    fromCustom,
  } = state;
  const pill = <PropFieldPill state={state} />;
  const menu = <PropFieldMenu state={state} />;
  return (
    <label onClick={noLabelActivation}>
      {pill}
      {/* The prop's own documentation — the comment above it in the
          component's `interface Props`. */}
      <PropTip {...(field.doc === undefined ? {} : { text: field.doc })} />
      {reason && (
        <span className="prop-inert" title={reason}>
          ignored
        </span>
      )}
      {/* The way between the field's own control and an expression, both ways,
          in the one place a field's name already is. Some values a control
          cannot hold — `href={page.url}` is not a link setting — and until this
          existed the only way in was to pick data, which is a value rather than
          the code somebody had in mind. */}
      {bindable && (
        <button
          type="button"
          className={`prop-expr-toggle${showExpr ? ' on' : ''}`}
          title={showExpr ? `Use the ${controlWord(field)}` : 'Write an expression'}
          aria-pressed={showExpr}
          aria-label="Write an expression"
          onClick={() => (showExpr ? fromCustom() : setCustom(true))}
        >
          <BracesIcon size={12} />
        </button>
      )}
      {bindable && (
        <BindHandle
          active={!!insertAt}
          onOpen={(host) => {
            if (insertAt) {
              setInsertAt(undefined);
              return;
            }
            const bounds = host?.getBoundingClientRect();
            if (!bounds) {
              return;
            }
            setInsertAt({
              left: bounds.left,
              top: Math.min(bounds.bottom + 4, Math.max(60, window.innerHeight - 340)),
              width: Math.max(bounds.width, 240),
            });
          }}
        />
      )}
      {menu}
    </label>
  );
}
function PropFieldPicker({ state }: { readonly state: PropState }) {
  const {
    field,
    value,
    bindContext,
    onChange,
    type,
    setCustom,
    insertAt,
    setInsertAt,
    bindApiRef,
  } = state;

  return (
    insertAt && (
      <FieldDataPicker
        pos={insertAt}
        bindContext={bindContext}
        onPick={(path) => {
          setInsertAt(undefined);
          // Into the value field's caret when there is one — so a chip can land
          // beside text already typed. Otherwise this is the field's first
          // binding, and choosing one is what turns the control into a value.
          if (bindApiRef.current?.insert) {
            bindApiRef.current.insert(path);
            return;
          }
          setCustom(true);
          // Text already typed is kept and the chip goes after it — inserting
          // data into "Read more about " should not throw the sentence away. A
          // control's value can't be joined to anything (`true` and a binding is
          // not a value), so those are replaced.
          const numeric = !!(
            type === 'number' ||
            type === 'boolean' ||
            (type === 'enum' && field.numeric)
          );
          const keep = numeric || type === 'enum' ? undefined : partsFromValue(value);
          const next = keep?.length ? [...keep, { expr: path }] : [{ expr: path }];
          onChange(valueFromParts(next, { numeric }), true);
        }}
        onClose={() => setInsertAt(undefined)}
      />
    )
  );
}

function ResetMenu({ position, onReset, onUnbind, unbindLabel, onClose }: ResetMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
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
    const onScroll = (event: Event) => {
      if (
        ref.current &&
        event.target instanceof window.Node &&
        ref.current.contains(event.target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="prop-menu" style={{ left: position.left, top: position.top }}>
      {onUnbind && (
        <div className="prop-menu-item" onClick={onUnbind}>
          <CornerIcon size={12} />
          {unbindLabel}
        </div>
      )}
      <div className="prop-menu-item" onClick={onReset}>
        <ResetIcon size={12} />
        Reset to default property value
      </div>
    </div>
  );
}

function numberControlBounds(field: FieldDefinition) {
  const { min, max, step: grain, minExclusive, maxExclusive } = field;
  const bounded = min !== undefined || max !== undefined || grain !== undefined;
  const allows = (candidate: number) => {
    if (!Number.isFinite(candidate)) {
      return false;
    }
    if (min !== undefined && (minExclusive ? candidate <= min : candidate < min)) {
      return false;
    }
    if (max !== undefined && (maxExclusive ? candidate >= max : candidate > max)) {
      return false;
    }
    // Rounded before comparing, or 0.1 + 0.2 fails a step of 0.1.
    if (grain !== undefined && Math.abs(Math.round(candidate / grain) * grain - candidate) > 1e-9) {
      return false;
    }
    return true;
  };
  const clamp = (input: number) => {
    let clamped = input;
    if (grain !== undefined) {
      clamped = Math.round(clamped / grain) * grain;
    }
    if (min !== undefined) {
      clamped = Math.max(clamped, minExclusive ? min + (grain ?? 1e-6) : min);
    }
    if (max !== undefined) {
      clamped = Math.min(clamped, maxExclusive ? max - (grain ?? 1e-6) : max);
    }
    return Math.round(clamped * 1e6) / 1e6;
  };
  return { bounded, allows, clamp };
}
