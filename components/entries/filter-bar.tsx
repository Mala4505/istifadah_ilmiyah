'use client'

import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { SelectNative } from '@/components/ui/select-native'
import { DEFAULT_FILTERS, type EntriesFilters, type FilterOptions } from './types'

/**
 * Filter controls for the entries list (MASTER-PLAN §5 row 3). Purely
 * controlled — entries-explorer.tsx owns the actual filter state and syncs
 * it to the URL, so a filtered view is copy-pasteable.
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
  const headOptions = filters.department
    ? options.heads.filter((h) => h.department_id == null || String(h.department_id) === filters.department)
    : options.heads
  const zoneOptions = filters.department
    ? options.zones.filter((z) => z.department_id == null || String(z.department_id) === filters.department)
    : options.zones

  const activeCount = Object.entries(filters).filter(([key, value]) => {
    const def = DEFAULT_FILTERS[key as keyof EntriesFilters]
    return value !== def
  }).length

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Department">
          <SelectNative
            value={filters.department}
            onChange={(e) => onChange({ department: e.target.value, head: '', zone: '' })}
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

        <Field label="Head">
          <SelectNative value={filters.head} onChange={(e) => onChange({ head: e.target.value })}>
            <option value="">All heads</option>
            {headOptions.map((h) => (
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

        <Field label="Tenant status">
          <SelectNative value={filters.tenantStatus} onChange={(e) => onChange({ tenantStatus: e.target.value })}>
            <option value="">Any tenant status</option>
            {options.tenantStatuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectNative>
        </Field>

        <Field label="Main status">
          <SelectNative value={filters.mainStatus} onChange={(e) => onChange({ mainStatus: e.target.value })}>
            <option value="">Any main status</option>
            {options.mainStatuses.map((s) => (
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

        <Field label="Vendor">
          <Input
            placeholder="Search vendor…"
            value={filters.vendor}
            onChange={(e) => onChange({ vendor: e.target.value })}
          />
        </Field>

        <Field label="Date from">
          <Input type="date" value={filters.dateFrom} onChange={(e) => onChange({ dateFrom: e.target.value })} />
        </Field>

        <Field label="Date to">
          <Input type="date" value={filters.dateTo} onChange={(e) => onChange({ dateTo: e.target.value })} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
        <ToggleField
          label="Export-pending"
          checked={filters.exportPending}
          onCheckedChange={(v) => onChange({ exportPending: v })}
        />
        <ToggleField label="Has variance" checked={filters.hasVariance} onCheckedChange={(v) => onChange({ hasVariance: v })} />
        <ToggleField
          label="Has document"
          checked={filters.hasDocument}
          onCheckedChange={(v) => onChange({ hasDocument: v })}
        />
        <div className="ml-auto flex items-center gap-2">
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
        </div>
      </div>
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
