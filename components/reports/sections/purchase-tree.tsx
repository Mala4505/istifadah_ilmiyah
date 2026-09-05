import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { PurchaseTreeChart } from '@/components/reports/charts/purchase-tree-chart-lazy'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { formatDeltaVs } from '@/lib/reports/sections/shared'
import type { PurchaseTreeRow } from '@/lib/reports/surfaces/purchase-tree'

// reporting-blueprint.md C-02 (flagship) — Purchase tree. "Item family →
// catalogue item → vendor → the specific bills, drillable at every level.
// The exploration surface for 'where did ₹X actually go'."

/** "₹X went to N item families this event, led by {family} at ₹Y (Z% of the
 *  total) across M vendors." (§6 fix #3) */
export function purchaseTreeSentence(rows: PurchaseTreeRow[]): string {
  if (rows.length === 0) {
    return 'No purchase has been classified into an item family yet — this fills in as line items are matched to the catalogue.'
  }
  const total = rows.reduce((s, r) => s + r.line_amount, 0)
  const familyCount = new Set(rows.map((r) => r.item_family_id)).size
  const vendorCount = new Set(rows.map((r) => r.vendor_id).filter((v) => v != null)).size
  if (total <= 0) {
    return `${formatNumber(rows.length)} classified purchase${rows.length === 1 ? '' : 's'} recorded, none carrying a positive amount yet.`
  }
  const byFamily = new Map<number, { label: string; sum: number }>()
  for (const r of rows) {
    const cur = byFamily.get(r.item_family_id) ?? { label: r.family_label, sum: 0 }
    cur.sum += r.line_amount
    byFamily.set(r.item_family_id, cur)
  }
  const lead = [...byFamily.values()].sort((a, b) => b.sum - a.sum)[0]!
  const leadSharePct = (lead.sum / total) * 100
  return `${formatINRCompact(total)} went to ${formatNumber(familyCount)} item famil${
    familyCount === 1 ? 'y' : 'ies'
  } this event, led by ${lead.label} at ${formatINRCompact(lead.sum)} (${formatPercent(leadSharePct)} of the total) across ${formatNumber(
    vendorCount
  )} vendor${vendorCount === 1 ? '' : 's'}.`
}

export function PurchaseTreeSection({
  rows,
  error,
  compareBasis,
  previousTotal,
}: {
  rows: PurchaseTreeRow[]
  error: string | null
  compareBasis: CompareBasis
  previousTotal: number | null
}) {
  const total = rows.reduce((s, r) => s + r.line_amount, 0)
  const previous = compareBasis === 'prior_event' ? previousTotal : null
  const tableRows = [...rows].sort((a, b) => b.line_amount - a.line_amount)

  const columns: DataTableColumn<PurchaseTreeRow>[] = [
    { key: 'family', header: 'Item family', render: (r) => r.family_label },
    { key: 'item', header: 'Catalogue item', render: (r) => r.catalog_label ?? 'Unclassified item' },
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
    {
      key: 'entry',
      header: 'Entry',
      render: (r) =>
        r.entry_id ? (
          <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.invoice_number ? r.invoice_number : `#${r.entry_id}`}
          </Link>
        ) : (
          '—'
        ),
    },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.line_amount) },
  ]

  return (
    <ReportSection
      id="purchase-tree"
      title="Purchase tree"
      description="Item family → catalogue item → vendor → the specific bills, drillable at every level. The exploration surface for 'where did the money actually go' — every lump-sum and comparable line alike, not just the benchmarkable ones."
      action={
        <ExportCsvButton
          filename="purchase-tree.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Item family', value: (r) => r.family_label },
            { header: 'Catalogue item', value: (r) => r.catalog_label },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Entry', value: (r) => r.entry_id },
            { header: 'Invoice number', value: (r) => r.invoice_number },
            { header: 'Net rate', value: (r) => r.net_rate },
            { header: 'Quantity', value: (r) => r.quantity },
            { header: 'Amount', value: (r) => r.line_amount },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the purchase tree" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No classified purchases yet"
          description="This fills in as line items are matched to an item family during review — see /catalog to confirm proposed families."
        />
      ) : (
        <>
          <KpiTile
            label="Classified purchase spend"
            value={formatINRCompact(total)}
            delta={formatDeltaVs(compareBasis, total, previous, 'inr')}
            deltaTone="neutral"
          />
          <p className="text-sm text-muted-foreground">{purchaseTreeSentence(rows)}</p>
          <PurchaseTreeChart rows={rows} />
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => `${r.item_family_id}-${r.item_catalog_id ?? 'x'}-${r.vendor_id ?? 'x'}-${r.entry_id ?? 'x'}-${r.observed_date ?? 'x'}-${r.net_rate}`}
            emptyTitle="No classified purchases"
          />
        </>
      )}
    </ReportSection>
  )
}
