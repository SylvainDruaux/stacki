// Colour normalization for writes. Webflow's native Style API accepts hex and
// rgb()/rgba() but not hsl()/hsla() — it silently drops an hsl* value. So on every
// write we rewrite any hsl()/hsla() in the value to rgb()/rgba() (works natively AND
// in embed CSS, and matches how Webflow stores colours). Only hsl* substrings are
// touched; everything else — including a gradient's angle, positions, and other
// colours — passes through untouched.

// Matches one hsl()/hsla() function. `[^)]*` can't span a nested paren, so an
// hsl(var(--x) …) with an inner function is left alone (returned unchanged below).
const HSL_FN_RE = /hsla?\(\s*[^)]*\)/gi;

/** Rewrite every hsl()/hsla() colour in a CSS value to rgb()/rgba(). */
export function hslaToRgba(value: string): string {
  if (!value || !/hsl/i.test(value)) {
    return value;
  }
  return value.replace(HSL_FN_RE, (match) => {
    const inner = match.slice(match.indexOf('(') + 1, -1);
    return convertHsl(inner) ?? match;
  });
}

function convertHsl(inner: string): string | null {
  let alpha: string | null = null;
  let body = inner.trim();
  // Modern slash-alpha syntax: `h s l / a`.
  const slash = body.indexOf('/');
  if (slash !== -1) {
    alpha = body.slice(slash + 1).trim();
    body = body.slice(0, slash).trim();
  }

  const parts = body.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  if (alpha == null && parts.length >= 4) {
    alpha = parts[3] ?? null;
  } // legacy `h, s, l, a`

  const h = parseHue(parts[0] ?? '');
  const s = parsePercent(parts[1] ?? '');
  const l = parsePercent(parts[2] ?? '');
  if (h == null || s == null || l == null) {
    return null;
  }

  const [r, g, b] = hslToRgb(h, s, l);
  if (alpha != null) {
    const a = parseAlpha(alpha);
    if (a == null) {
      return null;
    }
    if (a < 1) {
      return `rgba(${r}, ${g}, ${b}, ${round(a)})`;
    }
  }
  return `rgb(${r}, ${g}, ${b})`;
}

/** Hue with an optional angle unit → degrees in [0, 360). */
function parseHue(token: string): number | null {
  const m = token.match(/^(-?[\d.]+)(deg|grad|rad|turn)?$/i);
  if (!m) {
    return null;
  }
  let n = parseFloat(m[1] ?? '');
  switch ((m[2] || 'deg').toLowerCase()) {
    case 'grad':
      n *= 0.9;
      break;
    case 'rad':
      n = (n * 180) / Math.PI;
      break;
    case 'turn':
      n *= 360;
      break;
  }
  return ((n % 360) + 360) % 360;
}

/** Saturation/lightness → 0–1 (a bare 0–100 number is treated as a percentage). */
function parsePercent(token: string): number | null {
  const m = token.match(/^(-?[\d.]+)%?$/);
  if (!m) {
    return null;
  }
  let n = parseFloat(m[1] ?? '');
  if (token.trim().endsWith('%') || n > 1) {
    n /= 100;
  }
  return Math.max(0, Math.min(1, n));
}

/** Alpha as a 0–1 number or a percentage. */
function parseAlpha(token: string): number | null {
  const m = token.match(/^(-?[\d.]+)%?$/);
  if (!m) {
    return null;
  }
  let n = parseFloat(m[1] ?? '');
  if (token.trim().endsWith('%')) {
    n /= 100;
  }
  return Math.max(0, Math.min(1, n));
}

/** HSL (h 0–360, s/l 0–1) → 8-bit RGB. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
