import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { StripPlotChart, type StripPlotDot } from '@/components/reports/charts/strip-plot-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs, type RateObservationRow } from '@/lib/reports/sections/shared'

// reporting-blueprint.md C-04 (flagship) — above-median overpayment. "For every
// line priced above our own median for that item and unit: (rate − median) ×
// quantity. Summed, that is a headline rupee figure benchmarked against our own
// purchase history — very hard to argue with." The dots are the evidence; the
// total is the headline.

/** Comparable observations are the ones the strip plot can place: a real
 *  (family, unit) median to normalise against. */
function comparable(rows: RateObservationRow[]): RateObservationRow[] {
  return rows.filter((r) => r.median_rate != null && r.median_rate > 0)
}

/** "Across N comparable purchases in M item families, ₹X sits above our own
 *  median rate for the same item and unit — led by {family} at ₹Y." (§6 fix #3) */
export function aboveMedianOverpaymentSentence(rows: RateObservationRow[]): string {
  const cmp = comparable(rows)
  if (cmp.length === 0) {
    return 'No comparable purchases yet — a rate needs our own median for the same item and unit to be benchmarked against.'
  }
  const total = rows.reduce((s, r) => s + r.overpayment_amount, 0)
  const familyCount = new Set(cmp.map((r) => r.family_key)).size
  const base = `Across ${formatNumber(cmp.length)} comparable purchase${cmp.length === 1 ? '' : 's'} in ${formatNumber(
    familyCount
  )} item famil${familyCount === 1 ? 'y' : 'ies'}`
  if (total <= 0) {
    return `${base}, none is priced above our own median rate for the same item and unit.`
  }
  const byFamily = new Map<string, { label: string; sum: number }>()
  for (const r of rows) {
    if (r.overpayment_amount <= 0) continue
    const cur = byFamily.get(r.family_key) ?? { label: r.family_label, sum: 0 }
    cur.sum += r.overpayment_amount
    byFamily.set(r.family_key, cur)
  }
  const lead = [...byFamily.values()].sort((a, b) => b.sum - a.sum)[0]!
  return `${base}, ${formatINRCompact(total)} sits above our own median rate for the same item and unit — led by ${
    lead.label
  } at ${formatINRCompact(lead.sum)}.`
}

export function AboveMedianOverpaymentSection({
  rows,
  error,
  compareBasis,
  previousTotal,
}: {
  rows: RateObservationRow[]
  error: string | null
  compareBasis: CompareBasis
  previousTotal: number | null
}) {
  const cmp = comparable(rows)
  const totalOverpayment = rows.reduce((s, r) => s + r.overpayment_amount, 0)
  const excludedCount = rows.length - cmp.length
  const previous = compareBasis === 'prior_event' ? previousTotal : null

  const dots: StripPlotDot[] = cmp.map((r) => {
    const median = r.median_rate as number
    return {
      key: r.rate_reference_id,
      familyKey: r.family_key,
      family: r.family_label,
      unit: r.unit_normalized,
      vendorId: r.vendor_id,
      vendorName: r.vendor_display_name ?? (r.vendor_id != null ? `#${r.vendor_id}` : 'Unknown vendor'),
      netRate: r.net_rate,
      medianRate: median,
      ratio: r.net_rate / median,
      quantity: r.quantity,
      overpayment: r.overpayment_amount,
      entryId: r.entry_id,
    }
  })

  const tableRows = rows
    .filter((r) => r.overpayment_amount > 0)
    .sort((a, b) => b.overpayment_amount - a.overpayment_amount)

  const columns: DataTableColumn<RateObservationRow>[] = [
    { key: 'family', header: 'Item family', render: (r) => r.family_label },
    { key: 'unit', header: 'Unit', render: (r) => r.unit_normalized ?? '—' },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendor_id ? (
          <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.vendor_display_name ?? `#${r.vendor_id}`}
          </Link>
        ) : (
          (r.vendor_display_name ?? '—')
        ),
    },
    { key: 'rate', header: 'Net rate', align: 'right', render: (r) => formatINR(r.net_rate) },
    { key: 'median', header: 'Our median', align: 'right', render: (r) => formatINR(r.median_rate) },
    { key: 'qty', header: 'Qty', align: 'right', render: (r) => formatNumber(r.quantity) },
    { key: 'over', header: 'Above-median ₹', align: 'right', render: (r) => formatINR(r.overpayment_amount) },
    {
      key: 'entry',
      header: 'Entry',
      render: (r) =>
        r.entry_id ? (
          <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
            #{r.entry_id}
          </Link>
        ) : (
          '—'
        ),
    },
  ]

  return (
    <ReportSection
      id="above-median-overpayment"
      title="Above-median overpayment"
      description="Every comparable purchase plotted by its rate as a multiple of our own median for the same item and unit. Everything right of the median rule has a rupee cost — (rate − median) × quantity — and the sum of those costs is the headline. Benchmarked against our own purchase history, not an external list."
      action={
        <ExportCsvButton
          filename="above-median-overpayment.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Item family', value: (r) => r.family_label },
            { header: 'Unit', value: (r) => r.unit_normalized },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Net rate', value: (r) => r.net_rate },
            { header: 'Our median', value: (r) => r.median_rate },
            { header: 'Quantity', value: (r) => r.quantity },
            { header: 'Above-median amount', value: (r) => r.overpayment_amount },
            { header: 'Entry', value: (r) => r.entry_id },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load above-median overpayment" description={error} />
      ) : cmp.length === 0 ? (
        <EmptyState
          title="No comparable purchases yet"
          description="This needs two or more vendors billing the same item family in the same unit, so a median exists to compare against. It fills in as more line items are verified across more vendors."
        />
      ) : (
        <>
          <KpiTile
            label="Above-median spend"
            value={formatINRCompact(totalOverpayment)}
            delta={formatDeltaVs(compareBasis, totalOverpayment, previous, 'inr')}
            deltaTone={deltaToneHigherIsBad(totalOverpayment, previous)}
          />
          <p className="text-sm text-muted-foreground">{aboveMedianOverpaymentSentence(rows)}</p>
          <StripPlotChart dots={dots} excludedCount={excludedCount} />
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => r.rate_reference_id}
            emptyTitle="No purchase is priced above our median"
            emptyDescription="Every comparable purchase this event sits at or below our own median rate for the same item and unit."
          />
        </>
      )}
    </ReportSection>
  )
}
