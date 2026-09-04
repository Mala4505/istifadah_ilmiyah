import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { DonutChart } from '@/components/reports/charts/donut-chart'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { SeverityBadge } from '@/components/reports/severity-badge'
import { toCsv } from '@/lib/reports/csv'
import { cn } from '@/lib/utils'
import { formatINR, formatINRCompact, formatNumber, formatDate, humanizeCode } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs, severitySegments } from '@/lib/reports/sections/shared'
import type { OpenItemAgeingRow } from '@/lib/reports/surfaces/spend-curve-open-ageing'

// reporting-blueprint.md D-03 — "Exceptions and flags by days open and
// severity, with the owning department. Names the queue being sat on." NOT
// hub-status ageing (that ages the workflow pipeline); this ages OPEN
// reconciliation exceptions + flags — the review queue.

const AGE_BUCKETS: OpenItemAgeingRow['age_bucket'][] = ['0-7', '8-30', '31-60', '60+']
const SEVERITIES = ['high', 'medium', 'low'] as const
const UNASSIGNED = 'Unassigned'

const AGE_BUCKET_STYLES: Record<OpenItemAgeingRow['age_bucket'], string> = {
  '0-7': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  '8-30': 'bg-secondary text-secondary-foreground',
  '31-60': 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  '60+': 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
}

function AgeBucketTag({ bucket }: { bucket: OpenItemAgeingRow['age_bucket'] }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        AGE_BUCKET_STYLES[bucket]
      )}
    >
      {bucket} days
    </span>
  )
}

type MatrixCell = { count: number; atRisk: number }
type MatrixRow = { bucket: OpenItemAgeingRow['age_bucket']; cells: Record<string, MatrixCell>; total: MatrixCell }

export function buildAgeSeverityMatrix(rows: OpenItemAgeingRow[]): MatrixRow[] {
  return AGE_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((r) => r.age_bucket === bucket)
    const cells: Record<string, MatrixCell> = {}
    for (const sev of SEVERITIES) {
      const matched = inBucket.filter((r) => (r.severity === 'high' || r.severity === 'medium' ? r.severity : 'low') === sev)
      cells[sev] = { count: matched.length, atRisk: matched.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0) }
    }
    return {
      bucket,
      cells,
      total: { count: inBucket.length, atRisk: inBucket.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0) },
    }
  })
}

type DeptRank = { key: string; name: string; departmentId: number | null; count: number; agedAtRisk: number; oldestDays: number }

/** Departments ranked by ₹ at risk sitting in the aged (31-60 / 60+) buckets,
 *  then by the age of their oldest open item. */
export function buildDepartmentRanking(rows: OpenItemAgeingRow[]): DeptRank[] {
  const byDept = new Map<string, DeptRank>()
  for (const r of rows) {
    const key = r.department_id != null ? String(r.department_id) : UNASSIGNED
    const name = r.department_name ?? UNASSIGNED
    const existing = byDept.get(key) ?? { key, name, departmentId: r.department_id, count: 0, agedAtRisk: 0, oldestDays: 0 }
    existing.count += 1
    existing.oldestDays = Math.max(existing.oldestDays, r.days_open)
    if (r.age_bucket === '31-60' || r.age_bucket === '60+') existing.agedAtRisk += r.amount_at_risk ?? 0
    byDept.set(key, existing)
  }
  return [...byDept.values()].sort((a, b) => b.agedAtRisk - a.agedAtRisk || b.oldestDays - a.oldestDays)
}

/** "N items are open past 30 days, ₹X at risk in them — {dept} is sitting on
 *  the most ({count} items, ₹Y)." (§6 fix #3) */
export function openItemAgeingSentence(rows: OpenItemAgeingRow[], agedCount: number, agedAtRisk: number): string {
  if (rows.length === 0) return 'Nothing is open in reconciliation exceptions or flags right now.'
  if (agedCount === 0) return `${formatNumber(rows.length)} items open, none older than 30 days.`
  const ranking = buildDepartmentRanking(rows)
  const lead = ranking[0]
  const leadAgedItems = rows.filter(
    (r) =>
      (r.age_bucket === '31-60' || r.age_bucket === '60+') &&
      (r.department_id != null ? String(r.department_id) : UNASSIGNED) === lead?.key
  ).length
  const leadDetail =
    lead && lead.agedAtRisk > 0
      ? ` — ${lead.name} is sitting on the most (${formatNumber(leadAgedItems)} aged item${leadAgedItems === 1 ? '' : 's'}, ${formatINR(lead.agedAtRisk)} at risk)`
      : ''
  return `${formatNumber(agedCount)} item${agedCount === 1 ? '' : 's'} open past 30 days, ${formatINR(agedAtRisk)} at risk in ${agedCount === 1 ? 'it' : 'them'}${leadDetail}.`
}

const columns: DataTableColumn<OpenItemAgeingRow>[] = [
  { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
  { key: 'type', header: 'Type', render: (r) => humanizeCode(r.issue_type) },
  { key: 'source', header: 'Source', render: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
  { key: 'atRisk', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
  { key: 'days', header: 'Days open', align: 'right', render: (r) => formatNumber(r.days_open) },
  { key: 'bucket', header: 'Bucket', render: (r) => <AgeBucketTag bucket={r.age_bucket} /> },
  {
    key: 'dept',
    header: 'Department',
    render: (r) =>
      r.department_id != null ? (
        <Link href={`/entries?dept=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.department_name ?? `#${r.department_id}`}
        </Link>
      ) : (
        UNASSIGNED
      ),
  },
  {
    key: 'entry',
    header: 'Entry',
    render: (r) =>
      r.entry_id != null ? (
        <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
          #{r.entry_id}
        </Link>
      ) : (
        '—'
      ),
  },
  { key: 'raised', header: 'Raised', render: (r) => formatDate(r.created_at) },
]

export function OpenItemAgeingSection({
  rows,
  error,
  compareBasis,
  agedOpenCount,
  agedAmountAtRisk,
  previousAgedOpenCount,
}: {
  rows: OpenItemAgeingRow[]
  error: string | null
  compareBasis: CompareBasis
  agedOpenCount: number
  agedAmountAtRisk: number
  previousAgedOpenCount: number | null
}) {
  const matrix = buildAgeSeverityMatrix(rows)
  const ranking = buildDepartmentRanking(rows).filter((d) => d.agedAtRisk > 0 || d.oldestDays > 30)
  const severity = severitySegments(rows)

  const rankItems: BarListItem[] = ranking.slice(0, 12).map((d) => ({
    key: d.key,
    label: d.name,
    value: d.agedAtRisk,
    href: d.departmentId != null ? `/entries?dept=${d.departmentId}` : undefined,
    note: `${formatNumber(d.oldestDays)}d oldest`,
  }))

  return (
    <ReportSection
      id="open-item-ageing"
      title="Open item ageing"
      description="Open reconciliation exceptions and flags by days open and severity, with the owning department — the queue being sat on."
      action={
        <ExportCsvButton
          filename="open-item-ageing.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Source', value: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
            { header: 'ID', value: (r) => r.id },
            { header: 'Type', value: (r) => r.issue_type },
            { header: 'Severity', value: (r) => r.severity },
            { header: '₹ at risk', value: (r) => r.amount_at_risk },
            { header: 'Entry', value: (r) => r.entry_id },
            { header: 'Department', value: (r) => r.department_name ?? UNASSIGNED },
            { header: 'Days open', value: (r) => r.days_open },
            { header: 'Age bucket', value: (r) => r.age_bucket },
            { header: 'Raised', value: (r) => r.created_at },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load open item ageing" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing open"
          description="Reconciliation exceptions and flags appear here while their status is open."
        />
      ) : (
        <>
          <KpiTile
            label="Items open past 30 days"
            value={formatNumber(agedOpenCount)}
            delta={formatDeltaVs(compareBasis, agedOpenCount, previousAgedOpenCount, 'count')}
            deltaTone={deltaToneHigherIsBad(agedOpenCount, previousAgedOpenCount)}
          />
          <p className="text-sm text-muted-foreground">
            {openItemAgeingSentence(rows, agedOpenCount, agedAmountAtRisk)}
          </p>

          {/* age_bucket × severity matrix — count on top, ₹ at risk below. */}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">Days open</th>
                  {SEVERITIES.map((s) => (
                    <th key={s} className="px-3 py-2 text-right font-medium capitalize">
                      {s}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">All</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map((mr) => (
                  <tr key={mr.bucket} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      <AgeBucketTag bucket={mr.bucket} />
                    </td>
                    {SEVERITIES.map((s) => {
                      const cell = mr.cells[s]!
                      return (
                        <td
                          key={s}
                          className={cn(
                            'px-3 py-2 text-right font-mono tabular-nums',
                            cell.count === 0 && 'text-muted-foreground/40'
                          )}
                        >
                          {formatNumber(cell.count)}
                          {cell.atRisk > 0 && (
                            <span className="block text-[10px] text-muted-foreground">{formatINRCompact(cell.atRisk)}</span>
                          )}
                        </td>
                      )
                    })}
                    <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">
                      {formatNumber(mr.total.count)}
                      {mr.total.atRisk > 0 && (
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          {formatINRCompact(mr.total.atRisk)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {severity.length > 0 && <DonutChart segments={severity} centerLabel={`${rows.length} open`} />}

          {rankItems.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Departments by ₹ at risk in aged items
              </p>
              <BarList items={rankItems} valueFormatter={formatINRCompact} />
            </div>
          )}

          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => `${r.source_table}-${r.id}`}
            emptyTitle="Nothing open"
          />
        </>
      )}
    </ReportSection>
  )
}
