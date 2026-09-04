'use client'

import { formatNumber } from '@/lib/reports/format'

// reporting-blueprint.md D-09 -- "Histogram of invoice amounts. A spike just
// below an approval limit is deliberate splitting." A plain bucketed bar chart
// of non-void entry amounts. Bars in the "just below a recorded limit" region
// take a reserved warn colour (amber) -- always with the legend and the count
// on the bar face, never colour alone (§6 fix #5). Recorded approval limits
// are drawn as labelled vertical rules between buckets; with no limits recorded
// the chart is a bare distribution and nothing is flagged.
//
// Fixed internal viewBox with real numeric attributes for every mark (exempt
// from this app's style-src CSP constraint -- see lib/reports/bar-scale.ts).
// Pure: every prop is minimal plain data the server already bucketed, so no
// threshold constant crosses the client boundary.

export type AmountHistogramBar = {
  bucketLabel: string
  count: number
  belowThreshold: boolean
}

/** A recorded approval limit, drawn as a vertical rule immediately after
 *  `afterBucketIndex` (0-based). */
export type AmountHistogramThreshold = {
  label: string
  afterBucketIndex: number
}

const VIEW_WIDTH = 640
const VIEW_HEIGHT = 240
const PAD = { left: 40, right: 16, top: 16, bottom: 52 }

const NEUTRAL_BAR = 'fill-[#2a78d6] dark:fill-[#3987e5]'
const WARN_BAR = 'fill-amber-500 dark:fill-amber-400'

export function AmountHistogramChart({
  bars,
  thresholds = [],
}: {
  bars: AmountHistogramBar[]
  thresholds?: AmountHistogramThreshold[]
}) {
  if (bars.length === 0) return null

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right
  const innerHeight = VIEW_HEIGHT - PAD.top - PAD.bottom
  const maxCount = Math.max(1, ...bars.map((b) => b.count))
  const slot = innerWidth / bars.length
  const barWidth = Math.min(56, slot * 0.7)
  const anyFlagged = bars.some((b) => b.belowThreshold)

  const yTicks = 4
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) => Math.round((maxCount / yTicks) * i))
  const yFor = (count: number) => PAD.top + innerHeight - (count / maxCount) * innerHeight
  const xEdgeAfter = (bucketIndex: number) => PAD.left + (bucketIndex + 1) * slot

  return (
    <div className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        width="100%"
        height={VIEW_HEIGHT}
        className="overflow-visible"
        role="img"
        aria-label={`Distribution of entry amounts -- ${bars
          .map((b) => `${b.bucketLabel}: ${formatNumber(b.count)}`)
          .join(', ')}.${
          thresholds.length > 0
            ? ` Recorded approval limits: ${thresholds.map((t) => t.label).join(', ')}.`
            : ' No approval limits recorded.'
        }`}
      >
        {tickValues.map((t) => (
          <g key={`y-${t}`}>
            <line
              x1={PAD.left}
              x2={VIEW_WIDTH - PAD.right}
              y1={yFor(t)}
              y2={yFor(t)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text x={PAD.left - 6} y={yFor(t) + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">
              {formatNumber(t)}
            </text>
          </g>
        ))}

        {bars.map((b, i) => {
          const x = PAD.left + i * slot + (slot - barWidth) / 2
          const top = yFor(b.count)
          const height = PAD.top + innerHeight - top
          return (
            <g key={b.bucketLabel}>
              <title>{`${b.bucketLabel}: ${formatNumber(b.count)} entr${b.count === 1 ? 'y' : 'ies'}${
                b.belowThreshold ? ' -- within a recorded approval limit band' : ''
              }`}</title>
              <rect
                x={x}
                y={top}
                width={barWidth}
                height={Math.max(height, b.count > 0 ? 2 : 0)}
                rx={2}
                className={b.belowThreshold ? WARN_BAR : NEUTRAL_BAR}
              />
              {b.count > 0 && (
                <text x={x + barWidth / 2} y={top - 4} textAnchor="middle" className="fill-foreground text-[9px] font-medium">
                  {formatNumber(b.count)}
                </text>
              )}
              <text
                x={x + barWidth / 2}
                y={PAD.top + innerHeight + 14}
                textAnchor="middle"
                className="fill-muted-foreground text-[8px]"
              >
                {b.bucketLabel}
              </text>
            </g>
          )
        })}

        {thresholds.map((t) => {
          const x = xEdgeAfter(t.afterBucketIndex)
          return (
            <g key={`${t.label}-${t.afterBucketIndex}`}>
              <line
                x1={x}
                x2={x}
                y1={PAD.top}
                y2={PAD.top + innerHeight}
                className="stroke-red-600 dark:stroke-red-500"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <text
                x={x}
                y={PAD.top - 4}
                textAnchor="middle"
                className="fill-red-700 dark:fill-red-400 text-[8px] font-medium"
              >
                {t.label}
              </text>
            </g>
          )
        })}

        <text
          x={PAD.left + innerWidth / 2}
          y={VIEW_HEIGHT - 6}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          Entry amount
        </text>
      </svg>

      {(anyFlagged || thresholds.length > 0) && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {thresholds.length > 0 && (
            <span className="flex items-center gap-1.5">
              <svg width={14} height={12} aria-hidden="true">
                <line x1={7} y1={0} x2={7} y2={12} className="stroke-red-600 dark:stroke-red-500" strokeWidth={1.5} strokeDasharray="4 3" />
              </svg>
              Recorded approval limit
            </span>
          )}
          {anyFlagged && (
            <span className="flex items-center gap-1.5">
              <svg width={12} height={12} aria-hidden="true">
                <rect x={0} y={2} width={12} height={8} rx={2} className={WARN_BAR} />
              </svg>
              Amounts sitting just below a limit
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <svg width={12} height={12} aria-hidden="true">
              <rect x={0} y={2} width={12} height={8} rx={2} className={NEUTRAL_BAR} />
            </svg>
            All other amounts
          </span>
        </div>
      )}
    </div>
  )
}
