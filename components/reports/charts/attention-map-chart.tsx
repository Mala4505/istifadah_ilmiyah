'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CartesianGrid, ReferenceArea, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis } from 'recharts'
import type { ScatterShapeProps } from 'recharts'
import { formatINR, formatINRCompact, formatPercent } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  useChartAnimation,
  type ChartConfig,
} from '@/components/ui/chart'

export type AttentionMapPoint = {
  key: string | number
  label: string
  x: number // spend, rupees
  y: number // documentation coverage %, 0-100
  href?: string // optional drill-through link
}

const Y_TICKS = [0, 25, 50, 75, 100]
const AXIS_TICK = { fontSize: 11 }

// One accent hue for every point (the screen's blue, light/dark steps from
// the dataviz reference palette) and a red tint for the attention quadrant.
const chartConfig = {
  department: { label: 'Department', theme: { light: '#2a78d6', dark: '#3987e5' } },
  attention: { label: 'Needs attention', theme: { light: '#ef4444', dark: '#ef4444' } },
} satisfies ChartConfig

// Same "nice numbers" ticking as trend-chart.tsx, reused here for the X
// (spend) axis only — the Y axis is a fixed 0-100 percentage scale.
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
  // Spend axis: never a negative-rupee tick when every point sits at ₹0.
  if (min === max) return [...new Set([Math.max(0, min - 1), min, min + 1])]
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

/** Custom Recharts point: a 4px dot plus an invisible 14px hit area, wrapped
 *  in a next/link when the department has a drill-through, so each linked
 *  point is Tab-reachable and opens with Enter. */
function renderPoint(props: ScatterShapeProps, active: boolean): ReactNode {
  const { cx, cy } = props
  const p = props.payload as AttentionMapPoint | undefined
  if (cx == null || cy == null || !p) return null
  const dotLabel = `${p.label}: ${formatINRCompact(p.x)} spend, ${formatPercent(p.y)} documented`
  const dot = (
    <>
      <title>{dotLabel}</title>
      <circle cx={cx} cy={cy} r={14} fill="transparent" />
      <circle
        cx={cx}
        cy={cy}
        r={active ? 5.5 : 4}
        fill="var(--color-department)"
        stroke="hsl(var(--card))"
        strokeWidth={active ? 2 : 0}
      />
    </>
  )
  return p.href ? (
    <Link
      href={p.href}
      aria-label={dotLabel}
      className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {dot}
    </Link>
  ) : (
    <g>{dot}</g>
  )
}

/**
 * Scatter/quadrant "attention map" — departments plotted by spend (X) against
 * documentation strength (Y). Per the reporting blueprint's E-02 framing, the
 * high-spend/weakly-documented quadrant (bottom-right) is the answer to
 * "where do we look first" and gets a quiet ReferenceArea tint rather than a
 * callout — the tint is low-opacity only, never the sole signal: the quadrant
 * is equally readable from each point's raw position against the two dashed
 * threshold ReferenceLines.
 *
 * Recharts 3 ScatterChart inside the shadcn ChartContainer (CSP style-src is
 * 'unsafe-inline', so Recharts' inline styles are fine), the shared
 * useChartAnimation() mount animation, a ChartTooltipContent hover tooltip
 * with ₹ in Indian grouping, linked points that are keyboard-focusable, and a
 * required "View as table" twin so every value the chart conveys — including
 * quadrant membership — is also readable as plain text.
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
  const [showTable, setShowTable] = useState(false)
  const animation = useChartAnimation()

  if (points.length === 0) return null

  const xValues = points.map((p) => p.x)
  const xTicks = niceTicks(0, Math.max(...xValues), 4)
  const domainMinX = xTicks[0]! // niceTicks always returns at least one tick
  const domainMaxX = xTicks[xTicks.length - 1]!

  const resolvedXThreshold = Math.min(domainMaxX, Math.max(domainMinX, xThreshold ?? median(xValues)))
  const resolvedYThreshold = Math.min(100, Math.max(0, yThreshold ?? median(points.map((p) => p.y))))

  const isInAttentionQuadrant = (p: AttentionMapPoint) => p.x > resolvedXThreshold && p.y < resolvedYThreshold
  const attentionCount = points.filter(isInAttentionQuadrant).length

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
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-[320px] w-full"
        role="img"
        aria-label={`Attention map — ${points.length} departments by spend and documentation strength; ${attentionCount} sit in the high-spend, weakly documented quadrant (right of ${formatINRCompact(
          resolvedXThreshold
        )} spend, below ${formatPercent(resolvedYThreshold)} documented). See the table view below for exact values.`}
      >
        <ScatterChart margin={{ top: 12, right: 24, bottom: 4, left: 4 }}>
          {/* Quiet tint for the high-spend, weakly-documented quadrant. */}
          <ReferenceArea
            x1={resolvedXThreshold}
            x2={domainMaxX}
            y1={0}
            y2={resolvedYThreshold}
            fill="var(--color-attention)"
            fillOpacity={0.07}
            stroke="none"
            ifOverflow="hidden"
          />
          {/* Hairline solid gridlines; dashes are reserved for the thresholds. */}
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="" />
          <XAxis
            type="number"
            dataKey="x"
            name="Spend"
            domain={[domainMinX, domainMaxX]}
            ticks={xTicks}
            tickFormatter={(v: number) => formatINRCompact(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Documented"
            domain={[0, 100]}
            ticks={Y_TICKS}
            tickFormatter={(v: number) => formatPercent(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <ReferenceLine x={resolvedXThreshold} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 3" ifOverflow="hidden" />
          <ReferenceLine y={resolvedYThreshold} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 3" ifOverflow="hidden" />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                className="min-w-[10rem]"
                labelFormatter={(_, payload) => (payload[0]?.payload as AttentionMapPoint | undefined)?.label ?? ''}
                formatter={(value, name, _item, index) => (
                  <>
                    {index === 0 ? (
                      <div className="h-2.5 w-2.5 shrink-0 rounded-[2px] bg-[--color-department]" />
                    ) : (
                      <div className="h-2.5 w-2.5 shrink-0" />
                    )}
                    <div className="flex flex-1 items-center justify-between gap-3 leading-none">
                      <span className="text-muted-foreground">{name}</span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {name === 'Spend' ? formatINR(Number(value)) : formatPercent(Number(value))}
                      </span>
                    </div>
                  </>
                )}
              />
            }
          />
          <Scatter
            name="Department"
            data={points}
            fill="var(--color-department)"
            shape={(props: ScatterShapeProps) => renderPoint(props, false)}
            activeShape={(props: ScatterShapeProps) => renderPoint(props, true)}
            {...animation}
          />
        </ScatterChart>
      </ChartContainer>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#2a78d6] dark:bg-[#3987e5]" aria-hidden="true" />
          One department
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={16} height={4} aria-hidden="true">
            <line x1={0} y1={2} x2={16} y2={2} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="5 3" />
          </svg>
          Thresholds
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-red-500/10 dark:bg-red-500/20" aria-hidden="true" />
          High spend, weak documentation
        </span>
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
