'use client'

import { useId, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine, XAxis, YAxis } from 'recharts'
import { formatNumber, formatINRCompact } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { TooltipValueRow } from '@/components/reports/charts/tooltip-value-row'

// Spend pace (reporting-blueprint A-03, /reports overview + /reports/brief).
// Cumulative actual spend as an area with a soft wash + 2px line, the
// even-pace target as a dashed muted line, a dotted "Forecast" extension from
// the current week to the event's end at the current run rate, and the
// approved budget as a labelled ceiling line. The forecast comes from
// lib/reports/hero-metrics.ts computeSpendTrend, which reuses
// computeProjectedLanding — the same projection behind the Brief's "projects
// to land at X%" sentence — so the chart and the sentence never disagree.
// One ₹ axis only; every value is also in the "View as table" twin.

export type TrendPoint = {
  label: string
  /** Null for weeks that haven't happened yet. */
  actual: number | null
  target: number | null
  /** Dotted run-rate extension; null/absent outside it. */
  forecast?: number | null
}

// `valueFormatter` used to be a function prop, but this component is a
// Client Component rendered from Server Component pages -- a function
// reference can't cross that boundary (React errors "Functions cannot be
// passed directly to Client Components", digest 429141552, seen live on
// /reports). A format *name* is plain data and serializes fine; the actual
// function is resolved locally here, on the client.
const FORMATTERS = { number: formatNumber, 'inr-compact': formatINRCompact } as const

const ACCENT = { light: '#2a78d6', dark: '#3987e5' }
const MUTED = { light: '#898781', dark: '#898781' }

const chartConfig = {
  actual: { label: 'Actual', theme: ACCENT },
  target: { label: 'Target pace', theme: MUTED },
  forecast: { label: 'Forecast', theme: ACCENT },
  budget: { label: 'Budget', theme: MUTED },
} satisfies ChartConfig

const LEGEND: { key: keyof typeof chartConfig; dash: string | undefined; strokeClass: string }[] = [
  { key: 'actual', dash: undefined, strokeClass: 'stroke-[#2a78d6] dark:stroke-[#3987e5]' },
  { key: 'target', dash: '5 3', strokeClass: 'stroke-muted-foreground' },
  { key: 'forecast', dash: '2 3', strokeClass: 'stroke-[#2a78d6] dark:stroke-[#3987e5]' },
  { key: 'budget', dash: undefined, strokeClass: 'stroke-foreground/50' },
]

export function TrendChart({
  points,
  valueFormat = 'number',
  budget = null,
}: {
  points: TrendPoint[]
  valueFormat?: keyof typeof FORMATTERS
  /** Approved-budget ceiling, drawn as a labelled reference line when set. */
  budget?: number | null
}) {
  const valueFormatter = FORMATTERS[valueFormat]
  const [showTable, setShowTable] = useState(false)
  const anim = useChartAnimation()
  const gradientId = `trend-fill-${useId().replace(/:/g, '')}`

  if (points.length === 0) return null

  const hasTarget = points.some((p) => p.target != null)
  const hasForecast = points.some((p) => p.forecast != null)
  const hasBudget = budget != null && budget > 0
  const data = points.map((p) => ({ ...p, forecast: p.forecast ?? null }))
  const lastActualIndex = data.findLastIndex((p) => p.actual != null)
  const lastForecastIndex = data.findLastIndex((p) => p.forecast != null)
  const legendItems = LEGEND.filter(
    (l) => l.key === 'actual' || (l.key === 'target' && hasTarget) || (l.key === 'forecast' && hasForecast) || (l.key === 'budget' && hasBudget)
  )

  const tableColumns: DataTableColumn<TrendPoint>[] = [
    { key: 'label', header: 'Week of', render: (p) => p.label },
    { key: 'actual', header: 'Actual', align: 'right', render: (p) => (p.actual != null ? valueFormatter(p.actual) : '—') },
    { key: 'target', header: 'Target pace', align: 'right', render: (p) => (p.target != null ? valueFormatter(p.target) : '—') },
    ...(hasForecast
      ? [{ key: 'forecast', header: 'Forecast', align: 'right' as const, render: (p: TrendPoint) => (p.forecast != null ? valueFormatter(p.forecast) : '—') }]
      : []),
  ]

  const lastActual = lastActualIndex >= 0 ? data[lastActualIndex]!.actual : null
  const projected = lastForecastIndex >= 0 ? data[lastForecastIndex]!.forecast : null

  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`Spend pace — cumulative spend${lastActual != null ? ` of ${valueFormatter(lastActual)} so far` : ''}${
          hasTarget ? ' against an even-pace target' : ''
        }${projected != null ? `, forecast to reach ${valueFormatter(projected)} by the event's end at the current pace` : ''}${
          hasBudget ? ` versus an approved budget of ${valueFormatter(budget)}` : ''
        }. See the table view below for exact values.`}
      >
        <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
          <ComposedChart data={data} margin={{ top: 16, right: 12, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-actual)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--color-actual)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval="preserveStartEnd"
              minTickGap={28}
              fontSize={11}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              // "₹2.40 Cr" needs ~64px at 11px or Recharts wraps it onto two lines.
              width={valueFormat === 'inr-compact' ? 68 : 56}
              tickCount={5}
              tickFormatter={(v: number) => valueFormatter(v)}
              fontSize={11}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name, item) => {
                    // The current week carries both actual and the forecast
                    // anchor (same figure) — show it once, as actual.
                    if (name === 'forecast' && item.payload?.actual != null) return null
                    const key = name as keyof typeof chartConfig
                    return (
                      <TooltipValueRow
                        color={item.color}
                        dashed={key !== 'actual'}
                        label={chartConfig[key]?.label ?? name}
                        value={valueFormatter(value as number)}
                      />
                    )
                  }}
                />
              }
            />
            {hasBudget && (
              <ReferenceLine
                y={budget}
                ifOverflow="extendDomain"
                stroke="var(--color-budget)"
                strokeWidth={1}
                label={{
                  value: `Budget ${valueFormatter(budget)}`,
                  position: 'insideTopLeft',
                  fontSize: 11,
                  className: 'fill-muted-foreground',
                }}
              />
            )}
            <Area
              dataKey="actual"
              type="linear"
              stroke="var(--color-actual)"
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2 }}
              connectNulls={false}
              {...anim}
            >
              <LabelList
                dataKey="actual"
                content={(props) =>
                  props.index === lastActualIndex && !hasForecast ? (
                    <text x={Number(props.x)} y={Number(props.y) - 8} textAnchor="end" fontSize={11} className="fill-foreground font-medium">
                      {valueFormatter(Number(props.value))}
                    </text>
                  ) : null
                }
              />
            </Area>
            {hasTarget && (
              <Line
                dataKey="target"
                type="linear"
                stroke="var(--color-target)"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2 }}
                {...anim}
              />
            )}
            {hasForecast && (
              <Line
                dataKey="forecast"
                type="linear"
                stroke="var(--color-forecast)"
                strokeWidth={2}
                strokeDasharray="2 3"
                strokeLinecap="round"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2 }}
                connectNulls={false}
                {...anim}
              >
                <LabelList
                  dataKey="forecast"
                  content={(props) =>
                    props.index === lastForecastIndex ? (
                      <text x={Number(props.x)} y={Number(props.y) - 8} textAnchor="end" fontSize={11} className="fill-foreground font-medium">
                        {valueFormatter(Number(props.value))} projected
                      </text>
                    ) : null
                  }
                />
              </Line>
            )}
          </ComposedChart>
        </ChartContainer>
      </div>

      {/* Legend: line-style keys (solid / dashed / dotted), since three of the
          four marks are lines distinguished by dash, not hue. Text tokens only. */}
      {legendItems.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {legendItems.map((l) => (
            <span key={l.key} className="flex items-center gap-1.5">
              <svg width={14} height={4} aria-hidden="true">
                <line x1={0} y1={2} x2={14} y2={2} className={l.strokeClass} strokeWidth={l.key === 'budget' ? 1 : 2} strokeDasharray={l.dash} />
              </svg>
              {chartConfig[l.key].label}
            </span>
          ))}
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
