import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { DonutChart, type DonutSegment } from '@/components/reports/charts/donut-chart'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ORDINAL_RAMP } from '@/components/reports/charts/ordinal-ramp'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { BudgetCategoryMixRow } from '@/lib/reports/surfaces/budget-structure'

// reporting-blueprint.md §8 Phase Six A-07 -- "Where money goes structurally,
// expressed as SHARE rather than total." Backed by v_budget_category_mix
// (20260903000013): one row per (cost_center, event). "Budget category" ==
// the cost_center table.
//
// §6 fix #4: every category figure links to its filtered entries via
// `/entries?cc=` (the param the entries explorer actually reads).

const MAX_DONUT_SEGMENTS = 6

type Ranked = {
  key: string
  costCenterId: number | null
  label: string
  isConfirmed: boolean | null
  entryCount: number
  totalAmount: number
  sharePct: number
}

function rank(rows: BudgetCategoryMixRow[]): { ranked: Ranked[]; total: number } {
  const total = rows.reduce((sum, r) => sum + r.total_amount, 0)
  const ranked = [...rows]
    .filter((r) => r.total_amount > 0)
    .sort((a, b) => b.total_amount - a.total_amount)
    .map((r) => ({
      key: r.cost_center_id != null ? `c${r.cost_center_id}` : 'cnone',
      costCenterId: r.cost_center_id,
      label: r.cost_center_name,
      isConfirmed: r.cost_center_is_confirmed,
      entryCount: r.entry_count,
      totalAmount: r.total_amount,
      sharePct: total > 0 ? (r.total_amount / total) * 100 : 0,
    }))
  return { ranked, total }
}

/** §6 fix #3 -- one computed sentence on the structural mix. */
export function budgetCategoryMixSentence(rows: BudgetCategoryMixRow[]): string {
  const { ranked, total } = rank(rows)
  if (ranked.length === 0 || total <= 0) return 'No categorised spend recorded yet this event.'
  const top = ranked[0]!
  const topThree = ranked.slice(0, 3).reduce((sum, r) => sum + r.sharePct, 0)
  const threePart =
    ranked.length >= 3 ? ` The top three together are ${formatPercent(topThree)} of spend.` : ''
  return `${top.label} is the largest budget category at ${formatPercent(top.sharePct)} of ${formatINRCompact(
    total
  )} across ${formatNumber(ranked.length)} categories.${threePart}`
}

export function BudgetCategoryMixSection({
  rows,
  error,
}: {
  rows: BudgetCategoryMixRow[]
  error: string | null
}) {
  const { ranked, total } = rank(rows)

  const donutSegments: DonutSegment[] = []
  ranked.slice(0, MAX_DONUT_SEGMENTS).forEach((r, i) => {
    donutSegments.push({
      key: r.key,
      label: r.label,
      value: r.totalAmount,
      colorClass: ORDINAL_RAMP[i % ORDINAL_RAMP.length]!.strokeClass,
    })
  })
  const rest = ranked.slice(MAX_DONUT_SEGMENTS)
  if (rest.length > 0) {
    donutSegments.push({
      key: 'other',
      label: `Other (${formatNumber(rest.length)} categories)`,
      value: rest.reduce((sum, r) => sum + r.totalAmount, 0),
      colorClass: 'stroke-muted-foreground',
    })
  }

  const barItems: BarListItem[] = ranked.map((r) => ({
    key: r.key,
    label: r.label,
    value: r.totalAmount,
    note: formatPercent(r.sharePct),
    href: r.costCenterId != null ? `/entries?cc=${r.costCenterId}` : undefined,
  }))

  const columns: DataTableColumn<Ranked>[] = [
    { key: 'category', header: 'Budget category', render: (r) => r.label },
    {
      key: 'confirmed',
      header: 'Confirmed',
      render: (r) => (r.isConfirmed == null ? '—' : r.isConfirmed ? 'Yes' : 'No'),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entryCount) },
    { key: 'amount', header: 'Spend', align: 'right', render: (r) => formatINR(r.totalAmount) },
    { key: 'share', header: 'Share', align: 'right', render: (r) => formatPercent(r.sharePct) },
  ]

  const csv = toCsv(ranked, [
    { header: 'Budget Category', value: (r) => r.label },
    { header: 'Confirmed', value: (r) => (r.isConfirmed == null ? '' : String(r.isConfirmed)) },
    { header: 'Entries', value: (r) => r.entryCount },
    { header: 'Spend', value: (r) => r.totalAmount },
    { header: 'Share %', value: (r) => r.sharePct },
  ])

  const top = ranked[0] ?? null

  return (
    <ReportSection
      id="budget-category-mix"
      title="Budget category mix"
      description="Where the money goes structurally — each budget category as a share of total spend, not a raw figure."
      action={<ExportCsvButton filename="budget-category-mix.csv" rowCount={ranked.length} csv={csv} />}
    >
      {error ? (
        <EmptyState title="Couldn't load the budget category mix" description={error} />
      ) : ranked.length === 0 || total <= 0 ? (
        <EmptyState
          title="No categorised spend yet"
          description="Spend is grouped by budget category once entries are enriched with a cost centre."
        />
      ) : (
        <>
          {top && (
            <KpiTile
              label={`Top category — ${top.label}`}
              value={formatPercent(top.sharePct)}
              delta={`${formatINRCompact(top.totalAmount)} of ${formatINRCompact(total)}`}
              deltaTone="neutral"
            />
          )}
          <DonutChart segments={donutSegments} centerLabel={formatINRCompact(total)} />
          <BarList items={barItems} valueFormatter={formatINRCompact} />
          <p className="text-sm text-muted-foreground">{budgetCategoryMixSentence(rows)}</p>
          <DataTable columns={columns} rows={ranked} getRowKey={(r) => r.key} />
        </>
      )}
    </ReportSection>
  )
}
