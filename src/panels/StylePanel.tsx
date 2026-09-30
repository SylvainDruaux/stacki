import React, { useEffect, useRef, useState } from 'react';
import type { HostState } from '../style-panel/lib/host';
import { setHost } from '../style-panel/lib/host';
import EmbedEditor from '../style-panel/EmbedEditor';
import '../style-panel/tokens.css';
import '../style-panel/utilities.css';
import '../style-panel/embed-editor.css';
import { readAstroStyleFiles, readStyleFiles } from '../stylePanelBridge';
import { clickNote } from '../ui/sound.js';
import { SoundHere } from '../ui/soundScope';
import usePopupOpen from '../ui/usePopupOpen';

interface StylePanelProps {
  readonly project: { readonly path: string } | undefined;
  readonly model?: { readonly nodes: HostState['nodes'] } | undefined;
  readonly node?: { readonly id: string } | undefined;
  readonly device?: string;
  readonly pathOf?: HostState['pathOf'];
  readonly onWriteStyleNode?: HostState['writeStyleNode'] | undefined;
  readonly onSelectNode?: HostState['selectNode'] | undefined;
  readonly onRecordUndo?: HostState['recordUndo'] | undefined;
  readonly onAddClass?: HostState['addClass'] | undefined;
  readonly onSpacingHover?: HostState['onSpacingHover'];
  readonly renderedClasses?: readonly string[] | undefined;
  readonly projectClasses?: readonly string[] | undefined;
  readonly historyTick?: number;
  readonly openFilePath?: string | undefined;
  readonly openFileKind?: HostState['openFileKind'];
}

type StyleFiles = HostState['files'];

export default function StylePanel(props: StylePanelProps) {
  const files = useStyleFiles(props.project?.path, undefined, readStyleFiles);
  const astroFiles = useStyleFiles(props.project?.path, props.openFilePath, readAstroStyleFiles);
  const host = hostState(props, files, astroFiles);
  // Children read the bridge during their own effects, which run before the
  // parent's effects. Publishing here ensures their first read is current.
  setHost(host);
  useEffect(() => setHost(host), [host]);
  const hostRef = useRef<HTMLDivElement>(null);
  usePanelBounds(hostRef);
  const popupOpen = usePopupOpen(hostRef);
  if (!props.project) {
    return undefined;
  }
  return (
    <SoundHere>
      <div
        className={`style-panel-host ${popupOpen ? 'is-locked' : ''}`}
        ref={hostRef}
        onClick={playButtonNote}
      >
        {props.node ? (
          <EmbedEditor />
        ) : (
          <div className="props-empty">Select an element to style it.</div>
        )}
      </div>
    </SoundHere>
  );
}

// `refreshKey` names what, when it changes, makes the files worth reading again.
function useStyleFiles(
  projectPath: string | undefined,
  refreshKey: string | undefined,
  read: (
    projectPath: string,
  ) => Promise<
    | { readonly ok: true; readonly value: StyleFiles }
    | { readonly ok: false; readonly error: string }
  >,
): StyleFiles {
  const [files, setFiles] = useState<StyleFiles>([]);
  useEffect(() => {
    if (!projectPath) {
      setFiles([]);
      return;
    }
    let active = true;
    void read(projectPath).then((result) => {
      if (active) {
        setFiles(result.ok ? result.value : []);
      }
    });
    return () => {
      active = false;
    };
  }, [projectPath, read, refreshKey]);
  return files;
}

function hostState(props: StylePanelProps, files: StyleFiles, astroFiles: StyleFiles): HostState {
  return {
    projectPath: props.project?.path,
    nodes: props.model?.nodes ?? [],
    selectedId: props.node?.id,
    pathOf: props.pathOf,
    device: props.device ?? 'desktop',
    files,
    astroFiles,
    openFilePath: props.openFilePath,
    openFileKind: props.openFileKind,
    writeStyleNode: props.onWriteStyleNode,
    selectNode: props.onSelectNode,
    recordUndo: props.onRecordUndo,
    addClass: props.onAddClass,
    onSpacingHover: props.onSpacingHover,
    renderedClasses: [...(props.renderedClasses ?? [])],
    projectClasses: [...(props.projectClasses ?? [])],
    historyTick: props.historyTick ?? 0,
  };
}

function usePanelBounds(hostRef: React.RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const publish = (): void => {
      const bounds = element.getBoundingClientRect();
      const style = document.documentElement.style;
      style.setProperty('--style-panel-left', `${bounds.left}px`);
      style.setProperty('--style-panel-top', `${bounds.top}px`);
      style.setProperty('--style-panel-width', `${bounds.width}px`);
      style.setProperty('--style-panel-height', `${bounds.height}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    window.addEventListener('resize', publish);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, [hostRef]);
}

function playButtonNote(event: React.MouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest('button');
  if (button && !button.disabled) {
    clickNote();
  }
}
