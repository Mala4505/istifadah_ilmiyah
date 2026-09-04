import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { BenfordChart, type BenfordDigitDatum } from '@/components/reports/charts/benford-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatNumber } from '@/lib/reports/format'
import { cn } from '@/lib/utils'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  benfordConformity,
  type BenfordConformity,
  type BenfordDigitRow,
} from '@/lib/reports/surfaces/amount-forensics'

// reporting-blueprint.md D-07 — Benford's Law digit test. "Leading-digit
// distribution of all amounts against the expected curve. A standard forensic
// test that needs no new data and reads as rigorous to any auditor or
// trustee." Headline = the event-level MAD statistic and its Nigrini
// conformity verdict; the chart shows where the observed distribution departs
// from Benford's expected curve.

const TONE_BADGE_CLASS: Record<BenfordConformity['tone'], string> = {
  good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  bad: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  neutral: 'bg-secondary text-secondary-foreground',
}

/** The digit whose observed share is furthest from its Benford expectation. */
function widestDeviation(rows: BenfordDigitRow[]): BenfordDigitRow | null {
  const usable = rows.filter((r) => r.total_count > 0)
  if (usable.length === 0) return null
  return [...usable].sort((a, b) => Math.abs(b.deviation_pct) - Math.abs(a.deviation_pct))[0]!
}

/** "Leading digits conform to Benford's curve — the widest gap is digit 3, at
 *  12.1% vs an expected 12.5%." / "Leading digits deviate from Benford's
 *  curve — digit 1 appears 38.0% vs an expected 30.1%." (§6 fix #3) */
export function benfordSentence(rows: BenfordDigitRow[], mad: number | null): string {
  const worst = widestDeviation(rows)
  if (worst == null || mad == null) {
    return 'Not enough entry amounts this event to run the leading-digit test.'
  }
  const conforms = benfordConformity(mad).tone === 'good'
  const verb = conforms ? 'conform to' : 'deviate from'
  const framing = conforms ? 'the widest gap is' : 'the widest gap is at'
  return `Leading digits ${verb} Benford's expected curve — ${framing} digit ${worst.leading_digit}, appearing ${worst.observed_pct.toFixed(
    1
  )}% against an expected ${worst.expected_pct.toFixed(1)}%.`
}

export function BenfordDigitTestSection({
  rows,
  error,
  mad,
  conformity,
  totalCount,
  compareBasis,
  previousMad,
}: {
  rows: BenfordDigitRow[]
  error: string | null
  mad: number | null
  conformity: BenfordConformity
  totalCount: number
  compareBasis: CompareBasis
  previousMad: number | null
}) {
  const chartData: BenfordDigitDatum[] = [...rows]
    .sort((a, b) => a.leading_digit - b.leading_digit)
    .map((r) => ({ digit: r.leading_digit, observedPct: r.observed_pct, expectedPct: r.expected_pct }))

  const madDisplay = mad == null ? '—' : mad.toFixed(4)
  // MAD lower is better (closer to Benford). A rising MAD vs the prior event
  // is the bad direction; formatDeltaVs wants counts/inr, so render the delta
  // by hand at 4dp precision.
  const madDelta =
    compareBasis === 'prior_event' && previousMad != null && mad != null
      ? `${mad > previousMad ? '+' : mad < previousMad ? '−' : '±'}${Math.abs(mad - previousMad).toFixed(4)} vs prior event`
      : undefined
  const madDeltaTone =
    compareBasis === 'prior_event' && previousMad != null && mad != null
      ? mad > previousMad
        ? 'bad'
        : mad < previousMad
          ? 'good'
          : 'neutral'
      : 'neutral'

  return (
    <ReportSection
      id="benford-digit-test"
      title="Benford's Law digit test"
      description="The leading digit of every entry amount, distributed against Benford's expected curve. A standard forensic screen — an organic set of real invoice amounts follows the curve closely; a set that has been constructed or capped does not."
      action={
        <ExportCsvButton
          filename="benford-leading-digit.csv"
          rowCount={rows.length}
          csv={toCsv([...rows].sort((a, b) => a.leading_digit - b.leading_digit), [
            { header: 'Leading digit', value: (r) => r.leading_digit },
            { header: 'Observed count', value: (r) => r.observed_count },
            { header: 'Window total', value: (r) => r.total_count },
            { header: 'Observed %', value: (r) => r.observed_pct },
            { header: 'Benford expected %', value: (r) => r.expected_pct },
            { header: 'Deviation (pp)', value: (r) => r.deviation_pct },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the Benford test" description={error} />
      ) : rows.length === 0 || totalCount === 0 ? (
        <EmptyState
          title="Not enough amounts yet"
          description="The leading-digit test needs entry amounts of ₹1 or more for the selected event."
        />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <KpiTile
              label="Mean absolute deviation (MAD) from Benford"
              value={madDisplay}
              delta={madDelta}
              deltaTone={madDeltaTone}
            />
            <span
              className={cn(
                'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                TONE_BADGE_CLASS[conformity.tone]
              )}
            >
              {conformity.verdict}
            </span>
            <p className="text-xs text-muted-foreground">
              Across{' '}
              <Link href="/entries" className="text-primary underline-offset-2 hover:underline">
                {formatNumber(totalCount)} entry amounts
              </Link>{' '}
              of ₹1 or more. Nigrini bands: MAD below 0.006 is close conformity, 0.006–0.012 acceptable, 0.012–0.015
              marginal, above 0.015 nonconformity.
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{benfordSentence(rows, mad)}</p>
          <BenfordChart data={chartData} />
        </>
      )}
    </ReportSection>
  )
}
