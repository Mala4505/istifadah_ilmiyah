'use client'

import { useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import type { ConcentrationPoint } from '@/lib/reports/sections/shared'

// reporting-blueprint.md B-01 (flagship): "Cumulative share of spend as vendors
// are added, ranked. Deliberately NOT a classic Pareto — two scales on one
// chart is the single most common way a finance chart misleads." So: one axis
// (cumulative % up the side, fixed 0–100%), one line (the curve), one dashed
// reference line (where the curve would sit if every vendor took an equal
// share). The gap between the two IS the concentration.
//
// Recharts (shadcn chart) since the 2026-10-07 direction change; the "View as
// table" twin keeps every value reachable without hover (dataviz skill:
// tooltips enhance, never gate).

const chartConfig = {
  cumulative: { label: 'Cumulative share of spend', theme: { light: '#2a78d6', dark: '#3987e5' } },
  equal: { label: 'If every vendor took an equal share', theme: { light: '#898781', dark: '#898781' } },
} satisfies ChartConfig

type CurveDatum = {
  rank: number
  cumulative: number
  equal: number
  point: ConcentrationPoint | null
}

function ConcentrationTooltip({ active, payload }: { active?: boolean; payload?: readonly { payload?: CurveDatum }[] }) {
  const d = payload?.[0]?.payload
  if (!active || !d?.point) return null
  const p = d.point
  return (
    <div className="grid min-w-[11rem] gap-1 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <p className="font-medium text-foreground">
        #{p.rank} · {p.vendorName}
      </p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Top {p.rank} carry</span>
        <span className="font-mono font-medium tabular-nums text-foreground">{formatPercent(p.cumulativeSharePct)}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">This vendor</span>
        <span className="font-mono font-medium tabular-nums text-foreground">
          {formatINRCompact(p.spend)} · {formatPercent(p.sharePct)}
        </span>
      </div>
    </div>
  )
}

export function ConcentrationCurveChart({ points }: { points: ConcentrationPoint[] }) {
  const [showTable, setShowTable] = useState(false)
  const anim = useChartAnimation()

  if (points.length === 0) return null

  const n = points.length
  // Anchored at the origin (0 vendors, 0% of spend), then one point per vendor.
  const data: CurveDatum[] = [
    { rank: 0, cumulative: 0, equal: 0, point: null },
    ...points.map((p) => ({ rank: p.rank, cumulative: p.cumulativeSharePct, equal: (p.rank / n) * 100, point: p })),
  ]

  const tableColumns: DataTableColumn<ConcentrationPoint>[] = [
    { key: 'rank', header: '#', align: 'right', render: (p) => formatNumber(p.rank) },
    { key: 'vendor', header: 'Vendor', render: (p) => p.vendorName },
    { key: 'spend', header: 'Spend', align: 'right', render: (p) => formatINRCompact(p.spend) },
    { key: 'share', header: 'Share', align: 'right', render: (p) => formatPercent(p.sharePct) },
    { key: 'cumulative', header: 'Cumulative share', align: 'right', render: (p) => formatPercent(p.cumulativeSharePct) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label="Vendor concentration curve — cumulative share of spend as vendors are added, ranked largest first; see the table view below for exact values"
      >
        <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full">
          <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="rank"
              type="number"
              domain={[0, n]}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={24}
              fontSize={11}
              tickFormatter={(v: number) => formatNumber(v)}
              height={40}
              label={{ value: 'Vendors, largest spend first', position: 'insideBottom', offset: 0, fontSize: 11, className: 'fill-muted-foreground' }}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickLine={false}
              axisLine={false}
              width={44}
              fontSize={11}
              tickFormatter={(v: number) => formatPercent(v)}
            />
            <ChartTooltip cursor={{ strokeWidth: 1 }} content={<ConcentrationTooltip />} />
            {/* Even-spend reference — dashed, muted (the legitimate dash use). */}
            <Line
              dataKey="equal"
              type="linear"
              stroke="var(--color-equal)"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              activeDot={false}
              {...anim}
            />
            <Area
              dataKey="cumulative"
              type="linear"
              stroke="var(--color-cumulative)"
              strokeWidth={2}
              fill="var(--color-cumulative)"
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2 }}
              {...anim}
            />
          </ComposedChart>
        </ChartContainer>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={14} height={4} aria-hidden="true">
            <line x1={0} y1={2} x2={14} y2={2} className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} />
          </svg>
          {chartConfig.cumulative.label}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={14} height={4} aria-hidden="true">
            <line x1={0} y1={2} x2={14} y2={2} className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="3 2" />
          </svg>
          {chartConfig.equal.label}
        </span>
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={points} getRowKey={(p) => p.vendorId} />}
    </div>
  )
}
