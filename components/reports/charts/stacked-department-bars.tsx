'use client'

import { useRouter } from 'next/navigation'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { formatINRCompact, formatPercent } from '@/lib/reports/format'
import { outlierScale } from '@/lib/reports/outlier-scale'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  useChartAnimation,
  type ChartConfig,
} from '@/components/ui/chart'
import {
  AXIS_TICK,
  BAR_PX,
  CategoryTick,
  GRID_STROKE,
  TooltipRow,
  horizontalChartHeight,
  stackedSegmentShape,
  useCompactChart,
} from './recharts-kit'

// Shared renderer for the per-department stacked bars (A-08 entry-type split,
// C-09 instrument mix, B-08 tax exposure). One horizontal stacked bar per
// department on ONE value axis: either 100%-stacked (`mode="percent"`, the mix
// is comparable across departments of very different size) or absolute ₹
// (`mode="absolute"`). Series order, labels and colours come from the caller
// (fixed order, never cycled). 2px surface gap between segments, 4px rounded
// data end on each row's last segment only, legend always shown, per-row
// tooltip listing every non-zero segment with ₹ and % of the department.
// Department names are focusable drill links on the category axis; when
// `segmentHref` is given each segment is a click-through too.
//
// Client-only and internal to the chart modules: `segmentHref` is a function
// prop, so this must only ever be rendered from another client component.

export type StackedSeries = { key: string; label: string; theme: { light: string; dark: string } }

export type StackedRow = {
  rowKey: string
  label: string
  href?: string | null
  total: number
  values: Record<string, number>
}

type Datum = Record<string, number | string | null | undefined> & {
  rowKey: string
  __label: string
  __total: number
  __last: string
  /** 'yes' when the row's total runs past the capped axis. */
  __clipped: string
}

export function StackedDepartmentBars({
  rows,
  series,
  mode,
  ariaLabel,
  segmentHref,
}: {
  rows: StackedRow[]
  series: readonly StackedSeries[]
  mode: 'percent' | 'absolute'
  ariaLabel: string
  segmentHref?: (row: StackedRow, seriesKey: string) => string | null
}) {
  const router = useRouter()
  const anim = useChartAnimation()
  const [wrapRef, compact] = useCompactChart()

  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, theme: s.theme }]))
  const byKey = new Map(rows.map((r) => [r.rowKey, r]))

  // Absolute mode only: broken axis when one or two departments dwarf the
  // rest (lib/reports/outlier-scale.ts). Segments are clamped in stack order
  // so a capped row stops at the edge; its last visible segment carries the ⫽
  // break mark. Tooltip figures stay the real ones (raw_*).
  const scale = mode === 'absolute' ? outlierScale(rows.map((r) => r.total)) : { cap: null, outlierCount: 0 }
  const cap = scale.cap

  const data: Datum[] = rows.map((r) => {
    const d: Datum = { rowKey: r.rowKey, __label: r.label, __total: r.total, __last: '', __clipped: '' }
    let used = 0
    for (const s of series) {
      const raw = Math.max(0, r.values[s.key] ?? 0)
      d[`raw_${s.key}`] = raw
      let plotted = mode === 'percent' ? (r.total > 0 ? (raw / r.total) * 100 : 0) : raw
      if (cap != null) plotted = Math.min(plotted, Math.max(0, cap - used))
      used += plotted
      d[s.key] = plotted
      if (plotted > 0) d.__last = s.key
    }
    if (cap != null && r.total > cap) d.__clipped = 'yes'
    return d
  })
  const outliers = cap != null ? rows.filter((r) => r.total > cap) : []

  const clickable = segmentHref != null

  return (
    <div ref={wrapRef}>
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height: horizontalChartHeight(data.length, 28 + (compact ? 64 : 40)) }}
        role="img"
        aria-label={ariaLabel}
      >
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }} barSize={BAR_PX}>
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            domain={mode === 'percent' ? [0, 100] : cap != null ? [0, cap] : [0, 'auto']}
            allowDataOverflow={cap != null}
            ticks={mode === 'percent' ? [0, 25, 50, 75, 100] : undefined}
            tickCount={mode === 'percent' ? undefined : compact ? 3 : 5}
            tickFormatter={(v: number) => (mode === 'percent' ? `${v}%` : formatINRCompact(v))}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
          />
          <YAxis
            type="category"
            dataKey="rowKey"
            width={compact ? 104 : 160}
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={
              <CategoryTick
                maxChars={compact ? 14 : 22}
                lookup={(k) => {
                  const r = byKey.get(k)
                  return r ? { label: r.label, href: r.href } : undefined
                }}
              />
            }
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideIndicator
                labelFormatter={(_, payload) => {
                  const d = payload[0]?.payload as Datum | undefined
                  return d ? `${d.__label} · ${formatINRCompact(d.__total)}` : null
                }}
                formatter={(_v, name, item) => {
                  const d = item.payload as Datum | undefined
                  const raw = Number(d?.[`raw_${name}`] ?? 0)
                  if (!d || raw <= 0) return null
                  const s = series.find((x) => x.key === name)
                  return (
                    <TooltipRow
                      color={`var(--color-${name})`}
                      name={s?.label ?? name}
                      value={formatINRCompact(raw)}
                      sub={d.__total > 0 ? formatPercent((raw / d.__total) * 100) : undefined}
                    />
                  )
                }}
              />
            }
          />
          {/* itemSorter={null}: keep series order (Recharts 3 sorts legend items alphabetically by default). */}
          <ChartLegend verticalAlign="bottom" itemSorter={null} content={<ChartLegendContent />} />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.key}
              stackId="dept"
              fill={`var(--color-${s.key})`}
              shape={stackedSegmentShape(
                (p) => (p as Datum | undefined)?.__last === s.key,
                clickable,
                (p) => (p as Datum | undefined)?.__last === s.key && (p as Datum | undefined)?.__clipped === 'yes'
              )}
              onClick={
                clickable
                  ? (entry) => {
                      const d = entry.payload as Datum | undefined
                      const row = d ? byKey.get(d.rowKey) : undefined
                      const href = row ? segmentHref(row, s.key) : null
                      if (href) router.push(href)
                    }
                  : undefined
              }
              {...anim}
            />
          ))}
        </BarChart>
      </ChartContainer>
      {outliers.length > 0 && cap != null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Scale capped at {formatINRCompact(cap)} so every department stays readable —{' '}
          {outliers.map((o, i) => (
            <span key={o.rowKey}>
              {i > 0 && ', '}
              <span className="font-medium text-foreground">{o.label}</span> ({formatINRCompact(o.total)})
            </span>
          ))}{' '}
          {outliers.length === 1 ? 'runs' : 'run'} past it, marked ⫽; hover for exact figures.
        </p>
      )}
    </div>
  )
}
