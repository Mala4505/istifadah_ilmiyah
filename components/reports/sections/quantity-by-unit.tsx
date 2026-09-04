import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { QuantityByUnitChart, type QuantityByUnitBar } from '@/components/reports/charts/quantity-by-unit-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatNumber } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsGood, formatDeltaVs } from '@/lib/reports/sections/shared'
import type { QuantityByUnitRow } from '@/lib/reports/surfaces/quantity-zone-price'

// reporting-blueprint.md C-07 — quantity purchased by unit. "Not rupees —
// sqft, nos, days. Consumption in physical terms, which is what an
// operations head actually plans against." One row per (item family, unit)
// tracked this event; the chart draws one mini bar-chart per unit since
// units aren't comparable to each other.

function toBar(r: QuantityByUnitRow): QuantityByUnitBar {
  return {
    key: `${r.item_family_id}-${r.unit_normalized ?? 'none'}`,
    unit: r.unit_normalized ?? '',
    familyLabel: r.family_label,
    familyHref: '/reports/vendors#spend-by-family',
    totalQuantity: r.total_quantity,
    observationCount: r.observation_count,
    vendorCount: r.vendor_count,
    entryCount: r.entry_count,
  }
}

/** "Tracked across N units of measure, {family} leads {unit} at {qty}
 *  purchased this event." (§6 fix #3) */
export function quantityByUnitSentence(rows: QuantityByUnitRow[]): string {
  if (rows.length === 0) {
    return 'No comparable purchase yet carries both an item family and a recorded quantity — this fills in as line items are verified with a quantity attached.'
  }
  const units = new Set(rows.map((r) => r.unit_normalized ?? '')).size
  const top = [...rows].sort((a, b) => b.total_quantity - a.total_quantity)[0]!
  return `Tracked across ${formatNumber(units)} unit${units === 1 ? '' : 's'} of measure, ${top.family_label} leads ${
    top.unit_normalized || 'its unit'
  } at ${formatNumber(top.total_quantity)} purchased this event.`
}

export function QuantityByUnitSection({
  rows,
  error,
  compareBasis,
  previousPairCount,
}: {
  rows: QuantityByUnitRow[]
  error: string | null
  compareBasis: CompareBasis
  previousPairCount: number | null
}) {
  const bars = rows.map(toBar)
  const previous = compareBasis === 'prior_event' ? previousPairCount : null

  const columns: DataTableColumn<QuantityByUnitRow>[] = [
    {
      key: 'family',
      header: 'Item family',
      render: (r) => (
        <Link href="/reports/vendors#spend-by-family" className="text-primary underline-offset-2 hover:underline">
          {r.family_label}
        </Link>
      ),
    },
    { key: 'unit', header: 'Unit', render: (r) => r.unit_normalized || 'Not recorded' },
    { key: 'qty', header: 'Total quantity', align: 'right', render: (r) => formatNumber(r.total_quantity) },
    { key: 'obs', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observation_count) },
    { key: 'vendors', header: 'Vendors', align: 'right', render: (r) => formatNumber(r.vendor_count) },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
  ]

  return (
    <ReportSection
      id="quantity-by-unit"
      title="Quantity purchased by unit"
      description="What we bought in physical terms — sqft, nos, days — not rupees. Each unit of measure gets its own scale, since a sqft total and a nos total can never share an axis."
      action={
        <ExportCsvButton
          filename="quantity-by-unit.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Item family', value: (r) => r.family_label },
            { header: 'Unit', value: (r) => r.unit_normalized },
            { header: 'Total quantity', value: (r) => r.total_quantity },
            { header: 'Observations', value: (r) => r.observation_count },
            { header: 'Vendors', value: (r) => r.vendor_count },
            { header: 'Entries', value: (r) => r.entry_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load quantity by unit" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No quantities recorded yet"
          description="This needs a comparable line item carrying both an item family and a parsed quantity. Quantity is back-filled by a separate pass, so this fills in as more line items are processed."
        />
      ) : (
        <>
          <KpiTile
            label="Item-family/unit pairs tracked"
            value={formatNumber(rows.length)}
            delta={formatDeltaVs(compareBasis, rows.length, previous, 'count')}
            deltaTone={deltaToneHigherIsGood(rows.length, previous)}
          />
          <p className="text-sm text-muted-foreground">{quantityByUnitSentence(rows)}</p>
          <QuantityByUnitChart bars={bars} />
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => `${r.item_family_id}-${r.unit_normalized ?? 'none'}`}
          />
        </>
      )}
    </ReportSection>
  )
}
