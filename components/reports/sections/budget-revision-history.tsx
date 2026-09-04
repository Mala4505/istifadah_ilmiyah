import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { WaterfallChart, type WaterfallStage } from '@/components/reports/charts/waterfall-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatDate, formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import type { BudgetRevisionHistoryRow } from '@/lib/reports/surfaces/budget-structure'
import {
  BudgetRevisionHistoryPicker,
  type BudgetRevisionHistoryCandidate,
} from '@/components/reports/sections/budget-revision-history-picker'

// reporting-blueprint.md §8 Phase Six A-02 -- "Allocations are dated: original
// ask → approved → each revision → today, as a waterfall. Shows who kept
// coming back for more." Backed by v_budget_revision_history
// (20260903000013): one row per dated budget_allocation snapshot, carrying the
// running revision sequence and per-step deltas.
//
// "effective amount" = approved once it is a real (non-zero) figure, the
// requested amount until then -- see the migration header. The sample data
// has approved_amount = 0 on every head, so the report keys its "revised
// upward" logic on effective_amount and keeps approved-only movement in the
// CSV.
//
// §6 fix #4: the head figure links to its filtered entries via `/entries?bh=`
// (the param the entries explorer actually reads -- NOT `budget_head_id`).

type HeadSummary = {
  headId: number
  label: string
  departmentName: string | null
  snapshots: BudgetRevisionHistoryRow[]
  revisionCount: number
  timesIncreased: number
  firstEffective: number
  latestEffective: number
  upwardTotal: number
  latestAsOf: string
}

function summarise(rows: BudgetRevisionHistoryRow[]): HeadSummary[] {
  const byHead = new Map<number, BudgetRevisionHistoryRow[]>()
  for (const row of rows) {
    const bucket = byHead.get(row.budget_head_id)
    if (bucket) bucket.push(row)
    else byHead.set(row.budget_head_id, [row])
  }

  const summaries: HeadSummary[] = []
  for (const snapshots of byHead.values()) {
    const ordered = [...snapshots].sort((a, b) => a.revision_seq - b.revision_seq)
    const first = ordered[0]!
    const last = ordered[ordered.length - 1]!
    const upwardTotal = Math.max(0, last.effective_amount - first.effective_amount)
    summaries.push({
      headId: first.budget_head_id,
      label: first.budget_head_label,
      departmentName: first.department_name,
      snapshots: ordered,
      revisionCount: ordered.length,
      timesIncreased: ordered.filter((r) => (r.effective_delta ?? 0) > 0).length,
      firstEffective: first.effective_amount,
      latestEffective: last.effective_amount,
      upwardTotal,
      latestAsOf: last.as_of,
    })
  }
  return summaries
}

/** Heads with a real revision trail -- more than one dated snapshot. */
function revisedHeads(summaries: HeadSummary[]): HeadSummary[] {
  return summaries
    .filter((s) => s.revisionCount >= 2)
    .sort((a, b) => b.upwardTotal - a.upwardTotal || b.revisionCount - a.revisionCount)
}

/** §6 fix #3 -- one computed sentence describing the revision picture. */
export function budgetRevisionHistorySentence(rows: BudgetRevisionHistoryRow[]): string {
  const revised = revisedHeads(summarise(rows))
  if (revised.length === 0) {
    return 'No budget head has more than one dated allocation snapshot yet — the revision trail appears once a head is re-allocated.'
  }
  const cameBackForMore = revised.filter((s) => s.upwardTotal > 0)
  const totalAdded = cameBackForMore.reduce((sum, s) => sum + s.upwardTotal, 0)
  if (cameBackForMore.length === 0) {
    return `${formatNumber(revised.length)} budget head${revised.length === 1 ? '' : 's'} ${
      revised.length === 1 ? 'has' : 'have'
    } been re-allocated, but none ended higher than its first ask.`
  }
  const top = cameBackForMore[0]!
  return `${formatNumber(cameBackForMore.length)} of ${formatNumber(
    revised.length
  )} re-allocated budget head${revised.length === 1 ? '' : 's'} ended higher than the first ask — ${formatINRCompact(
    totalAdded
  )} added in total. ${top.label} rose the most, from ${formatINRCompact(top.firstEffective)} to ${formatINRCompact(
    top.latestEffective
  )} across ${formatNumber(top.revisionCount)} snapshots.`
}

function toCandidate(s: HeadSummary): BudgetRevisionHistoryCandidate {
  return {
    id: s.headId,
    label: s.departmentName ? `${s.label} · ${s.departmentName}` : s.label,
    revisionCount: s.revisionCount,
    upwardTotal: s.upwardTotal,
  }
}

function toStages(s: HeadSummary): WaterfallStage[] {
  return s.snapshots.map((snap, i) => ({
    key: String(snap.allocation_id),
    label: i === 0 ? `First ask · ${formatDate(snap.as_of)}` : formatDate(snap.as_of),
    amount: snap.effective_amount,
    count: null,
  }))
}

export function BudgetRevisionHistorySection({
  rows,
  error,
  selectedHeadId,
}: {
  rows: BudgetRevisionHistoryRow[]
  error: string | null
  selectedHeadId: number | null
}) {
  const summaries = summarise(rows)
  const revised = revisedHeads(summaries)

  const cameBackForMore = revised.filter((s) => s.upwardTotal > 0)
  const totalAdded = cameBackForMore.reduce((sum, s) => sum + s.upwardTotal, 0)

  const selected =
    (selectedHeadId != null && revised.find((s) => s.headId === selectedHeadId)) || revised[0] || null

  const columns: DataTableColumn<HeadSummary>[] = [
    {
      key: 'head',
      header: 'Budget head',
      render: (s) => (
        <Link href={`/entries?bh=${s.headId}`} className="text-primary underline-offset-2 hover:underline">
          {s.label}
        </Link>
      ),
    },
    { key: 'department', header: 'Department', render: (s) => s.departmentName ?? 'Unassigned' },
    { key: 'snapshots', header: 'Snapshots', align: 'right', render: (s) => formatNumber(s.revisionCount) },
    { key: 'timesUp', header: 'Times increased', align: 'right', render: (s) => formatNumber(s.timesIncreased) },
    { key: 'first', header: 'First ask', align: 'right', render: (s) => formatINR(s.firstEffective) },
    { key: 'latest', header: 'Latest figure', align: 'right', render: (s) => formatINR(s.latestEffective) },
    {
      key: 'upward',
      header: 'Added since first ask',
      align: 'right',
      render: (s) => (s.upwardTotal > 0 ? formatINR(s.upwardTotal) : '—'),
    },
    { key: 'asOf', header: 'Latest as of', render: (s) => formatDate(s.latestAsOf) },
  ]

  const csv = toCsv(rows, [
    { header: 'Budget Head', value: (r) => r.budget_head_label },
    { header: 'Department', value: (r) => r.department_name },
    { header: 'Event ID', value: (r) => r.event_id },
    { header: 'Revision Seq', value: (r) => r.revision_seq },
    { header: 'As Of', value: (r) => r.as_of },
    { header: 'Request Amount', value: (r) => r.request_amount },
    { header: 'Approved Amount', value: (r) => r.approved_amount },
    { header: 'Utilised Amount', value: (r) => r.utilised_amount },
    { header: 'Balance Amount', value: (r) => r.balance_amount },
    { header: 'Effective Amount', value: (r) => r.effective_amount },
    { header: 'Approved Delta', value: (r) => r.approved_delta },
    { header: 'Effective Delta', value: (r) => r.effective_delta },
    { header: 'Is First', value: (r) => String(r.is_first) },
    { header: 'Is Latest', value: (r) => String(r.is_latest) },
  ])

  return (
    <ReportSection
      id="budget-revision-history"
      title="Budget revision history"
      description="Every dated allocation snapshot for a head, from the first ask to today. A head that keeps coming back for more shows a rising staircase."
      action={<ExportCsvButton filename="budget-revision-history.csv" rowCount={rows.length} csv={csv} />}
    >
      {error ? (
        <EmptyState title="Couldn't load budget revision history" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No allocation snapshots yet"
          description="Budget allocations arrive via import; the revision trail builds up as heads are re-allocated."
        />
      ) : revised.length === 0 ? (
        <EmptyState
          title="No head has been re-allocated yet"
          description="Every budget head has exactly one dated allocation snapshot, so there is no revision trail to chart."
        />
      ) : (
        <>
          <KpiTile
            label="Budget heads revised upward"
            value={formatNumber(cameBackForMore.length)}
            delta={totalAdded > 0 ? `+${formatINRCompact(totalAdded)} added since first ask` : undefined}
            deltaTone="neutral"
          />
          <BudgetRevisionHistoryPicker candidates={revised.map(toCandidate)} selectedId={selectedHeadId} />
          {selected && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {selected.label}
                {selected.departmentName ? ` · ${selected.departmentName}` : ''} — {formatNumber(selected.revisionCount)}{' '}
                snapshots
              </p>
              <WaterfallChart stages={toStages(selected)} />
            </div>
          )}
          <p className="text-sm text-muted-foreground">{budgetRevisionHistorySentence(rows)}</p>
          <DataTable columns={columns} rows={revised} getRowKey={(s) => s.headId} />
        </>
      )}
    </ReportSection>
  )
}
