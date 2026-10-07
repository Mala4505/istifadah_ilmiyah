'use client'

import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, XAxis, YAxis } from 'recharts'
import { formatINRCompact, formatDate } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { TooltipValueRow } from '@/components/reports/charts/tooltip-value-row'

// reporting-blueprint.md A-11 — spend curve & peak weeks. Per-week
// (non-cumulative) spend bars across the event, the single peak week in a
// reserved highlight hue with a "Peak" label, and the weekly mean as a dashed
// reference line. Distinct from the Explore "spend pace" chart, which is
// cumulative actual-vs-target.
//
// One series hue (blue); the peak bar uses a separate reserved highlight hue
// (violet) that is NOT one of the green/amber/red status colours and never
// stands in for a data series elsewhere. Every value is reachable without
// hover via the "View as table" twin (dataviz skill: tooltips enhance, never
// gate). Recharts (shadcn chart) since the 2026-10-07 direction change.

export type SpendCurvePoint = {
  weekStart: string
  amount: number
  isPeak: boolean
}

const chartConfig = {
  amount: { label: 'Spend', theme: { light: '#2a78d6', dark: '#3987e5' } },
  peak: { label: 'Peak week', theme: { light: '#7c3aed', dark: '#a78bfa' } },
  mean: { label: 'Weekly mean', theme: { light: '#898781', dark: '#898781' } },
} satisfies ChartConfig

function shortWeek(weekStart: string): string {
  const d = new Date(weekStart)
  if (Number.isNaN(d.getTime())) return weekStart
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

export function SpendCurveChart({ points, meanAmount }: { points: SpendCurvePoint[]; meanAmount: number }) {
  const [showTable, setShowTable] = useState(false)
  const anim = useChartAnimation()

  if (points.length === 0) return null

  const peakIndex = points.findIndex((p) => p.isPeak)

  const tableColumns: DataTableColumn<SpendCurvePoint>[] = [
    { key: 'week', header: 'Week of', render: (p) => formatDate(p.weekStart) },
    { key: 'amount', header: 'Spend', align: 'right', render: (p) => formatINRCompact(p.amount) },
    { key: 'peak', header: 'Peak week', render: (p) => (p.isPeak ? 'Peak' : '') },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`Weekly spend across the event, peaking at ${formatINRCompact(
          points[peakIndex]?.amount ?? 0
        )} in the week of ${formatDate(points[peakIndex]?.weekStart)}; weekly mean ${formatINRCompact(meanAmount)}. See the table view below for exact values.`}
      >
        <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
          <BarChart data={points} margin={{ top: 20, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="weekStart"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval="preserveStartEnd"
              minTickGap={28}
              fontSize={11}
              tickFormatter={shortWeek}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={68}
              tickCount={5}
              fontSize={11}
              tickFormatter={(v: number) => formatINRCompact(v)}
            />
            <ChartTooltip
              cursor={{ fillOpacity: 0.5 }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const p = payload?.[0]?.payload as SpendCurvePoint | undefined
                    return p ? `Week of ${formatDate(p.weekStart)}${p.isPeak ? ' · peak' : ''}` : null
                  }}
                  formatter={(value, _name, item) => (
                    <TooltipValueRow
                      color={item.payload?.isPeak ? 'var(--color-peak)' : 'var(--color-amount)'}
                      label="Spend"
                      value={formatINRCompact(value as number)}
                    />
                  )}
                />
              }
            />
            <Bar dataKey="amount" radius={[4, 4, 0, 0]} maxBarSize={24} {...anim}>
              {points.map((p) => (
                <Cell
                  key={p.weekStart}
                  fill={p.isPeak ? 'var(--color-peak)' : 'var(--color-amount)'}
                  fillOpacity={p.isPeak ? 1 : 0.75}
                />
              ))}
              <LabelList
                dataKey="amount"
                content={(props) =>
                  props.index === peakIndex ? (
                    <text
                      x={Number(props.x) + Number(props.width) / 2}
                      y={Number(props.y) - 6}
                      textAnchor="middle"
                      fontSize={11}
                      className="fill-foreground font-semibold"
                    >
                      Peak
                    </text>
                  ) : null
                }
              />
            </Bar>
            {meanAmount > 0 && (
              <ReferenceLine
                y={meanAmount}
                ifOverflow="extendDomain"
                stroke="var(--color-mean)"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                label={{
                  value: `mean ${formatINRCompact(meanAmount)}`,
                  position: 'insideTopRight',
                  fontSize: 11,
                  className: 'fill-muted-foreground',
                }}
              />
            )}
          </BarChart>
        </ChartContainer>
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
