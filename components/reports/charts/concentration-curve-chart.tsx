'use client'

import { useState, type PointerEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import type { ConcentrationPoint } from '@/lib/reports/sections/shared'

// reporting-blueprint.md B-01 (flagship): "Cumulative share of spend as vendors
// are added, ranked. Deliberately NOT a classic Pareto — two scales on one
// chart is the single most common way a finance chart misleads." So: one axis
// (cumulative % up the side), one line (the curve), one dashed reference line
// (where the curve would sit if every vendor took an equal share). The gap
// between the two IS the concentration.
//
// Structurally mirrors trend-chart.tsx / attention-map-chart.tsx: inline SVG
// with real numeric attributes for every data-driven mark (exempt from this
// app's style-src CSP constraint — see lib/reports/bar-scale.ts), a
// pointer-move hover crosshair, and a required "View as table" twin so every
// value the chart conveys is also plain text (dataviz skill: tooltips enhance,
// never gate).

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 260
const PAD = { left: 40, right: 20, top: 16, bottom: 28 }
const INNER_WIDTH = VIEW_WIDTH - PAD.left - PAD.right
const INNER_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom
const Y_TICKS = [0, 25, 50, 75, 100]

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
  if (min === max) return [min]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

export function ConcentrationCurveChart({ points }: { points: ConcentrationPoint[] }) {
  const [hoverRank, setHoverRank] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (points.length === 0) return null

  const n = points.length
  const xTicks = niceTicks(0, n, 4).filter((t) => t >= 0 && t <= n)
  const domainMaxX = Math.max(n, xTicks[xTicks.length - 1] ?? n)

  const xFor = (rank: number) => PAD.left + (rank / domainMaxX) * INNER_WIDTH
  const yFor = (pct: number) => PAD.top + (1 - pct / 100) * INNER_HEIGHT

  // Curve path — anchored at the origin (0 vendors, 0% of spend), then one
  // point per vendor at (rank, cumulative share).
  const curvePath = [
    `M${xFor(0).toFixed(2)},${yFor(0).toFixed(2)}`,
    ...points.map((p) => `L${xFor(p.rank).toFixed(2)},${yFor(p.cumulativeSharePct).toFixed(2)}`),
  ].join(' ')
  const areaPath = `${curvePath} L${xFor(n).toFixed(2)},${yFor(0).toFixed(2)} Z`

  // Even-spend reference: straight from (0,0) to (n,100).
  const refPath = `M${xFor(0).toFixed(2)},${yFor(0).toFixed(2)} L${xFor(n).toFixed(2)},${yFor(100).toFixed(2)}`

  const lastPoint = points[n - 1]!

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const rank = Math.round(((relX - PAD.left) / INNER_WIDTH) * domainMaxX)
    setHoverRank(Math.max(1, Math.min(n, rank)))
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverRank((r) => Math.min(n, (r ?? 0) + 1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverRank((r) => Math.max(1, (r ?? n + 1) - 1))
    } else if (e.key === 'Escape') {
      setHoverRank(null)
    }
  }

  const hoverPoint = hoverRank != null ? points[hoverRank - 1]! : null
  const tooltipPct = hoverPoint ? (xFor(hoverPoint.rank) / VIEW_WIDTH) * 100 : 50

  const tableColumns: DataTableColumn<ConcentrationPoint>[] = [
    { key: 'rank', header: '#', align: 'right', render: (p) => formatNumber(p.rank) },
    { key: 'vendor', header: 'Vendor', render: (p) => p.vendorName },
    { key: 'spend', header: 'Spend', align: 'right', render: (p) => formatINRCompact(p.spend) },
    { key: 'share', header: 'Share', align: 'right', render: (p) => formatPercent(p.sharePct) },
    { key: 'cumulative', header: 'Cumulative share', align: 'right', render: (p) => formatPercent(p.cumulativeSharePct) },
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
          aria-label="Vendor concentration curve — cumulative share of spend as vendors are added, ranked largest first; see the table view below for exact values"
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverRank(null)}
          onKeyDown={handleKeyDown}
        >
          {Y_TICKS.map((t) => (
            <g key={`y-${t}`}>
              <line x1={PAD.left} x2={VIEW_WIDTH - PAD.right} y1={yFor(t)} y2={yFor(t)} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={yFor(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[9px]">
                {formatPercent(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={`x-${t}`} x={xFor(t)} y={VIEW_HEIGHT - PAD.bottom + 14} textAnchor="middle" className="fill-muted-foreground text-[9px]">
              {formatNumber(Math.round(t))}
            </text>
          ))}
          <text x={PAD.left + INNER_WIDTH / 2} y={VIEW_HEIGHT - 2} textAnchor="middle" className="fill-muted-foreground text-[9px]">
            Vendors, largest spend first
          </text>

          {/* Even-spend reference — dashed, muted (the legitimate dash use). */}
          <path d={refPath} className="fill-none stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="5 3" />

          {/* The curve — one accent hue, ~10% area wash. */}
          <path d={areaPath} className="fill-[#2a78d6]/10 dark:fill-[#3987e5]/10" />
          <path d={curvePath} className="fill-none stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

          <circle cx={xFor(lastPoint.rank)} cy={yFor(lastPoint.cumulativeSharePct)} r={3} className="fill-[#2a78d6] dark:fill-[#3987e5]" />

          {hoverPoint && (
            <g>
              <line
                x1={xFor(hoverPoint.rank)}
                x2={xFor(hoverPoint.rank)}
                y1={PAD.top}
                y2={VIEW_HEIGHT - PAD.bottom}
                className="stroke-foreground/30"
                strokeWidth={1}
              />
              <circle
                cx={xFor(hoverPoint.rank)}
                cy={yFor(hoverPoint.cumulativeSharePct)}
                r={4}
                strokeWidth={2}
                className="fill-[#2a78d6] stroke-card dark:fill-[#3987e5]"
              />
            </g>
          )}
        </svg>

        {hoverPoint && (
          <div
            className={cn(
              'pointer-events-none absolute top-2 z-10 min-w-[11rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">
              #{hoverPoint.rank} · {hoverPoint.vendorName}
            </p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Top {hoverPoint.rank} carry</span>
              <span className="font-mono font-semibold text-foreground">{formatPercent(hoverPoint.cumulativeSharePct)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">This vendor</span>
              <span className="font-mono font-semibold text-foreground">
                {formatINRCompact(hoverPoint.spend)} · {formatPercent(hoverPoint.sharePct)}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={14} height={4} aria-hidden="true">
            <line x1={0} y1={2} x2={14} y2={2} className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} />
          </svg>
          Cumulative share of spend
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={14} height={4} aria-hidden="true">
            <line x1={0} y1={2} x2={14} y2={2} className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="3 2" />
          </svg>
          If every vendor took an equal share
        </span>
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={points} getRowKey={(p) => p.vendorId} />}
    </div>
  )
}
