import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { formatDeltaVs, type SpendByFamilyRow } from '@/lib/reports/sections/shared'

// Spend by item family (blueprint D-01). Ported verbatim from the former
// app/(app)/reports/page.tsx section of the same id.

/** Largest item-family sentence (§6 fix #3). */
export function familySpendSentence(rows: SpendByFamilyRow[], total: number): string {
  const withSpend = rows.filter((r) => r.total_spend > 0)
  if (withSpend.length === 0 || total <= 0) return 'No item-family spend recorded yet.'
  const top = withSpend[0]! // already ordered by total_spend desc (v_spend_by_family query)
  const share = (top.total_spend / total) * 100
  return `${top.label} is the largest item family, at ${formatPercent(share)} of tracked family spend.`
}

export function SpendByFamilySection({
  rows,
  error,
  compareBasis,
  previousSpendTotal,
}: {
  rows: SpendByFamilyRow[]
  error: string | null
  compareBasis: CompareBasis
  previousSpendTotal: number | null
}) {
  const barItems: BarListItem[] = rows
    .filter((r) => r.total_spend > 0)
    .slice(0, 12)
    .map((r) => ({ key: r.item_family_id, label: r.label, value: r.total_spend }))

  const columns: DataTableColumn<SpendByFamilyRow>[] = [
    {
      key: 'family',
      header: 'Item Family',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          {r.label}
          {!r.is_confirmed && (
            <span className="rounded border border-border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              Proposed
            </span>
          )}
        </span>
      ),
    },
    { key: 'unit', header: 'Unit', render: (r) => r.default_unit ?? '—' },
    { key: 'spend', header: 'Total Spend', align: 'right', render: (r) => formatINR(r.total_spend) },
    { key: 'observations', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observation_count) },
    { key: 'vendors', header: 'Vendors', align: 'right', render: (r) => formatNumber(r.vendor_count) },
  ]

  const spendTotal = rows.reduce((s, r) => s + r.total_spend, 0)
  const previous = compareBasis === 'prior_event' ? previousSpendTotal : null

  return (
    <ReportSection
      id="spend-by-family"
      title="Spend by item family"
      description="Cross-vendor comparable item groupings (e.g. 'gypsum ceiling', 'pvc boring pipe') — the level rates are actually comparable at, per the two-level item catalog (family → exact spec)."
      action={
        <ExportCsvButton
          filename="spend-by-family.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Item Family', value: (r) => r.label },
            { header: 'Unit', value: (r) => r.default_unit },
            { header: 'Total Spend', value: (r) => r.total_spend },
            { header: 'Observations', value: (r) => r.observation_count },
            { header: 'Vendors', value: (r) => r.vendor_count },
            { header: 'Confirmed', value: (r) => (r.is_confirmed ? 'yes' : 'no') },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load spend by family" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No item families yet"
          description="The catalog is back-filled from verified line items as documents are reviewed — see /catalog to confirm proposed families."
        />
      ) : (
        <>
          <KpiTile
            label="Total family spend"
            value={formatINRCompact(spendTotal)}
            delta={formatDeltaVs(compareBasis, spendTotal, previous, 'inr')}
            deltaTone="neutral"
          />
          <BarList items={barItems} valueFormatter={formatINRCompact} />
          <p className="text-sm text-muted-foreground">{familySpendSentence(rows, spendTotal)}</p>
          <DataTable columns={columns} rows={rows} getRowKey={(r) => r.item_family_id} />
        </>
      )}
    </ReportSection>
  )
}
