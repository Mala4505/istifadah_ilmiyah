import Link from 'next/link'
import { CheckCircle2, GitCompareArrows } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { ReportSection } from '@/components/reports/report-section'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { EmptyState } from '@/components/reports/empty-state'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { toCsv } from '@/lib/reports/csv'
import { SeverityBadge } from '@/components/reports/severity-badge'
import { formatDate, formatINR } from '@/lib/reports/format'

// Screen 9 — Reconciliation (MASTER-PLAN §5, day 6). "The report the org
// currently produces by hand." Reads from v_department_audit_variance
// (§10.2, renamed 2026-08-11 from v_tenant_main_variance — there is no
// separate second amount anymore, so this view is deliberately simplified
// to "missing a Main/Audit-side match" rather than an amount-mismatch
// comparison; see the view's own header comment) for the unmatched-entries
// logic; reconciliation_exception for the allocation queue if the importer
// has written it, falling back to a direct comparison against
// v_budget_vs_actual's already-computed columns otherwise.
export const dynamic = 'force-dynamic'

type VarianceRow = {
  entry_id: number
  ubbl_number: string
  main_number: string | null
  department_id: number | null
  budget_head_id: number | null
  vendor_id: number | null
  date: string | null
  amount: number | null
  variance_reason: string | null
  variance_type: 'main_number_missing'
}

type DepartmentRow = { id: number; name: string }
type VendorRow = { id: number; display_name: string }
type BudgetHeadRow = { id: number; raw_label: string; short_label: string | null }

type AllocationExceptionRow = {
  id: number
  entry_id: number | null
  exception_type: string
  severity: string
  amount_at_risk: number | null
  description: string | null
  status: string
  created_at: string
}

type BudgetVsActualRow = {
  budget_head_id: number
  raw_label: string
  short_label: string | null
  utilised_amount: number | null
  actual_amount: number | null
  entry_count: number
}

const VARIANCE_TOLERANCE = 1 // ₹1 — matches the review queue's tolerance (§7)

async function loadReconciliationData() {
  const supabase = await createClient()

  const [varianceRes, deptRes, vendorRes, budgetHeadRes, exceptionRes, budgetVsActualRes] =
    await Promise.all([
      supabase
        .from('v_department_audit_variance')
        .select(
          'entry_id, ubbl_number, main_number, department_id, budget_head_id, vendor_id, date, amount, variance_reason, variance_type'
        )
        .order('date', { ascending: false, nullsFirst: false })
        .limit(1000)
        .returns<VarianceRow[]>(),
      supabase.from('department').select('id, name').returns<DepartmentRow[]>(),
      supabase.from('vendor').select('id, display_name').returns<VendorRow[]>(),
      supabase.from('budget_head').select('id, raw_label, short_label').returns<BudgetHeadRow[]>(),
      supabase
        .from('reconciliation_exception')
        .select('id, entry_id, exception_type, severity, amount_at_risk, description, status, created_at')
        .eq('status', 'open')
        .eq('exception_type', 'allocation_sum_mismatch')
        .order('amount_at_risk', { ascending: false, nullsFirst: false })
        .returns<AllocationExceptionRow[]>(),
      supabase
        .from('v_budget_vs_actual')
        .select('budget_head_id, raw_label, short_label, utilised_amount, actual_amount, entry_count')
        .returns<BudgetVsActualRow[]>(),
    ])

  const unmatched = varianceRes.data ?? []

  const exceptionRows = exceptionRes.data ?? []
  const allocationSource: 'exceptions' | 'computed' = exceptionRows.length > 0 ? 'exceptions' : 'computed'
  const computedAllocationMismatches = (budgetVsActualRes.data ?? []).filter((r) => {
    if (r.utilised_amount === null) return false
    const actual = r.actual_amount ?? 0
    return Math.abs(actual - r.utilised_amount) > VARIANCE_TOLERANCE
  })

  return {
    unmatched,
    deptMap: new Map((deptRes.data ?? []).map((d) => [d.id, d.name])),
    vendorMap: new Map((vendorRes.data ?? []).map((v) => [v.id, v.display_name])),
    budgetHeadMap: new Map((budgetHeadRes.data ?? []).map((b) => [b.id, b.short_label ?? b.raw_label])),
    allocationSource,
    exceptionRows,
    computedAllocationMismatches,
    errors: {
      variance: varianceRes.error?.message ?? null,
      exceptions: exceptionRes.error?.message ?? null,
      budgetVsActual: budgetVsActualRes.error?.message ?? null,
    },
  }
}

export default async function ReconciliationPage() {
  const data = await loadReconciliationData()

  const unmatchedColumns: DataTableColumn<VarianceRow>[] = [
    {
      key: 'ubbl',
      header: 'UBBL Number',
      render: (r) => (
        <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
          {r.ubbl_number}
        </Link>
      ),
    },
    { key: 'dept', header: 'Department', render: (r) => (r.department_id ? data.deptMap.get(r.department_id) ?? '—' : '—') },
    { key: 'vendor', header: 'Vendor', render: (r) => (r.vendor_id ? data.vendorMap.get(r.vendor_id) ?? `#${r.vendor_id}` : '—') },
    { key: 'date', header: 'Date', render: (r) => formatDate(r.date) },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.amount) },
  ]

  const exceptionColumns: DataTableColumn<AllocationExceptionRow>[] = [
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
    { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'amount', header: '₹ at risk', align: 'right', render: (r) => formatINR(r.amount_at_risk) },
    { key: 'description', header: 'Description', render: (r) => r.description ?? '—' },
    { key: 'created', header: 'Raised', render: (r) => formatDate(r.created_at) },
  ]

  const computedColumns: DataTableColumn<BudgetVsActualRow>[] = [
    { key: 'head', header: 'Budget Head', render: (r) => r.short_label ?? r.raw_label },
    { key: 'utilised', header: 'Utilised (source)', align: 'right', render: (r) => formatINR(r.utilised_amount) },
    { key: 'actual', header: 'Sum of amounts', align: 'right', render: (r) => formatINR(r.actual_amount) },
    {
      key: 'diff',
      header: 'Difference',
      align: 'right',
      render: (r) => (
        <span className="text-destructive">{formatINR((r.actual_amount ?? 0) - (r.utilised_amount ?? 0))}</span>
      ),
    },
    { key: 'entries', header: 'Entries', align: 'right', render: (r) => String(r.entry_count) },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Reconciliation</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          Phase 1A · Day 6
        </span>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Entries missing a Main/Audit-side match, and allocation-sum mismatches — the report the org
        currently produces by hand.
      </p>

      <ReportSection
        title="Missing a Main/Audit-side match"
        description="Entries with no Main Entry Number recorded yet — nothing to compare against on the Audit side."
        action={
          <ExportCsvButton
            filename="reconciliation-unmatched.csv"
            rowCount={data.unmatched.length}
            csv={toCsv(data.unmatched, [
              { header: 'UBBL Number', value: (r) => r.ubbl_number },
              { header: 'Department', value: (r) => (r.department_id ? data.deptMap.get(r.department_id) : '') },
              { header: 'Vendor', value: (r) => (r.vendor_id ? data.vendorMap.get(r.vendor_id) : '') },
              { header: 'Date', value: (r) => r.date },
              { header: 'Amount', value: (r) => r.amount },
            ])}
          />
        }
      >
        {data.errors.variance ? (
          <EmptyState title="Couldn't load variance data" description={data.errors.variance} />
        ) : data.unmatched.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="Every entry has a Main-side match"
            description="No entries missing a Main Entry Number across the entries this account can see."
          />
        ) : (
          <DataTable
            columns={unmatchedColumns}
            rows={data.unmatched}
            getRowKey={(r) => r.entry_id}
            emptyTitle="Nothing unmatched"
            emptyDescription="Every entry this account can see has a Main-side match."
          />
        )}
      </ReportSection>

      <ReportSection
        title="Allocation-sum mismatches"
        description={
          data.allocationSource === 'exceptions'
            ? 'Open reconciliation_exception rows of type allocation_sum_mismatch — raised by the importer.'
            : 'No open exception rows yet — computed directly by comparing v_budget_vs_actual\'s reported utilised amount against the sum of amounts per head.'
        }
        action={
          data.allocationSource === 'exceptions' ? (
            <ExportCsvButton
              filename="reconciliation-allocation-mismatches.csv"
              rowCount={data.exceptionRows.length}
              csv={toCsv(data.exceptionRows, [
                { header: 'Entry', value: (r) => r.entry_id },
                { header: 'Severity', value: (r) => r.severity },
                { header: '₹ at risk', value: (r) => r.amount_at_risk },
                { header: 'Description', value: (r) => r.description },
                { header: 'Raised', value: (r) => r.created_at },
              ])}
            />
          ) : (
            <ExportCsvButton
              filename="reconciliation-allocation-mismatches.csv"
              rowCount={data.computedAllocationMismatches.length}
              csv={toCsv(data.computedAllocationMismatches, [
                { header: 'Budget Head', value: (r) => r.short_label ?? r.raw_label },
                { header: 'Utilised (source)', value: (r) => r.utilised_amount },
                { header: 'Sum of amounts', value: (r) => r.actual_amount },
                { header: 'Difference', value: (r) => (r.actual_amount ?? 0) - (r.utilised_amount ?? 0) },
                { header: 'Entries', value: (r) => r.entry_count },
              ])}
            />
          )
        }
      >
        {data.allocationSource === 'exceptions' ? (
          <DataTable
            columns={exceptionColumns}
            rows={data.exceptionRows}
            getRowKey={(r) => r.id}
            emptyTitle="No open allocation exceptions"
          />
        ) : (
          <DataTable
            columns={computedColumns}
            rows={data.computedAllocationMismatches}
            getRowKey={(r) => r.budget_head_id}
            emptyTitle="Every head's utilised amount matches its entries"
            emptyDescription={`No difference greater than ₹${VARIANCE_TOLERANCE} between the source-reported utilised amount and the sum of amounts.`}
          />
        )}
      </ReportSection>

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <GitCompareArrows className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p>
          Reads from <code className="font-mono">v_department_audit_variance</code>,{' '}
          <code className="font-mono">reconciliation_exception</code>, and{' '}
          <code className="font-mono">v_budget_vs_actual</code> (§10.2) — RLS-scoped per signed-in user,
          same as every other screen.
        </p>
      </div>
    </div>
  )
}
