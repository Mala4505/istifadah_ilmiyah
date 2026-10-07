'use client'

import type * as React from 'react'

// One "swatch · label ........ value" row for a ChartTooltipContent `formatter`
// (components/ui/chart.tsx). The formatter replaces the default row wholesale,
// so the reports charts that need ₹ formatting share this instead of each
// re-building the swatch. Text stays in text tokens; only the swatch carries
// the series colour (dataviz skill: text never wears the data colour).
export function TooltipValueRow({
  color,
  label,
  value,
  dashed = false,
}: {
  color?: string
  label: React.ReactNode
  value: React.ReactNode
  /** Line-style key (dashed/dotted series) instead of a filled square. */
  dashed?: boolean
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {dashed ? (
          <span
            aria-hidden="true"
            className="w-3 shrink-0 border-t-2 border-dashed border-[--swatch]"
            style={{ '--swatch': color } as React.CSSProperties}
          />
        ) : (
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-[2px] bg-[--swatch]"
            style={{ '--swatch': color } as React.CSSProperties}
          />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span className="font-mono font-medium tabular-nums text-foreground">{value}</span>
    </div>
  )
}
