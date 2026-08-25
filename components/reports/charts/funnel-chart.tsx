import { formatNumber } from '@/lib/reports/format'
import { ORDINAL_RAMP } from './ordinal-ramp'

// A fixed internal coordinate space for the bars' SVG geometry — real
// numeric attributes computed from data, not CSS, so this is unaffected by
// the CSP constraint that governs HTML width/position (see
// lib/reports/bar-scale.ts). `width="100%"` on the <svg> itself is a static
// Tailwind class, not a runtime-computed one, so that's fine too.
const VIEW_WIDTH = 1000
const BAR_HEIGHT = 22 // <=24px per the dataviz skill's bar-thickness cap
const RADIUS = 4 // 4px rounded data-ends, per the same spec

/**
 * Horizontal, center-anchored funnel — presentational only (no click
 * handling; a click-through belongs to whatever hosts this, same as
 * bar-list's `href` does for its rows). Widest = first stage = 100%; every
 * later stage is scaled relative to that first stage's count, not its own
 * predecessor, so the bars read as "share of the top of the funnel."
 * Drop-off between consecutive stages is still computed against the
 * immediately preceding stage, since that's the number a reader means by
 * "drop-off."
 */
export function FunnelChart({ stages }: { stages: { key: string; label: string; count: number }[] }) {
  if (stages.length === 0) return null
  const base = Math.max(1, stages[0]!.count) // stages.length > 0, checked above

  return (
    <div className="flex flex-col gap-2">
      {stages.map((stage, i) => {
        const fraction = Math.max(0, Math.min(1, stage.count / base))
        const barWidth = fraction * VIEW_WIDTH
        const barX = (VIEW_WIDTH - barWidth) / 2
        const ramp = ORDINAL_RAMP[i % ORDINAL_RAMP.length]! // modulo is always a valid index into the ramp
        const prev = i > 0 ? stages[i - 1] : null
        const dropOffPct = prev && prev.count > 0 ? ((prev.count - stage.count) / prev.count) * 100 : null

        return (
          <div key={stage.key} className="flex flex-col gap-1">
            {dropOffPct != null && dropOffPct > 0.05 && (
              <p className="text-center text-[10px] uppercase tracking-wide text-muted-foreground">
                &minus;{dropOffPct.toFixed(0)}% drop-off
              </p>
            )}
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-foreground">{stage.label}</span>
              <span className="shrink-0 font-mono text-muted-foreground">{formatNumber(stage.count)}</span>
            </div>
            <svg
              viewBox={`0 0 ${VIEW_WIDTH} ${BAR_HEIGHT}`}
              width="100%"
              height={BAR_HEIGHT}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect x={0} y={0} width={VIEW_WIDTH} height={BAR_HEIGHT} rx={RADIUS} className="fill-secondary" />
              <rect x={barX} y={0} width={barWidth} height={BAR_HEIGHT} rx={RADIUS} className={ramp.fillClass} />
            </svg>
          </div>
        )
      })}
    </div>
  )
}
