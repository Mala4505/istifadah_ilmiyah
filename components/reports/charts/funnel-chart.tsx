'use client'

import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from 'recharts'
import { formatNumber, formatPercent } from '@/lib/reports/format'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { ORDINAL_RAMP } from './ordinal-ramp'
import {
  CategoryTick,
  TooltipRow,
  barEndLabel,
  horizontalChartHeight,
  useCompactChart,
} from './recharts-kit'

// Document pipeline funnel — presentational only (a click-through belongs to
// whatever hosts this, same as bar-list's `href` does for its rows). One
// horizontal bar per stage, left-anchored on a shared count axis, so every
// later stage reads as "share of the top of the funnel." Stage colour is
// ORDINAL_RAMP (position in a fixed sequence: one hue, monotone steps — never
// a per-stage hue); stages past the ramp's length hold its last step rather
// than cycling. Drop-off between consecutive stages is computed against the
// immediately preceding stage (the number a reader means by "drop-off") and
// labelled at the bar end next to the count.
//
// shadcn chart (Recharts 3). 'use client' because Recharts is; the props are
// plain serialisable data, so Server Component hosts can keep rendering it.

type FunnelStage = { key: string; label: string; count: number }

const chartConfig = Object.fromEntries(
  ORDINAL_RAMP.map((step, i) => [`s${i}`, { label: `Stage ${i + 1}`, theme: step.hex }])
) satisfies ChartConfig

function stepKey(i: number): string {
  return `s${Math.min(i, ORDINAL_RAMP.length - 1)}`
}

export function FunnelChart({ stages }: { stages: { key: string; label: string; count: number }[] }) {
  const anim = useChartAnimation()
  const [wrapRef, compact] = useCompactChart()
  if (stages.length === 0) return null

  const base = Math.max(1, stages[0]!.count) // stages.length > 0, checked above
  const data = stages.map((stage, i) => {
    const prev = i > 0 ? stages[i - 1]! : null
    const dropOffPct = prev && prev.count > 0 ? ((prev.count - stage.count) / prev.count) * 100 : null
    return { ...stage, dropOffPct, shareOfTop: (stage.count / base) * 100, fillKey: stepKey(i) }
  })
  const byKey = new Map<string, FunnelStage>(data.map((d) => [d.key, d]))

  const EndLabel = barEndLabel((i) => {
    const d = data[i]
    if (!d) return null
    return (
      <text dy={4} fontSize={11}>
        <tspan className="fill-foreground font-medium">{formatNumber(d.count)}</tspan>
        {d.dropOffPct != null && d.dropOffPct > 0.05 && (
          <tspan className="fill-muted-foreground"> · &minus;{d.dropOffPct.toFixed(0)}% drop-off</tspan>
        )}
      </text>
    )
  })

  return (
    <div ref={wrapRef}>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto w-full"
        style={{ height: horizontalChartHeight(data.length, 8) }}
        role="img"
        aria-label={`Pipeline funnel — ${data
          .map(
            (d) =>
              `${d.label}: ${formatNumber(d.count)}${
                d.dropOffPct != null && d.dropOffPct > 0.05 ? ` (${d.dropOffPct.toFixed(0)}% drop-off)` : ''
              }`
          )
          .join(', ')}.`}
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: compact ? 112 : 148, bottom: 4, left: 0 }}
          barSize={22}
        >
          <XAxis type="number" hide domain={[0, Math.max(base, ...data.map((d) => d.count))]} />
          <YAxis
            type="category"
            dataKey="key"
            width={compact ? 104 : 150}
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={
              <CategoryTick
                maxChars={compact ? 14 : 22}
                lookup={(k) => {
                  const s = byKey.get(k)
                  return s ? { label: s.label } : undefined
                }}
              />
            }
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideIndicator
                labelFormatter={(_, payload) => String(payload[0]?.payload?.label ?? '')}
                formatter={(_v, _n, item) => {
                  const d = item.payload as (typeof data)[number] | undefined
                  if (!d) return null
                  return (
                    <div className="grid w-full gap-1.5">
                      <TooltipRow color={`var(--color-${d.fillKey})`} name="Count" value={formatNumber(d.count)} />
                      <TooltipRow name="Share of first stage" value={formatPercent(d.shareOfTop)} />
                      {d.dropOffPct != null && (
                        <TooltipRow name="Drop-off from previous" value={formatPercent(d.dropOffPct)} />
                      )}
                    </div>
                  )
                }}
              />
            }
          />
          <Bar dataKey="count" name="count" radius={[0, 4, 4, 0]} minPointSize={2} {...anim}>
            {data.map((d) => (
              <Cell key={d.key} fill={`var(--color-${d.fillKey})`} />
            ))}
            <LabelList dataKey="count" content={EndLabel} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}
