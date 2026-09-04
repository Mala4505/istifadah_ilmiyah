'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Filter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { SelectNative } from '@/components/ui/select-native'
import { DEFAULT_FILTERS, type EntriesFilters, type FilterOptions } from './types'

/**
 * A single removable filter chip. `key` names the field(s) a click on the X
 * resets — `'dateRange'` is the one synthetic key, clearing dateFrom+dateTo
 * together the same way they collapse into one summary term
 * (docs/hub-screen-certification.md §4.11).
 */
export type FilterChipKey = keyof EntriesFilters | 'dateRange'
export type FilterChip = { label: string; key: FilterChipKey }

/**
 * How many of the 13 filters differ from their default. Exported so
 * entries-explorer.tsx can thread the same count into the empty state (§4.4)
 * without re-deriving it.
 */
export function countActiveFilters(filters: EntriesFilters): number {
  return Object.entries(filters).filter(([key, value]) => value !== DEFAULT_FILTERS[key as keyof EntriesFilters]).length
}

/** Resets the field(s) a chip's X targets, returning the partial patch. */
export function clearFilterChip(key: FilterChipKey): Partial<EntriesFilters> {
  if (key === 'dateRange') return { dateFrom: '', dateTo: '' }
  return { [key]: DEFAULT_FILTERS[key] } as Partial<EntriesFilters>
}

/**
 * Filter controls for the entries list (MASTER-PLAN §5 row 3; grouping per
 * hub-refinements-plan.md §1). Purely controlled — entries-explorer.tsx owns
 * the actual filter state and syncs it to the URL, so a filtered view is
 * copy-pasteable.
 *
 * All 13 filters stay — the plan's decision (§1) was explicit that every
 * group gets used regularly, so this is a reorganization into four labelled
 * sections, not a removal:
 *   - Status: Type, Status, Hub status
 *   - Classification: Department, Budget head, Admin head, Zone, Cost center
 *   - Search: Vendor, Date from, Date to
 *   - Flags: Export-pending, Missing Main #, Has document
 *
 * Collapsed by default (finding 7.2): the full panel used to take ~450px
 * before the first table row, so entries — the most-used screen — opens
 * hidden behind a wall of filters. Collapsed state shows the active filters
 * as removable chips (§4.11) with a click target to expand.
 */
export function FilterBar({
  filters,
  options,
  onChange,
}: {
  filters: EntriesFilters
  options: FilterOptions
  onChange: (next: Partial<EntriesFilters>) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const adminHeadOptions = filters.department
    ? options.adminHeads.filter((h) => h.department_id == null || String(h.department_id) === filters.department)
    : options.adminHeads
  const zoneOptions = filters.department
    ? options.zones.filter((z) => z.department_id == null || String(z.department_id) === filters.department)
    : options.zones

  const activeCount = countActiveFilters(filters)
  const chips = buildFilterSummary(filters, options)

  const chipRow =
    chips.length > 0 ? (
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <Badge key={chip.key} variant="secondary" className="gap-1 pr-1 font-normal">
            <span className="truncate">{chip.label}</span>
            <button
              type="button"
              aria-label={`Remove filter: ${chip.label}`}
              className="rounded-full p-0.5 hover:bg-foreground/10"
              onClick={() => onChange(clearFilterChip(chip.key))}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </Badge>
        ))}
      </div>
    ) : null

  if (!expanded) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex shrink-0 items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={false}
          >
            <Filter className="h-4 w-4 shrink-0" />
            <span>{activeCount === 0 ? 'No filters active' : `${activeCount} filter${activeCount === 1 ? '' : 's'}`}</span>
            <ChevronDown className="h-4 w-4 shrink-0" />
          </button>
          {chipRow}
        </div>
        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1 text-xs"
            onClick={() => onChange(DEFAULT_FILTERS)}
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="flex items-center gap-2 text-left text-sm font-medium text-foreground"
        aria-expanded={true}
      >
        <Filter className="h-4 w-4 text-muted-foreground" />
        Filters
        <ChevronUp className="h-4 w-4 text-muted-foreground" />
      </button>

      {chipRow}

      <FilterSection label="Status">
        <Field label="Type">
          <SelectNative value={filters.type} onChange={(e) => onChange({ type: e.target.value })}>
            <option value="">Any type</option>
            {options.entryTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </SelectNative>
        </Field>

        <Field label="Status">
          <SelectNative value={filters.status} onChange={(e) => onChange({ status: e.target.value })}>
            <option value="">Any status</option>
            {options.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectNative>
        </Field>

        <Field label="Hub status">
          <SelectNative value={filters.hubStatus} onChange={(e) => onChange({ hubStatus: e.target.value })}>
            <option value="">Any Hub status</option>
            {options.hubStatuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectNative>
        </Field>
      </FilterSection>

      <FilterSection label="Classification">
        <Field label="Department">
          <SelectNative
            value={filters.department}
            onChange={(e) => onChange({ department: e.target.value, adminHead: '', zone: '' })}
          >
            <option value="">All departments</option>
            {options.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </SelectNative>
        </Field>

        <Field label="Budget head">
          <SelectNative value={filters.budgetHead} onChange={(e) => onChange({ budgetHead: e.target.value })}>
            <option value="">All budget heads</option>
            {options.budgetHeads.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </SelectNative>
        </Field>

        <Field label="Admin head">
          <SelectNative value={filters.adminHead} onChange={(e) => onChange({ adminHead: e.target.value })}>
            <option value="">All admin heads</option>
            {adminHeadOptions.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </SelectNative>
        </Field>

        <Field label="Zone">
          <SelectNative value={filters.zone} onChange={(e) => onChange({ zone: e.target.value })}>
            <option value="">All zones</option>
            {zoneOptions.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </SelectNative>
        </Field>

        <Field label="Cost center">
          <SelectNative value={filters.costCenter} onChange={(e) => onChange({ costCenter: e.target.value })}>
            <option value="">All cost centers</option>
            {options.costCenters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </SelectNative>
        </Field>
      </FilterSection>

      <FilterSection label="Search">
        <Field label="Vendor">
          <Input
            placeholder="Search vendor…"
            value={filters.vendor}
            onChange={(e) => onChange({ vendor: e.target.value, vendorId: '' })}
          />
        </Field>

        <Field label="Date from">
          <Input type="date" value={filters.dateFrom} onChange={(e) => onChange({ dateFrom: e.target.value })} />
        </Field>

        <Field label="Date to">
          <Input type="date" value={filters.dateTo} onChange={(e) => onChange({ dateTo: e.target.value })} />
        </Field>
      </FilterSection>

      <div className="border-t border-border pt-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/70">Flags</h3>
        <div className="flex flex-wrap items-center gap-4">
          <ToggleField
            label="Export-pending"
            checked={filters.exportPending}
            onCheckedChange={(v) => onChange({ exportPending: v })}
          />
          <ToggleField
            label="Missing Main #"
            checked={filters.hasVariance}
            onCheckedChange={(v) => onChange({ hasVariance: v })}
          />
          <ToggleField
            label="Has document"
            checked={filters.hasDocument}
            onCheckedChange={(v) => onChange({ hasDocument: v })}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        {activeCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {activeCount} filter{activeCount === 1 ? '' : 's'} active
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 text-xs"
          disabled={activeCount === 0}
          onClick={() => onChange(DEFAULT_FILTERS)}
        >
          <X className="h-3.5 w-3.5" />
          Clear filters
        </Button>
        <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setExpanded(false)}>
          <ChevronUp className="h-3.5 w-3.5" />
          Collapse
        </Button>
      </div>
    </div>
  )
}

/**
 * Builds the removable filter chips (§4.11) — one per active filter, each
 * carrying the field `key` its X should reset. Select-based filters resolve
 * their ID to a human label via the matching options.* array;
 * dateFrom/dateTo collapse into a single `dateRange` chip.
 */
export function buildFilterSummary(filters: EntriesFilters, options: FilterOptions): FilterChip[] {
  const parts: FilterChip[] = []

  const pushSelect = (
    key: keyof EntriesFilters,
    value: string,
    opts: { id: string | number; label: string }[],
    fallback: string,
  ) => {
    if (!value) return
    const match = opts.find((o) => String(o.id) === value)
    parts.push({ key, label: match ? match.label : fallback })
  }

  pushSelect('type', filters.type, options.entryTypes, 'Type')
  pushSelect('status', filters.status, options.statuses, 'Status')
  pushSelect('hubStatus', filters.hubStatus, options.hubStatuses, 'Hub status')
  pushSelect('department', filters.department, options.departments, 'Department')
  pushSelect('budgetHead', filters.budgetHead, options.budgetHeads, 'Budget head')
  pushSelect('adminHead', filters.adminHead, options.adminHeads, 'Admin head')
  pushSelect('zone', filters.zone, options.zones, 'Zone')
  pushSelect('costCenter', filters.costCenter, options.costCenters, 'Cost center')

  if (filters.vendor) parts.push({ key: 'vendor', label: `Vendor: "${filters.vendor}"` })
  if (filters.vendorId) parts.push({ key: 'vendorId', label: 'Vendor (from link)' })

  if (filters.dateFrom || filters.dateTo) {
    parts.push({ key: 'dateRange', label: formatDateRangeSummary(filters.dateFrom, filters.dateTo) })
  }

  if (filters.exportPending) parts.push({ key: 'exportPending', label: 'Export-pending' })
  if (filters.hasVariance) parts.push({ key: 'hasVariance', label: 'Missing Main #' })
  if (filters.hasDocument) parts.push({ key: 'hasDocument', label: 'Has document' })

  return parts
}

function formatDateShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function isFirstOfMonth(iso: string): boolean {
  return iso.endsWith('-01')
}

function isLastOfMonth(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00`)
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  return d.getDate() === lastDay
}

function formatDateRangeSummary(dateFrom: string, dateTo: string): string {
  if (dateFrom && dateTo) {
    const fromD = new Date(`${dateFrom}T00:00:00`)
    const toD = new Date(`${dateTo}T00:00:00`)
    const sameMonth = fromD.getFullYear() === toD.getFullYear() && fromD.getMonth() === toD.getMonth()
    if (sameMonth && isFirstOfMonth(dateFrom) && isLastOfMonth(dateTo)) {
      return fromD.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    }
    return `${formatDateShort(dateFrom)} – ${formatDateShort(dateTo)}`
  }
  if (dateFrom) return `From ${formatDateShort(dateFrom)}`
  return `Until ${formatDateShort(dateTo)}`
}

/**
 * One labelled group within the filter bar (hub-refinements-plan.md §1:
 * "four visually distinct, labelled groups"). A fieldset-style heading
 * rather than a bordered box per group — keeps the bar from turning into
 * four separate cards while still giving each group a clear label.
 */
function FilterSection({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/70">{label}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function ToggleField({
  label,
  checked,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} />
      {label}
    </label>
  )
}
