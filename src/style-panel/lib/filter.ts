// `filter` / `backdrop-filter` are a SPACE-separated list of filter functions
// (blur/brightness/…/drop-shadow). We model each as one editable layer and
// parse/serialize back, splitting on TOP-LEVEL spaces so drop-shadow()'s inner
// lengths + rgba() survive. Mirrors lib/transform.ts.

import { splitTopLevelSpaces } from './background'

export type FilterType =
  | 'blur' | 'brightness' | 'contrast' | 'grayscale'
  | 'hue-rotate' | 'invert' | 'saturate' | 'sepia' | 'drop-shadow'

/** One filter layer: an amount (for the value filters) OR the drop-shadow fields. */
export type Filter = {
  type: FilterType
  amount: string // value filters, e.g. '200%', '4px', '180deg'
  x: string; y: string; blur: string; color: string // drop-shadow only
}
// One control's edit. Each member names the fields that control owns — an
// explicit update surface rather than `Partial<T>` (AGENTS.md §4).
export type FilterPatch =
  | Pick<Filter, 'amount'>
  | Pick<Filter, 'x'>
  | Pick<Filter, 'y'>
  | Pick<Filter, 'blur'>
  | Pick<Filter, 'color'>

export type FilterControl = 'amount' | 'angle' | 'shadow'
export const FILTER_META: Record<FilterType, { label: string; unit: string; min: number; max: number; control: FilterControl; def: string }> = {
  blur: { label: 'Blur', unit: 'px', min: 0, max: 100, control: 'amount', def: '4px' },
  brightness: { label: 'Brightness', unit: '%', min: 0, max: 200, control: 'amount', def: '100%' },
  contrast: { label: 'Contrast', unit: '%', min: 0, max: 200, control: 'amount', def: '100%' },
  saturate: { label: 'Saturation', unit: '%', min: 0, max: 200, control: 'amount', def: '100%' },
  grayscale: { label: 'Grayscale', unit: '%', min: 0, max: 100, control: 'amount', def: '100%' },
  invert: { label: 'Invert', unit: '%', min: 0, max: 100, control: 'amount', def: '100%' },
  sepia: { label: 'Sepia', unit: '%', min: 0, max: 100, control: 'amount', def: '100%' },
  'hue-rotate': { label: 'Hue rotate', unit: 'deg', min: 0, max: 360, control: 'angle', def: '0deg' },
  'drop-shadow': { label: 'Drop shadow', unit: 'px', min: 0, max: 100, control: 'shadow', def: '' },
}

// Grouped exactly like Webflow's filter menu.
export const FILTER_GROUPS: ReadonlyArray<{ heading: string; types: FilterType[] }> = [
  { heading: 'General', types: ['blur', 'drop-shadow'] },
  { heading: 'Color adjustments', types: ['brightness', 'contrast', 'hue-rotate', 'saturate'] },
  { heading: 'Color effects', types: ['grayscale', 'invert', 'sepia'] },
]

function isFilterType(value: string): value is FilterType {
  return value in FILTER_META
}

const DROP_DEFAULT = { x: '0px', y: '2px', blur: '5px', color: 'rgba(0, 0, 0, 0.7)' }
const round = (n: number) => Math.round(n * 100) / 100

const fnName = (fn: string): string => fn.slice(0, fn.indexOf('(')).trim().toLowerCase()
const fnInner = (fn: string): string => {
  const o = fn.indexOf('('); const c = fn.lastIndexOf(')')
  return o < 0 || c <= o ? '' : fn.slice(o + 1, c).trim()
}
const isLength = (t: string): boolean => /^-?[\d.]+(px|em|rem|%|vw|vh|vmin|vmax)?$/i.test(t.trim())

// Normalize a value filter's argument to the meta unit: %-filters store a percentage
// (a unitless `1.5` → `150%`), deg-filters store degrees, blur stores px. A value we
// can't parse (var()/calc()) is kept verbatim.
function normalizeAmount(type: FilterType, inner: string): string {
  const meta = FILTER_META[type]
  const m = inner.trim().match(/^(-?[\d.]+)(%|px|deg|rad|turn|grad|em|rem)?$/i)
  if (!m) {return inner.trim()}
  let n = parseFloat(m[1] ?? ''); const unit = (m[2] || '').toLowerCase()
  if (meta.unit === '%') {return `${round(unit === '%' ? n : n * 100)}%`}
  if (meta.unit === 'deg') {
    if (unit === 'turn') {n *= 360}
    else if (unit === 'grad') {n *= 0.9}
    else if (unit === 'rad') {n = (n * 180) / Math.PI}
    return `${round(n)}deg`
  }
  return `${round(n)}${unit || 'px'}`
}

/** Parse a `filter` value into ordered layers (`none`/'' → empty). */
export function parseFilters(value: string): Filter[] {
  const v = value.trim()
  if (!v || v.toLowerCase() === 'none') {return []}
  const out: Filter[] = []
  for (const fn of splitTopLevelSpaces(v).filter((f) => f.includes('('))) {
    const name = fnName(fn)
    if (!isFilterType(name)) {continue}
    if (name === 'drop-shadow') {
      const lens: string[] = []; let color = ''
      for (const p of splitTopLevelSpaces(fnInner(fn))) {
        if (isLength(p)) {lens.push(p)}
        else {color = p}
      }
      out.push({ type: name, amount: '', x: lens[0] ?? '0px', y: lens[1] ?? '0px', blur: lens[2] ?? '0px', color: color || DROP_DEFAULT.color })
    } else {
      out.push({ ...blankFilter(name), amount: normalizeAmount(name, fnInner(fn)) })
    }
  }
  return out
}

function serializeOne(f: Filter): string {
  if (f.type === 'drop-shadow') {
    const x = f.x.trim() || '0px', y = f.y.trim() || '0px', blur = f.blur.trim() || '0px'
    const color = f.color.trim() || DROP_DEFAULT.color
    return `drop-shadow(${x} ${y} ${blur} ${color})`
  }
  return `${f.type}(${f.amount.trim() || FILTER_META[f.type].def})`
}

/** Serialize layers back to a `filter` value ('' when empty). */
export function serializeFilters(list: Filter[]): string {
  return list.map(serializeOne).filter(Boolean).join(' ')
}

/** A new layer of `type`, seeded with that type's default. */
export function blankFilter(type: FilterType = 'blur'): Filter {
  return { type, amount: FILTER_META[type].def, x: DROP_DEFAULT.x, y: DROP_DEFAULT.y, blur: DROP_DEFAULT.blur, color: DROP_DEFAULT.color }
}

/** Re-type a layer to its new type's default. */
export function retypeFilter(type: FilterType): Filter {
  return blankFilter(type)
}

/** A short label for a collapsed row. */
export function filterLabel(f: Filter): string {
  const meta = FILTER_META[f.type]
  if (f.type === 'drop-shadow') {return `${meta.label}: ${[f.x, f.y, f.blur].map((s) => s.trim() || '0px').join(' ')}`}
  return `${meta.label}: ${f.amount.trim() || meta.def}`
}
