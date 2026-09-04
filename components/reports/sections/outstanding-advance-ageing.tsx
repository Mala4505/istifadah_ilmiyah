import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatDate, formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import { cn } from '@/lib/utils'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  type AdvanceAgeBucket,
  type OutstandingAdvanceAgeingRow,
} from '@/lib/reports/surfaces/entry-type-flow'

// reporting-blueprint.md A-09 — outstanding-advance ageing. "Advances issued
// but never settled — the settlement link is null on the invoice side. Live
// cash exposure, bucketed by age and owner." Headline = total ₹ outstanding
// and the count.
//
// DATA-MATURITY CAVEAT (stated on the report, per the view header): IAU rows
// import with settles_entry_id null until the Dept portal exposes a real
// link, so in practice almost every advance reads as outstanding today. This
// figure is an upper bound on true exposure, not a settled-vs-unsettled split.

const BUCKET_ORDER: readonly AdvanceAgeBucket[] = ['0-30', '31-60', '61-90', '90+']

// Reserved status ramp (§6 fix #5), oldest = most severe — always paired with
// the bucket label, never colour alone.
const BUCKET_BAR_CLASS: Record<AdvanceAgeBucket, string> = {
  '0-30': 'bg-amber-300 dark:bg-amber-400/70',
  '31-60': 'bg-amber-500 dark:bg-amber-400',
  '61-90': 'bg-orange-500 dark:bg-orange-400',
  '90+': 'bg-red-600 dark:bg-red-500',
}

const BUCKET_BADGE_CLASS: Record<AdvanceAgeBucket, string> = {
  '0-30': 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  '31-60': 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  '61-90': 'bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300',
  '90+': 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
}

function bucketAmounts(rows: OutstandingAdvanceAgeingRow[]): Record<AdvanceAgeBucket, number> {
  const out: Record<AdvanceAgeBucket, number> = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
  for (const r of rows) {
    if (r.age_bucket) out[r.age_bucket] += r.advance_amount ?? 0
  }
  return out
}

/** "₹X in N advances unsettled, ₹Y of it over 90 days, oldest owned by
 *  {admin head}." (§6 fix #3) */
export function outstandingAdvanceSentence(rows: OutstandingAdvanceAgeingRow[]): string {
  if (rows.length === 0) return 'No outstanding advances this event.'
  const total = rows.reduce((s, r) => s + (r.advance_amount ?? 0), 0)
  const over90 = rows.filter((r) => r.age_bucket === '90+').reduce((s, r) => s + (r.advance_amount ?? 0), 0)
  const oldest = [...rows].sort((a, b) => (b.days_outstanding ?? -1) - (a.days_outstanding ?? -1))[0]!
  const owner =
    oldest.admin_head_name ?? oldest.department_name ?? oldest.vendor_display_name ?? 'an unassigned advance'
  return `${formatINRCompact(total)} across ${formatNumber(rows.length)} advance${
    rows.length === 1 ? '' : 's'
  } is unsettled this event, ${formatINRCompact(over90)} of it over 90 days — the oldest sits ${formatNumber(
    oldest.days_outstanding ?? 0
  )} days out, owned by ${owner}.`
}

export function OutstandingAdvanceAgeingSection({
  rows,
  error,
  compareBasis,
  previousOutstandingCount,
  previousOutstandingAmount,
}: {
  rows: OutstandingAdvanceAgeingRow[]
  error: string | null
  compareBasis: CompareBasis
  previousOutstandingCount: number | null
  previousOutstandingAmount: number | null
}) {
  const total = rows.reduce((s, r) => s + (r.advance_amount ?? 0), 0)
  const amounts = bucketAmounts(rows)
  const maxBucket = Math.max(1, ...BUCKET_ORDER.map((b) => amounts[b]))

  const prevCount = compareBasis === 'prior_event' ? previousOutstandingCount : null
  const prevAmount = compareBasis === 'prior_event' ? previousOutstandingAmount : null

  const barItems: BarListItem[] = BUCKET_ORDER.filter((b) => amounts[b] > 0).map((b) => ({
    key: b,
    label: `${b} days`,
    value: amounts[b],
    colorClass: BUCKET_BAR_CLASS[b],
  }))

  const tableRows = [...rows].sort((a, b) => (b.days_outstanding ?? -1) - (a.days_outstanding ?? -1))

  const columns: DataTableColumn<OutstandingAdvanceAgeingRow>[] = [
    {
      key: 'entry',
      header: 'Advance',
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
          <Link href={`/entries?dept=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.department_name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'owner', header: 'Admin head', render: (r) => r.admin_head_name ?? '—' },
    { key: 'vendor', header: 'Vendor', render: (r) => r.vendor_display_name ?? '—' },
    { key: 'advance', header: 'Advance ₹', align: 'right', render: (r) => formatINR(r.advance_amount) },
    { key: 'invoice', header: 'Invoice ₹', align: 'right', render: (r) => formatINR(r.invoice_amount) },
    { key: 'date', header: 'Advance date', render: (r) => formatDate(r.advance_date) },
    { key: 'days', header: 'Days out', align: 'right', render: (r) => formatNumber(r.days_outstanding) },
    {
      key: 'bucket',
      header: 'Age',
      render: (r) =>
        r.age_bucket ? (
          <span
            className={cn(
              'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
              BUCKET_BADGE_CLASS[r.age_bucket]
            )}
          >
            {r.age_bucket} days
          </span>
        ) : (
          '—'
        ),
    },
  ]

  return (
    <ReportSection
      id="outstanding-advance-ageing"
      title="Outstanding advance ageing"
      description="Advances paid out with no settling entry against them — live cash exposure, bucketed by age and owner. Note: invoice-against-uplaq rows currently import without a settlement link, so nearly every advance reads as outstanding here — treat this as an upper bound on exposure."
      action={
        <ExportCsvButton
          filename="outstanding-advance-ageing.csv"
          rowCount={rows.length}
          csv={toCsv(tableRows, [
            { header: 'Entry ID', value: (r) => r.entry_id },
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Admin head', value: (r) => r.admin_head_name },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Advance amount', value: (r) => r.advance_amount },
            { header: 'Invoice amount', value: (r) => r.invoice_amount },
            { header: 'Advance date', value: (r) => r.advance_date },
            { header: 'Days outstanding', value: (r) => r.days_outstanding },
            { header: 'Age bucket', value: (r) => r.age_bucket },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load outstanding advances" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No outstanding advances"
          description="Advance-payment entries with no settling entry appear here for the selected event."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiTile
              label="₹ outstanding"
              value={formatINRCompact(total)}
              delta={formatDeltaVs(compareBasis, total, prevAmount, 'inr')}
              deltaTone={deltaToneHigherIsBad(total, prevAmount)}
            />
            <KpiTile
              label="Advances unsettled"
              value={formatNumber(rows.length)}
              delta={formatDeltaVs(compareBasis, rows.length, prevCount, 'count')}
              deltaTone={deltaToneHigherIsBad(rows.length, prevCount)}
            />
          </div>
          <p className="text-sm text-muted-foreground">{outstandingAdvanceSentence(rows)}</p>
          {barItems.length > 0 && <BarList items={barItems} max={maxBucket} valueFormatter={formatINRCompact} />}
          <DataTable columns={columns} rows={tableRows} getRowKey={(r) => r.entry_id} />
        </>
      )}
    </ReportSection>
  )
}
