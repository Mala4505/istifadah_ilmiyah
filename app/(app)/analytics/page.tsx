import { friendlyDataError } from '@/lib/friendly-error'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { ReportSection } from '@/components/reports/report-section'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { toCsv } from '@/lib/reports/csv'
import { SeverityBadge } from '@/components/reports/severity-badge'
import { EmptyState } from '@/components/reports/empty-state'
import { formatDateTime, formatINR, formatINRCompact, formatNumber, humanizeCode } from '@/lib/reports/format'
import { RATE_BENCHMARK_MIN_OBSERVATIONS, RATE_BENCHMARK_MIN_VENDORS } from '@/lib/analytics/thresholds'

/**
 * /analytics — Phase 2 analytics engine (MASTER-PLAN §14 Phase 2; item catalog,
 * flags-run, rate comparison). Four sections, each reading one of the views added
 * in 20260814000007_analytics_views.sql, following the exact section/CSV-export
 * pattern /reports already established — this screen is that one's sibling, not a
 * reinvention of it.
 *
 * Every row here originates from flags-run (lib/jobs/handlers/flags-run.ts),
 * which re-queues itself every 15 minutes — see that file's header comment for
 * why a whole-corpus sweep has no natural trigger event and self-schedules
 * instead. A flag confirmed or dismissed here is never silently reopened by a
 * later sweep (the upsert in 20260814000004 leaves status/resolved_* alone).
 */
export const dynamic = 'force-dynamic'

const ROW_CAP = 1000 // same safety cap as /reports (§0)

type ComplianceRow = {
  id: number
  flag_type: string
  severity: string
  description: string | null
  amount_at_risk: number | null
  status: string
  entry_id: number | null
  vendor_id: number | null
  vendor_display_name: string | null
  department_id: number | null
  department_name: string | null
  created_at: string
  last_detected_at: string
  related_entry_ids: number[] | null
}

type VendorConcentrationRow = {
  vendor_id: number
  display_name: string
  is_confirmed: boolean
  entry_count: number
  total_amount: number | null
  open_flag_count: number
  open_flag_amount_at_risk: number | null
  pct_of_total_spend: number | null
}

type SpendByFamilyRow = {
  item_family_id: number
  family_key: string
  label: string
  default_unit: string | null
  is_confirmed: boolean
  total_spend: number
  observation_count: number
  vendor_count: number
}

type RateBenchmarkRow = {
  item_family_id: number
  family_key: string
  family_label: string
  unit_normalized: string | null
  median_rate: number | null
  observation_count: number
  vendor_count: number
  min_rate: number | null
  max_rate: number | null
}

async function loadAnalyticsData() {
  const supabase = await createClient()

  const [complianceRes, concentrationRes, familyRes, benchmarkRes] = await Promise.all([
    supabase
      .from('v_compliance_summary')
      .select(
        'id, flag_type, severity, description, amount_at_risk, status, entry_id, vendor_id, vendor_display_name, department_id, department_name, created_at, last_detected_at, related_entry_ids'
      )
      .limit(ROW_CAP)
      .returns<ComplianceRow[]>(),
    supabase
      .from('v_vendor_concentration')
      .select(
        'vendor_id, display_name, is_confirmed, entry_count, total_amount, open_flag_count, open_flag_amount_at_risk, pct_of_total_spend'
      )
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorConcentrationRow[]>(),
    supabase
      .from('v_spend_by_family')
      .select('item_family_id, family_key, label, default_unit, is_confirmed, total_spend, observation_count, vendor_count')
      .order('total_spend', { ascending: false })
      .returns<SpendByFamilyRow[]>(),
    supabase
      .from('v_rate_benchmark')
      .select('item_family_id, family_key, family_label, unit_normalized, median_rate, observation_count, vendor_count, min_rate, max_rate')
      .order('observation_count', { ascending: false })
      .returns<RateBenchmarkRow[]>(),
  ])

  const vendorRows = (concentrationRes.data ?? []).filter((r) => (r.entry_count ?? 0) > 0)

  return {
    complianceRows: complianceRes.data ?? [],
    vendorRows,
    familyRows: familyRes.data ?? [],
    benchmarkRows: benchmarkRes.data ?? [],
    errors: {
      compliance: friendlyDataError(complianceRes.error, 'analytics:complianceRes'),
      concentration: friendlyDataError(concentrationRes.error, 'analytics:concentrationRes'),
      family: friendlyDataError(familyRes.error, 'analytics:familyRes'),
      benchmark: friendlyDataError(benchmarkRes.error, 'analytics:benchmarkRes'),
    },
  }
}

const SECTIONS = [
  { id: 'compliance', label: 'Compliance & Leakage' },
  { id: 'vendor-concentration', label: 'Vendor Concentration' },
  { id: 'spend-by-family', label: 'Spend by Item Family' },
  { id: 'rate-benchmark', label: 'Rate Benchmark' },
] as const

export default async function AnalyticsPage() {
  const data = await loadAnalyticsData()

  const complianceTotalAtRisk = data.complianceRows.reduce((sum, r) => sum + (r.amount_at_risk ?? 0), 0)
  const complianceByType = Object.entries(
    data.complianceRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.flag_type] = (acc[r.flag_type] ?? 0) + 1
      return acc
    }, {})
  ).sort((a, b) => b[1] - a[1])

  const vendorConcentrationBarItems: BarListItem[] = data.vendorRows.slice(0, 12).map((r) => ({
    key: r.vendor_id,
    label: r.display_name,
    value: r.total_amount ?? 0,
    note: r.pct_of_total_spend != null ? `${r.pct_of_total_spend.toFixed(1)}%` : undefined,
  }))

  const familyBarItems: BarListItem[] = data.familyRows
    .filter((r) => r.total_spend > 0)
    .slice(0, 12)
    .map((r) => ({ key: r.item_family_id, label: r.label, value: r.total_spend }))

  const complianceColumns: DataTableColumn<ComplianceRow>[] = [
    { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'type', header: 'Type', render: (r) => humanizeCode(r.flag_type) },
    { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendor_id ? (
          <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.vendor_display_name ?? `#${r.vendor_id}`}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'entry',
      header: 'Entry',
      render: (r) =>
        r.entry_id ? (
          <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
            #{r.entry_id}
          </Link>
        ) : r.related_entry_ids && r.related_entry_ids.length > 0 ? (
          <span className="text-muted-foreground">{r.related_entry_ids.length} entries</span>
        ) : (
          '—'
        ),
    },
    { key: 'department', header: 'Department', render: (r) => r.department_name ?? '—' },
    { key: 'description', header: 'Description', render: (r) => r.description ?? '—' },
    { key: 'detected', header: 'Last Seen', render: (r) => formatDateTime(r.last_detected_at) },
  ]

  const vendorColumns: DataTableColumn<VendorConcentrationRow>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.display_name}
        </Link>
      ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'total', header: 'Total Spend', align: 'right', render: (r) => formatINR(r.total_amount) },
    {
      key: 'pct',
      header: '% of Total Spend',
      align: 'right',
      render: (r) => (r.pct_of_total_spend != null ? `${r.pct_of_total_spend.toFixed(2)}%` : '—'),
    },
    {
      key: 'flags',
      header: 'Open Flags',
      align: 'right',
      render: (r) =>
        r.open_flag_count > 0 ? (
          <Link href={`/analytics#compliance`} className="text-primary underline-offset-2 hover:underline">
            {formatNumber(r.open_flag_count)}
          </Link>
        ) : (
          formatNumber(r.open_flag_count)
        ),
    },
    { key: 'risk', header: '₹ at Risk', align: 'right', render: (r) => formatINR(r.open_flag_amount_at_risk) },
  ]

  const familyColumns: DataTableColumn<SpendByFamilyRow>[] = [
    {
      key: 'family',
      header: 'Item Family',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          {r.label}
          {!r.is_confirmed && (
            <span className="rounded border border-border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              Proposed
            </span>
          )}
        </span>
      ),
    },
    { key: 'unit', header: 'Unit', render: (r) => r.default_unit ?? '—' },
    { key: 'spend', header: 'Total Spend', align: 'right', render: (r) => formatINR(r.total_spend) },
    { key: 'observations', header: 'Observations', align: 'right', render: (r) => formatNumber(r.observation_count) },
    { key: 'vendors', header: 'Vendors', align: 'right', render: (r) => formatNumber(r.vendor_count) },
  ]

  const benchmarkColumns: DataTableColumn<RateBenchmarkRow>[] = [
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

  const benchmarkReliableRows = data.benchmarkRows.filter(
    (r) => r.vendor_count >= RATE_BENCHMARK_MIN_VENDORS && r.observation_count >= RATE_BENCHMARK_MIN_OBSERVATIONS
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Compliance flags, vendor concentration, and item-family rate comparison — refreshed every 15
        minutes by the flags-run sweep. CSV export on every section.
      </p>

      <nav className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border pb-3 text-xs">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="text-muted-foreground hover:text-foreground hover:underline">
            {s.label}
          </a>
        ))}
      </nav>

      <ReportSection
        id="compliance"
        title="Compliance & leakage"
        description="Open flags sorted by severity then ₹ at risk — tax, GSTIN, and statutory findings alongside vendor-pattern findings (splitting, duplicate payment, TDS threshold)."
        action={
          <ExportCsvButton
            filename="compliance-flags.csv"
            rowCount={data.complianceRows.length}
            csv={toCsv(data.complianceRows, [
              { header: 'Type', value: (r) => r.flag_type },
              { header: 'Severity', value: (r) => r.severity },
              { header: '₹ at risk', value: (r) => r.amount_at_risk },
              { header: 'Vendor', value: (r) => r.vendor_display_name },
              { header: 'Entry', value: (r) => r.entry_id },
              { header: 'Department', value: (r) => r.department_name },
              { header: 'Description', value: (r) => r.description },
              { header: 'First Detected', value: (r) => r.created_at },
              { header: 'Last Seen', value: (r) => r.last_detected_at },
            ])}
          />
        }
      >
        {data.errors.compliance ? (
          <EmptyState title="Couldn't load compliance flags" description={data.errors.compliance} />
        ) : data.complianceRows.length === 0 ? (
          <EmptyState
            title="No open compliance flags"
            description="flags-run scans every verified document and vendor payment history every 15 minutes. This is expected to be empty until documents have been reviewed (Day 4 verify) and at least one sweep has run."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-border p-3">
                <p className="text-2xl font-mono font-semibold tracking-tight">{formatNumber(data.complianceRows.length)}</p>
                <p className="mt-1 text-xs text-muted-foreground">open flags</p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-2xl font-mono font-semibold tracking-tight">{formatINRCompact(complianceTotalAtRisk)}</p>
                <p className="mt-1 text-xs text-muted-foreground">total ₹ at risk</p>
              </div>
              {complianceByType.slice(0, 2).map(([type, count]) => (
                <div key={type} className="rounded-md border border-border p-3">
                  <p className="text-2xl font-mono font-semibold tracking-tight">{formatNumber(count)}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{humanizeCode(type)}</p>
                </div>
              ))}
            </div>
            <DataTable columns={complianceColumns} rows={data.complianceRows} getRowKey={(r) => r.id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="vendor-concentration"
        title="Vendor concentration"
        description="Spend, share of total organisational spend, and open-flag exposure per vendor."
        action={
          <ExportCsvButton
            filename="vendor-concentration.csv"
            rowCount={data.vendorRows.length}
            csv={toCsv(data.vendorRows, [
              { header: 'Vendor', value: (r) => r.display_name },
              { header: 'Entries', value: (r) => r.entry_count },
              { header: 'Total Spend', value: (r) => r.total_amount },
              { header: '% of Total Spend', value: (r) => r.pct_of_total_spend },
              { header: 'Open Flags', value: (r) => r.open_flag_count },
              { header: '₹ at Risk', value: (r) => r.open_flag_amount_at_risk },
            ])}
          />
        }
      >
        {data.errors.concentration ? (
          <EmptyState title="Couldn't load vendor concentration" description={data.errors.concentration} />
        ) : data.vendorRows.length === 0 ? (
          <EmptyState title="No vendor spend yet" />
        ) : (
          <>
            <BarList items={vendorConcentrationBarItems} valueFormatter={formatINRCompact} />
            <DataTable columns={vendorColumns} rows={data.vendorRows} getRowKey={(r) => r.vendor_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="spend-by-family"
        title="Spend by item family"
        description="Cross-vendor comparable item groupings (e.g. 'gypsum ceiling', 'pvc boring pipe') — the level rates are actually comparable at, per the two-level item catalog (family → exact spec)."
        action={
          <ExportCsvButton
            filename="spend-by-family.csv"
            rowCount={data.familyRows.length}
            csv={toCsv(data.familyRows, [
              { header: 'Item Family', value: (r) => r.label },
              { header: 'Unit', value: (r) => r.default_unit },
              { header: 'Total Spend', value: (r) => r.total_spend },
              { header: 'Observations', value: (r) => r.observation_count },
              { header: 'Vendors', value: (r) => r.vendor_count },
              { header: 'Confirmed', value: (r) => (r.is_confirmed ? 'yes' : 'no') },
            ])}
          />
        }
      >
        {data.errors.family ? (
          <EmptyState title="Couldn't load spend by family" description={data.errors.family} />
        ) : data.familyRows.length === 0 ? (
          <EmptyState
            title="No item families yet"
            description="The catalog is back-filled from verified line items as documents are reviewed — see /catalog to confirm proposed families."
          />
        ) : (
          <>
            <BarList items={familyBarItems} valueFormatter={formatINRCompact} />
            <DataTable columns={familyColumns} rows={data.familyRows} getRowKey={(r) => r.item_family_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="rate-benchmark"
        title="Rate benchmark"
        description={`Median rate per item family + unit, across vendors. Greyed vendor counts have fewer than ${RATE_BENCHMARK_MIN_VENDORS} vendors or ${RATE_BENCHMARK_MIN_OBSERVATIONS} observations — not yet a reliable benchmark, shown for visibility only.`}
        action={
          <ExportCsvButton
            filename="rate-benchmark.csv"
            rowCount={data.benchmarkRows.length}
            csv={toCsv(data.benchmarkRows, [
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
        {data.errors.benchmark ? (
          <EmptyState title="Couldn't load rate benchmark" description={data.errors.benchmark} />
        ) : data.benchmarkRows.length === 0 ? (
          <EmptyState
            title="Not enough data yet"
            description="Rate comparison needs multiple vendors billing the same item family. The pilot corpus has almost no cross-vendor overlap — this fills in as more documents are verified across more vendors."
          />
        ) : (
          <>
            {benchmarkReliableRows.length === 0 && (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                No family/unit pair yet has {RATE_BENCHMARK_MIN_VENDORS}+ vendors and {RATE_BENCHMARK_MIN_OBSERVATIONS}+
                observations — every row below is directional only.
              </p>
            )}
            <DataTable
              columns={benchmarkColumns}
              rows={data.benchmarkRows}
              getRowKey={(r) => `${r.item_family_id}-${r.unit_normalized ?? 'none'}`}
            />
          </>
        )}
      </ReportSection>
    </div>
  )
}
