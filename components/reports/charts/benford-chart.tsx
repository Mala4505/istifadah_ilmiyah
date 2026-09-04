'use client'

import { useState, type PointerEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'

// reporting-blueprint.md D-07 — Benford's Law leading-digit test. "Leading-digit
// distribution of all amounts against the expected curve." Observed share is
// drawn as bars; Benford's expected curve is drawn as a single overlaid line
// with a marker per digit. Both series are percentages on ONE shared 0..max
// scale — never a dual axis (§6 fix #8): the whole point is to read the bar
// tops against the line.
//
// Colour: bars are the one accent hue by default. A bar whose observed share
// sits far enough from its expected value gets a reserved status colour
// (amber = notable, red = large) so the eye lands on the digits that actually
// break from the curve — always paired with the deviation number in the
// tooltip and table, never colour alone (§6 fix #5). The reserved-colour
// thresholds are a per-digit visual aid only; the actual conformity verdict
// is the event-level MAD statistic shown in the KPI above this chart.
//
// Structurally mirrors trend-chart.tsx / department-dependency-chart.tsx:
// inline SVG with real numeric attributes for every data-driven mark (exempt
// from this app's style-src CSP constraint — see lib/reports/bar-scale.ts), a
// pointer/keyboard hover layer, an SVG <title> per digit as a no-JS fallback,
// role="img" + aria-label, and a required "View as table" twin so every value
// the chart conveys is also plain text.

export type BenfordDigitDatum = {
  digit: number
  observedPct: number
  expectedPct: number
}

// Per-digit deviation thresholds, in percentage POINTS of |observed − expected|.
// Duplicated here as a literal rather than imported from the loader: this is a
// 'use client' module and the loader transitively imports next/headers via
// @/lib/supabase/server, so a value import from it would break the client
// bundle (types are erased and safe, runtime values are not). Kept small and
// commented so the two definitions stay honest.
const DIGIT_DEVIATION_WARN_PP = 2
const DIGIT_DEVIATION_BAD_PP = 4

const ACCENT_BAR = 'fill-[#2a78d6] dark:fill-[#3987e5]'
const WARN_BAR = 'fill-amber-500 dark:fill-amber-400'
const BAD_BAR = 'fill-red-600 dark:fill-red-500'

function barClassFor(deviationPp: number): string {
  const abs = Math.abs(deviationPp)
  if (abs >= DIGIT_DEVIATION_BAD_PP) return BAD_BAR
  if (abs >= DIGIT_DEVIATION_WARN_PP) return WARN_BAR
  return ACCENT_BAR
}

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 240
const PAD = { left: 40, right: 16, top: 16, bottom: 34 }
const INNER_WIDTH = VIEW_WIDTH - PAD.left - PAD.right
const INNER_HEIGHT = VIEW_HEIGHT - PAD.top - PAD.bottom

function niceCeil(v: number): number {
  if (v <= 5) return 5
  if (v <= 10) return 10
  if (v <= 15) return 15
  if (v <= 20) return 20
  if (v <= 25) return 25
  if (v <= 35) return 35
  return Math.ceil(v / 10) * 10
}

export function BenfordChart({ data }: { data: BenfordDigitDatum[] }) {
  const [hoverDigit, setHoverDigit] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  if (data.length === 0) return null

  const sorted = [...data].sort((a, b) => a.digit - b.digit)
  const domainMax = niceCeil(Math.max(...sorted.flatMap((d) => [d.observedPct, d.expectedPct])))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * domainMax))

  const slot = INNER_WIDTH / sorted.length
  const barWidth = slot * 0.62
  const xCentre = (i: number) => PAD.left + slot * i + slot / 2
  const yFor = (pct: number) => PAD.top + (1 - pct / domainMax) * INNER_HEIGHT

  const expectedPath = sorted
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${xCentre(i).toFixed(2)},${yFor(d.expectedPct).toFixed(2)}`)
    .join(' ')

  const anyWarn = sorted.some((d) => Math.abs(d.observedPct - d.expectedPct) >= DIGIT_DEVIATION_WARN_PP)

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const i = Math.floor((relX - PAD.left) / slot)
    setHoverDigit(i >= 0 && i < sorted.length ? sorted[i]!.digit : null)
  }
  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    const idx = sorted.findIndex((d) => d.digit === hoverDigit)
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverDigit(sorted[Math.min(sorted.length - 1, idx + 1)]!.digit)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverDigit(sorted[Math.max(0, idx === -1 ? sorted.length - 1 : idx - 1)]!.digit)
    } else if (e.key === 'Escape') {
      setHoverDigit(null)
    }
  }

  const hoverIndex = hoverDigit != null ? sorted.findIndex((d) => d.digit === hoverDigit) : -1
  const hover = hoverIndex >= 0 ? sorted[hoverIndex]! : null
  const tooltipLeftPct = hover ? (xCentre(hoverIndex) / VIEW_WIDTH) * 100 : 50

  const tableColumns: DataTableColumn<BenfordDigitDatum>[] = [
    { key: 'digit', header: 'Leading digit', render: (d) => d.digit },
    { key: 'observed', header: 'Observed %', align: 'right', render: (d) => `${d.observedPct.toFixed(1)}%` },
    { key: 'expected', header: 'Benford expected %', align: 'right', render: (d) => `${d.expectedPct.toFixed(1)}%` },
    {
      key: 'deviation',
      header: 'Deviation (pp)',
      align: 'right',
      render: (d) => {
        const dev = d.observedPct - d.expectedPct
        return `${dev > 0 ? '+' : dev < 0 ? '−' : '±'}${Math.abs(dev).toFixed(1)}`
      },
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          width="100%"
          height={VIEW_HEIGHT}
          className="overflow-visible"
          role="img"
          aria-label="Benford's Law leading-digit test — bars are the observed share of entry amounts starting with each digit 1 to 9, the line is Benford's expected curve. Both are percentages on one scale. See the table view below for exact values."
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverDigit(null)}
          onKeyDown={handleKeyDown}
        >
          {/* Y gridlines + labels (hairline, solid — never dashed). */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={VIEW_WIDTH - PAD.right}
                y1={yFor(t)}
                y2={yFor(t)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={yFor(t)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[9px]"
              >
                {t}%
              </text>
            </g>
          ))}

          {/* Observed bars. */}
          {sorted.map((d, i) => {
            const isHover = hoverDigit === d.digit
            const dev = d.observedPct - d.expectedPct
            const y = yFor(d.observedPct)
            return (
              <g key={d.digit}>
                <title>{`Digit ${d.digit}: ${d.observedPct.toFixed(1)}% observed vs ${d.expectedPct.toFixed(1)}% expected`}</title>
                <rect
                  x={(xCentre(i) - barWidth / 2).toFixed(2)}
                  y={y.toFixed(2)}
                  width={barWidth.toFixed(2)}
                  height={Math.max(0, PAD.top + INNER_HEIGHT - y).toFixed(2)}
                  rx={2}
                  strokeWidth={isHover ? 1.5 : 0}
                  className={cn(barClassFor(dev), isHover && 'stroke-foreground')}
                />
                <text
                  x={xCentre(i).toFixed(2)}
                  y={VIEW_HEIGHT - PAD.bottom + 14}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {d.digit}
                </text>
              </g>
            )
          })}

          {/* Benford expected curve — one muted line + markers, drawn over the bars. */}
          <path
            d={expectedPath}
            className="fill-none stroke-foreground/70"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {sorted.map((d, i) => (
            <circle
              key={d.digit}
              cx={xCentre(i).toFixed(2)}
              cy={yFor(d.expectedPct).toFixed(2)}
              r={2.5}
              className="fill-foreground/70"
            />
          ))}

          <text
            x={PAD.left + INNER_WIDTH / 2}
            y={VIEW_HEIGHT - 6}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            Leading digit of the entry amount
          </text>
        </svg>

        {hover && (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[12rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipLeftPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">Leading digit {hover.digit}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Observed</span>
              <span className="font-mono font-semibold text-foreground">{hover.observedPct.toFixed(1)}%</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Benford expected</span>
              <span className="font-mono font-semibold text-foreground">{hover.expectedPct.toFixed(1)}%</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Deviation</span>
              <span className="font-mono font-semibold text-foreground">
                {(() => {
                  const dev = hover.observedPct - hover.expectedPct
                  return `${dev > 0 ? '+' : dev < 0 ? '−' : '±'}${Math.abs(dev).toFixed(1)} pp`
                })()}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width={12} height={10} aria-hidden="true">
            <rect x={2} y={0} width={8} height={10} rx={1} className={ACCENT_BAR} />
          </svg>
          Observed share
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={14} height={10} aria-hidden="true">
            <line x1={0} y1={5} x2={14} y2={5} className="stroke-foreground/70" strokeWidth={2} />
          </svg>
          Benford expected
        </span>
        {anyWarn && (
          <>
            <span className="flex items-center gap-1.5">
              <svg width={12} height={10} aria-hidden="true">
                <rect x={2} y={0} width={8} height={10} rx={1} className={WARN_BAR} />
              </svg>
              ≥ {DIGIT_DEVIATION_WARN_PP} pp off
            </span>
            <span className="flex items-center gap-1.5">
              <svg width={12} height={10} aria-hidden="true">
                <rect x={2} y={0} width={8} height={10} rx={1} className={BAD_BAR} />
              </svg>
              ≥ {DIGIT_DEVIATION_BAD_PP} pp off
            </span>
          </>
        )}
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={sorted} getRowKey={(d) => d.digit} />}
    </div>
  )
}
