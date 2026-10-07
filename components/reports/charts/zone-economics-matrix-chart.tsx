'use client'

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { useChartWidth } from '@/components/reports/charts/use-chart-width'
import {
  MATRIX_CELL_H,
  MATRIX_PAD_BOTTOM,
  matrixColLabelHeight,
  matrixLayout,
  truncateLabel,
} from '@/components/reports/charts/matrix-layout'
import { ChartTooltipNote, ChartTooltipPanel, ChartTooltipRow } from '@/components/reports/charts/chart-tooltip-panel'

// reporting-blueprint.md C-08: "Rate paid for the same item at different
// sites. Two zones buying the same ceiling at different rates is a finding no
// total will ever show." Matrix — item_family rows × zone columns, each cell
// coloured by (cell rate ÷ family median rate), where 1.0× is the family's own
// norm.
//
// DIVERGING scale centred on 1.0× (dataviz skill: polarity → two hues + a
// neutral grey midpoint, equal steps per arm). Cool blue arm = paid LESS than
// the family median, a neutral grey bin around 1.0× = at the norm, warm orange
// arm = paid MORE. Orange, not red: red is the app's reserved status colour.
// (The earlier sequential single-hue ramp made "paid less than median" look
// like "near zero" — a ratio's reference point is 1, not 0.) Five discrete
// bins, symmetric in % terms: < 0.85×, 0.85–0.95×, 0.95–1.05×, 1.05–1.15×,
// > 1.15× (1.15 matches the section's 15% wide-spread headline).
//
// Blank cell (hairline stroke-border box, never coloured) where that family
// wasn't billed in that zone at all — the view itself only carries families
// billed in 2+ zones, so a blank cell still means "not this zone," never
// "zero rate."
//
// Laid out at the card's measured width (useChartWidth + matrix-layout.ts,
// scale 1) so labels stay 11px on a phone; inline SVG with real numeric
// attributes, a pointer/keyboard hover layer, an SVG <title> per cell as a
// no-JS fallback, and a required "View as table" twin.

export type ZoneEconomicsAxisItem = { key: string; label: string }
export type ZoneEconomicsCell = {
  rowKey: string
  colKey: string
  medianRate: number
  familyMedianRate: number
  observationCount: number
}

// Bin edges, in ratio-to-family-median. A ratio of exactly 0.95 or 1.05
// counts as "near the median" (bin 2).
const LOW_STRONG = 0.85
const LOW_MILD = 0.95
const HIGH_MILD = 1.05
const HIGH_STRONG = 1.15

// Diverging steps. Validated with the dataviz skill's validator
// (scripts/validate_palette.js), each arm as an --ordinal ramp and the full
// set --pairs all for cross-bin separation:
//   light  cool #3987e5,#86b6ef | neutral #f0efec | warm #ee9a7c,#d95926
//          arms: ALL CHECKS PASS (light ends 2.06:1 / 2.14:1 vs #fcfcfb);
//          all-pairs CVD ΔE 14.3, normal-vision ΔE 15.5 — PASS
//   dark   cool #5598e7,#1c5cab | neutral #383835 | warm #9c390b,#eb6834
//          arms: ALL CHECKS PASS (inner steps 2.63:1 / 2.49:1 vs #1a1a19);
//          all-pairs CVD ΔE 10.8, normal-vision ΔE 19.1 — PASS
// Matched lightness per arm (cool and warm steps share OKLCH L) so neither
// side reads as heavier. Band/chroma "FAIL"s from the categorical checks are
// expected for a ramp (the neutral is grey by design); the sub-3:1 inner
// steps are relieved by the per-cell tooltip, <title> and table twin.
const BINS = [
  {
    fill: 'fill-[#3987e5] dark:fill-[#5598e7]',
    bg: 'bg-[#3987e5] dark:bg-[#5598e7]',
    label: `< ${LOW_STRONG}×`,
    meaning: 'well below median',
  },
  {
    fill: 'fill-[#86b6ef] dark:fill-[#1c5cab]',
    bg: 'bg-[#86b6ef] dark:bg-[#1c5cab]',
    label: `${LOW_STRONG}–${LOW_MILD}×`,
    meaning: 'below median',
  },
  {
    fill: 'fill-[#f0efec] dark:fill-[#383835]',
    bg: 'bg-[#f0efec] dark:bg-[#383835]',
    label: `${LOW_MILD}–${HIGH_MILD}×`,
    meaning: 'at median',
  },
  {
    fill: 'fill-[#ee9a7c] dark:fill-[#9c390b]',
    bg: 'bg-[#ee9a7c] dark:bg-[#9c390b]',
    label: `${HIGH_MILD}–${HIGH_STRONG}×`,
    meaning: 'above median',
  },
  {
    fill: 'fill-[#d95926] dark:fill-[#eb6834]',
    bg: 'bg-[#d95926] dark:bg-[#eb6834]',
    label: `> ${HIGH_STRONG}×`,
    meaning: 'well above median',
  },
] as const

const COL_LABEL_CHARS = 16

/** Bin index 0..4 for a cell's rate-vs-family-median ratio. */
function binOf(ratio: number): number {
  if (ratio < LOW_STRONG) return 0
  if (ratio < LOW_MILD) return 1
  if (ratio <= HIGH_MILD) return 2
  if (ratio <= HIGH_STRONG) return 3
  return 4
}

export function ZoneEconomicsMatrixChart({
  rows,
  columns,
  cells,
}: {
  rows: ZoneEconomicsAxisItem[]
  columns: ZoneEconomicsAxisItem[]
  cells: ZoneEconomicsCell[]
}) {
  const [active, setActive] = useState<{ r: number; c: number } | null>(null)
  const [showTable, setShowTable] = useState(false)
  const [wrapRef, containerWidth] = useChartWidth(600)

  const cellByKey = useMemo(() => {
    const m = new Map<string, ZoneEconomicsCell>()
    for (const cell of cells) m.set(`${cell.rowKey}||${cell.colKey}`, cell)
    return m
  }, [cells])

  if (rows.length === 0 || columns.length === 0) return null

  const { rowLabelW, rowLabelChars, cellW, svgWidth } = matrixLayout(containerWidth, columns.length)
  const colLabelH = matrixColLabelHeight(COL_LABEL_CHARS)
  const height = colLabelH + rows.length * MATRIX_CELL_H + MATRIX_PAD_BOTTOM

  const lookup = (r: number, c: number) => cellByKey.get(`${rows[r]!.key}||${columns[c]!.key}`) ?? null
  const ratioOf = (cell: ZoneEconomicsCell) => (cell.familyMedianRate > 0 ? cell.medianRate / cell.familyMedianRate : 1)

  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'Escape') {
      setActive(null)
      return
    }
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    setActive((prev) => {
      const cur = prev ?? { r: 0, c: 0 }
      if (e.key === 'ArrowRight') return { r: cur.r, c: Math.min(columns.length - 1, cur.c + 1) }
      if (e.key === 'ArrowLeft') return { r: cur.r, c: Math.max(0, cur.c - 1) }
      if (e.key === 'ArrowUp') return { r: Math.max(0, cur.r - 1), c: cur.c }
      return { r: Math.min(rows.length - 1, cur.r + 1), c: cur.c }
    })
  }

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    // Scale 1: one viewBox unit per CSS pixel.
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const relY = e.clientY - rect.top
    const c = Math.floor((relX - rowLabelW) / cellW)
    const r = Math.floor((relY - colLabelH) / MATRIX_CELL_H)
    if (r >= 0 && r < rows.length && c >= 0 && c < columns.length) setActive({ r, c })
    else setActive(null)
  }

  const activeCell = active ? lookup(active.r, active.c) : null
  const activeBin = activeCell ? binOf(ratioOf(activeCell)) : -1
  const tooltipLeftPct = active ? ((rowLabelW + active.c * cellW + cellW / 2) / containerWidth) * 100 : 50

  const tableColumns: DataTableColumn<ZoneEconomicsCell>[] = [
    { key: 'family', header: 'Item family', render: (cell) => cell.rowKey },
    { key: 'zone', header: 'Zone', render: (cell) => cell.colKey },
    { key: 'rate', header: 'Zone median rate', align: 'right', render: (cell) => formatINR(cell.medianRate) },
    { key: 'familyRate', header: 'Family median rate', align: 'right', render: (cell) => formatINR(cell.familyMedianRate) },
    { key: 'ratio', header: 'vs family median', align: 'right', render: (cell) => `${ratioOf(cell).toFixed(2)}×` },
    { key: 'obs', header: 'Observations', align: 'right', render: (cell) => formatNumber(cell.observationCount) },
  ]
  const tableRows = [...cells].sort((a, b) => ratioOf(b) - ratioOf(a))

  return (
    <div className="flex flex-col gap-3 motion-safe:animate-chart-in">
      <div ref={wrapRef} className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${svgWidth} ${height}`}
          width={svgWidth}
          height={height}
          role="img"
          aria-label={`Unit economics by zone — ${formatNumber(rows.length)} item families down the rows, ${formatNumber(
            columns.length
          )} zones across the columns. Each cell is coloured by its median rate against that family's own median across every zone: blue below the median, grey near it (0.95× to 1.05×), orange above it, deeper colour the further away. See the table view below for exact values.`}
          tabIndex={0}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={handleKeyDown}
        >
          {columns.map((col, c) => {
            const x = rowLabelW + c * cellW + cellW / 2
            return (
              <text
                key={col.key}
                x={x}
                y={colLabelH - 8}
                textAnchor="start"
                transform={`rotate(-40 ${x} ${colLabelH - 8})`}
                className="fill-muted-foreground text-[11px]"
              >
                {truncateLabel(col.label, COL_LABEL_CHARS)}
              </text>
            )
          })}

          {rows.map((row, r) => {
            const y = colLabelH + r * MATRIX_CELL_H
            return (
              <g key={row.key}>
                <text
                  x={rowLabelW - 8}
                  y={y + MATRIX_CELL_H / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-foreground text-[11px]"
                >
                  {truncateLabel(row.label, rowLabelChars)}
                </text>
                {columns.map((col, c) => {
                  const x = rowLabelW + c * cellW
                  const cell = lookup(r, c)
                  const ratio = cell ? ratioOf(cell) : null
                  const bin = ratio != null ? binOf(ratio) : -1
                  const isActive = active?.r === r && active?.c === c
                  const titleText = cell
                    ? `${row.label} · ${col.label}: ${formatINR(cell.medianRate)} (${ratio!.toFixed(2)}× the ${formatINR(cell.familyMedianRate)} family median — ${BINS[bin]!.meaning}), ${formatNumber(cell.observationCount)} observation${cell.observationCount === 1 ? '' : 's'}`
                    : `${row.label} · ${col.label}: not billed in this zone`
                  return (
                    <g key={col.key}>
                      <title>{titleText}</title>
                      <rect
                        x={x + 1}
                        y={y + 1}
                        width={cellW - 2}
                        height={MATRIX_CELL_H - 2}
                        rx={2}
                        strokeWidth={1}
                        className={cn(bin >= 0 ? BINS[bin]!.fill : 'fill-none stroke-border', isActive && 'stroke-foreground')}
                      />
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>

        {active ? (
          <ChartTooltipPanel
            leftPct={tooltipLeftPct}
            className="min-w-[13rem]"
            title={`${rows[active.r]!.label} · ${columns[active.c]!.label}`}
          >
            {activeCell ? (
              <>
                <ChartTooltipRow label="Zone median rate" value={formatINR(activeCell.medianRate)} indicatorClass={BINS[activeBin]!.bg} />
                <ChartTooltipRow label="Family median (all zones)" value={formatINR(activeCell.familyMedianRate)} />
                <ChartTooltipRow label="vs family median" value={`${ratioOf(activeCell).toFixed(2)}×`} />
                <ChartTooltipNote>{BINS[activeBin]!.meaning}</ChartTooltipNote>
              </>
            ) : (
              <ChartTooltipNote>Not billed in this zone</ChartTooltipNote>
            )}
          </ChartTooltipPanel>
        ) : null}
      </div>

      {/* Legend: the five bins in order, cool → neutral → warm, with their
          ranges, plus the blank-cell state. */}
      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span>Rate vs family median:</span>
          {BINS.map((bin) => (
            <span key={bin.label} className="flex items-center gap-1.5">
              <span className={cn('h-3 w-3 shrink-0 rounded-[2px]', bin.bg)} aria-hidden="true" />
              {bin.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <svg width={12} height={12} aria-hidden="true">
              <rect x={0.5} y={0.5} width={11} height={11} rx={2} className="fill-none stroke-border" strokeWidth={1} />
            </svg>
            Not billed in this zone
          </span>
        </div>
        <p>Blue = paid less than the family&rsquo;s own median, grey = about the median, orange = paid more.</p>
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && (
        <DataTable columns={tableColumns} rows={tableRows} getRowKey={(cell) => `${cell.rowKey}||${cell.colKey}`} />
      )}
    </div>
  )
}
