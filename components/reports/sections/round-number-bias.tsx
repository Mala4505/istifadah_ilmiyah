import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  ROUND_NUMBER_MATERIALITY_MIN_ENTRIES,
  type RoundNumberBiasRow,
  type RoundNumberRollup,
} from '@/lib/reports/surfaces/amount-forensics'

// reporting-blueprint.md D-08 — round-number bias. "Share of amounts ending in
// 000, by department and vendor. A high share means estimates are being booked
// as invoices." Round = a positive whole multiple of ₹1,000. Headline = the
// overall share for the event; the two bar lists rank departments and vendors
// (each above a minimum-entry-count bar so a one-entry vendor isn't "100%").

const MAX_BARS = 8

/** "142 of 1,203 amounts this event (11.8%) are round thousands — led by
 *  Maintenance at 24.0% and ACME Traders at 31.0%." (§6 fix #3) */
export function roundNumberSentence(
  overallRoundCount: number,
  overallEntryCount: number,
  overallSharePct: number,
  byDepartment: RoundNumberRollup[],
  byVendor: RoundNumberRollup[]
): string {
  if (overallEntryCount === 0) return 'No entry amounts recorded yet this event.'
  const base = `${formatNumber(overallRoundCount)} of ${formatNumber(overallEntryCount)} amounts this event (${formatPercent(
    overallSharePct
  )}) are round thousands`
  const topDept = byDepartment[0]
  const topVendor = byVendor[0]
  if (!topDept && !topVendor) return `${base}.`
  const bits: string[] = []
  if (topDept) bits.push(`${topDept.label} at ${formatPercent(topDept.roundSharePct)}`)
  if (topVendor) bits.push(`${topVendor.label} at ${formatPercent(topVendor.roundSharePct)}`)
  return `${base} — led by ${bits.join(' and ')}.`
}

function rollupBars(rollups: RoundNumberRollup[], hrefKey: 'department_id' | 'vendor_id'): BarListItem[] {
  return rollups.slice(0, MAX_BARS).map((g) => ({
    key: g.key,
    label: g.label,
    value: g.roundSharePct,
    href: g.key === 'unassigned' ? undefined : `/entries?${hrefKey}=${g.key}`,
    note: `${formatNumber(g.roundCount)}/${formatNumber(g.entryCount)}`,
  }))
}

export function RoundNumberBiasSection({
  rows,
  error,
  byDepartment,
  byVendor,
  overallEntryCount,
  overallRoundCount,
  overallSharePct,
  compareBasis,
  previousOverallSharePct,
}: {
  rows: RoundNumberBiasRow[]
  error: string | null
  byDepartment: RoundNumberRollup[]
  byVendor: RoundNumberRollup[]
  overallEntryCount: number
  overallRoundCount: number
  overallSharePct: number
  compareBasis: CompareBasis
  previousOverallSharePct: number | null
}) {
  const previous = compareBasis === 'prior_event' ? previousOverallSharePct : null

  const tableRows = [...rows].sort(
    (a, b) => (b.round_share_pct ?? 0) - (a.round_share_pct ?? 0) || b.round_count - a.round_count
  )

  const columns: DataTableColumn<RoundNumberBiasRow>[] = [
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.department_id == null ? (
          'Unassigned'
        ) : (
          <Link
            href={`/entries?department_id=${r.department_id}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {r.department_name}
          </Link>
        ),
    },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendor_id == null ? (
          'Unassigned'
        ) : (
          <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.vendor_display_name}
          </Link>
        ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'round', header: 'Round (×₹1,000)', align: 'right', render: (r) => formatNumber(r.round_count) },
    { key: 'share', header: 'Round share', align: 'right', render: (r) => formatPercent(r.round_share_pct) },
  ]

  return (
    <ReportSection
      id="round-number-bias"
      title="Round-number bias"
      description={`Share of entry amounts that are an exact multiple of ₹1,000, by department and vendor. A high share means round estimates are being booked in place of real invoice totals. Departments and vendors need at least ${ROUND_NUMBER_MATERIALITY_MIN_ENTRIES} entries to be ranked.`}
      action={
        <ExportCsvButton
          filename="round-number-bias.csv"
          rowCount={rows.length}
          csv={toCsv(tableRows, [
            { header: 'Department', value: (r) => r.department_name ?? 'Unassigned' },
            { header: 'Vendor', value: (r) => r.vendor_display_name ?? 'Unassigned' },
            { header: 'Entries', value: (r) => r.entry_count },
            { header: 'Round entries', value: (r) => r.round_count },
            { header: 'Round share %', value: (r) => r.round_share_pct },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load round-number bias" description={error} />
      ) : rows.length === 0 || overallEntryCount === 0 ? (
        <EmptyState
          title="No entry amounts yet"
          description="This fills in once non-void entries with an amount exist for the selected event."
        />
      ) : (
        <>
          <KpiTile
            label="Round-number share (all amounts)"
            value={formatPercent(overallSharePct)}
            delta={formatDeltaVs(compareBasis, overallSharePct, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(overallSharePct, previous)}
          />
          <p className="text-sm text-muted-foreground">
            {roundNumberSentence(overallRoundCount, overallEntryCount, overallSharePct, byDepartment, byVendor)}
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Top departments by round share
              </p>
              {byDepartment.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No department has at least {ROUND_NUMBER_MATERIALITY_MIN_ENTRIES} entries this event.
                </p>
              ) : (
                <BarList items={rollupBars(byDepartment, 'department_id')} max={100} valueFormatter={formatPercent} />
              )}
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Top vendors by round share
              </p>
              {byVendor.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No vendor has at least {ROUND_NUMBER_MATERIALITY_MIN_ENTRIES} entries this event.
                </p>
              ) : (
                <BarList items={rollupBars(byVendor, 'vendor_id')} max={100} valueFormatter={formatPercent} />
              )}
            </div>
          </div>
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => `${r.department_id ?? 'na'}:${r.vendor_id ?? 'na'}`}
          />
        </>
      )}
    </ReportSection>
  )
}
