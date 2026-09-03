import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { formatDeltaVs, type ZoneSpendRow } from '@/lib/reports/sections/shared'

// Spend by zone (blueprint A-05). Ported verbatim from the former
// app/(app)/reports/page.tsx section of the same id.

export function zoneSpendSentence(rows: ZoneSpendRow[], total: number): string {
  const withSpend = rows.filter((r) => (r.total_amount ?? 0) > 0)
  if (withSpend.length === 0 || total <= 0) return 'No zone spend recorded yet.'
  const top = [...withSpend].sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))[0]!
  const share = ((top.total_amount ?? 0) / total) * 100
  return `${top.zone_name} is the highest-spend zone, at ${formatPercent(share)} of total zone spend across ${withSpend.length} zones.`
}

export function ZoneSpendSection({
  rows,
  error,
  compareBasis,
  previousTotal,
}: {
  rows: ZoneSpendRow[]
  error: string | null
  compareBasis: CompareBasis
  previousTotal: number | null
}) {
  const barItems: BarListItem[] = rows
    .filter((r) => (r.total_amount ?? 0) > 0)
    .map((r) => ({
      key: r.zone_id ?? 'unassigned',
      label: r.zone_name,
      value: r.total_amount ?? 0,
    }))

  const columns: DataTableColumn<ZoneSpendRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => (
        <Link
          href={r.zone_id ? `/entries?zone_id=${r.zone_id}` : '/entries?zone_id=none'}
          className="text-primary underline-offset-2 hover:underline"
        >
          {r.zone_name}
        </Link>
      ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'total', header: 'Total Amount', align: 'right', render: (r) => formatINR(r.total_amount) },
  ]

  const spendTotal = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  const previous = compareBasis === 'prior_event' ? previousTotal : null

  return (
    <ReportSection
      id="zone-spend"
      title="Spend by zone"
      description="Null zone is reported as 'unassigned' so gaps in enrichment stay visible."
      action={
        <ExportCsvButton
          filename="zone-spend.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Zone', value: (r) => r.zone_name },
            { header: 'Entries', value: (r) => r.entry_count },
            { header: 'Total Amount', value: (r) => r.total_amount },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load zone spend" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No zone spend yet" />
      ) : (
        <>
          <KpiTile
            label="Total zone spend"
            value={formatINRCompact(spendTotal)}
            delta={formatDeltaVs(compareBasis, spendTotal, previous, 'inr')}
            deltaTone="neutral"
          />
          <BarList items={barItems} valueFormatter={formatINRCompact} />
          <p className="text-sm text-muted-foreground">{zoneSpendSentence(rows, spendTotal)}</p>
          <DataTable columns={columns} rows={rows} getRowKey={(r) => r.zone_id ?? 'unassigned'} />
        </>
      )}
    </ReportSection>
  )
}
