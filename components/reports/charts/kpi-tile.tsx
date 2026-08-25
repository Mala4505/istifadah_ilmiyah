import { Sparkline } from './sparkline'
import { cn } from '@/lib/utils'

// Status-role text colors reused from severity-badge.tsx's palette (emerald
// good / red bad), not invented — see that file's header comment for why
// these specific steps.
const DELTA_TONE_CLASS: Record<'good' | 'bad' | 'neutral', string> = {
  good: 'text-emerald-800 dark:text-emerald-300',
  bad: 'text-red-700 dark:text-red-300',
  neutral: 'text-muted-foreground',
}

/**
 * Stat tile for the Reports overview band. Follows the dataviz skill's
 * stat-tile contract: `value` stays in the body sans (never a display/serif
 * face — h1-h6 in this app pull `font-display`, a serif, via globals.css, so
 * this is explicit rather than incidental) with the font's default
 * proportional figures (no `tabular-nums` — that's reserved for numbers that
 * must align in a column, and a standalone tile value isn't one).
 */
export function KpiTile({
  label,
  value,
  delta,
  deltaTone = 'neutral',
  series,
}: {
  label: string
  value: string
  delta?: string
  deltaTone?: 'good' | 'bad' | 'neutral'
  series?: number[]
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="font-sans text-2xl font-semibold tracking-tight text-foreground">{value}</p>
          {delta && <p className={cn('text-xs font-medium', DELTA_TONE_CLASS[deltaTone])}>{delta}</p>}
        </div>
        {series && series.length >= 2 && (
          <div className="shrink-0 pt-1">
            <Sparkline values={series} />
          </div>
        )}
      </div>
    </div>
  )
}
