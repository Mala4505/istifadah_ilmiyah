import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { DonutChart } from '@/components/reports/charts/lazy'
import { shareSegments } from '@/components/reports/charts/share-segments'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { BudgetCategoryMixRow } from '@/lib/reports/surfaces/budget-structure'

// reporting-blueprint.md §8 Phase Six A-07 -- "Where money goes structurally,
// expressed as SHARE rather than total." Backed by v_budget_category_mix:
// one row per (budget category, event). "Budget category" is derived from
// the budget head's short_label with spelling variants merged; entries with no
// budget head fall in key null / 'No budget head'.
//
// No drill link: a derived category spans several budget heads and the entries
// explorer has no filter for it.

type Ranked = {
  key: string
  label: string
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
      key: r.budget_category_key ?? '__none__',
      label: r.budget_category_label,
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
  insight,
}: {
  rows: BudgetCategoryMixRow[]
  error: string | null
  insight?: string | null
}) {
  const { ranked, total } = rank(rows)

  // Categorical hues (budget categories are unordered identities, not ordinal
  // stages) — at most 6 slices, the tail folded into a neutral "Other".
  // Phase 6 dedup: the BarList that repeated these exact numbers is gone; the
  // donut answers "share", the table below carries every exact figure.
  const donutSegments = shareSegments(ranked.map((r) => ({ key: r.key, label: r.label, value: r.totalAmount })), {
    otherNoun: 'categories',
  })

  const columns: DataTableColumn<Ranked>[] = [
    { key: 'category', header: 'Budget category', render: (r) => r.label },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entryCount) },
    { key: 'amount', header: 'Spend', align: 'right', render: (r) => formatINR(r.totalAmount) },
    { key: 'share', header: 'Share', align: 'right', render: (r) => formatPercent(r.sharePct) },
  ]

  const csv = toCsv(ranked, [
    { header: 'Budget Category', value: (r) => r.label },
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
          description="Spend is grouped by budget category once entries are linked to a budget head."
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
          <DonutChart segments={donutSegments} centerLabel={formatINRCompact(total)} valueFormat="inr-compact" />
          <p className="text-sm text-muted-foreground">{insight ?? budgetCategoryMixSentence(rows)}</p>
          <DataTable columns={columns} rows={ranked} getRowKey={(r) => r.key} />
        </>
      )}
    </ReportSection>
  )
}
