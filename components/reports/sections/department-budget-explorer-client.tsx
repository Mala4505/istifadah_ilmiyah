'use client'

import { useMemo, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { DonutChart, type DonutSegment } from '@/components/reports/charts/donut-chart'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { ORDINAL_RAMP } from '@/components/reports/charts/ordinal-ramp'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { ExportPdfButton } from '@/components/reports/export-pdf-button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SelectNative } from '@/components/ui/select-native'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  BudgetStatusLegend,
  budgetStatusColorClass,
  formatDeltaVs,
  type DepartmentBudgetVsActualRow,
  type SubDepartmentBudgetVsActualRow,
} from '@/lib/reports/sections/shared'

// Interactive companion to Department / Sub-department Budget vs Actual
// (blueprint A-01): pick a department -- by donut wedge, bar, or the jump
// dropdown -- and the same card narrows to that department's divisions plus
// a detail table, instead of listing every department and every division
// flat on the page at once.
//
// The Budget Utilization Report PDF is department-grained only (Sr. No /
// Department / Actual / Budget / % of Budget Used, per
// lib/reports/budget-utilization-pdf.ts) and doesn't change with the drill
// state below -- it's built once, server-side, by the async wrapper in
// department-budget-explorer.tsx and handed in here as ready bytes, the same
// split that component's PDF button already uses.

const MAX_DONUT_SEGMENTS = 6
type ChartStyle = 'donut' | 'bars'

type ScopedItem = {
  id: number
  name: string
  budget: number | null
  actual: number | null
  entryCount: number
  pctOfBudget: number | null
  statusNote: string | null
}

function fromDept(r: DepartmentBudgetVsActualRow): ScopedItem {
  return {
    id: r.department_id,
    name: r.department_name,
    budget: r.budget_amount,
    actual: r.actual_amount,
    entryCount: r.entry_count,
    pctOfBudget: r.pct_of_budget,
    statusNote: r.budget_status_note,
  }
}

function fromSub(r: SubDepartmentBudgetVsActualRow): ScopedItem {
  return {
    id: r.sub_department_id,
    name: r.sub_department_name,
    budget: r.budget_amount,
    actual: r.actual_amount,
    entryCount: r.entry_count,
    pctOfBudget: r.pct_of_budget,
    statusNote: r.budget_status_note,
  }
}

export function DepartmentBudgetExplorerClient({
  deptRows,
  subDeptRows,
  deptError,
  subDeptError,
  compareBasis,
  previousDeptActualTotal,
  budgetUtilizationBase64,
  budgetUtilizationFilename,
}: {
  deptRows: DepartmentBudgetVsActualRow[]
  subDeptRows: SubDepartmentBudgetVsActualRow[]
  deptError: string | null
  subDeptError: string | null
  compareBasis: CompareBasis
  previousDeptActualTotal: number | null
  budgetUtilizationBase64: string
  budgetUtilizationFilename: string
}) {
  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null)
  const [chartStyle, setChartStyle] = useState<ChartStyle>('donut')

  const deptItems = useMemo(() => deptRows.map(fromDept).sort((a, b) => (b.actual ?? 0) - (a.actual ?? 0)), [deptRows])
  const selectedDept = selectedDeptId != null ? deptRows.find((d) => d.department_id === selectedDeptId) ?? null : null
  const divisionItems = useMemo(
    () =>
      selectedDeptId != null
        ? subDeptRows
            .filter((s) => s.department_id === selectedDeptId)
            .map(fromSub)
            .sort((a, b) => (b.actual ?? 0) - (a.actual ?? 0))
        : [],
    [subDeptRows, selectedDeptId]
  )

  const items = selectedDept ? divisionItems : deptItems
  const error = selectedDept ? subDeptError : deptError
  const nameHeader = selectedDept ? 'Division' : 'Department'

  const totalBudget = items.reduce((s, x) => s + (x.budget ?? 0), 0)
  const totalActual = items.reduce((s, x) => s + (x.actual ?? 0), 0)
  const totalEntries = items.reduce((s, x) => s + x.entryCount, 0)
  const withBudget = items.filter((x) => x.budget != null && x.budget > 0)
  const overCount = withBudget.filter((x) => (x.pctOfBudget ?? 0) > 100).length
  const previousActual = !selectedDept && compareBasis === 'prior_event' ? previousDeptActualTotal : null

  // Donut caps at 6 named segments -- past that, hue alone stops working
  // (the same threshold budget-category-mix.tsx's donut already uses).
  const donutSegments: DonutSegment[] = []
  items.slice(0, MAX_DONUT_SEGMENTS).forEach((it, i) => {
    donutSegments.push({
      key: String(it.id),
      label: it.name,
      value: it.actual ?? 0,
      colorClass: ORDINAL_RAMP[i % ORDINAL_RAMP.length]!.strokeClass,
    })
  })
  const restItems = items.slice(MAX_DONUT_SEGMENTS)
  if (restItems.length > 0) {
    donutSegments.push({
      key: 'other',
      label: `Other (${formatNumber(restItems.length)} ${selectedDept ? 'divisions' : 'departments'})`,
      value: restItems.reduce((s, x) => s + (x.actual ?? 0), 0),
      colorClass: 'stroke-muted-foreground',
    })
  }

  const barItems: BarListItem[] = items
    .filter((x) => (x.actual ?? 0) > 0)
    .map((x) => ({
      key: x.id,
      label: x.name,
      value: x.actual ?? 0,
      marker: x.budget && x.budget > 0 ? x.budget : null,
      markerLabel: x.budget ? `Budget: ${formatINR(x.budget)}` : undefined,
      note: x.statusNote ?? undefined,
      colorClass: budgetStatusColorClass(x.budget, x.actual),
    }))

  const columns: DataTableColumn<ScopedItem>[] = [
    {
      key: 'name',
      header: nameHeader,
      render: (r) =>
        selectedDept ? (
          r.name
        ) : (
          <button
            type="button"
            onClick={() => setSelectedDeptId(r.id)}
            className="text-primary underline-offset-2 hover:underline"
          >
            {r.name}
          </button>
        ),
    },
    { key: 'budget', header: 'Budget', align: 'right', render: (r) => formatINR(r.budget) },
    { key: 'actual', header: 'Actual (sum of amounts)', align: 'right', render: (r) => formatINR(r.actual) },
    {
      key: 'pct',
      header: '% of Budget',
      align: 'right',
      render: (r) => (r.statusNote ? <span className="text-muted-foreground">{r.statusNote}</span> : formatPercent(r.pctOfBudget)),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entryCount) },
  ]

  const onSelectFromChart = (key: string) => {
    if (key === 'other') return
    setSelectedDeptId(Number(key))
  }

  return (
    <ReportSection
      id="department-budget-explorer"
      title={selectedDept ? `${selectedDept.department_name} — divisions` : 'Budget vs actual — department explorer'}
      description={
        selectedDept
          ? `Every division under ${selectedDept.department_name}, budget vs actual, for the same event.`
          : 'Pick a department -- by wedge, bar, or the dropdown -- to see its own divisions and the figures behind them.'
      }
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={chartStyle} onValueChange={(v) => setChartStyle(v as ChartStyle)}>
            <TabsList>
              <TabsTrigger value="donut">Donut</TabsTrigger>
              <TabsTrigger value="bars">Bars</TabsTrigger>
            </TabsList>
          </Tabs>
          <ExportPdfButton
            filename={budgetUtilizationFilename}
            rowCount={deptRows.length}
            base64={budgetUtilizationBase64}
            label="Budget Utilization Report"
          />
          <ExportCsvButton
            filename={selectedDept ? `${selectedDept.department_name}-divisions.csv` : 'department-budget-explorer.csv'}
            rowCount={items.length}
            csv={toCsv(items, [
              { header: nameHeader, value: (r) => r.name },
              { header: 'Budget Amount', value: (r) => r.budget },
              { header: 'Actual (sum of amounts)', value: (r) => r.actual },
              { header: '% of Budget', value: (r) => r.pctOfBudget },
              { header: 'Note', value: (r) => r.statusNote },
              { header: 'Entries', value: (r) => r.entryCount },
            ])}
          />
        </div>
      }
    >
      {selectedDept && (
        <button
          type="button"
          onClick={() => setSelectedDeptId(null)}
          className="flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          All departments
        </button>
      )}

      {!selectedDept && deptItems.length > 1 && (
        <SelectNative
          aria-label="Jump to department"
          className="w-fit"
          value=""
          onChange={(e) => {
            if (e.target.value) setSelectedDeptId(Number(e.target.value))
          }}
        >
          <option value="">Jump to a department…</option>
          {deptItems.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectNative>
      )}

      {error ? (
        <EmptyState title="Couldn't load budget data" description={error} />
      ) : items.length === 0 ? (
        <EmptyState
          title={selectedDept ? 'No divisions under this department' : 'No department budgets yet'}
          description={
            selectedDept
              ? undefined
              : 'Department budgets arrive via the Department budget import on /import — no file has been provided yet.'
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Budget" value={formatINRCompact(totalBudget)} />
            <KpiTile
              label="Actual"
              value={formatINRCompact(totalActual)}
              delta={formatDeltaVs(compareBasis, totalActual, previousActual, 'inr')}
              deltaTone="neutral"
            />
            <KpiTile
              label={selectedDept ? 'Divisions over budget' : 'Departments over budget'}
              value={`${overCount} of ${withBudget.length}`}
              delta={overCount ? 'needs attention' : withBudget.length ? 'all within budget' : undefined}
              deltaTone={overCount ? 'bad' : 'good'}
            />
            <KpiTile label="Entries recorded" value={formatNumber(totalEntries)} />
          </div>

          {chartStyle === 'donut' ? (
            <DonutChart
              segments={donutSegments}
              centerLabel={formatINRCompact(totalActual)}
              onSelect={selectedDept ? undefined : onSelectFromChart}
              valueFormatter={formatINRCompact}
            />
          ) : (
            <BarList items={barItems} valueFormatter={formatINRCompact} />
          )}

          <BudgetStatusLegend />
          <DataTable columns={columns} rows={items} getRowKey={(r) => r.id} />
        </>
      )}
    </ReportSection>
  )
}
