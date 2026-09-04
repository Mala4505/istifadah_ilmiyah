'use client'

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatNumber, formatPercent } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md C-06: "The same vendor giving different discounts
// to different departments on the same item family." A dumbbell / range
// plot: one row per (vendor, item family), a horizontal segment spanning its
// lowest- to highest-discounted department, with one dot per department at
// its own average discount %. The segment length IS the spread — no shading
// or threshold band on the % axis itself, unlike the strip plot's
// above-median wash, because there is no "good side" of a discount
// percentage the way there is a "good side" of a median rate; only the
// LENGTH of the segment (the cross-department gap) carries a finding.
//
// Departments get a consistent categorical color (by first appearance across
// rows) so the same department reads as the same dot color down the whole
// chart — legend below lists every department shown. Rows beyond MAX_ROWS
// (sorted by spread, widest first) stay in the required "View as table"
// twin rather than cluttering the plot.
//
// Structurally mirrors strip-plot-chart.tsx: inline SVG with real numeric
// attributes for every data-driven mark (exempt from this app's style-src
// CSP constraint — see lib/reports/bar-scale.ts), a pointer-move nearest-dot
// hover lookup, keyboard nav across dots, role="img" + aria-label, and the
// table twin.

export type DiscountSpreadChartGroup = {
  key: string
  vendorName: string
  familyLabel: string
  spreadPp: number
  departments: { departmentId: number | null; departmentName: string; avgDiscountPct: number; observationCount: number }[]
}

const MAX_ROWS = 12
const VIEW_WIDTH = 620
const ROW_HEIGHT = 32
const PAD = { left: 168, right: 24, top: 20, bottom: 30 }
const HOVER_RADIUS_SQ = 20 * 20

// Muted categorical hues — same family as rate-drift-chart.tsx's series
// palette (distinct identities, no inherent order), reused here per
// department instead of per vendor-item series.
const DEPT_DOT_FILL_CLASSES = [
  'fill-[#2a78d6] dark:fill-[#5b9be8]',
  'fill-[#c0742d] dark:fill-[#e0975a]',
  'fill-[#3f8f7a] dark:fill-[#5cae98]',
  'fill-[#9553a6] dark:fill-[#b57bc4]',
  'fill-[#767b3f] dark:fill-[#9ba35a]',
  'fill-[#6b6f76] dark:fill-[#9aa0a8]',
] as const

function niceNum(range: number, round: boolean): number {
  const safeRange = range || 1
  const exponent = Math.floor(Math.log10(safeRange))
  const fraction = safeRange / 10 ** exponent
  let niceFraction: number
  if (round) {
    niceFraction = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10
  } else {
    niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  }
  return niceFraction * 10 ** exponent
}

function niceTicks(min: number, max: number, tickCount = 4): number[] {
  if (min === max) return [0, min]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

type PlacedDot = {
  groupKey: string
  vendorName: string
  familyLabel: string
  departmentName: string
  avgDiscountPct: number
  observationCount: number
  colorIndex: number
  cx: number
  cy: number
}

export function DiscountSpreadChart({ groups }: { groups: DiscountSpreadChartGroup[] }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [showTable, setShowTable] = useState(false)

  const allRows = useMemo(() => [...groups].sort((a, b) => b.spreadPp - a.spreadPp), [groups])
  const rows = allRows.slice(0, MAX_ROWS)
  const hiddenCount = allRows.length - rows.length

  const departmentColorIndex = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of rows) {
      for (const d of g.departments) {
        if (!m.has(d.departmentName)) m.set(d.departmentName, m.size % DEPT_DOT_FILL_CLASSES.length)
      }
    }
    return m
  }, [rows])

  if (groups.length === 0) return null

  const allPct = rows.flatMap((g) => g.departments.map((d) => d.avgDiscountPct))
  const ticks = niceTicks(0, Math.max(5, ...allPct), 4)
  const domainMax = ticks[ticks.length - 1]!

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right
  const plotHeight = rows.length * ROW_HEIGHT
  const viewHeight = PAD.top + plotHeight + PAD.bottom

  const xFor = (pct: number) => PAD.left + (Math.min(pct, domainMax) / domainMax) * innerWidth
  const rowCentre = (i: number) => PAD.top + i * ROW_HEIGHT + ROW_HEIGHT / 2

  const placed: PlacedDot[] = rows.flatMap((g, rowIndex) =>
    g.departments.map((d) => ({
      groupKey: g.key,
      vendorName: g.vendorName,
      familyLabel: g.familyLabel,
      departmentName: d.departmentName,
      avgDiscountPct: d.avgDiscountPct,
      observationCount: d.observationCount,
      colorIndex: departmentColorIndex.get(d.departmentName) ?? 0,
      cx: xFor(d.avgDiscountPct),
      cy: rowCentre(rowIndex),
    }))
  )
  const dotKey = (d: PlacedDot) => `${d.groupKey}::${d.departmentName}`
  const placedByX = [...placed].sort((a, b) => a.cx - b.cx)

  function nearestKey(relX: number, relY: number): string | null {
    let bestKey: string | null = null
    let bestSq = Infinity
    for (const p of placed) {
      const dx = p.cx - relX
      const dy = p.cy - relY
      const sq = dx * dx + dy * dy
      if (sq < bestSq) {
        bestSq = sq
        bestKey = dotKey(p)
      }
    }
    return bestSq <= HOVER_RADIUS_SQ ? bestKey : null
  }

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const relY = ((e.clientY - rect.top) / rect.height) * viewHeight
    setHoverKey(nearestKey(relX, relY))
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (placedByX.length === 0) return
    const idx = placedByX.findIndex((p) => dotKey(p) === hoverKey)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverKey(dotKey(placedByX[Math.min(placedByX.length - 1, idx + 1)]!))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverKey(dotKey(placedByX[Math.max(0, idx === -1 ? placedByX.length - 1 : idx - 1)]!))
    } else if (e.key === 'Escape') {
      setHoverKey(null)
    }
  }

  const hoverDot = hoverKey != null ? (placed.find((p) => dotKey(p) === hoverKey) ?? null) : null
  const tooltipPct = hoverDot ? (hoverDot.cx / VIEW_WIDTH) * 100 : 50

  const tableColumns: DataTableColumn<{
    vendor: string
    family: string
    department: string
    avgPct: number
    obsCount: number
    spread: number
  }>[] = [
    { key: 'vendor', header: 'Vendor', render: (r) => r.vendor },
    { key: 'family', header: 'Item family', render: (r) => r.family },
    { key: 'department', header: 'Department', render: (r) => r.department },
    { key: 'avg', header: 'Avg. discount', align: 'right', render: (r) => formatPercent(r.avgPct) },
    { key: 'obs', header: 'Observations', align: 'right', render: (r) => formatNumber(r.obsCount) },
    { key: 'spread', header: 'Group spread', align: 'right', render: (r) => `${r.spread.toFixed(1)} pp` },
  ]
  const tableRows = allRows.flatMap((g) =>
    g.departments.map((d) => ({
      vendor: g.vendorName,
      family: g.familyLabel,
      department: d.departmentName,
      avgPct: d.avgDiscountPct,
      obsCount: d.observationCount,
      spread: g.spreadPp,
    }))
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${viewHeight}`}
          width="100%"
          height={viewHeight}
          className="overflow-visible"
          role="img"
          aria-label="Discount consistency — one row per vendor and item family, a horizontal segment spanning its lowest- to highest-discounted department, one dot per department. See the table view below for exact values."
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverKey(null)}
          onKeyDown={handleKeyDown}
        >
          {ticks.map((t) => (
            <g key={`x-${t}`}>
              <line x1={xFor(t)} x2={xFor(t)} y1={PAD.top} y2={PAD.top + plotHeight} className="stroke-border" strokeWidth={1} />
              <text x={xFor(t)} y={PAD.top + plotHeight + 16} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {t.toFixed(0)}%
              </text>
            </g>
          ))}
          <text x={PAD.left + innerWidth / 2} y={viewHeight - 8} textAnchor="middle" className="fill-muted-foreground text-[9px]">
            Average discount by department
          </text>

          {rows.map((g, i) => {
            const minPct = Math.min(...g.departments.map((d) => d.avgDiscountPct))
            const maxPct = Math.max(...g.departments.map((d) => d.avgDiscountPct))
            return (
              <g key={g.key}>
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
                <text x={PAD.left - 10} y={rowCentre(i)} textAnchor="end" dominantBaseline="middle" className="fill-foreground text-[10px]">
                  <tspan>{g.vendorName.length > 16 ? `${g.vendorName.slice(0, 15)}…` : g.vendorName}</tspan>
                  <tspan className="fill-muted-foreground"> · {g.familyLabel.length > 14 ? `${g.familyLabel.slice(0, 13)}…` : g.familyLabel}</tspan>
                </text>
                <line
                  x1={xFor(minPct)}
                  x2={xFor(maxPct)}
                  y1={rowCentre(i)}
                  y2={rowCentre(i)}
                  className="stroke-foreground/40"
                  strokeWidth={2}
                />
              </g>
            )
          })}

          {placed.map((p) => {
            const isHovered = hoverKey === dotKey(p)
            return (
              <g key={dotKey(p)}>
                <title>{`${p.vendorName} · ${p.familyLabel} — ${p.departmentName}: ${formatPercent(p.avgDiscountPct)} avg. discount`}</title>
                <circle cx={p.cx} cy={p.cy} r={10} fill="transparent" />
                <circle
                  cx={p.cx}
                  cy={p.cy}
                  r={isHovered ? 5.5 : 4}
                  strokeWidth={isHovered ? 2 : 0}
                  className={cn(DEPT_DOT_FILL_CLASSES[p.colorIndex], isHovered && 'stroke-card')}
                />
              </g>
            )
          })}
        </svg>

        {hoverDot && (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[12rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipPct)
            )}
          >
            <p className="font-medium text-foreground">{hoverDot.departmentName}</p>
            <p className="mb-1 text-[11px] text-muted-foreground">
              {hoverDot.vendorName} · {hoverDot.familyLabel}
            </p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Avg. discount</span>
              <span className="font-mono font-semibold text-foreground">{formatPercent(hoverDot.avgDiscountPct)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Observations</span>
              <span className="font-mono font-semibold text-foreground">{formatNumber(hoverDot.observationCount)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {[...departmentColorIndex.entries()].map(([name, idx]) => (
          <span key={name} className="flex items-center gap-1.5">
            <svg width={10} height={10} aria-hidden="true">
              <circle cx={5} cy={5} r={4} className={DEPT_DOT_FILL_CLASSES[idx]} />
            </svg>
            {name}
          </span>
        ))}
      </div>

      {hiddenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(rows.length)} vendor + item family pairs with the widest cross-department spread;{' '}
          {formatNumber(hiddenCount)} more {hiddenCount === 1 ? 'is' : 'are'} in the table.
        </p>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && (
        <DataTable columns={tableColumns} rows={tableRows} getRowKey={(r) => `${r.vendor}::${r.family}::${r.department}`} />
      )}
    </div>
  )
}
