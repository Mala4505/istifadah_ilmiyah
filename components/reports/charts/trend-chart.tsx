'use client'

import { useState, type PointerEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatNumber, formatINRCompact } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

export type TrendPoint = {
  label: string
  actual: number
  target: number | null
}

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 220
const PAD = { left: 36, right: 56, top: 16, bottom: 24 }
const INNER_WIDTH = VIEW_WIDTH - PAD.left - PAD.right
const INNER_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom

// Classic Sparks/Amdahl "nice numbers" ticking — Y-axis ticks round to clean
// numbers per the dataviz skill's label rule, rather than raw data min/max.
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

/**
 * Line + area trend chart with a target pace line, a crosshair+tooltip, and
 * a "View as table" twin (this chart's required accessibility fallback —
 * every value the tooltip shows is also in the table, per the dataviz
 * skill's "tooltips enhance, never gate" rule). Built as inline SVG with
 * real numeric attributes for every data-driven mark (line paths, dots,
 * crosshair position) — exempt from this app's style-src CSP constraint,
 * which only governs CSS width/position on HTML elements (see
 * lib/reports/bar-scale.ts). The one HTML element whose position IS
 * data-driven — the tooltip — gets there via `barLeftClass`, the same
 * lookup-table helper bar-list.tsx already uses, snapped to 5% steps
 * instead of an inline style.
 */
// `valueFormatter` used to be a function prop, but this component is a
// Client Component ('use client' above) rendered from the Server Component
// page.tsx -- a function reference can't cross that boundary (React errors
// "Functions cannot be passed directly to Client Components" at render
// time, digest 429141552, seen live on /reports). A format *name* is plain
// data and serializes fine; the actual function is resolved locally here,
// on the client, from this module's own imports.
const FORMATTERS = { number: formatNumber, 'inr-compact': formatINRCompact } as const

export function TrendChart({
  points,
  valueFormat = 'number',
}: {
  points: TrendPoint[]
  valueFormat?: keyof typeof FORMATTERS
}) {
  const valueFormatter = FORMATTERS[valueFormat]
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (points.length === 0) return null

  const n = points.length
  const hasAnyTarget = points.some((p) => p.target != null)

  const dataValues = points.flatMap((p) => (p.target != null ? [p.actual, p.target] : [p.actual]))
  const dataMin = Math.min(...dataValues)
  const dataMax = Math.max(...dataValues)
  const ticks = niceTicks(dataMin, dataMax, 4)
  const domainMin = ticks[0]! // niceTicks always returns at least one tick
  const domainMax = ticks[ticks.length - 1]!
  const domainRange = domainMax - domainMin || 1

  const xStep = n > 1 ? INNER_WIDTH / (n - 1) : 0
  const xFor = (i: number) => (n > 1 ? PAD.left + i * xStep : PAD.left + INNER_WIDTH / 2)
  const yFor = (v: number) => PAD.top + (1 - (v - domainMin) / domainRange) * INNER_HEIGHT

  const actualPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(2)},${yFor(p.actual).toFixed(2)}`).join(' ')
  const areaPath = `${actualPath} L${xFor(n - 1).toFixed(2)},${yFor(domainMin).toFixed(2)} L${xFor(0).toFixed(2)},${yFor(domainMin).toFixed(2)} Z`

  // Target line: break into separate M/L segments across any null gaps
  // instead of interpolating through them.
  const targetIndices = points.reduce<number[]>((acc, p, i) => {
    if (p.target != null) acc.push(i)
    return acc
  }, [])
  const targetPath = targetIndices
    .map((i, order) => {
      const point = points[i]!
      const isContiguous = order > 0 && targetIndices[order - 1] === i - 1
      return `${isContiguous ? 'L' : 'M'}${xFor(i).toFixed(2)},${yFor(point.target as number).toFixed(2)}`
    })
    .join(' ')
  const lastTargetIndex = targetIndices.length > 0 ? targetIndices[targetIndices.length - 1]! : null
  const lastTargetValue = lastTargetIndex != null ? (points[lastTargetIndex]!.target as number) : null

  const lastActual = points[n - 1]!.actual
  const lastActualPos = { x: xFor(n - 1), y: yFor(lastActual) }
  const lastTargetPos = lastTargetIndex != null ? { x: xFor(lastTargetIndex), y: yFor(lastTargetValue as number) } : null

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const idx = n > 1 ? Math.round(((relX - PAD.left) / INNER_WIDTH) * (n - 1)) : 0
    setHoverIndex(Math.max(0, Math.min(n - 1, idx)))
  }
  function handlePointerLeave() {
    setHoverIndex(null)
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverIndex((i) => Math.min(n - 1, (i ?? -1) + 1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverIndex((i) => Math.max(0, (i ?? n) - 1))
    } else if (e.key === 'Escape') {
      setHoverIndex(null)
    }
  }

  const tooltipPct = hoverIndex != null && n > 1 ? (hoverIndex / (n - 1)) * 100 : 50
  const hoverPoint = hoverIndex != null ? points[hoverIndex]! : null

  const tableColumns: DataTableColumn<TrendPoint>[] = [
    { key: 'label', header: 'Period', render: (p) => p.label },
    { key: 'actual', header: 'Actual', align: 'right', render: (p) => valueFormatter(p.actual) },
    { key: 'target', header: 'Target', align: 'right', render: (p) => (p.target != null ? valueFormatter(p.target) : '—') },
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
          aria-label="Trend chart — see the table view below for exact values"
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onKeyDown={handleKeyDown}
        >
          {/* Hairline solid gridlines — never dashed, per the dataviz skill. */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={VIEW_WIDTH - PAD.right} y1={yFor(t)} y2={yFor(t)} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={yFor(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[9px]">
                {valueFormatter(t)}
              </text>
            </g>
          ))}

          {/* Actual series: solid line + ~10%-opacity area wash, accent hue. */}
          <path d={areaPath} className="fill-[#2a78d6]/10 dark:fill-[#3987e5]/10" />
          <path d={actualPath} className="fill-none stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

          {/* Target series: dashed pace/threshold line, muted — a legitimate
              dash use (not the anti-pattern about dashed gridlines). Skipped
              entirely when no point has a target. */}
          {hasAnyTarget && (
            <path d={targetPath} className="fill-none stroke-muted-foreground" strokeWidth={2} strokeDasharray="5 3" strokeLinecap="round" />
          )}

          {/* Direct end-labels — text tokens, never the series hue (marks carry
              color, text never does). */}
          <circle cx={lastActualPos.x} cy={lastActualPos.y} r={3} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
          <text x={lastActualPos.x + 6} y={lastActualPos.y} dominantBaseline="middle" className="fill-foreground text-[10px] font-medium">
            {valueFormatter(lastActual)}
          </text>
          {hasAnyTarget && lastTargetPos && (
            <>
              <circle cx={lastTargetPos.x} cy={lastTargetPos.y} r={3} className="fill-muted-foreground" />
              <text
                x={lastTargetPos.x + 6}
                y={Math.abs(lastTargetPos.y - lastActualPos.y) < 10 ? lastTargetPos.y + 12 : lastTargetPos.y}
                dominantBaseline="middle"
                className="fill-muted-foreground text-[10px] font-medium"
              >
                {valueFormatter(lastTargetValue as number)}
              </text>
            </>
          )}

          {/* Selective x-axis labels: first, last, and whichever is hovered —
              never a label on every point. */}
          {Array.from(new Set([0, n - 1, hoverIndex].filter((i): i is number => i != null))).map((i) => (
            <text key={i} x={xFor(i)} y={VIEW_HEIGHT - PAD.bottom + 14} textAnchor="middle" className="fill-muted-foreground text-[9px]">
              {points[i]!.label}
            </text>
          ))}

          {/* Crosshair: finds the X, the tooltip below lists every series. */}
          {hoverIndex != null && (
            <g>
              <line x1={xFor(hoverIndex)} x2={xFor(hoverIndex)} y1={PAD.top} y2={VIEW_HEIGHT - PAD.bottom} className="stroke-foreground/30" strokeWidth={1} />
              {/* Surface ring (dataviz skill's marker spacer) keeps the dot legible
                  where it crosses the line — a stroke in the card surface color,
                  not a border, per that skill's "never draw a border" rule. */}
              <circle
                cx={xFor(hoverIndex)}
                cy={yFor(points[hoverIndex]!.actual)}
                r={4}
                strokeWidth={2}
                className="fill-[#2a78d6] stroke-card dark:fill-[#3987e5]"
              />
              {points[hoverIndex]!.target != null && (
                <circle
                  cx={xFor(hoverIndex)}
                  cy={yFor(points[hoverIndex]!.target as number)}
                  r={4}
                  strokeWidth={2}
                  className="fill-muted-foreground stroke-card"
                />
              )}
            </g>
          )}
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
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <svg width={12} height={4} aria-hidden="true">
                  <line x1={0} y1={2} x2={12} y2={2} className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} />
                </svg>
                Actual
              </span>
              <span className="font-mono font-semibold text-foreground">{valueFormatter(hoverPoint.actual)}</span>
            </div>
            {hoverPoint.target != null && (
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <svg width={12} height={4} aria-hidden="true">
                    <line x1={0} y1={2} x2={12} y2={2} className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="3 2" />
                  </svg>
                  Target
                </span>
                <span className="font-mono font-semibold text-foreground">{valueFormatter(hoverPoint.target)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {hasAnyTarget && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <svg width={14} height={4} aria-hidden="true">
              <line x1={0} y1={2} x2={14} y2={2} className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} />
            </svg>
            Actual
          </span>
          <span className="flex items-center gap-1.5">
            <svg width={14} height={4} aria-hidden="true">
              <line x1={0} y1={2} x2={14} y2={2} className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="3 2" />
            </svg>
            Target
          </span>
        </div>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={points} getRowKey={(p) => p.label} />}
    </div>
  )
}
