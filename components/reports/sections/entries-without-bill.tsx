import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent, formatDate } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import type { EntryWithoutBillRow, UndocumentedRollupRow } from '@/lib/reports/surfaces/reconciliation-gap'

// reporting-blueprint.md §8 Phase Six / D-06 -- "Entries with no supporting
// bill. Not a count — a rupee figure, by department and by vendor. This is
// the size of the undocumented pile." "No supporting bill" here means no
// USABLE bill: either nothing uploaded, or a document uploaded but never
// verified (the reviewer still cannot say what it says).

/** "₹X of spend this event — {pct} of the total — sits on entries with no
 *  usable bill, across N entries ({M} with nothing uploaded at all). Most of
 *  it is in {department}." (§6 fix #3) */
export function entriesWithoutBillSentence({
  totalUndocumented,
  pctOfSpend,
  entryCount,
  noDocumentCount,
  topDepartment,
}: {
  totalUndocumented: number
  pctOfSpend: number | null
  entryCount: number
  noDocumentCount: number
  topDepartment: UndocumentedRollupRow | null
}): string {
  if (entryCount === 0) {
    return 'Every non-void entry this event has a person-verified bill behind it.'
  }
  const pct = pctOfSpend != null ? ` — ${formatPercent(pctOfSpend)} of event spend —` : ''
  const lead =
    topDepartment && topDepartment.dimension_name
      ? ` Most of it is in ${topDepartment.dimension_name} (${formatINRCompact(topDepartment.undocumented_amount)}).`
      : ''
  return `${formatINRCompact(totalUndocumented)} of spend${pct} sits on ${formatNumber(
    entryCount
  )} entr${entryCount === 1 ? 'y' : 'ies'} with no usable bill — ${formatNumber(
    noDocumentCount
  )} with nothing uploaded at all.${lead}`
}

const TOP_BARS = 8

function toBars(
  rows: UndocumentedRollupRow[],
  total: number,
  param: 'department_id' | 'vendor_id'
): BarListItem[] {
  return rows.slice(0, TOP_BARS).map((r) => {
    const share = total > 0 ? formatPercent((r.undocumented_amount / total) * 100) : null
    const noDoc = r.no_document_count > 0 ? `${formatNumber(r.no_document_count)} no doc` : null
    return {
      key: `${r.dimension}-${r.dimension_id ?? 'none'}`,
      label: r.dimension_name ?? (r.dimension === 'department' ? 'No department' : 'No vendor'),
      href: r.dimension_id != null ? `/entries?${param}=${r.dimension_id}` : undefined,
      value: r.undocumented_amount,
      note: [share, noDoc].filter(Boolean).join(' · ') || undefined,
    }
  })
}

export function EntriesWithoutBillSection({
  rows,
  error,
  byDepartment,
  byVendor,
  totalUndocumented,
  noDocumentCount,
  undocumentedPctOfSpend,
  compareBasis,
  previousTotalUndocumented,
}: {
  rows: EntryWithoutBillRow[]
  error: string | null
  byDepartment: UndocumentedRollupRow[]
  byVendor: UndocumentedRollupRow[]
  totalUndocumented: number
  noDocumentCount: number
  undocumentedPctOfSpend: number | null
  compareBasis: CompareBasis
  previousTotalUndocumented: number | null
}) {
  const previous = compareBasis === 'prior_event' ? previousTotalUndocumented : null
  const entryCount = byDepartment.reduce((s, r) => s + r.entry_count, 0)
  const topDepartment = byDepartment[0] ?? null

  const departmentBars = toBars(byDepartment, totalUndocumented, 'department_id')
  const vendorBars = toBars(byVendor, totalUndocumented, 'vendor_id')

  const tableRows = [...rows].sort((a, b) => (b.entry_amount ?? 0) - (a.entry_amount ?? 0))

  const columns: DataTableColumn<EntryWithoutBillRow>[] = [
    {
      key: 'entry',
      header: 'Entry',
      render: (r) => (
        <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
          #{r.entry_id}
        </Link>
      ),
    },
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.department_id != null ? (
          <Link href={`/entries?department_id=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.department_name ?? `#${r.department_id}`}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendor_id != null ? (
          <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.vendor_display_name ?? `#${r.vendor_id}`}
          </Link>
        ) : (
          (r.vendor_display_name ?? '—')
        ),
    },
    { key: 'amount', header: 'Ledger amount', align: 'right', render: (r) => formatINR(r.entry_amount) },
    { key: 'date', header: 'Entry date', align: 'right', render: (r) => formatDate(r.entry_date) },
    {
      key: 'doc',
      header: 'Document',
      render: (r) => (r.has_document ? 'Uploaded, not verified' : 'Nothing uploaded'),
    },
  ]

  return (
    <ReportSection
      id="entries-without-bill"
      title="Entries with no supporting bill"
      description="Spend that sits on entries with no usable bill — nothing uploaded, or a document that was never verified. The size of the undocumented pile, by department and by vendor."
      action={
        <ExportCsvButton
          filename="entries-without-bill.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Entry', value: (r) => r.entry_id },
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Ledger amount', value: (r) => r.entry_amount },
            { header: 'Entry date', value: (r) => r.entry_date },
            { header: 'Has document', value: (r) => (r.has_document ? 'yes' : 'no') },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load entries with no supporting bill" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing undocumented"
          description="Every non-void entry for this event has a person-verified bill behind it."
        />
      ) : (
        <>
          <KpiTile
            label="Undocumented spend"
            value={formatINRCompact(totalUndocumented)}
            delta={formatDeltaVs(compareBasis, totalUndocumented, previous, 'inr')}
            deltaTone={deltaToneHigherIsBad(totalUndocumented, previous)}
          />
          {undocumentedPctOfSpend != null && (
            <KpiTile label="Share of event spend" value={formatPercent(undocumentedPctOfSpend)} />
          )}
          <p className="text-sm text-muted-foreground">
            {entriesWithoutBillSentence({
              totalUndocumented,
              pctOfSpend: undocumentedPctOfSpend,
              entryCount,
              noDocumentCount,
              topDepartment,
            })}
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">By department</p>
              <BarList items={departmentBars} />
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">By vendor</p>
              <BarList items={vendorBars} />
            </div>
          </div>
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => r.entry_id}
            emptyTitle="Nothing undocumented"
          />
        </>
      )}
    </ReportSection>
  )
}
