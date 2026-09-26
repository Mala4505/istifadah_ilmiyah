import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import type { VendorAdvancePositionRow } from '@/lib/reports/surfaces/entry-type-flow'

// "How much has this vendor been given as an advance, and how much do we
// still owe them" -- a live sum per vendor, not a per-transaction link. See
// v_vendor_advance_position's own header (20260926000005) for why summing is
// correct here even when one final invoice closes out several advances at
// once: the arithmetic only needs the totals, not which specific advance
// paid for which specific invoice.

export function VendorAdvancePositionSection({
  rows,
  error,
  insight,
}: {
  rows: VendorAdvancePositionRow[]
  error: string | null
  insight?: string | null
}) {
  const withAdvance = rows.filter((r) => r.advance_count > 0)
  const totalGiven = withAdvance.reduce((s, r) => s + r.advance_given, 0)
  const totalOwed = withAdvance.reduce((s, r) => s + r.balance_owed, 0)
  const awaitingCount = withAdvance.filter((r) => r.settlement_count === 0).length

  const tableRows = [...withAdvance].sort((a, b) => b.advance_given - a.advance_given)

  const columns: DataTableColumn<VendorAdvancePositionRow>[] = [
    { key: 'vendor', header: 'Vendor', render: (r) => r.vendor_display_name },
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.department_id != null ? (
          <Link href={`/entries?dept=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.department_name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'given', header: 'Advance Given', align: 'right', render: (r) => formatINR(r.advance_given) },
    { key: 'advances', header: 'Advances', align: 'right', render: (r) => formatNumber(r.advance_count) },
    {
      key: 'owed',
      header: 'Balance Owed',
      align: 'right',
      render: (r) =>
        r.settlement_count === 0 ? (
          <span className="text-muted-foreground">Awaiting final invoice</span>
        ) : (
          formatINR(r.balance_owed)
        ),
    },
    { key: 'settlements', header: 'Settled', align: 'right', render: (r) => formatNumber(r.settlement_count) },
  ]

  return (
    <ReportSection
      id="vendor-advance-position"
      title="Vendor advance position"
      description="What each vendor has been given as an advance, and what's still owed once their work is finalised into an invoice — summed per vendor, not linked transaction-by-transaction. A vendor showing 'Awaiting final invoice' has no settled invoice yet, so nothing is owed against it yet either."
      action={
        <ExportCsvButton
          filename="vendor-advance-position.csv"
          rowCount={tableRows.length}
          csv={toCsv(tableRows, [
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Advance given', value: (r) => r.advance_given },
            { header: 'Advance count', value: (r) => r.advance_count },
            { header: 'Balance owed', value: (r) => r.balance_owed },
            { header: 'Settlement count', value: (r) => r.settlement_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load vendor advance position" description={error} />
      ) : tableRows.length === 0 ? (
        <EmptyState
          title="No advances this event"
          description="Vendors with an advance-payment entry appear here for the selected event."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile label="Given as advances" value={formatINRCompact(totalGiven)} />
            <KpiTile label="Still owed (finalised)" value={formatINRCompact(totalOwed)} />
            <KpiTile label="Awaiting final invoice" value={formatNumber(awaitingCount)} />
          </div>
          <p className="text-sm text-muted-foreground">{insight}</p>
          <DataTable columns={columns} rows={tableRows} getRowKey={(r) => `${r.department_id}:${r.vendor_key}`} />
        </>
      )}
    </ReportSection>
  )
}
