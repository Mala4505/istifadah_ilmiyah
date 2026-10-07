'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, XAxis, YAxis } from 'recharts'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import {
  AXIS_TICK,
  BAR_PX,
  CategoryTick,
  GRID_STROKE,
  SERIES_BLUE,
  STATUS_CRITICAL,
  TooltipRow,
  barEndLabel,
  horizontalChartHeight,
  truncate,
  useCompactChart,
} from './recharts-kit'

// Duplicated from lib/reports/surfaces/vendor-dependency.ts rather than
// imported: that module imports '@/lib/supabase/server' (next/headers), so a
// runtime value import from it into this 'use client' chart would pull a
// server-only module graph into the client bundle -- Next.js fails the build
// the moment it hits next/headers there (same cross-boundary bug class the
// vendor-scorecard-grid.tsx chart hit and fixed the same way; a type-only
// import is fine here, only a *value* import breaks the bundle). Keep this in
// sync with DEPARTMENT_DEPENDENCY_THRESHOLD_PCT in that file if it ever changes.
const DEPARTMENT_DEPENDENCY_THRESHOLD_PCT = 50

// reporting-blueprint.md B-03: "Which departments rely on a single vendor for
// more than half their spend. Single-source risk, named." One horizontal
// bar per department — bar length = its top vendor's share of that
// department's total spend — with a ReferenceLine at 50%. Departments past
// the line get the reserved critical-status colour PLUS a warning glyph and
// an inline "single-source" label (§6 fix #5: status colour is never the
// sole signal, and never reused elsewhere on this chart as a plain series
// hue), so the finding survives print and colour-blind viewing on raw bar
// length and label text alone.
//
// shadcn chart (Recharts 3), vertical layout: height grows with row count so
// long lists never squash; department names are focusable drill links on the
// category axis; a required "View as table" twin keeps every value as text.

export type DepartmentDependencyBar = {
  key: number
  departmentLabel: string
  departmentHref?: string
  topVendorLabel: string
  topVendorHref?: string
  sharePct: number
  topVendorSpend: number
  departmentTotalSpend: number
  vendorCount: number
}

const MAX_ROWS = 12

const chartConfig = {
  share: { label: 'Under 50%', theme: SERIES_BLUE },
  over: { label: 'Over 50% — single-source risk', theme: STATUS_CRITICAL },
} satisfies ChartConfig

function overThreshold(sharePct: number): boolean {
  return sharePct > DEPARTMENT_DEPENDENCY_THRESHOLD_PCT
}

export function DepartmentDependencyChart({
  bars,
  tableTwin = true,
}: {
  bars: DepartmentDependencyBar[]
  /** false when the host section already renders these rows as a table. */
  tableTwin?: boolean
}) {
  const [showTable, setShowTable] = useState(false)
  const router = useRouter()
  const anim = useChartAnimation()
  const [wrapRef, compact] = useCompactChart()

  if (bars.length === 0) return null

  const sorted = [...bars].sort((a, b) => b.sharePct - a.sharePct)
  const rows = sorted.slice(0, MAX_ROWS)
  const hiddenCount = sorted.length - rows.length
  const hiddenOverThresholdCount = sorted.slice(MAX_ROWS).filter((r) => overThreshold(r.sharePct)).length

  const data = rows.map((r) => ({ ...r, rowKey: String(r.key), share: Math.max(0, Math.min(100, r.sharePct)) }))
  const byKey = new Map(data.map((d) => [d.rowKey, d]))

  const tableColumns: DataTableColumn<DepartmentDependencyBar>[] = [
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.departmentHref ? (
          <Link href={r.departmentHref} className="text-primary underline-offset-2 hover:underline">
            {r.departmentLabel}
          </Link>
        ) : (
          r.departmentLabel
        ),
    },
    {
      key: 'vendor',
      header: 'Top vendor',
      render: (r) =>
        r.topVendorHref ? (
          <Link href={r.topVendorHref} className="text-primary underline-offset-2 hover:underline">
            {r.topVendorLabel}
          </Link>
        ) : (
          r.topVendorLabel
        ),
    },
    { key: 'share', header: 'Share of dept. spend', align: 'right', render: (r) => formatPercent(r.sharePct) },
    { key: 'vendorSpend', header: 'Top vendor spend', align: 'right', render: (r) => formatINR(r.topVendorSpend) },
    { key: 'deptSpend', header: 'Department total', align: 'right', render: (r) => formatINR(r.departmentTotalSpend) },
    { key: 'vendorCount', header: 'Vendors used', align: 'right', render: (r) => formatNumber(r.vendorCount) },
  ]

  const EndLabel = barEndLabel((i) => {
    const row = data[i]
    if (!row) return null
    const isOver = overThreshold(row.sharePct)
    return (
      <>
        {isOver && <path d="M5 -5 L10.5 5 L-0.5 5 Z" className="fill-red-600 dark:fill-red-500" aria-hidden="true" />}
        <text x={isOver ? 15 : 0} dy={4} fontSize={11} className="fill-muted-foreground">
          <title>{`${row.topVendorLabel} · ${formatPercent(row.sharePct)}${isOver ? ' — single-source risk' : ''}`}</title>
          {compact ? formatPercent(row.sharePct) : `${truncate(row.topVendorLabel, 14)} · ${formatPercent(row.sharePct)}`}
        </text>
      </>
    )
  })

  return (
    <div ref={wrapRef} className="flex flex-col gap-3">
      <ChartContainer
        config={chartConfig}
        className="aspect-auto w-full"
        style={{ height: horizontalChartHeight(data.length, 48) }}
        role="img"
        aria-label={`Department dependency — one bar per department, length is its top vendor's share of that department's spend. ${formatNumber(
          rows.filter((r) => overThreshold(r.sharePct)).length
        )} of ${formatNumber(rows.length)} shown are past the 50% single-source threshold. See the table view below for exact values.`}
      >
        <BarChart data={data} layout="vertical" margin={{ top: 18, right: compact ? 56 : 156, bottom: 4, left: 0 }} barSize={BAR_PX}>
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            label={{ value: 'Top vendor’s share of department spend', position: 'insideBottom', offset: 0, fontSize: 11, fill: AXIS_TICK.fill }}
            height={40}
          />
          <YAxis
            type="category"
            dataKey="rowKey"
            width={compact ? 112 : 160}
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={
              <CategoryTick
                maxChars={compact ? 14 : 22}
                lookup={(k) => {
                  const r = byKey.get(k)
                  return r ? { label: r.departmentLabel, href: r.departmentHref } : undefined
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
                  const r = payload[0]?.payload as (typeof data)[number] | undefined
                  return r ? (
                    <div>
                      <p>{r.departmentLabel}</p>
                      <p className="font-normal text-muted-foreground">{r.topVendorLabel}</p>
                    </div>
                  ) : null
                }}
                formatter={(_v, _n, item) => {
                  const r = item.payload as (typeof data)[number] | undefined
                  if (!r) return null
                  return (
                    <div className="grid w-full gap-1.5">
                      <TooltipRow
                        color={overThreshold(r.sharePct) ? 'var(--color-over)' : 'var(--color-share)'}
                        name="Share of dept. spend"
                        value={formatPercent(r.sharePct)}
                      />
                      <TooltipRow name="Top vendor spend" value={formatINRCompact(r.topVendorSpend)} />
                      <TooltipRow name="Department total" value={formatINRCompact(r.departmentTotalSpend)} />
                      {overThreshold(r.sharePct) && (
                        <p className="font-medium text-red-700 dark:text-red-400">Single-source risk</p>
                      )}
                    </div>
                  )
                }}
              />
            }
          />
          <ReferenceLine
            x={DEPARTMENT_DEPENDENCY_THRESHOLD_PCT}
            stroke="hsl(var(--foreground) / 0.6)"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            label={{ value: '50%', position: 'top', fontSize: 11, className: 'fill-foreground font-medium' }}
          />
          <Bar
            dataKey="share"
            name="share"
            radius={[0, 4, 4, 0]}
            minPointSize={2}
            className={data.some((d) => d.departmentHref) ? 'cursor-pointer' : undefined}
            onClick={(entry) => {
              const href = (entry.payload as (typeof data)[number] | undefined)?.departmentHref
              if (href) router.push(href)
            }}
            {...anim}
          >
            {data.map((d) => (
              <Cell key={d.rowKey} fill={overThreshold(d.sharePct) ? 'var(--color-over)' : 'var(--color-share)'} />
            ))}
            <LabelList dataKey="share" content={EndLabel} />
          </Bar>
        </BarChart>
      </ChartContainer>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-red-600 dark:bg-red-500" aria-hidden="true" />
          <svg width={10} height={10} aria-hidden="true">
            <path d="M5 0 L10 10 L0 10 Z" className="fill-red-600 dark:fill-red-500" />
          </svg>
          Over 50% — single-source risk
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#2a78d6] dark:bg-[#3987e5]" aria-hidden="true" />
          Under 50%
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={14} height={10} aria-hidden="true">
            <line x1={7} y1={0} x2={7} y2={10} className="stroke-foreground/60" strokeWidth={1.5} strokeDasharray="3 2" />
          </svg>
          50% reference
        </span>
      </div>

      {(hiddenCount > 0 || hiddenOverThresholdCount > 0) && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(rows.length)} departments with the highest single-vendor share;{' '}
          {formatNumber(hiddenCount)} more {hiddenCount === 1 ? 'is' : 'are'} in the table
          {hiddenOverThresholdCount > 0 &&
            ` (${formatNumber(hiddenOverThresholdCount)} also past the 50% threshold)`}
          .
        </p>
      )}

      {tableTwin && (
        <>
          <div>
            <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Hide table' : 'View as table'}
            </Button>
          </div>
          {showTable && <DataTable columns={tableColumns} rows={sorted} getRowKey={(r) => r.key} />}
        </>
      )}
    </div>
  )
}
