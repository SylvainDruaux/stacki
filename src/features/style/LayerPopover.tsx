import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode, RefObject } from 'react';
import { panelSpan } from './model/panelBox';
import { inOwnedPopup } from './model/popupLayer';

// A layer editor anchored directly below the row it edits (flips above when there's no
// room to drop down), spanning the panel's full width — measured, since the panel is a
// column of the window here rather than the whole of it. Portaled to <body> so it
// overlays everything, and rendered at the panel's own scale: it used to re-apply
// moden's compact 0.75 `zoom`, a wrapper this app doesn't render, which left every
// control in here a quarter smaller than the same control in the panel behind it.
// Closes on outside click / Escape / scroll; the anchor row is excluded from the
// outside-click so clicking it toggles the popover shut instead of instantly reopening.
export default function LayerPopover({
  anchorEl: anchorElement,
  onClose,
  ariaLabel,
  children,
}: {
  anchorEl: HTMLElement;
  onClose: () => void;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Whether the box has to be a scroll container. It is one so a tall layer
  // editor can't run off the screen — and a scroll container clips, which took
  // out the one thing in here that is *meant* to escape: a dropdown's menu. With
  // no room below (there rarely is, this far down the panel) the menu opens
  // upward, lands outside the box, and is clipped away — so the click that meant
  // to pick an option went through to the panel behind and read as a click
  // outside, closing the popover. These editors are three or four rows; the
  // scrolling is for a case that does not happen, and it stays available for the
  // case that does.
  const scrolls = usePopoverOverflow(boxRef);
  // Read once, at mount, so the popover has its real width for the very first
  // layout — the flip decision below measures a height that depends on it.
  const [span] = useState(() => panelSpan(anchorElement));
  const top = usePopoverTop(ref, anchorElement);
  usePopoverDismiss(ref, anchorElement, onClose);
  return createPortal(
    <div
      ref={ref}
      className="embed-editor_layer-popover"
      role="dialog"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        left: span.left,
        width: span.width,
        top: top ?? 0,
        visibility: top === undefined ? 'hidden' : 'visible',
      }}
    >
      <div
        ref={boxRef}
        className={
          'embed-editor_layer-popover-box u-surface-surface' + (scrolls ? ' is-scrolling' : '')
        }
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// The popover's top edge: directly below the anchor row, or flipped above it
// when there is no room to drop down. Undefined until the first measurement.
function usePopoverTop(
  ref: RefObject<HTMLDivElement>,
  anchorElement: HTMLElement,
): number | undefined {
  const [top, setTop] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const anchorRect = anchorElement.getBoundingClientRect();
    const gap = 6;
    // Rendered height (the zoomed content already collapsed it).
    const height = element.offsetHeight;
    const below = anchorRect.bottom + gap + height <= window.innerHeight;
    setTop(below ? anchorRect.bottom + gap : Math.max(gap, anchorRect.top - gap - height));
  }, [ref, anchorElement]);
  return top;
}

// Closes on outside press, Escape, and a scroll of the page beneath.
function usePopoverDismiss(
  ref: RefObject<HTMLDivElement>,
  anchorElement: HTMLElement,
  onClose: () => void,
): void {
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      // A popup this one opened (the colour picker from a swatch in here) is drawn
      // through a portal, so `contains` says outside — see lib/popup-layer.
      if (inOwnedPopup(target, ref.current ?? undefined)) {
        return;
      }
      if (ref.current?.contains(target) || anchorElement.contains(target)) {
        return;
      }
      // The anchor row is excluded above: pressing it toggles the popover shut
      // through its own handler, which is a press meant for it.
      swallowNextClick();
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    // Closing on scroll is about the page moving out from under a popover that is
    // pinned to a rectangle it can no longer see. A list scrolling INSIDE it is
    // not that — and a dropdown scrolls itself the moment it opens, to bring the
    // selected option into view, which shut the editor as soon as you opened the
    // one control most of these editors lead with.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [ref, onClose, anchorElement]);
}

// The press that dismisses this popover is spent dismissing it. Without that,
// clicking a control outside to get rid of the popover also pressed the
// control: aiming at "Events: Auto" to close the transform editor set
// pointer-events on the element. One press, one thing.
function swallowNextClick(): void {
  const eat = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener('click', eat, { capture: true, once: true });
  // A press that never becomes a click (a drag away, a right-click) must not
  // leave this armed for whatever is clicked next.
  window.setTimeout(() => document.removeEventListener('click', eat, true), 400);
}

function usePopoverOverflow(boxRef: RefObject<HTMLDivElement>): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) {
      return undefined;
    }
    const measure = () => setScrolls(box.scrollHeight > window.innerHeight * 0.94);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(box);
    // A max-height box can keep the same border size while its contents grow,
    // so ResizeObserver alone misses the exact change that makes it scroll.
    const mutations =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(measure);
    mutations?.observe(box, { attributes: true, childList: true, subtree: true });
    window.addEventListener('resize', measure);
    return () => {
      mutations?.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [boxRef]);
  return scrolls;
}
