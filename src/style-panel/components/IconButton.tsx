import type { MouseEventHandler, ReactNode } from 'react';
import './IconButton.css';

type Props = {
  /** The icon glyph (an <svg>). IconButton controls its size and color, so
      differently-authored SVGs still render at a consistent size + brightness. */
  icon: ReactNode;
  /** Accessible label; also the default tooltip. */
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  disabled?: boolean;
  /** Footprint: 'md' (34px, default) for toolbars; 'sm' (24px) for the compact header. */
  size?: 'sm' | 'md';
  className?: string;
};

/**
 * Icon-only button with one shared footprint, glyph size, and brightness. Use it
 * anywhere an icon needs to act as a button (header close, toolbar refresh, panel
 * close, …) so every icon button matches instead of each re-deriving its own size
 * and color.
 */
export default function IconButton({
  icon,
  label,
  onClick,
  title,
  disabled,
  size = 'md',
  className,
}: Props) {
  return (
    <button
      type="button"
      className={['icon-button', size === 'sm' ? 'is-sm' : '', className].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
    >
      {icon}
    </button>
  );
}
