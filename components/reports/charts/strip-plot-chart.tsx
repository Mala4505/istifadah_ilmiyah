'use client'

import { useState, type PointerEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md C-04 (flagship) §4: "Strip plot — one dot per purchase
// on a rate axis, one row per item family, our own median as a vertical rule,
// the above-median region shaded." Every purchase's rate is normalised to
// net_rate / median_rate, so every family shares one axis and our median is a
// single vertical rule at 1.0×; the region right of 1.0× carries a rupee cost
// and gets a low-opacity red wash — a tint only, never the sole signal: the
// rule and each dot's raw position carry it. One accent hue for every dot,
// never recoloured by over/under (dataviz skill).
//
// Structurally mirrors attention-map-chart.tsx: inline SVG with real numeric
// attributes for every data-driven mark (exempt from this app's style-src CSP
// constraint — see lib/reports/bar-scale.ts), a pointer-move nearest-dot hover
// lookup, keyboard nav across dots, role="img" + aria-label, and a required
// "View as table" twin so every value the chart conveys is also plain text
// (dataviz skill: tooltips enhance, never gate).

export type StripPlotDot = {
  key: number
  familyKey: string
  family: string
  unit: string | null
  vendorId: number | null
  vendorName: string
  netRate: number
  medianRate: number
  ratio: number
  quantity: number
  overpayment: number
  entryId: number | null
}

const VIEW_WIDTH = 600
const ROW_HEIGHT = 34
const MAX_ROWS = 12
const DOT_JITTER = 8 // max ± vertical px from a row's centre line
const PAD = { left: 148, right: 20, top: 22, bottom: 40 }
const RATIO_CAP = 3 // clamp the x domain; dots beyond are drawn at the edge and counted
const HOVER_RADIUS_SQ = 22 * 22

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
  if (min === max) return [min]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

// Deterministic in-row vertical jitter so dots at the same ratio stay
// individually hoverable — hashed off the dot key, stable between renders.
function jitterFor(key: number): number {
  const h = Math.abs(Math.sin(key * 12.9898) * 43758.5453)
  return ((h % 1) * 2 - 1) * DOT_JITTER
}

export function StripPlotChart({ dots, excludedCount = 0 }: { dots: StripPlotDot[]; excludedCount?: number }) {
  const [hoverKey, setHoverKey] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (dots.length === 0) return null

  // One row per family + unit, ordered by the family's total above-median spend
  // so the costliest families sit at the top.
  const rowMap = new Map<string, { label: string; unit: string | null; dots: StripPlotDot[]; overpay: number }>()
  for (const d of dots) {
    const k = `${d.familyKey}::${d.unit ?? ''}`
    const row = rowMap.get(k) ?? { label: d.family, unit: d.unit, dots: [], overpay: 0 }
    row.dots.push(d)
    row.overpay += d.overpayment
    rowMap.set(k, row)
  }
  const allRows = [...rowMap.entries()]
    .map(([k, v]) => ({ k, ...v }))
    .sort((a, b) => b.overpay - a.overpay || b.dots.length - a.dots.length)
  const rows = allRows.slice(0, MAX_ROWS)
  const hiddenFamilyCount = allRows.length - rows.length

  const maxRatio = Math.max(...dots.map((d) => d.ratio))
  const xTicks = niceTicks(0, Math.min(RATIO_CAP, Math.max(1.5, maxRatio)), 4).filter((t) => t >= 0)
  const domainMax = Math.max(1.5, xTicks[xTicks.length - 1] ?? RATIO_CAP)

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right
  const plotHeight = rows.length * ROW_HEIGHT
  const viewHeight = PAD.top + plotHeight + PAD.bottom

  const xFor = (ratio: number) => PAD.left + (Math.min(ratio, domainMax) / domainMax) * innerWidth
  const rowCentre = (rowIndex: number) => PAD.top + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2

  const clippedCount = dots.filter((d) => d.ratio > domainMax).length

  // Placed dots (only for the shown rows) for hover + keyboard, plus a
  // ratio-ordered copy for left/right navigation.
  const placed = rows.flatMap((row, rowIndex) =>
    row.dots.map((d) => ({ dot: d, cx: xFor(d.ratio), cy: rowCentre(rowIndex) + jitterFor(d.key) }))
  )
  const placedByRatio = [...placed].sort((a, b) => a.dot.ratio - b.dot.ratio)

  function nearestKey(relX: number, relY: number): number | null {
    let bestKey: number | null = null
    let bestSq = Infinity
    for (const p of placed) {
      const dx = p.cx - relX
      const dy = p.cy - relY
      const sq = dx * dx + dy * dy
      if (sq < bestSq) {
        bestSq = sq
        bestKey = p.dot.key
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
    if (placedByRatio.length === 0) return
    const idx = placedByRatio.findIndex((p) => p.dot.key === hoverKey)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverKey(placedByRatio[Math.min(placedByRatio.length - 1, idx + 1)]!.dot.key)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverKey(placedByRatio[Math.max(0, idx === -1 ? placedByRatio.length - 1 : idx - 1)]!.dot.key)
    } else if (e.key === 'Escape') {
      setHoverKey(null)
    }
  }

  const hoverPlaced = hoverKey != null ? (placed.find((p) => p.dot.key === hoverKey) ?? null) : null
  const hoverDot = hoverPlaced?.dot ?? null
  const tooltipPct = hoverPlaced ? (hoverPlaced.cx / VIEW_WIDTH) * 100 : 50

  const medianX = xFor(1)
  const shadeWidth = Math.max(0, xFor(domainMax) - medianX)

  const tableColumns: DataTableColumn<StripPlotDot>[] = [
    { key: 'family', header: 'Item family', render: (d) => d.family },
    { key: 'unit', header: 'Unit', render: (d) => d.unit ?? '—' },
    { key: 'vendor', header: 'Vendor', render: (d) => d.vendorName },
    { key: 'rate', header: 'Net rate', align: 'right', render: (d) => formatINR(d.netRate) },
    { key: 'median', header: 'Our median', align: 'right', render: (d) => formatINR(d.medianRate) },
    { key: 'ratio', header: 'vs median', align: 'right', render: (d) => `${d.ratio.toFixed(2)}×` },
    { key: 'qty', header: 'Qty', align: 'right', render: (d) => formatNumber(d.quantity) },
    {
      key: 'over',
      header: 'Above-median ₹',
      align: 'right',
      render: (d) => (d.overpayment > 0 ? formatINR(d.overpayment) : '—'),
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${viewHeight}`}
          width="100%"
          height={viewHeight}
          className="overflow-visible"
          role="img"
          aria-label="Above-median overpayment strip plot — one dot per purchase, positioned by its rate as a multiple of our own median for the same item and unit; dots right of the 1.0× rule are priced above our median. See the table view below for exact values."
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverKey(null)}
          onKeyDown={handleKeyDown}
        >
          {/* Above-median wash — a low-opacity tint only; the vertical rule and
              each dot's raw position carry the signal on their own. */}
          <rect x={medianX} y={PAD.top} width={shadeWidth} height={plotHeight} className="fill-red-500/5 dark:fill-red-500/10" />

          {/* Ratio gridlines + labels. */}
          {xTicks.map((t) => (
            <g key={`x-${t}`}>
              <line x1={xFor(t)} x2={xFor(t)} y1={PAD.top} y2={PAD.top + plotHeight} className="stroke-border" strokeWidth={1} />
              <text x={xFor(t)} y={PAD.top + plotHeight + 16} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {t % 1 === 0 ? t.toFixed(0) : t.toFixed(1)}×
              </text>
            </g>
          ))}
          <text x={PAD.left + innerWidth / 2} y={viewHeight - 8} textAnchor="middle" className="fill-muted-foreground text-[9px]">
            Rate vs our own median for the same item and unit (1.0× = median)
          </text>

          {/* Our-median rule. */}
          <line x1={medianX} x2={medianX} y1={PAD.top - 8} y2={PAD.top + plotHeight} className="stroke-foreground/60" strokeWidth={1.5} />
          <text x={medianX} y={PAD.top - 12} textAnchor="middle" className="fill-foreground text-[9px] font-medium">
            our median
          </text>

          {/* Row labels + separators. */}
          {rows.map((row, i) => (
            <g key={row.k}>
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
                <tspan>{row.label.length > 22 ? `${row.label.slice(0, 21)}…` : row.label}</tspan>
                {row.unit ? <tspan className="fill-muted-foreground"> · {row.unit}</tspan> : null}
              </text>
            </g>
          ))}

          {/* Dots — one accent hue for every purchase, never recoloured by
              over/under (the shaded band + rule already carry that). Each gets
              an invisible larger hit-area circle and a native <title>. */}
          {placed.map((p) => {
            const isHovered = hoverKey === p.dot.key
            return (
              <g key={p.dot.key}>
                <title>{`${p.dot.vendorName} — ${formatINR(p.dot.netRate)} vs ${formatINR(p.dot.medianRate)} median (${p.dot.ratio.toFixed(2)}×)`}</title>
                <circle cx={p.cx} cy={p.cy} r={10} fill="transparent" />
                <circle
                  cx={p.cx}
                  cy={p.cy}
                  r={isHovered ? 5 : 3.5}
                  strokeWidth={isHovered ? 2 : 0}
                  className={cn('fill-[#2a78d6] dark:fill-[#3987e5]', isHovered && 'stroke-card')}
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
            <p className="font-medium text-foreground">{hoverDot.vendorName}</p>
            <p className="mb-1 text-[11px] text-muted-foreground">
              {hoverDot.family}
              {hoverDot.unit ? ` · ${hoverDot.unit}` : ''}
            </p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Rate</span>
              <span className="font-mono font-semibold text-foreground">{formatINR(hoverDot.netRate)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Our median</span>
              <span className="font-mono font-semibold text-foreground">{formatINR(hoverDot.medianRate)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Above median</span>
              <span className="font-mono font-semibold text-foreground">
                {hoverDot.overpayment > 0 ? formatINR(hoverDot.overpayment) : '—'}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={10} height={10} aria-hidden="true">
            <circle cx={5} cy={5} r={3.5} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
          </svg>
          One purchase
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={12} height={10} aria-hidden="true">
            <line x1={6} y1={0} x2={6} y2={10} className="stroke-foreground/60" strokeWidth={1.5} />
          </svg>
          Our median (1.0×)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-red-500/10 dark:bg-red-500/20" />
          Above median — costed
        </span>
      </div>

      {(clippedCount > 0 || excludedCount > 0 || hiddenFamilyCount > 0) && (
        <p className="text-xs text-muted-foreground">
          {hiddenFamilyCount > 0 &&
            `Showing the ${formatNumber(rows.length)} item families with the most above-median spend; ${formatNumber(hiddenFamilyCount)} more ${hiddenFamilyCount === 1 ? 'is' : 'are'} in the table. `}
          {clippedCount > 0 &&
            `${formatNumber(clippedCount)} purchase${clippedCount === 1 ? '' : 's'} priced above ${domainMax.toFixed(0)}× the median ${clippedCount === 1 ? 'is' : 'are'} drawn at the axis edge. `}
          {excludedCount > 0 &&
            `${formatNumber(excludedCount)} comparable purchase${excludedCount === 1 ? '' : 's'} had no usable median and ${excludedCount === 1 ? 'is' : 'are'} not plotted.`}
        </p>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && (
        <DataTable
          columns={tableColumns}
          rows={[...dots].sort((a, b) => b.overpayment - a.overpayment)}
          getRowKey={(d) => d.key}
        />
      )}
    </div>
  )
}
