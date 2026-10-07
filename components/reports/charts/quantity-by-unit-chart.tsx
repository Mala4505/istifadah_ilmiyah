'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts'
import { formatNumber } from '@/lib/reports/format'
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
  useCompactChart,
} from './recharts-kit'

// reporting-blueprint.md C-07: "Not rupees — sqft, nos, days. Consumption in
// physical terms." Units are NOT comparable across each other (a sqft total
// and a nos total can never share one axis, per §6 fix #8's "never two scales
// on one chart" — the risk here isn't two axes on one chart, it's one axis
// silently mixing two units), so this draws small multiples: one horizontal
// Recharts BarChart PER unit, each with its own independent scale, stacked
// vertically. Families are ranked by quantity within their own unit group
// only — a family that shows up under two units (e.g. bought in both sqft and
// nos) gets one bar in each group, which is correct: they are two different
// physical facts.
//
// One accent hue for every bar (a volume ranking, not a status signal — §6
// fix #5's reserved colours don't apply here). Family names are focusable
// drill links; required "View as table" twin.

export type QuantityByUnitBar = {
  key: string
  unit: string
  familyLabel: string
  familyHref?: string
  totalQuantity: number
  observationCount: number
  vendorCount: number
  entryCount: number
}

const MAX_UNITS = 6
const MAX_FAMILIES_PER_UNIT = 6

const chartConfig = {
  totalQuantity: { label: 'Total quantity', theme: SERIES_BLUE },
} satisfies ChartConfig

type Group = {
  unit: string
  bars: QuantityByUnitBar[]
  hiddenCount: number
}

function buildGroups(bars: QuantityByUnitBar[]): { groups: Group[]; hiddenUnitCount: number } {
  const byUnit = new Map<string, QuantityByUnitBar[]>()
  for (const b of bars) {
    const list = byUnit.get(b.unit) ?? []
    list.push(b)
    byUnit.set(b.unit, list)
  }
  const allUnits = [...byUnit.entries()]
    .map(([unit, list]) => ({ unit, list: [...list].sort((a, c) => c.totalQuantity - a.totalQuantity) }))
    .sort((a, c) => c.list.reduce((s, b) => s + b.totalQuantity, 0) - a.list.reduce((s, b) => s + b.totalQuantity, 0))
  const shownUnits = allUnits.slice(0, MAX_UNITS)
  const groups: Group[] = shownUnits.map(({ unit, list }) => {
    const shown = list.slice(0, MAX_FAMILIES_PER_UNIT)
    return { unit, bars: shown, hiddenCount: list.length - shown.length }
  })
  return { groups, hiddenUnitCount: allUnits.length - shownUnits.length }
}

function UnitMultiple({ group, compact }: { group: Group; compact: boolean }) {
  const router = useRouter()
  const anim = useChartAnimation()
  const unitLabel = group.unit || 'No unit recorded'
  const byKey = new Map(group.bars.map((b) => [b.key, b]))

  const EndLabel = barEndLabel((i) => {
    const row = group.bars[i]
    return row ? (
      <text dy={4} fontSize={11} className="fill-muted-foreground">
        {formatNumber(row.totalQuantity)}
      </text>
    ) : null
  })

  return (
    <div className="flex flex-col gap-1">
      <p className="border-b border-border pb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground">
        {unitLabel}
        {group.hiddenCount > 0 && (
          <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground">
            +{formatNumber(group.hiddenCount)} more in the table
          </span>
        )}
      </p>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto w-full"
        style={{ height: horizontalChartHeight(group.bars.length, 26) }}
        role="img"
        aria-label={`${unitLabel}: ${group.bars
          .map((b) => `${b.familyLabel} ${formatNumber(b.totalQuantity)}`)
          .join(', ')}.`}
      >
        <BarChart
          data={group.bars}
          layout="vertical"
          margin={{ top: 4, right: compact ? 56 : 72, bottom: 0, left: 0 }}
          barSize={BAR_PX}
        >
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            allowDecimals={false}
            tickFormatter={(v: number) => formatNumber(v)}
            tickLine={false}
            axisLine={false}
            tick={AXIS_TICK}
            tickCount={compact ? 3 : 5}
          />
          <YAxis
            type="category"
            dataKey="key"
            width={compact ? 104 : 150}
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={
              <CategoryTick
                maxChars={compact ? 14 : 20}
                lookup={(k) => {
                  const b = byKey.get(k)
                  return b ? { label: b.familyLabel, href: b.familyHref } : undefined
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
                  const b = payload[0]?.payload as QuantityByUnitBar | undefined
                  return b ? (
                    <div>
                      <p>{b.familyLabel}</p>
                      <p className="font-normal text-muted-foreground">{unitLabel}</p>
                    </div>
                  ) : null
                }}
                formatter={(_v, _n, item) => {
                  const b = item.payload as QuantityByUnitBar | undefined
                  if (!b) return null
                  return (
                    <div className="grid w-full gap-1.5">
                      <TooltipRow color="var(--color-totalQuantity)" name="Total quantity" value={formatNumber(b.totalQuantity)} />
                      <TooltipRow name="Observations" value={formatNumber(b.observationCount)} />
                      <TooltipRow name="Vendors" value={formatNumber(b.vendorCount)} />
                    </div>
                  )
                }}
              />
            }
          />
          <Bar
            dataKey="totalQuantity"
            name="totalQuantity"
            fill="var(--color-totalQuantity)"
            radius={[0, 4, 4, 0]}
            minPointSize={2}
            className={group.bars.some((b) => b.familyHref) ? 'cursor-pointer' : undefined}
            onClick={(entry) => {
              const href = (entry.payload as QuantityByUnitBar | undefined)?.familyHref
              if (href) router.push(href)
            }}
            {...anim}
          >
            <LabelList dataKey="totalQuantity" content={EndLabel} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  )
}

export function QuantityByUnitChart({
  bars,
  tableTwin = true,
}: {
  bars: QuantityByUnitBar[]
  /** false when the host section already renders these rows as a table. */
  tableTwin?: boolean
}) {
  const [showTable, setShowTable] = useState(false)
  const [wrapRef, compact] = useCompactChart()

  const { groups, hiddenUnitCount } = useMemo(() => buildGroups(bars), [bars])

  if (groups.length === 0) return null

  const tableColumns: DataTableColumn<QuantityByUnitBar>[] = [
    {
      key: 'family',
      header: 'Item family',
      render: (b) =>
        b.familyHref ? (
          <Link href={b.familyHref} className="text-primary underline-offset-2 hover:underline">
            {b.familyLabel}
          </Link>
        ) : (
          b.familyLabel
        ),
    },
    { key: 'unit', header: 'Unit', render: (b) => b.unit },
    { key: 'qty', header: 'Total quantity', align: 'right', render: (b) => formatNumber(b.totalQuantity) },
    { key: 'obs', header: 'Observations', align: 'right', render: (b) => formatNumber(b.observationCount) },
    { key: 'vendors', header: 'Vendors', align: 'right', render: (b) => formatNumber(b.vendorCount) },
    { key: 'entries', header: 'Entries', align: 'right', render: (b) => formatNumber(b.entryCount) },
  ]
  const tableRows = [...bars].sort((a, c) => a.unit.localeCompare(c.unit) || c.totalQuantity - a.totalQuantity)

  return (
    <div ref={wrapRef} className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-4"
        role="group"
        aria-label={`Quantity purchased by unit — one mini bar-chart per unit of measure, each on its own scale since units aren't comparable to each other. ${formatNumber(
          groups.length
        )} units shown, families ranked by quantity within each. See the table view below for exact values.`}
      >
        {groups.map((g) => (
          <UnitMultiple key={g.unit} group={g} compact={compact} />
        ))}
      </div>

      {hiddenUnitCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(groups.length)} units with the most total quantity; {formatNumber(hiddenUnitCount)} more{' '}
          {hiddenUnitCount === 1 ? 'is' : 'are'} in the table.
        </p>
      )}

      {tableTwin && (
        <>
          <div>
            <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Hide table' : 'View as table'}
            </Button>
          </div>
          {showTable && <DataTable columns={tableColumns} rows={tableRows} getRowKey={(b) => b.key} />}
        </>
      )}
    </div>
  )
}
