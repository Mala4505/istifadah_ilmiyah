import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { ReportSection } from '@/components/reports/report-section'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { BarList, type BarListItem } from '@/components/reports/bar-list'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { toCsv } from '@/lib/reports/csv'
import { SeverityBadge, AgeBucketBadge } from '@/components/reports/severity-badge'
import { EmptyState } from '@/components/reports/empty-state'
import {
  formatDate,
  formatDateTime,
  formatINR,
  formatINRCompact,
  formatNumber,
  formatPercent,
  humanizeCode,
} from '@/lib/reports/format'

// Screen 10 — Reports (MASTER-PLAN §5, day 6). Every section reads from a
// §10.2 reporting view and carries its own CSV export. Charts are plain
// CSS bar lists (dataviz skill's no-dependency option) rather than a new
// charting library — the data here is "rank N things by ₹", which a bar
// list communicates as well as a bar chart would.
export const dynamic = 'force-dynamic'

const ROW_CAP = 1000 // safety cap on entry-level views at 1k-10k entry volume (§0)

type BudgetVsActualRow = {
  budget_head_id: number
  raw_label: string
  short_label: string | null
  department_id: number | null
  approved_amount: number | null
  utilised_amount: number | null
  balance_amount: number | null
  actual_amount: number | null
  entry_count: number
  pct_of_approved: number | null
  budget_status_note: string | null
}

type VendorSpendRow = {
  vendor_id: number
  display_name: string
  entry_count: number
  total_amount: number | null
  first_entry_date: string | null
  last_entry_date: string | null
  entries_with_documents: number
  document_coverage_pct: number | null
}

type ZoneSpendRow = {
  zone_id: number | null
  zone_name: string
  zone_number: number | null
  department_id: number | null
  entry_count: number
  total_amount: number | null
}

type HubAgeingRow = {
  entry_id: number
  department_id: number | null
  ubbl_number: string
  hub_status_code: string
  hub_status_label: string
  hub_status_changed_at: string | null
  days_in_status: number
  age_bucket: '0-2' | '3-7' | '8+'
}

type OpenIssueRow = {
  source_table: string
  id: number
  entry_id: number | null
  issue_type: string
  severity: string
  amount_at_risk: number | null
  description: string | null
  status: string
  created_at: string
}

async function loadReportsData() {
  const supabase = await createClient()

  const [budgetRes, vendorRes, zoneRes, ageingRes, issuesRes] = await Promise.all([
    supabase
      .from('v_budget_vs_actual')
      .select(
        'budget_head_id, raw_label, short_label, department_id, approved_amount, utilised_amount, balance_amount, actual_amount, entry_count, pct_of_approved, budget_status_note'
      )
      .order('actual_amount', { ascending: false, nullsFirst: false })
      .returns<BudgetVsActualRow[]>(),
    supabase
      .from('v_vendor_spend')
      .select(
        'vendor_id, display_name, entry_count, total_amount, first_entry_date, last_entry_date, entries_with_documents, document_coverage_pct'
      )
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorSpendRow[]>(),
    supabase
      .from('v_zone_spend')
      .select('zone_id, zone_name, zone_number, department_id, entry_count, total_amount')
      .order('total_amount', { ascending: false, nullsFirst: false })
      .returns<ZoneSpendRow[]>(),
    supabase
      .from('v_hub_status_ageing')
      .select('entry_id, department_id, ubbl_number, hub_status_code, hub_status_label, hub_status_changed_at, days_in_status, age_bucket')
      .order('days_in_status', { ascending: false })
      .limit(ROW_CAP)
      .returns<HubAgeingRow[]>(),
    supabase
      .from('v_open_issues')
      .select('source_table, id, entry_id, issue_type, severity, amount_at_risk, description, status, created_at')
      .limit(ROW_CAP)
      .returns<OpenIssueRow[]>(),
  ])

  const vendorRows = (vendorRes.data ?? []).filter((r) => r.entry_count > 0)
  const ageingRows = ageingRes.data ?? []

  return {
    budgetRows: budgetRes.data ?? [],
    vendorRows,
    zoneRows: zoneRes.data ?? [],
    ageingRows,
    ageingBuckets: {
      '0-2': ageingRows.filter((r) => r.age_bucket === '0-2').length,
      '3-7': ageingRows.filter((r) => r.age_bucket === '3-7').length,
      '8+': ageingRows.filter((r) => r.age_bucket === '8+').length,
    },
    issueRows: issuesRes.data ?? [],
    errors: {
      budget: budgetRes.error?.message ?? null,
      vendor: vendorRes.error?.message ?? null,
      zone: zoneRes.error?.message ?? null,
      ageing: ageingRes.error?.message ?? null,
      issues: issuesRes.error?.message ?? null,
    },
  }
}

const SECTIONS = [
  { id: 'budget-vs-actual', label: 'Budget vs Actual' },
  { id: 'vendor-spend', label: 'Vendor Spend' },
  { id: 'zone-spend', label: 'Spend by Zone' },
  { id: 'hub-status-ageing', label: 'Hub-status Ageing' },
  { id: 'open-issues', label: 'Open Issues' },
] as const

export default async function ReportsPage() {
  const data = await loadReportsData()

  const budgetBarItems: BarListItem[] = data.budgetRows
    .filter((r) => (r.actual_amount ?? 0) > 0)
    .slice(0, 12)
    .map((r) => ({
      key: r.budget_head_id,
      label: r.short_label ?? r.raw_label,
      value: r.actual_amount ?? 0,
      marker: r.approved_amount && r.approved_amount > 0 ? r.approved_amount : null,
      markerLabel: r.approved_amount ? `Approved: ${formatINR(r.approved_amount)}` : undefined,
      note: r.budget_status_note ?? undefined,
    }))

  const vendorBarItems: BarListItem[] = data.vendorRows.slice(0, 12).map((r) => ({
    key: r.vendor_id,
    label: r.display_name,
    value: r.total_amount ?? 0,
  }))

  const zoneBarItems: BarListItem[] = data.zoneRows
    .filter((r) => (r.total_amount ?? 0) > 0)
    .map((r) => ({
      key: r.zone_id ?? 'unassigned',
      label: r.zone_name,
      value: r.total_amount ?? 0,
    }))

  const budgetColumns: DataTableColumn<BudgetVsActualRow>[] = [
    { key: 'head', header: 'Budget Head', render: (r) => r.short_label ?? r.raw_label },
    { key: 'approved', header: 'Approved', align: 'right', render: (r) => formatINR(r.approved_amount) },
    { key: 'utilised', header: 'Utilised (source)', align: 'right', render: (r) => formatINR(r.utilised_amount) },
    { key: 'actual', header: 'Actual (sum of amounts)', align: 'right', render: (r) => formatINR(r.actual_amount) },
    { key: 'balance', header: 'Balance', align: 'right', render: (r) => formatINR(r.balance_amount) },
    {
      key: 'pct',
      header: '% of Approved',
      align: 'right',
      render: (r) =>
        r.budget_status_note ? (
          <span className="text-muted-foreground">{r.budget_status_note}</span>
        ) : (
          formatPercent(r.pct_of_approved)
        ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
  ]

  const vendorColumns: DataTableColumn<VendorSpendRow>[] = [
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
    { key: 'total', header: 'Total Amount', align: 'right', render: (r) => formatINR(r.total_amount) },
    { key: 'first', header: 'First Entry', render: (r) => formatDate(r.first_entry_date) },
    { key: 'last', header: 'Last Entry', render: (r) => formatDate(r.last_entry_date) },
    { key: 'coverage', header: 'Doc Coverage', align: 'right', render: (r) => formatPercent(r.document_coverage_pct) },
  ]

  const zoneColumns: DataTableColumn<ZoneSpendRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => (
        <Link
          href={r.zone_id ? `/entries?zone_id=${r.zone_id}` : '/entries?zone_id=none'}
          className="text-primary underline-offset-2 hover:underline"
        >
          {r.zone_name}
        </Link>
      ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => formatNumber(r.entry_count) },
    { key: 'total', header: 'Total Amount', align: 'right', render: (r) => formatINR(r.total_amount) },
  ]

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

  const issueColumns: DataTableColumn<OpenIssueRow>[] = [
    { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'type', header: 'Type', render: (r) => humanizeCode(r.issue_type) },
    { key: 'source', header: 'Source', render: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
    { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
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
    { key: 'description', header: 'Description', render: (r) => r.description ?? '—' },
    { key: 'created', header: 'Raised', render: (r) => formatDate(r.created_at) },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Budget vs actual by head, vendor spend, spend by zone, Hub-status ageing, and the open-issues
        digest. CSV export on every section.
      </p>

      <nav className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border pb-3 text-xs">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="text-muted-foreground hover:text-foreground hover:underline">
            {s.label}
          </a>
        ))}
      </nav>

      <ReportSection
        id="budget-vs-actual"
        title="Budget vs actual by head"
        description={
          data.budgetRows.some((r) => r.budget_status_note)
            ? 'Heads with no approved budget show "no approved budget" instead of a −100% figure (§3.5).'
            : 'Latest allocation snapshot against the sum of amounts per head.'
        }
        action={
          <ExportCsvButton
            filename="budget-vs-actual.csv"
            rowCount={data.budgetRows.length}
            csv={toCsv(data.budgetRows, [
              { header: 'Budget Head', value: (r) => r.short_label ?? r.raw_label },
              { header: 'Approved Amount', value: (r) => r.approved_amount },
              { header: 'Utilised Amount (source)', value: (r) => r.utilised_amount },
              { header: 'Actual (sum of amounts)', value: (r) => r.actual_amount },
              { header: 'Balance', value: (r) => r.balance_amount },
              { header: '% of Approved', value: (r) => r.pct_of_approved },
              { header: 'Note', value: (r) => r.budget_status_note },
              { header: 'Entries', value: (r) => r.entry_count },
            ])}
          />
        }
      >
        {data.errors.budget ? (
          <EmptyState title="Couldn't load budget data" description={data.errors.budget} />
        ) : data.budgetRows.length === 0 ? (
          <EmptyState title="No budget heads yet" description="Budget heads arrive via import." />
        ) : (
          <>
            <BarList items={budgetBarItems} valueFormatter={formatINRCompact} />
            <DataTable columns={budgetColumns} rows={data.budgetRows} getRowKey={(r) => r.budget_head_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="vendor-spend"
        title="Vendor spend"
        description="Entry count, total spend, and document coverage per vendor."
        action={
          <ExportCsvButton
            filename="vendor-spend.csv"
            rowCount={data.vendorRows.length}
            csv={toCsv(data.vendorRows, [
              { header: 'Vendor', value: (r) => r.display_name },
              { header: 'Entries', value: (r) => r.entry_count },
              { header: 'Total Amount', value: (r) => r.total_amount },
              { header: 'First Entry Date', value: (r) => r.first_entry_date },
              { header: 'Last Entry Date', value: (r) => r.last_entry_date },
              { header: 'Document Coverage %', value: (r) => r.document_coverage_pct },
            ])}
          />
        }
      >
        {data.errors.vendor ? (
          <EmptyState title="Couldn't load vendor spend" description={data.errors.vendor} />
        ) : data.vendorRows.length === 0 ? (
          <EmptyState title="No vendor spend yet" description="Vendors are created automatically as entries import." />
        ) : (
          <>
            <BarList items={vendorBarItems} valueFormatter={formatINRCompact} />
            <DataTable columns={vendorColumns} rows={data.vendorRows} getRowKey={(r) => r.vendor_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="zone-spend"
        title="Spend by zone"
        description="Null zone is reported as 'unassigned' so gaps in enrichment stay visible."
        action={
          <ExportCsvButton
            filename="zone-spend.csv"
            rowCount={data.zoneRows.length}
            csv={toCsv(data.zoneRows, [
              { header: 'Zone', value: (r) => r.zone_name },
              { header: 'Entries', value: (r) => r.entry_count },
              { header: 'Total Amount', value: (r) => r.total_amount },
            ])}
          />
        }
      >
        {data.errors.zone ? (
          <EmptyState title="Couldn't load zone spend" description={data.errors.zone} />
        ) : data.zoneRows.length === 0 ? (
          <EmptyState title="No zone spend yet" />
        ) : (
          <>
            <BarList items={zoneBarItems} valueFormatter={formatINRCompact} />
            <DataTable columns={zoneColumns} rows={data.zoneRows} getRowKey={(r) => r.zone_id ?? 'unassigned'} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="hub-status-ageing"
        title="Hub-status ageing"
        description="Days each entry has sat in Awaiting Verification / Awaiting Validation — what the modules are waiting on."
        action={
          <ExportCsvButton
            filename="hub-status-ageing.csv"
            rowCount={data.ageingRows.length}
            csv={toCsv(data.ageingRows, [
              { header: 'UBBL Number', value: (r) => r.ubbl_number },
              { header: 'Hub Status', value: (r) => r.hub_status_label },
              { header: 'Days in Status', value: (r) => r.days_in_status },
              { header: 'Age Bucket', value: (r) => r.age_bucket },
              { header: 'Changed At', value: (r) => r.hub_status_changed_at },
            ])}
          />
        }
      >
        {data.errors.ageing ? (
          <EmptyState title="Couldn't load Hub-status ageing" description={data.errors.ageing} />
        ) : data.ageingRows.length === 0 ? (
          <EmptyState
            title="Nothing awaiting verification or validation"
            description="Entries appear here once a Hub status is set from the review queue or entry detail screen."
          />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {(['0-2', '3-7', '8+'] as const).map((bucket) => (
                <div key={bucket} className="rounded-md border border-border p-3">
                  <p className="text-2xl font-mono font-semibold tracking-tight">
                    {formatNumber(data.ageingBuckets[bucket])}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{bucket} days</p>
                </div>
              ))}
            </div>
            <DataTable columns={ageingColumns} rows={data.ageingRows} getRowKey={(r) => r.entry_id} />
          </>
        )}
      </ReportSection>

      <ReportSection
        id="open-issues"
        title="Open issues digest"
        description="Reconciliation exceptions and flags, sorted by severity then ₹ at risk."
        action={
          <ExportCsvButton
            filename="open-issues.csv"
            rowCount={data.issueRows.length}
            csv={toCsv(data.issueRows, [
              { header: 'Source', value: (r) => (r.source_table === 'flags' ? 'Flag' : 'Exception') },
              { header: 'Type', value: (r) => r.issue_type },
              { header: 'Severity', value: (r) => r.severity },
              { header: '₹ at risk', value: (r) => r.amount_at_risk },
              { header: 'Entry', value: (r) => r.entry_id },
              { header: 'Description', value: (r) => r.description },
              { header: 'Raised', value: (r) => r.created_at },
            ])}
          />
        }
      >
        {data.errors.issues ? (
          <EmptyState title="Couldn't load open issues" description={data.errors.issues} />
        ) : (
          <DataTable
            columns={issueColumns}
            rows={data.issueRows}
            getRowKey={(r) => `${r.source_table}-${r.id}`}
            emptyTitle="No open issues"
            emptyDescription="Nothing in reconciliation_exception or flags is currently open."
          />
        )}
      </ReportSection>
    </div>
  )
}
