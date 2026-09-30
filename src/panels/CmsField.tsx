import React, { useEffect, useRef, useState } from 'react';
import type { Result } from '../../shared/result';
import type { FieldType } from '../cmsSchema';
import type { PickedAsset } from '../ui/AssetField';
import { assert } from '../../shared/assert';
import { BOUNDARY_LIMITS } from '../../shared/boundary';
import { toArray, toRecord } from '../../shared/record';
import { blankItem, fieldsOf, isExpr, titleOf, EXPR_KEY } from '../cmsSchema';
import { ChevronRightIcon, CloseIcon, DragIcon, PlusIcon, TrashIcon } from '../ui/Icons';
import AssetField from '../ui/AssetField';
import AutoTextarea from '../ui/AutoTextarea';
import ExprInput from '../ui/ExprInput';
import useListReorder from '../ui/useListReorder';

export interface CmsFieldContext {
  readonly projectPath: string;
  readonly baseDir: string;
  readonly pickAsset?: ((picked: PickedAsset) => Promise<Result<unknown, string>>) | undefined;
}
interface ValueProps extends CmsFieldContext {
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly depth: number;
}
interface ControlProps extends ValueProps {
  readonly type: FieldType;
}
export interface CmsFieldProps extends CmsFieldContext {
  readonly label: string;
  readonly type: FieldType;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly depth?: number;
}
interface ListProps {
  readonly value: readonly unknown[];
  readonly onChange: (value: unknown) => void;
}
interface RepeaterProps extends ListProps, CmsFieldContext {
  readonly depth: number;
}
interface GroupProps extends CmsFieldContext {
  readonly value: Readonly<Record<string, unknown>>;
  readonly onChange: (value: unknown) => void;
  readonly depth: number;
}
interface DialogProps extends CmsFieldContext {
  readonly entry: unknown;
  readonly title: string;
  readonly depth: number;
  readonly onChange: (value: unknown) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

export default function CmsField({ label, type, depth = 0, ...props }: CmsFieldProps) {
  assert(Number.isSafeInteger(depth), 'CMS field: depth must be an integer');
  assert(depth >= 0, 'CMS field: depth must be nonnegative');
  assert(depth <= BOUNDARY_LIMITS.depthMax, 'CMS field: nesting limit exceeded');
  // A control keeps its shape while typing so a text-to-paragraph inference
  // cannot replace the focused input and discard the caret.
  const [focused, setFocused] = useState(false);
  const shown = useRef(type);
  if (!focused) {
    shown.current = type;
  }
  return (
    <div
      className={`cms-field ${shown.current}`}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div className="cms-field-head">
        <label>{label}</label>
      </div>
      <FieldControl {...props} type={shown.current} depth={depth} />
    </div>
  );
}

function FieldControl(props: ControlProps) {
  const { type, value, onChange, depth, ...context } = props;
  switch (type) {
    case 'code':
      return <CodeField value={value} onChange={onChange} />;
    case 'boolean':
      return <ToggleField value={value} onChange={onChange} />;
    case 'number':
      return <NumberField value={value} onChange={onChange} />;
    case 'image':
      return <ImageField {...props} />;
    case 'date':
      return <DateField value={value} onChange={onChange} />;
    case 'color':
      return <ColorField value={value} onChange={onChange} />;
    case 'longtext':
      return (
        <AutoTextarea
          value={fieldText(value)}
          minRows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'list':
      return <ListEditor value={toArray(value) ?? []} onChange={onChange} />;
    case 'object':
      return (
        <GroupEditor
          {...context}
          value={toRecord(value) ?? {}}
          onChange={onChange}
          depth={depth + 1}
        />
      );
    case 'objects':
      return (
        <RepeaterEditor
          {...context}
          value={toArray(value) ?? []}
          onChange={onChange}
          depth={depth + 1}
        />
      );
    case 'link':
    case 'email':
    case 'phone':
      return <AddressField {...props} type={type} />;
    case 'empty':
    case 'text':
      return (
        <input
          value={fieldText(value)}
          maxLength={BOUNDARY_LIMITS.textLengthMax}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}
function fieldText(value: unknown): string {
  const result = String(value ?? '');
  assert(result.length <= BOUNDARY_LIMITS.textLengthMax, 'CMS field: text limit exceeded');
  return result;
}
type ScalarProps = Pick<ValueProps, 'value' | 'onChange'>;
function CodeField({ value, onChange }: ScalarProps) {
  const text = isExpr(value) ? value[EXPR_KEY] : fieldText(value);
  return (
    <ExprInput
      value={text}
      syncValue={text}
      placeholder="expression"
      onCommit={(next) => {
        if (next.trim() !== text.trim()) {
          onChange({ [EXPR_KEY]: next.trim() });
        }
      }}
    />
  );
}
function ToggleField({ value, onChange }: ScalarProps) {
  return (
    <button
      type="button"
      className={`cms-toggle ${value ? 'on' : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className="cms-toggle-knob" />
      <span className="cms-toggle-label">{value ? 'On' : 'Off'}</span>
    </button>
  );
}
function NumberField({ value, onChange }: ScalarProps) {
  return (
    <input
      type="number"
      value={fieldText(value)}
      onChange={(event) => {
        const text = event.target.value;
        const next = text === '' ? '' : Number(text);
        if (typeof next === 'number') {
          if (!Number.isFinite(next)) {
            return;
          }
        }
        onChange(next);
      }}
    />
  );
}
function ImageField({
  value,
  onChange,
  pickAsset,
  projectPath,
  baseDir: baseDirectory,
}: ValueProps) {
  const asset = isExpr(value) ? value['__asset'] : undefined;
  const reference = typeof asset === 'string' ? asset : undefined;
  return (
    <AssetField
      value={reference === undefined ? fieldText(value) : ''}
      srcRel={reference}
      onChange={onChange}
      onPickEntry={
        pickAsset &&
        ((picked) => {
          void pickAsset(picked).then((result) => {
            if (result.ok) {
              onChange(result.value);
            }
          });
        })
      }
      mediaKind="image"
      projectPath={projectPath}
      baseDir={baseDirectory}
    />
  );
}
function DateField({ value, onChange }: ScalarProps) {
  const text = fieldText(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  return dateOnly || !value ? (
    <input type="date" value={text} onChange={(event) => onChange(event.target.value)} />
  ) : (
    <input value={text} onChange={(event) => onChange(event.target.value)} />
  );
}
function AddressField({
  type,
  value,
  onChange,
}: ScalarProps & {
  readonly type: 'link' | 'email' | 'phone';
}) {
  return (
    <input
      type={type === 'link' ? 'url' : type === 'email' ? 'email' : 'tel'}
      value={fieldText(value)}
      maxLength={BOUNDARY_LIMITS.textLengthMax}
      placeholder={type === 'link' ? 'https://' : type === 'email' ? 'name@site.com' : ''}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
function ColorField({ value, onChange }: ScalarProps) {
  const text = fieldText(value);
  return (
    <div className="cms-color">
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(text) ? text : '#000000'}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        value={text}
        placeholder="#000000"
        spellCheck={false}
        maxLength={BOUNDARY_LIMITS.textLengthMax}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
function ListEditor({ value, onChange }: ListProps) {
  assert(value.length <= BOUNDARY_LIMITS.itemsMax, 'CMS list: item limit exceeded');
  return (
    <div className="cms-list">
      {value.map((entry, index) => (
        <div key={index} className="cms-list-row">
          <input
            value={fieldText(entry)}
            maxLength={BOUNDARY_LIMITS.textLengthMax}
            onChange={(event) => {
              const text = event.target.value;
              const next = typeof entry === 'number' ? Number(text) : text;
              if (typeof next === 'number') {
                if (!Number.isFinite(next)) {
                  return;
                }
              }
              onChange(value.map((item, position) => (position === index ? next : item)));
            }}
          />
          <button
            className="ghost"
            title="Remove"
            onClick={() => onChange(value.filter((_, position) => position !== index))}
          >
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
      <button
        className="cms-add"
        onClick={() => {
          assert(value.length < BOUNDARY_LIMITS.itemsMax, 'CMS list: item limit exceeded');
          onChange([...value, '']);
        }}
      >
        <PlusIcon size={11} /> Add
      </button>
    </div>
  );
}
function GroupEditor({ value, onChange, ...context }: GroupProps) {
  const fields = fieldsOf([value]);
  return (
    <div className="cms-group-box">
      {fields.map((field) => (
        <CmsField
          key={field.key}
          {...context}
          label={field.label}
          type={field.type}
          value={value[field.key]}
          onChange={(next) => onChange({ ...value, [field.key]: next })}
        />
      ))}
      {fields.length === 0 && <div className="cms-empty-inline">Empty group.</div>}
    </div>
  );
}
function useRepeater({ value, onChange }: RepeaterProps) {
  assert(value.length <= BOUNDARY_LIMITS.itemsMax, 'CMS repeater: item limit exceeded');
  const [openIndex, setOpenIndex] = useState<number | undefined>();
  const removeAt = (index: number) => {
    onChange(value.filter((_, position) => position !== index));
    if (openIndex === index) {
      setOpenIndex(undefined);
    } else if (openIndex !== undefined) {
      if (openIndex > index) {
        setOpenIndex(openIndex - 1);
      }
    }
  };
  const move = (from: number, to: number) => {
    assert(Number.isSafeInteger(from), 'CMS repeater: source index must be an integer');
    assert(from >= 0, 'CMS repeater: source index must be nonnegative');
    assert(from < value.length, 'CMS repeater: source index out of range');
    assert(Number.isSafeInteger(to), 'CMS repeater: target index must be an integer');
    assert(to >= 0, 'CMS repeater: target index must be nonnegative');
    assert(to <= value.length, 'CMS repeater: target index out of range');
    if (from === to) {
      return;
    }
    const next = [...value];
    const [moved] = next.splice(from, 1);
    const target = to > from ? to - 1 : to;
    next.splice(target, 0, moved);
    onChange(next);
    // Keep the dialog attached to its entry when a preceding row moves.
    if (openIndex !== undefined) {
      if (openIndex === from) {
        setOpenIndex(target);
      } else {
        const afterRemoval = openIndex > from ? openIndex - 1 : openIndex;
        setOpenIndex(afterRemoval >= target ? afterRemoval + 1 : afterRemoval);
      }
    }
  };
  const add = () => {
    assert(value.length < BOUNDARY_LIMITS.itemsMax, 'CMS repeater: item limit exceeded');
    const next = [...value, blankItem(value)];
    onChange(next);
    setOpenIndex(next.length - 1);
  };
  const reorder = useListReorder({ count: value.length, onMove: move });
  return { openIndex, setOpenIndex, removeAt, add, reorder };
}
function RepeaterEditor(props: RepeaterProps) {
  const { value, onChange, ...context } = props;
  const { openIndex, setOpenIndex, removeAt, add, reorder } = useRepeater(props);
  return (
    <div className="cms-repeater">
      {value.map((entry, index) => (
        <div
          key={index}
          className={`cms-repeat-row ${reorder.rowClass(index)}`}
          {...reorder.rowProps(index)}
          onClick={() => setOpenIndex(index)}
        >
          <span className="cms-repeat-grip">
            <DragIcon size={11} />
          </span>
          <span className="cms-repeat-title">{titleOf(entry, index)}</span>
          <button
            className="ghost"
            title="Remove"
            onClick={(event) => {
              event.stopPropagation();
              removeAt(index);
            }}
          >
            <CloseIcon size={10} />
          </button>
          <ChevronRightIcon size={10} />
        </div>
      ))}
      <button className="cms-add" onClick={add}>
        <PlusIcon size={11} /> Add item
      </button>
      {openIndex !== undefined && value[openIndex] !== undefined && (
        <NestedItemDialog
          {...context}
          entry={value[openIndex]}
          title={titleOf(value[openIndex], openIndex)}
          onChange={(next) =>
            onChange(value.map((entry, index) => (index === openIndex ? next : entry)))
          }
          onDelete={() => removeAt(openIndex)}
          onClose={() => setOpenIndex(undefined)}
        />
      )}
    </div>
  );
}
export function useCmsDialog(onClose: () => void) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const open = document.querySelectorAll('.cms-modal-overlay');
      if (open[open.length - 1] !== overlayRef.current) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return overlayRef;
}
function NestedItemDialog({ entry, title, onChange, onDelete, onClose, ...context }: DialogProps) {
  const overlayRef = useCmsDialog(onClose);
  const value = toRecord(entry) ?? {};
  const fields = fieldsOf([entry]);
  return (
    <div
      ref={overlayRef}
      className="modal-overlay cms-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal cms-modal">
        <div className="modal-header cms-modal-header">
          <span>{title}</span>
          <button className="ghost" title="Close" onClick={onClose}>
            <CloseIcon size={12} />
          </button>
        </div>
        <div className="modal-body cms-modal-body">
          {fields.map((field) => (
            <CmsField
              key={field.key}
              {...context}
              label={field.label}
              type={field.type}
              value={value[field.key]}
              onChange={(next) => onChange({ ...value, [field.key]: next })}
            />
          ))}
          {fields.length === 0 && (
            <div className="cms-empty-inline">
              These items have no fields yet — add them in the collection's settings.
            </div>
          )}
        </div>
        <div className="modal-footer cms-modal-footer">
          <button className="ghost danger" onClick={onDelete}>
            <TrashIcon size={12} /> Delete
          </button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
