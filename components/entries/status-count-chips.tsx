'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/reports/format'
import { statusBadgeVariant } from '@/lib/status-badge'

export type EntryStatusCount = {
  /** null for the synthetic "not set" bucket — nothing to filter `/entries` on.
   *  string for the `type` dimension, which has no numeric id — its code
   *  itself (e.g. "invoice") is what `/entries` filters on. */
  id: number | string | null
  code: string
  label: string
  count: number
}

/**
 * Compact clickable status-count row above the entries table
 * (docs/hub-screen-certification.md §3.7). Wiring only — `v_entry_status_counts`
 * already exists and the Dashboard already consumes it; nothing on Entries
 * read it before. Each chip toggles its own filter (`st` / `hs`); the
 * currently-applied value reads as selected.
 */
export function StatusCountChips({
  typeCounts,
  statusCounts,
  hubStatusCounts,
  activeType,
  activeStatus,
  activeHubStatus,
  onSelectType,
  onSelectStatus,
  onSelectHubStatus,
}: {
  typeCounts: EntryStatusCount[]
  statusCounts: EntryStatusCount[]
  hubStatusCounts: EntryStatusCount[]
  activeType: string
  activeStatus: string
  activeHubStatus: string
  onSelectType: (id: string) => void
  onSelectStatus: (id: string) => void
  onSelectHubStatus: (id: string) => void
}) {
  if (typeCounts.length === 0 && statusCounts.length === 0 && hubStatusCounts.length === 0) return null

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5 text-xs">
      <ChipGroup
        label="Type"
        rows={typeCounts}
        active={activeType}
        onSelect={onSelectType}
      />
      <ChipGroup
        label="Status"
        rows={statusCounts}
        active={activeStatus}
        onSelect={onSelectStatus}
      />
      <ChipGroup
        label="Hub status"
        rows={hubStatusCounts}
        active={activeHubStatus}
        onSelect={onSelectHubStatus}
      />
    </div>
  )
}

function ChipGroup({
  label,
  rows,
  active,
  onSelect,
}: {
  label: string
  rows: EntryStatusCount[]
  active: string
  onSelect: (id: string) => void
}) {
  if (rows.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {rows.map((row) => {
        const idStr = row.id === null ? '' : String(row.id)
        const isActive = idStr !== '' && active === idStr
        const inert = row.id === null
        return (
          <button
            key={row.code}
            type="button"
            disabled={inert}
            aria-pressed={isActive}
            onClick={() => onSelect(isActive ? '' : idStr)}
            className={cn(
              'rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              inert && 'cursor-default',
            )}
          >
            <Badge
              variant={isActive ? 'default' : statusBadgeVariant(row.code, row.label)}
              className={cn('gap-1', !inert && 'hover:opacity-80')}
            >
              {row.label}
              <span className="font-mono">{formatNumber(row.count)}</span>
            </Badge>
          </button>
        )
      })}
    </div>
  )
}
