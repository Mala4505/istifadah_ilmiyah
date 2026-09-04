import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { EntryTypeSplitChart, type EntryTypeSplitDept } from '@/components/reports/charts/entry-type-split-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  REIMBURSEMENT_SHARE_HIGH_PCT,
  reimbursementShare,
  topReimbursementDepartment,
  type EntryTypeByDepartmentRow,
} from '@/lib/reports/surfaces/entry-type-flow'

// reporting-blueprint.md A-08 — entry-type split by department. "Invoice vs
// reimbursement vs advance vs invoice-against-uplaq. A high reimbursement
// share is a control signal." Headline = reimbursement share of total spend,
// coloured as a warning once it clears the control line.

type SplitTableRow = {
  rowKey: string
  departmentId: number | null
  departmentName: string
  type: string
  typeLabel: string
  entryCount: number
  amount: number
  deptSharePct: number
}

/** "Reimbursements are X% of total spend this event; {department} leans on
 *  them most at Y% of its own spend." (§6 fix #3) */
export function entryTypeSplitSentence(rows: EntryTypeByDepartmentRow[]): string {
  if (rows.length === 0) return 'No entries recorded yet this event.'
  const share = reimbursementShare(rows)
  const top = topReimbursementDepartment(rows)
  if (!top) {
    return `Reimbursements are ${formatPercent(share.reimbursementSharePct)} of ${formatINRCompact(
      share.totalSpend
    )} total spend this event — no department leans on them materially.`
  }
  return `Reimbursements are ${formatPercent(share.reimbursementSharePct)} of ${formatINRCompact(
    share.totalSpend
  )} total spend this event; ${top.departmentName} leans on them most at ${formatPercent(
    top.sharePct
  )} of its own spend (${formatINRCompact(top.reimbursementSpend)}).`
}

function buildDepartments(rows: EntryTypeByDepartmentRow[]): EntryTypeSplitDept[] {
  const byDept = new Map<string, EntryTypeSplitDept>()
  for (const r of rows) {
    const key = r.department_id == null ? 'null' : String(r.department_id)
    const d =
      byDept.get(key) ??
      ({
        key,
        departmentId: r.department_id,
        name: r.department_name ?? 'No department',
        total: 0,
        values: {},
      } satisfies EntryTypeSplitDept)
    d.values[r.type] = (d.values[r.type] ?? 0) + (r.total_amount ?? 0)
    d.total += r.total_amount ?? 0
    byDept.set(key, d)
  }
  return [...byDept.values()]
}

export function EntryTypeSplitSection({
  rows,
  error,
  compareBasis,
  previousReimbursementSharePct,
}: {
  rows: EntryTypeByDepartmentRow[]
  error: string | null
  compareBasis: CompareBasis
  previousReimbursementSharePct: number | null
}) {
  const share = reimbursementShare(rows)
  const isHigh = share.reimbursementSharePct >= REIMBURSEMENT_SHARE_HIGH_PCT

  const previous = compareBasis === 'prior_event' ? previousReimbursementSharePct : null
  let delta: string | undefined
  if (isHigh) {
    delta = `above the ${REIMBURSEMENT_SHARE_HIGH_PCT}% control line`
  } else if (previous != null) {
    const diff = share.reimbursementSharePct - previous
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±'
    delta = `${sign}${Math.abs(diff).toFixed(1)} pp vs prior event`
  }

  const departments = buildDepartments(rows)

  const deptTotals = new Map<string, number>()
  for (const d of departments) deptTotals.set(String(d.key), d.total)

  const tableRows: SplitTableRow[] = rows
    .map((r) => {
      const key = r.department_id == null ? 'null' : String(r.department_id)
      const deptTotal = deptTotals.get(key) ?? 0
      return {
        rowKey: `${key}:${r.type}`,
        departmentId: r.department_id,
        departmentName: r.department_name ?? 'No department',
        type: r.type,
        typeLabel: r.type_label,
        entryCount: r.entry_count,
        amount: r.total_amount ?? 0,
        deptSharePct: deptTotal > 0 ? ((r.total_amount ?? 0) / deptTotal) * 100 : 0,
      }
    })
    .sort((a, b) => b.amount - a.amount)

  const columns: DataTableColumn<SplitTableRow>[] = [
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.departmentId != null ? (
          <Link
            href={`/entries?dept=${r.departmentId}&tp=${r.type}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {r.departmentName}
          </Link>
        ) : (
          <span className="text-muted-foreground">{r.departmentName}</span>
        ),
    },
    { key: 'type', header: 'Entry type', render: (r) => r.typeLabel },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entryCount) },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.amount) },
    { key: 'deptShare', header: '% of dept spend', align: 'right', render: (r) => formatPercent(r.deptSharePct) },
  ]

  return (
    <ReportSection
      id="entry-type-split"
      title="Entry-type split by department"
      description="Each department's spend split by entry type — invoice, invoice against uplaq, advance, reimbursement. A high reimbursement share is a control signal: reimbursements bypass the normal vendor path."
      action={
        <ExportCsvButton
          filename="entry-type-split-by-department.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Department', value: (r) => r.department_name ?? 'No department' },
            { header: 'Entry type', value: (r) => r.type_label },
            { header: 'Type code', value: (r) => r.type },
            { header: 'Entries', value: (r) => r.entry_count },
            { header: 'Amount', value: (r) => r.total_amount },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the entry-type split" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No entries yet"
          description="This fills in once entries exist for the selected event."
        />
      ) : (
        <>
          <KpiTile
            label="Reimbursement share of total spend"
            value={formatPercent(share.reimbursementSharePct)}
            delta={delta}
            deltaTone={isHigh ? 'bad' : 'neutral'}
          />
          <p className="text-sm text-muted-foreground">{entryTypeSplitSentence(rows)}</p>
          <EntryTypeSplitChart departments={departments} />
          <DataTable columns={columns} rows={tableRows} getRowKey={(r) => r.rowKey} />
        </>
      )}
    </ReportSection>
  )
}
