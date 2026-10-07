'use client'

import { useState } from 'react'
import { Bar, CartesianGrid, Cell, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { TooltipValueRow } from '@/components/reports/charts/tooltip-value-row'

// reporting-blueprint.md D-07 — Benford's Law leading-digit test. "Leading-digit
// distribution of all amounts against the expected curve." Observed share is
// drawn as bars; Benford's expected curve as one overlaid line with a marker
// per digit. Both series are percentages on ONE shared scale — never a dual
// axis (§6 fix #8): the whole point is to read the bar tops against the line.
//
// Colour: bars are the one accent hue by default. A bar whose observed share
// sits far enough from its expected value gets a reserved status colour
// (amber = notable, red = large) so the eye lands on the digits that actually
// break from the curve — always paired with the deviation number in the
// tooltip and table, never colour alone (§6 fix #5). The thresholds are a
// per-digit visual aid only; the conformity verdict is the event-level MAD
// statistic shown in the KPI above this chart.
//
// Recharts (shadcn chart) since the 2026-10-07 direction change; loaded via
// benford-chart-lazy.tsx. The "View as table" twin keeps every value plain text.

export type BenfordDigitDatum = {
  digit: number
  observedPct: number
  expectedPct: number
}

// Per-digit deviation thresholds, in percentage POINTS of |observed − expected|.
// Duplicated here as a literal rather than imported from the loader: this is a
// 'use client' module and the loader transitively imports next/headers via
// @/lib/supabase/server, so a value import from it would break the client
// bundle (types are erased and safe, runtime values are not).
const DIGIT_DEVIATION_WARN_PP = 2
const DIGIT_DEVIATION_BAD_PP = 4

const chartConfig = {
  observedPct: { label: 'Observed share', theme: { light: '#2a78d6', dark: '#3987e5' } },
  expectedPct: { label: 'Benford expected', theme: { light: '#52514e', dark: '#c3c2bd' } },
  warn: { label: `≥ ${DIGIT_DEVIATION_WARN_PP} pp off`, theme: { light: '#f59e0b', dark: '#fbbf24' } },
  bad: { label: `≥ ${DIGIT_DEVIATION_BAD_PP} pp off`, theme: { light: '#dc2626', dark: '#ef4444' } },
} satisfies ChartConfig

function barColorFor(deviationPp: number): string {
  const abs = Math.abs(deviationPp)
  if (abs >= DIGIT_DEVIATION_BAD_PP) return 'var(--color-bad)'
  if (abs >= DIGIT_DEVIATION_WARN_PP) return 'var(--color-warn)'
  return 'var(--color-observedPct)'
}

function signedPp(dev: number): string {
  return `${dev > 0 ? '+' : dev < 0 ? '−' : '±'}${Math.abs(dev).toFixed(1)} pp`
}

const LEGEND_SWATCH = {
  observedPct: 'bg-[#2a78d6] dark:bg-[#3987e5]',
  warn: 'bg-amber-500 dark:bg-amber-400',
  bad: 'bg-red-600 dark:bg-red-500',
} as const

export function BenfordChart({ data }: { data: BenfordDigitDatum[] }) {
  const [showTable, setShowTable] = useState(false)
  const anim = useChartAnimation()

  if (data.length === 0) return null

  const sorted = [...data].sort((a, b) => a.digit - b.digit)
  const anyWarn = sorted.some((d) => Math.abs(d.observedPct - d.expectedPct) >= DIGIT_DEVIATION_WARN_PP)

  const tableColumns: DataTableColumn<BenfordDigitDatum>[] = [
    { key: 'digit', header: 'Leading digit', render: (d) => d.digit },
    { key: 'observed', header: 'Observed %', align: 'right', render: (d) => `${d.observedPct.toFixed(1)}%` },
    { key: 'expected', header: 'Benford expected %', align: 'right', render: (d) => `${d.expectedPct.toFixed(1)}%` },
    { key: 'deviation', header: 'Deviation (pp)', align: 'right', render: (d) => signedPp(d.observedPct - d.expectedPct).replace(' pp', '') },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label="Benford's Law leading-digit test — bars are the observed share of entry amounts starting with each digit 1 to 9, the line is Benford's expected curve. Both are percentages on one scale. See the table view below for exact values."
      >
        <ChartContainer config={chartConfig} className="aspect-auto h-[240px] w-full">
          <ComposedChart data={sorted} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="digit"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              fontSize={11}
              height={40}
              label={{ value: 'Leading digit of the entry amount', position: 'insideBottom', offset: 0, fontSize: 11, className: 'fill-muted-foreground' }}
            />
            <YAxis tickLine={false} axisLine={false} width={40} tickCount={5} fontSize={11} tickFormatter={(v: number) => `${v}%`} />
            <ChartTooltip
              cursor={{ fillOpacity: 0.5 }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const d = payload?.[0]?.payload as BenfordDigitDatum | undefined
                    return d ? `Leading digit ${d.digit}` : null
                  }}
                  formatter={(value, name, item) => {
                    const d = item.payload as BenfordDigitDatum | undefined
                    if (name === 'observedPct' && d) {
                      return (
                        <div className="grid w-full gap-1.5">
                          <TooltipValueRow color={barColorFor(d.observedPct - d.expectedPct)} label="Observed" value={`${d.observedPct.toFixed(1)}%`} />
                          <TooltipValueRow label="Deviation" value={signedPp(d.observedPct - d.expectedPct)} color="transparent" />
                        </div>
                      )
                    }
                    return <TooltipValueRow color="var(--color-expectedPct)" dashed label="Benford expected" value={`${(value as number).toFixed(1)}%`} />
                  }}
                />
              }
            />
            <Bar dataKey="observedPct" radius={[4, 4, 0, 0]} maxBarSize={24} {...anim}>
              {sorted.map((d) => (
                <Cell key={d.digit} fill={barColorFor(d.observedPct - d.expectedPct)} />
              ))}
            </Bar>
            <Line
              dataKey="expectedPct"
              type="linear"
              stroke="var(--color-expectedPct)"
              strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, fill: 'var(--color-expectedPct)', stroke: 'hsl(var(--card))' }}
              activeDot={{ r: 5, strokeWidth: 2 }}
              {...anim}
            />
          </ComposedChart>
        </ChartContainer>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-[2px] ${LEGEND_SWATCH.observedPct}`} />
          {chartConfig.observedPct.label}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={14} height={10} aria-hidden="true">
            <line x1={0} y1={5} x2={14} y2={5} className="stroke-[#52514e] dark:stroke-[#c3c2bd]" strokeWidth={2} />
            <circle cx={7} cy={5} r={3} className="fill-[#52514e] dark:fill-[#c3c2bd]" />
          </svg>
          {chartConfig.expectedPct.label}
        </span>
        {anyWarn && (
          <>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-[2px] ${LEGEND_SWATCH.warn}`} />
              {chartConfig.warn.label}
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-[2px] ${LEGEND_SWATCH.bad}`} />
              {chartConfig.bad.label}
            </span>
          </>
        )}
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={sorted} getRowKey={(d) => d.digit} />}
    </div>
  )
}
