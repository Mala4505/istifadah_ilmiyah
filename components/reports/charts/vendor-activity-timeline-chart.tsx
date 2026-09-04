'use client'

import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatDate, formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { AttentionPill } from '@/components/reports/severity-badge'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md B-09: "First and last invoice per vendor, and the
// gaps. Surfaces vendors that appear once for a large amount and are never
// seen again." One horizontal lane per vendor (top ~30 by spend), a segment
// from first→last entry date across a shared event time axis, a dot at each
// distinct active day, single-appearance vendors marked with a distinct
// shape rather than colour alone (§6 fix #6). X axis = calendar weeks of the
// event.
//
// Structurally mirrors strip-plot-chart.tsx: inline SVG with real numeric
// attributes for every data-driven mark (exempt from this app's style-src
// CSP constraint — see lib/reports/bar-scale.ts), a pointer-move nearest-row
// hover lookup, keyboard nav across lanes, role="img" + aria-label, and a
// required "View as table" twin so every value the chart conveys is also
// plain text. One accent hue (the screen's normal blue) for an ordinary
// vendor's span; a single-appearance vendor gets the reserved warning colour
// (amber) PLUS a diamond marker and its own legend entry — never colour
// alone (§6 fix #5) — because a single appearance for a large amount is
// exactly the finding this report exists to surface.

export type ActivityLaneVendor = {
  vendorId: number
  vendorName: string
  firstDate: string
  lastDate: string
  activeDates: string[]
  entryCount: number
  distinctActiveDays: number
  maxGapDays: number
  totalSpend: number | null
  singleAppearance: boolean
  /** True when this vendor also clears the materiality bar the section
   *  applies for "large amount" — drawn with the warning colour/marker;
   *  a single appearance below the bar still gets the diamond shape but
   *  stays in the neutral accent hue. */
  isMaterialSingleAppearance: boolean
}

const VIEW_WIDTH = 640
const ROW_HEIGHT = 26
const PAD = { left: 150, right: 20, top: 22, bottom: 34 }
const MAX_LANES = 30
const HOVER_RADIUS_PX = 14

const MS_PER_DAY = 24 * 60 * 60 * 1000

function toUtcDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
}

function startOfIsoWeekUtc(d: Date): Date {
  const day = d.getUTCDay() // 0 = Sunday
  const diffToMonday = (day + 6) % 7
  return new Date(d.getTime() - diffToMonday * MS_PER_DAY)
}

/** Monday-anchored week-start ticks spanning [start, end], inclusive. Capped
 *  so a corrupt/very wide date range can't spin — a real event runs months,
 *  never years. */
function weekTicks(startIso: string, endIso: string): Date[] {
  const start = startOfIsoWeekUtc(toUtcDate(startIso))
  const end = toUtcDate(endIso)
  const ticks: Date[] = []
  let cursor = start
  let guard = 0
  while (cursor.getTime() <= end.getTime() && guard < 260) {
    ticks.push(cursor)
    cursor = new Date(cursor.getTime() + 7 * MS_PER_DAY)
    guard += 1
  }
  if (ticks.length === 0) ticks.push(start)
  return ticks
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function VendorActivityTimelineChart({
  vendors,
  domainStart,
  domainEnd,
}: {
  vendors: ActivityLaneVendor[]
  domainStart: string
  domainEnd: string
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (vendors.length === 0) return null

  const rows = vendors.slice(0, MAX_LANES)
  const hiddenCount = vendors.length - rows.length

  const domainStartMs = toUtcDate(domainStart).getTime()
  const domainEndMsRaw = toUtcDate(domainEnd).getTime()
  const domainEndMs = Math.max(domainEndMsRaw, domainStartMs + MS_PER_DAY)
  const domainRangeMs = domainEndMs - domainStartMs

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right
  const plotHeight = rows.length * ROW_HEIGHT
  const viewHeight = PAD.top + plotHeight + PAD.bottom

  const xFor = (iso: string) => {
    const t = toUtcDate(iso).getTime()
    const clamped = Math.max(domainStartMs, Math.min(domainEndMs, t))
    return PAD.left + ((clamped - domainStartMs) / domainRangeMs) * innerWidth
  }
  const rowCentre = (i: number) => PAD.top + i * ROW_HEIGHT + ROW_HEIGHT / 2

  const ticks = weekTicks(domainStart, domainEnd)
  // Thin the week labels so they don't collide — show at most ~8 across the
  // width, always including the first and last tick.
  const labelStride = Math.max(1, Math.ceil(ticks.length / 8))

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relY = ((e.clientY - rect.top) / rect.height) * viewHeight
    const idx = Math.floor((relY - PAD.top) / ROW_HEIGHT)
    if (idx >= 0 && idx < rows.length && relY >= PAD.top - HOVER_RADIUS_PX && relY <= PAD.top + plotHeight + HOVER_RADIUS_PX) {
      setHoverIndex(idx)
    } else {
      setHoverIndex(null)
    }
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHoverIndex((i) => Math.min(rows.length - 1, (i ?? -1) + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHoverIndex((i) => Math.max(0, (i ?? rows.length) - 1))
    } else if (e.key === 'Escape') {
      setHoverIndex(null)
    }
  }

  const hoverRow = hoverIndex != null ? rows[hoverIndex]! : null
  const tooltipPct = hoverRow ? ((xFor(hoverRow.firstDate) + xFor(hoverRow.lastDate)) / 2 / VIEW_WIDTH) * 100 : 50

  const tableColumns: DataTableColumn<ActivityLaneVendor>[] = [
    { key: 'vendor', header: 'Vendor', render: (r) => r.vendorName },
    { key: 'first', header: 'First entry', render: (r) => formatDate(r.firstDate) },
    { key: 'last', header: 'Last entry', render: (r) => formatDate(r.lastDate) },
    { key: 'days', header: 'Active days', align: 'right', render: (r) => formatNumber(r.distinctActiveDays) },
    { key: 'gap', header: 'Max gap (days)', align: 'right', render: (r) => formatNumber(r.maxGapDays) },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entryCount) },
    { key: 'spend', header: 'Spend', align: 'right', render: (r) => formatINR(r.totalSpend) },
    {
      key: 'single',
      header: 'Single appearance',
      render: (r) => (r.singleAppearance ? <AttentionPill>Single appearance</AttentionPill> : '—'),
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${viewHeight}`}
          width="100%"
          height={viewHeight}
          role="img"
          aria-label={`Vendor activity timeline — ${formatNumber(rows.length)} vendors, one lane each, spanning from their first to last entry across the event's calendar weeks. Dots mark each active day; a diamond marks a vendor with only one entry. See the table view below for exact values.`}
          tabIndex={0}
          className="overflow-visible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
          onKeyDown={handleKeyDown}
        >
          {/* Week gridlines — hairline solid, never dashed (dataviz skill). */}
          {ticks.map((t, i) => {
            const iso = t.toISOString().slice(0, 10)
            const x = xFor(iso)
            const showLabel = i % labelStride === 0 || i === ticks.length - 1
            return (
              <g key={iso}>
                <line x1={x} x2={x} y1={PAD.top} y2={PAD.top + plotHeight} className="stroke-border" strokeWidth={1} />
                {showLabel && (
                  <text x={x} y={PAD.top + plotHeight + 14} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                    {formatDate(iso)}
                  </text>
                )}
              </g>
            )
          })}

          {/* Lanes. */}
          {rows.map((row, i) => {
            const cy = rowCentre(i)
            const x1 = xFor(row.firstDate)
            const x2 = xFor(row.lastDate)
            const isHovered = hoverIndex === i
            const warn = row.isMaterialSingleAppearance
            const laneColor = warn ? 'stroke-amber-500 dark:stroke-amber-400' : 'stroke-[#2a78d6] dark:stroke-[#3987e5]'
            const dotColor = warn ? 'fill-amber-500 dark:fill-amber-400' : 'fill-[#2a78d6] dark:fill-[#3987e5]'
            return (
              <g key={row.vendorId}>
                {i > 0 && (
                  <line
                    x1={PAD.left}
                    x2={VIEW_WIDTH - PAD.right}
                    y1={PAD.top + i * ROW_HEIGHT}
                    y2={PAD.top + i * ROW_HEIGHT}
                    className="stroke-border/60"
                    strokeWidth={1}
                  />
                )}
                <text
                  x={PAD.left - 10}
                  y={cy}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className={cn('text-[10px]', isHovered ? 'fill-foreground font-medium' : 'fill-foreground')}
                >
                  {truncate(row.vendorName, 20)}
                </text>

                <title>
                  {row.singleAppearance
                    ? `${row.vendorName}: single entry on ${formatDate(row.firstDate)}, ${formatINR(row.totalSpend)}`
                    : `${row.vendorName}: ${formatDate(row.firstDate)} to ${formatDate(row.lastDate)}, ${formatNumber(row.distinctActiveDays)} active days, ${formatINR(row.totalSpend)}`}
                </title>

                {row.singleAppearance ? (
                  <rect
                    x={x1 - 4}
                    y={cy - 4}
                    width={8}
                    height={8}
                    transform={`rotate(45 ${x1} ${cy})`}
                    strokeWidth={isHovered ? 2 : 0}
                    className={cn(dotColor, isHovered && 'stroke-card')}
                  />
                ) : (
                  <>
                    <line x1={x1} x2={x2} y1={cy} y2={cy} className={laneColor} strokeWidth={isHovered ? 3 : 2} strokeLinecap="round" />
                    {row.activeDates.map((d) => (
                      <circle key={d} cx={xFor(d)} cy={cy} r={isHovered ? 3.5 : 2.5} className={dotColor} />
                    ))}
                  </>
                )}
              </g>
            )
          })}
        </svg>

        {hoverRow && (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[13rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">{hoverRow.vendorName}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">First → last</span>
              <span className="font-mono font-semibold text-foreground">
                {formatDate(hoverRow.firstDate)} → {formatDate(hoverRow.lastDate)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Active days</span>
              <span className="font-mono font-semibold text-foreground">{formatNumber(hoverRow.distinctActiveDays)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Max gap</span>
              <span className="font-mono font-semibold text-foreground">{formatNumber(hoverRow.maxGapDays)} days</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Spend</span>
              <span className="font-mono font-semibold text-foreground">{formatINRCompact(hoverRow.totalSpend)}</span>
            </div>
            {hoverRow.singleAppearance && (
              <p className="mt-1 font-medium text-amber-700 dark:text-amber-400">Single appearance</p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={16} height={10} aria-hidden="true">
            <line x1={1} y1={5} x2={15} y2={5} className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} />
            <circle cx={8} cy={5} r={2.5} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
          </svg>
          Active span, dot = active day
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={10} height={10} aria-hidden="true">
            <rect x={1} y={1} width={8} height={8} transform="rotate(45 5 5)" className="fill-amber-500 dark:fill-amber-400" />
          </svg>
          Single appearance, above the materiality bar
        </span>
      </div>

      {hiddenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(rows.length)} vendors with the most spend; {formatNumber(hiddenCount)} more{' '}
          {hiddenCount === 1 ? 'is' : 'are'} in the table.
        </p>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={vendors} getRowKey={(r) => r.vendorId} />}
    </div>
  )
}
