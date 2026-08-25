'use client'

import { cn } from '@/lib/utils'
import { formatNumber, formatPercent } from '@/lib/reports/format'

const SIZE = 120
// >=24px per the dataviz skill's hover-target minimum — since this ring's
// own stroke width doubles as its hit area (no separate invisible hit
// layer), the visible mark itself needs to clear that floor.
const STROKE_WIDTH = 24
const RADIUS = (SIZE - STROKE_WIDTH) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
// 2px surface gap between segments, per the dataviz skill's mark spec —
// the same mechanism as bar-list's stacked-segment gap, expressed in arc
// length instead of a CSS gap.
const SEGMENT_GAP = 2

export type DonutSegment = {
  key: string
  label: string
  value: number
  /**
   * A literal Tailwind `stroke-[...]` class (with a `dark:stroke-[...]`
   * pair) — see components/reports/charts/ordinal-ramp.ts for a ready-made
   * ramp of these. Deliberately stroke-only rather than a combined
   * fill+stroke string: this component draws every colored mark (the ring
   * segments, the legend swatches) as an unfilled, stroked SVG circle, so a
   * `fill-[...]` class living in the same string could collide in the
   * compiled stylesheet with the `fill-none` this component sets to keep
   * the ring hollow (arbitrary-value utility ordering isn't guaranteed to
   * follow class-attribute order). Keeping the contract stroke-only avoids
   * that collision entirely rather than relying on a load order.
   */
  colorClass: string
}

export function DonutChart({
  segments,
  centerLabel,
  selectedKey,
  onSelect,
}: {
  segments: DonutSegment[]
  centerLabel?: string
  selectedKey?: string | null
  onSelect?: (key: string) => void
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  if (segments.length === 0 || total <= 0) return null

  let cursor = 0
  const arcs = segments.map((s) => {
    const fraction = s.value / total
    const startFraction = cursor
    cursor += fraction
    return { ...s, fraction, startFraction }
  })

  function select(key: string) {
    onSelect?.(key)
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        {/* width/height here are fixed constants (SIZE), not a runtime-computed
            percentage, so a plain style attribute is fine under this app's CSP
            constraint — see lib/reports/bar-scale.ts's header comment; that
            constraint targets values computed per-instance from data (widths,
            positions), not a component-wide fixed pixel size. */}
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} className="-rotate-90" aria-hidden="true">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE_WIDTH} className="fill-none stroke-secondary" />
          {arcs.map((arc) => {
            const dash = Math.max(0, arc.fraction * CIRCUMFERENCE - SEGMENT_GAP)
            const isSelected = selectedKey === arc.key
            const isDimmed = selectedKey != null && !isSelected
            return (
              <circle
                key={arc.key}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                strokeWidth={STROKE_WIDTH}
                strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                strokeDashoffset={-arc.startFraction * CIRCUMFERENCE}
                strokeLinecap="butt"
                className={cn('fill-none transition-opacity', arc.colorClass, isDimmed && 'opacity-40', onSelect && 'cursor-pointer')}
                role={onSelect ? 'button' : undefined}
                tabIndex={onSelect ? 0 : undefined}
                aria-label={onSelect ? `${arc.label}: ${formatNumber(arc.value)}` : undefined}
                onClick={onSelect ? () => select(arc.key) : undefined}
                onKeyDown={
                  onSelect
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          select(arc.key)
                        }
                      }
                    : undefined
                }
              >
                <title>{`${arc.label}: ${formatNumber(arc.value)} (${formatPercent(arc.fraction * 100)})`}</title>
              </circle>
            )
          })}
        </svg>
        {centerLabel && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center">
            <span className="text-sm font-medium text-foreground">{centerLabel}</span>
          </div>
        )}
      </div>
      {/* A legend is always rendered (2+ segments per the dataviz skill's rule)
          with every value directly labeled — identity is never color-only. */}
      <ul className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {arcs.map((arc) => {
          const isSelected = selectedKey === arc.key
          return (
            <li key={arc.key}>
              <button
                type="button"
                onClick={onSelect ? () => select(arc.key) : undefined}
                disabled={!onSelect}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors disabled:cursor-default',
                  onSelect && 'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected && 'bg-accent/60'
                )}
              >
                <svg width={10} height={10} viewBox="0 0 10 10" className="shrink-0" aria-hidden="true">
                  <circle cx={5} cy={5} r={4} strokeWidth={2} className={cn('fill-none', arc.colorClass)} />
                </svg>
                <span className="flex-1 truncate text-foreground">{arc.label}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {formatNumber(arc.value)} · {formatPercent(arc.fraction * 100)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
