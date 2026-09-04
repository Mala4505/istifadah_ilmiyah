import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { RateDriftChart, type RateDriftChartSeries } from '@/components/reports/charts/rate-drift-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import { RATE_DRIFT_FLAG_PCT, type RateDriftSeries } from '@/lib/reports/surfaces/rate-drift-discount'

// reporting-blueprint.md C-05 — "Same vendor, same item, price movement week
// by week. Detects mid-event escalation while there is still time to act."
// Only vendor×item-family pairs the loader already gated to >= 2 distinct
// weeks reach this component — a single week is a price, not a trend.

function drifting(series: RateDriftSeries[]): RateDriftSeries[] {
  return series.filter((s) => s.driftPct != null && s.driftPct >= RATE_DRIFT_FLAG_PCT)
}

/** "Across N vendor-item pairs tracked over 2+ weeks this event, M have
 *  climbed 15 percentage points or more since their first week — led by
 *  {vendor} · {family} at +X%." (§6 fix #3) */
export function rateDriftSentence(series: RateDriftSeries[]): string {
  if (series.length === 0) {
    return 'No vendor and item family has been purchased in two or more different weeks yet this event — a price trend needs at least two weeks to compare.'
  }
  const flagged = drifting(series)
  const base = `Across ${formatNumber(series.length)} vendor-item pair${series.length === 1 ? '' : 's'} tracked over 2+ weeks this event`
  if (flagged.length === 0) {
    return `${base}, none has climbed ${RATE_DRIFT_FLAG_PCT} percentage points or more since its first week.`
  }
  const lead = [...flagged].sort((a, b) => (b.driftPct ?? 0) - (a.driftPct ?? 0))[0]!
  return `${base}, ${formatNumber(flagged.length)} ${flagged.length === 1 ? 'has' : 'have'} climbed ${RATE_DRIFT_FLAG_PCT} percentage points or more since its first week — led by ${lead.vendorName} · ${lead.familyLabel} at ${lead.driftPct! > 0 ? '+' : ''}${lead.driftPct!.toFixed(1)}%.`
}

export function RateDriftSection({
  series,
  error,
  compareBasis,
  previousDriftingCount,
}: {
  series: RateDriftSeries[]
  error: string | null
  compareBasis: CompareBasis
  previousDriftingCount: number | null
}) {
  const flagged = drifting(series)
  const previous = compareBasis === 'prior_event' ? previousDriftingCount : null

  const chartSeries: RateDriftChartSeries[] = series.map((s) => ({
    key: s.key,
    vendorName: s.vendorName,
    familyLabel: s.familyLabel,
    driftPct: s.driftPct,
    points: s.weeks.map((w) => ({ weekStart: w.weekStart, medianRate: w.medianRate })),
  }))

  const tableRows = [...series].sort((a, b) => (b.driftPct ?? -Infinity) - (a.driftPct ?? -Infinity))

  const columns: DataTableColumn<RateDriftSeries>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendorId ? (
          <Link href={`/entries?vendor_id=${r.vendorId}`} className="text-primary underline-offset-2 hover:underline">
            {r.vendorName}
          </Link>
        ) : (
          r.vendorName
        ),
    },
    { key: 'family', header: 'Item family', render: (r) => r.familyLabel },
    { key: 'weeks', header: 'Weeks tracked', align: 'right', render: (r) => formatNumber(r.weeks.length) },
    { key: 'first', header: 'First week median', align: 'right', render: (r) => formatINR(r.firstWeekMedian) },
    { key: 'last', header: 'Last week median', align: 'right', render: (r) => formatINR(r.lastWeekMedian) },
    {
      key: 'drift',
      header: 'Drift',
      align: 'right',
      render: (r) => (r.driftPct == null ? '—' : formatPercent(r.driftPct)),
    },
  ]

  return (
    <ReportSection
      id="rate-drift"
      title="Rate drift across the event"
      description="Same vendor, same item family, priced week by week against its own first-week median — the escalation this catches while there is still time to renegotiate. Only vendor-item pairs purchased in two or more distinct weeks are comparable."
      action={
        <ExportCsvButton
          filename="rate-drift.csv"
          rowCount={series.length}
          csv={toCsv(series, [
            { header: 'Vendor', value: (r) => r.vendorName },
            { header: 'Item family', value: (r) => r.familyLabel },
            { header: 'Weeks tracked', value: (r) => r.weeks.length },
            { header: 'First week median', value: (r) => r.firstWeekMedian },
            { header: 'Last week median', value: (r) => r.lastWeekMedian },
            { header: 'Drift %', value: (r) => r.driftPct },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load rate drift" description={error} />
      ) : series.length === 0 ? (
        <EmptyState
          title="Not enough weeks yet"
          description="This needs the same vendor and item family purchased in two or more distinct weeks this event, so a week-over-week trend exists to plot. It fills in as the event goes on."
        />
      ) : (
        <>
          <KpiTile
            label={`Pairs drifting ≥ ${RATE_DRIFT_FLAG_PCT}%`}
            value={formatNumber(flagged.length)}
            delta={formatDeltaVs(compareBasis, flagged.length, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(flagged.length, previous)}
          />
          <p className="text-sm text-muted-foreground">{rateDriftSentence(series)}</p>
          <RateDriftChart series={chartSeries} />
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => r.key}
            emptyTitle="No vendor-item pair tracked yet"
          />
        </>
      )}
    </ReportSection>
  )
}
