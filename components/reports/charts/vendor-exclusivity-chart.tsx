'use client'

import { useState, type PointerEvent, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md B-04: "Vendors serving exactly one department,
// especially at high value. Not wrong in itself — but it is where a
// relationship, rather than a market, is setting the price." One horizontal
// bar per single-department vendor, ranked by spend, each labeled with the
// one department it serves. One accent hue throughout — this isn't a
// good/bad finding the way B-03's threshold is, so it gets the plain series
// colour rather than the reserved status palette.
//
// Structurally mirrors funnel-chart.tsx's simple bar geometry plus
// attention-map-chart.tsx's pointer/keyboard/table scaffolding: inline SVG
// with real numeric attributes for every data-driven mark (exempt from this
// app's style-src CSP constraint — see lib/reports/bar-scale.ts), a
// pointer-move row lookup, arrow-key row navigation, an SVG <title> per bar
// as a no-JS fallback, and a required "View as table" twin.

export type VendorExclusivityBar = {
  key: number
  vendorLabel: string
  vendorHref?: string
  departmentLabel: string
  departmentHref?: string
  spend: number
}

const VIEW_WIDTH = 600
const ROW_HEIGHT = 32
const BAR_HEIGHT = 14
const MAX_ROWS = 12
const PAD = { left: 156, right: 16, top: 6, bottom: 26 }

function niceNum(range: number, round: boolean): number {
  const safeRange = range || 1
  const exponent = Math.floor(Math.log10(safeRange))
  const fraction = safeRange / 10 ** exponent
  const niceFraction = round
    ? fraction < 1.5
      ? 1
      : fraction < 3
        ? 2
        : fraction < 7
          ? 5
          : 10
    : fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 5
          ? 5
          : 10
  return niceFraction * 10 ** exponent
}

function niceTicks(min: number, max: number, tickCount = 4): number[] {
  if (min === max) return [0, min]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = 0
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

export function VendorExclusivityChart({ bars }: { bars: VendorExclusivityBar[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (bars.length === 0) return null

  const sorted = [...bars].sort((a, b) => b.spend - a.spend)
  const rows = sorted.slice(0, MAX_ROWS)
  const hiddenCount = sorted.length - rows.length

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right
  const plotHeight = rows.length * ROW_HEIGHT
  const viewHeight = PAD.top + plotHeight + PAD.bottom

  const maxSpend = Math.max(...rows.map((r) => r.spend))
  const ticks = niceTicks(0, maxSpend, 4)
  const domainMax = ticks[ticks.length - 1] || 1

  const xFor = (spend: number) => PAD.left + (Math.max(0, spend) / domainMax) * innerWidth
  const rowTop = (i: number) => PAD.top + i * ROW_HEIGHT
  const rowCentre = (i: number) => rowTop(i) + ROW_HEIGHT / 2

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relY = ((e.clientY - rect.top) / rect.height) * viewHeight
    const idx = Math.floor((relY - PAD.top) / ROW_HEIGHT)
    setActiveIndex(idx >= 0 && idx < rows.length ? idx : null)
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(rows.length - 1, (i ?? -1) + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, (i ?? rows.length) - 1))
    } else if (e.key === 'Escape') {
      setActiveIndex(null)
    }
  }

  const activeBar = activeIndex != null ? rows[activeIndex]! : null
  const tooltipPct = activeIndex != null ? (xFor(rows[activeIndex]!.spend) / VIEW_WIDTH) * 100 : 50

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

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${viewHeight}`}
          width="100%"
          height={viewHeight}
          className="overflow-visible"
          role="img"
          aria-label={`Vendor exclusivity — vendors serving exactly one department, ranked by spend, each bar labeled with its sole department. See the table view below for exact values.`}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setActiveIndex(null)}
          onKeyDown={handleKeyDown}
        >
          {ticks.map((t) => (
            <g key={`x-${t}`}>
              <line x1={xFor(t)} x2={xFor(t)} y1={PAD.top} y2={PAD.top + plotHeight} className="stroke-border" strokeWidth={1} />
              <text x={xFor(t)} y={PAD.top + plotHeight + 16} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {formatINRCompact(t)}
              </text>
            </g>
          ))}

          {rows.map((row, i) => {
            const barW = Math.max(0, xFor(row.spend) - PAD.left)
            const isActive = activeIndex === i
            return (
              <g key={row.key}>
                <title>{`${row.vendorLabel} — ${formatINR(row.spend)}, sole department: ${row.departmentLabel}`}</title>
                {i > 0 && (
                  <line
                    x1={PAD.left}
                    x2={VIEW_WIDTH - PAD.right}
                    y1={rowTop(i)}
                    y2={rowTop(i)}
                    className="stroke-border/60"
                    strokeWidth={1}
                  />
                )}
                <text
                  x={PAD.left - 10}
                  y={rowCentre(i)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-foreground text-[10px]"
                >
                  {row.vendorLabel.length > 22 ? `${row.vendorLabel.slice(0, 21)}…` : row.vendorLabel}
                </text>
                <rect
                  x={PAD.left}
                  y={rowCentre(i) - BAR_HEIGHT / 2}
                  width={barW}
                  height={BAR_HEIGHT}
                  rx={2}
                  strokeWidth={isActive ? 1.5 : 0}
                  className={cn('fill-[#2a78d6] dark:fill-[#3987e5]', isActive && 'stroke-foreground')}
                />
                <text
                  x={PAD.left + barW + 8}
                  y={rowCentre(i)}
                  dominantBaseline="middle"
                  className="fill-muted-foreground text-[9px]"
                >
                  {row.departmentLabel.length > 20 ? `${row.departmentLabel.slice(0, 19)}…` : row.departmentLabel}
                </text>
              </g>
            )
          })}
        </svg>

        {activeBar && (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[12rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipPct)
            )}
          >
            <p className="font-medium text-foreground">{activeBar.vendorLabel}</p>
            <p className="mb-1 text-[11px] text-muted-foreground">{activeBar.departmentLabel}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Total spend</span>
              <span className="font-mono font-semibold text-foreground">{formatINRCompact(activeBar.spend)}</span>
            </div>
          </div>
        )}
      </div>

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
