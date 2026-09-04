import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { VendorScorecardGrid, type ScorecardGridVendor } from '@/components/reports/charts/vendor-scorecard-grid'
import { toCsv } from '@/lib/reports/csv'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  PRICE_POSITION_TOLERANCE,
  priceIsAboveBenchmark,
  vendorNeedsAttention,
  type VendorScorecardRow,
} from '@/lib/reports/surfaces/vendor-scorecard'

// reporting-blueprint.md B-02 — vendor scorecard. "One card per vendor:
// spend, share, price against our benchmark, discount given, document
// quality, GSTIN validity, flag history. A supplier rating you could put in
// front of the supplier." Headline = vendors that need a look this event:
// priced above our own benchmark, or carrying an open flag.

function gstinStatusLabel(status: VendorScorecardRow['gstin_status']): string {
  if (status === 'valid') return 'Valid'
  if (status === 'flagged') return 'Flagged'
  return 'Missing'
}

function priceLabel(row: VendorScorecardRow): string {
  if (row.avg_price_ratio == null) return 'No benchmark'
  const ratio = `${row.avg_price_ratio.toFixed(2)}×`
  if (priceIsAboveBenchmark(row)) return `${ratio} above`
  if (row.avg_price_ratio < 1 - PRICE_POSITION_TOLERANCE) return `${ratio} below`
  return `${ratio} near`
}

/** "N of M vendors are priced above our own benchmark or carry an open flag
 *  — led by {vendor} at {ratio}× median and {count} open flags." (§6 fix #3) */
export function vendorScorecardSentence(rows: VendorScorecardRow[]): string {
  if (rows.length === 0) return 'No vendor spend recorded yet this event.'
  const attention = rows.filter(vendorNeedsAttention)
  if (attention.length === 0) {
    return `All ${formatNumber(rows.length)} vendors are priced at or within ${Math.round(
      PRICE_POSITION_TOLERANCE * 100
    )}% of our own benchmark this event, with no open flags.`
  }
  const lead = [...attention].sort(
    (a, b) => b.open_flag_count - a.open_flag_count || (b.avg_price_ratio ?? 0) - (a.avg_price_ratio ?? 0)
  )[0]!
  const bits: string[] = []
  if (lead.avg_price_ratio != null && priceIsAboveBenchmark(lead)) bits.push(`${lead.avg_price_ratio.toFixed(2)}× our median`)
  if (lead.open_flag_count > 0) bits.push(`${formatNumber(lead.open_flag_count)} open flag${lead.open_flag_count === 1 ? '' : 's'}`)
  const leadDetail = bits.length > 0 ? ` — led by ${lead.display_name} at ${bits.join(' and ')}` : ` — led by ${lead.display_name}`
  return `${formatNumber(attention.length)} of ${formatNumber(
    rows.length
  )} vendors are priced above our own benchmark or carry an open flag this event${leadDetail}.`
}

export function VendorScorecardSection({
  rows,
  error,
  compareBasis,
  previousAttentionCount,
}: {
  rows: VendorScorecardRow[]
  error: string | null
  compareBasis: CompareBasis
  previousAttentionCount: number | null
}) {
  const attention = rows.filter(vendorNeedsAttention)
  const previous = compareBasis === 'prior_event' ? previousAttentionCount : null

  const gridVendors: ScorecardGridVendor[] = rows.map((r) => ({
    vendorId: r.vendor_id,
    vendorName: r.display_name,
    spend: r.total_amount ?? 0,
    sharePct: r.pct_of_total_spend,
    priceRatio: r.avg_price_ratio,
    pricedObservationCount: r.priced_observation_count,
    gstinStatus: r.gstin_status,
    docCoveragePct: r.document_coverage_pct,
    openFlagCount: r.open_flag_count,
    flagHistoryCount: r.flag_history_count,
  }))

  const columns: DataTableColumn<VendorScorecardRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.display_name}
        </Link>
      ),
    },
    { key: 'spend', header: 'Spend', align: 'right', render: (r) => formatINRCompact(r.total_amount) },
    { key: 'share', header: 'Share', align: 'right', render: (r) => formatPercent(r.pct_of_total_spend) },
    { key: 'price', header: 'Price vs benchmark', render: (r) => priceLabel(r) },
    { key: 'docs', header: 'Doc coverage', align: 'right', render: (r) => formatPercent(r.document_coverage_pct) },
    { key: 'gstin', header: 'GSTIN', render: (r) => gstinStatusLabel(r.gstin_status) },
    { key: 'flags', header: 'Open flags', align: 'right', render: (r) => formatNumber(r.open_flag_count) },
  ]

  return (
    <ReportSection
      id="vendor-scorecard"
      title="Vendor scorecard"
      description="One row per vendor — spend, share, price against our own benchmark, document coverage, GSTIN validity and flag history. A supplier rating you could put in front of the supplier."
      action={
        <ExportCsvButton
          filename="vendor-scorecard.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Vendor', value: (r) => r.display_name },
            { header: 'Spend', value: (r) => r.total_amount },
            { header: 'Share %', value: (r) => r.pct_of_total_spend },
            { header: 'Avg price ratio vs benchmark', value: (r) => r.avg_price_ratio },
            { header: 'Priced observations', value: (r) => r.priced_observation_count },
            { header: 'Avg discount %', value: (r) => r.avg_discount_pct },
            { header: 'Discount observations', value: (r) => r.discount_observation_count },
            { header: 'Document coverage %', value: (r) => r.document_coverage_pct },
            { header: 'GSTIN', value: (r) => r.gstin },
            { header: 'GSTIN status', value: (r) => r.gstin_status },
            { header: 'Open flags', value: (r) => r.open_flag_count },
            { header: 'Open flag ₹ at risk', value: (r) => r.open_flag_amount_at_risk },
            { header: 'Flag history (all statuses)', value: (r) => r.flag_history_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the vendor scorecard" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No vendor spend yet"
          description="Vendors are created automatically as entries import — this fills in once entries exist for the selected event."
        />
      ) : (
        <>
          <KpiTile
            label="Vendors needing a look"
            value={formatNumber(attention.length)}
            delta={formatDeltaVs(compareBasis, attention.length, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(attention.length, previous)}
          />
          <p className="text-sm text-muted-foreground">{vendorScorecardSentence(rows)}</p>
          <VendorScorecardGrid vendors={gridVendors} />
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => r.vendor_id}
            emptyTitle="No vendor spend yet"
          />
        </>
      )}
    </ReportSection>
  )
}
