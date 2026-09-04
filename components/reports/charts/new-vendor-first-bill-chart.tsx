'use client'

import { useState, type PointerEvent, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINRCompact } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { AttentionPill } from '@/components/reports/severity-badge'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md B-05: "Vendors first seen mid-event, ranked by the
// size of their opening invoice. A new vendor whose first bill is also
// their largest deserves a look." Scatter: x = first entry date (within the
// event), y = first entry amount. Every plotted vendor is already "new
// mid-event" (the view's is_new_mid_event flag — filtered by the caller
// before this chart ever sees a row); points where that opening bill is
// ALSO the vendor's largest to date (the finding) get the reserved
// warning-status colour plus a legend label, muted grey for the rest, never
// the plain series hue reused as a status signal (§6 fix #5).
//
// Structurally mirrors attention-map-chart.tsx: inline SVG with real
// numeric attributes for every data-driven mark (exempt from this app's
// style-src CSP constraint — see lib/reports/bar-scale.ts), a nearest-point
// pointer-move hover lookup, arrow-key navigation ordered by date, an SVG
// <title> per point as a no-JS fallback, and a required "View as table"
// twin so every value the chart conveys is also plain text.

export type NewVendorFirstBillPoint = {
  key: number
  label: string
  href?: string
  firstEntryDateMs: number
  firstEntryDateLabel: string
  firstEntryAmount: number
  isFinding: boolean
}

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 300
const PAD = { left: 56, right: 20, top: 16, bottom: 32 }
const INNER_WIDTH = VIEW_WIDTH - PAD.left - PAD.right
const INNER_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom
const HOVER_RADIUS_SQ = 20 * 20

function niceNum(range: number, round: boolean): number {
  const safeRange = range || 1
  const exponent = Math.floor(Math.log10(safeRange))
  const fraction = safeRange / 10 ** exponent
  const niceFraction = round
    ? fraction < 1.5
      ? 1
      : fraction < 3
        ? 2
        : fraction < 7
          ? 5
          : 10
    : fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 5
          ? 5
          : 10
  return niceFraction * 10 ** exponent
}

function niceTicks(min: number, max: number, tickCount = 4): number[] {
  if (min === max) return [0, min - 1, min, min + 1].filter((v) => v >= 0)
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = 0
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

export function NewVendorFirstBillChart({ points }: { points: NewVendorFirstBillPoint[] }) {
  const [hoverKey, setHoverKey] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (points.length === 0) return null

  const dateValues = points.map((p) => p.firstEntryDateMs)
  const domainMinX = Math.min(...dateValues)
  const domainMaxX = Math.max(...dateValues)
  const domainRangeX = domainMaxX - domainMinX || 1

  const amountValues = points.map((p) => p.firstEntryAmount)
  const yTicks = niceTicks(0, Math.max(...amountValues), 4)
  const domainMaxY = yTicks[yTicks.length - 1] || 1

  const xFor = (ms: number) => PAD.left + ((ms - domainMinX) / domainRangeX) * INNER_WIDTH
  const yFor = (amount: number) => PAD.top + (1 - Math.min(amount, domainMaxY) / domainMaxY) * INNER_HEIGHT

  const sortedByDate = [...points].sort((a, b) => a.firstEntryDateMs - b.firstEntryDateMs)

  function nearestPoint(relX: number, relY: number): NewVendorFirstBillPoint | null {
    let nearest: NewVendorFirstBillPoint | null = null
    let nearestDistSq = Infinity
    for (const p of points) {
      const dx = xFor(p.firstEntryDateMs) - relX
      const dy = yFor(p.firstEntryAmount) - relY
      const distSq = dx * dx + dy * dy
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq
        nearest = p
      }
    }
    return nearest && nearestDistSq <= HOVER_RADIUS_SQ ? nearest : null
  }

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const relY = ((e.clientY - rect.top) / rect.height) * VIEW_HEIGHT
    setHoverKey(nearestPoint(relX, relY)?.key ?? null)
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    const idx = sortedByDate.findIndex((p) => p.key === hoverKey)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverKey(sortedByDate[Math.min(sortedByDate.length - 1, idx + 1)]!.key)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverKey(sortedByDate[Math.max(0, idx === -1 ? sortedByDate.length - 1 : idx - 1)]!.key)
    } else if (e.key === 'Escape') {
      setHoverKey(null)
    }
  }

  const hoverPoint = hoverKey != null ? (points.find((p) => p.key === hoverKey) ?? null) : null
  const tooltipPct = hoverPoint ? (xFor(hoverPoint.firstEntryDateMs) / VIEW_WIDTH) * 100 : 50
  const findingCount = points.filter((p) => p.isFinding).length

  const tableColumns: DataTableColumn<NewVendorFirstBillPoint>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (p) =>
        p.href ? (
          <Link href={p.href} className="text-primary underline-offset-2 hover:underline">
            {p.label}
          </Link>
        ) : (
          p.label
        ),
    },
    { key: 'date', header: 'First entry date', render: (p) => p.firstEntryDateLabel },
    { key: 'amount', header: 'First entry amount', align: 'right', render: (p) => formatINRCompact(p.firstEntryAmount) },
    {
      key: 'finding',
      header: 'Opening bill is largest',
      render: (p) => (p.isFinding ? <AttentionPill>⚠ Needs a look</AttentionPill> : '—'),
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          width="100%"
          height={VIEW_HEIGHT}
          className="overflow-visible"
          role="img"
          aria-label={`New vendors first seen mid-event — one point per vendor, positioned by the date and size of their first bill. ${findingCount} of ${points.length} have an opening bill that is also their largest to date. See the table view below for exact values.`}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverKey(null)}
          onKeyDown={handleKeyDown}
        >
          {yTicks.map((t) => (
            <g key={`y-${t}`}>
              <line x1={PAD.left} x2={VIEW_WIDTH - PAD.right} y1={yFor(t)} y2={yFor(t)} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={yFor(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[9px]">
                {formatINRCompact(t)}
              </text>
            </g>
          ))}

          {/* First and last observed dates as x labels — never one per point. */}
          <text x={PAD.left} y={VIEW_HEIGHT - PAD.bottom + 16} textAnchor="start" className="fill-muted-foreground text-[9px]">
            {sortedByDate[0]!.firstEntryDateLabel}
          </text>
          <text
            x={VIEW_WIDTH - PAD.right}
            y={VIEW_HEIGHT - PAD.bottom + 16}
            textAnchor="end"
            className="fill-muted-foreground text-[9px]"
          >
            {sortedByDate[sortedByDate.length - 1]!.firstEntryDateLabel}
          </text>

          {/* Points — muted grey for an ordinary new-mid-event vendor, the
              reserved warning colour for the finding (opening bill is also
              the largest), never recoloured for any other reason. */}
          {points.map((p) => {
            const cx = xFor(p.firstEntryDateMs)
            const cy = yFor(p.firstEntryAmount)
            const isHovered = hoverKey === p.key
            const dotLabel = `${p.label}: first bill ${formatINRCompact(p.firstEntryAmount)} on ${p.firstEntryDateLabel}${
              p.isFinding ? ' — this is also their largest bill' : ''
            }`
            // The finding gets a genuinely different mark — a diamond, the
            // same shape the vendor-activity timeline uses for its finding —
            // so it survives greyscale and a colour-blind read, not just an
            // amber-vs-grey fill and a size bump.
            const half = isHovered ? 6 : 5
            const dot = (
              <>
                <title>{dotLabel}</title>
                <circle cx={cx} cy={cy} r={14} fill="transparent" />
                {p.isFinding ? (
                  <rect
                    x={cx - half}
                    y={cy - half}
                    width={half * 2}
                    height={half * 2}
                    transform={`rotate(45 ${cx} ${cy})`}
                    strokeWidth={isHovered ? 2 : 1.5}
                    className="fill-amber-500 stroke-card dark:fill-amber-400"
                  />
                ) : (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isHovered ? 6 : 3.5}
                    strokeWidth={isHovered ? 2 : 0}
                    className={cn('fill-muted-foreground/50', isHovered && 'stroke-card')}
                  />
                )}
              </>
            )
            return p.href ? (
              <Link
                key={p.key}
                href={p.href}
                aria-label={dotLabel}
                className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {dot}
              </Link>
            ) : (
              <g key={p.key}>{dot}</g>
            )
          })}
        </svg>

        {hoverPoint && (
          <div
            className={cn(
              'pointer-events-none absolute top-2 z-10 min-w-[11rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">{hoverPoint.label}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">First bill</span>
              <span className="font-mono font-semibold text-foreground">{formatINRCompact(hoverPoint.firstEntryAmount)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Date</span>
              <span className="font-mono font-semibold text-foreground">{hoverPoint.firstEntryDateLabel}</span>
            </div>
            {hoverPoint.isFinding && <p className="mt-1 text-amber-700 dark:text-amber-300">Opening bill is also their largest</p>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={12} height={12} aria-hidden="true">
            <rect x={2} y={2} width={8} height={8} transform="rotate(45 6 6)" className="fill-amber-500 dark:fill-amber-400" />
          </svg>
          Opening bill is also the largest — needs a look
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={10} height={10} aria-hidden="true">
            <circle cx={5} cy={5} r={3.5} className="fill-muted-foreground/50" />
          </svg>
          Other vendors new this event
        </span>
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && (
        <DataTable
          columns={tableColumns}
          rows={[...points].sort((a, b) => b.firstEntryAmount - a.firstEntryAmount)}
          getRowKey={(p) => p.key}
        />
      )}
    </div>
  )
}
