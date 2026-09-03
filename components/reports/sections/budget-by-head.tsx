import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  BudgetStatusLegend,
  budgetStatusColorClass,
  formatDeltaVs,
  type BudgetVsActualRow,
  type DepartmentBudgetVsActualRow,
} from '@/lib/reports/sections/shared'

// Budget vs actual by head (blueprint A-01, one of the three levels). Ported
// verbatim from the former app/(app)/reports/page.tsx section of the same id
// so /reports (Explore) and /reports/budget render identically.

function departmentLabelFactory(deptRows: DepartmentBudgetVsActualRow[]) {
  const byId = new Map(deptRows.map((d) => [d.department_id, d.department_name]))
  return (departmentId: number | null) =>
    departmentId == null ? 'Unassigned' : (byId.get(departmentId) ?? `Department #${departmentId}`)
}

/** All heads' actual spend contradiction sentence (§6 fix #3). */
export function budgetVsActualSentence(rows: BudgetVsActualRow[]): string {
  const withBudget = rows.filter((r) => r.approved_amount != null && r.approved_amount > 0)
  if (withBudget.length === 0) return 'No budget heads have an approved figure set yet.'
  const over = withBudget.filter((r) => (r.pct_of_approved ?? 0) > 100)
  const near = withBudget.filter((r) => (r.pct_of_approved ?? 0) > 90 && (r.pct_of_approved ?? 0) <= 100)
  if (over.length === 0 && near.length === 0) {
    return `All ${withBudget.length} budget heads with an approved figure are within budget.`
  }
  const parts: string[] = []
  if (over.length > 0) parts.push(`${over.length} ${over.length === 1 ? 'head is' : 'heads are'} over its approved budget`)
  if (near.length > 0) parts.push(`${near.length} ${near.length === 1 ? 'head is' : 'heads are'} above 90% with balance left`)
  return `${parts.join(', and ')}, out of ${withBudget.length} heads with an approved figure.`
}

export function BudgetByHeadSection({
  rows,
  deptRows,
  error,
  compareBasis,
  previousActualTotal,
}: {
  rows: BudgetVsActualRow[]
  deptRows: DepartmentBudgetVsActualRow[]
  error: string | null
  compareBasis: CompareBasis
  previousActualTotal: number | null
}) {
  const departmentLabel = departmentLabelFactory(deptRows)

  const grouped = [...rows].sort((a, b) => {
    const deptCompare = departmentLabel(a.department_id).localeCompare(departmentLabel(b.department_id))
    if (deptCompare !== 0) return deptCompare
    return (b.actual_amount ?? 0) - (a.actual_amount ?? 0)
  })

  const barItems: BarListItem[] = rows
    .filter((r) => (r.actual_amount ?? 0) > 0)
    .slice(0, 12)
    .map((r) => ({
      key: r.budget_head_id,
      label: r.short_label ?? r.raw_label,
      value: r.actual_amount ?? 0,
      marker: r.approved_amount && r.approved_amount > 0 ? r.approved_amount : null,
      markerLabel: r.approved_amount ? `Approved: ${formatINR(r.approved_amount)}` : undefined,
      note: r.budget_status_note ?? undefined,
      colorClass: budgetStatusColorClass(r.approved_amount, r.actual_amount),
    }))

  const columns: DataTableColumn<BudgetVsActualRow>[] = [
    {
      key: 'head',
      header: 'Budget Head',
      render: (r) => (
        <Link href={`/entries?budget_head_id=${r.budget_head_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.short_label ?? r.raw_label}
        </Link>
      ),
    },
    { key: 'department', header: 'Department', render: (r) => departmentLabel(r.department_id) },
    { key: 'approved', header: 'Approved', align: 'right', render: (r) => formatINR(r.approved_amount) },
    { key: 'utilised', header: 'Utilised (source)', align: 'right', render: (r) => formatINR(r.utilised_amount) },
    { key: 'actual', header: 'Actual (sum of amounts)', align: 'right', render: (r) => formatINR(r.actual_amount) },
    { key: 'balance', header: 'Balance', align: 'right', render: (r) => formatINR(r.balance_amount) },
    {
      key: 'pct',
      header: '% of Approved',
      align: 'right',
      render: (r) =>
        r.budget_status_note ? (
          <span className="text-muted-foreground">{r.budget_status_note}</span>
        ) : (
          formatPercent(r.pct_of_approved)
        ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
  ]

  const actualTotal = rows.reduce((s, r) => s + (r.actual_amount ?? 0), 0)
  const previous = compareBasis === 'prior_event' ? previousActualTotal : null

  return (
    <ReportSection
      id="budget-vs-actual"
      title="Budget vs actual by head"
      description={
        rows.some((r) => r.budget_status_note)
          ? 'Heads with no approved budget show "no approved budget" instead of a −100% figure (§3.5).'
          : 'Latest allocation snapshot against the sum of amounts per head.'
      }
      action={
        <ExportCsvButton
          filename="budget-vs-actual.csv"
          rowCount={rows.length}
          csv={toCsv(grouped, [
            { header: 'Budget Head', value: (r) => r.short_label ?? r.raw_label },
            { header: 'Department', value: (r) => departmentLabel(r.department_id) },
            { header: 'Approved Amount', value: (r) => r.approved_amount },
            { header: 'Utilised Amount (source)', value: (r) => r.utilised_amount },
            { header: 'Actual (sum of amounts)', value: (r) => r.actual_amount },
            { header: 'Balance', value: (r) => r.balance_amount },
            { header: '% of Approved', value: (r) => r.pct_of_approved },
            { header: 'Note', value: (r) => r.budget_status_note },
            { header: 'Entries', value: (r) => r.entry_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load budget data" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No budget heads yet" description="Budget heads arrive via import." />
      ) : (
        <>
          <KpiTile
            label="Total actual spend"
            value={formatINRCompact(actualTotal)}
            delta={formatDeltaVs(compareBasis, actualTotal, previous, 'inr')}
            deltaTone="neutral"
          />
          <BarList items={barItems} valueFormatter={formatINRCompact} />
          <p className="text-sm text-muted-foreground">{budgetVsActualSentence(rows)}</p>
          <BudgetStatusLegend />
          <DataTable columns={columns} rows={grouped} getRowKey={(r) => r.budget_head_id} />
        </>
      )}
    </ReportSection>
  )
}
