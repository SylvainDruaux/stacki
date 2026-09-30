import React from 'react';
import type { Box } from '../outlineBoxes';
import type { PreviewMessage } from '../previewMessages';
import { hoverIsSelection, onePerPlace } from '../outlineBoxes';
import { spacingBands } from '../spacingBands';
import {
  BranchIcon,
  CodeIcon,
  CommentIcon,
  CornerIcon,
  CustomElementIcon,
  ElementComponentIcon,
  LayoutIcon,
  RepeatIcon,
  TextIcon,
  astroAssetIcon,
  elementIcon,
} from '../ui/Icons';

export interface OverlayInfo {
  readonly label: string;
  readonly kind: 'component' | 'map' | 'element';
  readonly tag: string | undefined;
  readonly astroAsset: boolean;
  readonly dynamicTag: boolean;
  readonly nodeKind: string;
  readonly isLayout: boolean;
  readonly bound: boolean;
}

export interface SpacingHover {
  readonly kind: 'padding' | 'margin' | 'gap';
  readonly sides?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
}

// The measurements as the canvas frame reports them (src/previewMessages.ts): a
// path it could not measure, and a copy without spacing, are absent.
type RectsMessage = Extract<PreviewMessage, { readonly kind: 'rects' }>;
export type RectMap = RectsMessage['rects'];
export type SpacingMap = RectsMessage['spacing'];

interface PreviewOverlaysProps {
  readonly rects: RectMap;
  readonly spacing: SpacingMap;
  readonly spacingHover?: SpacingHover | undefined;
  readonly selPath: string | undefined;
  readonly selOcc: number | undefined;
  readonly hoverPath: string | undefined;
  readonly hoverOcc: number | undefined;
  readonly focusPath: string | undefined;
  readonly focusWhole: boolean;
  readonly overlayInfo?: (path: string) => OverlayInfo | undefined;
}

export function PreviewOverlays(props: PreviewOverlaysProps) {
  return (
    <>
      {!props.focusWhole && <FocusOverlays path={props.focusPath} rects={props.rects} />}
      <SpacingOverlays {...props} />
      <NodeOutlines {...props} />
    </>
  );
}

function FocusOverlays({
  path,
  rects,
}: {
  readonly path: string | undefined;
  readonly rects: RectMap;
}) {
  if (!path) {
    return undefined;
  }
  return onePerPlace(rects[path] ?? undefined).map((box, index) => (
    <div key={`focus-${index}`} className="node-focus" style={boxStyle(box)} />
  ));
}

function SpacingOverlays(props: PreviewOverlaysProps) {
  const { spacingHover, selPath: selectedPath } = props;
  if (!spacingHover || !selectedPath) {
    return undefined;
  }
  const boxes = props.rects[selectedPath] ?? [];
  const measurements = props.spacing[selectedPath] ?? [];
  const box = boxes[props.selOcc ?? 0] ?? boxes[0];
  const measurement = measurements[props.selOcc ?? 0] ?? measurements[0] ?? undefined;
  return spacingBands(box, measurement, spacingHover.kind, spacingHover.sides).map(
    (band, index) => (
      <div
        key={`sp-${band.side}-${index}`}
        className={`spacing-band is-${spacingHover.kind}`}
        style={boxStyle(band)}
      >
        <span className="spacing-band-label">
          {spacingHover.labels?.[band.side] ?? spacingLabel(band)}
        </span>
      </div>
    ),
  );
}

function NodeOutlines(props: PreviewOverlaysProps) {
  const outlines = outlineTargets(props);
  return outlines.flatMap((outline) => {
    const all = props.rects[outline.path];
    const info = props.overlayInfo?.(outline.path);
    if (!all || !info) {
      return [];
    }
    // No occurrence means the node, so draw one box per place. A number means
    // the specific repeated copy clicked on the canvas.
    const selected = outline.occ === undefined ? undefined : all[outline.occ];
    const boxes =
      outline.occ === undefined ? onePerPlace(all) : selected ? [selected] : all.slice(0, 1);
    return boxes.map((box, index) => (
      <div
        key={`${outline.type}-${index}`}
        className={`node-outline ${outline.type} ${info.kind}${info.bound ? ' bound' : ''}`}
        style={boxStyle(box)}
      >
        <span className={`node-outline-tag ${box.y < 20 ? 'inside' : ''}`}>
          {outlineIcon(info)}
          {info.label}
        </span>
      </div>
    ));
  });
}

interface OutlineTarget {
  readonly path: string;
  readonly type: 'hover' | 'sel';
  readonly occ: number | undefined;
}

function outlineTargets(props: PreviewOverlaysProps): readonly OutlineTarget[] {
  const targets: OutlineTarget[] = [];
  if (
    props.hoverPath &&
    !hoverIsSelection(
      { path: props.hoverPath, occ: props.hoverOcc },
      { path: props.selPath, occ: props.selOcc },
    )
  ) {
    targets.push({ path: props.hoverPath, type: 'hover', occ: props.hoverOcc });
  }
  if (props.selPath) {
    targets.push({ path: props.selPath, type: 'sel', occ: props.selOcc });
  }
  return targets;
}

function outlineIcon(info: OverlayInfo): React.ReactNode {
  const size = 11;
  if (info.isLayout) {
    return <LayoutIcon size={size} />;
  }
  if (info.nodeKind === 'component') {
    // Fragments and dynamic tags share element styling and the custom-tag icon.
    if (info.kind === 'element') {
      return <CustomElementIcon size={size} />;
    }
    return info.astroAsset ? (
      astroAssetIcon(info.label, size)
    ) : (
      <ElementComponentIcon size={size} />
    );
  }
  switch (info.nodeKind) {
    case 'map':
      return <RepeatIcon size={size} />;
    case 'cond':
      return <BranchIcon size={size} />;
    case 'branch':
      return <CornerIcon size={size} />;
    case 'text':
      return <TextIcon size={size} />;
    case 'comment':
      return <CommentIcon size={size} />;
    case 'expr':
    case 'raw':
      return <CodeIcon size={size} />;
    default:
      return info.tag ? elementIcon(info.tag, size) : <CustomElementIcon size={size} />;
  }
}

function boxStyle(box: Box): React.CSSProperties {
  return { left: box.x, top: box.y, width: box.w, height: box.h };
}

function spacingLabel(box: Box & { readonly side: string }): string {
  const horizontal = box.side === 'left' || box.side === 'right';
  return `${Math.round(horizontal ? box.w : box.h)}px`;
}
