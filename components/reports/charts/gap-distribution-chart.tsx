'use client'

import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from 'recharts'
import { formatNumber } from '@/lib/reports/format'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { AXIS_TICK, GRID_STROKE, SERIES_BLUE, STATUS_CRITICAL, TooltipRow, WrappingTick } from './recharts-kit'

// reporting-blueprint.md D-05 -- "Distribution of the gap between the entry
// amount and the bill's own total. Most sit at zero; the tail is the report."
// A plain bucketed column chart of gap-as-percent-of-entry. The "No gap"
// column dominates by design; the reserved critical-status colour lands ONLY
// on the buckets the loader marked material (a gap over the medium-severity
// rupee bar or over ~1% of the entry) -- §6 fix #5: status colour, always with
// a label, never a plain series hue and never the sole signal (the bucket
// label and the count on the face of each column carry it without colour).
//
// shadcn chart (Recharts 3): one value axis, hairline grid on it only,
// per-column status colour via <Cell>, counts via <LabelList>. Pure: the only
// prop is minimal plain data the server already bucketed, so no threshold
// constant crosses the client boundary.

export type GapDistributionBar = { bucketLabel: string; count: number; material: boolean }

const chartConfig = {
  count: { label: 'Within tolerance', theme: SERIES_BLUE },
  material: { label: 'Material gap', theme: STATUS_CRITICAL },
} satisfies ChartConfig

export function GapDistributionChart({ bars }: { bars: GapDistributionBar[] }) {
  const anim = useChartAnimation()
  if (bars.length === 0) return null

  const anyMaterial = bars.some((b) => b.material)
  const data = bars.map((b, i) => ({ ...b, slot: `b${i}` }))
  const labelFor = (slot: string) => data.find((d) => d.slot === slot)?.bucketLabel ?? slot

  return (
    <div className="flex flex-col gap-3">
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-[240px] w-full"
        role="img"
        aria-label={`Reconciliation gap distribution -- ${bars
          .map((b) => `${b.bucketLabel}: ${formatNumber(b.count)}`)
          .join(', ')}. Bars flagged material: ${
          bars
            .filter((b) => b.material)
            .map((b) => b.bucketLabel)
            .join(', ') || 'none'
        }.`}
      >
        <BarChart data={data} margin={{ top: 18, right: 8, bottom: 4, left: 0 }} barCategoryGap="22%">
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
                    color={item.payload?.material ? 'var(--color-material)' : 'var(--color-count)'}
                    name={item.payload?.material ? 'Entries (material gap)' : 'Entries'}
                    value={formatNumber(Number(value))}
                  />
                )}
              />
            }
          />
          <Bar dataKey="count" name="count" radius={[4, 4, 0, 0]} maxBarSize={56} minPointSize={2} {...anim}>
            {data.map((d) => (
              <Cell key={d.slot} fill={d.material ? 'var(--color-material)' : 'var(--color-count)'} />
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
        </BarChart>
      </ChartContainer>

      {anyMaterial && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-red-600 dark:bg-red-500" aria-hidden="true" />
            Material gap (over ₹10,000 or ~1% of the entry)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" aria-hidden="true" />
            Within tolerance
          </span>
        </div>
      )}
    </div>
  )
}
