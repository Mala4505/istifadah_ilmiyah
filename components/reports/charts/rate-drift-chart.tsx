'use client'

import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
} from 'recharts'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { CATEGORICAL_PALETTE } from '@/components/reports/charts/categorical-palette'
import { TooltipValueRow } from '@/components/reports/charts/tooltip-value-row'
import { useChartWidth } from '@/components/reports/charts/use-chart-width'

// reporting-blueprint.md C-05: "Same vendor, same item, price movement week
// by week." Two views of the same question (plan Phase 4):
//
// 1. SLOPE CHART — one line per shown vendor×item-family series, from its
//    first-week median to its latest-week median, on a common index (first
//    week = 100). Different ₹ magnitudes (₹40 cement vs ₹4,000 pipe) share one
//    axis honestly without a second scale (dataviz skill: never dual-axis);
//    the old multi-week spaghetti + ₹/index toggle is gone. Capped at
//    MAX_SERIES lines by |drift|; colours come from CATEGORICAL_PALETTE in
//    fixed order (never cycled). Right-end direct labels with leader lines,
//    nudged apart vertically so they never overlap; under ~480px they shrink
//    to the drift % and the legend carries identity.
// 2. RANKED DRIFT LIST — every series as a horizontal bar diverging around
//    0%, neutral ink, the direction carried by ↑/↓ and the sign (never colour
//    alone).
//
// The "View as table" twin keeps the raw ₹ median for every week.

export type RateDriftChartSeries = {
  key: string
  vendorName: string
  familyLabel: string
  driftPct: number | null
  points: { weekStart: string; medianRate: number }[]
}

const MAX_SERIES = 6
const FIRST = 'First week'
const LATEST = 'Latest week'
const LABEL_GAP = 14
const COMPACT_BELOW = 480

function weekLabel(weekStart: string): string {
  const d = new Date(weekStart)
  if (Number.isNaN(d.getTime())) return weekStart
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function signedPct(v: number): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}%`
}

/** Round-number ticks (step 1/2/5 × 10^k, ~`target` of them) inside
 *  [lo, hi] — so a padded domain doesn't produce ticks like −29% / +11%. */
function roundTicks(lo: number, hi: number, target = 5): number[] {
  const raw = (hi - lo) / Math.max(1, target - 1)
  if (!(raw > 0)) return [lo]
  const mag = 10 ** Math.floor(Math.log10(raw))
  const steps = [0.5, 1, 2, 5, 10].map((m) => m * mag)
  let si = steps.findIndex((st) => st >= raw)
  if (si === -1) si = steps.length - 1
  const build = (step: number) => {
    const ticks: number[] = []
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
    return ticks
  }
  // A padded domain can leave a rounded step with a single tick: step down.
  let ticks = build(steps[si]!)
  while (ticks.length < 3 && si > 0) ticks = build(steps[--si]!)
  return ticks
}

function arrowPct(v: number): string {
  return `${v > 0 ? '↑' : v < 0 ? '↓' : '→'} ${signedPct(v)}`
}

type Prepared = {
  slot: string
  series: RateDriftChartSeries
  first: { weekStart: string; medianRate: number }
  last: { weekStart: string; medianRate: number }
  latestIndex: number
  drift: number
}

function prepare(s: RateDriftChartSeries, slot: string): Prepared | null {
  const pts = [...s.points].sort((a, b) => a.weekStart.localeCompare(b.weekStart))
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (!first || !last || !(first.medianRate > 0)) return null
  const latestIndex = (last.medianRate / first.medianRate) * 100
  return { slot, series: s, first, last, latestIndex, drift: s.driftPct ?? latestIndex - 100 }
}

/**
 * Right-end labels for the slope chart. Reads the chart's own scales (Recharts
 * 3 hooks), places each label at its line's end, then nudges overlapping
 * labels apart (min LABEL_GAP px) and clamps them into the plot area. A short
 * leader line ties a nudged label back to its line end (dataviz skill: never
 * detach a nudged label from its mark).
 */
function SlopeEndLabels({ items, compact }: { items: Prepared[]; compact: boolean }) {
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  const plot = usePlotArea()
  if (!xScale || !yScale || !plot) return null
  const x = xScale(LATEST, { position: 'middle' })
  if (x == null) return null

  const placed = items
    .map((it) => {
      const y = yScale(it.latestIndex) ?? 0
      return { it, y, labelY: y }
    })
    .sort((a, b) => a.y - b.y)
  // Forward pass pushes labels down; backward pass pulls them back inside.
  const top = plot.y + 6
  const bottom = plot.y + plot.height - 6
  for (let i = 0; i < placed.length; i += 1) {
    const prev = placed[i - 1]
    placed[i]!.labelY = Math.max(placed[i]!.labelY, top, prev ? prev.labelY + LABEL_GAP : -Infinity)
  }
  for (let i = placed.length - 1; i >= 0; i -= 1) {
    const next = placed[i + 1]
    placed[i]!.labelY = Math.min(placed[i]!.labelY, bottom, next ? next.labelY - LABEL_GAP : Infinity)
  }

  return (
    <g>
      {placed.map(({ it, y, labelY }) => (
        <g key={it.slot}>
          <polyline
            points={`${x + 5},${y} ${x + 11},${labelY} ${x + 14},${labelY}`}
            fill="none"
            className="stroke-muted-foreground/60"
            strokeWidth={1}
          />
          <text x={x + 17} y={labelY} dominantBaseline="middle" fontSize={11} className="fill-foreground">
            {compact ? null : (
              <tspan className="fill-muted-foreground">
                {truncate(`${it.series.vendorName} · ${it.series.familyLabel}`, 24)}{' '}
              </tspan>
            )}
            <tspan className="font-medium">{signedPct(it.drift)}</tspan>
          </text>
        </g>
      ))}
    </g>
  )
}

type RankedRow = Prepared & { label: string }

export function RateDriftChart({ series }: { series: RateDriftChartSeries[] }) {
  const [showTable, setShowTable] = useState(false)
  const anim = useChartAnimation()
  const [wrapRef, width] = useChartWidth(640)
  const compact = width < COMPACT_BELOW

  const shown = useMemo(
    () =>
      [...series]
        .sort((a, b) => Math.abs(b.driftPct ?? 0) - Math.abs(a.driftPct ?? 0))
        .slice(0, MAX_SERIES)
        .map((s, i) => prepare(s, `s${i}`))
        .filter((p): p is Prepared => p != null),
    [series]
  )
  const ranked = useMemo<RankedRow[]>(
    () =>
      series
        .map((s, i) => prepare(s, `r${i}`))
        .filter((p): p is Prepared => p != null)
        .sort((a, b) => b.drift - a.drift)
        .map((p) => ({ ...p, label: `${p.series.vendorName} · ${p.series.familyLabel}` })),
    [series]
  )

  if (series.length === 0 || shown.length === 0) return null
  const hiddenCount = series.length - shown.length

  const slopeConfig: ChartConfig = Object.fromEntries(
    shown.map((p, i) => [p.slot, { label: `${p.series.vendorName} · ${p.series.familyLabel}`, theme: CATEGORICAL_PALETTE[i]!.hex }])
  )
  // Two rows (first week, latest week); per series: its index value plus the
  // raw ₹ median under `<slot>_raw` for the tooltip.
  const firstRow: Record<string, string | number> = { x: FIRST }
  const latestRow: Record<string, string | number> = { x: LATEST }
  for (const p of shown) {
    firstRow[p.slot] = 100
    firstRow[`${p.slot}_raw`] = p.first.medianRate
    latestRow[p.slot] = p.latestIndex
    latestRow[`${p.slot}_raw`] = p.last.medianRate
  }
  const slopeData = [firstRow, latestRow]

  const indices = [100, ...shown.map((p) => p.latestIndex)]
  const yMin = Math.floor(Math.min(...indices) / 10) * 10
  const yMax = Math.max(yMin + 10, Math.ceil(Math.max(...indices) / 10) * 10)
  const yTicks = roundTicks(yMin, yMax)

  // Diverging around 0, only as wide as the data needs on each side, plus
  // headroom so the "↑ +x%" end labels stay inside the plot.
  const lo = Math.min(0, ...ranked.map((r) => r.drift))
  const hi = Math.max(0, ...ranked.map((r) => r.drift))
  const span = hi - lo || 5
  // More headroom on a phone, where the end label is wide relative to the plot.
  const pad = span * (compact ? 1.3 : 0.35)
  const xDomain: [number, number] = [lo < 0 ? lo - pad : 0, hi > 0 ? hi + pad : 0]
  const rankedConfig = { drift: { label: 'Drift', theme: { light: '#898781', dark: '#a3a29d' } } } satisfies ChartConfig

  const tableColumns: DataTableColumn<{ vendor: string; family: string; week: string; medianRate: number }>[] = [
    { key: 'vendor', header: 'Vendor', render: (r) => r.vendor },
    { key: 'family', header: 'Item family', render: (r) => r.family },
    { key: 'week', header: 'Week of', render: (r) => weekLabel(r.week) },
    { key: 'rate', header: 'Median rate', align: 'right', render: (r) => formatINR(r.medianRate) },
  ]
  const tableRows = series.flatMap((s) =>
    s.points.map((p) => ({ vendor: s.vendorName, family: s.familyLabel, week: p.weekStart, medianRate: p.medianRate }))
  )

  return (
    <div ref={wrapRef} className="flex flex-col gap-4">
      <div
        role="img"
        aria-label={`Rate drift slope chart — ${formatNumber(shown.length)} vendor-item series with the largest movement, each a line from its first-week median to its latest-week median, indexed so the first week = 100. ${shown
          .map((p) => `${p.series.vendorName} · ${p.series.familyLabel} ${signedPct(p.drift)}`)
          .join('; ')}. See the table view below for exact values.`}
      >
        <ChartContainer config={slopeConfig} className="aspect-auto h-[260px] w-full">
          <LineChart data={slopeData} margin={{ top: 12, right: compact ? 64 : 200, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} padding={{ left: 24, right: 8 }} />
            <YAxis
              domain={[yMin, yMax]}
              ticks={yTicks}
              tickLine={false}
              axisLine={false}
              width={40}
              fontSize={11}
              allowDecimals={false}
            />
            <ReferenceLine y={100} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} strokeWidth={1} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => `${String(label)} · index (first week = 100)`}
                  formatter={(value, name, item) => {
                    const row = item.payload as Record<string, string | number> | undefined
                    return (
                      <TooltipValueRow
                        color={item.color}
                        label={slopeConfig[name]?.label ?? name}
                        value={`${formatINR(Number(row?.[`${name}_raw`]))} · ${(value as number).toFixed(0)}`}
                      />
                    )
                  }}
                />
              }
            />
            {shown.map((p) => (
              <Line
                key={p.slot}
                dataKey={p.slot}
                type="linear"
                stroke={`var(--color-${p.slot})`}
                strokeWidth={2}
                dot={{ r: 4, strokeWidth: 2, fill: `var(--color-${p.slot})`, stroke: 'hsl(var(--card))' }}
                activeDot={{ r: 5, strokeWidth: 2 }}
                {...anim}
              />
            ))}
            <SlopeEndLabels items={shown} compact={compact} />
          </LineChart>
        </ChartContainer>
      </div>

      {/* Legend: always present for ≥2 series (identity never colour alone). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {shown.map((p, i) => (
          <span key={p.slot} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-[2px] ${CATEGORICAL_PALETTE[i]!.bgClass}`} />
            {p.series.vendorName} · {p.series.familyLabel}
          </span>
        ))}
      </div>

      {hiddenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(shown.length)} series with the largest movement; {formatNumber(hiddenCount)} more{' '}
          {hiddenCount === 1 ? 'is' : 'are'} in the ranked list below and the table.
        </p>
      )}

      {ranked.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">Every pair, ranked by drift since its first week</p>
          <div role="img" aria-label={`Drift ranking — ${ranked.map((r) => `${r.label} ${signedPct(r.drift)}`).join('; ')}.`}>
            <ChartContainer config={rankedConfig} className="aspect-auto w-full" style={{ height: ranked.length * 28 + 32 }}>
              <BarChart data={ranked} layout="vertical" margin={{ top: 4, right: 64, bottom: 0, left: 0 }}>
                <CartesianGrid horizontal={false} />
                <XAxis
                  type="number"
                  domain={xDomain}
                  ticks={roundTicks(xDomain[0], xDomain[1])}
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}%`}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  width={compact ? 110 : 190}
                  fontSize={11}
                  tickFormatter={(v: string) => truncate(v, compact ? 16 : 30)}
                />
                <ReferenceLine x={0} stroke="hsl(var(--foreground))" strokeOpacity={0.4} strokeWidth={1} />
                <ChartTooltip
                  cursor={{ fillOpacity: 0.5 }}
                  content={
                    <ChartTooltipContent
                      hideIndicator
                      labelFormatter={(_, payload) => (payload?.[0]?.payload as RankedRow | undefined)?.label ?? null}
                      formatter={(_value, _name, item) => {
                        const r = item.payload as unknown as RankedRow
                        return (
                          <div className="grid w-full gap-1">
                            <TooltipValueRow color="var(--color-drift)" label="Drift" value={arrowPct(r.drift)} />
                            <TooltipValueRow
                              color="transparent"
                              label={`${weekLabel(r.first.weekStart)} → ${weekLabel(r.last.weekStart)}`}
                              value={`${formatINR(r.first.medianRate)} → ${formatINR(r.last.medianRate)}`}
                            />
                          </div>
                        )
                      }}
                    />
                  }
                />
                <Bar dataKey="drift" fill="var(--color-drift)" radius={4} maxBarSize={16} {...anim}>
                  <LabelList
                    dataKey="drift"
                    content={(props) => {
                      const v = Number(props.value)
                      const x = Number(props.x)
                      const w = Number(props.width)
                      const left = Math.min(x, x + w)
                      const right = Math.max(x, x + w)
                      const y = Number(props.y) + Number(props.height) / 2
                      return (
                        <text
                          x={v >= 0 ? right + 4 : left - 4}
                          y={y}
                          textAnchor={v >= 0 ? 'start' : 'end'}
                          dominantBaseline="middle"
                          fontSize={11}
                          className="fill-foreground"
                        >
                          {arrowPct(v)}
                        </text>
                      )
                    }}
                  />
                </Bar>
              </BarChart>
            </ChartContainer>
          </div>
        </div>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && (
        <DataTable columns={tableColumns} rows={tableRows} getRowKey={(r) => `${r.vendor}::${r.family}::${r.week}`} />
      )}
    </div>
  )
}
