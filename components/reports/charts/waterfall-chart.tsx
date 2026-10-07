'use client'

import { useState } from 'react'
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from 'recharts'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, useChartAnimation, type ChartConfig } from '@/components/ui/chart'
import { ORDINAL_RAMP } from './ordinal-ramp'
import {
  CategoryTick,
  stackedSegmentShape,
  TooltipRow,
  barEndLabel,
  horizontalChartHeight,
  useCompactChart,
} from './recharts-kit'

// reporting-blueprint.md D-02 — amount-at-risk waterfall. "Total spend →
// flagged → confirmed → recovered or dismissed. The value the review function
// actually delivered, in one figure." A horizontal, left-anchored run of
// descending ₹ stages on one shared ₹ scale. Each stage is a stacked bar: its
// own amount in ORDINAL_RAMP (position in a fixed sequence, one hue, monotone
// steps — never a per-stage hue) plus a pale "fell away" segment reaching
// back up to the prior stage's level, so the drop between consecutive stages
// is visible as a gap in the staircase and spelled out in the bar-end label.
// Also reused by budget-revision-history, where a stage can go UP — then
// there is no fall-away segment and the label reads "+₹X".
//
// shadcn chart (Recharts 3). Every figure is on the face of the chart as text;
// the "View as table" twin adds the % of prior stage.

export type WaterfallStage = {
  key: string
  label: string
  amount: number
  /** null for stages with no meaningful item count (e.g. total spend). */
  count: number | null
}

const chartConfig = {
  ...Object.fromEntries(ORDINAL_RAMP.map((step, i) => [`s${i}`, { label: `Stage ${i + 1}`, theme: step.hex }])),
  drop: { label: 'Fell away from the prior stage', theme: { light: '#d9d6d0', dark: '#3b3836' } },
} satisfies ChartConfig

export function WaterfallChart({
  stages,
  tableTwin = true,
}: {
  stages: WaterfallStage[]
  /** false when the host section already renders the stages as a table. */
  tableTwin?: boolean
}) {
  const [showTable, setShowTable] = useState(false)
  const anim = useChartAnimation()
  const [wrapRef, compact] = useCompactChart()

  if (stages.length === 0) return null

  const data = stages.map((stage, i) => {
    const prev = i > 0 ? stages[i - 1]! : null
    const delta = prev ? stage.amount - prev.amount : null
    return {
      ...stage,
      amountBar: Math.max(0, stage.amount),
      drop: delta != null && delta < 0 ? -delta : 0,
      delta,
      prevLabel: prev?.label ?? null,
      fillKey: `s${Math.min(i, ORDINAL_RAMP.length - 1)}`,
    }
  })
  const byKey = new Map(data.map((d) => [d.key, d]))

  const tableRows = stages.map((stage, i) => {
    const prev = i > 0 ? stages[i - 1]! : null
    return {
      ...stage,
      pctOfPrior: prev && prev.amount > 0 ? (stage.amount / prev.amount) * 100 : null,
    }
  })
  type TableRow = (typeof tableRows)[number]

  const tableColumns: DataTableColumn<TableRow>[] = [
    { key: 'stage', header: 'Stage', render: (s) => s.label },
    { key: 'amount', header: '₹', align: 'right', render: (s) => formatINR(s.amount) },
    { key: 'count', header: 'Count', align: 'right', render: (s) => (s.count == null ? '—' : formatNumber(s.count)) },
    {
      key: 'pct',
      header: '% of prior stage',
      align: 'right',
      render: (s) => (s.pctOfPrior == null ? '—' : formatPercent(s.pctOfPrior)),
    },
  ]

  // Data end rounds on whichever segment ends the row: the fall-away segment
  // when there is one, else the stage amount itself.
  const amountShape = stackedSegmentShape((p) => !((p as { drop?: number } | undefined)?.drop ?? 0), false)
  const dropShape = stackedSegmentShape(() => true, false)

  // Labelled once, at the end of the whole stack (after the fall-away segment).
  const EndLabel = barEndLabel((i) => {
    const d = data[i]
    if (!d) return null
    return (
      <text dy={4} fontSize={11}>
        <tspan className="fill-foreground font-medium">{formatINRCompact(d.amount)}</tspan>
        {!compact && d.count != null && (
          <tspan className="fill-muted-foreground">{` · ${formatNumber(d.count)} ${d.count === 1 ? 'item' : 'items'}`}</tspan>
        )}
        {d.delta != null && d.delta !== 0 && (
          <tspan className="fill-muted-foreground">
            {` · ${d.delta < 0 ? '−' : '+'}${formatINRCompact(Math.abs(d.delta))}`}
          </tspan>
        )}
      </text>
    )
  })

  return (
    <div ref={wrapRef} className="flex flex-col gap-3">
      <ChartContainer
        config={chartConfig}
        className="aspect-auto w-full"
        style={{ height: horizontalChartHeight(data.length, 8) }}
        role="img"
        aria-label={`Amount-at-risk waterfall — ${stages
          .map((s) => `${s.label} ${formatINRCompact(s.amount)}`)
          .join(', ')}. See the table view below for exact values.`}
      >
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: compact ? 120 : 200, bottom: 4, left: 0 }}
          barSize={22}
        >
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis
            type="category"
            dataKey="key"
            width={compact ? 104 : 160}
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={
              <CategoryTick
                maxChars={compact ? 14 : 24}
                lookup={(k) => {
                  const d = byKey.get(k)
                  return d ? { label: d.label } : undefined
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
                formatter={(_v, name, item) => {
                  // One summary per stage, not one line per stacked segment.
                  if (name !== 'amountBar') return null
                  const d = item.payload as (typeof data)[number] | undefined
                  if (!d) return null
                  return (
                    <div className="grid w-full gap-1.5">
                      <TooltipRow color={`var(--color-${d.fillKey})`} name="Amount" value={formatINRCompact(d.amount)} />
                      {d.count != null && <TooltipRow name="Items" value={formatNumber(d.count)} />}
                      {d.delta != null && d.delta !== 0 && d.prevLabel && (
                        <TooltipRow
                          color={d.delta < 0 ? 'var(--color-drop)' : undefined}
                          name={`${d.delta < 0 ? 'Down' : 'Up'} from ${d.prevLabel.toLowerCase()}`}
                          value={formatINRCompact(Math.abs(d.delta))}
                        />
                      )}
                    </div>
                  )
                }}
              />
            }
          />
          <Bar dataKey="amountBar" name="amountBar" stackId="w" minPointSize={2} shape={amountShape} {...anim}>
            {data.map((d) => (
              <Cell key={d.key} fill={`var(--color-${d.fillKey})`} />
            ))}
          </Bar>
          <Bar dataKey="drop" name="drop" stackId="w" fill="var(--color-drop)" shape={dropShape} {...anim}>
            <LabelList dataKey="drop" content={EndLabel} />
          </Bar>
        </BarChart>
      </ChartContainer>

      {data.some((d) => d.drop > 0) && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-[#2a78d6] dark:bg-[#256abf]" aria-hidden="true" />
            Stage amount (darker = later stage)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-[#d9d6d0] dark:bg-[#3b3836]" aria-hidden="true" />
            Fell away from the prior stage
          </span>
        </div>
      )}

      {tableTwin && (
        <>
          <div>
            <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Hide table' : 'View as table'}
            </Button>
          </div>
          {showTable && <DataTable columns={tableColumns} rows={tableRows} getRowKey={(s) => s.key} />}
        </>
      )}
    </div>
  )
}
