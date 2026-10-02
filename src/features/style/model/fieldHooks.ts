// Small pieces of field behaviour every style section needs the same way: a
// draft that follows outside edits without clobbering typing, debounced live
// writes, focusing a custom field once its write settles, and which row's
// popover stays open after a row is removed. Each section used to carry its own
// identical copy.

import { useEffect, useRef, useState } from 'react';
import { parseImportant } from './styleDisplay';

/** Typing pauses this long before a live write. */
const LIVE_DELAY_MS = 100;

// A field's draft: it mirrors external edits, but never clobbers what the user is
// typing (while `focused` holds).
export function useExternalDraft(external: string) {
  const [draft, setDraft] = useState(external);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(external);
    }
  }, [external]);
  return { draft, setDraft, focused };
}

// Live writes of typed text, split into value and `!important`. `scheduleLive`
// debounces typing; `liveNow` is the undelayed write for a scrub, which does its
// own throttling — a debounce reset by every mouse move would never fire
// mid-drag. Blank text is never written live.
export function useDebouncedLive(write: (value: string, important: boolean) => void) {
  const liveTimer = useRef<number | undefined>(undefined);
  const cancelLive = () => {
    if (liveTimer.current !== undefined) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = undefined;
    }
  };
  useEffect(() => cancelLive, []);
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const parsed = parseImportant(trimmed);
    write(parsed.value, parsed.important);
  };
  const scheduleLive = (text: string) => {
    cancelLive();
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = undefined;
      liveNow(text);
    }, LIVE_DELAY_MS);
  };
  return { cancelLive, liveNow, scheduleLive };
}

// Focus the custom field after switching to Custom, once its `unset` write
// settles: the request is remembered until the field exists and is enabled.
export function useCustomFocus({ customMode, busy }: { customMode: boolean; busy: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [customMode, busy]);
  return {
    inputRef,
    requestFocus: () => {
      wantFocus.current = true;
    },
  };
}

// The open popover after removing row `removed`: closed if it was that row's, shifted
// down one if it was a later row's.
export function openAfterRemoval(open: number | undefined, removed: number): number | undefined {
  if (open === undefined) {
    return undefined;
  }
  if (open === removed) {
    return undefined;
  }
  return open > removed ? open - 1 : open;
}
