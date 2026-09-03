import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { DonutChart } from '@/components/reports/charts/donut-chart'
import { SeverityBadge } from '@/components/reports/severity-badge'
import { toCsv } from '@/lib/reports/csv'
import { formatDateTime, formatINR, formatINRCompact, formatNumber, humanizeCode } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs, severitySegments, type ComplianceRow } from '@/lib/reports/sections/shared'

// Compliance & leakage (blueprint Integrity surface). Ported verbatim from
// the former app/(app)/reports/page.tsx section of the same id.

/** "N open flags carrying ₹X at risk; <type> is the most common" (§6 fix #3). */
export function complianceSentence(rows: ComplianceRow[], byType: [string, number][], totalAtRisk: number): string {
  if (rows.length === 0) return 'No open compliance flags.'
  const [topType, topCount] = byType[0]!
  return `${formatNumber(rows.length)} open flags carrying ${formatINRCompact(totalAtRisk)} at risk; ${humanizeCode(topType).toLowerCase()} is the most common, at ${formatNumber(topCount)}.`
}

const complianceColumns: DataTableColumn<ComplianceRow>[] = [
  { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
  { key: 'type', header: 'Type', render: (r) => humanizeCode(r.flag_type) },
  { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
  {
    key: 'vendor',
    header: 'Vendor',
    render: (r) =>
      r.vendor_id ? (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.vendor_display_name ?? `#${r.vendor_id}`}
        </Link>
      ) : (
        '—'
      ),
  },
  {
    key: 'entry',
    header: 'Entry',
    render: (r) =>
      r.entry_id ? (
        <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
          #{r.entry_id}
        </Link>
      ) : r.related_entry_ids && r.related_entry_ids.length > 0 ? (
        <span className="text-muted-foreground">{r.related_entry_ids.length} entries</span>
      ) : (
        '—'
      ),
  },
  { key: 'department', header: 'Department', render: (r) => r.department_name ?? '—' },
  {
    key: 'description',
    header: 'Description',
    render: (r) => (
      <span className="block max-w-[24rem] truncate" title={r.description ?? undefined}>
        {r.description ?? '—'}
      </span>
    ),
  },
  { key: 'detected', header: 'Last Seen', render: (r) => formatDateTime(r.last_detected_at) },
]

export function ComplianceSection({
  rows,
  error,
  compareBasis,
  series,
  atRiskTotal,
  byType,
  previousAtRisk,
}: {
  rows: ComplianceRow[]
  error: string | null
  compareBasis: CompareBasis
  series: number[]
  atRiskTotal: number
  byType: [string, number][]
  previousAtRisk: number | null
}) {
  const severity = severitySegments(rows)

  return (
    <ReportSection
      id="compliance"
      title="Compliance & leakage"
      description="Open flags sorted by severity then ₹ at risk — tax, GSTIN, and statutory findings alongside vendor-pattern findings (splitting, duplicate payment, TDS threshold)."
      action={
        <ExportCsvButton
          filename="compliance-flags.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Type', value: (r) => r.flag_type },
            { header: 'Severity', value: (r) => r.severity },
            { header: '₹ at risk', value: (r) => r.amount_at_risk },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Entry', value: (r) => r.entry_id },
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Description', value: (r) => r.description },
            { header: 'First Detected', value: (r) => r.created_at },
            { header: 'Last Seen', value: (r) => r.last_detected_at },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load compliance flags" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No open compliance flags"
          description="flags-run scans every verified document and vendor payment history every 15 minutes. This is expected to be empty until documents have been reviewed (Day 4 verify) and at least one sweep has run."
        />
      ) : (
        <>
          <KpiTile
            label="₹ at risk (compliance)"
            value={formatINRCompact(atRiskTotal)}
            delta={formatDeltaVs(compareBasis, atRiskTotal, previousAtRisk, 'inr')}
            deltaTone={deltaToneHigherIsBad(atRiskTotal, previousAtRisk)}
            series={series}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border border-border p-3">
              <p className="text-2xl font-mono font-semibold tracking-tight">{formatNumber(rows.length)}</p>
              <p className="mt-1 text-xs text-muted-foreground">open flags</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-2xl font-mono font-semibold tracking-tight">{formatINRCompact(atRiskTotal)}</p>
              <p className="mt-1 text-xs text-muted-foreground">total ₹ at risk</p>
            </div>
            {byType.slice(0, 2).map(([type, count]) => (
              <div key={type} className="rounded-md border border-border p-3">
                <p className="text-2xl font-mono font-semibold tracking-tight">{formatNumber(count)}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{humanizeCode(type)}</p>
              </div>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{complianceSentence(rows, byType, atRiskTotal)}</p>
          {severity.length > 0 && <DonutChart segments={severity} centerLabel={`${rows.length} flags`} />}
          <DataTable columns={complianceColumns} rows={rows} getRowKey={(r) => r.id} />
        </>
      )}
    </ReportSection>
  )
}
