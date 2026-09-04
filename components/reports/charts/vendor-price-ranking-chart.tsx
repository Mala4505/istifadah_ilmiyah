'use client'

import { useMemo, useState, type PointerEvent, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md B-06: "For each item we buy repeatedly: who charges
// what, ranked. Turns purchasing from a habit into a choice." One item family
// at a time (picked from a dropdown — a page with every family's ranking
// drawn at once would be unreadable and each family has its own rate scale,
// same "never two scales on one chart" reasoning as C-07's small multiples):
// vendors along the y-axis ordered by median rate ascending (cheapest first),
// a min–max whisker per vendor, the dot itself sized by how many observations
// back that median, and the family's own median rate as a vertical rule.
//
// Structurally mirrors strip-plot-chart.tsx: inline SVG with real numeric
// attributes for every data-driven mark, a pointer-move nearest-row hover
// lookup, keyboard nav across vendors, role="img" + aria-label, and a
// required "View as table" twin scoped to the selected family (the table
// shows exactly what the chart draws, not every family at once).

export type VendorPriceDot = {
  familyKey: string
  familyLabel: string
  unit: string | null
  vendorId: number
  vendorLabel: string
  vendorHref?: string
  medianRate: number
  minRate: number | null
  maxRate: number | null
  observationCount: number
  familyMedianRate: number | null
}

type FamilyGroup = {
  key: string
  familyLabel: string
  unit: string | null
  dots: VendorPriceDot[]
  familyMedianRate: number | null
}

const VIEW_WIDTH = 600
const ROW_HEIGHT = 32
const PAD = { left: 150, right: 24, top: 28, bottom: 34 }
const MIN_DOT_R = 4
const MAX_DOT_R = 10
const HOVER_RADIUS_SQ = 24 * 24

function niceNum(range: number, round: boolean): number {
  const safeRange = range || 1
  const exponent = Math.floor(Math.log10(safeRange))
  const fraction = safeRange / 10 ** exponent
  let niceFraction: number
  if (round) {
    niceFraction = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10
  } else {
    niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  }
  return niceFraction * 10 ** exponent
}
function niceTicks(min: number, max: number, tickCount = 4): number[] {
  if (min === max) return [min]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

function buildGroups(dots: VendorPriceDot[]): FamilyGroup[] {
  const byKey = new Map<string, FamilyGroup>()
  for (const d of dots) {
    const key = `${d.familyKey}::${d.unit ?? ''}`
    const g = byKey.get(key) ?? { key, familyLabel: d.familyLabel, unit: d.unit, dots: [], familyMedianRate: d.familyMedianRate }
    g.dots.push(d)
    byKey.set(key, g)
  }
  return [...byKey.values()].sort((a, b) => b.dots.length - a.dots.length || a.familyLabel.localeCompare(b.familyLabel))
}

export function VendorPriceRankingChart({ dots }: { dots: VendorPriceDot[] }) {
  const groups = useMemo(() => buildGroups(dots), [dots])
  const [selectedKey, setSelectedKey] = useState<string | null>(groups[0]?.key ?? null)
  const [hoverVendorId, setHoverVendorId] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (groups.length === 0) return null

  const selected = groups.find((g) => g.key === selectedKey) ?? groups[0]!
  const rows = [...selected.dots].sort((a, b) => a.medianRate - b.medianRate)
  const familyMedian = selected.familyMedianRate

  const maxObs = Math.max(1, ...rows.map((r) => r.observationCount))
  const radiusFor = (obsCount: number) =>
    MIN_DOT_R + (MAX_DOT_R - MIN_DOT_R) * (maxObs > 1 ? Math.sqrt(obsCount / maxObs) : 1)

  const allValues = rows.flatMap((r) => [r.minRate ?? r.medianRate, r.maxRate ?? r.medianRate, r.medianRate])
  if (familyMedian != null) allValues.push(familyMedian)
  const dataMax = Math.max(...allValues, 0)
  const xTicks = niceTicks(0, dataMax, 4)
  const domainMax = xTicks[xTicks.length - 1] ?? (dataMax || 1)

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right
  const plotHeight = rows.length * ROW_HEIGHT
  const viewHeight = PAD.top + plotHeight + PAD.bottom
  const xFor = (v: number) => PAD.left + (Math.min(v, domainMax) / domainMax) * innerWidth
  const rowCentre = (i: number) => PAD.top + i * ROW_HEIGHT + ROW_HEIGHT / 2

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const relY = ((e.clientY - rect.top) / rect.height) * viewHeight
    let bestId: number | null = null
    let bestSq = Infinity
    rows.forEach((r, i) => {
      const dx = xFor(r.medianRate) - relX
      const dy = rowCentre(i) - relY
      const sq = dx * dx + dy * dy
      if (sq < bestSq) {
        bestSq = sq
        bestId = r.vendorId
      }
    })
    setHoverVendorId(bestSq <= HOVER_RADIUS_SQ ? bestId : null)
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (rows.length === 0) return
    const idx = rows.findIndex((r) => r.vendorId === hoverVendorId)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHoverVendorId(rows[Math.min(rows.length - 1, idx === -1 ? 0 : idx + 1)]!.vendorId)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHoverVendorId(rows[Math.max(0, idx === -1 ? rows.length - 1 : idx - 1)]!.vendorId)
    } else if (e.key === 'Escape') {
      setHoverVendorId(null)
    }
  }

  const hoverRow = hoverVendorId != null ? (rows.find((r) => r.vendorId === hoverVendorId) ?? null) : null
  const hoverIndex = hoverRow ? rows.indexOf(hoverRow) : -1
  const tooltipLeftPct = hoverRow ? (xFor(hoverRow.medianRate) / VIEW_WIDTH) * 100 : 50

  const medianX = familyMedian != null ? xFor(familyMedian) : null

  const tableColumns: DataTableColumn<VendorPriceDot>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (d) =>
        d.vendorHref ? (
          <Link href={d.vendorHref} className="text-primary underline-offset-2 hover:underline">
            {d.vendorLabel}
          </Link>
        ) : (
          d.vendorLabel
        ),
    },
    { key: 'median', header: 'Median rate', align: 'right', render: (d) => formatINR(d.medianRate) },
    { key: 'min', header: 'Min', align: 'right', render: (d) => formatINR(d.minRate) },
    { key: 'max', header: 'Max', align: 'right', render: (d) => formatINR(d.maxRate) },
    { key: 'obs', header: 'Observations', align: 'right', render: (d) => formatNumber(d.observationCount) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:max-w-sm">
        Item family
        <select
          value={selected.key}
          onChange={(e) => {
            setSelectedKey(e.target.value)
            setHoverVendorId(null)
          }}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          {groups.map((g) => (
            <option key={g.key} value={g.key}>
              {g.familyLabel}
              {g.unit ? ` · ${g.unit}` : ''} — {g.dots.length} vendor{g.dots.length === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </label>

      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${viewHeight}`}
          width="100%"
          height={viewHeight}
          className="overflow-visible"
          role="img"
          aria-label={`Vendor price ranking for ${selected.familyLabel}${selected.unit ? ` (${selected.unit})` : ''} — ${formatNumber(
            rows.length
          )} vendors ranked by median rate, dot size shows observation count, the vertical rule is the family's own median across every vendor. See the table view below for exact values.`}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverVendorId(null)}
          onKeyDown={handleKeyDown}
        >
          {xTicks.map((t) => (
            <g key={`x-${t}`}>
              <line x1={xFor(t)} x2={xFor(t)} y1={PAD.top - 4} y2={PAD.top + plotHeight} className="stroke-border" strokeWidth={1} />
              <text x={xFor(t)} y={PAD.top + plotHeight + 16} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                {formatINR(t)}
              </text>
            </g>
          ))}
          <text x={PAD.left + innerWidth / 2} y={viewHeight - 6} textAnchor="middle" className="fill-muted-foreground text-[9px]">
            Net rate
          </text>

          {medianX != null && (
            <>
              <line x1={medianX} x2={medianX} y1={PAD.top - 12} y2={PAD.top + plotHeight} className="stroke-foreground/60" strokeWidth={1.5} />
              <text x={medianX} y={PAD.top - 16} textAnchor="middle" className="fill-foreground text-[9px] font-medium">
                family median
              </text>
            </>
          )}

          {rows.map((r, i) => {
            const isHovered = hoverVendorId === r.vendorId
            const cy = rowCentre(i)
            const x1 = r.minRate != null ? xFor(r.minRate) : xFor(r.medianRate)
            const x2 = r.maxRate != null ? xFor(r.maxRate) : xFor(r.medianRate)
            return (
              <g key={r.vendorId}>
                {i > 0 && (
                  <line x1={PAD.left} x2={VIEW_WIDTH - PAD.right} y1={PAD.top + i * ROW_HEIGHT} y2={PAD.top + i * ROW_HEIGHT} className="stroke-border/60" strokeWidth={1} />
                )}
                <text x={PAD.left - 10} y={cy} textAnchor="end" dominantBaseline="middle" className="fill-foreground text-[10px]">
                  {r.vendorLabel.length > 22 ? `${r.vendorLabel.slice(0, 21)}…` : r.vendorLabel}
                </text>
                <title>{`${r.vendorLabel}: ${formatINR(r.medianRate)} median across ${formatNumber(r.observationCount)} observation${r.observationCount === 1 ? '' : 's'}`}</title>
                {x2 > x1 && <line x1={x1} x2={x2} y1={cy} y2={cy} className="stroke-muted-foreground/50" strokeWidth={2} />}
                <circle
                  cx={xFor(r.medianRate)}
                  cy={cy}
                  r={radiusFor(r.observationCount)}
                  strokeWidth={isHovered ? 2 : 0}
                  className={cn('fill-[#2a78d6] dark:fill-[#3987e5]', isHovered && 'stroke-card')}
                />
              </g>
            )
          })}
        </svg>

        {hoverRow && (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[12rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipLeftPct)
            )}
          >
            <p className="font-medium text-foreground">{hoverRow.vendorLabel}</p>
            <p className="mb-1 text-[11px] text-muted-foreground">Rank #{hoverIndex + 1} of {rows.length}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Median rate</span>
              <span className="font-mono font-semibold text-foreground">{formatINR(hoverRow.medianRate)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Range</span>
              <span className="font-mono font-semibold text-foreground">
                {formatINR(hoverRow.minRate)} – {formatINR(hoverRow.maxRate)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Observations</span>
              <span className="font-mono font-semibold text-foreground">{formatNumber(hoverRow.observationCount)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={10} height={10} aria-hidden="true">
            <circle cx={5} cy={5} r={4} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
          </svg>
          One vendor — size = observation count
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={12} height={10} aria-hidden="true">
            <line x1={6} y1={0} x2={6} y2={10} className="stroke-foreground/60" strokeWidth={1.5} />
          </svg>
          Family median (this family, all vendors)
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={16} height={4} aria-hidden="true">
            <line x1={0} y1={2} x2={16} y2={2} className="stroke-muted-foreground/50" strokeWidth={2} />
          </svg>
          Min–max range
        </span>
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={rows} getRowKey={(d) => d.vendorId} />}
    </div>
  )
}
