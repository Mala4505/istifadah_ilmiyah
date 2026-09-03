import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatDate, formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { formatDeltaVs, type MergedVendorRow } from '@/lib/reports/sections/shared'

// Vendor spend (blueprint §5.2). Ported verbatim from the former
// app/(app)/reports/page.tsx section of the same id -- the merge of the former
// separate "Vendor spend" and "Vendor concentration" sections. `/reports`
// (Explore) and `/reports/vendors` render identically.

/** Largest-vendor sentence (§6 fix #3). */
export function vendorSpendSentence(rows: MergedVendorRow[]): string {
  if (rows.length === 0) return 'No vendor spend recorded yet.'
  const top = rows[0]! // already ordered by total_amount desc (v_vendor_spend query)
  return top.pct_of_total_spend != null
    ? `${top.display_name} is the largest vendor, accounting for ${formatPercent(top.pct_of_total_spend)} of spend across ${rows.length} vendors.`
    : `${top.display_name} is the largest vendor by spend, across ${rows.length} vendors.`
}

export function VendorSpendSection({
  rows,
  error,
  concentrationError,
  compareBasis,
  previousSpendTotal,
}: {
  rows: MergedVendorRow[]
  error: string | null
  concentrationError: string | null
  compareBasis: CompareBasis
  previousSpendTotal: number | null
}) {
  const barItems: BarListItem[] = rows.slice(0, 12).map((r) => ({
    key: r.vendor_id,
    label: r.display_name,
    value: r.total_amount ?? 0,
    note: r.pct_of_total_spend != null ? `${r.pct_of_total_spend.toFixed(1)}%` : undefined,
  }))

  const columns: DataTableColumn<MergedVendorRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.display_name}
        </Link>
      ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'total', header: 'Total Amount', align: 'right', render: (r) => formatINR(r.total_amount) },
    { key: 'first', header: 'First Entry', render: (r) => formatDate(r.first_entry_date) },
    { key: 'last', header: 'Last Entry', render: (r) => formatDate(r.last_entry_date) },
    { key: 'coverage', header: 'Doc Coverage', align: 'right', render: (r) => formatPercent(r.document_coverage_pct) },
    {
      key: 'pct',
      header: '% of Total Spend',
      align: 'right',
      render: (r) => (r.pct_of_total_spend != null ? `${r.pct_of_total_spend.toFixed(2)}%` : '—'),
    },
    {
      key: 'flags',
      header: 'Open Flags',
      align: 'right',
      render: (r) =>
        r.open_flag_count > 0 ? (
          <Link href={`/reports#compliance`} className="text-primary underline-offset-2 hover:underline">
            {formatNumber(r.open_flag_count)}
          </Link>
        ) : (
          formatNumber(r.open_flag_count)
        ),
    },
    { key: 'risk', header: '₹ at Risk', align: 'right', render: (r) => formatINR(r.open_flag_amount_at_risk) },
  ]

  const spendTotal = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  const previous = compareBasis === 'prior_event' ? previousSpendTotal : null

  return (
    <ReportSection
      id="vendor-spend"
      title="Vendor spend"
      description="Entry count, total spend, document coverage, share of total spend, and open-flag exposure per vendor. Merged from the former separate 'Vendor spend' and 'Vendor concentration' sections, which ranked the same vendors by the same spend (§5.2)."
      action={
        <ExportCsvButton
          filename="vendor-spend.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Vendor', value: (r) => r.display_name },
            { header: 'Entries', value: (r) => r.entry_count },
            { header: 'Total Amount', value: (r) => r.total_amount },
            { header: 'First Entry Date', value: (r) => r.first_entry_date },
            { header: 'Last Entry Date', value: (r) => r.last_entry_date },
            { header: 'Document Coverage %', value: (r) => r.document_coverage_pct },
            { header: '% of Total Spend', value: (r) => r.pct_of_total_spend },
            { header: 'Open Flags', value: (r) => r.open_flag_count },
            { header: '₹ at Risk', value: (r) => r.open_flag_amount_at_risk },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load vendor spend" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No vendor spend yet" description="Vendors are created automatically as entries import." />
      ) : (
        <>
          {concentrationError && (
            <p className="text-xs text-destructive">
              {concentrationError} — % of total spend, open flags, and ₹ at risk below may be incomplete.
            </p>
          )}
          <KpiTile
            label="Total vendor spend"
            value={formatINRCompact(spendTotal)}
            delta={formatDeltaVs(compareBasis, spendTotal, previous, 'inr')}
            deltaTone="neutral"
          />
          <BarList items={barItems} valueFormatter={formatINRCompact} />
          <p className="text-sm text-muted-foreground">{vendorSpendSentence(rows)}</p>
          <DataTable columns={columns} rows={rows} getRowKey={(r) => r.vendor_id} />
        </>
      )}
    </ReportSection>
  )
}
