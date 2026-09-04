import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { DiscountSpreadChart, type DiscountSpreadChartGroup } from '@/components/reports/charts/discount-spread-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import { DISCOUNT_SPREAD_FLAG_PP, type DiscountConsistencyGroup } from '@/lib/reports/surfaces/rate-drift-discount'

// reporting-blueprint.md C-06 — "The same vendor giving different discounts
// to different departments on the same item family." Schema-reality caveat
// (see the migration header and the loader's own header): discount_pct is
// only a numeric field on rate_reference, populated by extraction paths this
// codebase has since retired — the CURRENT save path never writes it. This
// section is expected to run near-empty against the present corpus, and
// says so plainly rather than implying full coverage.

function inconsistent(groups: DiscountConsistencyGroup[]): DiscountConsistencyGroup[] {
  return groups.filter((g) => g.spreadPp >= DISCOUNT_SPREAD_FLAG_PP)
}

/** "Across N vendor + item-family pairs with a captured discount in two or
 *  more departments, M show a spread of 5 percentage points or more — led by
 *  {vendor} · {family} at X pp (only Y of Z comparable purchases in this
 *  family have a captured discount)." (§6 fix #3) */
export function discountConsistencySentence(
  groups: DiscountConsistencyGroup[],
  coverage: { observed: number; total: number }
): string {
  if (groups.length === 0) {
    return coverage.total > 0
      ? `None of the ${formatNumber(coverage.total)} comparable purchases this event has a numeric discount captured yet — this fills in as reviewers verify a bill that states its discount as a percentage.`
      : 'No comparable purchase this event has a numeric discount captured yet — this fills in as reviewers verify a bill that states its discount as a percentage.'
  }
  const multiDept = groups.filter((g) => g.departments.length >= 2)
  const flagged = inconsistent(multiDept)
  const base = `Across ${formatNumber(multiDept.length)} vendor and item-family pair${multiDept.length === 1 ? '' : 's'} with a captured discount in two or more departments`
  if (multiDept.length === 0) {
    return `Every vendor and item-family pair with a captured discount so far has it from only one department — cross-department comparison needs a second department's discount on the same family. (${formatNumber(coverage.observed)} of ${formatNumber(coverage.total)} comparable purchases have a captured discount overall.)`
  }
  if (flagged.length === 0) {
    return `${base}, none shows a spread of ${DISCOUNT_SPREAD_FLAG_PP} percentage points or more. (${formatNumber(coverage.observed)} of ${formatNumber(coverage.total)} comparable purchases have a captured discount overall.)`
  }
  const lead = [...flagged].sort((a, b) => b.spreadPp - a.spreadPp)[0]!
  return `${base}, ${formatNumber(flagged.length)} ${flagged.length === 1 ? 'shows' : 'show'} a spread of ${DISCOUNT_SPREAD_FLAG_PP} percentage points or more — led by ${lead.vendorName} · ${lead.familyLabel} at ${lead.spreadPp.toFixed(1)} pp. (${formatNumber(coverage.observed)} of ${formatNumber(coverage.total)} comparable purchases have a captured discount overall.)`
}

export function DiscountConsistencySection({
  groups,
  error,
  compareBasis,
  previousInconsistentCount,
  coverage,
}: {
  groups: DiscountConsistencyGroup[]
  error: string | null
  compareBasis: CompareBasis
  previousInconsistentCount: number | null
  coverage: { observed: number; total: number }
}) {
  const multiDept = groups.filter((g) => g.departments.length >= 2)
  const flagged = inconsistent(multiDept)
  const previous = compareBasis === 'prior_event' ? previousInconsistentCount : null
  const coveragePct = coverage.total > 0 ? (coverage.observed / coverage.total) * 100 : null

  const chartGroups: DiscountSpreadChartGroup[] = multiDept.map((g) => ({
    key: g.key,
    vendorName: g.vendorName,
    familyLabel: g.familyLabel,
    spreadPp: g.spreadPp,
    departments: g.departments,
  }))

  type DeptTableRow = {
    key: string
    vendorId: number | null
    vendorName: string
    familyLabel: string
    departmentId: number | null
    departmentName: string
    avgDiscountPct: number
    observationCount: number
    spreadPp: number
  }
  const tableRows: DeptTableRow[] = [...groups]
    .sort((a, b) => b.spreadPp - a.spreadPp)
    .flatMap((g) =>
      g.departments.map((d) => ({
        key: `${g.key}::${d.departmentId ?? d.departmentName}`,
        vendorId: g.vendorId,
        vendorName: g.vendorName,
        familyLabel: g.familyLabel,
        departmentId: d.departmentId,
        departmentName: d.departmentName,
        avgDiscountPct: d.avgDiscountPct,
        observationCount: d.observationCount,
        spreadPp: g.spreadPp,
      }))
    )

  const columns: DataTableColumn<DeptTableRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendorId ? (
          <Link href={`/entries?vendor_id=${r.vendorId}`} className="text-primary underline-offset-2 hover:underline">
            {r.vendorName}
          </Link>
        ) : (
          r.vendorName
        ),
    },
    { key: 'family', header: 'Item family', render: (r) => r.familyLabel },
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.departmentId ? (
          <Link href={`/entries?department_id=${r.departmentId}`} className="text-primary underline-offset-2 hover:underline">
            {r.departmentName}
          </Link>
        ) : (
          r.departmentName
        ),
    },
    { key: 'avg', header: 'Avg. discount', align: 'right', render: (r) => formatPercent(r.avgDiscountPct) },
    { key: 'obs', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observationCount) },
    { key: 'spread', header: 'Group spread', align: 'right', render: (r) => `${r.spreadPp.toFixed(1)} pp` },
  ]

  return (
    <ReportSection
      id="discount-consistency"
      title="Discount consistency"
      description="The same vendor's discount on the same item family, compared across departments — a captured percentage discount only, from rate_reference.discount_pct, never the free-text discount note on a bill line."
      action={
        <ExportCsvButton
          filename="discount-consistency.csv"
          rowCount={tableRows.length}
          csv={toCsv(tableRows, [
            { header: 'Vendor', value: (r) => r.vendorName },
            { header: 'Item family', value: (r) => r.familyLabel },
            { header: 'Department', value: (r) => r.departmentName },
            { header: 'Avg. discount %', value: (r) => r.avgDiscountPct },
            { header: 'Observations', value: (r) => r.observationCount },
            { header: 'Group spread (pp)', value: (r) => r.spreadPp },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load discount consistency" description={error} />
      ) : groups.length === 0 ? (
        <EmptyState
          title="No numeric discount captured yet"
          description={`Discount consistency needs rate_reference.discount_pct — a discount captured as a number, not the free-text note on a bill line — for the same vendor and item family in two or more departments. ${coverage.total > 0 ? `${formatNumber(coverage.observed)} of ${formatNumber(coverage.total)} comparable purchases this event have one so far.` : 'None of this event’s comparable purchases have one so far.'} It fills in as more bills stating a percentage discount are verified.`}
        />
      ) : (
        <>
          <KpiTile
            label={`Pairs with spread ≥ ${DISCOUNT_SPREAD_FLAG_PP}pp`}
            value={formatNumber(flagged.length)}
            delta={formatDeltaVs(compareBasis, flagged.length, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(flagged.length, previous)}
          />
          <p className="text-xs font-medium text-muted-foreground">
            Coverage: {formatNumber(coverage.observed)} of {formatNumber(coverage.total)} comparable purchases this event have a
            captured discount{coveragePct != null ? ` (${formatPercent(coveragePct)})` : ''} — the comparison below is only as
            complete as that number.
          </p>
          <p className="text-sm text-muted-foreground">{discountConsistencySentence(groups, coverage)}</p>
          {chartGroups.length > 0 && <DiscountSpreadChart groups={chartGroups} />}
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => r.key}
            emptyTitle="No captured discount yet"
          />
        </>
      )}
    </ReportSection>
  )
}
