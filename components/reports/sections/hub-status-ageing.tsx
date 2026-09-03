import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { AgeBucketBadge } from '@/components/reports/severity-badge'
import { toCsv } from '@/lib/reports/csv'
import { formatDateTime, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs, type HubAgeingRow } from '@/lib/reports/sections/shared'

// Hub-status ageing (blueprint Integrity surface). Ported verbatim from the
// former app/(app)/reports/page.tsx section of the same id so /reports
// (Explore) and /reports/integrity render identically.

type AgeingBuckets = { '0-2': number; '3-7': number; '8+': number }

/** "N entries have been waiting 8+ days" contradiction sentence (§6 fix #3). */
export function hubAgeingSentence(buckets: AgeingBuckets, total: number): string {
  if (total === 0) return 'Nothing is currently awaiting verification or validation.'
  if (buckets['8+'] === 0) return `${formatNumber(total)} entries are awaiting review, none older than 7 days.`
  const share8Plus = (buckets['8+'] / total) * 100
  return `${formatNumber(buckets['8+'])} entries (${formatPercent(share8Plus)} of the queue) have been waiting 8+ days.`
}

const ageingColumns: DataTableColumn<HubAgeingRow>[] = [
  {
    key: 'ubbl',
    header: 'UBBL Number',
    render: (r) => (
      <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
        {r.ubbl_number}
      </Link>
    ),
  },
  { key: 'status', header: 'Hub Status', render: (r) => r.hub_status_label },
  { key: 'days', header: 'Days in Status', align: 'right', render: (r) => formatNumber(r.days_in_status) },
  { key: 'bucket', header: 'Bucket', render: (r) => <AgeBucketBadge bucket={r.age_bucket} /> },
  { key: 'changed', header: 'Changed', render: (r) => formatDateTime(r.hub_status_changed_at) },
]

export function HubStatusAgeingSection({
  rows,
  error,
  compareBasis,
  buckets,
  series,
  previousCount,
}: {
  rows: HubAgeingRow[]
  error: string | null
  compareBasis: CompareBasis
  buckets: AgeingBuckets
  series: number[]
  previousCount: number | null
}) {
  return (
    <ReportSection
      id="hub-status-ageing"
      title="Hub-status ageing"
      description="Days each entry has sat in Awaiting Verification / Awaiting Validation — what the modules are waiting on."
      action={
        <ExportCsvButton
          filename="hub-status-ageing.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'UBBL Number', value: (r) => r.ubbl_number },
            { header: 'Hub Status', value: (r) => r.hub_status_label },
            { header: 'Days in Status', value: (r) => r.days_in_status },
            { header: 'Age Bucket', value: (r) => r.age_bucket },
            { header: 'Changed At', value: (r) => r.hub_status_changed_at },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load Hub-status ageing" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing awaiting verification or validation"
          description="Entries appear here once a Hub status is set from the review queue or entry detail screen."
        />
      ) : (
        <>
          <KpiTile
            label="Awaiting review"
            value={formatNumber(rows.length)}
            delta={formatDeltaVs(compareBasis, rows.length, previousCount, 'count')}
            deltaTone={deltaToneHigherIsBad(rows.length, previousCount)}
            series={series}
          />
          <div className="grid grid-cols-3 gap-3">
            {(['0-2', '3-7', '8+'] as const).map((bucket) => (
              <div key={bucket} className="rounded-md border border-border p-3">
                <p className="text-2xl font-mono font-semibold tracking-tight">{formatNumber(buckets[bucket])}</p>
                <p className="mt-1 text-xs text-muted-foreground">{bucket} days</p>
              </div>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{hubAgeingSentence(buckets, rows.length)}</p>
          <DataTable columns={ageingColumns} rows={rows} getRowKey={(r) => r.entry_id} />
        </>
      )}
    </ReportSection>
  )
}
