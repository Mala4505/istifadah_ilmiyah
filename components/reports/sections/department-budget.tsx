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
import {
  BudgetStatusLegend,
  budgetStatusColorClass,
  formatDeltaVs,
  type DepartmentBudgetVsActualRow,
} from '@/lib/reports/sections/shared'

// Department budget vs actual (blueprint A-01, department level). Ported
// verbatim from the former app/(app)/reports/page.tsx section.

export function deptBudgetSentence(rows: DepartmentBudgetVsActualRow[]): string {
  const withBudget = rows.filter((r) => r.budget_amount != null && r.budget_amount > 0)
  if (withBudget.length === 0) return 'No department budgets have been imported yet.'
  const over = [...withBudget]
    .filter((r) => (r.pct_of_budget ?? 0) > 100)
    .sort((a, b) => (b.pct_of_budget ?? 0) - (a.pct_of_budget ?? 0))
  if (over.length === 0) return `All ${withBudget.length} departments with a budget set are within it.`
  const top = over[0]!
  return `${over.length} of ${withBudget.length} departments are over budget — ${top.department_name} is highest at ${formatPercent(top.pct_of_budget)}.`
}

export function DepartmentBudgetSection({
  rows,
  error,
  compareBasis,
  previousActualTotal,
}: {
  rows: DepartmentBudgetVsActualRow[]
  error: string | null
  compareBasis: CompareBasis
  previousActualTotal: number | null
}) {
  const barItems: BarListItem[] = rows
    .filter((r) => (r.actual_amount ?? 0) > 0)
    .slice(0, 12)
    .map((r) => ({
      key: r.department_id,
      label: r.department_name,
      value: r.actual_amount ?? 0,
      marker: r.budget_amount && r.budget_amount > 0 ? r.budget_amount : null,
      markerLabel: r.budget_amount ? `Budget: ${formatINR(r.budget_amount)}` : undefined,
      note: r.budget_status_note ?? undefined,
      colorClass: budgetStatusColorClass(r.budget_amount, r.actual_amount),
    }))

  const columns: DataTableColumn<DepartmentBudgetVsActualRow>[] = [
    {
      key: 'department',
      header: 'Department',
      render: (r) => (
        <Link href={`/entries?department_id=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.department_name}
        </Link>
      ),
    },
    { key: 'asOf', header: 'As of', render: (r) => formatDate(r.as_of) },
    { key: 'budget', header: 'Budget', align: 'right', render: (r) => formatINR(r.budget_amount) },
    { key: 'actual', header: 'Actual (sum of amounts)', align: 'right', render: (r) => formatINR(r.actual_amount) },
    {
      key: 'pct',
      header: '% of Budget',
      align: 'right',
      render: (r) =>
        r.budget_status_note ? (
          <span className="text-muted-foreground">{r.budget_status_note}</span>
        ) : (
          formatPercent(r.pct_of_budget)
        ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
  ]

  const actualTotal = rows.reduce((s, r) => s + (r.actual_amount ?? 0), 0)
  const previous = compareBasis === 'prior_event' ? previousActualTotal : null

  return (
    <ReportSection
      id="department-budget-vs-actual"
      title="Department budget vs actual"
      description={
        rows.some((r) => r.budget_status_note)
          ? 'A separate, department-grained figure from Budget vs Actual above — imported directly per department, not rolled up from budget heads. Departments with no budget set show "no budget set" instead of a misleading −100% figure.'
          : 'A separate, department-grained figure from Budget vs Actual above — imported directly per department, not rolled up from budget heads.'
      }
      action={
        <ExportCsvButton
          filename="department-budget-vs-actual.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Department', value: (r) => r.department_name },
            { header: 'As Of', value: (r) => r.as_of },
            { header: 'Budget Amount', value: (r) => r.budget_amount },
            { header: 'Actual (sum of amounts)', value: (r) => r.actual_amount },
            { header: '% of Budget', value: (r) => r.pct_of_budget },
            { header: 'Note', value: (r) => r.budget_status_note },
            { header: 'Entries', value: (r) => r.entry_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load department budget data" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No department budgets yet"
          description="Department budgets arrive via the Department budget import on /import — no file has been provided yet."
        />
      ) : (
        <>
          <KpiTile
            label="Total actual spend"
            value={formatINRCompact(actualTotal)}
            delta={formatDeltaVs(compareBasis, actualTotal, previous, 'inr')}
            deltaTone="neutral"
          />
          <BarList items={barItems} valueFormatter={formatINRCompact} />
          <p className="text-sm text-muted-foreground">{deptBudgetSentence(rows)}</p>
          <BudgetStatusLegend />
          <DataTable columns={columns} rows={rows} getRowKey={(r) => r.department_id} />
        </>
      )}
    </ReportSection>
  )
}
