'use client'

import { useState, type PointerEvent, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

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
// department's total spend — with a reference line at 50%. Departments past
// the line get the reserved critical-status colour PLUS a warning glyph and
// an inline "single-source" label (§6 fix #5: status colour is never the
// sole signal, and never reused elsewhere on this chart as a plain series
// hue), so the finding survives print and colour-blind viewing on raw bar
// length and label text alone.
//
// Structurally mirrors heatmap-matrix-chart.tsx: inline SVG with real
// numeric attributes for every data-driven mark (exempt from this app's
// style-src CSP constraint — see lib/reports/bar-scale.ts), a pointer-move
// row lookup, arrow-key row navigation, an SVG <title> per bar as a no-JS
// fallback, and a required "View as table" twin so every value the chart
// conveys is also plain text.

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

const VIEW_WIDTH = 600
const ROW_HEIGHT = 32
const BAR_HEIGHT = 14
const MAX_ROWS = 12
const PAD = { left: 156, right: 16, top: 10, bottom: 26 }
const X_TICKS = [0, 25, 50, 75, 100]

function overThreshold(sharePct: number): boolean {
  return sharePct > DEPARTMENT_DEPENDENCY_THRESHOLD_PCT
}

// Small filled triangle "warning" glyph, drawn as a path rather than an
// icon-font import so it stays inline SVG (no external font/style request
// this app's CSP would need to allowlist).
function WarningGlyph({ x, y }: { x: number; y: number }) {
  return (
    <path
      d={`M${x} ${y - 5} L${x + 5.5} ${y + 5} L${x - 5.5} ${y + 5} Z`}
      className="fill-red-600 dark:fill-red-500"
      aria-hidden="true"
    />
  )
}

export function DepartmentDependencyChart({ bars }: { bars: DepartmentDependencyBar[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (bars.length === 0) return null

  const sorted = [...bars].sort((a, b) => b.sharePct - a.sharePct)
  const rows = sorted.slice(0, MAX_ROWS)
  const hiddenCount = sorted.length - rows.length
  const hiddenOverThresholdCount = sorted.slice(MAX_ROWS).filter((r) => overThreshold(r.sharePct)).length

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right
  const plotHeight = rows.length * ROW_HEIGHT
  const viewHeight = PAD.top + plotHeight + PAD.bottom

  const xFor = (pct: number) => PAD.left + (Math.max(0, Math.min(100, pct)) / 100) * innerWidth
  const rowTop = (i: number) => PAD.top + i * ROW_HEIGHT
  const rowCentre = (i: number) => rowTop(i) + ROW_HEIGHT / 2
  const referenceX = xFor(DEPARTMENT_DEPENDENCY_THRESHOLD_PCT)

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
  const tooltipPct = activeIndex != null ? (xFor(rows[activeIndex]!.sharePct) / VIEW_WIDTH) * 100 : 50

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

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${viewHeight}`}
          width="100%"
          height={viewHeight}
          className="overflow-visible"
          role="img"
          aria-label={`Department dependency — one bar per department, length is its top vendor's share of that department's spend. ${formatNumber(
            rows.filter((r) => overThreshold(r.sharePct)).length
          )} of ${formatNumber(rows.length)} shown are past the 50% single-source threshold. See the table view below for exact values.`}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setActiveIndex(null)}
          onKeyDown={handleKeyDown}
        >
          {/* X gridlines + labels (0/25/50/75/100%). */}
          {X_TICKS.map((t) => (
            <g key={`x-${t}`}>
              <line x1={xFor(t)} x2={xFor(t)} y1={PAD.top} y2={PAD.top + plotHeight} className="stroke-border" strokeWidth={1} />
              <text x={xFor(t)} y={PAD.top + plotHeight + 16} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {t}%
              </text>
            </g>
          ))}
          <text x={PAD.left + innerWidth / 2} y={viewHeight - 6} textAnchor="middle" className="fill-muted-foreground text-[9px]">
            Top vendor&rsquo;s share of department spend
          </text>

          {/* 50% reference rule. */}
          <line
            x1={referenceX}
            x2={referenceX}
            y1={PAD.top - 6}
            y2={PAD.top + plotHeight}
            className="stroke-foreground/60"
            strokeWidth={1.5}
            strokeDasharray="5 3"
          />
          <text x={referenceX} y={PAD.top - 10} textAnchor="middle" className="fill-foreground text-[9px] font-medium">
            50%
          </text>

          {rows.map((row, i) => {
            const isOver = overThreshold(row.sharePct)
            const barW = Math.max(0, xFor(row.sharePct) - PAD.left)
            const isActive = activeIndex === i
            const titleText = `${row.departmentLabel}: ${row.topVendorLabel} carries ${formatPercent(row.sharePct)} of spend${
              isOver ? ' — single-source risk' : ''
            }`
            return (
              <g key={row.key}>
                <title>{titleText}</title>
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
                  {row.departmentLabel.length > 22 ? `${row.departmentLabel.slice(0, 21)}…` : row.departmentLabel}
                </text>
                <rect
                  x={PAD.left}
                  y={rowCentre(i) - BAR_HEIGHT / 2}
                  width={barW}
                  height={BAR_HEIGHT}
                  rx={2}
                  strokeWidth={isActive ? 1.5 : 0}
                  className={cn(
                    isOver ? 'fill-red-600 dark:fill-red-500' : 'fill-[#2a78d6] dark:fill-[#3987e5]',
                    isActive && 'stroke-foreground'
                  )}
                />
                {isOver && <WarningGlyph x={PAD.left + barW + 12} y={rowCentre(i)} />}
                <text
                  x={PAD.left + barW + (isOver ? 22 : 8)}
                  y={rowCentre(i)}
                  dominantBaseline="middle"
                  className="fill-muted-foreground text-[9px]"
                >
                  {row.topVendorLabel.length > 16 ? `${row.topVendorLabel.slice(0, 15)}…` : row.topVendorLabel} ·{' '}
                  {formatPercent(row.sharePct)}
                </text>
              </g>
            )
          })}
        </svg>

        {activeBar && (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[13rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipPct)
            )}
          >
            <p className="font-medium text-foreground">{activeBar.departmentLabel}</p>
            <p className="mb-1 text-[11px] text-muted-foreground">{activeBar.topVendorLabel}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Share of dept. spend</span>
              <span className="font-mono font-semibold text-foreground">{formatPercent(activeBar.sharePct)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Top vendor spend</span>
              <span className="font-mono font-semibold text-foreground">{formatINRCompact(activeBar.topVendorSpend)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Department total</span>
              <span className="font-mono font-semibold text-foreground">{formatINRCompact(activeBar.departmentTotalSpend)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={12} height={12} aria-hidden="true">
            <rect x={0} y={2} width={12} height={8} rx={2} className="fill-red-600 dark:fill-red-500" />
          </svg>
          <svg width={10} height={10} aria-hidden="true">
            <path d="M5 0 L10 10 L0 10 Z" className="fill-red-600 dark:fill-red-500" />
          </svg>
          Over 50% — single-source risk
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={12} height={12} aria-hidden="true">
            <rect x={0} y={2} width={12} height={8} rx={2} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
          </svg>
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

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={sorted} getRowKey={(r) => r.key} />}
    </div>
  )
}
