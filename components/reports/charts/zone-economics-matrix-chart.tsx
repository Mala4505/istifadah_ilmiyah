'use client'

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md C-08: "Rate paid for the same item at different
// sites. Two zones buying the same ceiling at different rates is a finding no
// total will ever show." Matrix — item_family rows × zone columns, each cell
// shaded sequential single-hue by (cell rate ÷ family median rate): darker
// means paid MORE than our own norm for that item, not just "more rupees" —
// unlike a plain amount heatmap, 1.0x (right at the family's own median) is
// the reference point, not zero, so the bins below are centred on 1.0x rather
// than starting at 0. Blank cell (hairline stroke-border box, never
// coloured) where that family wasn't billed in that zone at all — the view
// itself only carries families billed in 2+ zones, so a blank cell here
// still means "not this zone," never "zero rate."
//
// Structurally identical to heatmap-matrix-chart.tsx (D-01's exception heat
// map): inline SVG with real numeric attributes for every data-driven mark,
// a pointer/keyboard hover layer, an SVG <title> per cell as a no-JS
// fallback, and a required "View as table" twin.

export type ZoneEconomicsAxisItem = { key: string; label: string }
export type ZoneEconomicsCell = {
  rowKey: string
  colKey: string
  medianRate: number
  familyMedianRate: number
  observationCount: number
}

// Five discrete bins centred on 1.0x (at the family's own median), not on the
// observed max — a ratio chart's natural reference point is 1, unlike an
// amount heatmap's natural reference point of 0. Same sequential single-hue
// ramp as heatmap-matrix-chart.tsx (references/palette.md) so "darker /
// brighter = more" reads consistently across every matrix in this app.
const RATIO_THRESHOLDS = [0.95, 1.05, 1.15, 1.3] as const
const BIN_FILL_CLASSES = [
  'fill-[#cde2fb] dark:fill-[#123a63]',
  'fill-[#9ec5f4] dark:fill-[#1a5388]',
  'fill-[#6da7ec] dark:fill-[#2f6fbf]',
  'fill-[#3e8ae0] dark:fill-[#5b9be8]',
  'fill-[#184f95] dark:fill-[#93bff1]',
] as const

const CELL_W = 46
const CELL_H = 30
const ROW_LABEL_W = 150
const COL_LABEL_H = 96
const PAD_RIGHT = 12
const PAD_BOTTOM = 6

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Bin index 0..4 for a cell's rate-vs-family-median ratio. */
function binOf(ratio: number): number {
  for (let i = 0; i < RATIO_THRESHOLDS.length; i += 1) {
    if (ratio <= RATIO_THRESHOLDS[i]!) return i
  }
  return RATIO_THRESHOLDS.length
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

  const cellByKey = useMemo(() => {
    const m = new Map<string, ZoneEconomicsCell>()
    for (const cell of cells) m.set(`${cell.rowKey}||${cell.colKey}`, cell)
    return m
  }, [cells])

  if (rows.length === 0 || columns.length === 0) return null

  const width = ROW_LABEL_W + columns.length * CELL_W + PAD_RIGHT
  const height = COL_LABEL_H + rows.length * CELL_H + PAD_BOTTOM

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
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * width
    const relY = ((e.clientY - rect.top) / rect.height) * height
    const c = Math.floor((relX - ROW_LABEL_W) / CELL_W)
    const r = Math.floor((relY - COL_LABEL_H) / CELL_H)
    if (r >= 0 && r < rows.length && c >= 0 && c < columns.length) setActive({ r, c })
    else setActive(null)
  }

  const activeCell = active ? lookup(active.r, active.c) : null
  const tooltipLeftPct = active ? ((ROW_LABEL_W + active.c * CELL_W + CELL_W / 2) / width) * 100 : 50

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
    <div className="flex flex-col gap-3">
      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`Unit economics by zone — ${formatNumber(rows.length)} item families down the rows, ${formatNumber(
            columns.length
          )} zones across the columns, each cell shaded darker the more its median rate exceeds that family's own median rate across every zone. See the table view below for exact values.`}
          tabIndex={0}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={handleKeyDown}
        >
          {columns.map((col, c) => {
            const x = ROW_LABEL_W + c * CELL_W + CELL_W / 2
            return (
              <text
                key={col.key}
                x={x}
                y={COL_LABEL_H - 8}
                textAnchor="start"
                transform={`rotate(-40 ${x} ${COL_LABEL_H - 8})`}
                className="fill-muted-foreground text-[10px]"
              >
                {truncate(col.label, 16)}
              </text>
            )
          })}

          {rows.map((row, r) => {
            const y = COL_LABEL_H + r * CELL_H
            return (
              <g key={row.key}>
                <text x={ROW_LABEL_W - 8} y={y + CELL_H / 2} textAnchor="end" dominantBaseline="middle" className="fill-foreground text-[10px]">
                  {truncate(row.label, 22)}
                </text>
                {columns.map((col, c) => {
                  const x = ROW_LABEL_W + c * CELL_W
                  const cell = lookup(r, c)
                  const ratio = cell ? ratioOf(cell) : null
                  const bin = ratio != null ? binOf(ratio) : -1
                  const isActive = active?.r === r && active?.c === c
                  const titleText = cell
                    ? `${row.label} · ${col.label}: ${formatINR(cell.medianRate)} (${ratio!.toFixed(2)}× the ${formatINR(cell.familyMedianRate)} family median), ${formatNumber(cell.observationCount)} observation${cell.observationCount === 1 ? '' : 's'}`
                    : `${row.label} · ${col.label}: not billed in this zone`
                  return (
                    <g key={col.key}>
                      <title>{titleText}</title>
                      <rect
                        x={x + 1}
                        y={y + 1}
                        width={CELL_W - 2}
                        height={CELL_H - 2}
                        rx={2}
                        strokeWidth={1}
                        className={cn(bin >= 0 ? BIN_FILL_CLASSES[bin] : 'fill-none stroke-border', isActive && 'stroke-foreground')}
                      />
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>

        {activeCell || active ? (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[13rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipLeftPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">
              {rows[active!.r]!.label} · {columns[active!.c]!.label}
            </p>
            {activeCell ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Zone median rate</span>
                  <span className="font-mono font-semibold text-foreground">{formatINR(activeCell.medianRate)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Family median (all zones)</span>
                  <span className="font-mono font-semibold text-foreground">{formatINR(activeCell.familyMedianRate)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">vs family median</span>
                  <span className="font-mono font-semibold text-foreground">{ratioOf(activeCell).toFixed(2)}×</span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">Not billed in this zone</p>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={12} height={12} aria-hidden="true">
            <rect x={0.5} y={0.5} width={11} height={11} rx={2} className="fill-none stroke-border" strokeWidth={1} />
          </svg>
          Not billed in this zone
        </span>
        {BIN_FILL_CLASSES.map((fillClass, i) => {
          const lower = i === 0 ? null : RATIO_THRESHOLDS[i - 1]!
          const upper = i < RATIO_THRESHOLDS.length ? RATIO_THRESHOLDS[i]! : null
          const label = lower == null ? `≤ ${upper}×` : upper == null ? `> ${lower}×` : `${lower}×–${upper}×`
          return (
            <span key={fillClass} className="flex items-center gap-1.5">
              <svg width={12} height={12} aria-hidden="true">
                <rect x={0} y={0} width={12} height={12} rx={2} className={fillClass} />
              </svg>
              {label} of family median
            </span>
          )
        })}
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
