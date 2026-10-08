import Link from 'next/link'
import { formatINRCompact } from '@/lib/reports/format'
import { barWidthClass, barLeftClass } from '@/lib/reports/bar-scale'
import { cn } from '@/lib/utils'
import { outlierScale } from '@/lib/reports/outlier-scale'

export type BarListItem = {
  key: string | number
  label: string
  value: number
  href?: string
  /** A secondary reference point (e.g. approved budget) rendered as a tick, not a second hue — keeps the mark on one axis. */
  marker?: number | null
  markerLabel?: string
  note?: string
  /**
   * Optional per-item override for the bar's fill — a literal Tailwind
   * `bg-[...]` class (with a `dark:bg-[...]` pair), e.g. one of
   * severity-badge.tsx's status colors, for callers that need to color-code
   * individual bars by status rather than rank. Omit to keep today's single
   * fixed accent hue.
   */
  colorClass?: string
}

/**
 * Horizontal bar list — the dataviz skill's plain-CSS option for a simple
 * magnitude comparison, avoiding a new charting dependency for report
 * sections that are really "rank these N things by ₹". One sequential hue
 * (blue, per the palette's `references/palette.md`), rounded data-ends,
 * thin track.
 */
export function BarList({
  items,
  max,
  valueFormatter = formatINRCompact,
}: {
  items: BarListItem[]
  max?: number
  valueFormatter?: (v: number) => string
}) {
  if (items.length === 0) return null
  // Broken axis (lib/reports/outlier-scale.ts): when one or two rows dwarf the
  // rest, cap the scale just above the next-largest so the others stay
  // readable; capped rows fill the track and carry a ⫽ break mark. The value
  // text is always the true figure. Callers passing an explicit `max` (e.g. a
  // fixed 100% scale) opt out.
  const extents = items.map((i) => Math.max(i.value, i.marker ?? 0))
  const scale = max == null ? outlierScale(extents) : { cap: null, outlierCount: 0 }
  const computedMax = max ?? scale.cap ?? Math.max(1, ...extents)

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => {
        const clipped = scale.cap != null && item.value > scale.cap
        const pct = Math.max(0, Math.min(100, (item.value / computedMax) * 100))
        const markerPct =
          item.marker != null ? Math.max(0, Math.min(100, (item.marker / computedMax) * 100)) : null
        const body = (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-foreground">{item.label}</span>
              <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-muted-foreground">
                {valueFormatter(item.value)}
                {item.note && (
                  <span className="text-[10px] font-sans uppercase tracking-wide text-muted-foreground/70">
                    {item.note}
                  </span>
                )}
              </span>
            </div>
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
              {/* Width/position come from a build-time Tailwind class, never an
                  inline style attribute — see lib/reports/bar-scale.ts for why:
                  production CSP's style-src has no 'unsafe-inline'. */}
              <div
                className={cn(
                  'h-full rounded-full',
                  item.colorClass ?? 'bg-[#2a78d6] dark:bg-[#3987e5]',
                  barWidthClass(pct)
                )}
              />
              {markerPct != null && (
                <div
                  className={cn('absolute top-0 h-1.5 w-0.5 bg-foreground/70', barLeftClass(markerPct))}
                  title={item.markerLabel}
                />
              )}
              {clipped && (
                // ⫽ break mark: two slanted cuts in the card colour near the end.
                <span aria-hidden="true" className="absolute inset-y-0 right-2.5 flex gap-[3px]">
                  <span className="h-full w-[2px] skew-x-[-30deg] bg-card" />
                  <span className="h-full w-[2px] skew-x-[-30deg] bg-card" />
                </span>
              )}
            </div>
          </div>
        )
        return item.href ? (
          <Link
            key={item.key}
            href={item.href}
            className="rounded-sm transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </Link>
        ) : (
          <div key={item.key}>{body}</div>
        )
      })}
      {scale.cap != null && (
        <p className="text-xs text-muted-foreground">
          Scale capped at {valueFormatter(scale.cap)} so smaller rows stay readable; {scale.outlierCount === 1 ? 'the bar' : 'bars'}{' '}
          marked ⫽ {scale.outlierCount === 1 ? 'runs' : 'run'} past it — {scale.outlierCount === 1 ? 'its' : 'their'} figure{scale.outlierCount === 1 ? ' is' : 's are'} exact.
        </p>
      )}
    </div>
  )
}
