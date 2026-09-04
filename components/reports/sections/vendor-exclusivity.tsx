import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { VendorExclusivityChart, type VendorExclusivityBar } from '@/components/reports/charts/vendor-exclusivity-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatNumber } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import { countMaterialSingleDepartmentVendors, type VendorExclusivityRow } from '@/lib/reports/surfaces/vendor-dependency'

// reporting-blueprint.md B-04 — "Vendors serving exactly one department,
// especially at high value. Not wrong in itself — but it is where a
// relationship, rather than a market, is setting the price."

function isExclusive(row: VendorExclusivityRow): boolean {
  return row.distinct_department_count === 1
}

/** "18 vendors serve exactly one department this event; the largest is
 *  {vendor} at {spend} in {department}." */
export function vendorExclusivitySentence(rows: VendorExclusivityRow[]): string {
  const exclusive = rows.filter(isExclusive)
  if (exclusive.length === 0) {
    return 'No vendor is exclusive to a single department this event.'
  }
  const largest = [...exclusive].sort((a, b) => b.total_spend - a.total_spend)[0]!
  return `${formatNumber(exclusive.length)} vendor${exclusive.length === 1 ? '' : 's'} serve exactly one department this event — the largest is ${
    largest.vendor_display_name
  } at ${formatINR(largest.total_spend)} in ${largest.department_name ?? 'that department'}.`
}

export function VendorExclusivitySection({
  rows,
  error,
  compareBasis,
  previousMaterialCount,
}: {
  rows: VendorExclusivityRow[]
  error: string | null
  compareBasis: CompareBasis
  previousMaterialCount: number | null
}) {
  const materialCount = countMaterialSingleDepartmentVendors(rows)
  const previous = compareBasis === 'prior_event' ? previousMaterialCount : null

  const exclusiveRows = rows.filter(isExclusive).sort((a, b) => b.total_spend - a.total_spend)

  const bars: VendorExclusivityBar[] = exclusiveRows.map((r) => ({
    key: r.vendor_id,
    vendorLabel: r.vendor_display_name,
    vendorHref: `/entries?vendor_id=${r.vendor_id}`,
    departmentLabel: r.department_name ?? '—',
    departmentHref: r.department_id != null ? `/entries?department_id=${r.department_id}` : undefined,
    spend: r.total_spend,
  }))

  const columns: DataTableColumn<VendorExclusivityRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.vendor_display_name}
        </Link>
      ),
    },
    {
      key: 'department',
      header: 'Sole department',
      render: (r) =>
        r.department_id != null ? (
          <Link href={`/entries?department_id=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.department_name}
          </Link>
        ) : (
          (r.department_name ?? '—')
        ),
    },
    { key: 'spend', header: 'Total spend', align: 'right', render: (r) => formatINR(r.total_spend) },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
  ]

  return (
    <ReportSection
      id="vendor-exclusivity"
      title="Vendor exclusivity"
      description="Vendors serving exactly one department this event, ranked by spend. Not wrong in itself, but it is where a relationship, rather than a market, is setting the price."
      action={
        <ExportCsvButton
          filename="vendor-exclusivity.csv"
          rowCount={exclusiveRows.length}
          csv={toCsv(exclusiveRows, [
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Sole department', value: (r) => r.department_name },
            { header: 'Total spend', value: (r) => r.total_spend },
            { header: 'Entries', value: (r) => r.entry_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load vendor exclusivity" description={error} />
      ) : exclusiveRows.length === 0 ? (
        <EmptyState
          title="No exclusive vendors yet"
          description="This fills in as vendors bill against more than zero, but only one, department this event."
        />
      ) : (
        <>
          <KpiTile
            label="High-value single-department vendors"
            value={formatNumber(materialCount)}
            delta={formatDeltaVs(compareBasis, materialCount, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(materialCount, previous)}
          />
          <p className="text-sm text-muted-foreground">{vendorExclusivitySentence(rows)}</p>
          <VendorExclusivityChart bars={bars} />
          <DataTable
            columns={columns}
            rows={exclusiveRows}
            getRowKey={(r) => r.vendor_id}
            emptyTitle="No exclusive vendors yet"
          />
        </>
      )}
    </ReportSection>
  )
}
