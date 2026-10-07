'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts'
import { formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import {
  AXIS_TICK,
  BAR_PX,
  CategoryTick,
  GRID_STROKE,
  SERIES_BLUE,
  TooltipRow,
  barEndLabel,
  horizontalChartHeight,
  truncate,
  useCompactChart,
} from './recharts-kit'

// reporting-blueprint.md B-04: "Vendors serving exactly one department,
// especially at high value. Not wrong in itself — but it is where a
// relationship, rather than a market, is setting the price." One horizontal
// bar per single-department vendor, ranked by spend, each labelled at its end
// with the one department it serves. One accent hue throughout — this isn't a
// good/bad finding the way B-03's threshold is, so it gets the plain series
// colour rather than the reserved status palette.
//
// shadcn chart (Recharts 3), vertical layout: height grows with row count;
// vendor names are focusable drill links on the category axis (a click on the
// bar goes to the same place); required "View as table" twin.

export type VendorExclusivityBar = {
  key: number
  vendorLabel: string
  vendorHref?: string
  departmentLabel: string
  departmentHref?: string
  spend: number
}

const MAX_ROWS = 12

const chartConfig = {
  spend: { label: 'Total spend', theme: SERIES_BLUE },
} satisfies ChartConfig

export function VendorExclusivityChart({ bars }: { bars: VendorExclusivityBar[] }) {
  const [showTable, setShowTable] = useState(false)
  const router = useRouter()
  const anim = useChartAnimation()
  const [wrapRef, compact] = useCompactChart()

  if (bars.length === 0) return null

  const sorted = [...bars].sort((a, b) => b.spend - a.spend)
  const rows = sorted.slice(0, MAX_ROWS)
  const hiddenCount = sorted.length - rows.length

  const data = rows.map((r) => ({ ...r, rowKey: String(r.key) }))
  const byKey = new Map(data.map((d) => [d.rowKey, d]))

  const tableColumns: DataTableColumn<VendorExclusivityBar>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendorHref ? (
          <Link href={r.vendorHref} className="text-primary underline-offset-2 hover:underline">
            {r.vendorLabel}
          </Link>
        ) : (
          r.vendorLabel
        ),
    },
    {
      key: 'department',
      header: 'Sole department',
      render: (r) =>
        r.departmentHref ? (
          <Link href={r.departmentHref} className="text-primary underline-offset-2 hover:underline">
            {r.departmentLabel}
          </Link>
        ) : (
          r.departmentLabel
        ),
    },
    { key: 'spend', header: 'Total spend', align: 'right', render: (r) => formatINR(r.spend) },
  ]

  const EndLabel = barEndLabel((i) => {
    const row = data[i]
    if (!row) return null
    return (
      <text dy={4} fontSize={11} className="fill-muted-foreground">
        <title>{row.departmentLabel}</title>
        {truncate(row.departmentLabel, compact ? 10 : 20)}
      </text>
    )
  })

  return (
    <div ref={wrapRef} className="flex flex-col gap-3">
      <ChartContainer
        config={chartConfig}
        className="aspect-auto w-full"
        style={{ height: horizontalChartHeight(data.length, 28) }}
        role="img"
        aria-label="Vendor exclusivity — vendors serving exactly one department, ranked by spend, each bar labelled with its sole department. See the table view below for exact values."
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: compact ? 72 : 132, bottom: 0, left: 0 }}
          barSize={BAR_PX}
        >
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            tickFormatter={(v: number) => formatINRCompact(v)}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            tickCount={compact ? 3 : 5}
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
                  return r ? { label: r.vendorLabel, href: r.vendorHref } : undefined
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
                      <p>{r.vendorLabel}</p>
                      <p className="font-normal text-muted-foreground">Sole department: {r.departmentLabel}</p>
                    </div>
                  ) : null
                }}
                formatter={(value) => (
                  <TooltipRow color="var(--color-spend)" name="Total spend" value={formatINRCompact(Number(value))} />
                )}
              />
            }
          />
          <Bar
            dataKey="spend"
            name="spend"
            fill="var(--color-spend)"
            radius={[0, 4, 4, 0]}
            minPointSize={2}
            className={data.some((d) => d.vendorHref) ? 'cursor-pointer' : undefined}
            onClick={(entry) => {
              const href = (entry.payload as (typeof data)[number] | undefined)?.vendorHref
              if (href) router.push(href)
            }}
            {...anim}
          >
            <LabelList dataKey="spend" content={EndLabel} />
          </Bar>
        </BarChart>
      </ChartContainer>

      {hiddenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(rows.length)} highest-spend single-department vendors; {formatNumber(hiddenCount)} more{' '}
          {hiddenCount === 1 ? 'is' : 'are'} in the table.
        </p>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={sorted} getRowKey={(r) => r.key} />}
    </div>
  )
}
