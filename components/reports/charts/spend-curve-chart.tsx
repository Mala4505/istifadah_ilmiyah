'use client'

import { useState } from 'react'
import { formatINRCompact, formatDate } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md A-11 — spend curve & peak weeks. Per-week
// (non-cumulative) spend bars across the event, the single peak week in a
// reserved highlight hue with a "Peak" label, and the weekly-mean as a
// dashed reference line. Distinct from the Explore "spend pace" chart, which
// is cumulative actual-vs-target.
//
// Built as inline SVG with real numeric attributes for every data-driven
// mark — exempt from this app's style-src CSP constraint, which only governs
// CSS width/position on HTML elements (see lib/reports/bar-scale.ts). One
// series hue (blue); the peak bar uses a separate reserved highlight hue
// (violet) that is NOT one of the green/amber/red status colours and never
// stands in for a data series elsewhere. Every value is reachable without
// hover: each bar carries a native <title>, and the "View as table" twin
// lists them all (dataviz skill's "tooltips enhance, never gate").

export type SpendCurvePoint = {
  weekStart: string
  amount: number
  isPeak: boolean
}

const VIEW_WIDTH = 720
const VIEW_HEIGHT = 240
const PAD = { left: 44, right: 56, top: 16, bottom: 28 }
const INNER_WIDTH = VIEW_WIDTH - PAD.left - PAD.right
const INNER_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom

// "Nice numbers" Y-axis ticking — same helper shape as trend-chart.tsx,
// duplicated locally (small, and this is a leaf client component).
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
  if (min === max) return [0, min || 1]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

export function SpendCurveChart({ points, meanAmount }: { points: SpendCurvePoint[]; meanAmount: number }) {
  const [showTable, setShowTable] = useState(false)

  if (points.length === 0) return null

  const n = points.length
  const maxValue = Math.max(meanAmount, ...points.map((p) => p.amount))
  const ticks = niceTicks(0, maxValue, 4)
  const domainMax = ticks[ticks.length - 1] || 1

  const yFor = (v: number) => PAD.top + (1 - v / domainMax) * INNER_HEIGHT
  const slot = INNER_WIDTH / n
  const barWidth = Math.max(2, Math.min(36, slot * 0.7))
  const xFor = (i: number) => PAD.left + i * slot + (slot - barWidth) / 2

  const baselineY = yFor(0)
  const meanY = yFor(meanAmount)
  const peakIndex = points.findIndex((p) => p.isPeak)

  // Selective x-axis labels: first, last, and the peak week only.
  const labelIndices = Array.from(new Set([0, n - 1, peakIndex].filter((i) => i >= 0)))

  const tableColumns: DataTableColumn<SpendCurvePoint>[] = [
    { key: 'week', header: 'Week of', render: (p) => formatDate(p.weekStart) },
    { key: 'amount', header: 'Spend', align: 'right', render: (p) => formatINRCompact(p.amount) },
    { key: 'peak', header: 'Peak week', render: (p) => (p.isPeak ? 'Peak' : '') },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          width="100%"
          height={VIEW_HEIGHT}
          className="overflow-visible"
          role="img"
          aria-label={`Weekly spend across the event, peaking at ${formatINRCompact(
            points[peakIndex]?.amount ?? 0
          )} in the week of ${formatDate(points[peakIndex]?.weekStart)}. See the table view below for exact values.`}
        >
          {/* Hairline solid gridlines + Y labels. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={VIEW_WIDTH - PAD.right}
                y1={yFor(t)}
                y2={yFor(t)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={yFor(t)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[9px]"
              >
                {formatINRCompact(t)}
              </text>
            </g>
          ))}

          {/* Bars: series hue for a normal week, reserved highlight hue for
              the peak. */}
          {points.map((p, i) => {
            const top = yFor(p.amount)
            const h = Math.max(0, baselineY - top)
            return (
              <rect
                key={p.weekStart}
                x={xFor(i)}
                y={top}
                width={barWidth}
                height={h}
                rx={1.5}
                className={
                  p.isPeak
                    ? 'fill-[#7c3aed] dark:fill-[#a78bfa]'
                    : 'fill-[#2a78d6]/70 dark:fill-[#3987e5]/70'
                }
              >
                <title>{`Week of ${formatDate(p.weekStart)}: ${formatINRCompact(p.amount)}${p.isPeak ? ' (peak)' : ''}`}</title>
              </rect>
            )
          })}

          {/* Weekly-mean reference line — dashed, muted (a legitimate
              pace/threshold dash, not the dashed-gridline anti-pattern). */}
          {meanAmount > 0 && (
            <>
              <line
                x1={PAD.left}
                x2={VIEW_WIDTH - PAD.right}
                y1={meanY}
                y2={meanY}
                className="stroke-muted-foreground"
                strokeWidth={1.5}
                strokeDasharray="5 3"
              />
              <text
                x={VIEW_WIDTH - PAD.right + 4}
                y={meanY}
                dominantBaseline="middle"
                className="fill-muted-foreground text-[9px]"
              >
                mean {formatINRCompact(meanAmount)}
              </text>
            </>
          )}

          {/* "Peak" annotation above the peak bar. */}
          {peakIndex >= 0 && (
            <text
              x={xFor(peakIndex) + barWidth / 2}
              y={yFor(points[peakIndex]!.amount) - 5}
              textAnchor="middle"
              className="fill-[#7c3aed] dark:fill-[#a78bfa] text-[9px] font-semibold"
            >
              Peak
            </text>
          )}

          {/* Baseline. */}
          <line
            x1={PAD.left}
            x2={VIEW_WIDTH - PAD.right}
            y1={baselineY}
            y2={baselineY}
            className="stroke-border"
            strokeWidth={1}
          />

          {/* Selective x-axis labels: first, last, peak. */}
          {labelIndices.map((i) => (
            <text
              key={i}
              x={xFor(i) + barWidth / 2}
              y={VIEW_HEIGHT - PAD.bottom + 14}
              textAnchor="middle"
              className="fill-muted-foreground text-[9px]"
            >
              {formatDate(points[i]!.weekStart)}
            </text>
          ))}
        </svg>
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={points} getRowKey={(p) => p.weekStart} />}
    </div>
  )
}
