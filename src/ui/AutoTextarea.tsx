import type { TextareaHTMLAttributes } from 'react';
interface AutoTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly minRows?: number;
}
import { useLayoutEffect, useRef } from 'react';

// Textarea that grows and shrinks to fit its content. Height tracks the
// value on every change (and on width changes via ResizeObserver, since
// wrapping depends on width).
export default function AutoTextarea({
  value,
  minRows: rowsMin = 2,
  style,
  ...props
}: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const fit = () => {
    const element = ref.current;
    if (!element) {
      return;
    }
    element.style.height = 'auto';
    // +2 accounts for the 1px top/bottom borders (border-box sizing).
    element.style.height = element.scrollHeight + 2 + 'px';
  };

  useLayoutEffect(fit, [value]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(fit);
    ro.observe(element);
    return () => ro.disconnect();
  }, []);

  return (
    <textarea
      ref={ref}
      rows={rowsMin}
      value={value}
      style={{ overflow: 'hidden', resize: 'none', ...style }}
      {...props}
    />
  );
}
