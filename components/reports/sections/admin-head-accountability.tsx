import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  headDepartmentIsOverBudget,
  type AdminHeadAccountabilityRow,
} from '@/lib/reports/surfaces/admin-head'

// reporting-blueprint.md A-04 — administrative head accountability. "Spend,
// entry volume and budget adherence per named head. The dimension exists and
// is currently almost unreported — yet it is the one that attaches a number
// to a person." Ranked by spend; the org does not budget at head level, so
// adherence is shown honestly at the department the head belongs to. Colour
// only on the outliers (§4 E-01 rule): a bar goes red only when the head's
// department is materially over its own budget.

const OVER_BUDGET_BAR = 'bg-red-600 dark:bg-red-500'
const BAR_LIMIT = 12

function departmentPositionLabel(row: AdminHeadAccountabilityRow): string {
  if (row.departmentId == null) return 'No department on file'
  if (row.departmentPctOfBudget != null) return `${formatPercent(row.departmentPctOfBudget)} of budget`
  if (row.departmentBudgetStatusNote) return row.departmentBudgetStatusNote
  return '—'
}

/** §6 fix #3 — one computed sentence under the chart. "N heads account for
 *  ₹X this event — led by {head} at ₹Y ({share}). K sit in a department
 *  that is over its budget." */
export function adminHeadAccountabilitySentence(rows: AdminHeadAccountabilityRow[]): string {
  if (rows.length === 0) return 'No spend is attributed to a named administrative head this event.'
  const total = rows.reduce((sum, r) => sum + r.totalAmount, 0)
  const lead = [...rows].sort((a, b) => b.totalAmount - a.totalAmount)[0]!
  const base = `${formatNumber(rows.length)} administrative head${rows.length === 1 ? '' : 's'} account for ${formatINRCompact(
    total
  )} this event — led by ${lead.adminHeadName} at ${formatINRCompact(lead.totalAmount)} (${formatPercent(
    lead.shareOfEventPct
  )} of the total)`
  const overBudget = rows.filter(headDepartmentIsOverBudget)
  if (overBudget.length === 0) {
    return `${base}. No head sits in a department that is over its budget.`
  }
  return `${base}. ${formatNumber(overBudget.length)} of them sit in a department that is over its budget — ${
    overBudget.length === 1 ? 'it is' : 'they are'
  } shown in red below.`
}

export function AdminHeadAccountabilitySection({
  rows,
  error,
  compareBasis,
  previousSpendTotal,
}: {
  rows: AdminHeadAccountabilityRow[]
  error: string | null
  compareBasis: CompareBasis
  previousSpendTotal: number | null
}) {
  const spendThroughHeads = rows.reduce((sum, r) => sum + r.totalAmount, 0)
  const previous = compareBasis === 'prior_event' ? previousSpendTotal : null
  const anyOverBudget = rows.some(headDepartmentIsOverBudget)

  const barItems: BarListItem[] = rows
    .filter((r) => r.totalAmount > 0)
    .slice(0, BAR_LIMIT)
    .map((r) => ({
      key: r.adminHeadId,
      label: r.adminHeadName,
      value: r.totalAmount,
      href: `/entries?ahead=${r.adminHeadId}`,
      note: `${formatPercent(r.shareOfEventPct)} of event`,
      colorClass: headDepartmentIsOverBudget(r) ? OVER_BUDGET_BAR : undefined,
    }))

  const columns: DataTableColumn<AdminHeadAccountabilityRow>[] = [
    {
      key: 'head',
      header: 'Administrative head',
      render: (r) => (
        <Link href={`/entries?ahead=${r.adminHeadId}`} className="text-primary underline-offset-2 hover:underline">
          {r.adminHeadName}
        </Link>
      ),
    },
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.departmentId != null ? (
          <Link href={`/entries?dept=${r.departmentId}`} className="text-primary underline-offset-2 hover:underline">
            {r.departmentName ?? `Department ${r.departmentId}`}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'spend', header: 'Spend', align: 'right', render: (r) => formatINRCompact(r.totalAmount) },
    { key: 'share', header: 'Share of event', align: 'right', render: (r) => formatPercent(r.shareOfEventPct) },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entryCount) },
    { key: 'docs', header: 'Doc coverage', align: 'right', render: (r) => formatPercent(r.documentCoveragePct) },
    {
      key: 'deptBudget',
      header: 'Dept. budget position',
      align: 'right',
      render: (r) =>
        headDepartmentIsOverBudget(r) ? (
          <span className="font-medium text-red-700 dark:text-red-300">{departmentPositionLabel(r)}</span>
        ) : (
          <span className={r.departmentPctOfBudget == null ? 'text-muted-foreground' : undefined}>
            {departmentPositionLabel(r)}
          </span>
        ),
    },
    {
      key: 'deptRisk',
      header: 'Dept. ₹ at risk',
      align: 'right',
      render: (r) =>
        r.departmentAmountAtRisk != null && r.departmentAmountAtRisk > 0 ? (
          formatINRCompact(r.departmentAmountAtRisk)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ]

  return (
    <ReportSection
      id="admin-head-accountability"
      title="Administrative head accountability"
      description="Spend, entry volume and document coverage per named administrative head, ranked — the one dimension that attaches a number to a person. Budgets are not tracked at head level, so adherence is shown at the department each head belongs to (department budget position and department ₹ at risk). Red marks a head whose department is over its own budget."
      action={
        <ExportCsvButton
          filename="admin-head-accountability.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Administrative head', value: (r) => r.adminHeadName },
            { header: 'Department', value: (r) => r.departmentName },
            { header: 'Spend', value: (r) => r.totalAmount },
            { header: 'Share of event %', value: (r) => r.shareOfEventPct },
            { header: 'Entries', value: (r) => r.entryCount },
            { header: 'Entries with documents', value: (r) => r.entriesWithDocuments },
            { header: 'Document coverage %', value: (r) => r.documentCoveragePct },
            { header: 'Department budget amount', value: (r) => r.departmentBudgetAmount },
            { header: 'Department actual amount', value: (r) => r.departmentActualAmount },
            { header: 'Department % of budget', value: (r) => r.departmentPctOfBudget },
            { header: 'Department budget note', value: (r) => r.departmentBudgetStatusNote },
            { header: 'Department ₹ at risk', value: (r) => r.departmentAmountAtRisk },
            { header: 'Department open issues', value: (r) => r.departmentOpenIssueCount },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load administrative head accountability" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No head-level spend yet"
          description="Entries carry an administrative head as they import — this fills in once entries with a head are recorded for the selected event."
        />
      ) : (
        <>
          <KpiTile
            label="Spend through named heads"
            value={formatINRCompact(spendThroughHeads)}
            delta={formatDeltaVs(compareBasis, spendThroughHeads, previous, 'inr')}
            deltaTone="neutral"
          />
          <BarList items={barItems} valueFormatter={formatINRCompact} />
          <p className="text-sm text-muted-foreground">{adminHeadAccountabilitySentence(rows)}</p>
          {anyOverBudget && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-red-600 dark:bg-red-500" />
              Head&apos;s department is over its own budget
            </div>
          )}
          <DataTable columns={columns} rows={rows} getRowKey={(r) => r.adminHeadId} />
        </>
      )}
    </ReportSection>
  )
}
