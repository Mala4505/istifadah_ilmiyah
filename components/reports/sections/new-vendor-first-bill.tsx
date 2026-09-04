import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { AttentionPill } from '@/components/reports/severity-badge'
import {
  NewVendorFirstBillChart,
  type NewVendorFirstBillPoint,
} from '@/components/reports/charts/new-vendor-first-bill-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatDate, formatINR, formatNumber } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import { countNewVendorFirstBillFindings, type VendorFirstBillRow } from '@/lib/reports/surfaces/vendor-dependency'

// reporting-blueprint.md B-05 — "Vendors first seen mid-event, ranked by the
// size of their opening invoice. A new vendor whose first bill is also
// their largest deserves a look." Population is every vendor whose first
// entry date is NOT the event's own earliest observed day (genuinely new
// mid-event, not just the earliest vendor in the corpus); within that, the
// finding is a vendor whose opening bill is still their largest to date.

function isNewMidEvent(row: VendorFirstBillRow): boolean {
  return row.is_new_mid_event
}

/** "6 vendors were first seen mid-event and their opening bill is already
 *  their largest — the biggest is {vendor} at {amount} on {date}." */
export function newVendorFirstBillSentence(rows: VendorFirstBillRow[]): string {
  const newMidEvent = rows.filter(isNewMidEvent)
  if (newMidEvent.length === 0) {
    return 'No vendor has been newly seen mid-event yet.'
  }
  const finding = newMidEvent.filter((r) => r.opening_bill_is_largest)
  if (finding.length === 0) {
    return `${formatNumber(newMidEvent.length)} vendor${newMidEvent.length === 1 ? ' was' : 's were'} first seen mid-event; none of their opening bills is currently their largest.`
  }
  const biggest = [...finding].sort((a, b) => b.first_entry_amount - a.first_entry_amount)[0]!
  return `${formatNumber(finding.length)} of ${formatNumber(newMidEvent.length)} vendor${newMidEvent.length === 1 ? '' : 's'} first seen mid-event has an opening bill that is already their largest — the biggest is ${
    biggest.vendor_display_name
  } at ${formatINR(biggest.first_entry_amount)} on ${formatDate(biggest.first_entry_date)}.`
}

export function NewVendorFirstBillSection({
  rows,
  error,
  compareBasis,
  previousFindingCount,
}: {
  rows: VendorFirstBillRow[]
  error: string | null
  compareBasis: CompareBasis
  previousFindingCount: number | null
}) {
  const findingCount = countNewVendorFirstBillFindings(rows)
  const previous = compareBasis === 'prior_event' ? previousFindingCount : null

  const newMidEventRows = rows.filter(isNewMidEvent).sort((a, b) => b.first_entry_amount - a.first_entry_amount)

  const points: NewVendorFirstBillPoint[] = newMidEventRows
    .filter((r) => r.first_entry_date != null)
    .map((r) => ({
      key: r.vendor_id,
      label: r.vendor_display_name,
      href: `/entries?vendor_id=${r.vendor_id}`,
      firstEntryDateMs: new Date(r.first_entry_date as string).getTime(),
      firstEntryDateLabel: formatDate(r.first_entry_date),
      firstEntryAmount: r.first_entry_amount,
      isFinding: r.opening_bill_is_largest,
    }))

  const columns: DataTableColumn<VendorFirstBillRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.vendor_display_name}
        </Link>
      ),
    },
    { key: 'firstDate', header: 'First entry date', render: (r) => formatDate(r.first_entry_date) },
    { key: 'firstAmount', header: 'First entry amount', align: 'right', render: (r) => formatINR(r.first_entry_amount) },
    { key: 'maxAmount', header: 'Largest entry to date', align: 'right', render: (r) => formatINR(r.max_entry_amount) },
    { key: 'totalSpend', header: 'Total spend', align: 'right', render: (r) => formatINR(r.total_spend) },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    {
      key: 'finding',
      header: 'Opening bill is largest',
      render: (r) => (r.opening_bill_is_largest ? <AttentionPill>⚠ Needs a look</AttentionPill> : '—'),
    },
  ]

  return (
    <ReportSection
      id="new-vendor-first-bill"
      title="New vendor, first bill"
      description="Vendors first seen mid-event (not just the earliest vendor in the corpus), ranked by the size of their opening invoice. A new vendor whose first bill is also their largest deserves a look."
      action={
        <ExportCsvButton
          filename="new-vendor-first-bill.csv"
          rowCount={newMidEventRows.length}
          csv={toCsv(newMidEventRows, [
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'First entry date', value: (r) => r.first_entry_date },
            { header: 'First entry amount', value: (r) => r.first_entry_amount },
            { header: 'Largest entry to date', value: (r) => r.max_entry_amount },
            { header: 'Total spend', value: (r) => r.total_spend },
            { header: 'Entries', value: (r) => r.entry_count },
            { header: 'Opening bill is largest', value: (r) => (r.opening_bill_is_largest ? 'Yes' : 'No') },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load new vendor first bill" description={error} />
      ) : newMidEventRows.length === 0 ? (
        <EmptyState
          title="No vendor newly seen mid-event yet"
          description="This fills in once a vendor's first entry lands after the event's own earliest recorded day."
        />
      ) : (
        <>
          <KpiTile
            label="New vendors whose opening bill is their largest"
            value={formatNumber(findingCount)}
            delta={formatDeltaVs(compareBasis, findingCount, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(findingCount, previous)}
          />
          <p className="text-sm text-muted-foreground">{newVendorFirstBillSentence(rows)}</p>
          <NewVendorFirstBillChart points={points} />
          <DataTable
            columns={columns}
            rows={newMidEventRows}
            getRowKey={(r) => r.vendor_id}
            emptyTitle="No vendor newly seen mid-event yet"
          />
        </>
      )}
    </ReportSection>
  )
}
