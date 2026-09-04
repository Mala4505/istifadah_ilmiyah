import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import {
  AmountHistogramChart,
  type AmountHistogramThreshold,
} from '@/components/reports/charts/amount-histogram-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import type {
  ActiveThreshold,
  AmountHistogramBucket,
  SplittingFlagRow,
} from '@/lib/reports/surfaces/threshold-splitting'

// reporting-blueprint.md D-09 -- Threshold splitting. Histogram of non-void
// entry amounts. When approval limits are recorded, each is drawn as a rule
// and the buckets just below it are flagged (a spike there = deliberate
// splitting). When none are recorded -- the state today -- the histogram still
// renders and the section says an admin must add limits in settings; the
// existing vendor_splitting flags (which fire in concentration mode, needing
// no limit) are surfaced regardless.

/** Map recorded limits onto bucket edges for the chart's vertical rules. */
function chartThresholds(
  active: ActiveThreshold[],
  buckets: AmountHistogramBucket[]
): AmountHistogramThreshold[] {
  return active.map((t) => {
    let afterBucketIndex = -1
    for (let i = 0; i < buckets.length; i++) {
      const max = buckets[i]!.max
      if (max != null && max <= t.minAmount) afterBucketIndex = i
    }
    return { label: formatINRCompact(t.minAmount), afterBucketIndex }
  })
}

/** "1,203 non-void amounts this event. No approval limits recorded, so no
 *  split-detection." / "... Two limits recorded; 34 amounts sit in the band
 *  just below ₹1L." (§6 fix #3) */
export function thresholdSplittingSentence(
  entryCount: number,
  active: ActiveThreshold[],
  buckets: AmountHistogramBucket[],
  splittingFlagCount: number
): string {
  if (entryCount === 0) return 'No non-void entry amounts recorded yet for this event.'
  const base = `${formatNumber(entryCount)} non-void amount${entryCount === 1 ? '' : 's'} this event`
  if (active.length === 0) {
    const flagBit =
      splittingFlagCount > 0
        ? ` The pattern detector has raised ${formatNumber(splittingFlagCount)} vendor-splitting flag${
            splittingFlagCount === 1 ? '' : 's'
          } on concentration alone.`
        : ''
    return `${base}. No approval limits are recorded, so a spike below a limit can't be detected — add limits in settings to enable it.${flagBit}`
  }
  const flaggedCount = buckets.filter((b) => b.belowThreshold).reduce((s, b) => s + b.count, 0)
  return `${base}. ${formatNumber(active.length)} approval limit${
    active.length === 1 ? '' : 's'
  } recorded; ${formatNumber(flaggedCount)} amount${flaggedCount === 1 ? '' : 's'} sit in the band just below a limit — worth checking for deliberate splitting.`
}

export function ThresholdSplittingSection({
  activeThresholds,
  thresholdError,
  histogram,
  entryCount,
  entriesError,
  splittingFlags,
  splittingFlagsError,
}: {
  activeThresholds: ActiveThreshold[]
  thresholdError: string | null
  histogram: AmountHistogramBucket[]
  entryCount: number
  entriesError: string | null
  splittingFlags: SplittingFlagRow[]
  splittingFlagsError: string | null
}) {
  const bars = histogram.map((b) => ({
    bucketLabel: b.bucketLabel,
    count: b.count,
    belowThreshold: b.belowThreshold,
  }))
  const thresholds = chartThresholds(activeThresholds, histogram)

  const histogramColumns: DataTableColumn<AmountHistogramBucket>[] = [
    { key: 'bucket', header: 'Amount band', render: (b) => b.bucketLabel },
    { key: 'count', header: 'Entries', align: 'right', render: (b) => formatNumber(b.count) },
    { key: 'total', header: 'Total ₹', align: 'right', render: (b) => formatINRCompact(b.totalAmount) },
    {
      key: 'flag',
      header: 'Below a limit',
      render: (b) => (b.belowThreshold ? 'yes' : '—'),
    },
  ]

  const flagColumns: DataTableColumn<SplittingFlagRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (f) =>
        f.vendor_display_name ? (
          <Link
            href={`/entries?vendor=${encodeURIComponent(f.vendor_display_name)}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {f.vendor_display_name}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'department',
      header: 'Department',
      render: (f) =>
        f.department_id != null ? (
          <Link href={`/entries?dept=${f.department_id}`} className="text-primary underline-offset-2 hover:underline">
            {f.department_name ?? `#${f.department_id}`}
          </Link>
        ) : (
          '—'
        ),
    },
    { key: 'severity', header: 'Severity', render: (f) => f.severity ?? '—' },
    { key: 'at_risk', header: 'At risk ₹', align: 'right', render: (f) => formatINRCompact(f.amount_at_risk ?? 0) },
    {
      key: 'bills',
      header: 'Bills',
      align: 'right',
      render: (f) => formatNumber(f.related_entry_ids?.length ?? 0),
    },
    { key: 'description', header: 'Detail', render: (f) => f.description ?? '—' },
  ]

  return (
    <ReportSection
      id="threshold-splitting"
      title="Threshold splitting"
      description="Distribution of non-void entry amounts. Where an approval limit is recorded, a cluster of bills sitting just below it is a sign that spend is being split to stay under sign-off."
      action={
        <ExportCsvButton
          filename="threshold-splitting-histogram.csv"
          rowCount={histogram.length}
          csv={toCsv(histogram, [
            { header: 'Amount band', value: (b) => b.bucketLabel },
            { header: 'Entries', value: (b) => b.count },
            { header: 'Total amount', value: (b) => b.totalAmount },
            { header: 'Below a recorded limit', value: (b) => (b.belowThreshold ? 'yes' : 'no') },
          ])}
        />
      }
    >
      {entriesError ? (
        <EmptyState title="Couldn't load entry amounts" description={entriesError} />
      ) : entryCount === 0 ? (
        <EmptyState
          title="No entry amounts yet"
          description="This fills in once non-void entries with an amount exist for the selected event."
        />
      ) : (
        <>
          <KpiTile label="Non-void amounts" value={formatNumber(entryCount)} />
          {thresholdError && (
            <p className="text-xs text-red-700 dark:text-red-300">Approval limits couldn&apos;t be loaded: {thresholdError}</p>
          )}
          {activeThresholds.length === 0 && (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              No approval thresholds recorded — add them in settings to enable split-detection. The histogram below is shown
              for reference, and any existing vendor-splitting flags are listed underneath.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {thresholdSplittingSentence(entryCount, activeThresholds, histogram, splittingFlags.length)}
          </p>
          <AmountHistogramChart bars={bars} thresholds={thresholds} />

          {activeThresholds.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recorded approval limits</p>
              <ul className="text-sm text-muted-foreground">
                {activeThresholds.map((t) => (
                  <li key={`${t.departmentId ?? 'org'}-${t.minAmount}`}>
                    {formatINR(t.minAmount)} → {t.escalatesTo}
                    {t.departmentName ? ` (${t.departmentName})` : ' (org-wide)'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <DataTable columns={histogramColumns} rows={histogram} getRowKey={(b) => b.bucketLabel} />

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Vendor-splitting flags {splittingFlags.length > 0 ? `(${formatNumber(splittingFlags.length)})` : ''}
            </p>
            {splittingFlagsError ? (
              <p className="text-xs text-red-700 dark:text-red-300">{splittingFlagsError}</p>
            ) : splittingFlags.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No open vendor-splitting flags — the pattern detector has found no vendor billed repeatedly just under a
                concentration threshold.
              </p>
            ) : (
              <DataTable columns={flagColumns} rows={splittingFlags} getRowKey={(f) => f.id} />
            )}
          </div>
        </>
      )}
    </ReportSection>
  )
}
