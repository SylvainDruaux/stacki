import type {
  PageNode,
  PairedNode,
  ChunkGroupNode,
  Attr,
  ValueNode,
} from '../../../shared/page-node';
import type { FieldDefinition, PropValues } from './propRules';
import type { SetProp, SetProps } from './propAttributes';
import type { SetText, TagOption, TagFieldProps } from './propNodeEditors';
import type { SourceContext, FieldPosition } from './propBindings';
import type { RichContext, RichInsertAPI, InlineNode } from './RichContent';
import type { AssetDimensions } from '../../ui/AssetThumb';
import type { PickedAsset } from '../../ui/AssetField';
import { resolveAssetImport, readAssetDimensions } from '../../ipc/assetBridge';
import { MapEditor, TagField } from './propNodeEditors';
import PropField, { assetImportOf } from './PropField';
import { AttributesSection } from './propAttributes';
import { ConditionField, BindHandle, FieldDataPicker } from './propBindings';
import { createPropRules } from './propRules';
import { isFragmentNode } from '../../editor/liveClasses';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import React, { useEffect, useRef, useState } from 'react';
import { VOID_TAGS } from '../../editor/elementSchemas';
import { elementIcon } from '../../ui/Icons';
import AutoTextarea from '../../ui/AutoTextarea';
import { clickNote } from '../../ui/sound';
import { SoundHere } from '../../ui/soundScope';
import ExprInput from '../../ui/ExprInput';
import RichContent, { isInlineOnly } from './RichContent';
import { scopeChips, scopeCompletions } from '../../editor/dataSuggest';
import LinkField from './LinkField';
import {
  VariableTextSizeIcon,
  CustomElementIcon,
  ElementComponentIcon,
  astroAssetIcon,
  CommentIcon,
  CodeIcon,
  ChevronRightIcon,
  BranchIcon,
  CornerIcon,
} from '../../ui/Icons';

type SelectedNode = PageNode | { readonly kind: 'frontmatter'; readonly id: string };
type ElementNode = (PairedNode | ChunkGroupNode) & { readonly props?: PropValues };
export interface PropsPanelProps {
  readonly node?: SelectedNode | undefined;
  readonly focusClass?: number;
  readonly focusContent?: number;
  readonly isLayout?: boolean;
  readonly layouts?: readonly TagOption[];
  readonly currentLayoutName?: string;
  readonly onChangeLayout?: (name: string) => void;
  readonly schema?: readonly FieldDefinition[];
  readonly slotOptions?: readonly string[] | undefined;
  readonly takesSlotText?: boolean;
  readonly tagOptions?: readonly TagOption[];
  readonly projectClasses?: readonly string[];
  readonly allowAttrs?: boolean;
  readonly comment?: string;
  readonly onSetComment?: (value: string) => void;
  readonly loopContext?: RichContext | undefined;
  readonly bindContext?: RichContext | undefined;
  readonly linkContext?: React.ComponentProps<typeof LinkField>['context'] | undefined;
  readonly onSetProp: SetProp;
  readonly onSetProps?: SetProps;
  readonly onSetAssetProp?: (nodeId: string, name: string, picked: PickedAsset) => void;
  readonly onRenameProp: (previous: string, next: string) => void;
  readonly onChangeTag?: TagFieldProps['onChangeTag'];
  readonly onSetText: SetText;
  readonly onSetContent: (text: string) => void;
  readonly onSetInline: (nodes: readonly InlineNode[]) => void;
  readonly onOpenCode?: () => void;
  readonly onSetFrontmatter?: (source: string) => void;
  readonly frontmatterSource?: string;
  readonly onOpenSymbol?: (name: string) => void;
  readonly onToggleElse?: (value: boolean) => void;
  readonly projectPath?: string | undefined;
  readonly filePath?: string | undefined;
}
type NodePanelProps<Kind extends SelectedNode['kind']> = Omit<PropsPanelProps, 'node'> & {
  readonly node:
    | Extract<SelectedNode, { readonly kind: Kind }>
    | (Kind extends ValueNode['kind'] ? ValueNode : never);
};
interface ElementPropsPanelProps extends Omit<PropsPanelProps, 'node'> {
  readonly node: ElementNode;
  readonly dataContext: SourceContext;
  readonly stashRef: React.MutableRefObject<Map<string, PropValues>>;
}
interface SourceDimensionsOptions {
  readonly source: Attr | undefined;
  readonly projectPath: string | undefined;
  readonly filePath: string | undefined;
  readonly imports: unknown;
  readonly setSourceDimensions: (value: AssetDimensions) => void;
}

export { BindField } from './propBindings';

// Edits the props of the selected node. Fields come from the component's
// prop schema (interface Props / Astro.props destructure), plus any props
// already set on the node that aren't in the schema.
// A click inside a label is forwarded to its first control.
// These labels hold no field — the input is their sibling — but they do hold
// the bind dot and the `{}` toggle, so a press on the empty space beside a
// prop's name, or on the name itself, was silently pressing a button. On a
// field showing an expression that button means "use the control instead",
// which drops a value no control can hold: clicking next to the label cleared
// the prop. The label has nothing to activate, so it activates nothing.
//
// Attributes rows avoid labels; these keep the tag because styling depends on it.
const noLabelActivation = (event: React.MouseEvent<HTMLLabelElement>) => event.preventDefault();

// Whether the Settings group is open, remembered across selections. See where it
// is read, below.
let settingsGroupOpen = false;

export default function PropsPanel(props: PropsPanelProps) {
  // Held union values survive selections of text, loops, and other special nodes.
  const stashRef = useRef(new Map<string, PropValues>());
  return renderPropsPanel(props, stashRef);
}
function renderPropsPanel(
  props: PropsPanelProps,
  stashRef: React.MutableRefObject<Map<string, PropValues>>,
) {
  const { node } = props;
  if (!node) {
    return <EmptyPanel {...props} />;
  }
  switch (node.kind) {
    case 'frontmatter':
      return <FrontmatterPanel {...props} node={node} />;
    case 'expr':
      return <ExprPanel {...props} node={node} />;
    case 'raw-line':
      return <RawLinePanel {...props} node={node} />;
    case 'map':
      return <MapPanel {...props} node={node} />;
    case 'cond':
      return <CondPanel {...props} node={node} />;
    case 'branch':
      return <BranchPanel {...props} node={node} />;
    case 'comment':
      return <CommentPanel {...props} node={node} />;
    case 'raw':
      return <RawPanel {...props} node={node} />;
    case 'text':
      return <TextPanel {...props} node={node} />;
    case 'element':
    case 'component':
    case 'chunk-group':
      return (
        <ElementPropsPanel
          {...props}
          node={node}
          dataContext={panelDataContext(props)}
          stashRef={stashRef}
        />
      );
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}
function panelDataContext(props: PropsPanelProps): SourceContext {
  return {
    frontmatter: props.loopContext?.frontmatter || '',
    imports: props.frontmatterSource || '',
    onSetFrontmatter: props.onSetFrontmatter,
    onOpenSymbol: props.onOpenSymbol,
  };
}

// Element hooks have a stable lifetime across ordinary selections. Other node
// kinds mount their own editors, so selecting text cannot change this hook order.
function useElementProps(props: ElementPropsPanelProps) {
  const schema = props.schema ?? [];
  const layouts = props.layouts ?? [];
  assert(schema.length <= LIMITS.propSchemaFieldsMax, 'PropsPanel: schema limit exceeded');
  assert(
    Object.keys(props.node.props ?? {}).length <= LIMITS.attrsPerNodeMax,
    'PropsPanel: attribute limit exceeded',
  );
  assert(layouts.length <= LIMITS.scanEntriesMax, 'PropsPanel: layout limit exceeded');
  const layout = elementFieldLayout(props);
  const assets = useElementAssets(props);
  const rules = elementRules(props);
  const focus = useElementFocus(props);
  const settings = elementSettings(props, layout, rules.appliesNow);
  const dimensions = elementDimensionAction(props);
  const assetContext = {
    projectPath: props.projectPath,
    filePath: props.filePath,
    nodeName: props.node.name,
    onPickDimensions: dimensions.onPickDimensions,
    srcDims: assets.sourceDimensions,
    onSrcDimensions: assets.setSourceDimensions,
    siblingProps: props.node.props,
    srcKind: assets.sourceKind,
    onPickAsset: props.onSetAssetProp
      ? (name: string, picked: PickedAsset) => props.onSetAssetProp?.(props.node.id, name, picked)
      : undefined,
  };
  return {
    ...props,
    schema,
    layouts,
    ...layout,
    ...assets,
    ...rules,
    ...focus,
    ...settings,
    ...dimensions,
    assetContext,
  };
}
type ElementState = ReturnType<typeof useElementProps>;
function ElementPropsPanel(props: ElementPropsPanelProps) {
  const state = useElementProps(props);
  return <ElementPanelView state={state} />;
}
function ElementPanelView({ state }: { readonly state: ElementState }) {
  const {
    node,
    isLayout,
    currentLayoutName,
    schema,
    allowAttrs,
    extraProps,
    showContentField,
    rootRef,
  } = state;

  return (
    // Every button in the panel taps, and every dropdown under it sounds its
    // highlight — the same two the style panel makes, wired the same way. The
    // click handler sits here rather than on each button because a popover
    // portals to <body> and React still sends its events up the tree that
    // rendered it; SoundHere is what carries the same fact to the menus, which
    // cannot be reached by a DOM ancestor at all. Silent unless the setting is
    // on.
    <SoundHere>
      <div
        className="panel-section grow"
        ref={rootRef}
        style={{ flex: '1 1 50%', overflow: 'hidden' }}
        onClick={(event) => {
          const button =
            event.target instanceof Element ? event.target.closest('button') : undefined;
          if (button && !button.disabled) {
            clickNote();
          }
        }}
      >
        <div className="props-title">
          {isFragmentNode(node) ? (
            <CustomElementIcon size={16} className="props-title-icon" />
          ) : node.kind === 'element' ? (
            elementIcon(node.name, 16, 'props-title-icon')
          ) : 'astroAsset' in node && node.astroAsset ? (
            astroAssetIcon(node.name, 16, 'props-title-icon')
          ) : (
            <ElementComponentIcon size={16} className="props-title-icon" />
          )}
          {isLayout ? currentLayoutName || node.name : node.name}
          {isLayout && <span className="badge">layout</span>}
        </div>
        <div className="panel-body" style={{ padding: 0 }}>
          {/* A slot isn't a tag choice — it's where the caller's content plugs
            in. Renaming it would silently turn it into an empty element. */}

          <ElementContent state={state} />
          <ElementLooseText state={state} />
          <ElementSchemaFields state={state} />
          <ElementExtraFields state={state} />
          {/* Class, attributes, the comment and slot are the same four fields on
            every node, and they're the ones you reach for least — folded away
            behind one heading so a component's own props are what the panel
            opens on. Shut by default; the choice sticks while the app is up. */}
          <ElementSettingsHeader state={state} />
          <ElementSettings state={state} />
          {!isLayout &&
            !allowAttrs &&
            schema.length === 0 &&
            extraProps.length === 0 &&
            !showContentField && (
              <div className="props-empty">
                {node.kind === 'element'
                  ? 'This HTML element has no attributes set.'
                  : 'This component declares no props (add an interface Props or ' +
                    'an Astro.props destructure to expose some).'}
              </div>
            )}
        </div>
      </div>
    </SoundHere>
  );
}

// The HTML comment directly above this node — the note the navigator shows
// beside its name. Written as you type, so that label keeps up with the field:
// the write is coalesced and the save debounced (see setComment), so a burst of
// typing is still one save and one undo step. Clearing the field removes the
// comment node.
function CommentField({
  value,
  onCommit,
}: {
  readonly value?: string | undefined;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  // Re-sync when the model changes underneath (undo, external edit) — but not
  // while typing, or the caret would jump.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value ?? '');
    }
  }, [value]);
  const commit = (text = draft) => {
    const next = text.trim();
    if (next !== (value ?? '').trim()) {
      onCommit(next);
    }
  };
  return (
    <div className="props-field props-comment">
      <label onClick={noLabelActivation}>
        <span className="prop-label">
          <CommentIcon size={12} className="prop-label-icon" />
          Comment
        </span>
      </label>
      <AutoTextarea
        minRows={1}
        placeholder="Note above this element…"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          commit(event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
      />
    </div>
  );
}

function EmptyPanel(props: PropsPanelProps) {
  const {} = props;

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%' }}>
      <div className="panel-header">
        <h2>Settings</h2>
      </div>
      <div className="props-empty">Select a component to edit its props.</div>
    </div>
  );
}
function FrontmatterPanel(props: NodePanelProps<'frontmatter'>) {
  const { onOpenCode } = props;

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="props-title">
        <CodeIcon size={14} className="props-title-icon" />
        Frontmatter
      </div>
      <div className="props-field" style={{ marginTop: 4 }}>
        <button className="primary" style={{ width: '100%' }} onClick={onOpenCode}>
          <CodeIcon size={13} /> Edit code
        </button>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
          Imports, constants, and data for this page. Opens in a floating editor you can move and
          resize while working with the canvas.
        </div>
      </div>
    </div>
  );
}
function ExprPanel(props: NodePanelProps<'expr'>) {
  const { node, loopContext, bindContext, onSetText } = props;
  const scope = scopeCompletions(bindContext || loopContext || {});

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>Expression</h2>
      </div>
      <div className="props-field" style={{ marginTop: 8 }}>
        <label onClick={noLabelActivation}>
          <span className="prop-label">Code</span>
        </label>
        <ExprInput
          key={node.id}
          value={node.value}
          syncValue={node.value}
          completions={scope}
          onCommit={(next) => next !== node.value && onSetText(next)}
        />
      </div>
    </div>
  );
}
function RawLinePanel(props: NodePanelProps<'raw-line'>) {
  const { node, onSetText } = props;

  const isDoctype = /^<!doctype/i.test(node.value || '');
  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>{isDoctype ? 'Doctype' : 'Source line'}</h2>
      </div>
      <div className="props-field" style={{ marginTop: 8 }}>
        <label onClick={noLabelActivation}>
          <span className="prop-label">
            <CodeIcon size={12} className="prop-label-icon" />
            Line
          </span>
        </label>
        <AutoTextarea
          key={node.id}
          minRows={1}
          value={node.value}
          spellCheck={false}
          style={{ fontFamily: 'var(--mono)' }}
          onChange={(event) => onSetText(event.target.value)}
        />
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
          {isDoctype
            ? 'Written out verbatim at the top of the page. ' +
              'Not an element — it has no tag or attributes.'
            : 'Written out verbatim, exactly as typed.'}
        </div>
      </div>
    </div>
  );
}
function MapPanel(props: NodePanelProps<'map'>) {
  const { node, loopContext, bindContext, onSetText } = props;

  const buildDataContext = () => panelDataContext(props);

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>Loop</h2>
      </div>
      <MapEditor
        key={node.id}
        node={node}
        loopContext={loopContext}
        bindContext={bindContext || loopContext}
        dataContext={buildDataContext()}
        onSetText={onSetText}
      />
    </div>
  );
}
function CondPanel(props: NodePanelProps<'cond'>) {
  const { node, loopContext, bindContext, onSetText, onToggleElse } = props;
  const scope = scopeCompletions(bindContext || loopContext || {});
  const scopeNames = new Set(scope.map((completion) => completion.label.split('.')[0] ?? ''));
  const chipsInScope = (text: string) => scopeChips(text, scopeNames);

  const hasElse = (node.children || []).length > 1;
  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>Condition</h2>
      </div>
      <div className="props-field" style={{ marginTop: 8 }}>
        <label onClick={noLabelActivation}>
          <span className="prop-label">
            <BranchIcon size={12} className="prop-label-icon" />
            Show when
          </span>
        </label>
        <ConditionField
          key={node.id}
          test={node.test}
          scope={scope}
          chipsOf={chipsInScope}
          bindContext={bindContext || loopContext}
          onSetText={onSetText}
        />
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
          True renders <strong>then</strong>
          {hasElse ? (
            <>
              , false renders <strong>else</strong>.
            </>
          ) : (
            '; nothing renders otherwise.'
          )}{' '}
          Drop elements into either branch in the navigator.
        </div>
      </div>
      {onToggleElse && (
        <div className="props-field">
          <button style={{ width: '100%' }} onClick={() => onToggleElse(!hasElse)}>
            {hasElse ? 'Remove else branch' : 'Add else branch'}
          </button>
        </div>
      )}
    </div>
  );
}
function BranchPanel(props: NodePanelProps<'branch'>) {
  const { node } = props;

  const isElse = node.name === 'else';
  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="props-title">
        <CornerIcon size={14} className="props-title-icon" />
        {isElse ? 'else' : 'then'}
      </div>
      <div className="props-empty">
        {isElse ? 'Rendered when the condition is false.' : 'Rendered when the condition is true.'}
      </div>
    </div>
  );
}
function CommentPanel(props: NodePanelProps<'comment'>) {
  const { node, onSetText } = props;

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>Comment</h2>
      </div>
      <div className="props-field" style={{ marginTop: 8 }}>
        <label onClick={noLabelActivation}>
          <span className="prop-label">
            <CommentIcon size={12} className="prop-label-icon" />
            Comment
          </span>
        </label>
        <AutoTextarea
          minRows={3}
          value={node.value}
          onChange={(event) => onSetText(event.target.value)}
        />
      </div>
    </div>
  );
}
function RawPanel(props: NodePanelProps<'raw'>) {
  const {
    node,
    loopContext,
    bindContext,
    onSetProp,
    onSetProps,
    onRenameProp,
    onOpenCode,
    projectPath,
  } = props;

  const language = node.name === 'style' ? 'css' : 'javascript';
  const attrs = Object.keys(node.props || {});
  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="props-title">
        <CodeIcon size={14} className="props-title-icon" />
        {`<${node.name}>`}
      </div>
      <div style={{ flexShrink: 0 }}>
        {/* `class` is not filtered out the way it is for an element: an
              element keeps a dedicated class field (the selector well drives
              its styling), and these have no such field — so here it is an
              attribute like any other, and adding one is how you get it. */}
        <AttributesSection
          node={node}
          names={attrs}
          projectPath={projectPath}
          bindContext={bindContext || loopContext}
          onSetProp={onSetProp}
          onSetProps={onSetProps}
          onRenameProp={onRenameProp}
        />
      </div>
      <div className="props-field" style={{ marginTop: 4 }}>
        <button className="primary" style={{ width: '100%' }} onClick={onOpenCode}>
          <CodeIcon size={13} /> Edit code
        </button>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
          Opens the {language} in a floating editor you can move and resize while working with the
          canvas.
        </div>
      </div>
    </div>
  );
}
function TextPanel(props: NodePanelProps<'text'>) {
  const { node, onSetText } = props;

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>Text</h2>
      </div>
      <div className="props-field" style={{ marginTop: 8 }}>
        <label onClick={noLabelActivation}>
          <span className="prop-label">
            <VariableTextSizeIcon size={12} className="prop-label-icon" />
            Content
          </span>
        </label>
        <AutoTextarea
          minRows={3}
          value={node.value}
          onChange={(event) => onSetText(event.target.value)}
        />
      </div>
    </div>
  );
}
function sourceKind(
  source: Attr | undefined,
  imports: unknown,
): 'svg' | 'public' | 'remote' | 'asset' | undefined {
  if (!source || source.type === 'bare') {
    return undefined;
  }
  const isSVG = (value: string) => /\.svg(\?|#|$)/i.test(value);
  if (source.type === 'string') {
    const value = source.value;
    if (!value) {
      return undefined;
    }
    if (isSVG(value)) {
      return 'svg';
    }
    return /^(https?:)?\/\//.test(value) || value.startsWith('data:') ? 'remote' : 'public';
  }
  const binding = assetImportOf(source.value, imports);
  if (!binding) {
    return undefined;
  }
  return isSVG(binding.spec) ? 'svg' : 'asset';
}
function useSourceDimensions({
  source,
  projectPath,
  filePath,
  imports,
  setSourceDimensions,
}: SourceDimensionsOptions) {
  // Primitive dependencies also refresh dimensions when an import changes in place.
  const sourceType = source?.type;
  const sourceValue = source?.type === 'bare' ? undefined : source?.value;
  useEffect(() => {
    if (!sourceValue || !projectPath) {
      return undefined;
    }
    let live = true;
    const fromRel = async (rel: string) => {
      const result = await readAssetDimensions(projectPath, rel);
      if (live && result.ok && result.value) {
        setSourceDimensions(result.value);
      }
    };
    if (sourceType === 'string') {
      if (/^(https?:)?\/\//.test(sourceValue) || sourceValue.startsWith('data:')) {
        return undefined;
      }
      void fromRel('public/' + sourceValue.replace(/^\//, ''));
    } else {
      const binding = assetImportOf(sourceValue, imports);
      if (!binding || !filePath) {
        return undefined;
      }
      void resolveAssetImport(projectPath, filePath, binding.spec).then((result) => {
        if (live && result.ok) {
          return fromRel(result.rel);
        }
        return undefined;
      });
    }
    return () => {
      live = false;
    };
  }, [sourceType, sourceValue, projectPath, filePath, imports, setSourceDimensions]);
}

function elementFieldLayout(props: ElementPropsPanelProps) {
  const { node, schema = [], slotOptions, takesSlotText, allowAttrs } = props;
  assert((node.children?.length ?? 0) <= LIMITS.treeNodesMax, 'PropsPanel: child limit exceeded');
  const schemaNames = new Set(schema.map((entry) => entry.name));

  // The slot field renders in one stable spot whether or not the attribute
  // is currently set — hover-previewing a value must not remount the field
  // (that would close the dropdown mid-hover).
  const showSlotField =
    Array.isArray(slotOptions) &&
    slotOptions.some((slot) => slot !== 'default') &&
    !schemaNames.has('slot');
  let extraProps = Object.keys(node.props || {}).filter(
    (key) => !schemaNames.has(key) && !(showSlotField && key === 'slot'),
  );
  // With a free-form Attributes section, unknown attrs live there instead of
  // as individual fields — except class and style, which keep dedicated ones.
  let attrNames: string[] = [];
  if (allowAttrs) {
    attrNames = extraProps.filter((key) => key !== 'class' && key !== 'style' && key !== 'slot');
    // `slot` is sorted last so a hand-written one lands where the picker's
    // does — directly above the comment — instead of in among the props.
    extraProps = extraProps
      .filter((key) => key === 'class' || key === 'slot')
      .sort((left, right) => (left === 'slot' ? 1 : right === 'slot' ? -1 : 0));
  }

  // Content field: shown when the children are inline-only (text plus simple
  // tags like <strong>/<em>), edited with the rich inline editor. An element
  // that's still empty — a just-inserted <h1> or <p> — has no inline children
  // to detect, so offer the editor there too; otherwise there'd be no way to
  // type its first words. Void tags can't hold content at all.
  // A component with a default <slot/> holds content exactly the way an
  // element does. Without this an empty one — everything the insert palette
  // adds, since a fresh instance is self-closing — has no Content field, and
  // so no way to be given its first words.
  const isEmpty = node.children === undefined || node.children.length === 0;
  const canHoldText =
    (node.kind === 'element' && !VOID_TAGS.has(String(node.name).toLowerCase())) || !!takesSlotText;
  const showContentField = isInlineOnly(node.children) || (isEmpty && canHoldText);
  // HTML lets a node hold text *and* elements — `<div>Intro<Button/></div>` is
  // ordinary markup — but the rich editor above only covers all-inline
  // children. Rather than leave the text unreachable from the node that owns
  // it, mixed children get a plain field over the loose text alone; the
  // element children it sits among are left exactly where they are.
  const looseText =
    !isEmpty && (node.children || []).find((child): child is ValueNode => child.kind === 'text');
  const showLooseTextField = !showContentField && canHoldText && !isEmpty;
  // <slot> does take children, but they're the fallback Astro renders only
  // when the caller passes nothing — labelling it "Content" reads as if it
  // were what shows on the page.
  const isSlot = node.kind === 'element' && node.name === 'slot';

  // Where a prop's {expression} can be pointing, and how to write that source
  // back — lets an expression field edit the declaration behind it.

  return {
    showSlotField,
    extraProps,
    attrNames,
    showContentField,
    showLooseTextField,
    looseText,
    isSlot,
  };
}

function useElementAssets(props: ElementPropsPanelProps) {
  const { node, projectPath, filePath, dataContext } = props;
  // Astro's <Image> (and any component that forwards to it) rejects a public/
  // path with no width and height — "MissingImageDimension" takes the page
  // down. The picker already knows the size it just showed, so an image pick
  // fills those in when the component has them. One edit, one undo.
  // The size of the image currently in `src`. width/height fall back to it
  // when unset, so it is what those fields should show as their placeholder.
  const [sourceDimensions, setSourceDimensions] = useState<AssetDimensions | undefined>(undefined);
  useEffect(() => setSourceDimensions(undefined), [node?.id]);

  // …and read them from the file as well. The card above reports what its
  // thumbnail decoded, which only happens if a thumbnail rendered — so a
  // source the picker couldn't preview (or a field the eye never reached)
  // left width/height claiming the size was "inferred". Astro infers nothing
  // for a local asset: it reads the real size out of the file, and so do we.
  const source = node.props?.['src'];
  const kind = sourceKind(source, dataContext.imports);
  useSourceDimensions({
    source,
    projectPath,
    filePath,
    imports: dataContext.imports,
    setSourceDimensions,
  });

  return { sourceDimensions, setSourceDimensions, sourceKind: kind };
}

function elementRules(props: ElementPropsPanelProps) {
  const { node, schema = [], onSetProp, onSetProps, stashRef } = props;
  // Changing the discriminant changes which props exist. The ones that no
  // longer apply are removed, not just hidden — leaving them in the markup
  // means the file carries props the component will ignore, and they would
  // reappear the moment the discriminant went back. Same edit, so it is one
  // undo, and the value is recoverable that way.
  // Values a discriminant switch took away, per node, kept only while the
  // panel is up: flicking variant → full-width → constrained should hand
  // `sizes` back, but reopening the project shouldn't resurrect it.
  const { appliesNow, branchDefault, narrowOptions, cascade } = createPropRules(
    schema,
    node.props || {},
  );
  const setPropCascading: SetProp = (fieldName, value, immediate) => {
    const held = stashRef.current.get(node.id);
    if (!held) {
      assert(stashRef.current.size < LIMITS.treeNodesMax, 'PropsPanel: stash node limit exceeded');
    }
    const { patch, stash } = cascade({ fieldName, value, stash: held || {} });
    stashRef.current.set(node.id, stash);
    if (Object.keys(patch).length === 1 || !onSetProps) {
      onSetProp(fieldName, value, immediate);
      return;
    }
    onSetProps(node.id, patch);
  };
  return { appliesNow, branchDefault, narrowOptions, setPropCascading };
}
function useElementFocus(props: ElementPropsPanelProps) {
  const { focusClass, focusContent } = props;
  // The data picker over the Content field, and the way into the editor's
  // caret once something is chosen.
  const [contentPicker, setContentPicker] = useState<FieldPosition | undefined>(undefined);
  // A ref prop: RichContent fills it with its caret API while it is mounted.
  const contentInsertRef = useRef<RichInsertAPI | undefined>(undefined);

  // Settings survives ordinary selections through hook state and special-node
  // selections through this module's value, because those unmount the element panel.
  const [settingsOpen, setSettingsOpenState] = useState(settingsGroupOpen);
  const setSettingsOpen = (next: React.SetStateAction<boolean>) => {
    settingsGroupOpen = typeof next === 'function' ? next(settingsGroupOpen) : next;
    setSettingsOpenState(settingsGroupOpen);
  };

  // ⌘Enter, forwarded from App as a counter: open Settings and put the caret
  // in the class field. Two steps, because the field doesn't exist to focus
  // until the render that opens the group has happened.
  const [wantClassFocus, setWantClassFocus] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusClass) {
      return;
    }
    setSettingsOpen(true);
    setWantClassFocus(true);
  }, [focusClass]);
  useEffect(() => {
    if (!wantClassFocus || !settingsOpen) {
      return;
    }
    setWantClassFocus(false);
    const input = rootRef.current?.querySelector<HTMLElement>('.class-input-field');
    if (!input) {
      return;
    }
    input.focus();
    input.closest('.props-field')?.scrollIntoView({ block: 'nearest' });
  }, [wantClassFocus, settingsOpen]);

  // Double-clicking text on the canvas, forwarded the same way: caret in the
  // Content field, at the end of what's already written. No group to open
  // first — Content sits at the top of the panel — but still an effect, so
  // the field belongs to the node that was double-clicked and not the one
  // that was selected a render ago.
  useEffect(() => {
    if (!focusContent) {
      return;
    }
    const field = rootRef.current?.querySelector<HTMLElement>('.rich-content');
    if (!field) {
      return;
    }
    field.focus();
    // Land after the last character rather than at the top: the gesture means
    // "let me write here", and a caret parked before the first word makes
    // typing insert in front of the sentence.
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    field.closest('.props-field')?.scrollIntoView({ block: 'nearest' });
  }, [focusContent]);

  return {
    contentPicker,
    setContentPicker,
    contentInsertRef,
    settingsOpen,
    setSettingsOpen,
    rootRef,
  };
}

function elementSettings(
  props: ElementPropsPanelProps,
  layout: ReturnType<typeof elementFieldLayout>,
  appliesNow: ReturnType<typeof createPropRules>['appliesNow'],
) {
  const {
    node,
    isLayout,
    layouts = [],
    onChangeLayout,
    schema = [],
    allowAttrs,
    comment,
    onSetComment,
    onChangeTag,
  } = props;
  const { isSlot, showSlotField, attrNames } = layout;
  const classField: FieldDefinition | undefined =
    schema.find((field) => field.name === 'class' && appliesNow(field)) ||
    (node.props?.['class'] !== undefined ? { name: 'class', type: 'string' } : undefined);
  // Inline styles, directly under the class field. Anything that renders a
  // real element has one, whatever it declares; a component only when it
  // takes the attribute (…rest) or already carries it, so the panel never
  // offers a prop the component would ignore. Always the CSS editor, even
  // when a component types it `style?: string`.
  const styleField: FieldDefinition | undefined =
    allowAttrs || node.props?.['style'] !== undefined
      ? { ...(schema.find((field) => field.name === 'style') || {}), name: 'style', type: 'style' }
      : undefined;
  // The page's wrapper switches through the same Tag field as everything else
  // — it just answers with a layout rather than a tag, so its list is the
  // project's layouts and the change goes through the import rewrite.
  const layoutTag = isLayout && !!onChangeLayout && layouts.length > 0;
  const changeToLayout = (name: string) => {
    // The wrapper is an import, not markup: a name no layout file provides
    // can't be written, so the field puts the old one back.
    if (!layouts.some((layout) => layout.name === name)) {
      return false;
    }
    onChangeLayout?.(name);
    return true;
  };
  // Anything with a real tag or component name — not a loop, a condition, a
  // comment or a slot (switching a slot away would be a one-way door).
  const showTagField =
    !isSlot &&
    (layoutTag ||
      (!!onChangeTag && !isLayout && (node.kind === 'element' || node.kind === 'component')));
  const hasSettings =
    showTagField ||
    !!classField ||
    !!styleField ||
    allowAttrs ||
    showSlotField ||
    !!(onSetComment && (node.kind === 'element' || node.kind === 'component'));
  // How many of them actually carry something, shown on the closed header.
  const settingsCount =
    (node.props?.['class'] !== undefined ? 1 : 0) +
    (node.props?.['style'] !== undefined ? 1 : 0) +
    attrNames.length +
    (comment ? 1 : 0) +
    (node.props?.['slot'] !== undefined ? 1 : 0);
  return {
    classField,
    styleField,
    layoutTag,
    changeToLayout,
    showTagField,
    hasSettings,
    settingsCount,
  };
}
function elementDimensionAction(props: ElementPropsPanelProps) {
  const { node, schema = [], onSetProps } = props;
  const onPickDimensions = (fieldName: string, dims: AssetDimensions) => {
    if (!onSetProps || !node || !dims?.w || !dims?.h) {
      return;
    }
    if (!/^(src|poster)$/i.test(fieldName)) {
      return;
    }
    const takes = (propName: string) => (schema || []).some((field) => field.name === propName);
    const patch: Record<string, Attr> = {};
    if (takes('width')) {
      patch['width'] = { type: 'expr', value: String(dims.w) };
    }
    if (takes('height')) {
      patch['height'] = { type: 'expr', value: String(dims.h) };
    }
    if (Object.keys(patch).length) {
      onSetProps(node.id, patch);
    }
  };

  return { onPickDimensions };
}

function ElementContent({ state }: { readonly state: ElementState }) {
  const {
    node,
    loopContext,
    bindContext,
    onSetInline,
    showContentField,
    isSlot,
    contentPicker,
    setContentPicker,
    contentInsertRef,
  } = state;
  return (
    <>
      {showContentField && (
        <div className="props-field" key="content">
          <label onClick={noLabelActivation}>
            <span className="prop-label">
              <VariableTextSizeIcon size={12} className="prop-label-icon" />
              {isSlot ? 'Fallback' : 'Content'}
            </span>
            {/* Text can hold data too — the same handle, the same picker,
                  dropping the same chip in at the caret. Without it, putting a
                  field into a sentence means knowing to type
                  `{post.data.title}`. */}
            <BindHandle
              active={!!contentPicker}
              onOpen={(host) => elementOpenContentPicker(state, host ?? undefined)}
            />
          </label>
          <RichContent
            key={node.id}
            nodes={isInlineOnly(node.children) ? node.children : []}
            {...richContextProp(bindContext || loopContext)}
            insertRef={contentInsertRef}
            onChange={onSetInline}
          />
          {contentPicker && (
            <FieldDataPicker
              pos={contentPicker}
              bindContext={bindContext || loopContext}
              onPick={(path) => {
                setContentPicker(undefined);
                contentInsertRef.current?.insert(path);
              }}
              onClose={() => setContentPicker(undefined)}
            />
          )}
          {isSlot && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-faint)',
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              Shown only when whatever uses this component passes nothing for the slot.
            </div>
          )}
        </div>
      )}
    </>
  );
}

// RichContent spells a missing context by leaving the prop out.
function richContextProp(context: RichContext | undefined): { readonly bindContext?: RichContext } {
  return context === undefined ? {} : { bindContext: context };
}

function ElementLooseText({ state }: { readonly state: ElementState }) {
  const { node, onSetContent, showLooseTextField, looseText } = state;
  return (
    <>
      {showLooseTextField && (
        <div className="props-field" key="loose-text">
          <label onClick={noLabelActivation}>
            <span className={`prop-label${looseText ? ' set' : ''}`}>
              <VariableTextSizeIcon size={12} className="prop-label-icon" />
              Content
            </span>
          </label>
          <AutoTextarea
            key={node.id}
            minRows={2}
            value={looseText ? looseText.value : ''}
            placeholder="Text alongside the children below"
            onChange={(event) => onSetContent(event.target.value)}
          />
        </div>
      )}
    </>
  );
}

function ElementSchemaFields({ state }: { readonly state: ElementState }) {
  const {
    node,
    schema,
    slotOptions,
    projectClasses,
    loopContext,
    bindContext,
    linkContext,
    dataContext,
    appliesNow,
    branchDefault,
    narrowOptions,
    setPropCascading,
    styleField,
    assetContext,
  } = state;
  return (
    <>
      {schema
        .filter(appliesNow)
        .filter((field) => field.name !== 'class' && !(styleField && field.name === 'style'))
        .map((field) => (
          <PropField
            key={field.name}
            nodeKey={node.id}
            bindContext={bindContext || loopContext}
            field={narrowOptions(field)}
            branchDefault={branchDefault(field.name)}
            value={node.props?.[field.name]}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            assetContext={assetContext}
            linkContext={linkContext}
            dataContext={dataContext}
            onChange={(next, immediate) => setPropCascading(field.name, next, immediate)}
          />
        ))}
    </>
  );
}

function ElementExtraFields({ state }: { readonly state: ElementState }) {
  const {
    node,
    slotOptions,
    projectClasses,
    loopContext,
    bindContext,
    linkContext,
    onSetProp,
    dataContext,
    extraProps,
    styleField,
    assetContext,
  } = state;
  return (
    <>
      {extraProps
        .filter((name) => name !== 'class' && !(styleField && name === 'style'))
        .map((name) => (
          <PropField
            key={name}
            nodeKey={node.id}
            bindContext={bindContext || loopContext}
            field={{ name, type: 'other' }}
            value={node.props?.[name]}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            assetContext={assetContext}
            linkContext={linkContext}
            dataContext={dataContext}
            onChange={(next, immediate) => onSetProp(name, next, immediate)}
          />
        ))}
    </>
  );
}

function ElementSettingsHeader({ state }: { readonly state: ElementState }) {
  const { settingsOpen, setSettingsOpen, hasSettings, settingsCount } = state;
  return (
    <>
      {hasSettings && (
        <div className={`props-group ${settingsOpen ? 'open' : ''}`}>
          <button
            type="button"
            className="props-group-head"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <span className="props-group-name">Settings</span>
            {/* Something set in there is worth knowing about without opening
                  it — otherwise a class you gave the element looks lost. */}
            {!settingsOpen && settingsCount > 0 && (
              <span className="props-group-count">{settingsCount}</span>
            )}
            <ChevronRightIcon size={11} className="props-group-chevron" />
          </button>
        </div>
      )}
    </>
  );
}

function ElementTag({ state }: { readonly state: ElementState }) {
  const {
    node,
    layouts,
    currentLayoutName,
    tagOptions,
    onChangeTag,
    layoutTag,
    changeToLayout,
    showTagField,
  } = state;
  return (
    <>
      {showTagField && (
        <TagField
          key="tag"
          // A layout shows (and offers) the layout it resolves to, not the
          // local name the page imported it under — that name is a detail of
          // this page, while the file is what you're choosing between.
          tag={layoutTag ? currentLayoutName || node.name : node.name}
          options={
            layoutTag
              ? layouts.map((option) => ({ name: option.name, kind: 'layout' }))
              : tagOptions
          }
          onChangeTag={layoutTag ? changeToLayout : (name) => onChangeTag?.(name)}
        />
      )}
    </>
  );
}

function ElementClass({ state }: { readonly state: ElementState }) {
  const {
    node,
    slotOptions,
    projectClasses,
    loopContext,
    bindContext,
    linkContext,
    dataContext,
    setPropCascading,
    classField,
    assetContext,
  } = state;
  return (
    <>
      {classField && (
        <PropField
          key="class"
          nodeKey={node.id}
          bindContext={bindContext || loopContext}
          field={classField}
          value={node.props?.['class']}
          slotOptions={slotOptions}
          projectClasses={projectClasses}
          assetContext={assetContext}
          linkContext={linkContext}
          dataContext={dataContext}
          onChange={(next, immediate) => setPropCascading('class', next, immediate)}
        />
      )}
    </>
  );
}

function ElementStyle({ state }: { readonly state: ElementState }) {
  const {
    node,
    slotOptions,
    projectClasses,
    loopContext,
    bindContext,
    linkContext,
    dataContext,
    setPropCascading,
    styleField,
  } = state;
  return (
    <>
      {styleField && (
        <PropField
          // The editor is mounted with its text and doesn't re-sync, so it
          // has to be a new one per node — otherwise selecting a sibling
          // would leave the previous element's CSS sitting in the field.
          key={`style:${node.id}`}
          nodeKey={node.id}
          bindContext={bindContext || loopContext}
          field={styleField}
          value={node.props?.['style']}
          slotOptions={slotOptions}
          projectClasses={projectClasses}
          linkContext={linkContext}
          dataContext={dataContext}
          onChange={(next, immediate) => setPropCascading('style', next, immediate)}
        />
      )}
    </>
  );
}

function ElementAttributes({ state }: { readonly state: ElementState }) {
  const {
    node,
    allowAttrs,
    loopContext,
    bindContext,
    onSetProp,
    onSetProps,
    onRenameProp,
    projectPath,
    attrNames,
  } = state;
  return (
    <>
      {allowAttrs && (
        <AttributesSection
          key="attrs"
          node={node}
          names={attrNames}
          projectPath={projectPath}
          bindContext={bindContext || loopContext}
          onSetProp={onSetProp}
          onSetProps={onSetProps}
          onRenameProp={onRenameProp}
        />
      )}
    </>
  );
}

function ElementSlot({ state }: { readonly state: ElementState }) {
  const { node, slotOptions, onSetProp, showSlotField } = state;
  return (
    <>
      {showSlotField && (
        <PropField
          key="slot"
          field={{ name: 'slot', type: 'slot' }}
          value={node.props?.['slot']}
          slotOptions={slotOptions}
          onChange={(next, immediate) => onSetProp('slot', next, immediate)}
        />
      )}
    </>
  );
}

function ElementSettings({ state }: { readonly state: ElementState }) {
  const { node, comment, onSetComment, settingsOpen, hasSettings } = state;
  return (
    <>
      {hasSettings && settingsOpen && (
        <>
          {/* First in Settings, and on every node: the tag is what the node IS,
            and it's how a <div> becomes a component (or a component becomes a
            <div>) without going to the code. */}
          <ElementTag state={state} />
          <ElementClass state={state} />
          <ElementStyle state={state} />
          <ElementAttributes state={state} />
          {onSetComment && (node.kind === 'element' || node.kind === 'component') && (
            <CommentField key="comment" value={comment} onCommit={onSetComment} />
          )}
          {/* `slot` is not a prop of this component — it tells the PARENT where to
            put it — so it sits apart from the component's own props, last of
            all, below even the comment. */}
          <ElementSlot state={state} />
        </>
      )}
    </>
  );
}

function elementOpenContentPicker(state: ElementState, host: Element | undefined): void {
  if (state.contentPicker) {
    state.setContentPicker(undefined);
    return;
  }
  const rectangle = host?.getBoundingClientRect();
  if (!rectangle) {
    return;
  }
  state.setContentPicker({
    left: rectangle.left,
    top: Math.min(rectangle.bottom + 4, Math.max(60, window.innerHeight - 340)),
    width: Math.max(rectangle.width, 240),
  });
}
