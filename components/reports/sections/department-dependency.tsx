import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { DepartmentDependencyChart, type DepartmentDependencyBar } from '@/components/reports/charts/department-dependency-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  DEPARTMENT_DEPENDENCY_THRESHOLD_PCT,
  countOverThreshold,
  type DepartmentVendorDependencyRow,
} from '@/lib/reports/surfaces/vendor-dependency'

// reporting-blueprint.md B-03 — "Which departments rely on a single vendor
// for more than half their spend. Single-source risk, named."

function overThreshold(row: DepartmentVendorDependencyRow): boolean {
  return (row.top_vendor_share_pct ?? 0) > DEPARTMENT_DEPENDENCY_THRESHOLD_PCT
}

/** "3 departments rely on a single vendor for more than half their spend —
 *  worst is {department}, where {vendor} carries {share}% of spend." Names
 *  the worst offender by name, per the blueprint's "named" framing. */
export function departmentDependencySentence(rows: DepartmentVendorDependencyRow[]): string {
  const over = rows.filter(overThreshold)
  if (over.length === 0) {
    return 'No department currently relies on a single vendor for more than half its spend.'
  }
  const worst = [...over].sort((a, b) => (b.top_vendor_share_pct ?? 0) - (a.top_vendor_share_pct ?? 0))[0]!
  return `${formatNumber(over.length)} department${over.length === 1 ? '' : 's'} rely on a single vendor for more than half their spend — worst is ${
    worst.department_name
  }, where ${worst.top_vendor_display_name} carries ${formatPercent(worst.top_vendor_share_pct)} of spend.`
}

export function DepartmentDependencySection({
  rows,
  error,
  compareBasis,
  previousOverThresholdCount,
}: {
  rows: DepartmentVendorDependencyRow[]
  error: string | null
  compareBasis: CompareBasis
  previousOverThresholdCount: number | null
}) {
  const overThresholdCount = countOverThreshold(rows)
  const previous = compareBasis === 'prior_event' ? previousOverThresholdCount : null

  const bars: DepartmentDependencyBar[] = rows.map((r) => ({
    key: r.department_id,
    departmentLabel: r.department_name,
    departmentHref: `/entries?department_id=${r.department_id}`,
    topVendorLabel: r.top_vendor_display_name,
    topVendorHref: `/entries?vendor_id=${r.top_vendor_id}`,
    sharePct: r.top_vendor_share_pct ?? 0,
    topVendorSpend: r.top_vendor_spend,
    departmentTotalSpend: r.department_total_spend,
    vendorCount: r.vendor_count,
  }))

  const tableRows = [...rows].sort((a, b) => (b.top_vendor_share_pct ?? 0) - (a.top_vendor_share_pct ?? 0))

  const columns: DataTableColumn<DepartmentVendorDependencyRow>[] = [
    {
      key: 'department',
      header: 'Department',
      render: (r) => (
        <Link href={`/entries?department_id=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.department_name}
        </Link>
      ),
    },
    {
      key: 'vendor',
      header: 'Top vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.top_vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.top_vendor_display_name}
        </Link>
      ),
    },
    { key: 'share', header: 'Share of dept. spend', align: 'right', render: (r) => formatPercent(r.top_vendor_share_pct) },
    { key: 'vendorSpend', header: 'Top vendor spend', align: 'right', render: (r) => formatINR(r.top_vendor_spend) },
    { key: 'deptSpend', header: 'Department total', align: 'right', render: (r) => formatINR(r.department_total_spend) },
    { key: 'vendorCount', header: 'Vendors used', align: 'right', render: (r) => formatNumber(r.vendor_count) },
  ]

  return (
    <ReportSection
      id="department-dependency"
      title="Department dependency"
      description="Each department's top vendor by spend, and its share of that department's total. Departments past the 50% line rely on a single vendor for more than half their spend — single-source risk, named."
      action={
        <ExportCsvButton
          filename="department-vendor-dependency.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Top vendor', value: (r) => r.top_vendor_display_name },
            { header: 'Top vendor spend', value: (r) => r.top_vendor_spend },
            { header: 'Department total spend', value: (r) => r.department_total_spend },
            { header: 'Share %', value: (r) => r.top_vendor_share_pct },
            { header: 'Vendors used', value: (r) => r.vendor_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load department dependency" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No department spend yet"
          description="This fills in once entries carry both a department and a vendor."
        />
      ) : (
        <>
          <KpiTile
            label="Departments over 50% single-vendor share"
            value={formatNumber(overThresholdCount)}
            delta={formatDeltaVs(compareBasis, overThresholdCount, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(overThresholdCount, previous)}
          />
          <p className="text-sm text-muted-foreground">{departmentDependencySentence(rows)}</p>
          <DepartmentDependencyChart bars={bars} />
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => r.department_id}
            emptyTitle="No department spend yet"
          />
        </>
      )}
    </ReportSection>
  )
}
