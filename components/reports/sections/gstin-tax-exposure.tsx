import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { TaxExposureChart, type TaxExposureDept } from '@/components/reports/charts/tax-exposure-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import type { TaxCreditExposureRow } from '@/lib/reports/surfaces/related-party-gstin'

// reporting-blueprint.md B-08 (flagship) — GSTIN validity & tax exposure.
// "Tax charged, against the share of it where the vendor GSTIN passes
// checksum and our own GSTIN appears on the bill. The gap is credit that may
// not be claimable." "At risk" = an open vendor_gstin_invalid_checksum or
// gst_recipient_compliance_missing exception on that bill (v_tax_credit_exposure's
// header has the full derivation) — resolving the exception (e.g. a reviewer
// corrects the GSTIN) moves its tax back to claimable on the next load.

function totals(rows: TaxCreditExposureRow[]) {
  return rows.reduce(
    (acc, r) => ({
      total: acc.total + r.total_tax_amount,
      atRisk: acc.atRisk + r.at_risk_tax_amount,
      claimable: acc.claimable + r.claimable_tax_amount,
    }),
    { total: 0, atRisk: 0, claimable: 0 }
  )
}

/** "Of ₹X tax charged this event, ₹Y (Z%) sits on a bill with an open GSTIN
 *  or recipient-compliance exception — led by {department} at ₹W." (§6 fix #3) */
export function taxExposureSentence(rows: TaxCreditExposureRow[]): string {
  const { total, atRisk } = totals(rows)
  if (total <= 0) {
    return 'No tax has been charged on a verified bill yet this event — nothing to assess for claimability.'
  }
  if (atRisk <= 0) {
    return `All ${formatINRCompact(total)} of tax charged this event sits on bills with a clean GSTIN checksum and our own GSTIN/name on record — none currently at risk.`
  }
  const atRiskPct = (atRisk / total) * 100
  const byDept = new Map<string, number>()
  for (const r of rows) {
    if (r.at_risk_tax_amount <= 0) continue
    const label = r.department_name ?? 'No department'
    byDept.set(label, (byDept.get(label) ?? 0) + r.at_risk_tax_amount)
  }
  const lead = [...byDept.entries()].sort((a, b) => b[1] - a[1])[0]
  const leadText = lead ? ` — led by ${lead[0]} at ${formatINRCompact(lead[1])}` : ''
  return `Of ${formatINRCompact(total)} tax charged this event, ${formatINRCompact(atRisk)} (${formatPercent(
    atRiskPct
  )}) sits on a bill with an open GSTIN checksum or recipient-compliance exception${leadText}.`
}

function toDeptChartRows(rows: TaxCreditExposureRow[]): TaxExposureDept[] {
  const byDept = new Map<string, TaxExposureDept>()
  for (const r of rows) {
    const key = r.department_id != null ? String(r.department_id) : 'none'
    const cur = byDept.get(key) ?? { key, name: r.department_name ?? 'No department', claimable: 0, atRisk: 0, total: 0 }
    cur.claimable += r.claimable_tax_amount
    cur.atRisk += r.at_risk_tax_amount
    cur.total += r.total_tax_amount
    byDept.set(key, cur)
  }
  return [...byDept.values()]
}

export function GstinTaxExposureSection({
  rows,
  error,
  compareBasis,
  previousAtRiskTotal,
}: {
  rows: TaxCreditExposureRow[]
  error: string | null
  compareBasis: CompareBasis
  previousAtRiskTotal: number | null
}) {
  const { atRisk } = totals(rows)
  const previous = compareBasis === 'prior_event' ? previousAtRiskTotal : null
  const deptRows = toDeptChartRows(rows)

  const tableRows = [...rows]
    .filter((r) => r.total_tax_amount > 0)
    .sort((a, b) => b.at_risk_tax_amount - a.at_risk_tax_amount)

  const columns: DataTableColumn<TaxCreditExposureRow>[] = [
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
      key: 'department',
      header: 'Department',
      render: (r) =>
        r.department_id ? (
          <Link
            href={`/entries?department_id=${r.department_id}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {r.department_name ?? `#${r.department_id}`}
          </Link>
        ) : (
          (r.department_name ?? '—')
        ),
    },
    { key: 'bills', header: 'Bills', align: 'right', render: (r) => formatNumber(r.bill_count) },
    { key: 'total', header: 'Total tax charged', align: 'right', render: (r) => formatINR(r.total_tax_amount) },
    { key: 'atrisk', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.at_risk_tax_amount) },
    { key: 'claimable', header: 'Claimable ₹', align: 'right', render: (r) => formatINR(r.claimable_tax_amount) },
  ]

  return (
    <ReportSection
      id="gstin-tax-exposure"
      title="GSTIN validity & tax exposure"
      description="Tax charged, against the share of it sitting on a bill whose vendor GSTIN fails its own checksum or whose recipient-compliance fields (our GSTIN/name/invoice number) are missing. The gap is input tax credit that may not be safely claimable until a reviewer clears the exception."
      action={
        <ExportCsvButton
          filename="gstin-tax-exposure.csv"
          rowCount={tableRows.length}
          csv={toCsv(tableRows, [
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Department', value: (r) => r.department_name },
            { header: 'Bills', value: (r) => r.bill_count },
            { header: 'Total tax charged', value: (r) => r.total_tax_amount },
            { header: '₹ at risk', value: (r) => r.at_risk_tax_amount },
            { header: 'Claimable ₹', value: (r) => r.claimable_tax_amount },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load GSTIN & tax exposure" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No tax charged yet this event"
          description="This fills in once a verified bill with GST charged is on record — either as clean credit or, when the vendor GSTIN fails checksum or our own recipient details are missing, as at-risk credit."
        />
      ) : (
        <>
          <KpiTile
            label="Tax credit at risk"
            value={formatINRCompact(atRisk)}
            delta={formatDeltaVs(compareBasis, atRisk, previous, 'inr')}
            deltaTone={deltaToneHigherIsBad(atRisk, previous)}
          />
          <p className="text-sm text-muted-foreground">{taxExposureSentence(rows)}</p>
          <TaxExposureChart departments={deptRows} />
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => `${r.vendor_id ?? 'none'}:${r.department_id ?? 'none'}`}
            emptyTitle="No tax-charged bills"
            emptyDescription="Every vendor/department pair with tax charged this event will list here once verified."
          />
        </>
      )}
    </ReportSection>
  )
}
