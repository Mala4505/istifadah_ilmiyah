import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { InstrumentMixChart, type InstrumentMixDept } from '@/components/reports/charts/instrument-mix-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  deltaToneHigherIsGood,
  formatDeltaVs,
  ITC_BACKED_INSTRUMENT_TYPES,
  type InstrumentTypeMixRow,
} from '@/lib/reports/sections/shared'

// reporting-blueprint.md C-09 (flagship) — instrument-type mix. "How much spend
// is backed by a proper tax invoice versus a letterhead bill, a cash memo, or a
// quotation. '₹X of spend is supported only by a letterhead bill' ends a
// meeting quickly." Measured in rupees, not entry counts.
//
// The eleven instrument-type codes (plus the two synthetic buckets from
// v_instrument_type_mix — 'unclassified' = we have a bill but no type on it,
// 'no_document' = there is no bill) collapse to five ordered tiers. The
// grouping + labels are defined here (a Server Component, so the client chart
// can't value-import them); the chart owns only their colours and order, which
// must stay in sync with GROUPS below.

const GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: 'tax_invoice', label: 'Tax invoice', types: ['tax_invoice'] },
  { key: 'bill_of_supply', label: 'Bill of supply', types: ['bill_of_supply'] },
  {
    key: 'other_bill',
    label: 'Other bill',
    types: ['letterhead_bill', 'retail_cash_memo', 'receipt', 'delivery_challan', 'proforma_invoice', 'quotation', 'other'],
  },
  { key: 'unclassified', label: 'Not yet classified', types: ['unclassified'] },
  { key: 'no_document', label: 'No supporting bill', types: ['no_document'] },
]

const TYPE_TO_GROUP = new Map<string, string>()
for (const g of GROUPS) for (const t of g.types) TYPE_TO_GROUP.set(t, g.key)

/** Anything that is not a tax invoice or a bill of supply — the "would not
 *  survive a review" bucket the sentence names. */
const WEAK_GROUP_KEYS = new Set(['other_bill', 'unclassified', 'no_document'])

function groupOf(instrumentType: string): string {
  return TYPE_TO_GROUP.get(instrumentType) ?? 'other_bill'
}

/** "₹X of spend (Y%) is backed only by a letterhead bill, a cash memo, an
 *  as-yet-unclassified document, or no bill at all." (§6 fix #3) */
export function instrumentTypeMixSentence(rows: InstrumentTypeMixRow[]): string {
  const total = rows.reduce((s, r) => s + r.total_amount, 0)
  if (total <= 0) return 'No department spend recorded yet this event.'
  const weak = rows.filter((r) => WEAK_GROUP_KEYS.has(groupOf(r.instrument_type))).reduce((s, r) => s + r.total_amount, 0)
  if (weak <= 0) return "Every rupee of this event's spend is backed by a tax invoice or a bill of supply."
  const pct = (weak / total) * 100
  return `${formatINRCompact(weak)} of spend (${formatPercent(
    pct
  )}) is backed only by a letterhead bill, a cash memo, an as-yet-unclassified document, or no bill at all — not a tax invoice or bill of supply.`
}

function buildDepartments(rows: InstrumentTypeMixRow[]): InstrumentMixDept[] {
  const byDept = new Map<string, InstrumentMixDept>()
  for (const r of rows) {
    const id = r.department_id
    const mapKey = id != null ? `d${id}` : 'none'
    const entry: InstrumentMixDept = byDept.get(mapKey) ?? {
      key: id ?? 'none',
      name: r.department_name ?? 'Unassigned',
      total: 0,
      values: {},
    }
    const gk = groupOf(r.instrument_type)
    entry.values[gk] = (entry.values[gk] ?? 0) + r.total_amount
    entry.total += r.total_amount
    byDept.set(mapKey, entry)
  }
  return [...byDept.values()].sort((a, b) => b.total - a.total)
}

export function InstrumentTypeMixSection({
  rows,
  error,
  compareBasis,
  previousBackedPct,
}: {
  rows: InstrumentTypeMixRow[]
  error: string | null
  compareBasis: CompareBasis
  previousBackedPct: number | null
}) {
  const departments = buildDepartments(rows)
  const totalSpend = rows.reduce((s, r) => s + r.total_amount, 0)
  const backedSpend = rows
    .filter((r) => ITC_BACKED_INSTRUMENT_TYPES.has(r.instrument_type))
    .reduce((s, r) => s + r.total_amount, 0)
  const backedPct = totalSpend > 0 ? (backedSpend / totalSpend) * 100 : 0
  const previous = compareBasis === 'prior_event' ? previousBackedPct : null

  const columns: DataTableColumn<InstrumentMixDept>[] = [
    {
      key: 'dept',
      header: 'Department',
      render: (d) =>
        typeof d.key === 'number' ? (
          <Link href={`/entries?department_id=${d.key}`} className="text-primary underline-offset-2 hover:underline">
            {d.name}
          </Link>
        ) : (
          d.name
        ),
    },
    ...GROUPS.map(
      (g): DataTableColumn<InstrumentMixDept> => ({
        key: g.key,
        header: g.label,
        align: 'right',
        render: (d) => ((d.values[g.key] ?? 0) > 0 ? formatINR(d.values[g.key] ?? 0) : '—'),
      })
    ),
    { key: 'total', header: 'Total', align: 'right', render: (d) => formatINR(d.total) },
  ]

  return (
    <ReportSection
      id="instrument-type-mix"
      title="Instrument-type mix"
      description="Each department's spend split by the kind of bill behind it — best-backed (tax invoice) to worst (no bill at all), measured in rupees. Turns a compliance question into a money question."
      action={
        <ExportCsvButton
          filename="instrument-type-mix.csv"
          rowCount={departments.length}
          csv={toCsv(departments, [
            { header: 'Department', value: (d) => d.name },
            ...GROUPS.map((g) => ({ header: g.label, value: (d: InstrumentMixDept) => d.values[g.key] ?? 0 })),
            { header: 'Total', value: (d) => d.total },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load instrument-type mix" description={error} />
      ) : totalSpend <= 0 ? (
        <EmptyState
          title="No department spend yet"
          description="Each non-void entry is attributed to one instrument type via its best bill; this fills in as entries import and documents are read."
        />
      ) : (
        <>
          <KpiTile
            label="Backed by tax invoice"
            value={formatPercent(backedPct)}
            delta={formatDeltaVs(compareBasis, backedPct, previous, 'count')}
            deltaTone={deltaToneHigherIsGood(backedPct, previous)}
          />
          <p className="text-sm text-muted-foreground">{instrumentTypeMixSentence(rows)}</p>
          <InstrumentMixChart departments={departments} />
          <DataTable columns={columns} rows={departments} getRowKey={(d) => d.key} />
        </>
      )}
    </ReportSection>
  )
}
