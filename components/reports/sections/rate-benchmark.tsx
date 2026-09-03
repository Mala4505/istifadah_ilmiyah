import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { RATE_BENCHMARK_MIN_OBSERVATIONS, RATE_BENCHMARK_MIN_VENDORS } from '@/lib/analytics/thresholds'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsGood, formatDeltaVs, type RateBenchmarkRow } from '@/lib/reports/sections/shared'

// Rate benchmark (blueprint D-02). Ported verbatim from the former
// app/(app)/reports/page.tsx section of the same id.

/** Reliable-benchmark coverage + widest-spread sentence (§6 fix #3). */
export function rateBenchmarkSentence(rows: RateBenchmarkRow[], reliableCount: number): string {
  if (rows.length === 0) return 'Not enough cross-vendor purchases yet to benchmark any item family.'
  const widest = [...rows]
    .filter((r) => r.median_rate != null && r.median_rate > 0 && r.max_rate != null)
    .sort((a, b) => b.max_rate! / b.median_rate! - a.max_rate! / a.median_rate!)[0]
  const base = `${formatNumber(reliableCount)} of ${formatNumber(rows.length)} item family/unit pairs have a reliable benchmark (≥${RATE_BENCHMARK_MIN_VENDORS} vendors, ≥${RATE_BENCHMARK_MIN_OBSERVATIONS} observations).`
  if (!widest) return base
  return `${base} ${widest.family_label} has the widest spread — its highest rate is ${(widest.max_rate! / widest.median_rate!).toFixed(1)}x the median.`
}

export function RateBenchmarkSection({
  rows,
  error,
  compareBasis,
  previousReliableCount,
}: {
  rows: RateBenchmarkRow[]
  error: string | null
  compareBasis: CompareBasis
  previousReliableCount: number | null
}) {
  const columns: DataTableColumn<RateBenchmarkRow>[] = [
    { key: 'family', header: 'Item Family', render: (r) => r.family_label },
    { key: 'unit', header: 'Unit', render: (r) => r.unit_normalized ?? '—' },
    { key: 'median', header: 'Median Rate', align: 'right', render: (r) => formatINR(r.median_rate) },
    { key: 'min', header: 'Min', align: 'right', render: (r) => formatINR(r.min_rate) },
    { key: 'max', header: 'Max', align: 'right', render: (r) => formatINR(r.max_rate) },
    { key: 'observations', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observation_count) },
    {
      key: 'vendors',
      header: 'Vendors',
      align: 'right',
      render: (r) => (
        <span
          className={
            r.vendor_count < RATE_BENCHMARK_MIN_VENDORS || r.observation_count < RATE_BENCHMARK_MIN_OBSERVATIONS
              ? 'text-muted-foreground'
              : undefined
          }
        >
          {formatNumber(r.vendor_count)}
        </span>
      ),
    },
  ]

  const reliableRows = rows.filter(
    (r) => r.vendor_count >= RATE_BENCHMARK_MIN_VENDORS && r.observation_count >= RATE_BENCHMARK_MIN_OBSERVATIONS
  )
  const reliableTotal = reliableRows.length
  const previous = compareBasis === 'prior_event' ? previousReliableCount : null

  return (
    <ReportSection
      id="rate-benchmark"
      title="Rate benchmark"
      description={`Median rate per item family + unit, across vendors. Greyed vendor counts have fewer than ${RATE_BENCHMARK_MIN_VENDORS} vendors or ${RATE_BENCHMARK_MIN_OBSERVATIONS} observations — not yet a reliable benchmark, shown for visibility only.`}
      action={
        <ExportCsvButton
          filename="rate-benchmark.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Item Family', value: (r) => r.family_label },
            { header: 'Unit', value: (r) => r.unit_normalized },
            { header: 'Median Rate', value: (r) => r.median_rate },
            { header: 'Min Rate', value: (r) => r.min_rate },
            { header: 'Max Rate', value: (r) => r.max_rate },
            { header: 'Observations', value: (r) => r.observation_count },
            { header: 'Vendors', value: (r) => r.vendor_count },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load rate benchmark" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Not enough data yet"
          description="Rate comparison needs multiple vendors billing the same item family. The pilot corpus has almost no cross-vendor overlap — this fills in as more documents are verified across more vendors."
        />
      ) : (
        <>
          <KpiTile
            label="Reliable benchmarks"
            value={`${formatNumber(reliableTotal)} / ${formatNumber(rows.length)}`}
            delta={formatDeltaVs(compareBasis, reliableTotal, previous, 'count')}
            deltaTone={deltaToneHigherIsGood(reliableTotal, previous)}
          />
          <p className="text-sm text-muted-foreground">{rateBenchmarkSentence(rows, reliableTotal)}</p>
          {reliableRows.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              No family/unit pair yet has {RATE_BENCHMARK_MIN_VENDORS}+ vendors and {RATE_BENCHMARK_MIN_OBSERVATIONS}+
              observations — every row below is directional only.
            </p>
          )}
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
