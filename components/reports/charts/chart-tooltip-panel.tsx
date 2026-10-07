import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { barLeftClass } from '@/lib/reports/bar-scale'

// Hover tooltip for the /reports charts that stay hand-drawn SVG (matrices,
// strip / dumbbell / ranking plots, timeline, network). Matches the look of
// shadcn's ChartTooltipContent (components/ui/chart.tsx) so a Recharts chart
// and a custom chart on the same page read as one system: rounded-lg, hairline
// border, background surface, xs text, font-medium label, a colour indicator
// square per row and a mono tabular value.
//
// Plain module (no 'use client', no hooks) — only ever rendered from inside a
// client chart component. Position comes from barLeftClass (a literal Tailwind
// left-% class snapped to 5%), so the tooltip needs no inline style.

export function ChartTooltipPanel({
  leftPct,
  title,
  subtitle,
  className,
  children,
}: {
  /** Horizontal anchor as a % of the chart wrapper's width (clamped 0–100). */
  leftPct: number
  title: ReactNode
  subtitle?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-1 z-10 grid min-w-[8rem] -translate-x-1/2 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl',
        barLeftClass(leftPct),
        className
      )}
    >
      <div className="grid gap-0.5">
        <div className="font-medium text-foreground">{title}</div>
        {subtitle ? <div className="text-muted-foreground">{subtitle}</div> : null}
      </div>
      {children ? <div className="grid gap-1.5">{children}</div> : null}
    </div>
  )
}

export function ChartTooltipRow({
  label,
  value,
  indicatorClass,
}: {
  label: ReactNode
  value: ReactNode
  /** Literal Tailwind background class(es) for the indicator square, e.g.
   *  'bg-[#2a78d6] dark:bg-[#3987e5]'. Omit for a row with no series colour. */
  indicatorClass?: string
}) {
  return (
    <div className="flex w-full items-center gap-2">
      {indicatorClass ? <div className={cn('h-2.5 w-2.5 shrink-0 rounded-[2px]', indicatorClass)} /> : null}
      <div className="flex flex-1 items-center justify-between gap-3 leading-none">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium tabular-nums text-foreground">{value}</span>
      </div>
    </div>
  )
}

export function ChartTooltipNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('leading-snug text-muted-foreground', className)}>{children}</p>
}
