import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsGood, formatDeltaVs } from '@/lib/reports/sections/shared'
import type { HsnGstAnomalyRow } from '@/lib/reports/surfaces/hsn-gst-anomaly'

// reporting-blueprint.md C-10 -- HSN coverage & GST anomaly. Two independent
// halves: coverage (works with no rate table) and anomaly (needs hsn_gst_rate
// populated). The section renders both, and degrades the anomaly half to an
// explanatory line when the rate table is empty -- its normal state today.

const entriesVendorHref = (name: string) => `/entries?vendor=${encodeURIComponent(name)}`

/** "N of M billed rupees (X%) carry an HSN/SAC code; of the K bills where the
 *  charged GST rate can be compared to the codes' expected rate, J depart from
 *  it." (§6 fix #3) */
export function hsnGstAnomalySentence(
  rows: HsnGstAnomalyRow[],
  coveragePct: number | null,
  billsWithBothRates: number,
  anomalyCount: number,
  hsnRateTableEmpty: boolean
): string {
  if (rows.length === 0) return 'No bills with line items recorded yet for this event.'
  const coverageBit =
    coveragePct == null
      ? 'No billed spend to measure coverage against yet'
      : `${formatPercent(coveragePct)} of billed spend carries an HSN or SAC code`
  if (hsnRateTableEmpty) {
    return `${coverageBit}. Load an HSN-to-rate table to check charged GST against the rate each code implies.`
  }
  if (billsWithBothRates === 0) {
    return `${coverageBit}. No bill yet has both a matched code rate and a computable charged rate, so no GST comparison is possible.`
  }
  return `${coverageBit}. Of ${formatNumber(billsWithBothRates)} bill${
    billsWithBothRates === 1 ? '' : 's'
  } where the charged GST rate can be compared to the codes' expected rate, ${formatNumber(anomalyCount)} depart${
    anomalyCount === 1 ? 's' : ''
  } from it.`
}

export function HsnGstAnomalySection({
  rows,
  error,
  hsnRateTableEmpty,
  coveragePct,
  previousCoveragePct,
  anomalyCount,
  billsWithBothRates,
  compareBasis,
}: {
  rows: HsnGstAnomalyRow[]
  error: string | null
  hsnRateTableEmpty: boolean
  coveragePct: number | null
  previousCoveragePct: number | null
  anomalyCount: number
  billsWithBothRates: number
  compareBasis: CompareBasis
}) {
  const previous = compareBasis === 'prior_event' ? previousCoveragePct : null

  const tableRows = [...rows].sort((a, b) => {
    if (a.is_anomaly !== b.is_anomaly) return a.is_anomaly ? -1 : 1
    return Math.abs(b.rate_gap_pp ?? 0) - Math.abs(a.rate_gap_pp ?? 0) || (b.billed_amount ?? 0) - (a.billed_amount ?? 0)
  })

  const columns: DataTableColumn<HsnGstAnomalyRow>[] = [
    {
      key: 'bill',
      header: 'Bill',
      render: (r) =>
        r.entry_id ? (
          <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
            #{r.entry_id}
          </Link>
        ) : (
          `bill ${r.bill_id}`
        ),
    },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendor_display_name ? (
          <Link href={entriesVendorHref(r.vendor_display_name)} className="text-primary underline-offset-2 hover:underline">
            {r.vendor_display_name}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.department_id != null ? (
          <Link href={`/entries?dept=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.department_name ?? `#${r.department_id}`}
          </Link>
        ) : (
          '—'
        ),
    },
    { key: 'lines', header: 'Lines', align: 'right', render: (r) => formatNumber(r.line_count) },
    {
      key: 'coverage',
      header: 'HSN coverage',
      align: 'right',
      render: (r) => `${formatNumber(r.lines_with_hsn)}/${formatNumber(r.line_count)} (${formatPercent(r.hsn_coverage_pct)})`,
    },
    {
      key: 'implied',
      header: 'Implied rate',
      align: 'right',
      render: (r) => (r.implied_gst_rate != null ? `${r.implied_gst_rate}%` : '—'),
    },
    {
      key: 'charged',
      header: 'Charged rate',
      align: 'right',
      render: (r) => (r.charged_gst_rate != null ? `${r.charged_gst_rate}%` : '—'),
    },
    {
      key: 'gap',
      header: 'Gap (pp)',
      align: 'right',
      render: (r) => {
        if (r.rate_gap_pp == null) return '—'
        const s = r.rate_gap_pp > 0 ? '+' : r.rate_gap_pp < 0 ? '−' : '±'
        return (
          <span className={r.is_anomaly ? 'font-medium text-red-700 dark:text-red-300' : undefined}>
            {s}
            {Math.abs(r.rate_gap_pp)}
          </span>
        )
      },
    },
    { key: 'billed', header: 'Billed ₹', align: 'right', render: (r) => formatINRCompact(r.billed_amount) },
  ]

  return (
    <ReportSection
      id="hsn-gst-anomaly"
      title="HSN coverage & GST anomaly"
      description="Which bills carry an HSN or SAC code on their lines, and — once an HSN-to-rate table is loaded — where the GST charged on the bill departs from the rate those codes imply."
      action={
        <ExportCsvButton
          filename="hsn-gst-anomaly.csv"
          rowCount={rows.length}
          csv={toCsv(tableRows, [
            { header: 'Bill ID', value: (r) => r.bill_id },
            { header: 'Entry ID', value: (r) => r.entry_id },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Line count', value: (r) => r.line_count },
            { header: 'Lines with HSN/SAC', value: (r) => r.lines_with_hsn },
            { header: 'HSN coverage %', value: (r) => r.hsn_coverage_pct },
            { header: 'Lines matched to rate table', value: (r) => r.lines_matched },
            { header: 'Implied GST rate %', value: (r) => r.implied_gst_rate },
            { header: 'Charged GST rate %', value: (r) => r.charged_gst_rate },
            { header: 'Rate gap (pp)', value: (r) => r.rate_gap_pp },
            { header: 'Anomaly', value: (r) => (r.is_anomaly ? 'yes' : 'no') },
            { header: 'Taxable value', value: (r) => r.taxable_value },
            { header: 'Tax amount', value: (r) => r.tax_amount },
            { header: 'Billed amount', value: (r) => r.billed_amount },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load HSN coverage" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No billed line items yet"
          description="This fills in as bills are read and their line items verified for the selected event."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <KpiTile
              label="Billed spend carrying an HSN/SAC code"
              value={coveragePct == null ? '—' : formatPercent(coveragePct)}
              delta={coveragePct == null ? undefined : formatDeltaVs(compareBasis, coveragePct, previous, 'count')}
              deltaTone={deltaToneHigherIsGood(coveragePct ?? 0, previous)}
            />
            {hsnRateTableEmpty ? (
              <div className="flex flex-col justify-center rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                Load an HSN→rate table (settings) to enable the GST anomaly check. Coverage above works without it.
              </div>
            ) : (
              <KpiTile
                label="Bills where charged GST departs from the code's rate"
                value={formatNumber(anomalyCount)}
                delta={`of ${formatNumber(billsWithBothRates)} comparable`}
                deltaTone={anomalyCount > 0 ? 'bad' : 'good'}
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {hsnGstAnomalySentence(rows, coveragePct, billsWithBothRates, anomalyCount, hsnRateTableEmpty)}
          </p>
          <DataTable columns={columns} rows={tableRows} getRowKey={(r) => r.bill_id} />
        </>
      )}
    </ReportSection>
  )
}
