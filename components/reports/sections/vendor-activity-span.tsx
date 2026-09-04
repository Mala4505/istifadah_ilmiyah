import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { AttentionPill } from '@/components/reports/severity-badge'
import {
  VendorActivityTimelineChart,
  type ActivityLaneVendor,
} from '@/components/reports/charts/vendor-activity-timeline-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatDate, formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  SINGLE_APPEARANCE_MATERIALITY_THRESHOLD,
  isMaterialSingleAppearance,
  type VendorActivitySpanRow,
} from '@/lib/reports/surfaces/vendor-scorecard'

// reporting-blueprint.md B-09 — activity span & dormancy. "First and last
// invoice per vendor, and the gaps. Surfaces vendors that appear once for a
// large amount and are never seen again." Headline = count and ₹ of
// single-appearance vendors clearing the materiality bar.

const TOP_LANE_COUNT = 30

/** "N vendors appear only once this event, for ₹X combined, above the
 *  ₹{threshold} bar — the largest is {vendor} at ₹Y on {date}." (§6 fix #3) */
export function vendorActivitySpanSentence(rows: VendorActivitySpanRow[]): string {
  if (rows.length === 0) return 'No vendor activity recorded yet this event.'
  const material = rows.filter(isMaterialSingleAppearance)
  if (material.length === 0) {
    return `No vendor appears only once for ₹${formatNumber(SINGLE_APPEARANCE_MATERIALITY_THRESHOLD)} or more this event — every large purchase sits with a vendor seen more than once.`
  }
  const lead = [...material].sort((a, b) => (b.total_spend ?? 0) - (a.total_spend ?? 0))[0]!
  const total = material.reduce((s, r) => s + (r.total_spend ?? 0), 0)
  return `${formatNumber(material.length)} vendor${material.length === 1 ? '' : 's'} appear${
    material.length === 1 ? 's' : ''
  } only once this event, for ${formatINRCompact(total)} combined — the largest is ${lead.display_name} at ${formatINRCompact(
    lead.total_spend
  )} on ${formatDate(lead.first_entry_date)}, never seen again.`
}

export function VendorActivitySpanSection({
  rows,
  error,
  compareBasis,
  previousMaterialCount,
  eventStartsOn,
  eventEndsOn,
}: {
  rows: VendorActivitySpanRow[]
  error: string | null
  compareBasis: CompareBasis
  previousMaterialCount: number | null
  eventStartsOn: string | null
  eventEndsOn: string | null
}) {
  const material = rows.filter(isMaterialSingleAppearance)
  const previous = compareBasis === 'prior_event' ? previousMaterialCount : null

  const datedRows = rows.filter((r) => r.first_entry_date != null && r.last_entry_date != null)
  const laneRows = [...datedRows].sort((a, b) => (b.total_spend ?? 0) - (a.total_spend ?? 0)).slice(0, TOP_LANE_COUNT)
  const laneVendors: ActivityLaneVendor[] = laneRows.map((r) => ({
    vendorId: r.vendor_id,
    vendorName: r.display_name,
    firstDate: r.first_entry_date as string,
    lastDate: r.last_entry_date as string,
    activeDates: r.active_dates,
    entryCount: r.entry_count,
    distinctActiveDays: r.distinct_active_days,
    maxGapDays: r.max_gap_days,
    totalSpend: r.total_spend,
    singleAppearance: r.single_appearance,
    isMaterialSingleAppearance: isMaterialSingleAppearance(r),
  }))

  const allDates = datedRows.flatMap((r) => [r.first_entry_date as string, r.last_entry_date as string])
  const fallbackStart = allDates.length > 0 ? allDates.reduce((a, b) => (a < b ? a : b)) : null
  const fallbackEnd = allDates.length > 0 ? allDates.reduce((a, b) => (a > b ? a : b)) : null
  const domainStart = eventStartsOn ?? fallbackStart
  const domainEnd = eventEndsOn ?? fallbackEnd

  const columns: DataTableColumn<VendorActivitySpanRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.display_name}
        </Link>
      ),
    },
    { key: 'first', header: 'First entry', render: (r) => formatDate(r.first_entry_date) },
    { key: 'last', header: 'Last entry', render: (r) => formatDate(r.last_entry_date) },
    { key: 'span', header: 'Active span (days)', align: 'right', render: (r) => formatNumber(r.active_span_days) },
    { key: 'days', header: 'Active days', align: 'right', render: (r) => formatNumber(r.distinct_active_days) },
    { key: 'gap', header: 'Max gap (days)', align: 'right', render: (r) => formatNumber(r.max_gap_days) },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'spend', header: 'Spend', align: 'right', render: (r) => formatINR(r.total_spend) },
    {
      key: 'single',
      header: 'Single appearance',
      render: (r) => (r.single_appearance ? <AttentionPill>Single appearance</AttentionPill> : '—'),
    },
  ]

  const tableRows = [...material, ...rows.filter((r) => !isMaterialSingleAppearance(r))].sort((a, b) => {
    const aMat = isMaterialSingleAppearance(a)
    const bMat = isMaterialSingleAppearance(b)
    if (aMat !== bMat) return aMat ? -1 : 1
    return (b.total_spend ?? 0) - (a.total_spend ?? 0)
  })

  return (
    <ReportSection
      id="vendor-activity-span"
      title="Vendor activity span & dormancy"
      description={`First and last entry per vendor this event, and the gaps between. Surfaces vendors that appear once for ₹${formatNumber(
        SINGLE_APPEARANCE_MATERIALITY_THRESHOLD
      )} or more and are never seen again.`}
      action={
        <ExportCsvButton
          filename="vendor-activity-span.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Vendor', value: (r) => r.display_name },
            { header: 'First entry', value: (r) => r.first_entry_date },
            { header: 'Last entry', value: (r) => r.last_entry_date },
            { header: 'Active span (days)', value: (r) => r.active_span_days },
            { header: 'Active days', value: (r) => r.distinct_active_days },
            { header: 'Max gap (days)', value: (r) => r.max_gap_days },
            { header: 'Entries', value: (r) => r.entry_count },
            { header: 'Spend', value: (r) => r.total_spend },
            { header: 'Max single amount', value: (r) => r.max_single_amount },
            { header: 'Single appearance', value: (r) => (r.single_appearance ? 'yes' : 'no') },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load vendor activity span" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No vendor activity yet"
          description="This fills in once entries exist for the selected event."
        />
      ) : (
        <>
          <KpiTile
            label={`Single-appearance vendors ≥ ${formatINRCompact(SINGLE_APPEARANCE_MATERIALITY_THRESHOLD)}`}
            value={formatNumber(material.length)}
            delta={formatDeltaVs(compareBasis, material.length, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(material.length, previous)}
          />
          <p className="text-sm text-muted-foreground">{vendorActivitySpanSentence(rows)}</p>
          {domainStart && domainEnd ? (
            <VendorActivityTimelineChart vendors={laneVendors} domainStart={domainStart} domainEnd={domainEnd} />
          ) : (
            <EmptyState
              title="No dated activity to plot"
              description="Vendors need at least one dated entry this event before a timeline can be drawn."
            />
          )}
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => r.vendor_id}
            emptyTitle="No vendor activity yet"
          />
        </>
      )}
    </ReportSection>
  )
}
