'use client'

import { formatINR } from '@/lib/reports/format'
import { StackedDepartmentBars, type StackedRow, type StackedSeries } from './stacked-department-bars'
import { ORDINAL_RAMP } from './ordinal-ramp'

// docs/entry-tags-plan.md Phase 5 -- "Tags: built vs maintained". One horizontal stacked bar
// per tag active in the selected event, on ONE ₹ axis: what was already spent on it in
// earlier events (carried in) and what has been spent on it this event. Voided entries are
// never part of either figure (decision 11).
//
// Colour (dataviz skill): the two series are positions in time, so they take two steps of
// the screen's blue ordinal ramp (charts/ordinal-ramp.ts, already validated) -- light for
// earlier events, dark for this event -- in that fixed order. Legend always shown; the
// section's table carries exact figures. Tooltips use full INR grouping (₹2,41,76,880).
//
// Client-only: imports no runtime value from lib/reports/tags.ts (server Supabase client).

const SERIES: readonly StackedSeries[] = [
  { key: 'carriedIn', label: 'Spent in earlier events', theme: ORDINAL_RAMP[0]!.hex },
  { key: 'thisEvent', label: 'Spent this event', theme: ORDINAL_RAMP[3]!.hex },
]

export type TagCarryBar = {
  tagId: number
  name: string
  carriedIn: number
  thisEvent: number
}

export function TagCarryChart({ bars }: { bars: TagCarryBar[] }) {
  const rows: StackedRow[] = bars
    .filter((b) => b.carriedIn + b.thisEvent > 0)
    .map((b) => ({
      rowKey: String(b.tagId),
      label: b.name,
      href: `/tags/${b.tagId}`,
      total: b.carriedIn + b.thisEvent,
      values: { carriedIn: b.carriedIn, thisEvent: b.thisEvent },
    }))
  if (rows.length === 0) return null

  return (
    <StackedDepartmentBars
      rows={rows}
      series={SERIES}
      mode="absolute"
      tooltipValueFormat={formatINR}
      ariaLabel="Tag cost carried in — for each tag active in this event, rupees spent on it in earlier events and rupees spent this event. Voided entries excluded. See the table below for exact figures."
    />
  )
}
