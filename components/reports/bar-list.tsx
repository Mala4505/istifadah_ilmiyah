import Link from 'next/link'
import { formatINRCompact } from '@/lib/reports/format'
import { barWidthClass, barLeftClass } from '@/lib/reports/bar-scale'
import { cn } from '@/lib/utils'

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
  const computedMax = max ?? Math.max(1, ...items.map((i) => Math.max(i.value, i.marker ?? 0)))

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => {
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
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary">
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
    </div>
  )
}
