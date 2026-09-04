import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { VendorPriceRankingChart, type VendorPriceDot } from '@/components/reports/charts/vendor-price-ranking-chart'
import { toCsv } from '@/lib/reports/csv'
import Link from 'next/link'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { RATE_BENCHMARK_MIN_VENDORS } from '@/lib/analytics/thresholds'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsGood, formatDeltaVs } from '@/lib/reports/sections/shared'
import { countMultiVendorFamilies, type VendorPriceByFamilyRow } from '@/lib/reports/surfaces/quantity-zone-price'

// reporting-blueprint.md B-06 — price ranking per item family. "For each item
// we buy repeatedly: who charges what, ranked. Turns purchasing from a habit
// into a choice." v_rate_benchmark broken out one level further, to one row
// per vendor; not filtered to reliably-ranked (>= RATE_BENCHMARK_MIN_VENDORS)
// families here, same convention rate-benchmark.tsx already uses — a
// single-vendor family still lists, just isn't much of a "ranking" yet.

function familyKeyOf(r: VendorPriceByFamilyRow): string {
  return `${r.item_family_id}::${r.unit_normalized ?? ''}`
}

function widestVendorSpread(
  rows: VendorPriceByFamilyRow[]
): { row: VendorPriceByFamilyRow; cheapest: VendorPriceByFamilyRow; priciest: VendorPriceByFamilyRow; ratio: number } | null {
  const byFamily = new Map<string, VendorPriceByFamilyRow[]>()
  for (const r of rows) {
    if (r.median_rate == null || r.vendor_count < RATE_BENCHMARK_MIN_VENDORS) continue
    const list = byFamily.get(familyKeyOf(r)) ?? []
    list.push(r)
    byFamily.set(familyKeyOf(r), list)
  }
  let best: { row: VendorPriceByFamilyRow; cheapest: VendorPriceByFamilyRow; priciest: VendorPriceByFamilyRow; ratio: number } | null = null
  for (const list of byFamily.values()) {
    const sorted = [...list].sort((a, b) => a.median_rate! - b.median_rate!)
    const cheapest = sorted[0]!
    const priciest = sorted[sorted.length - 1]!
    if (cheapest.median_rate! <= 0) continue
    const ratio = priciest.median_rate! / cheapest.median_rate!
    if (!best || ratio > best.ratio) best = { row: list[0]!, cheapest, priciest, ratio }
  }
  return best
}

/** "Across N families with 2+ vendors priced, {family}'s costliest vendor
 *  charges {ratio}× its cheapest." (§6 fix #3) */
export function vendorPriceRankingSentence(rows: VendorPriceByFamilyRow[]): string {
  if (rows.length === 0) {
    return 'No comparable purchase yet carries an item family and vendor together — this fills in as more line items are verified against the item catalogue.'
  }
  const multiVendorCount = countMultiVendorFamilies(rows)
  const base = `${formatNumber(multiVendorCount)} item family/unit pair${
    multiVendorCount === 1 ? '' : 's'
  } ${multiVendorCount === 1 ? 'has' : 'have'} ${RATE_BENCHMARK_MIN_VENDORS}+ vendors priced.`
  const widest = widestVendorSpread(rows)
  if (!widest) return base
  return `${base} ${widest.row.family_label}'s widest gap: ${widest.priciest.vendor_display_name ?? 'a vendor'} charges ${widest.ratio.toFixed(
    1
  )}× what ${widest.cheapest.vendor_display_name ?? 'the cheapest vendor'} does.`
}

export function VendorPriceRankingSection({
  rows,
  error,
  compareBasis,
  previousMultiVendorCount,
}: {
  rows: VendorPriceByFamilyRow[]
  error: string | null
  compareBasis: CompareBasis
  previousMultiVendorCount: number | null
}) {
  const multiVendorCount = countMultiVendorFamilies(rows)
  const previous = compareBasis === 'prior_event' ? previousMultiVendorCount : null

  const dots: VendorPriceDot[] = rows
    .filter((r) => r.median_rate != null)
    .map((r) => ({
      familyKey: r.family_key,
      familyLabel: r.family_label,
      unit: r.unit_normalized,
      vendorId: r.vendor_id,
      vendorLabel: r.vendor_display_name ?? `#${r.vendor_id}`,
      vendorHref: `/entries?vendor_id=${r.vendor_id}`,
      medianRate: r.median_rate as number,
      minRate: r.min_rate,
      maxRate: r.max_rate,
      observationCount: r.observation_count,
      familyMedianRate: r.family_median_rate,
    }))

  const columns: DataTableColumn<VendorPriceByFamilyRow>[] = [
    { key: 'family', header: 'Item family', render: (r) => r.family_label },
    { key: 'unit', header: 'Unit', render: (r) => r.unit_normalized ?? '—' },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.vendor_display_name ?? `#${r.vendor_id}`}
        </Link>
      ),
    },
    { key: 'median', header: 'Median rate', align: 'right', render: (r) => formatINR(r.median_rate) },
    { key: 'min', header: 'Min', align: 'right', render: (r) => formatINR(r.min_rate) },
    { key: 'max', header: 'Max', align: 'right', render: (r) => formatINR(r.max_rate) },
    { key: 'obs', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observation_count) },
    {
      key: 'vendors',
      header: 'Vendors priced',
      align: 'right',
      render: (r) => (
        <span className={r.vendor_count < RATE_BENCHMARK_MIN_VENDORS ? 'text-muted-foreground' : undefined}>
          {formatNumber(r.vendor_count)}
        </span>
      ),
    },
  ]

  return (
    <ReportSection
      id="vendor-price-ranking"
      title="Price ranking per item family"
      description={`For each item bought repeatedly: who charges what, ranked. Greyed vendor-priced counts have fewer than ${RATE_BENCHMARK_MIN_VENDORS} vendors — not yet a real ranking, shown for visibility only.`}
      action={
        <ExportCsvButton
          filename="vendor-price-ranking.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Item family', value: (r) => r.family_label },
            { header: 'Unit', value: (r) => r.unit_normalized },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Median rate', value: (r) => r.median_rate },
            { header: 'Min rate', value: (r) => r.min_rate },
            { header: 'Max rate', value: (r) => r.max_rate },
            { header: 'Observations', value: (r) => r.observation_count },
            { header: 'Vendors priced', value: (r) => r.vendor_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load price ranking" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No vendor pricing yet"
          description="This needs a comparable line item carrying both an item family and a vendor. It fills in as more documents are verified against the item catalogue."
        />
      ) : (
        <>
          <KpiTile
            label={`Families with ${RATE_BENCHMARK_MIN_VENDORS}+ vendors priced`}
            value={formatNumber(multiVendorCount)}
            delta={formatDeltaVs(compareBasis, multiVendorCount, previous, 'count')}
            deltaTone={deltaToneHigherIsGood(multiVendorCount, previous)}
          />
          <p className="text-sm text-muted-foreground">{vendorPriceRankingSentence(rows)}</p>
          <VendorPriceRankingChart dots={dots} />
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => `${r.item_family_id}-${r.unit_normalized ?? 'none'}-${r.vendor_id}`}
          />
        </>
      )}
    </ReportSection>
  )
}
