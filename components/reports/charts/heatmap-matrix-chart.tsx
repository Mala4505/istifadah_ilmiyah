'use client'

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md D-01 (flagship): "Matrix — type down, department
// across, shaded by rupees at risk. Sequential single-hue shading, never a
// rainbow, so darker always and only means more." (§4)
//
// So: one hue (the screen's accent blue), five DISCRETE bins rather than a
// continuous gradient — a legend of five swatches is readable, a gradient bar
// is not. On the light surface the ramp runs light→dark (dark = more); on the
// dark surface it runs dim→bright (bright = more), so on both surfaces "more
// ink / more contrast against the surface" means "more rupees" and nothing
// else. Empty cells (no open issue for that type × department) render as a
// hairline `stroke-border` box, never a coloured one, so zero is visibly not
// "a little".
//
// Structurally mirrors attention-map-chart.tsx: inline SVG with real numeric
// attributes for every data-driven mark (exempt from this app's style-src CSP
// constraint — see lib/reports/bar-scale.ts), a pointer/keyboard hover layer,
// an SVG <title> per cell as a no-JS fallback, and a required "View as table"
// twin so every value the chart conveys is also plain text.

export type HeatmapAxisItem = { key: string; label: string }
export type HeatmapCell = {
  rowKey: string
  colKey: string
  amountAtRisk: number
  issueCount: number
}

// Five discrete bins from the dataviz skill's documented sequential-blue ramp
// (references/palette.md). Every class string is a literal so Tailwind's
// content scan finds it — see lib/reports/bar-scale.ts's header for why a
// runtime-built class name would be invisible to the compiler. Light column:
// palette steps 100 / 200 / 300 / 400 / 600 (light→dark). Dark column: stepped
// for the dark surface so it runs dim→bright as the value climbs.
const BIN_FILL_CLASSES = [
  'fill-[#cde2fb] dark:fill-[#123a63]',
  'fill-[#9ec5f4] dark:fill-[#1a5388]',
  'fill-[#6da7ec] dark:fill-[#2f6fbf]',
  'fill-[#3e8ae0] dark:fill-[#5b9be8]',
  'fill-[#184f95] dark:fill-[#93bff1]',
] as const
const BIN_COUNT = BIN_FILL_CLASSES.length

const CELL_W = 46
const CELL_H = 30
const ROW_LABEL_W = 150
const COL_LABEL_H = 96
const PAD_RIGHT = 12
const PAD_BOTTOM = 6

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Bin index 0..BIN_COUNT-1 for a cell that has open issues, or -1 for a cell
 *  with none (rendered as an empty stroke-border box). A cell that has issues
 *  but no rupees attached still gets the lightest bin — it is not empty.
 *  Linear bins so the legend thresholds are simple to state. */
function binOf(amount: number, max: number): number {
  if (max <= 0 || amount <= 0) return 0
  return Math.min(BIN_COUNT - 1, Math.floor((amount / max) * BIN_COUNT))
}

export function HeatmapMatrixChart({
  rows,
  columns,
  cells,
}: {
  rows: HeatmapAxisItem[]
  columns: HeatmapAxisItem[]
  cells: HeatmapCell[]
}) {
  const [active, setActive] = useState<{ r: number; c: number } | null>(null)
  const [showTable, setShowTable] = useState(false)

  const cellByKey = useMemo(() => {
    const m = new Map<string, HeatmapCell>()
    for (const cell of cells) m.set(`${cell.rowKey}||${cell.colKey}`, cell)
    return m
  }, [cells])

  const maxAmount = useMemo(() => cells.reduce((m, cell) => Math.max(m, cell.amountAtRisk), 0), [cells])

  if (rows.length === 0 || columns.length === 0) return null

  const width = ROW_LABEL_W + columns.length * CELL_W + PAD_RIGHT
  const height = COL_LABEL_H + rows.length * CELL_H + PAD_BOTTOM

  const lookup = (r: number, c: number) => cellByKey.get(`${rows[r]!.key}||${columns[c]!.key}`) ?? null

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

  const tableColumns: DataTableColumn<HeatmapCell>[] = [
    { key: 'type', header: 'Issue type', render: (cell) => cell.rowKey },
    { key: 'department', header: 'Department', render: (cell) => cell.colKey },
    { key: 'count', header: 'Open issues', align: 'right', render: (cell) => formatNumber(cell.issueCount) },
    { key: 'amount', header: '₹ at risk', align: 'right', render: (cell) => formatINR(cell.amountAtRisk) },
  ]
  const tableRows = [...cells].sort((a, b) => b.amountAtRisk - a.amountAtRisk)

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`Exception heat map — ${formatNumber(rows.length)} open issue types down the rows, ${formatNumber(
            columns.length
          )} departments across the columns, each cell shaded darker the more rupees are at risk. See the table view below for exact values.`}
          tabIndex={0}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={handleKeyDown}
        >
          {/* Column headers (departments), angled for legibility. */}
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
                {/* Row header (issue type). */}
                <text
                  x={ROW_LABEL_W - 8}
                  y={y + CELL_H / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-foreground text-[10px]"
                >
                  {truncate(row.label, 22)}
                </text>
                {columns.map((col, c) => {
                  const x = ROW_LABEL_W + c * CELL_W
                  const cell = lookup(r, c)
                  const bin = cell ? binOf(cell.amountAtRisk, maxAmount) : -1
                  const isActive = active?.r === r && active?.c === c
                  const titleText = cell
                    ? `${row.label} · ${col.label}: ${formatINR(cell.amountAtRisk)} at risk, ${formatNumber(
                        cell.issueCount
                      )} open`
                    : `${row.label} · ${col.label}: no open issues`
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
                        className={cn(
                          bin >= 0 ? BIN_FILL_CLASSES[bin] : 'fill-none stroke-border',
                          isActive && 'stroke-foreground'
                        )}
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
              'pointer-events-none absolute top-1 z-10 min-w-[12rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipLeftPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">
              {rows[active!.r]!.label} · {columns[active!.c]!.label}
            </p>
            {activeCell ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">₹ at risk</span>
                  <span className="font-mono font-semibold text-foreground">{formatINR(activeCell.amountAtRisk)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Open issues</span>
                  <span className="font-mono font-semibold text-foreground">{formatNumber(activeCell.issueCount)}</span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">No open issues</p>
            )}
          </div>
        ) : null}
      </div>

      {/* Legend — five bin thresholds plus the empty state. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={12} height={12} aria-hidden="true">
            <rect x={0.5} y={0.5} width={11} height={11} rx={2} className="fill-none stroke-border" strokeWidth={1} />
          </svg>
          No open issues
        </span>
        {BIN_FILL_CLASSES.map((fillClass, i) => {
          const lower = maxAmount > 0 ? (i / BIN_COUNT) * maxAmount : 0
          const upper = maxAmount > 0 ? ((i + 1) / BIN_COUNT) * maxAmount : 0
          return (
            <span key={fillClass} className="flex items-center gap-1.5">
              <svg width={12} height={12} aria-hidden="true">
                <rect x={0} y={0} width={12} height={12} rx={2} className={fillClass} />
              </svg>
              {i === BIN_COUNT - 1
                ? `≥ ${formatINRCompact(lower)}`
                : `${formatINRCompact(lower)}–${formatINRCompact(upper)}`}
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
