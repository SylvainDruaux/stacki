import Select, { type SelectOption } from './components/Select'
import { ShadowColorRow, ShadowNum } from './ShadowFields'
import { AngleControl } from './GradientEditor'
import { FILTER_GROUPS, FILTER_META, retypeFilter, type Filter, type FilterPatch, type FilterType } from './lib/filter'

// The per-filter editor (Webflow's Filters): a grouped Filter-type dropdown, then the
// controls for that type — Amount (%/px/…, any unit), Hue rotate's Angle dial, or Drop
// shadow's X / Y / Blur / Color. Reuses the shadow number/color rows (value + unit shown
// inline, any unit accepted) and the gradient angle control.

const TYPE_OPTIONS = FILTER_GROUPS.flatMap<SelectOption<string>>((group) => [
  { value: `__h_${group.heading}`, label: group.heading, heading: true },
  ...group.types.map((type) => ({ value: type, label: FILTER_META[type].label, indent: true })),
])

function isFilterType(value: string): value is FilterType {
  return value in FILTER_META
}

export default function FilterEditor({ filter, busy, onChange }: {
  filter: Filter
  busy: boolean
  onChange: (next: Filter, live: boolean) => void
}) {
  const meta = FILTER_META[filter.type]
  const set = (p: FilterPatch, live: boolean) => onChange({ ...filter, ...p }, live)
  return (
    <div className="embed-editor_filter-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Filter</span>
        <Select
          value={filter.type}
          options={TYPE_OPTIONS}
          onChange={(value) => {if (isFilterType(value)) {onChange(retypeFilter(value), false)}}}
          ariaLabel="Filter type"
          disabled={busy}
          searchable
        />
      </div>

      {meta.control === 'amount' ? (
        <ShadowNum label="Amount" value={filter.amount} range={{ min: meta.min, max: meta.max }} defaultUnit={meta.unit} busy={busy}
          onLive={(v) => set({ amount: v }, true)} onCommit={(v) => set({ amount: v }, false)} />
      ) : meta.control === 'angle' ? (
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Angle</span>
          <AngleControl angle={filter.amount || '0deg'} busy={busy} onChange={(a, live) => set({ amount: a }, live)} />
        </div>
      ) : (
        <>
          <ShadowNum label="X" value={filter.x} busy={busy} onLive={(v) => set({ x: v }, true)} onCommit={(v) => set({ x: v }, false)} />
          <ShadowNum label="Y" value={filter.y} busy={busy} onLive={(v) => set({ y: v }, true)} onCommit={(v) => set({ y: v }, false)} />
          <ShadowNum label="Blur" value={filter.blur} busy={busy} onLive={(v) => set({ blur: v }, true)} onCommit={(v) => set({ blur: v }, false)} />
          <ShadowColorRow color={filter.color} busy={busy} onChange={(c, live) => set({ color: c }, live)} />
        </>
      )}
    </div>
  )
}
