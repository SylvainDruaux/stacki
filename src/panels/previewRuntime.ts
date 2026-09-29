import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { RectMap, SpacingMap } from './PreviewOverlays';
import type { PreviewDevice } from './PreviewToolbar';
import type { PreviewMessage } from '../previewMessages';
import { parsePreviewMessage } from '../previewMessages';
import { sameCopy } from '../outlineBoxes';
import { forgetComputedColors } from '../style-panel/lib/computed-color';
import { forgetComputedStyles } from '../style-panel/lib/computed-style';
import { setModifiers } from '../style-panel/lib/host';
import { noteCanvasReady, receiveCanvasReply, setCanvasFrame } from '../canvasQuery';
import type { Digest } from '../../shared/brand';
import {
  judgeEventToken,
  type PreviewRender,
  type PreviewVerdict,
} from '../../shared/preview-token';

/** Whether a click or double-click on the canvas may select what it names
 * (src/previewGate.ts). Hover needs only the token to be the latest. */
export type JudgeCanvasEvent = (
  token: Digest | undefined,
  render: PreviewRender | undefined,
) => Promise<PreviewVerdict>;

export interface PreviewRuntimeProps {
  readonly selPath: string | null;
  readonly navHoverPath?: string | null;
  readonly focusPath?: string | null;
  readonly focusOcc?: number | null;
  readonly pathScope?: string;
  readonly refreshKey?: string | number;
  readonly device: PreviewDevice;
  readonly onSelectPath?: (path: string | null, info: { readonly outside: boolean }) => void;
  readonly onOpenPath?: (path: string | null, occurrence: number) => void;
  readonly onSelectedClasses?: (classes: readonly string[]) => void;
  readonly onRenderedPaths?: (paths: readonly string[]) => void;
  readonly onNodeStates?: (states: {
    readonly hidden: readonly string[];
    readonly inert: readonly string[];
  }) => void;
  readonly onNodeClasses?: (classes: Readonly<Record<string, readonly string[]>>) => void;
  /** The preview-token gate (step 7): an event from a stale rendering never
   * selects, and the refusal is shown, never swallowed. */
  readonly judgeEvent: JudgeCanvasEvent;
  readonly onStaleEvent: (verdict: Extract<PreviewVerdict, { readonly tag: 'stale' }>) => void;
}

export interface PreviewRuntime {
  readonly iframeRef: React.RefObject<HTMLIFrameElement>;
  readonly rects: RectMap;
  readonly spacing: SpacingMap;
  readonly selOcc: number | null;
  readonly hoverPath: string | null;
  readonly hoverOcc: number | null;
  readonly registerFrame: () => void;
  readonly sendTrack: () => void;
}

export function usePreviewRuntime(props: PreviewRuntimeProps, url: string | null): PreviewRuntime {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [rects, setRects] = useState<RectMap>({});
  const [spacing, setSpacing] = useState<SpacingMap>({});
  const [canvasHover, setCanvasHover] = useState<string | null>(null);
  const [selOcc, setSelOcc] = useState<number | null>(null);
  const [hoverOcc, setHoverOcc] = useState(0);
  const hoverPath = props.navHoverPath ?? canvasHover;
  const refs = useRuntimeRefs(props, selOcc);
  const setters = useMemo(
    () => ({ setRects, setSpacing, setCanvasHover, setSelOcc, setHoverOcc }),
    [],
  );
  useOccurrenceSelection(props.selPath, refs, setSelOcc);
  useMessageListener(iframeRef, refs, setters);
  // The frame measures only tracked paths, so both hover sources must use
  // the same active path for measurement requests and outline rendering.
  const trackPaths = useMemo(
    () => trackedPaths(props.selPath, hoverPath, props.focusPath),
    [props.focusPath, hoverPath, props.selPath],
  );
  const registerFrame = useCallback((): void => {
    setCanvasFrame(iframeRef.current?.contentWindow ?? null);
  }, []);
  const sendTrack = useCallback((): void => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: 'avb:track',
        paths: trackPaths,
        scope: props.pathScope ?? '',
        focus: props.focusPath ?? '',
        focusOcc: props.focusOcc ?? 0,
      },
      '*',
    );
  }, [props.focusOcc, props.focusPath, props.pathScope, trackPaths]);
  useFrameRegistration(props, url, registerFrame, sendTrack);
  useSelectionScroll(props, iframeRef, refs);
  useResetOnReload(props, url, refs, setters);
  return {
    iframeRef,
    rects,
    spacing,
    selOcc,
    hoverPath,
    hoverOcc: props.navHoverPath ? null : hoverOcc,
    registerFrame,
    sendTrack,
  };
}

interface RuntimeRefs {
  readonly props: React.MutableRefObject<PreviewRuntimeProps>;
  readonly selOcc: React.MutableRefObject<number | null>;
  readonly selectedClasses: React.MutableRefObject<string | null>;
  readonly clickedPath: React.MutableRefObject<string | null | undefined>;
  readonly lastClick: React.MutableRefObject<{ readonly path: string | null } | null>;
  readonly cameFrom: React.MutableRefObject<string | null>;
  /** The rendering the frame last announced, and its token. */
  readonly render: React.MutableRefObject<PreviewRender | undefined>;
}

function useRuntimeRefs(props: PreviewRuntimeProps, selOcc: number | null): RuntimeRefs {
  const propsRef = useRef(props);
  propsRef.current = props;
  const selOccRef = useRef(selOcc);
  selOccRef.current = selOcc;
  const selectedClasses = useRef<string | null>(null);
  const clickedPath = useRef<string | null | undefined>(undefined);
  const lastClick = useRef<{ readonly path: string | null } | null>(null);
  const cameFrom = useRef<string | null>(null);
  const render = useRef<PreviewRender | undefined>(undefined);
  useEffect(() => {
    selectedClasses.current = null;
  }, [props.selPath, selOcc]);
  return useMemo(
    () => ({
      props: propsRef,
      selOcc: selOccRef,
      selectedClasses,
      clickedPath,
      lastClick,
      cameFrom,
      render,
    }),
    [],
  );
}

function useOccurrenceSelection(
  selPath: string | null,
  refs: RuntimeRefs,
  setSelOcc: React.Dispatch<React.SetStateAction<number | null>>,
): void {
  useEffect(() => {
    const previous = refs.cameFrom.current;
    refs.cameFrom.current = selPath;
    if (refs.lastClick.current?.path === selPath) {
      refs.lastClick.current = null;
      return;
    }
    refs.lastClick.current = null;
    if (sameCopy(previous, selPath)) {
      return;
    }
    setSelOcc(null);
  }, [refs, selPath, setSelOcc]);
}

interface RuntimeSetters {
  readonly setRects: React.Dispatch<React.SetStateAction<RectMap>>;
  readonly setSpacing: React.Dispatch<React.SetStateAction<SpacingMap>>;
  readonly setCanvasHover: React.Dispatch<React.SetStateAction<string | null>>;
  readonly setSelOcc: React.Dispatch<React.SetStateAction<number | null>>;
  readonly setHoverOcc: React.Dispatch<React.SetStateAction<number>>;
}

function useMessageListener(
  iframeRef: React.RefObject<HTMLIFrameElement>,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
): void {
  const settersRef = useRef(setters);
  settersRef.current = setters;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const message = parsePreviewMessage(event.data);
      if (message) {
        applyMessage(message, refs, settersRef.current);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [iframeRef, refs]);
}

function applyMessage(message: PreviewMessage, refs: RuntimeRefs, setters: RuntimeSetters): void {
  switch (message.kind) {
    case 'rects':
      setters.setRects(message.rects);
      setters.setSpacing(message.spacing);
      publishSelectedClasses(message.classes, refs);
      break;
    case 'node-classes':
      refs.props.current.onNodeClasses?.(message.classes);
      break;
    case 'rendered-nodes':
      refs.props.current.onRenderedPaths?.(message.paths);
      break;
    case 'node-states':
      refs.props.current.onNodeStates?.({ hidden: message.hidden, inert: message.inert });
      break;
    case 'modifiers':
      setModifiers(message.shiftKey, message.altKey);
      break;
    case 'hover-node':
      // A picture, not a selection: only the rendering has to be the latest.
      if (judgeEventToken(message.token, refs.render.current).tag === 'current') {
        setters.setCanvasHover(message.path);
        setters.setHoverOcc(message.occurrence);
      } else {
        setters.setCanvasHover(null);
      }
      break;
    case 'click-node':
      gateEvent(message.token, refs, () => applyClick(message, refs, setters));
      break;
    case 'render':
      refs.render.current = message.render;
      break;
    case 'canvas-ready':
      noteCanvasReady();
      forgetComputedColors();
      forgetComputedStyles();
      break;
    case 'query-result':
      receiveCanvasReply(message.input);
      break;
    case 'open-node':
      gateEvent(message.token, refs, () =>
        refs.props.current.onOpenPath?.(message.path, message.occurrence),
      );
      break;
  }
}

// The gate answers after main has read the stamped files; the rendering judged
// is the one the event named, and `apply` runs only on `current`.
function gateEvent(token: Digest | undefined, refs: RuntimeRefs, apply: () => void): void {
  const render = refs.render.current;
  refs.props.current.judgeEvent(token, render).then(
    (verdict) => {
      if (verdict.tag === 'current') {
        apply();
      } else {
        refs.props.current.onStaleEvent(verdict);
      }
    },
    (error: unknown) => {
      // The check itself failed (main unreachable): nothing vouches for the
      // rendering, so the event does not select — and says why.
      console.error('[stacki] preview check failed:', error);
      refs.props.current.onStaleEvent({ tag: 'stale', reason: 'no-render', file: undefined });
    },
  );
}

function publishSelectedClasses(
  classes: Readonly<Record<string, readonly (readonly string[])[]>>,
  refs: RuntimeRefs,
): void {
  const path = refs.props.current.selPath;
  const runs = path ? (classes[path] ?? []) : [];
  const list = runs[refs.selOcc.current ?? 0] ?? runs[0] ?? [];
  const key = list.join(' ');
  if (key !== refs.selectedClasses.current) {
    refs.selectedClasses.current = key;
    refs.props.current.onSelectedClasses?.(list);
  }
}

function applyClick(
  message: Extract<PreviewMessage, { readonly kind: 'click-node' }>,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
): void {
  refs.clickedPath.current = message.path;
  refs.lastClick.current = { path: message.path };
  setters.setSelOcc(message.occurrence);
  refs.props.current.onSelectPath?.(message.path, { outside: message.outside });
}

function useFrameRegistration(
  props: PreviewRuntimeProps,
  url: string | null,
  registerFrame: () => void,
  sendTrack: () => void,
): void {
  const canvasMode = props.device === 'canvas';
  useEffect(() => {
    registerFrame();
    return () => setCanvasFrame(null);
  }, [canvasMode, props.refreshKey, registerFrame, url]);
  useEffect(() => {
    sendTrack();
  }, [props.refreshKey, sendTrack, url]);
}

function useSelectionScroll(
  props: PreviewRuntimeProps,
  iframeRef: React.RefObject<HTMLIFrameElement>,
  refs: RuntimeRefs,
): void {
  const previousContext = useRef({ focusPath: props.focusPath, pathScope: props.pathScope });
  useEffect(() => {
    const frame = iframeRef.current?.contentWindow;
    const previous = previousContext.current;
    const contextChanged =
      previous.focusPath !== props.focusPath || previous.pathScope !== props.pathScope;
    previousContext.current = { focusPath: props.focusPath, pathScope: props.pathScope };
    if (!frame || !props.selPath) {
      return;
    }
    if (refs.clickedPath.current !== undefined) {
      refs.clickedPath.current = undefined;
      return;
    }
    if (!contextChanged) {
      frame.postMessage(
        { type: 'avb:scroll-to', path: props.selPath, occ: refs.selOcc.current },
        '*',
      );
    }
  }, [iframeRef, props.focusPath, props.pathScope, props.selPath, refs]);
}

function useResetOnReload(
  props: PreviewRuntimeProps,
  url: string | null,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
): void {
  const canvasMode = props.device === 'canvas';
  useEffect(() => {
    setters.setRects({});
    setters.setCanvasHover(null);
    setters.setSpacing({});
    setters.setSelOcc(null);
    setters.setHoverOcc(0);
    refs.selectedClasses.current = null;
    refs.clickedPath.current = undefined;
    refs.lastClick.current = null;
    refs.render.current = undefined; // A reloaded frame announces its rendering again.
  }, [canvasMode, props.refreshKey, refs, setters, url]);
}

function trackedPaths(...paths: readonly (string | null | undefined)[]): readonly string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}
