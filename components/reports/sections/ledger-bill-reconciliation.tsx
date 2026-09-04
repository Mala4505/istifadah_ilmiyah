import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { GapDistributionChart, type GapDistributionBar } from '@/components/reports/charts/gap-distribution-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent, formatDate } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  isMaterialGap,
  type GapHistogramBucket,
  type LedgerBillReconciliationRow,
} from '@/lib/reports/surfaces/reconciliation-gap'

// reporting-blueprint.md §8 Phase Six / D-05 -- "Ledger vs bill
// reconciliation. Distribution of the gap between the entry amount and the
// bill's own total. Most sit at zero; the tail is the report. Top 20 by rupee
// value." Only entries with a person-verified bill total are in scope -- an
// unverified OCR figure is not a fact to reconcile against.

const TOP_N = 20

/** "Of N entries with a verified bill total, M carry a non-trivial gap
 *  against the ledger -- ₹X in total. Largest is {vendor} at ₹Y ({pct})."
 *  (§6 fix #3) */
export function ledgerBillReconciliationSentence(rows: LedgerBillReconciliationRow[]): string {
  if (rows.length === 0) {
    return 'No entry yet has a person-verified bill total to reconcile the ledger figure against.'
  }
  const material = rows.filter(isMaterialGap)
  if (material.length === 0) {
    return `All ${formatNumber(rows.length)} entries with a verified bill total match the ledger figure within tolerance.`
  }
  const totalGap = material.reduce((s, r) => s + (r.abs_gap_amount ?? 0), 0)
  const worst = [...material].sort((a, b) => (b.abs_gap_amount ?? 0) - (a.abs_gap_amount ?? 0))[0]!
  const who = worst.vendor_display_name ?? (worst.vendor_id != null ? `vendor #${worst.vendor_id}` : `entry #${worst.entry_id}`)
  const pct = worst.gap_pct != null ? ` (${formatPercent(worst.gap_pct)})` : ''
  return `Of ${formatNumber(rows.length)} entries with a verified bill total, ${formatNumber(
    material.length
  )} carry a non-trivial gap against the ledger figure — ${formatINRCompact(totalGap)} in total. Largest is ${who} at ${formatINRCompact(
    worst.abs_gap_amount
  )}${pct}.`
}

export function LedgerBillReconciliationSection({
  rows,
  error,
  histogram,
  materialCount,
  materialAbsGapTotal,
  compareBasis,
  previousMaterialCount,
}: {
  rows: LedgerBillReconciliationRow[]
  error: string | null
  histogram: GapHistogramBucket[]
  materialCount: number
  materialAbsGapTotal: number
  compareBasis: CompareBasis
  previousMaterialCount: number | null
}) {
  const previous = compareBasis === 'prior_event' ? previousMaterialCount : null

  const bars: GapDistributionBar[] = histogram.map((b) => ({
    bucketLabel: b.bucketLabel,
    count: b.count,
    material: b.material,
  }))

  const topRows = [...rows]
    .filter((r) => (r.abs_gap_amount ?? 0) > 0)
    .sort((a, b) => (b.abs_gap_amount ?? 0) - (a.abs_gap_amount ?? 0))
    .slice(0, TOP_N)

  // Tone the Gap / Gap % cells off the same materiality predicate the KPI and
  // the histogram shading use — no second colour meaning, just the reserved
  // red — so the material-gap tail reads on a straight column scan (§6 fix #6).
  const gapToneClass = (r: LedgerBillReconciliationRow) =>
    isMaterialGap(r) ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'

  const columns: DataTableColumn<LedgerBillReconciliationRow>[] = [
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
    { key: 'invoice', header: 'Invoice', render: (r) => r.invoice_number ?? '—' },
    { key: 'entryAmount', header: 'Ledger', align: 'right', render: (r) => formatINR(r.entry_amount) },
    { key: 'billTotal', header: 'Bill total', align: 'right', render: (r) => formatINR(r.bill_total) },
    {
      key: 'gap',
      header: 'Gap',
      align: 'right',
      render: (r) => <span className={gapToneClass(r)}>{formatINR(r.gap_amount)}</span>,
    },
    {
      key: 'gapPct',
      header: 'Gap %',
      align: 'right',
      render: (r) => <span className={gapToneClass(r)}>{r.gap_pct == null ? '—' : formatPercent(r.gap_pct)}</span>,
    },
    { key: 'date', header: 'Entry date', align: 'right', render: (r) => formatDate(r.entry_date) },
  ]

  return (
    <ReportSection
      id="ledger-bill-reconciliation"
      title="Ledger vs bill reconciliation"
      description="For every entry with a person-verified bill total: the gap between the ledger figure and what the bill itself says. Most sit at zero — the tail is the report. Table shows the top 20 by rupee value."
      action={
        <ExportCsvButton
          filename="ledger-bill-reconciliation.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Entry', value: (r) => r.entry_id },
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Invoice number', value: (r) => r.invoice_number },
            { header: 'Ledger amount', value: (r) => r.entry_amount },
            { header: 'Verified bill total', value: (r) => r.bill_total },
            { header: 'Gap (ledger − bill)', value: (r) => r.gap_amount },
            { header: 'Absolute gap', value: (r) => r.abs_gap_amount },
            { header: 'Gap %', value: (r) => r.gap_pct },
            { header: 'Entry date', value: (r) => r.entry_date },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load ledger vs bill reconciliation" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing to reconcile yet"
          description="This fills in as reviewers verify bill totals against the ledger — each verified bill adds one row."
        />
      ) : (
        <>
          <KpiTile
            label="Entries with a non-trivial gap"
            value={formatNumber(materialCount)}
            delta={formatDeltaVs(compareBasis, materialCount, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(materialCount, previous)}
          />
          <KpiTile label="Total gap across those entries" value={formatINRCompact(materialAbsGapTotal)} />
          <p className="text-sm text-muted-foreground">{ledgerBillReconciliationSentence(rows)}</p>
          <GapDistributionChart bars={bars} />
          <DataTable
            columns={columns}
            rows={topRows}
            getRowKey={(r) => r.entry_id}
            emptyTitle="No gaps to show"
            emptyDescription="Every entry with a verified bill total matches the ledger figure exactly."
          />
        </>
      )}
    </ReportSection>
  )
}
