import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import IconButton from './IconButton';
import './HelpPopover.css';

function QuestionIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6.4 6.35a1.6 1.6 0 1 1 2.15 1.75c-.52.2-.8.52-.8 1.05v.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="11.4" r="0.8" fill="currentColor" />
    </svg>
  );
}

type Props = {
  /** Popover heading — usually the tool name. */
  title?: string;
  /** The help content. */
  children: ReactNode;
  /** Trigger aria-label / tooltip. Defaults to "Help". */
  label?: string;
  className?: string;
};

/**
 * A "?" icon button that opens an info popover (title + content). Reusable across
 * tools — pass different `children` for each tool's help. Closes on click-outside
 * or Escape.
 */
export default function HelpPopover({ title, children, label = 'Help', className }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={['help-popover', className].filter(Boolean).join(' ')}>
      <IconButton
        size="sm"
        icon={<QuestionIcon />}
        label={label}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div className="help-popover_panel" role="dialog" aria-label={title ?? label}>
          {title ? <div className="help-popover_title">{title}</div> : null}
          <div className="help-popover_body">{children}</div>
        </div>
      ) : null}
    </div>
  );
}
