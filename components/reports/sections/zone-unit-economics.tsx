import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import {
  ZoneEconomicsMatrixChart,
  type ZoneEconomicsAxisItem,
  type ZoneEconomicsCell,
} from '@/components/reports/charts/zone-economics-matrix-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatNumber } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import { countWideSpreadFamilies, ZONE_SPREAD_HEADLINE_PCT, type ZoneUnitEconomicsRow } from '@/lib/reports/surfaces/quantity-zone-price'

// reporting-blueprint.md C-08 — unit economics by zone. "Rate paid for the
// same item at different sites. Two zones buying the same ceiling at
// different rates is a finding no total will ever show." The view itself
// only carries families billed in 2+ zones (see the migration header), so
// every row here is already a real cross-zone comparison.

function rowKeyOf(r: ZoneUnitEconomicsRow): string {
  return `${r.item_family_id}::${r.unit_normalized ?? ''}`
}
function rowLabelOf(r: ZoneUnitEconomicsRow): string {
  return r.unit_normalized ? `${r.family_label} · ${r.unit_normalized}` : r.family_label
}
function colKeyOf(r: ZoneUnitEconomicsRow): string {
  return String(r.zone_id)
}
function colLabelOf(r: ZoneUnitEconomicsRow): string {
  return r.zone_number != null ? `Z${r.zone_number} ${r.zone_name}` : r.zone_name
}

/** Widest cross-zone spread, as a ratio of the family's own median. */
function widestSpread(
  rows: ZoneUnitEconomicsRow[]
): { row: ZoneUnitEconomicsRow; cheapest: ZoneUnitEconomicsRow; priciest: ZoneUnitEconomicsRow; spreadPct: number } | null {
  const byGroup = new Map<string, ZoneUnitEconomicsRow[]>()
  for (const r of rows) {
    if (r.median_rate == null) continue
    const key = rowKeyOf(r)
    const list = byGroup.get(key) ?? []
    list.push(r)
    byGroup.set(key, list)
  }
  let best: { row: ZoneUnitEconomicsRow; cheapest: ZoneUnitEconomicsRow; priciest: ZoneUnitEconomicsRow; spreadPct: number } | null = null
  for (const list of byGroup.values()) {
    const familyMedian = list[0]!.family_median_rate
    if (familyMedian == null || familyMedian <= 0) continue
    const sorted = [...list].sort((a, b) => a.median_rate! - b.median_rate!)
    const cheapest = sorted[0]!
    const priciest = sorted[sorted.length - 1]!
    const spreadPct = ((priciest.median_rate! - cheapest.median_rate!) / familyMedian) * 100
    if (!best || spreadPct > best.spreadPct) best = { row: list[0]!, cheapest, priciest, spreadPct }
  }
  return best
}

/** "Across N item families billed in 2+ zones, {family} shows the widest
 *  spread — {zone A} pays {rate} against {zone B}'s {rate}." (§6 fix #3) */
export function zoneUnitEconomicsSentence(rows: ZoneUnitEconomicsRow[]): string {
  if (rows.length === 0) {
    return 'No item family has been billed in two or more zones yet — this needs the same item family purchased at two different sites before a cross-zone rate comparison exists.'
  }
  const familyCount = new Set(rows.map(rowKeyOf)).size
  const base = `Across ${formatNumber(familyCount)} item family/unit pair${
    familyCount === 1 ? '' : 's'
  } billed in 2 or more zones`
  const widest = widestSpread(rows)
  if (!widest) return `${base}, no reliable family median is available yet to compare against.`
  return `${base}, ${widest.row.family_label} shows the widest spread — ${colLabelOf(widest.priciest)} pays ${formatINR(
    widest.priciest.median_rate
  )} against ${colLabelOf(widest.cheapest)}'s ${formatINR(widest.cheapest.median_rate)}.`
}

export function ZoneUnitEconomicsSection({
  rows,
  error,
  compareBasis,
  previousWideSpreadCount,
}: {
  rows: ZoneUnitEconomicsRow[]
  error: string | null
  compareBasis: CompareBasis
  previousWideSpreadCount: number | null
}) {
  const wideSpreadCount = countWideSpreadFamilies(rows)
  const previous = compareBasis === 'prior_event' ? previousWideSpreadCount : null

  const rowItems = new Map<string, ZoneEconomicsAxisItem>()
  const colItems = new Map<string, ZoneEconomicsAxisItem>()
  const cells: ZoneEconomicsCell[] = []
  for (const r of rows) {
    if (r.median_rate == null) continue
    const rk = rowKeyOf(r)
    const ck = colKeyOf(r)
    if (!rowItems.has(rk)) rowItems.set(rk, { key: rk, label: rowLabelOf(r) })
    if (!colItems.has(ck)) colItems.set(ck, { key: ck, label: colLabelOf(r) })
    cells.push({
      rowKey: rk,
      colKey: ck,
      medianRate: r.median_rate,
      familyMedianRate: r.family_median_rate ?? r.median_rate,
      observationCount: r.observation_count,
    })
  }
  const matrixRows = [...rowItems.values()].sort((a, b) => a.label.localeCompare(b.label))
  const matrixCols = [...colItems.values()].sort((a, b) => a.label.localeCompare(b.label))

  const columns: DataTableColumn<ZoneUnitEconomicsRow>[] = [
    { key: 'family', header: 'Item family', render: (r) => r.family_label },
    { key: 'unit', header: 'Unit', render: (r) => r.unit_normalized ?? '—' },
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => (
        <Link href={`/entries?zone_id=${r.zone_id}`} className="text-primary underline-offset-2 hover:underline">
          {colLabelOf(r)}
        </Link>
      ),
    },
    { key: 'median', header: 'Median rate', align: 'right', render: (r) => formatINR(r.median_rate) },
    { key: 'avg', header: 'Avg rate', align: 'right', render: (r) => formatINR(r.avg_rate) },
    { key: 'familyMedian', header: 'Family median (all zones)', align: 'right', render: (r) => formatINR(r.family_median_rate) },
    { key: 'zones', header: 'Zones billing this item', align: 'right', render: (r) => formatNumber(r.zone_count) },
    { key: 'obs', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observation_count) },
  ]

  return (
    <ReportSection
      id="zone-unit-economics"
      title="Unit economics by zone"
      description="The rate paid for the same item family at different sites. Only families billed in two or more zones appear here — each cell shaded darker the more it paid above that family's own median rate across every zone."
      action={
        <ExportCsvButton
          filename="zone-unit-economics.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Item family', value: (r) => r.family_label },
            { header: 'Unit', value: (r) => r.unit_normalized },
            { header: 'Zone', value: (r) => colLabelOf(r) },
            { header: 'Median rate', value: (r) => r.median_rate },
            { header: 'Avg rate', value: (r) => r.avg_rate },
            { header: 'Family median (all zones)', value: (r) => r.family_median_rate },
            { header: 'Zones billing this item', value: (r) => r.zone_count },
            { header: 'Observations', value: (r) => r.observation_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load unit economics by zone" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No cross-zone comparison yet"
          description="This needs the same item family billed in two or more zones, each with a comparable rate. It fills in as more entries are matched to a zone and more line items are verified."
        />
      ) : (
        <>
          <KpiTile
            label={`Families with a >${ZONE_SPREAD_HEADLINE_PCT}% cross-zone spread`}
            value={formatNumber(wideSpreadCount)}
            delta={formatDeltaVs(compareBasis, wideSpreadCount, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(wideSpreadCount, previous)}
          />
          <p className="text-sm text-muted-foreground">{zoneUnitEconomicsSentence(rows)}</p>
          <ZoneEconomicsMatrixChart rows={matrixRows} columns={matrixCols} cells={cells} />
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => `${r.item_family_id}-${r.unit_normalized ?? 'none'}-${r.zone_id}`}
          />
        </>
      )}
    </ReportSection>
  )
}
