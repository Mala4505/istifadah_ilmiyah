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
  type SubDepartmentBudgetTableRow,
  type SubDepartmentBudgetVsActualRow,
} from '@/lib/reports/sections/shared'

// Sub-department budget vs actual (blueprint A-01, sub-department level).
// The roll-up table interleaves a department header row ahead of each
// department's own sub-department rows -- ported verbatim from the former
// app/(app)/reports/page.tsx.

export function subDeptBudgetSentence(rows: SubDepartmentBudgetVsActualRow[]): string {
  const withBudget = rows.filter((r) => r.budget_amount != null && r.budget_amount > 0)
  if (withBudget.length === 0) return 'No sub-department budgets have been imported yet.'
  const over = [...withBudget]
    .filter((r) => (r.pct_of_budget ?? 0) > 100)
    .sort((a, b) => (b.pct_of_budget ?? 0) - (a.pct_of_budget ?? 0))
  if (over.length === 0) return `All ${withBudget.length} sub-departments with a budget set are within it.`
  const top = over[0]!
  return `${over.length} of ${withBudget.length} sub-departments are over budget — ${top.department_name} — ${top.sub_department_name} is highest at ${formatPercent(top.pct_of_budget)}.`
}

function buildTableRows(
  subRows: SubDepartmentBudgetVsActualRow[],
  deptRows: DepartmentBudgetVsActualRow[]
): SubDepartmentBudgetTableRow[] {
  const deptById = new Map(deptRows.map((d) => [d.department_id, d]))
  const subByDeptId = new Map<number, SubDepartmentBudgetVsActualRow[]>()
  for (const r of subRows) {
    const arr = subByDeptId.get(r.department_id)
    if (arr) arr.push(r)
    else subByDeptId.set(r.department_id, [r])
  }
  const groups = [...subByDeptId.entries()].sort((a, b) => {
    const aActual = deptById.get(a[0])?.actual_amount ?? 0
    const bActual = deptById.get(b[0])?.actual_amount ?? 0
    return bActual - aActual
  })
  return groups.flatMap(([departmentId, rowsForDept]) => {
    const deptRow = deptById.get(departmentId)
    const header: SubDepartmentBudgetTableRow = {
      kind: 'department',
      rowKey: `dept-${departmentId}`,
      label: deptRow?.department_name ?? rowsForDept[0]!.department_name,
      department_id: departmentId,
      as_of: deptRow?.as_of ?? null,
      budget_amount: deptRow?.budget_amount ?? null,
      actual_amount: deptRow?.actual_amount ?? null,
      entry_count: deptRow?.entry_count ?? 0,
      pct_of_budget: deptRow?.pct_of_budget ?? null,
      budget_status_note: deptRow?.budget_status_note ?? null,
    }
    const sorted = [...rowsForDept].sort((a, b) => (b.actual_amount ?? 0) - (a.actual_amount ?? 0))
    const childRows: SubDepartmentBudgetTableRow[] = sorted.map((r) => ({
      kind: 'sub-department',
      rowKey: `sub-${r.sub_department_id}`,
      label: r.sub_department_name,
      department_id: r.department_id,
      as_of: r.as_of,
      budget_amount: r.budget_amount,
      actual_amount: r.actual_amount,
      entry_count: r.entry_count,
      pct_of_budget: r.pct_of_budget,
      budget_status_note: r.budget_status_note,
    }))
    return [header, ...childRows]
  })
}

export function SubDepartmentBudgetSection({
  rows,
  deptRows,
  error,
  compareBasis,
  previousActualTotal,
}: {
  rows: SubDepartmentBudgetVsActualRow[]
  deptRows: DepartmentBudgetVsActualRow[]
  error: string | null
  compareBasis: CompareBasis
  previousActualTotal: number | null
}) {
  const tableRows = buildTableRows(rows, deptRows)

  const barItems: BarListItem[] = rows
    .filter((r) => (r.actual_amount ?? 0) > 0)
    .slice(0, 12)
    .map((r) => ({
      key: r.sub_department_id,
      label: `${r.department_name} — ${r.sub_department_name}`,
      value: r.actual_amount ?? 0,
      marker: r.budget_amount && r.budget_amount > 0 ? r.budget_amount : null,
      markerLabel: r.budget_amount ? `Budget: ${formatINR(r.budget_amount)}` : undefined,
      note: r.budget_status_note ?? undefined,
      colorClass: budgetStatusColorClass(r.budget_amount, r.actual_amount),
    }))

  const columns: DataTableColumn<SubDepartmentBudgetTableRow>[] = [
    {
      key: 'name',
      header: 'Department / Sub-department',
      render: (r) =>
        r.kind === 'department' ? (
          <Link
            href={`/entries?department_id=${r.department_id}`}
            className="font-semibold text-primary underline-offset-2 hover:underline"
          >
            {r.label}
          </Link>
        ) : (
          <span className="pl-4 text-foreground/90">↳ {r.label}</span>
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
      id="sub-department-budget-vs-actual"
      title="Sub-department budget vs actual"
      description={
        rows.some((r) => r.budget_status_note)
          ? "A department's actuals are the sum of its sub-departments' actuals — each department row above is repeated here as a header, with its sub-departments' own budget/actual indented underneath. Sub-departments with no budget set show \"no budget set\" instead of a misleading −100% figure."
          : "A department's actuals are the sum of its sub-departments' actuals — each department row above is repeated here as a header, with its sub-departments' own budget/actual indented underneath."
      }
      action={
        <ExportCsvButton
          filename="sub-department-budget-vs-actual.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Sub-department', value: (r) => r.sub_department_name },
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
        <EmptyState title="Couldn't load sub-department budget data" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No sub-department budgets yet"
          description="Sub-department budgets arrive via the Sub-department budget import on /import — no file has been provided yet."
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
          <p className="text-sm text-muted-foreground">{subDeptBudgetSentence(rows)}</p>
          <BudgetStatusLegend />
          <DataTable columns={columns} rows={tableRows} getRowKey={(r) => r.rowKey} />
        </>
      )}
    </ReportSection>
  )
}
