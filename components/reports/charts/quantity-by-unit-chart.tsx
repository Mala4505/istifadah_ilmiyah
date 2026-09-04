'use client'

import { useMemo, useState, type PointerEvent, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md C-07: "Not rupees — sqft, nos, days. Consumption in
// physical terms." Units are NOT comparable across each other (a sqft total
// and a nos total can never share one axis, per §6 fix #8's "never two scales
// on one chart" — the risk here isn't two axes on one chart, it's one axis
// silently mixing two units), so this draws one horizontal-bar mini-chart PER
// unit, each with its own independent scale, stacked vertically. Families are
// ranked by quantity within their own unit group only — a family that shows
// up under two units (e.g. bought in both sqft and nos) gets one bar in each
// group, which is correct: they are two different physical facts.
//
// Structurally mirrors department-dependency-chart.tsx: inline SVG with real
// numeric attributes for every data-driven mark, a pointer-move row lookup,
// arrow-key navigation across every bar (flattened across groups), an SVG
// <title> per bar as a no-JS fallback, and a required "View as table" twin.
// One accent hue for every bar (this is a volume ranking, not a status
// signal — §6 fix #5's reserved colours don't apply here).

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

const VIEW_WIDTH = 600
const ROW_HEIGHT = 28
const BAR_HEIGHT = 13
const GROUP_HEADER_HEIGHT = 22
const GROUP_GAP = 8
const MAX_UNITS = 6
const MAX_FAMILIES_PER_UNIT = 6
const PAD = { left: 150, right: 16, top: 6, bottom: 6 }
const BAR_COLOR = 'fill-[#2a78d6] dark:fill-[#3987e5]'

type Group = {
  unit: string
  bars: QuantityByUnitBar[]
  hiddenCount: number
  maxQuantity: number
}

function buildGroups(bars: QuantityByUnitBar[]): { groups: Group[]; hiddenUnitCount: number } {
  const byUnit = new Map<string, QuantityByUnitBar[]>()
  for (const b of bars) {
    const list = byUnit.get(b.unit) ?? []
    list.push(b)
    byUnit.set(b.unit, list)
  }
  const allUnits = [...byUnit.entries()]
    .map(([unit, list]) => ({ unit, list: list.sort((a, c) => c.totalQuantity - a.totalQuantity) }))
    .sort((a, c) => c.list.reduce((s, b) => s + b.totalQuantity, 0) - a.list.reduce((s, b) => s + b.totalQuantity, 0))
  const shownUnits = allUnits.slice(0, MAX_UNITS)
  const groups: Group[] = shownUnits.map(({ unit, list }) => {
    const shown = list.slice(0, MAX_FAMILIES_PER_UNIT)
    return {
      unit,
      bars: shown,
      hiddenCount: list.length - shown.length,
      maxQuantity: Math.max(1, ...shown.map((b) => b.totalQuantity)),
    }
  })
  return { groups, hiddenUnitCount: allUnits.length - shownUnits.length }
}

export function QuantityByUnitChart({ bars }: { bars: QuantityByUnitBar[] }) {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [showTable, setShowTable] = useState(false)

  const { groups, hiddenUnitCount } = useMemo(() => buildGroups(bars), [bars])

  if (groups.length === 0) return null

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right

  // Absolute y-layout: each group gets a header row then one row per bar.
  let cursorY = PAD.top
  const positioned: { bar: QuantityByUnitBar; unit: string; y: number; barW: number; maxQuantity: number }[] = []
  const groupHeaderY: { unit: string; y: number }[] = []
  for (const group of groups) {
    groupHeaderY.push({ unit: group.unit, y: cursorY })
    cursorY += GROUP_HEADER_HEIGHT
    for (const bar of group.bars) {
      positioned.push({
        bar,
        unit: group.unit,
        y: cursorY,
        barW: (bar.totalQuantity / group.maxQuantity) * innerWidth,
        maxQuantity: group.maxQuantity,
      })
      cursorY += ROW_HEIGHT
    }
    cursorY += GROUP_GAP
  }
  const viewHeight = cursorY - GROUP_GAP + PAD.bottom

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relY = ((e.clientY - rect.top) / rect.height) * viewHeight
    const hit = positioned.find((p) => relY >= p.y && relY < p.y + ROW_HEIGHT)
    setActiveKey(hit ? hit.bar.key : null)
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (positioned.length === 0) return
    const idx = positioned.findIndex((p) => p.bar.key === activeKey)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveKey(positioned[Math.min(positioned.length - 1, idx + 1)]!.bar.key)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveKey(positioned[Math.max(0, idx === -1 ? 0 : idx - 1)]!.bar.key)
    } else if (e.key === 'Escape') {
      setActiveKey(null)
    }
  }

  const active = positioned.find((p) => p.bar.key === activeKey) ?? null
  const tooltipLeftPct = active ? ((PAD.left + active.barW / 2) / VIEW_WIDTH) * 100 : 50

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
    <div className="flex flex-col gap-3">
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${viewHeight}`}
          width="100%"
          height={viewHeight}
          className="overflow-visible"
          role="img"
          aria-label={`Quantity purchased by unit — one mini bar-chart per unit of measure, each on its own scale since units aren't comparable to each other. ${formatNumber(
            groups.length
          )} units shown, families ranked by quantity within each. See the table view below for exact values.`}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setActiveKey(null)}
          onKeyDown={handleKeyDown}
        >
          {groupHeaderY.map(({ unit, y }) => (
            <g key={`hdr-${unit}`}>
              <text x={PAD.left} y={y + GROUP_HEADER_HEIGHT - 8} className="fill-foreground text-[10px] font-semibold uppercase tracking-wide">
                {unit || 'No unit recorded'}
              </text>
              <line
                x1={PAD.left}
                x2={VIEW_WIDTH - PAD.right}
                y1={y + GROUP_HEADER_HEIGHT - 3}
                y2={y + GROUP_HEADER_HEIGHT - 3}
                className="stroke-border"
                strokeWidth={1}
              />
            </g>
          ))}

          {positioned.map((p) => {
            const isActive = activeKey === p.bar.key
            const rowCentre = p.y + ROW_HEIGHT / 2
            const labelText =
              p.bar.familyLabel.length > 20 ? `${p.bar.familyLabel.slice(0, 19)}…` : p.bar.familyLabel
            return (
              <g key={p.bar.key}>
                <title>{`${p.bar.familyLabel} (${p.unit || 'no unit'}): ${formatNumber(p.bar.totalQuantity)}`}</title>
                <text x={PAD.left - 10} y={rowCentre} textAnchor="end" dominantBaseline="middle" className="fill-foreground text-[10px]">
                  {labelText}
                </text>
                <rect
                  x={PAD.left}
                  y={rowCentre - BAR_HEIGHT / 2}
                  width={Math.max(1, p.barW)}
                  height={BAR_HEIGHT}
                  rx={2}
                  strokeWidth={isActive ? 1.5 : 0}
                  className={cn(BAR_COLOR, isActive && 'stroke-foreground')}
                />
                <text x={PAD.left + p.barW + 6} y={rowCentre} dominantBaseline="middle" className="fill-muted-foreground text-[9px]">
                  {formatNumber(p.bar.totalQuantity)}
                </text>
              </g>
            )
          })}
        </svg>

        {active && (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[12rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipLeftPct)
            )}
          >
            <p className="font-medium text-foreground">{active.bar.familyLabel}</p>
            <p className="mb-1 text-[11px] text-muted-foreground">{active.unit || 'No unit recorded'}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Total quantity</span>
              <span className="font-mono font-semibold text-foreground">{formatNumber(active.bar.totalQuantity)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Observations</span>
              <span className="font-mono font-semibold text-foreground">{formatNumber(active.bar.observationCount)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Vendors</span>
              <span className="font-mono font-semibold text-foreground">{formatNumber(active.bar.vendorCount)}</span>
            </div>
          </div>
        )}
      </div>

      {hiddenUnitCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(groups.length)} units with the most total quantity; {formatNumber(hiddenUnitCount)} more{' '}
          {hiddenUnitCount === 1 ? 'is' : 'are'} in the table.
        </p>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={tableRows} getRowKey={(b) => b.key} />}
    </div>
  )
}
