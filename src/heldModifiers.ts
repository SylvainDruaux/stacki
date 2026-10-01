// Which modifiers are held, from wherever they were pressed.
//
// Keys reach one window at a time. Clicking an element on the canvas puts
// keyboard focus inside the preview frame, and from then on the app's own key
// listeners hear nothing — so a panel that watches Shift and Option has to be
// told by whoever did hear them. The frame forwards its key events (see the
// preload) and the app writes them here; the panel reads here rather than
// straight off the window, and gets the same answer either way.
export type Modifiers = { shiftKey: boolean; altKey: boolean };
let modifiers: Modifiers = { shiftKey: false, altKey: false };
const modifierListeners = new Set<(held: Modifiers) => void>();

export function setModifiers(held: Readonly<Modifiers>) {
  if (modifiers.shiftKey === held.shiftKey && modifiers.altKey === held.altKey) {
    return;
  }
  modifiers = { shiftKey: held.shiftKey, altKey: held.altKey };
  for (const listener of modifierListeners) {
    listener(modifiers);
  }
}

export function getModifiers(): Modifiers {
  return modifiers;
}

export function onModifiers(listener: (held: Modifiers) => void) {
  modifierListeners.add(listener);
  return () => {
    modifierListeners.delete(listener);
  };
}
