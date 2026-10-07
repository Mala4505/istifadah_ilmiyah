'use client'

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, XAxis, YAxis } from 'recharts'
import { formatNumber } from '@/lib/reports/format'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { AXIS_TICK, GRID_STROKE, SERIES_BLUE, STATUS_CRITICAL, STATUS_WARN, TooltipRow, WrappingTick } from './recharts-kit'

// reporting-blueprint.md D-09 -- "Histogram of invoice amounts. A spike just
// below an approval limit is deliberate splitting." A plain bucketed column
// chart of non-void entry amounts. Columns in the "just below a recorded
// limit" region take a reserved warn colour (amber) -- always with the legend
// and the count on the column face, never colour alone (§6 fix #5). Recorded
// approval limits are labelled vertical ReferenceLines on the boundary after
// their bucket; with no limits recorded the chart is a bare distribution and
// nothing is flagged.
//
// shadcn chart (Recharts 3): one value axis (count), hairline grid on it only,
// per-column status colour via <Cell>. Pure: every prop is minimal plain data
// the server already bucketed, so no threshold constant crosses the client
// boundary.

export type AmountHistogramBar = {
  bucketLabel: string
  count: number
  belowThreshold: boolean
}

/** A recorded approval limit, drawn as a vertical rule immediately after
 *  `afterBucketIndex` (0-based). */
export type AmountHistogramThreshold = {
  label: string
  afterBucketIndex: number
}

const chartConfig = {
  count: { label: 'Entries', theme: SERIES_BLUE },
  warn: { label: 'Just below a limit', theme: STATUS_WARN },
  limit: { label: 'Approval limit', theme: STATUS_CRITICAL },
} satisfies ChartConfig

export function AmountHistogramChart({
  bars,
  thresholds = [],
}: {
  bars: AmountHistogramBar[]
  thresholds?: AmountHistogramThreshold[]
}) {
  const anim = useChartAnimation()
  if (bars.length === 0) return null

  const anyFlagged = bars.some((b) => b.belowThreshold)
  // Bucket labels need not be unique; the axis is keyed by index.
  const data = bars.map((b, i) => ({ ...b, slot: `b${i}` }))
  const labelFor = (slot: string) => data.find((d) => d.slot === slot)?.bucketLabel ?? slot

  return (
    <div className="flex flex-col gap-3">
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-[260px] w-full"
        role="img"
        aria-label={`Distribution of entry amounts -- ${bars
          .map((b) => `${b.bucketLabel}: ${formatNumber(b.count)}`)
          .join(', ')}.${
          thresholds.length > 0
            ? ` Recorded approval limits: ${thresholds.map((t) => t.label).join(', ')}.`
            : ' No approval limits recorded.'
        }`}
      >
        <BarChart data={data} margin={{ top: 22, right: 8, bottom: 4, left: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey="slot"
            interval={0}
            tickLine={false}
            axisLine={false}
            height={36}
            tick={<WrappingTick format={labelFor} />}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={40}
            tick={AXIS_TICK}
            tickFormatter={(v: number) => formatNumber(v)}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideIndicator
                labelFormatter={(_, payload) => String(payload[0]?.payload?.bucketLabel ?? '')}
                formatter={(value, _name, item) => (
                  <TooltipRow
                    color={item.payload?.belowThreshold ? 'var(--color-warn)' : 'var(--color-count)'}
                    name={item.payload?.belowThreshold ? 'Entries (just below a limit)' : 'Entries'}
                    value={formatNumber(Number(value))}
                  />
                )}
              />
            }
          />
          <Bar dataKey="count" name="count" radius={[4, 4, 0, 0]} maxBarSize={48} minPointSize={2} {...anim}>
            {data.map((d) => (
              <Cell key={d.slot} fill={d.belowThreshold ? 'var(--color-warn)' : 'var(--color-count)'} />
            ))}
            <LabelList
              dataKey="count"
              position="top"
              offset={4}
              fontSize={11}
              className="fill-foreground"
              formatter={(v) => (Number(v) > 0 ? formatNumber(Number(v)) : '')}
            />
          </Bar>
          {thresholds.map((t) =>
            t.afterBucketIndex >= 0 && t.afterBucketIndex < data.length ? (
              <ReferenceLine
                key={`${t.label}-${t.afterBucketIndex}`}
                x={`b${t.afterBucketIndex}`}
                position="end"
                stroke="var(--color-limit)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                label={{ value: t.label, position: 'top', fontSize: 11, className: 'fill-red-700 dark:fill-red-400' }}
              />
            ) : null
          )}
        </BarChart>
      </ChartContainer>

      {(anyFlagged || thresholds.length > 0) && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {thresholds.length > 0 && (
            <span className="flex items-center gap-1.5">
              <svg width={14} height={12} aria-hidden="true">
                <line x1={7} y1={0} x2={7} y2={12} className="stroke-red-600 dark:stroke-red-500" strokeWidth={1.5} strokeDasharray="4 3" />
              </svg>
              Recorded approval limit
            </span>
          )}
          {anyFlagged && (
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-[2px] bg-amber-500 dark:bg-amber-400" aria-hidden="true" />
              Amounts sitting just below a limit
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" aria-hidden="true" />
            All other amounts
          </span>
        </div>
      )}
    </div>
  )
}
