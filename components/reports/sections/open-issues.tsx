import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { DonutChart } from '@/components/reports/charts/donut-chart'
import { SeverityBadge } from '@/components/reports/severity-badge'
import { toCsv } from '@/lib/reports/csv'
import { formatDate, formatINR, formatINRCompact, formatNumber, humanizeCode } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs, severitySegments, type OpenIssueRow } from '@/lib/reports/sections/shared'

// Open issues digest (blueprint Integrity surface). Ported verbatim from the
// former app/(app)/reports/page.tsx section of the same id.

/** "N open issues, M high severity; the largest carries ₹X at risk" (§6 fix #3). */
export function openIssuesSentence(rows: OpenIssueRow[]): string {
  if (rows.length === 0) return 'No open issues right now.'
  const highSeverity = rows.filter((r) => r.severity === 'high').length
  const largest = [...rows].sort((a, b) => (b.amount_at_risk ?? 0) - (a.amount_at_risk ?? 0))[0]!
  return highSeverity > 0
    ? `${formatNumber(rows.length)} open issues, ${formatNumber(highSeverity)} high severity; the largest carries ${formatINR(largest.amount_at_risk)} at risk.`
    : `${formatNumber(rows.length)} open issues; the largest carries ${formatINR(largest.amount_at_risk)} at risk.`
}

const issueColumns: DataTableColumn<OpenIssueRow>[] = [
  { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
  { key: 'type', header: 'Type', render: (r) => humanizeCode(r.issue_type) },
  { key: 'source', header: 'Source', render: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
  { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
  {
    key: 'entry',
    header: 'Entry',
    render: (r) =>
      r.entry_id ? (
        <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
          #{r.entry_id}
        </Link>
      ) : (
        '—'
      ),
  },
  {
    key: 'description',
    header: 'Description',
    render: (r) => (
      <span className="block max-w-[24rem] truncate" title={r.description ?? undefined}>
        {r.description ?? '—'}
      </span>
    ),
  },
  { key: 'created', header: 'Raised', render: (r) => formatDate(r.created_at) },
]

export function OpenIssuesSection({
  rows,
  error,
  compareBasis,
  series,
  atRiskTotal,
  previousAtRisk,
}: {
  rows: OpenIssueRow[]
  error: string | null
  compareBasis: CompareBasis
  series: number[]
  atRiskTotal: number
  previousAtRisk: number | null
}) {
  const severity = severitySegments(rows)

  return (
    <ReportSection
      id="open-issues"
      title="Open issues digest"
      description="Reconciliation exceptions and flags, sorted by severity then ₹ at risk."
      action={
        <ExportCsvButton
          filename="open-issues.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Source', value: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
            { header: 'Type', value: (r) => r.issue_type },
            { header: 'Severity', value: (r) => r.severity },
            { header: '₹ at risk', value: (r) => r.amount_at_risk },
            { header: 'Entry', value: (r) => r.entry_id },
            { header: 'Description', value: (r) => r.description },
            { header: 'Raised', value: (r) => r.created_at },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load open issues" description={error} />
      ) : (
        <>
          <KpiTile
            label="₹ at risk (open issues)"
            value={formatINRCompact(atRiskTotal)}
            delta={formatDeltaVs(compareBasis, atRiskTotal, previousAtRisk, 'inr')}
            deltaTone={deltaToneHigherIsBad(atRiskTotal, previousAtRisk)}
            series={series}
          />
          <p className="text-sm text-muted-foreground">{openIssuesSentence(rows)}</p>
          {severity.length > 0 && <DonutChart segments={severity} centerLabel={`${rows.length} issues`} />}
          <DataTable
            columns={issueColumns}
            rows={rows}
            getRowKey={(r) => `${r.source_table}-${r.id}`}
            emptyTitle="No open issues"
            emptyDescription="Nothing in reconciliation_exception or flags is currently open."
          />
        </>
      )}
    </ReportSection>
  )
}
