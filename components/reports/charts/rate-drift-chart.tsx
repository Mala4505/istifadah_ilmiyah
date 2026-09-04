'use client'

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md C-05: "Same vendor, same item, price movement week
// by week." One line per vendor×item-family series, x = ISO week, y = that
// week's median net_rate. A CATEGORICAL palette (each line is a distinct
// identity, not a position in a sequence), unlike ordinal-ramp.ts's one-hue
// ramp used elsewhere for ordered stages — muted so no single line reads as
// the screen's brand/status color. Capped at MAX_SERIES lines (sorted by
// |drift %|) so the chart stays legible; the rest are still in the "View as
// table" twin and counted in a caption.
//
// "NO second scale" (dataviz skill / blueprint §6 fix #8): when the shown
// series span very different rate magnitudes (e.g. ₹40/unit cement vs
// ₹4,000/unit pipe), a shared rupee axis makes the cheaper series flatline.
// The fix here is a toggle, not a second axis — "common index (first week =
// 100)" re-expresses every series as a fraction of its OWN first-week
// median, so every line shares one 100-based scale regardless of its rupee
// magnitude. Off by default (raw rupees is the more literal, more trusted
// reading); the caller can default it on for a specific case if needed.
//
// Structurally mirrors trend-chart.tsx: inline SVG with real numeric
// attributes for every data-driven mark (exempt from this app's style-src
// CSP constraint — see lib/reports/bar-scale.ts), a pointer-move nearest-week
// crosshair, keyboard week nav, role="img" + aria-label, and a required
// "View as table" twin so every value the chart conveys is also plain text.

export type RateDriftChartSeries = {
  key: string
  vendorName: string
  familyLabel: string
  driftPct: number | null
  points: { weekStart: string; medianRate: number }[]
}

const MAX_SERIES = 6

// Muted categorical hues, distinct from the single-hue ordinal ramp used for
// ordered sequences elsewhere in this app — series identity here has no
// inherent order, so a monotone-lightness ramp would falsely imply one.
const SERIES_COLOR_CLASSES = [
  'stroke-[#2a78d6] dark:stroke-[#5b9be8]',
  'stroke-[#c0742d] dark:stroke-[#e0975a]',
  'stroke-[#3f8f7a] dark:stroke-[#5cae98]',
  'stroke-[#9553a6] dark:stroke-[#b57bc4]',
  'stroke-[#767b3f] dark:stroke-[#9ba35a]',
  'stroke-[#6b6f76] dark:stroke-[#9aa0a8]',
] as const
const SERIES_DOT_FILL_CLASSES = [
  'fill-[#2a78d6] dark:fill-[#5b9be8]',
  'fill-[#c0742d] dark:fill-[#e0975a]',
  'fill-[#3f8f7a] dark:fill-[#5cae98]',
  'fill-[#9553a6] dark:fill-[#b57bc4]',
  'fill-[#767b3f] dark:fill-[#9ba35a]',
  'fill-[#6b6f76] dark:fill-[#9aa0a8]',
] as const

const VIEW_WIDTH = 640
const VIEW_HEIGHT = 260
const PAD = { left: 52, right: 16, top: 16, bottom: 28 }
const INNER_WIDTH = VIEW_WIDTH - PAD.left - PAD.right
const INNER_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom

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
  if (min === max) return [min - 1, min, min + 1]
  const step = niceNum((max - min) / (tickCount - 1), true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}

function weekLabel(weekStart: string): string {
  const d = new Date(weekStart)
  if (Number.isNaN(d.getTime())) return weekStart
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

export function RateDriftChart({ series }: { series: RateDriftChartSeries[] }) {
  const [hoverWeekIndex, setHoverWeekIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)
  const [indexed, setIndexed] = useState(false)

  const shown = useMemo(
    () =>
      [...series]
        .sort((a, b) => Math.abs(b.driftPct ?? 0) - Math.abs(a.driftPct ?? 0))
        .slice(0, MAX_SERIES),
    [series]
  )
  const hiddenCount = series.length - shown.length

  const weekStarts = useMemo(() => {
    const set = new Set<string>()
    for (const s of shown) for (const p of s.points) set.add(p.weekStart)
    return [...set].sort()
  }, [shown])
  const weekIndexByStart = useMemo(() => new Map(weekStarts.map((w, i) => [w, i])), [weekStarts])
  const n = weekStarts.length

  if (series.length === 0 || n === 0) return null

  // Plotted value per series per week — raw ₹, or (value / that series' own
  // first-week value) × 100 when the index toggle is on.
  const plotted = shown.map((s) => {
    const firstValue = s.points[0]?.medianRate ?? null
    const values = s.points.map((p) => ({
      index: weekIndexByStart.get(p.weekStart)!,
      raw: p.medianRate,
      value: indexed && firstValue ? (p.medianRate / firstValue) * 100 : p.medianRate,
    }))
    return { series: s, values: values.sort((a, b) => a.index - b.index) }
  })

  const allValues = plotted.flatMap((p) => p.values.map((v) => v.value))
  const ticks = niceTicks(Math.min(...allValues), Math.max(...allValues), 4)
  const domainMin = ticks[0]!
  const domainMax = ticks[ticks.length - 1]!
  const domainRange = domainMax - domainMin || 1

  const xStep = n > 1 ? INNER_WIDTH / (n - 1) : 0
  const xFor = (i: number) => (n > 1 ? PAD.left + i * xStep : PAD.left + INNER_WIDTH / 2)
  const yFor = (v: number) => PAD.top + (1 - (v - domainMin) / domainRange) * INNER_HEIGHT

  // Break each series' path into contiguous M/L segments across any missing
  // week, rather than interpolating straight through a gap (same approach as
  // trend-chart.tsx's target line).
  function pathFor(values: { index: number; value: number }[]): string {
    return values
      .map((v, order) => {
        const isContiguous = order > 0 && values[order - 1]!.index === v.index - 1
        return `${isContiguous ? 'L' : 'M'}${xFor(v.index).toFixed(2)},${yFor(v.value).toFixed(2)}`
      })
      .join(' ')
  }

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const idx = n > 1 ? Math.round(((relX - PAD.left) / INNER_WIDTH) * (n - 1)) : 0
    setHoverWeekIndex(Math.max(0, Math.min(n - 1, idx)))
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverWeekIndex((i) => Math.min(n - 1, (i ?? -1) + 1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverWeekIndex((i) => Math.max(0, (i ?? n) - 1))
    } else if (e.key === 'Escape') {
      setHoverWeekIndex(null)
    }
  }

  const tooltipPct = hoverWeekIndex != null && n > 1 ? (hoverWeekIndex / (n - 1)) * 100 : 50
  const hoverRows =
    hoverWeekIndex != null
      ? plotted
          .map((p) => ({ s: p.series, point: p.values.find((v) => v.index === hoverWeekIndex) ?? null }))
          .filter((r) => r.point != null)
      : []

  const tableColumns: DataTableColumn<{ vendor: string; family: string; week: string; medianRate: number }>[] = [
    { key: 'vendor', header: 'Vendor', render: (r) => r.vendor },
    { key: 'family', header: 'Item family', render: (r) => r.family },
    { key: 'week', header: 'Week of', render: (r) => weekLabel(r.week) },
    { key: 'rate', header: 'Median rate', align: 'right', render: (r) => formatINR(r.medianRate) },
  ]
  const tableRows = series.flatMap((s) =>
    s.points.map((p) => ({ vendor: s.vendorName, family: s.familyLabel, week: p.weekStart, medianRate: p.medianRate }))
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          width="100%"
          height={VIEW_HEIGHT}
          className="overflow-visible"
          role="img"
          aria-label={`Rate drift by week — ${formatNumber(shown.length)} vendor-item series, each a line of that week's median rate${
            indexed ? ', indexed to its own first week = 100' : ' in rupees'
          }. See the table view below for exact values.`}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverWeekIndex(null)}
          onKeyDown={handleKeyDown}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={VIEW_WIDTH - PAD.right} y1={yFor(t)} y2={yFor(t)} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={yFor(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[9px]">
                {indexed ? t.toFixed(0) : formatINR(t)}
              </text>
            </g>
          ))}

          {plotted.map((p, i) => (
            <path
              key={p.series.key}
              d={pathFor(p.values)}
              className={cn('fill-none', SERIES_COLOR_CLASSES[i % SERIES_COLOR_CLASSES.length])}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* Selective x-axis labels: first, last, hovered. */}
          {[...new Set([0, n - 1, hoverWeekIndex].filter((i): i is number => i != null))].map((i) => (
            <text key={i} x={xFor(i)} y={VIEW_HEIGHT - PAD.bottom + 16} textAnchor="middle" className="fill-muted-foreground text-[9px]">
              {weekLabel(weekStarts[i]!)}
            </text>
          ))}

          {hoverWeekIndex != null && (
            <g>
              <line
                x1={xFor(hoverWeekIndex)}
                x2={xFor(hoverWeekIndex)}
                y1={PAD.top}
                y2={VIEW_HEIGHT - PAD.bottom}
                className="stroke-foreground/30"
                strokeWidth={1}
              />
              {plotted.map((p, i) => {
                const pt = p.values.find((v) => v.index === hoverWeekIndex)
                if (!pt) return null
                return (
                  <circle
                    key={p.series.key}
                    cx={xFor(hoverWeekIndex)}
                    cy={yFor(pt.value)}
                    r={4}
                    strokeWidth={2}
                    className={cn(SERIES_DOT_FILL_CLASSES[i % SERIES_DOT_FILL_CLASSES.length], 'stroke-card')}
                  />
                )
              })}
            </g>
          )}
        </svg>

        {hoverRows.length > 0 && (
          <div
            className={cn(
              'pointer-events-none absolute top-2 z-10 min-w-[11rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">Week of {weekLabel(weekStarts[hoverWeekIndex!]!)}</p>
            {hoverRows.map((r, i) => (
              <div key={r.s.key} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <svg width={10} height={4} aria-hidden="true" className="shrink-0">
                    <line x1={0} y1={2} x2={10} y2={2} className={SERIES_COLOR_CLASSES[i % SERIES_COLOR_CLASSES.length]} strokeWidth={2} />
                  </svg>
                  <span className="truncate">{r.s.vendorName}</span>
                </span>
                <span className="font-mono font-semibold text-foreground">
                  {indexed ? `${r.point!.value.toFixed(0)}` : formatINR(r.point!.raw)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {plotted.map((p, i) => (
          <span key={p.series.key} className="flex items-center gap-1.5">
            <svg width={12} height={4} aria-hidden="true">
              <line x1={0} y1={2} x2={12} y2={2} className={SERIES_COLOR_CLASSES[i % SERIES_COLOR_CLASSES.length]} strokeWidth={2} />
            </svg>
            {p.series.vendorName} · {p.series.familyLabel}
          </span>
        ))}
      </div>

      {hiddenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(shown.length)} series with the largest week-over-week movement; {formatNumber(hiddenCount)} more{' '}
          {hiddenCount === 1 ? 'is' : 'are'} in the table.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setIndexed((v) => !v)}>
          {indexed ? 'Show ₹' : 'Common index (first week = 100)'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && (
        <DataTable columns={tableColumns} rows={tableRows} getRowKey={(r) => `${r.vendor}::${r.family}::${r.week}`} />
      )}
    </div>
  )
}
