'use client'

import { useState, type PointerEvent, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINRCompact, formatPercent } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

export type AttentionMapPoint = {
  key: string | number
  label: string
  x: number // spend, rupees
  y: number // documentation coverage %, 0-100
  href?: string // optional drill-through link
}

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 320
const PAD = { left: 44, right: 24, top: 16, bottom: 32 }
const INNER_WIDTH = VIEW_WIDTH - PAD.left - PAD.right
const INNER_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom
const Y_TICKS = [0, 25, 50, 75, 100]
// Squared-pixel hit radius (in viewBox units) for pointer-move hover lookup —
// 20px in either axis, matched against squared distance to skip a sqrt.
const HOVER_RADIUS_SQ = 20 * 20

// Same "nice numbers" ticking as trend-chart.tsx, reused here for the X
// (spend) axis only — the Y axis is a fixed 0-100 percentage scale and
// doesn't need it.
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
  if (min === max) return [min - 1, min, min + 1]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Scatter/quadrant "attention map" — departments plotted by spend (X) against
 * documentation strength (Y). Per the reporting blueprint's E-02 framing, the
 * high-spend/weakly-documented quadrant (bottom-right) is the answer to
 * "where do we look first" and gets a quiet shaded backdrop rather than a
 * callout — the shading is a low-opacity tint only, never the sole signal:
 * the quadrant is equally readable from each point's raw position against
 * the two dashed threshold lines. Structurally mirrors trend-chart.tsx:
 * inline SVG with real numeric attributes for every data-driven mark
 * (exempt from this app's style-src CSP constraint — see
 * lib/reports/bar-scale.ts), a pointer-move hover lookup (nearest point
 * instead of a single shared index, since this is a 2D scatter rather than
 * an ordered series), and a required "View as table" twin so every value
 * the chart conveys — including quadrant membership — is also readable as
 * plain text.
 */
export function AttentionMapChart({
  points,
  xThreshold,
  yThreshold,
}: {
  points: AttentionMapPoint[]
  xThreshold?: number
  yThreshold?: number
}) {
  const [hoverKey, setHoverKey] = useState<string | number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (points.length === 0) return null

  const xValues = points.map((p) => p.x)
  const rawMaxX = Math.max(...xValues)
  const xTicks = niceTicks(0, rawMaxX, 4)
  const domainMinX = xTicks[0]! // niceTicks always returns at least one tick
  const domainMaxX = xTicks[xTicks.length - 1]!
  const domainRangeX = domainMaxX - domainMinX || 1

  const xFor = (x: number) => PAD.left + ((x - domainMinX) / domainRangeX) * INNER_WIDTH
  const yFor = (y: number) => PAD.top + (1 - y / 100) * INNER_HEIGHT

  const resolvedXThreshold = Math.min(domainMaxX, Math.max(domainMinX, xThreshold ?? median(xValues)))
  const resolvedYThreshold = Math.min(100, Math.max(0, yThreshold ?? median(points.map((p) => p.y))))

  // High-spend, weakly-documented quadrant: right of the X threshold, below
  // the Y threshold. Y pixels grow downward, so this is the bottom-right
  // rectangle of the plot area.
  const quadrantX = xFor(resolvedXThreshold)
  const quadrantY = yFor(resolvedYThreshold)
  const quadrantWidth = Math.max(0, VIEW_WIDTH - PAD.right - quadrantX)
  const quadrantHeight = Math.max(0, PAD.top + INNER_HEIGHT - quadrantY)

  // Sorted by X for left/right keyboard navigation between points.
  const sortedByX = [...points].sort((a, b) => a.x - b.x)

  function nearestPoint(relX: number, relY: number): AttentionMapPoint | null {
    let nearest: AttentionMapPoint | null = null
    let nearestDistSq = Infinity
    for (const p of points) {
      const dx = xFor(p.x) - relX
      const dy = yFor(p.y) - relY
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
  function handlePointerLeave() {
    setHoverKey(null)
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    const currentIndex = sortedByX.findIndex((p) => p.key === hoverKey)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverKey(sortedByX[Math.min(sortedByX.length - 1, currentIndex + 1)]!.key)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverKey(sortedByX[Math.max(0, currentIndex === -1 ? sortedByX.length - 1 : currentIndex - 1)]!.key)
    } else if (e.key === 'Escape') {
      setHoverKey(null)
    }
  }

  const hoverPoint = hoverKey != null ? (points.find((p) => p.key === hoverKey) ?? null) : null
  const tooltipPct = hoverPoint ? (xFor(hoverPoint.x) / VIEW_WIDTH) * 100 : 50

  const isInAttentionQuadrant = (p: AttentionMapPoint) => p.x > resolvedXThreshold && p.y < resolvedYThreshold

  const tableColumns: DataTableColumn<AttentionMapPoint>[] = [
    {
      key: 'label',
      header: 'Department',
      render: (p) =>
        p.href ? (
          <Link href={p.href} className="text-foreground underline-offset-2 hover:underline">
            {p.label}
          </Link>
        ) : (
          p.label
        ),
    },
    { key: 'x', header: 'Spend', align: 'right', render: (p) => formatINRCompact(p.x) },
    { key: 'y', header: 'Documentation', align: 'right', render: (p) => formatPercent(p.y) },
    { key: 'attention', header: 'Attention', render: (p) => (isInAttentionQuadrant(p) ? 'Needs attention' : '—') },
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
          aria-label="Attention map — departments by spend and documentation strength; see the table view below for exact values"
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onKeyDown={handleKeyDown}
        >
          {/* Quiet backdrop for the high-spend, weakly-documented quadrant —
              a low-opacity tint only. The quadrant stays readable from axis
              position alone via the two dashed threshold lines below; the
              tint never carries the signal on its own. */}
          <rect
            x={quadrantX}
            y={quadrantY}
            width={quadrantWidth}
            height={quadrantHeight}
            className="fill-red-500/5 dark:fill-red-500/10"
          />

          {/* Hairline solid gridlines at each axis tick — never dashed, per
              the dataviz skill (dashed strokes are reserved for the
              threshold reference lines below). */}
          {xTicks.map((t) => (
            <g key={`x-${t}`}>
              <line x1={xFor(t)} x2={xFor(t)} y1={PAD.top} y2={VIEW_HEIGHT - PAD.bottom} className="stroke-border" strokeWidth={1} />
              <text x={xFor(t)} y={VIEW_HEIGHT - PAD.bottom + 14} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {formatINRCompact(t)}
              </text>
            </g>
          ))}
          {Y_TICKS.map((t) => (
            <g key={`y-${t}`}>
              <line x1={PAD.left} x2={VIEW_WIDTH - PAD.right} y1={yFor(t)} y2={yFor(t)} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={yFor(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[9px]">
                {formatPercent(t)}
              </text>
            </g>
          ))}

          {/* Threshold reference lines — dashed, muted, the legitimate dash
              use (trend-chart.tsx's target-pace line is the same pattern). */}
          <line
            x1={quadrantX}
            x2={quadrantX}
            y1={PAD.top}
            y2={VIEW_HEIGHT - PAD.bottom}
            className="stroke-muted-foreground"
            strokeWidth={1}
            strokeDasharray="5 3"
          />
          <line
            x1={PAD.left}
            x2={VIEW_WIDTH - PAD.right}
            y1={quadrantY}
            y2={quadrantY}
            className="stroke-muted-foreground"
            strokeWidth={1}
            strokeDasharray="5 3"
          />

          {/* Points — one accent hue for the whole series (never recolored
              by quadrant; the band above already carries that signal).
              Each gets an invisible larger hit-area circle so hover/click
              targets aren't limited to the 4px visible dot, and an SVG
              native <title> as a no-JS tooltip fallback. */}
          {points.map((p) => {
            const cx = xFor(p.x)
            const cy = yFor(p.y)
            const isHovered = hoverKey === p.key
            const dotLabel = `${p.label}: ${formatINRCompact(p.x)} spend, ${formatPercent(p.y)} documented`
            const dot = (
              <>
                <title>{dotLabel}</title>
                <circle cx={cx} cy={cy} r={14} fill="transparent" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={isHovered ? 5 : 4}
                  strokeWidth={isHovered ? 2 : 0}
                  className={cn('fill-[#2a78d6] dark:fill-[#3987e5]', isHovered && 'stroke-card')}
                />
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
              'pointer-events-none absolute top-2 z-10 min-w-[9rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">{hoverPoint.label}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Spend</span>
              <span className="font-mono font-semibold text-foreground">{formatINRCompact(hoverPoint.x)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Documented</span>
              <span className="font-mono font-semibold text-foreground">{formatPercent(hoverPoint.y)}</span>
            </div>
          </div>
        )}
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={points} getRowKey={(p) => p.key} />}
    </div>
  )
}
