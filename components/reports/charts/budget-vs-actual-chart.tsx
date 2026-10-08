'use client'

import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { formatINR, formatINRCompact, formatPercent } from '@/lib/reports/format'
import { outlierScale } from '@/lib/reports/outlier-scale'
import {
  AXIS_TICK,
  BAR_PX,
  CategoryTick,
  GRID_STROKE,
  cappedBarShape,
  SERIES_BLUE,
  STATUS_CRITICAL,
  STATUS_WARN,
  TooltipRow,
  horizontalChartHeight,
  useCompactChart,
} from './recharts-kit'

// reporting-blueprint.md A-01 — budget vs actual at the level budgets actually
// exist: departments and sub-departments (budget heads and zones carry no
// approved amounts). A bullet-style bar per row: the approved budget as a wide
// neutral track, actual spend as a thinner bar inside it in the budget-status
// colour (within / near / over, the same steps as BudgetStatusLegend), so
// "how far through its budget" reads off the overlap. One ₹ axis only.
//
// The approved budget is WRITTEN on every row, not left to a hover: the
// right-hand column reads "₹12.4L of ₹15L · 83%" ("no budget set" when a row
// has none). That column is a second category axis carrying text, not a
// second value scale. On a phone it shortens to the % alone.
//
// Broken axis: when one or two departments dwarf the rest (Venue Setup's
// budget is many times any other), a linear scale shrinks every other bar to
// a sliver. outlierScale() caps the axis just above the next-largest row; the
// outliers run to the edge with a ⫽ break mark (cappedBarShape) and keep
// their true figures in the written column and tooltip. A caption names them
// and a toggle restores the full scale.

export type BudgetVsActualBar = {
  key: string
  label: string
  budget: number | null
  actual: number
  href?: string | null
}

const STATUS_WITHIN = { light: '#059669', dark: '#10b981' } // emerald-600 / 500
const TRACK = { light: '#dcd9d4', dark: '#3f3c39' }

type Status = 'within' | 'near' | 'over' | 'none'

function statusOf(budget: number | null, actual: number): Status {
  if (!budget || budget <= 0) return 'none'
  const pct = (actual / budget) * 100
  // Same thresholds as budgetStatusColorClass (lib/reports/sections/shared.tsx).
  if (pct <= 95) return 'within'
  if (pct <= 110) return 'near'
  return 'over'
}

const chartConfig = {
  budget: { label: 'Approved budget', theme: TRACK },
  within: { label: 'Within budget', theme: STATUS_WITHIN },
  near: { label: 'Near limit', theme: STATUS_WARN },
  over: { label: 'Over budget', theme: STATUS_CRITICAL },
  none: { label: 'No budget set', theme: SERIES_BLUE },
} satisfies ChartConfig

const STATUS_VAR: Record<Status, string> = {
  within: 'var(--color-within)',
  near: 'var(--color-near)',
  over: 'var(--color-over)',
  none: 'var(--color-none)',
}

export function BudgetVsActualChart({
  bars,
  onSelect,
  ariaLabel,
}: {
  bars: BudgetVsActualBar[]
  /** Row click (e.g. drill from a department into its divisions). */
  onSelect?: (key: string) => void
  ariaLabel?: string
}) {
  const anim = useChartAnimation()
  const [ref, compact] = useCompactChart()
  const [fullScale, setFullScale] = useState(false)

  if (bars.length === 0) return null

  const base = bars.map((b) => {
    const budgetValue = b.budget && b.budget > 0 ? b.budget : 0
    return { ...b, budgetValue, status: statusOf(b.budget, b.actual), extent: Math.max(budgetValue, b.actual) }
  })
  const scale = outlierScale(base.map((d) => d.extent))
  const cap = fullScale ? null : scale.cap
  // Plotted values are clamped to the cap; the real ones (budgetValue,
  // actual) stay on the row for the written column and the tooltip.
  const data = base.map((d) => ({
    ...d,
    budgetPlot: cap != null ? Math.min(d.budgetValue, cap) : d.budgetValue,
    actualPlot: cap != null ? Math.min(d.actual, cap) : d.actual,
    budgetClipped: cap != null && d.budgetValue > cap,
    actualClipped: cap != null && d.actual > cap,
  }))
  const outliers = base.filter((d) => scale.cap != null && d.extent > scale.cap)
  const byKey = new Map(data.map((d) => [d.key, d]))
  const labelWidth = compact ? 104 : 168
  // Wide enough for "₹10.20 Cr of ₹12.50 Cr · 108.4%" at 11px tabular sans.
  const summaryWidth = compact ? 52 : 200

  function summary(key: string): string {
    const d = byKey.get(key)
    if (!d) return ''
    if (!d.budgetValue) return compact ? '—' : `${formatINRCompact(d.actual)} · no budget set`
    const pct = formatPercent((d.actual / d.budgetValue) * 100)
    return compact ? pct : `${formatINRCompact(d.actual)} of ${formatINRCompact(d.budgetValue)} · ${pct}`
  }

  return (
    <div ref={ref} className="flex flex-col gap-2">
      <ChartContainer
        config={chartConfig}
        className="aspect-auto w-full"
        style={{ height: horizontalChartHeight(data.length) }}
        role="img"
        aria-label={
          ariaLabel ??
          'Budget vs actual — each row shows its approved budget as a grey track and actual spend inside it, coloured by budget status. Exact figures are in the table below.'
        }
      >
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barGap={-(BAR_PX - 2)}>
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => formatINRCompact(v)}
            domain={cap != null ? [0, cap] : [0, 'dataMax']}
            allowDataOverflow={cap != null}
          />
          <YAxis
            type="category"
            dataKey="key"
            width={labelWidth}
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={(p) => (
              <CategoryTick
                {...p}
                maxChars={compact ? 13 : 24}
                lookup={(k) => {
                  const d = byKey.get(k)
                  return d ? { label: d.label, href: d.href ?? null } : undefined
                }}
              />
            )}
          />
          {/* Written budget column: text only, same categories — not a value axis. */}
          <YAxis
            yAxisId="summary"
            orientation="right"
            type="category"
            dataKey="key"
            width={summaryWidth}
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value?: unknown } }) => (
              <text
                x={Number(x ?? 0) + 6}
                y={Number(y ?? 0)}
                dy={4}
                fontSize={11}
                className="fill-muted-foreground tabular-nums"
              >
                {summary(String(payload?.value ?? ''))}
              </text>
            )}
          />
          <ChartTooltip
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
            content={({ active, payload }) => {
              const d = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined
              if (!d) return null
              const pct = d.budgetValue ? (d.actual / d.budgetValue) * 100 : null
              return (
                <div className="grid min-w-[12rem] gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                  <p className="font-medium text-foreground">{d.label}</p>
                  <TooltipRow color="var(--color-budget)" name="Approved budget" value={d.budgetValue ? formatINR(d.budgetValue) : 'not set'} />
                  <TooltipRow color={STATUS_VAR[d.status]} name="Actual" value={formatINR(d.actual)} />
                  {pct != null && (
                    <>
                      <TooltipRow name="Used" value={formatPercent(pct)} />
                      <TooltipRow name={d.actual > d.budgetValue ? 'Over by' : 'Balance'} value={formatINR(Math.abs(d.budgetValue - d.actual))} />
                    </>
                  )}
                </div>
              )
            }}
          />
          <Bar
            dataKey="budgetPlot"
            name="Approved budget"
            fill="var(--color-budget)"
            barSize={BAR_PX + 4}
            shape={cappedBarShape((p) => Boolean((p as { budgetClipped?: boolean })?.budgetClipped), Boolean(onSelect))}
            isAnimationActive={false}
            onClick={onSelect ? (d: { payload?: { key?: string } }) => d.payload?.key && onSelect(d.payload.key) : undefined}
          />
          <Bar
            dataKey="actualPlot"
            name="Actual"
            barSize={BAR_PX - 6}
            shape={cappedBarShape((p) => Boolean((p as { actualClipped?: boolean })?.actualClipped), Boolean(onSelect))}
            {...anim}
            onClick={onSelect ? (d: { payload?: { key?: string } }) => d.payload?.key && onSelect(d.payload.key) : undefined}
          >
            {data.map((d) => (
              <Cell key={d.key} fill={STATUS_VAR[d.status]} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>

      {scale.cap != null && (
        <p className="text-xs text-muted-foreground">
          {fullScale ? (
            <>Full scale — smaller departments are compressed by the largest. </>
          ) : (
            <>
              Scale capped at {formatINRCompact(scale.cap)} so every department stays readable —{' '}
              {outliers.map((o, i) => (
                <span key={o.key}>
                  {i > 0 && ', '}
                  <span className="font-medium text-foreground">{o.label}</span> ({formatINRCompact(o.extent)})
                </span>
              ))}{' '}
              {outliers.length === 1 ? 'runs' : 'run'} past it, marked ⫽. Exact figures are written on each row.{' '}
            </>
          )}
          <button
            type="button"
            onClick={() => setFullScale((v) => !v)}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {fullScale ? 'Fit to most departments' : 'Show full scale'}
          </button>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-[#dcd9d4] dark:bg-[#3f3c39]" />
          Approved budget
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-4 rounded-sm bg-[#059669] dark:bg-[#10b981]" />
          Within budget
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-4 rounded-sm bg-[#f59e0b] dark:bg-[#fbbf24]" />
          Near limit (95–110%)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-4 rounded-sm bg-[#dc2626] dark:bg-[#ef4444]" />
          Over budget
        </span>
        {data.some((d) => d.status === 'none') && (
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-4 rounded-sm bg-[#2a78d6] dark:bg-[#3987e5]" />
            No budget set
          </span>
        )}
      </div>
    </div>
  )
}
