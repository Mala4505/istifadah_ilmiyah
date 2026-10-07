'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CartesianGrid, Scatter, ScatterChart, XAxis, YAxis } from 'recharts'
import type { ScatterShapeProps, XAxisTickContentProps } from 'recharts'
import { formatINR, formatINRCompact } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { AttentionPill } from '@/components/reports/severity-badge'
import { Button } from '@/components/ui/button'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  useChartAnimation,
  type ChartConfig,
} from '@/components/ui/chart'

// reporting-blueprint.md B-05: "Vendors first seen mid-event, ranked by the
// size of their opening invoice. A new vendor whose first bill is also
// their largest deserves a look." Scatter: x = first entry date (within the
// event), y = first entry amount. Every plotted vendor is already "new
// mid-event" (the view's is_new_mid_event flag — filtered by the caller
// before this chart ever sees a row); points where that opening bill is
// ALSO the vendor's largest to date (the finding) get the reserved
// warning-status colour, a diamond mark and a legend label; muted grey
// circles for the rest, never the plain series hue reused as a status
// signal (§6 fix #5).
//
// Recharts 3 ScatterChart inside the shadcn ChartContainer (CSP style-src is
// 'unsafe-inline', so Recharts' inline styles are fine): two Scatter series
// (finding / other) with colours from the ChartConfig, the shared
// useChartAnimation() mount animation, a ChartTooltipContent hover tooltip
// with ₹ in Indian grouping, linked points that are Tab-reachable, an SVG
// <title> per point as a no-JS fallback, and a required "View as table" twin
// so every value the chart conveys is also plain text.

export type NewVendorFirstBillPoint = {
  key: number
  label: string
  href?: string
  firstEntryDateMs: number
  firstEntryDateLabel: string
  firstEntryAmount: number
  isFinding: boolean
}

const AXIS_TICK = { fontSize: 11 }
const MS_PER_DAY = 24 * 60 * 60 * 1000

// Reserved warning amber (Tailwind amber-500 / amber-400, the same steps the
// old SVG used) for the finding; the theme's muted ink at half strength for
// everything else.
const chartConfig = {
  finding: { label: 'Opening bill is also the largest', theme: { light: '#f59e0b', dark: '#fbbf24' } },
  other: { label: 'Other vendors new this event', color: 'hsl(var(--muted-foreground) / 0.5)' },
} satisfies ChartConfig

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
  // Set: with min === max === 0 the candidates repeat 0, and duplicate tick
  // values give Recharts duplicate React keys.
  if (min === max) return [...new Set([0, min - 1, min, min + 1].filter((v) => v >= 0))]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = 0
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

function pointLabel(p: NewVendorFirstBillPoint): string {
  return `${p.label}: first bill ${formatINRCompact(p.firstEntryAmount)} on ${p.firstEntryDateLabel}${
    p.isFinding ? ' — this is also their largest bill' : ''
  }`
}

/** Custom point: amber diamond for the finding (survives greyscale and a
 *  colour-blind read, not just amber-vs-grey), grey circle otherwise, each
 *  with an invisible 14px hit area; wrapped in a next/link when the vendor
 *  has a drill-through so it is Tab-reachable and opens with Enter. */
function renderPoint(props: ScatterShapeProps, active: boolean): ReactNode {
  const { cx, cy } = props
  const p = props.payload as NewVendorFirstBillPoint | undefined
  if (cx == null || cy == null || !p) return null
  const half = active ? 6 : 5
  const dot = (
    <>
      <title>{pointLabel(p)}</title>
      <circle cx={cx} cy={cy} r={14} fill="transparent" />
      {p.isFinding ? (
        <rect
          x={cx - half}
          y={cy - half}
          width={half * 2}
          height={half * 2}
          transform={`rotate(45 ${cx} ${cy})`}
          fill="var(--color-finding)"
          stroke="hsl(var(--card))"
          strokeWidth={active ? 2 : 1.5}
        />
      ) : (
        <circle
          cx={cx}
          cy={cy}
          r={active ? 6 : 3.5}
          fill="var(--color-other)"
          stroke="hsl(var(--card))"
          strokeWidth={active ? 2 : 0}
        />
      )}
    </>
  )
  return p.href ? (
    <Link
      href={p.href}
      aria-label={pointLabel(p)}
      className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {dot}
    </Link>
  ) : (
    <g>{dot}</g>
  )
}

export function NewVendorFirstBillChart({ points }: { points: NewVendorFirstBillPoint[] }) {
  const [showTable, setShowTable] = useState(false)
  const animation = useChartAnimation()

  if (points.length === 0) return null

  const dateValues = points.map((p) => p.firstEntryDateMs)
  const rawMinX = Math.min(...dateValues)
  const rawMaxX = Math.max(...dateValues)
  // A single shared date would collapse the axis; widen it by a day each side.
  const domainMinX = rawMinX === rawMaxX ? rawMinX - MS_PER_DAY : rawMinX
  const domainMaxX = rawMinX === rawMaxX ? rawMaxX + MS_PER_DAY : rawMaxX
  const singleDate = rawMinX === rawMaxX

  const yTicks = niceTicks(0, Math.max(...points.map((p) => p.firstEntryAmount)), 4)
  const domainMaxY = yTicks[yTicks.length - 1] || 1

  const sortedByDate = [...points].sort((a, b) => a.firstEntryDateMs - b.firstEntryDateMs)
  const firstPoint = sortedByDate[0]!
  const lastPoint = sortedByDate[sortedByDate.length - 1]!
  const findings = points.filter((p) => p.isFinding)
  const others = points.filter((p) => !p.isFinding)

  // First and last observed dates as x labels — never one per point —
  // anchored inward so neither runs off the plot edge.
  const renderDateTick = (props: XAxisTickContentProps): ReactNode => {
    const value = Number(props.payload.value)
    const isFirst = value === rawMinX
    const label = isFirst ? firstPoint.firstEntryDateLabel : lastPoint.firstEntryDateLabel
    return (
      <text
        x={props.x}
        y={Number(props.y) + 12}
        textAnchor={singleDate ? 'middle' : isFirst ? 'start' : 'end'}
        fontSize={11}
        className="fill-muted-foreground"
      >
        {label}
      </text>
    )
  }

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
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-[300px] w-full"
        role="img"
        aria-label={`New vendors first seen mid-event — one point per vendor, positioned by the date and size of their first bill. ${findings.length} of ${points.length} have an opening bill that is also their largest to date. See the table view below for exact values.`}
      >
        <ScatterChart margin={{ top: 12, right: 20, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis
            type="number"
            dataKey="firstEntryDateMs"
            name="Date"
            scale="time"
            domain={[domainMinX, domainMaxX]}
            ticks={singleDate ? [rawMinX] : [rawMinX, rawMaxX]}
            interval={0}
            tick={renderDateTick}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="number"
            dataKey="firstEntryAmount"
            name="First bill"
            domain={[0, domainMaxY]}
            ticks={yTicks}
            allowDataOverflow
            tickFormatter={(v: number) => formatINRCompact(v)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={68}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                className="min-w-[11rem]"
                labelFormatter={(_, payload) => {
                  const p = payload[0]?.payload as NewVendorFirstBillPoint | undefined
                  if (!p) return ''
                  return (
                    <div className="grid gap-0.5">
                      <span>{p.label}</span>
                      {p.isFinding && (
                        <span className="font-normal text-amber-700 dark:text-amber-300">⚠ Opening bill is also their largest</span>
                      )}
                    </div>
                  )
                }}
                formatter={(value, name, item, index) => {
                  const p = item.payload as NewVendorFirstBillPoint | undefined
                  return (
                    <>
                      {index === 0 ? (
                        <div
                          className={
                            p?.isFinding
                              ? 'h-2.5 w-2.5 shrink-0 rounded-[2px] bg-[--color-finding]'
                              : 'h-2.5 w-2.5 shrink-0 rounded-[2px] bg-[--color-other]'
                          }
                        />
                      ) : (
                        <div className="h-2.5 w-2.5 shrink-0" />
                      )}
                      <div className="flex flex-1 items-center justify-between gap-3 leading-none">
                        <span className="text-muted-foreground">{name}</span>
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {name === 'Date' ? (p?.firstEntryDateLabel ?? '') : formatINR(Number(value))}
                        </span>
                      </div>
                    </>
                  )
                }}
              />
            }
          />
          <Scatter
            name="Other vendors new this event"
            data={others}
            fill="var(--color-other)"
            shape={(props: ScatterShapeProps) => renderPoint(props, false)}
            activeShape={(props: ScatterShapeProps) => renderPoint(props, true)}
            {...animation}
          />
          <Scatter
            name="Opening bill is also the largest"
            data={findings}
            fill="var(--color-finding)"
            shape={(props: ScatterShapeProps) => renderPoint(props, false)}
            activeShape={(props: ScatterShapeProps) => renderPoint(props, true)}
            {...animation}
          />
        </ScatterChart>
      </ChartContainer>

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
