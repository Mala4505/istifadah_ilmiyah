'use client'

import { formatNumber } from '@/lib/reports/format'

// reporting-blueprint.md D-05 -- "Distribution of the gap between the entry
// amount and the bill's own total. Most sit at zero; the tail is the report."
// A plain bucketed bar chart of gap-as-percent-of-entry. The "No gap" bar
// dominates by design; the reserved critical-status colour lands ONLY on the
// buckets the loader marked material (a gap over the medium-severity rupee bar
// or over ~1% of the entry) -- §6 fix #5: status colour, always with a label,
// never a plain series hue and never the sole signal (the bucket label and the
// count on the face of each bar carry it without colour).
//
// Fixed internal viewBox with real numeric attributes for every bar (exempt
// from this app's style-src CSP constraint -- see lib/reports/bar-scale.ts).
// Pure: the only prop is minimal plain data the server already bucketed, so no
// threshold constant crosses the client boundary.

export type GapDistributionBar = { bucketLabel: string; count: number; material: boolean }

const VIEW_WIDTH = 600
const VIEW_HEIGHT = 220
const PAD = { left: 40, right: 16, top: 16, bottom: 40 }

export function GapDistributionChart({ bars }: { bars: GapDistributionBar[] }) {
  if (bars.length === 0) return null

  const innerWidth = VIEW_WIDTH - PAD.left - PAD.right
  const innerHeight = VIEW_HEIGHT - PAD.top - PAD.bottom
  const maxCount = Math.max(1, ...bars.map((b) => b.count))
  const slot = innerWidth / bars.length
  const barWidth = Math.min(64, slot * 0.7)
  const anyMaterial = bars.some((b) => b.material)

  const yTicks = 4
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) => Math.round((maxCount / yTicks) * i))

  const yFor = (count: number) => PAD.top + innerHeight - (count / maxCount) * innerHeight

  return (
    <div className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        width="100%"
        height={VIEW_HEIGHT}
        className="overflow-visible"
        role="img"
        aria-label={`Reconciliation gap distribution -- ${bars
          .map((b) => `${b.bucketLabel}: ${formatNumber(b.count)}`)
          .join(', ')}. Bars flagged material: ${
          bars
            .filter((b) => b.material)
            .map((b) => b.bucketLabel)
            .join(', ') || 'none'
        }.`}
      >
        {/* Y gridlines + labels. */}
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
                b.material ? ' -- material gap' : ''
              }`}</title>
              <rect
                x={x}
                y={top}
                width={barWidth}
                height={Math.max(height, b.count > 0 ? 2 : 0)}
                rx={2}
                className={
                  b.material
                    ? 'fill-red-600 dark:fill-red-500'
                    : 'fill-[#2a78d6] dark:fill-[#3987e5]'
                }
              />
              {b.count > 0 && (
                <text
                  x={x + barWidth / 2}
                  y={top - 4}
                  textAnchor="middle"
                  className="fill-foreground text-[9px] font-medium"
                >
                  {formatNumber(b.count)}
                </text>
              )}
              <text
                x={x + barWidth / 2}
                y={PAD.top + innerHeight + 14}
                textAnchor="middle"
                className="fill-muted-foreground text-[9px]"
              >
                {b.bucketLabel}
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
          Gap as a share of the entry amount
        </text>
      </svg>

      {anyMaterial && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <svg width={12} height={12} aria-hidden="true">
              <rect x={0} y={2} width={12} height={8} rx={2} className="fill-red-600 dark:fill-red-500" />
            </svg>
            Material gap (over ₹10,000 or ~1% of the entry)
          </span>
          <span className="flex items-center gap-1.5">
            <svg width={12} height={12} aria-hidden="true">
              <rect x={0} y={2} width={12} height={8} rx={2} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
            </svg>
            Within tolerance
          </span>
        </div>
      )}
    </div>
  )
}
