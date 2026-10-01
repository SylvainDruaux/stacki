import React, { useState } from 'react';
import type { PointerEvent } from 'react';
import CodeEditor from '../../ui/CodeEditor';
import type { CodeEditorProps } from '../../ui/CodeEditor';
import { CloseIcon, CodeIcon } from '../../ui/Icons';
import { usePointerDrag } from '../../ui/usePointerDrag';

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);
const WIDTH_PX_MIN = 340;
const HEIGHT_PX_MIN = 220;
const EDGES = ['n', 's', 'e', 'w', 'se', 'sw', 'ne', 'nw'] as const;
type Edge = (typeof EDGES)[number];
interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
interface CodeWindowProps extends CodeEditorProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly editorKey?: React.Key | undefined;
}

// A single pointer session owns movement and cleanup, including closing mid-drag.
export default function CodeWindow(props: CodeWindowProps) {
  const { title, language, value, onChange, onClose, editorKey, revealLine } = props;
  const { rectangle, startDrag, startResize } = useWindowRectangle();
  return (
    <div
      className="code-window"
      style={{ left: rectangle.x, top: rectangle.y, width: rectangle.w, height: rectangle.h }}
    >
      <div className="code-window-header" onPointerDown={startDrag}>
        <CodeIcon size={13} />
        <span className="code-window-title">{title}</span>
        <span className="type-tag">{language}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Close (edits are saved live)" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="code-window-body">
        <CodeEditor
          key={editorKey}
          language={language}
          value={value}
          onChange={onChange}
          revealLine={revealLine}
        />
      </div>
      {EDGES.map((edge) => (
        <div key={edge} className={`cw-rz cw-rz-${edge}`} onPointerDown={startResize(edge)} />
      ))}
    </div>
  );
}

function useWindowRectangle() {
  const [rectangle, setRectangle] = useState(windowRectangleInitial);
  const startPointer = usePointerDrag();
  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const ElementType = event.currentTarget.ownerDocument.defaultView?.Element;
    if (ElementType && event.target instanceof ElementType && event.target.closest('button')) {
      return;
    }
    event.preventDefault();
    const { clientX, clientY } = event;
    startPointer(event, {
      onMove: (next) => {
        setRectangle((current) => ({
          ...current,
          x: clamp(rectangle.x + next.clientX - clientX, -current.w + 120, window.innerWidth - 60),
          y: clamp(rectangle.y + next.clientY - clientY, 42, window.innerHeight - 48),
        }));
      },
    });
  };
  const startResize =
    (edge: Edge) =>
    (event: PointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      const { clientX, clientY } = event;
      startPointer(event, {
        onMove: (next) => {
          setRectangle(
            windowRectangleResize(rectangle, edge, next.clientX - clientX, next.clientY - clientY),
          );
        },
      });
    };
  return { rectangle, startDrag, startResize };
}

function windowRectangleInitial(): Rectangle {
  // Proportional dimensions make real code usable while keeping the canvas visible.
  const width = clamp(Math.round(window.innerWidth * 0.52), WIDTH_PX_MIN, 1040);
  const height = clamp(
    Math.round(window.innerHeight * 0.78),
    HEIGHT_PX_MIN,
    window.innerHeight - 140,
  );
  return { x: Math.max(60, window.innerWidth - width - 80), y: 96, w: width, h: height };
}

function windowRectangleResize(start: Rectangle, edge: Edge, dx: number, dy: number): Rectangle {
  // Mutation stays local to this calculation; the state is replaced atomically.
  let { x, y, w: width, h: height } = start;
  if (edge.includes('e')) {
    width = Math.max(WIDTH_PX_MIN, start.w + dx);
  }
  if (edge.includes('s')) {
    height = Math.max(HEIGHT_PX_MIN, start.h + dy);
  }
  if (edge.includes('w')) {
    width = Math.max(WIDTH_PX_MIN, start.w - dx);
    x = start.x + (start.w - width);
  }
  if (edge.includes('n')) {
    height = Math.max(HEIGHT_PX_MIN, start.h - dy);
    y = start.y + (start.h - height);
  }
  return { x, y, w: width, h: height };
}
