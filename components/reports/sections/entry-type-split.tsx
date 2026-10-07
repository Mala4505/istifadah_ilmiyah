import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { EntryTypeSplitChart, type EntryTypeSplitDept } from '@/components/reports/charts/lazy'
import { DonutChart, type DonutSegment } from '@/components/reports/charts/lazy'
import { OTHER_STEP } from '@/components/reports/charts/categorical-palette'
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

// Event-wide headline donut (visual-optimisation plan Phase 3.1): "what share
// of the whole event is each type" is a part-to-whole question, answered once
// here before the per-department 100% bars. Keys, labels and colours mirror
// entry-type-split-chart.tsx's SPLIT_META exactly (stroke-* twins of its bg-*
// hexes) so a type reads the same colour in the donut legend and the bars --
// reimbursement keeps the reserved amber as the control signal. Duplicated
// rather than imported: that chart is a 'use client' module and this section
// is a Server Component, so no runtime value may cross. Keep the two in sync.
const DONUT_TYPES: { code: string; label: string; strokeClass: string }[] = [
  { code: 'invoice', label: 'Invoice', strokeClass: 'stroke-[#184f95] dark:stroke-[#184f95]' },
  { code: 'invoice_against_uplaq', label: 'Invoice against uplaq', strokeClass: 'stroke-[#2a78d6] dark:stroke-[#256abf]' },
  { code: 'advance_payment', label: 'Advance', strokeClass: 'stroke-[#86b6ef] dark:stroke-[#6da7ec]' },
  { code: 'reimbursement', label: 'Reimbursement (control signal)', strokeClass: 'stroke-amber-500 dark:stroke-amber-400' },
]

function eventWideSegments(rows: EntryTypeByDepartmentRow[]): DonutSegment[] {
  const byType = new Map<string, number>()
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + (r.total_amount ?? 0))
  const segments: DonutSegment[] = DONUT_TYPES.filter((t) => (byType.get(t.code) ?? 0) > 0).map((t) => ({
    key: t.code,
    label: t.label,
    value: byType.get(t.code)!,
    colorClass: t.strokeClass,
  }))
  // Any code outside the four entries_type_check values (shouldn't happen)
  // folds into a neutral bucket instead of silently vanishing from the total.
  const known = new Set(DONUT_TYPES.map((t) => t.code))
  const unknown = [...byType].filter(([code, v]) => !known.has(code) && v > 0).reduce((s, [, v]) => s + v, 0)
  if (unknown > 0) segments.push({ key: '__other__', label: 'Other', value: unknown, colorClass: OTHER_STEP.strokeClass })
  return segments
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
  insight,
}: {
  rows: EntryTypeByDepartmentRow[]
  error: string | null
  compareBasis: CompareBasis
  previousReimbursementSharePct: number | null
  insight?: string | null
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
  const donutSegments = eventWideSegments(rows)

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
          <p className="text-sm text-muted-foreground">{insight ?? entryTypeSplitSentence(rows)}</p>
          {donutSegments.length > 0 && (
            <DonutChart
              segments={donutSegments}
              centerLabel={formatINRCompact(share.totalSpend)}
              valueFormat="inr-compact"
            />
          )}
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">By department</p>
          <EntryTypeSplitChart departments={departments} />
          <DataTable columns={columns} rows={tableRows} getRowKey={(r) => r.rowKey} />
        </>
      )}
    </ReportSection>
  )
}
