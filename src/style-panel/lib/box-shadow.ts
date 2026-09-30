// box-shadow is a comma-separated list of shadows, each
// `[inset] <x> <y> <blur>? <spread>? <color>?` (offset-x, offset-y, blur, spread —
// color may lead or trail, `inset` may appear anywhere). We parse it into an ordered
// list (index 0 = the first/top shadow) and serialize back, splitting on TOP-LEVEL
// commas/spaces only so rgba()/hsl()/var() with inner separators survive.

import { splitTopLevelCommas, splitTopLevelSpaces } from './background';

export type BoxShadow = {
  inset: boolean;
  x: string;
  y: string;
  blur: string;
  spread: string;
  color: string;
};
// One control's edit. Each member names the fields that control owns — an
// explicit update surface rather than `Partial<T>` (AGENTS.md §4).
export type BoxShadowPatch =
  | Pick<BoxShadow, 'inset'>
  | Pick<BoxShadow, 'x'>
  | Pick<BoxShadow, 'y'>
  | Pick<BoxShadow, 'blur'>
  | Pick<BoxShadow, 'spread'>
  | Pick<BoxShadow, 'color'>;

/** A token that reads as a length (a number with an optional CSS unit). */
function isLength(token: string): boolean {
  return /^-?[\d.]+(px|em|rem|%|vw|vh|vmin|vmax|ch|ex|cqw|cqh|cqi|cqb)?$/i.test(token.trim());
}

/** Parse a `box-shadow` value into an ordered shadow list (`none`/'' → empty). */
export function parseBoxShadows(value: string): BoxShadow[] {
  const v = value.trim();
  if (!v || v.toLowerCase() === 'none') {
    return [];
  }
  return splitTopLevelCommas(v)
    .filter(Boolean)
    .map((part) => {
      const lengths: string[] = [];
      let color = '';
      let inset = false;
      for (const token of splitTopLevelSpaces(part)) {
        if (/^inset$/i.test(token)) {
          inset = true;
          continue;
        }
        if (isLength(token)) {
          lengths.push(token);
        } else {
          color = color ? `${color} ${token}` : token;
        }
      }
      return {
        inset,
        x: lengths[0] ?? '0px',
        y: lengths[1] ?? '0px',
        blur: lengths[2] ?? '0px',
        spread: lengths[3] ?? '0px',
        color: color || 'rgba(0, 0, 0, 0.2)',
      };
    });
}

/** Serialize a shadow list back to a `box-shadow` value ('' when empty). */
export function serializeBoxShadows(shadows: BoxShadow[]): string {
  if (!shadows.length) {
    return '';
  }
  return shadows
    .map(
      (s) =>
        `${s.inset ? 'inset ' : ''}${s.x || '0px'} ${s.y || '0px'} ${s.blur || '0px'} ${s.spread || '0px'}${s.color ? ` ${s.color}` : ''}`,
    )
    .join(', ');
}

/** A new shadow with Webflow-like defaults (outer, `0px 2px 5px 0px rgba(0,0,0,0.2)`). */
export function blankBoxShadow(): BoxShadow {
  return {
    inset: false,
    x: '0px',
    y: '2px',
    blur: '5px',
    spread: '0px',
    color: 'rgba(0, 0, 0, 0.2)',
  };
}

/** A short label for a collapsed row ("Outer shadow: 0px 2px 5px 0px"). */
export function boxShadowLabel(s: BoxShadow): string {
  return `${s.inset ? 'Inner' : 'Outer'} shadow: ${s.x || '0px'} ${s.y || '0px'} ${s.blur || '0px'} ${s.spread || '0px'}`;
}
