import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { SpendCurveChart, type SpendCurvePoint } from '@/components/reports/charts/spend-curve-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatDate } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import type { WeeklySpendCurveRow } from '@/lib/reports/surfaces/spend-curve-open-ageing'

// reporting-blueprint.md A-11 — "Weekly spend across the event with the peak
// marked. Tells you when the pressure lands — and when to staff for it next
// year." Per-week (non-cumulative) bars, the peak week highlighted, the
// weekly mean as a reference line. NOT the cumulative spend-pace chart.

/** "The busiest week was the week of {date} at ₹X — N× the ₹Y weekly mean
 *  and M% of the whole event's spend." (§6 fix #3) */
export function spendCurveSentence(
  rows: WeeklySpendCurveRow[],
  peakWeekStart: string | null,
  peakWeekAmount: number,
  meanWeeklyAmount: number,
  peakMultipleOfMean: number | null,
  totalSpend: number
): string {
  if (rows.length === 0) return 'No dated spend recorded for this event yet.'
  if (!peakWeekStart || peakWeekAmount <= 0) return 'No spend has landed in any week of this event yet.'
  const multiple = peakMultipleOfMean != null ? `${peakMultipleOfMean.toFixed(1)}× the ${formatINR(meanWeeklyAmount)} weekly mean` : null
  const share = totalSpend > 0 ? `${Math.round((peakWeekAmount / totalSpend) * 100)}% of the event's total spend` : null
  const tail = [multiple, share].filter(Boolean).join(', and ')
  return `The busiest week was the week of ${formatDate(peakWeekStart)} at ${formatINR(peakWeekAmount)}${tail ? ` — ${tail}` : ''}.`
}

export function SpendCurveSection({
  rows,
  error,
  compareBasis,
  totalSpend,
  eventWeekCount,
  peakWeekStart,
  peakWeekAmount,
  meanWeeklyAmount,
  peakMultipleOfMean,
  previousPeakWeekAmount,
}: {
  rows: WeeklySpendCurveRow[]
  error: string | null
  compareBasis: CompareBasis
  totalSpend: number
  eventWeekCount: number
  peakWeekStart: string | null
  peakWeekAmount: number
  meanWeeklyAmount: number
  peakMultipleOfMean: number | null
  previousPeakWeekAmount: number | null
}) {
  const points: SpendCurvePoint[] = rows.map((r) => ({
    weekStart: r.week_start,
    amount: r.total_amount,
    isPeak: peakWeekStart != null && r.week_start === peakWeekStart,
  }))

  const multipleLabel = peakMultipleOfMean != null ? `, ${peakMultipleOfMean.toFixed(1)}× the weekly mean` : ''

  return (
    <ReportSection
      id="spend-curve"
      title="Spend curve & peak weeks"
      description="Weekly spend across the event with the peak week marked — when the pressure lands, and when to staff for it next year."
      action={
        <ExportCsvButton
          filename="spend-curve.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Week of', value: (r) => r.week_start },
            { header: 'Entries', value: (r) => r.entry_count },
            { header: 'Spend', value: (r) => r.total_amount },
            { header: 'Is peak week', value: (r) => (r.week_start === r.peak_week_start ? 'yes' : 'no') },
            { header: 'Weekly mean (event)', value: (r) => r.mean_weekly_amount },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the spend curve" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No dated spend yet"
          description="Weeks appear here once entries with a date exist for the selected event."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <KpiTile
              label={peakWeekStart ? `Peak week — week of ${formatDate(peakWeekStart)}` : 'Peak week'}
              value={formatINRCompact(peakWeekAmount)}
              delta={formatDeltaVs(compareBasis, peakWeekAmount, previousPeakWeekAmount, 'inr')}
              deltaTone={deltaToneHigherIsBad(peakWeekAmount, previousPeakWeekAmount)}
            />
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <p className="truncate text-xs text-muted-foreground">Total event spend</p>
              <Link
                href="/entries"
                className="font-sans text-2xl font-semibold tracking-tight text-primary underline-offset-2 hover:underline"
              >
                {formatINRCompact(totalSpend)}
              </Link>
              <p className="text-xs text-muted-foreground">
                over {formatNumber(eventWeekCount)} weeks{peakWeekStart ? `, peak week of ${formatDate(peakWeekStart)}` : ''}
                {multipleLabel}
              </p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {spendCurveSentence(rows, peakWeekStart, peakWeekAmount, meanWeeklyAmount, peakMultipleOfMean, totalSpend)}
          </p>
          <SpendCurveChart points={points} meanAmount={meanWeeklyAmount} />
        </>
      )}
    </ReportSection>
  )
}
