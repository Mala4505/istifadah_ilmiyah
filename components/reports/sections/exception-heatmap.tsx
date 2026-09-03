import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { SeverityBadge } from '@/components/reports/severity-badge'
import { HeatmapMatrixChart, type HeatmapCell } from '@/components/reports/charts/heatmap-matrix-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, humanizeCode } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs, type ExceptionHeatmapRow } from '@/lib/reports/sections/shared'

// reporting-blueprint.md D-01 (flagship) — the exception heat map. "Exception
// type down, department across, cell shaded by rupees at risk. One glance
// separates the expensive break from the merely noisy one." The view unions
// reconciliation_exception + flags at (source_table, issue_type, severity,
// department, event) grain; this section rolls severity up per cell for the
// matrix and keeps it in the table (via SeverityBadge — the severity field is
// a status dimension, never a data series).

/** Placeholder column for issues whose entry — and therefore department —
 *  can't be resolved (vendor-level flag, batch-level exception). Never
 *  dropped: those are often the largest single findings. */
const NO_DEPARTMENT = 'No department'

type AggregatedCell = HeatmapCell & {
  typeLabel: string
  departmentLabel: string
  departmentId: number | null
}

/**
 * Rolls the per-(type, severity, department) view rows up to one cell per
 * (type, department): summed ₹ at risk and issue count, with the axes ordered
 * by total ₹ at risk descending. "No department" always sorts last on the
 * column axis. Exported so the sentence helper and the section share exactly
 * one aggregation.
 */
export function buildHeatmapCells(rows: ExceptionHeatmapRow[]): {
  cells: AggregatedCell[]
  rowAxis: { key: string; label: string }[]
  colAxis: { key: string; label: string }[]
} {
  const cellByKey = new Map<string, AggregatedCell>()
  const rowTotal = new Map<string, number>()
  const colTotal = new Map<string, number>()

  for (const row of rows) {
    const typeLabel = humanizeCode(row.issue_type)
    const departmentLabel = row.department_name ?? NO_DEPARTMENT
    const key = `${typeLabel}||${departmentLabel}`
    const existing = cellByKey.get(key)
    if (existing) {
      existing.amountAtRisk += row.amount_at_risk
      existing.issueCount += row.issue_count
    } else {
      cellByKey.set(key, {
        rowKey: typeLabel,
        colKey: departmentLabel,
        typeLabel,
        departmentLabel,
        departmentId: row.department_id,
        amountAtRisk: row.amount_at_risk,
        issueCount: row.issue_count,
      })
    }
    rowTotal.set(typeLabel, (rowTotal.get(typeLabel) ?? 0) + row.amount_at_risk)
    colTotal.set(departmentLabel, (colTotal.get(departmentLabel) ?? 0) + row.amount_at_risk)
  }

  const rowAxis = [...rowTotal.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => ({ key, label: key }))
  const colAxis = [...colTotal.entries()]
    .sort((a, b) => {
      if (a[0] === NO_DEPARTMENT) return 1
      if (b[0] === NO_DEPARTMENT) return -1
      return b[1] - a[1]
    })
    .map(([key]) => ({ key, label: key }))

  return { cells: [...cellByKey.values()], rowAxis, colAxis }
}

/** "6 open issue types across 4 departments; ledger vs bill mismatch in
 *  Tabligh carries the most at ₹3.2 L." (§6 fix #3) */
export function exceptionHeatmapSentence(rows: ExceptionHeatmapRow[]): string {
  if (rows.length === 0) return 'No open exceptions or flags right now.'
  const { cells, rowAxis, colAxis } = buildHeatmapCells(rows)
  const base = `${formatNumber(rowAxis.length)} open issue ${rowAxis.length === 1 ? 'type' : 'types'} across ${formatNumber(
    colAxis.length
  )} ${colAxis.length === 1 ? 'department' : 'departments'}`
  const top = [...cells].sort((a, b) => b.amountAtRisk - a.amountAtRisk)[0]
  if (!top || top.amountAtRisk <= 0) return `${base}; none carries a rupee figure yet.`
  return `${base}; ${top.typeLabel.toLowerCase()} in ${top.departmentLabel} carries the most at ${formatINRCompact(
    top.amountAtRisk
  )}.`
}

const heatmapColumns: DataTableColumn<ExceptionHeatmapRow>[] = [
  { key: 'type', header: 'Type', render: (r) => humanizeCode(r.issue_type) },
  {
    key: 'department',
    header: 'Department',
    render: (r) =>
      r.department_id != null ? (
        <Link
          href={`/entries?department_id=${r.department_id}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {r.department_name ?? `#${r.department_id}`}
        </Link>
      ) : (
        <span className="text-muted-foreground">No department</span>
      ),
  },
  { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
  { key: 'source', header: 'Source', render: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
  { key: 'count', header: 'Issues', align: 'right', render: (r) => formatNumber(r.issue_count) },
  { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
]

export function ExceptionHeatmapSection({
  rows,
  error,
  compareBasis,
  previousTotalAtRisk,
}: {
  rows: ExceptionHeatmapRow[]
  error: string | null
  compareBasis: CompareBasis
  previousTotalAtRisk: number | null
}) {
  const totalAtRisk = rows.reduce((s, r) => s + r.amount_at_risk, 0)
  const { cells, rowAxis, colAxis } = buildHeatmapCells(rows)
  const previous = compareBasis === 'prior_event' ? previousTotalAtRisk : null

  return (
    <ReportSection
      id="exception-heatmap"
      title="Exception heat map"
      description="Open reconciliation exceptions and flags — issue type down the rows, department across the columns, each cell shaded darker the more rupees are at risk. One hue, five bins: darker always and only means more. Vendor- and batch-level findings with no traceable department keep their own column."
      action={
        <ExportCsvButton
          filename="exception-heatmap.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Source', value: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
            { header: 'Type', value: (r) => r.issue_type },
            { header: 'Severity', value: (r) => r.severity },
            { header: 'Department', value: (r) => r.department_name ?? 'No department' },
            { header: 'Open issues', value: (r) => r.issue_count },
            { header: '₹ at risk', value: (r) => r.amount_at_risk },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the exception heat map" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No open exceptions or flags"
          description="reconciliation_exception and flags are both empty of open rows for this event. Expected until documents have been verified and at least one flags sweep has run."
        />
      ) : (
        <>
          <KpiTile
            label="₹ at risk (open, by type × dept)"
            value={formatINRCompact(totalAtRisk)}
            delta={formatDeltaVs(compareBasis, totalAtRisk, previous, 'inr')}
            deltaTone={deltaToneHigherIsBad(totalAtRisk, previous)}
          />
          <p className="text-sm text-muted-foreground">{exceptionHeatmapSentence(rows)}</p>
          <HeatmapMatrixChart rows={rowAxis} columns={colAxis} cells={cells} />
          <DataTable
            columns={heatmapColumns}
            rows={rows}
            getRowKey={(r) => `${r.source_table}-${r.issue_type}-${r.severity}-${r.department_id ?? 'none'}`}
          />
        </>
      )}
    </ReportSection>
  )
}
