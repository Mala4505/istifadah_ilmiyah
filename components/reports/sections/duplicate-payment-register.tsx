import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { ClusterStatusBadge } from '@/components/reports/severity-badge'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatDate } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsGood, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  preventedAmount,
  preventedClusterCount,
  statusBreakdown,
  type DuplicatePaymentClusterRow,
} from '@/lib/reports/surfaces/duplicate-vendor-risk'

// reporting-blueprint.md §8 Phase Six — D-04 "Duplicate payment register".
// "The same bill paid twice — matched by document hash, and by vendor +
// invoice number + amount. Reported as RUPEES PREVENTED." One row per
// duplicate-payment CLUSTER (a flags.flag_type='duplicate_payment' row + the
// entries it ties together). The headline is framed as money SAVED — every
// cluster a reviewer has not dismissed is a double payment that did not go
// out — so it takes the reserved 'good' delta tone, not the "higher is worse"
// tone the other Integrity findings use.

function statusLabel(status: DuplicatePaymentClusterRow['status']): string {
  if (status === 'confirmed') return 'Confirmed duplicate'
  if (status === 'dismissed') return 'Dismissed — legitimate'
  return 'Open — awaiting review'
}

function windowLabel(row: DuplicatePaymentClusterRow): string {
  if (!row.first_entry_date && !row.last_entry_date) return '—'
  if (row.first_entry_date === row.last_entry_date) return formatDate(row.first_entry_date)
  return `${formatDate(row.first_entry_date)} – ${formatDate(row.last_entry_date)}`
}

/** "₹X across N duplicate clusters has been prevented this event — ₹Y confirmed
 *  by a reviewer, ₹Z still open. {lead vendor} accounts for the largest single
 *  cluster at ₹W." (§6 fix #3) */
export function duplicatePaymentRegisterSentence(rows: DuplicatePaymentClusterRow[]): string {
  if (rows.length === 0) {
    return 'No duplicate-payment clusters have been detected for this event — nothing has been billed twice by the same vendor inside the detection window.'
  }
  const prevented = preventedAmount(rows)
  const clusters = preventedClusterCount(rows)
  const b = statusBreakdown(rows)
  const lead = [...rows].sort((a, z) => (z.duplicate_amount ?? 0) - (a.duplicate_amount ?? 0))[0]!
  const leadText =
    lead.vendor_display_name != null
      ? ` ${lead.vendor_display_name} accounts for the largest single cluster at ${formatINRCompact(lead.duplicate_amount)}.`
      : ''
  return (
    `${formatINRCompact(prevented)} across ${formatNumber(clusters)} duplicate ` +
    `cluster${clusters === 1 ? '' : 's'} has been prevented this event — ` +
    `${formatINRCompact(b.confirmedAmount)} confirmed by a reviewer, ${formatINRCompact(b.openAmount)} still open.` +
    leadText
  )
}

export function DuplicatePaymentRegisterSection({
  rows,
  error,
  compareBasis,
  previousPreventedAmount,
}: {
  rows: DuplicatePaymentClusterRow[]
  error: string | null
  compareBasis: CompareBasis
  previousPreventedAmount: number | null
}) {
  const prevented = preventedAmount(rows)
  const clusters = preventedClusterCount(rows)
  const b = statusBreakdown(rows)
  const previous = compareBasis === 'prior_event' ? previousPreventedAmount : null

  const columns: DataTableColumn<DuplicatePaymentClusterRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendor_display_name != null ? (
          <Link
            href={`/entries?vendor=${encodeURIComponent(r.vendor_display_name)}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {r.vendor_display_name}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'entries',
      header: 'Entries',
      render: (r) =>
        r.entry_ids.length > 0 ? (
          <span className="flex flex-wrap gap-x-2">
            {r.entry_ids.map((id) => (
              <Link
                key={id}
                href={`/entries/${id}`}
                className="text-primary underline-offset-2 hover:underline"
              >
                #{id}
              </Link>
            ))}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'basis', header: 'Matched on', render: (r) => r.match_basis },
    { key: 'window', header: 'Billed', render: (r) => windowLabel(r) },
    {
      key: 'amount',
      header: '₹ duplicated',
      align: 'right',
      render: (r) => formatINR(r.duplicate_amount),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <ClusterStatusBadge status={r.status} label={statusLabel(r.status)} />,
    },
  ]

  return (
    <ReportSection
      id="duplicate-payment-register"
      title="Duplicate payment register"
      description="The same bill about to be paid twice — one row per cluster the detector matched, by repeated invoice number or by the same amount from the same vendor inside the 90-day window. Reported as rupees prevented: every cluster not dismissed by a reviewer is a double payment that did not go out."
      action={
        <ExportCsvButton
          filename="duplicate-payment-register.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Flag ID', value: (r) => r.flag_id },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Entry IDs', value: (r) => r.entry_ids.join(' | ') },
            { header: 'Entries in cluster', value: (r) => r.entry_count_in_cluster },
            { header: 'Matched on', value: (r) => r.match_basis },
            { header: 'First billed', value: (r) => r.first_entry_date },
            { header: 'Last billed', value: (r) => r.last_entry_date },
            { header: 'Severity', value: (r) => r.severity },
            { header: 'Status', value: (r) => r.status },
            { header: 'Rupees duplicated', value: (r) => r.duplicate_amount },
            { header: 'First detected', value: (r) => r.created_at },
            { header: 'Last detected', value: (r) => r.last_detected_at },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the duplicate payment register" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No duplicate payments detected"
          description="This fills in when the vendor-pattern detector finds the same invoice number, or the same amount from one vendor inside 90 days — the two signatures of a bill entered twice."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label={`Prevented across ${formatNumber(clusters)} cluster${clusters === 1 ? '' : 's'}`}
              value={formatINRCompact(prevented)}
              delta={formatDeltaVs(compareBasis, prevented, previous, 'inr')}
              deltaTone={deltaToneHigherIsGood(prevented, previous)}
            />
            <KpiTile
              label="Confirmed duplicates"
              value={formatNumber(b.confirmedCount)}
              delta={`${formatINRCompact(b.confirmedAmount)} confirmed`}
            />
            <KpiTile
              label="Open — awaiting review"
              value={formatNumber(b.openCount)}
              delta={`${formatINRCompact(b.openAmount)} at stake`}
            />
            <KpiTile
              label="Dismissed — legitimate"
              value={formatNumber(b.dismissedCount)}
              delta={`${formatINRCompact(b.dismissedAmount)} cleared`}
            />
          </div>
          <p className="text-sm text-muted-foreground">{duplicatePaymentRegisterSentence(rows)}</p>
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => r.flag_id}
            emptyTitle="No duplicate payments detected"
          />
        </>
      )}
    </ReportSection>
  )
}
