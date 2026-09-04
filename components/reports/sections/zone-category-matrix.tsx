import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import {
  ZoneCategoryMatrixChart,
  type MatrixAxisItem,
  type MatrixCell,
} from '@/components/reports/charts/zone-category-matrix-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { ZoneCategoryMatrixRow } from '@/lib/reports/surfaces/budget-structure'

// reporting-blueprint.md §8 Phase Six A-06 -- "What each site spends on.
// Reveals sites whose mix is unlike every comparable site." Backed by
// v_zone_category_matrix (20260903000013): one row per (zone, cost_center,
// event). "Budget category" == the cost_center table.
//
// The chart caps to the top MAX_CHART_CATEGORIES categories by total spend for
// legibility; the full matrix stays in the table twin and the CSV.
//
// §6 fix #4: zone and category figures link to their filtered entries via the
// params the entries explorer actually reads -- `/entries?zone=` and
// `/entries?cc=` (NOT `zone_id` / `cost_center_id`).

const MAX_CHART_CATEGORIES = 14

type ZoneAgg = { key: string; label: string; total: number; topCategory: string | null; topCategoryAmount: number }

function zoneKey(r: ZoneCategoryMatrixRow): string {
  return r.zone_id != null ? `z${r.zone_id}` : 'znone'
}
function categoryKey(r: ZoneCategoryMatrixRow): string {
  return r.cost_center_id != null ? `c${r.cost_center_id}` : 'cnone'
}

function mostConcentratedZone(rows: ZoneCategoryMatrixRow[]): ZoneAgg | null {
  const byZone = new Map<string, ZoneAgg>()
  for (const r of rows) {
    const key = zoneKey(r)
    const agg =
      byZone.get(key) ?? { key, label: r.zone_name, total: 0, topCategory: null, topCategoryAmount: -1 }
    agg.total += r.total_amount
    if (r.total_amount > agg.topCategoryAmount) {
      agg.topCategoryAmount = r.total_amount
      agg.topCategory = r.cost_center_name
    }
    byZone.set(key, agg)
  }
  const ranked = [...byZone.values()]
    .filter((z) => z.total > 0)
    .sort((a, b) => b.topCategoryAmount / b.total - a.topCategoryAmount / a.total)
  return ranked[0] ?? null
}

/** §6 fix #3 -- one computed sentence naming the most concentrated site. */
export function zoneCategoryMatrixSentence(rows: ZoneCategoryMatrixRow[]): string {
  if (rows.length === 0) return 'No zone spend recorded yet this event.'
  const top = mostConcentratedZone(rows)
  if (!top || top.topCategory == null) return 'No zone has any categorised spend yet this event.'
  const share = (top.topCategoryAmount / top.total) * 100
  return `${top.label} has the most concentrated mix — ${formatPercent(share)} of its ${formatINRCompact(
    top.total
  )} goes to ${top.topCategory}.`
}

export function ZoneCategoryMatrixSection({
  rows,
  error,
}: {
  rows: ZoneCategoryMatrixRow[]
  error: string | null
}) {
  // Axis ordering: both axes by total spend descending, so the densest corner
  // sits top-left.
  const zoneTotals = new Map<string, { label: string; total: number }>()
  const categoryTotals = new Map<string, { label: string; total: number }>()
  for (const r of rows) {
    const zk = zoneKey(r)
    const ck = categoryKey(r)
    zoneTotals.set(zk, { label: r.zone_name, total: (zoneTotals.get(zk)?.total ?? 0) + r.total_amount })
    categoryTotals.set(ck, {
      label: r.cost_center_name,
      total: (categoryTotals.get(ck)?.total ?? 0) + r.total_amount,
    })
  }

  const zoneAxisAll = [...zoneTotals.entries()].sort((a, b) => b[1].total - a[1].total)
  const categoryAxisAll = [...categoryTotals.entries()].sort((a, b) => b[1].total - a[1].total)

  const chartZones: MatrixAxisItem[] = zoneAxisAll.map(([, v]) => ({ key: v.label, label: v.label }))
  const chartCategories: MatrixAxisItem[] = categoryAxisAll
    .slice(0, MAX_CHART_CATEGORIES)
    .map(([, v]) => ({ key: v.label, label: v.label }))
  const shownCategoryLabels = new Set(chartCategories.map((c) => c.key))

  const chartCells: MatrixCell[] = rows
    .filter((r) => shownCategoryLabels.has(r.cost_center_name) && r.total_amount > 0)
    .map((r) => ({
      rowKey: r.zone_name,
      colKey: r.cost_center_name,
      amount: r.total_amount,
      entryCount: r.entry_count,
    }))

  const top = mostConcentratedZone(rows)

  const tableRows = [...rows].filter((r) => r.total_amount > 0).sort((a, b) => b.total_amount - a.total_amount)

  const columns: DataTableColumn<ZoneCategoryMatrixRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => (
        <Link
          href={r.zone_id != null ? `/entries?zone=${r.zone_id}` : '/entries'}
          className="text-primary underline-offset-2 hover:underline"
        >
          {r.zone_name}
        </Link>
      ),
    },
    {
      key: 'category',
      header: 'Budget category',
      render: (r) =>
        r.cost_center_id != null ? (
          <Link href={`/entries?cc=${r.cost_center_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.cost_center_name}
          </Link>
        ) : (
          <span className="text-muted-foreground">{r.cost_center_name}</span>
        ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'amount', header: 'Spend', align: 'right', render: (r) => formatINR(r.total_amount) },
  ]

  const csv = toCsv(rows, [
    { header: 'Zone', value: (r) => r.zone_name },
    { header: 'Zone Number', value: (r) => r.zone_number },
    { header: 'Budget Category', value: (r) => r.cost_center_name },
    { header: 'Entries', value: (r) => r.entry_count },
    { header: 'Spend', value: (r) => r.total_amount },
  ])

  return (
    <ReportSection
      id="zone-category-matrix"
      title="Zone × category matrix"
      description="Each site's spend broken down by budget category, shaded by rupees. A row whose colour pattern is unlike every other row is a site spending on an unusual mix."
      action={<ExportCsvButton filename="zone-category-matrix.csv" rowCount={rows.length} csv={csv} />}
    >
      {error ? (
        <EmptyState title="Couldn't load the zone × category matrix" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No zone spend yet" description="The matrix fills in as entries are enriched with a zone and a budget category." />
      ) : (
        <>
          {top && top.topCategory != null && (
            <KpiTile
              label="Most concentrated site"
              value={top.label}
              delta={`${formatPercent((top.topCategoryAmount / top.total) * 100)} in ${top.topCategory}`}
              deltaTone="neutral"
            />
          )}
          <ZoneCategoryMatrixChart rows={chartZones} columns={chartCategories} cells={chartCells} />
          {categoryAxisAll.length > MAX_CHART_CATEGORIES && (
            <p className="text-xs text-muted-foreground">
              Chart shows the {MAX_CHART_CATEGORIES} largest categories of {formatNumber(categoryAxisAll.length)} — the
              full matrix is in the table and CSV.
            </p>
          )}
          <p className="text-sm text-muted-foreground">{zoneCategoryMatrixSentence(rows)}</p>
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => `${zoneKey(r)}-${categoryKey(r)}`}
          />
        </>
      )}
    </ReportSection>
  )
}
