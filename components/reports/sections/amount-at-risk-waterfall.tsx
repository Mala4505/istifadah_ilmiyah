import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { WaterfallChart, type WaterfallStage } from '@/components/reports/charts/waterfall-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { AmountAtRiskByStatusRow } from '@/lib/reports/sections/shared'

// reporting-blueprint.md D-02 — amount-at-risk waterfall. "Total spend →
// flagged → confirmed → recovered or dismissed. The value the review function
// actually delivered, in one figure."
//
// Status → stage mapping (from 20260903000002's header): flags.status is
// open / confirmed / dismissed; reconciliation_exception.status is
// open / resolved / dismissed. The app maps confirmed + resolved to "upheld"
// and dismissed to "cleared".
//
//   Total spend  — every non-void entry's amount (loader).
//   Flagged      — summed amount_at_risk across every status.
//   Upheld       — flags 'confirmed' + reconciliation_exception 'resolved'.
//   Cleared / dismissed — status 'dismissed' (either table).
//   Still open    — status 'open' (either table), surfaced separately.

type StageKey = 'total_spend' | 'flagged' | 'upheld' | 'cleared' | 'open'

export type WaterfallStageResult = WaterfallStage & { key: StageKey }

const isUpheld = (r: AmountAtRiskByStatusRow) =>
  (r.source_table === 'flags' && r.status === 'confirmed') ||
  (r.source_table === 'reconciliation_exception' && r.status === 'resolved')
const isCleared = (r: AmountAtRiskByStatusRow) => r.status === 'dismissed'
const isOpen = (r: AmountAtRiskByStatusRow) => r.status === 'open'

/**
 * Turns the per-(source_table, status) rows plus the event's total spend into
 * the ordered stage list the chart and table render. Pure and total —
 * exported so it's unit-testable without a Supabase client.
 */
export function buildAmountAtRiskStages(
  rows: AmountAtRiskByStatusRow[],
  totalSpend: number
): WaterfallStageResult[] {
  const sumAmount = (pred: (r: AmountAtRiskByStatusRow) => boolean) =>
    rows.filter(pred).reduce((s, r) => s + r.amount_at_risk, 0)
  const sumCount = (pred: (r: AmountAtRiskByStatusRow) => boolean) =>
    rows.filter(pred).reduce((s, r) => s + r.issue_count, 0)

  return [
    { key: 'total_spend', label: 'Total spend', amount: totalSpend, count: null },
    { key: 'flagged', label: 'Flagged', amount: sumAmount(() => true), count: sumCount(() => true) },
    { key: 'upheld', label: 'Upheld', amount: sumAmount(isUpheld), count: sumCount(isUpheld) },
    { key: 'cleared', label: 'Cleared / dismissed', amount: sumAmount(isCleared), count: sumCount(isCleared) },
    { key: 'open', label: 'Still open', amount: sumAmount(isOpen), count: sumCount(isOpen) },
  ]
}

function stageAmount(stages: WaterfallStageResult[], key: StageKey): number {
  return stages.find((s) => s.key === key)?.amount ?? 0
}

/** "Of ₹4.2 Cr total spend, ₹6.1 L was ever flagged; the review function has
 *  closed ₹4.4 L of that (₹3.1 L upheld, ₹1.3 L cleared), with ₹1.7 L still
 *  open." (§6 fix #3) */
export function amountAtRiskWaterfallSentence(stages: WaterfallStageResult[]): string {
  const total = stageAmount(stages, 'total_spend')
  const flagged = stageAmount(stages, 'flagged')
  const upheld = stageAmount(stages, 'upheld')
  const cleared = stageAmount(stages, 'cleared')
  const open = stageAmount(stages, 'open')
  if (flagged <= 0) {
    return total > 0
      ? `Of ${formatINRCompact(total)} total spend, nothing is currently flagged.`
      : 'No spend and no flagged amount recorded yet.'
  }
  return `Of ${formatINRCompact(total)} total spend, ${formatINRCompact(
    flagged
  )} was ever flagged; the review function has closed ${formatINRCompact(upheld + cleared)} of that (${formatINRCompact(
    upheld
  )} upheld, ${formatINRCompact(cleared)} cleared), with ${formatINRCompact(open)} still open.`
}

export function AmountAtRiskWaterfallSection({
  rows,
  totalSpend,
  error,
}: {
  rows: AmountAtRiskByStatusRow[]
  totalSpend: number
  error: string | null
}) {
  const stages = buildAmountAtRiskStages(rows, totalSpend)
  const resolved = stageAmount(stages, 'upheld') + stageAmount(stages, 'cleared')
  const flagged = stageAmount(stages, 'flagged')

  const tableRows = stages.map((stage, i) => {
    const prev = i > 0 ? stages[i - 1]! : null
    return { ...stage, pctOfPrior: prev && prev.amount > 0 ? (stage.amount / prev.amount) * 100 : null }
  })
  type TableRow = (typeof tableRows)[number]

  const tableColumns: DataTableColumn<TableRow>[] = [
    {
      key: 'stage',
      header: 'Stage',
      render: (s) =>
        s.key === 'open' ? (
          <Link href="/reports/integrity#open-issues" className="text-primary underline-offset-2 hover:underline">
            {s.label}
          </Link>
        ) : s.key === 'total_spend' ? (
          <Link href="/entries" className="text-primary underline-offset-2 hover:underline">
            {s.label}
          </Link>
        ) : (
          <Link href="/reports/integrity#compliance" className="text-primary underline-offset-2 hover:underline">
            {s.label}
          </Link>
        ),
    },
    { key: 'amount', header: '₹', align: 'right', render: (s) => formatINR(s.amount) },
    { key: 'count', header: 'Count', align: 'right', render: (s) => (s.count == null ? '—' : formatNumber(s.count)) },
    {
      key: 'pct',
      header: '% of prior stage',
      align: 'right',
      render: (s) => (s.pctOfPrior == null ? '—' : formatPercent(s.pctOfPrior)),
    },
  ]

  return (
    <ReportSection
      id="amount-at-risk-waterfall"
      title="Amount-at-risk waterfall"
      description="Total spend, then how much of it was ever flagged, then how much of that the review function has since closed — upheld or cleared — versus what is still open. The value the review function actually delivered, in one figure."
      action={
        <ExportCsvButton
          filename="amount-at-risk-waterfall.csv"
          rowCount={stages.length}
          csv={toCsv(tableRows, [
            { header: 'Stage', value: (s) => s.label },
            { header: '₹', value: (s) => s.amount },
            { header: 'Count', value: (s) => s.count ?? '' },
            { header: '% of prior stage', value: (s) => (s.pctOfPrior == null ? '' : s.pctOfPrior.toFixed(1)) },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the amount-at-risk waterfall" description={error} />
      ) : totalSpend <= 0 && rows.length === 0 ? (
        <EmptyState
          title="No spend or findings yet"
          description="Needs at least one non-void entry, plus reconciliation exceptions or flags once documents have been verified and a sweep has run."
        />
      ) : (
        <>
          <KpiTile
            label="₹ at risk resolved (review function delivered)"
            value={formatINRCompact(resolved)}
            delta={
              flagged > 0 ? `${formatPercent((resolved / flagged) * 100)} of all flagged ₹ now closed` : undefined
            }
            deltaTone="neutral"
          />
          <p className="text-sm text-muted-foreground">{amountAtRiskWaterfallSentence(stages)}</p>
          <WaterfallChart stages={stages} />
          <DataTable columns={tableColumns} rows={tableRows} getRowKey={(s) => s.key} />
        </>
      )}
    </ReportSection>
  )
}
