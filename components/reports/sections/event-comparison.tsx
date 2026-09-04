import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { EventComparisonRow } from '@/lib/reports/surfaces/event-comparison'

// reporting-blueprint.md A-12 -- Event-over-event comparison. "Same department,
// same category, 1448 vs 1449, indexed to a common base." The schema is
// already event-scoped, so this is pure arrangement of existing spend — it
// only waits on a second event's data. Until then the section is an
// EmptyState; the moment a second event exists it becomes an indexed
// department comparison.

const MAX_BARS = 12
const indexFormatter = (v: number) => formatNumber(Math.round(v))

/** "Across N departments active in both 1448 and 1449, spend rose 8% overall
 *  (index 108) — led by Catering at index 141." (§6 fix #3) */
export function eventComparisonSentence(
  rows: EventComparisonRow[],
  baseName: string,
  currentName: string,
  baseTotal: number,
  currentTotal: number
): string {
  const bothActive = rows.filter((r) => r.baseAmount > 0 && r.currentAmount > 0)
  if (bothActive.length === 0) {
    return `No department has spend in both ${baseName} and ${currentName} yet.`
  }
  const overallIndex = baseTotal > 0 ? Math.round((currentTotal / baseTotal) * 100) : null
  const pct = baseTotal > 0 ? ((currentTotal - baseTotal) / baseTotal) * 100 : null
  const direction = pct == null ? 'changed' : pct > 0.5 ? 'rose' : pct < -0.5 ? 'fell' : 'held roughly flat'
  const magnitude = pct == null ? '' : ` ${formatPercent(Math.abs(pct))}`
  const indexBit = overallIndex == null ? '' : ` (index ${overallIndex})`
  const lead = [...bothActive].sort((a, b) => (b.indexed ?? 0) - (a.indexed ?? 0))[0]!
  const leadBit =
    lead.indexed != null
      ? ` — led by ${lead.department_name ?? `#${lead.department_id}`} at index ${Math.round(lead.indexed)}.`
      : '.'
  return `Across ${formatNumber(bothActive.length)} department${
    bothActive.length === 1 ? '' : 's'
  } active in both ${baseName} and ${currentName}, spend ${direction}${magnitude} overall${indexBit}${leadBit}`
}

export function EventComparisonSection({
  hasComparison,
  currentEventName,
  baseEventName,
  rows,
  error,
  currentTotal,
  baseTotal,
}: {
  hasComparison: boolean
  currentEventName: string | null
  baseEventName: string | null
  rows: EventComparisonRow[]
  error: string | null
  currentTotal: number
  baseTotal: number
}) {
  if (!hasComparison) {
    return (
      <ReportSection
        id="event-comparison"
        title="Event-over-event comparison"
        description="Each department's spend this event against the last, indexed to a common base."
      >
        <EmptyState
          title="Waiting on a second event"
          description="Year-on-year comparison unlocks once a second event's data is imported — the schema is already event-scoped and ready."
        />
      </ReportSection>
    )
  }

  const base = baseEventName ?? 'prior event'
  const current = currentEventName ?? 'this event'

  const barItems: BarListItem[] = rows
    .filter((r) => r.indexed != null)
    .slice(0, MAX_BARS)
    .map((r) => ({
      key: r.department_id ?? 'none',
      label: r.department_name ?? 'Unassigned',
      value: r.indexed as number,
      marker: 100,
      markerLabel: `${base} = 100`,
      href: r.department_id != null ? `/entries?dept=${r.department_id}` : undefined,
      note: `${formatINRCompact(r.baseAmount)} → ${formatINRCompact(r.currentAmount)}`,
    }))

  const newDepartments = rows.filter((r) => r.baseAmount === 0 && r.currentAmount > 0).length

  const columns: DataTableColumn<EventComparisonRow>[] = [
    {
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.department_id != null ? (
          <Link href={`/entries?dept=${r.department_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.department_name ?? `#${r.department_id}`}
          </Link>
        ) : (
          r.department_name ?? 'Unassigned'
        ),
    },
    { key: 'base', header: `${base} ₹`, align: 'right', render: (r) => formatINR(r.baseAmount) },
    { key: 'current', header: `${current} ₹`, align: 'right', render: (r) => formatINR(r.currentAmount) },
    {
      key: 'abs',
      header: 'Change ₹',
      align: 'right',
      render: (r) => `${r.absChange > 0 ? '+' : r.absChange < 0 ? '−' : '±'}${formatINRCompact(Math.abs(r.absChange))}`,
    },
    {
      key: 'pct',
      header: 'Change %',
      align: 'right',
      render: (r) =>
        r.pctChange == null
          ? 'new'
          : `${r.pctChange > 0 ? '+' : r.pctChange < 0 ? '−' : '±'}${formatPercent(Math.abs(r.pctChange))}`,
    },
    {
      key: 'index',
      header: `Index (${base} = 100)`,
      align: 'right',
      render: (r) => (r.indexed == null ? '—' : formatNumber(Math.round(r.indexed))),
    },
  ]

  const overallIndex = baseTotal > 0 ? Math.round((currentTotal / baseTotal) * 100) : null

  return (
    <ReportSection
      id="event-comparison"
      title="Event-over-event comparison"
      description={`Each department's spend in ${current} against ${base}, indexed so ${base} = 100. An index above 100 means spend grew.`}
      action={
        <ExportCsvButton
          filename="event-comparison.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Department', value: (r) => r.department_name },
            { header: `${base} amount`, value: (r) => r.baseAmount },
            { header: `${current} amount`, value: (r) => r.currentAmount },
            { header: 'Absolute change', value: (r) => r.absChange },
            { header: 'Percent change', value: (r) => r.pctChange },
            { header: 'Index', value: (r) => r.indexed },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the comparison" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No department spend in either event"
          description="Both events exist, but no department has recorded spend in either one yet."
        />
      ) : (
        <>
          <KpiTile
            label={`Overall index (${base} = 100)`}
            value={overallIndex == null ? '—' : formatNumber(overallIndex)}
            delta={`${formatINRCompact(baseTotal)} → ${formatINRCompact(currentTotal)}`}
            deltaTone={overallIndex == null ? 'neutral' : overallIndex > 100 ? 'bad' : 'good'}
          />
          <p className="text-sm text-muted-foreground">
            {eventComparisonSentence(rows, base, current, baseTotal, currentTotal)}
            {newDepartments > 0
              ? ` ${formatNumber(newDepartments)} department${newDepartments === 1 ? '' : 's'} new in ${current} (no ${base} base to index).`
              : ''}
          </p>
          {barItems.length > 0 && <BarList items={barItems} valueFormatter={indexFormatter} />}
          <DataTable columns={columns} rows={rows} getRowKey={(r) => r.department_id ?? 'none'} />
        </>
      )}
    </ReportSection>
  )
}
