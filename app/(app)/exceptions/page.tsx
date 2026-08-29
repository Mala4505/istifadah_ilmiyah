import Link from 'next/link'
import { CheckCircle2, GitCompareArrows } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Card, CardContent } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { friendlyDataError } from '@/lib/friendly-error'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { getSelectedEventId } from '@/lib/events/current'
import { ExceptionsFilters } from '@/components/exceptions/exceptions-filters'
import { ExceptionsTable, type ExceptionRow } from '@/components/exceptions/exceptions-table'
import { ExceptionsPagination } from '@/components/exceptions/exceptions-pagination'
import { SeverityCountChips } from '@/components/exceptions/severity-count-chips'
import { SeverityLegend } from '@/components/exceptions/severity-legend'
import { PAGE_SIZE_OPTIONS } from '@/components/ui/pagination-bar'
import { parseQueueSort, sortQueue } from '@/components/exceptions/queue-sort'
import { SEVERITY_VALUES } from '@/components/exceptions/labels'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ReportSection } from '@/components/reports/report-section'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { EmptyState as ReportEmptyState } from '@/components/reports/empty-state'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { toCsv } from '@/lib/reports/csv'
import { SeverityBadge } from '@/components/reports/severity-badge'
import { formatDate, formatINR } from '@/lib/reports/format'

// Screen 9 / /exceptions merge (nav-simplification plan). This page now
// hosts both the exceptions work queue (filter, resolve/dismiss — via
// lib/actions/exceptions.ts) and the read-only reconciliation report that
// used to live at /reconciliation ("the report the org currently produces
// by hand"), split across two tabs since ExceptionsTable is a queue-specific,
// severity-grouped table that wasn't built to also host report-shaped data.
export const dynamic = 'force-dynamic'

type RawExceptionRow = ExceptionRow & {
  document_extraction_id: number | null
  import_batch_id: number | null
  source_document_id: number | null
}

/** The id fields resolveEventIds actually reads — lets the lightweight
 *  severity-count query pass a narrower row shape. */
type EventScopableRow = {
  id: number
  entry_id: number | null
  document_extraction_id: number | null
  import_batch_id: number | null
  source_document_id: number | null
}

function uniqueIds(ids: (number | null)[]): number[] {
  return Array.from(new Set(ids.filter((id): id is number => id !== null)))
}

/**
 * Resolves each exception's event the same way v_open_issues does
 * (20260814000007's coalesce chain, extended by 20260822000010 §0.3):
 * entries.event_id via entry_id, else source_document.event_id via
 * document_extraction_id, else import_batch.event_id via import_batch_id,
 * else source_document.event_id via source_document_id directly. Rows that
 * still resolve to no event are KEPT, not dropped (§0.1 — the previous
 * `entry_id !== null && eventEntryIds.has(entry_id)` filter dropped every
 * row without an entry_id, which was 33 of 34 open exceptions).
 */
async function resolveEventIds(
  supabase: SupabaseClient,
  rows: EventScopableRow[]
): Promise<Map<number, number | null>> {
  const entryIds = uniqueIds(rows.map((r) => r.entry_id))
  const docExtractionIds = uniqueIds(rows.map((r) => r.document_extraction_id))
  const importBatchIds = uniqueIds(rows.map((r) => r.import_batch_id))
  const directSourceDocIds = uniqueIds(rows.map((r) => r.source_document_id))

  const [entryRes, docExtractionRes, importBatchRes] = await Promise.all([
    entryIds.length > 0
      ? supabase.from('entries').select('id, event_id').in('id', entryIds)
      : Promise.resolve({ data: [] as { id: number; event_id: number }[] }),
    docExtractionIds.length > 0
      ? supabase.from('document_extraction').select('id, source_document_id').in('id', docExtractionIds)
      : Promise.resolve({ data: [] as { id: number; source_document_id: number }[] }),
    importBatchIds.length > 0
      ? supabase.from('import_batch').select('id, event_id').in('id', importBatchIds)
      : Promise.resolve({ data: [] as { id: number; event_id: number }[] }),
  ])

  const entryEventMap = new Map((entryRes.data ?? []).map((r) => [r.id as number, r.event_id as number]))
  const docExtractionSourceDocMap = new Map(
    (docExtractionRes.data ?? []).map((r) => [r.id as number, r.source_document_id as number])
  )
  const importBatchEventMap = new Map((importBatchRes.data ?? []).map((r) => [r.id as number, r.event_id as number]))

  const sourceDocIdsNeeded = uniqueIds([...directSourceDocIds, ...Array.from(docExtractionSourceDocMap.values())])
  const { data: sourceDocRows } =
    sourceDocIdsNeeded.length > 0
      ? await supabase.from('source_document').select('id, event_id').in('id', sourceDocIdsNeeded)
      : { data: [] as { id: number; event_id: number }[] }
  const sourceDocEventMap = new Map((sourceDocRows ?? []).map((r) => [r.id as number, r.event_id as number]))

  const resolved = new Map<number, number | null>()
  for (const r of rows) {
    const viaEntry = r.entry_id !== null ? entryEventMap.get(r.entry_id) : undefined
    const viaDocExtraction =
      r.document_extraction_id !== null
        ? sourceDocEventMap.get(docExtractionSourceDocMap.get(r.document_extraction_id) ?? -1)
        : undefined
    const viaImportBatch = r.import_batch_id !== null ? importBatchEventMap.get(r.import_batch_id) : undefined
    const viaSourceDocument = r.source_document_id !== null ? sourceDocEventMap.get(r.source_document_id) : undefined
    resolved.set(r.id, viaEntry ?? viaDocExtraction ?? viaImportBatch ?? viaSourceDocument ?? null)
  }
  return resolved
}

// Item 1.2 (hub-screen-certification.md §3): the per-severity fetch cap the
// server-side ordering below is built from. §3.1: default page size 50,
// selectable from PAGE_SIZE_OPTIONS, `page`/`size` in the URL.
const QUEUE_DEFAULT_PAGE_SIZE = 50
const QUEUE_SEVERITY_BUCKET_CAP = 1000
const QUEUE_COUNT_CAP = 5000
const SEVERITY_PRIORITY = ['high', 'medium', 'low'] as const

function parsePageSize(raw: string | undefined): number {
  const n = Number(raw)
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : QUEUE_DEFAULT_PAGE_SIZE
}

function parsePageNumber(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/**
 * High / Medium / Low counts among *open* exceptions (§3.7), event-scoped the
 * same way the queue is. Independent of the queue's status/type/severity
 * filters on purpose — the chips are a fixed reference the filter can be set
 * from, not a reflection of it. Minimal column set (ids + severity only).
 */
async function loadOpenSeverityCounts(): Promise<Record<string, number>> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('reconciliation_exception')
    .select('id, severity, entry_id, document_extraction_id, import_batch_id, source_document_id')
    .eq('status', 'open')
    .range(0, QUEUE_COUNT_CAP - 1)

  const rows = (data ?? []) as (EventScopableRow & { severity: string })[]
  const counts: Record<string, number> = { high: 0, medium: 0, low: 0 }
  if (rows.length === 0) return counts

  const selectedEventId = await getSelectedEventId(supabase)
  let scoped = rows
  if (selectedEventId !== null) {
    const eventIdByRow = await resolveEventIds(supabase, rows)
    scoped = rows.filter((r) => {
      const resolved = eventIdByRow.get(r.id)
      return resolved === null || resolved === undefined || resolved === selectedEventId
    })
  }
  for (const r of scoped) counts[r.severity] = (counts[r.severity] ?? 0) + 1
  return counts
}

/**
 * Queue tab (MASTER-PLAN §3.10, §5 row 8, §11.1 Day 5). Sorted by
 * severity then ₹ at risk descending, filterable by exception_type and by
 * status (open by default — resolved/dismissed stay visible as the audit
 * trail, per §3.10's resolution_note/resolved_by/resolved_at columns).
 *
 * Any active staff can view (reconciliation_exception_select RLS requires
 * only is_staff()); resolving requires admin or above (§4.4c,
 * 20260819000003 — dept lost this), enforced both by hiding the action here
 * and by RLS in lib/actions/exceptions.ts.
 *
 * Event-scoping (§0.1/§0.2): reconciliation_exception carries no event_id
 * column of its own, so the fetched rows are filtered down in application
 * code via resolveEventIds above — the same coalesce chain v_open_issues
 * uses. Rows with no resolvable event stay visible regardless of the active
 * event, matching the view and matching Dashboard/Reports (§0.2 — all three
 * surfaces must agree on the same open-exception count).
 *
 * Item 1.2: the severity/amount sort used to happen client-side, after an
 * unordered, uncapped fetch — so whatever PostgREST's default row cap
 * dropped was arbitrary with respect to severity. The sort is now done
 * server-side instead. `severity` is plain text (CHECK-constrained to
 * low/medium/high, not an enum), so a single `.order('severity')` would sort
 * alphabetically ("high", "low", "medium") rather than by rank — so each
 * severity is fetched as its own `.order()`ed, `.range()`-capped bucket, and
 * the buckets are concatenated in priority order. That guarantees the
 * highest-severity rows always land first; if a single bucket ever exceeded
 * QUEUE_SEVERITY_BUCKET_CAP rows, the truncation would be confined to the
 * lowest-priority bucket instead of being arbitrary. `amount_at_risk` (nulls
 * last), then `created_at`, then `id` break ties within a bucket, the same
 * tiebreaker discipline 1.1 added to the review queue. Because event-scoping
 * can only be resolved after the rows are fetched (see resolveEventIds
 * above), the "true total" for the header is the post-event-scoping row
 * count rather than a DB-side `count`.
 */
async function loadQueueData(params: {
  status: string
  type: string
  severity: string
  page: number
  size: number
  sort: ReturnType<typeof parseQueueSort>['column']
  dir: ReturnType<typeof parseQueueSort>['direction']
}) {
  const supabase = await createClient()

  function baseQuery() {
    let q = supabase
      .from('reconciliation_exception')
      .select(
        'id, entry_id, document_extraction_id, import_batch_id, source_document_id, exception_type, severity, amount_at_risk, description, status, resolution_note, resolved_at, created_at'
      )
    if (params.status !== 'all') {
      q = q.eq('status', params.status)
    }
    if (params.type !== 'all') {
      q = q.eq('exception_type', params.type)
    }
    return q
  }

  // §3.4: a severity filter narrows the fetch to a single bucket.
  const severitiesToFetch =
    params.severity === 'all'
      ? SEVERITY_PRIORITY
      : SEVERITY_PRIORITY.filter((s) => s === params.severity)

  const bucketResults = await Promise.all(
    severitiesToFetch.map((severity) =>
      baseQuery()
        .eq('severity', severity)
        .order('amount_at_risk', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(0, QUEUE_SEVERITY_BUCKET_CAP - 1)
    )
  )

  const bucketError = bucketResults.find((r) => r.error)?.error ?? null
  const rawExceptions = bucketResults.flatMap((r) => r.data ?? []) as RawExceptionRow[]

  const selectedEventId = await getSelectedEventId(supabase)

  let exceptions: RawExceptionRow[] = rawExceptions
  if (selectedEventId !== null && rawExceptions.length > 0) {
    const eventIdByRow = await resolveEventIds(supabase, rawExceptions)
    exceptions = rawExceptions.filter((r) => {
      const resolved = eventIdByRow.get(r.id)
      return resolved === null || resolved === undefined || resolved === selectedEventId
    })
  }

  // §3.2: the user-chosen sort is applied here, after event-scoping, over the
  // assembled list. Severity rank is the default; every branch is
  // id-tiebroken so repeat loads are stable.
  const sorted = sortQueue(exceptions, params.sort, params.dir)

  const totalCount = sorted.length
  const maxPage = Math.max(1, Math.ceil(totalCount / params.size))
  const page = Math.min(params.page, maxPage)
  const start = (page - 1) * params.size
  const pageRows = sorted.slice(start, start + params.size)

  return {
    exceptions: pageRows,
    totalCount,
    page,
    rangeStart: totalCount === 0 ? 0 : start + 1,
    rangeEnd: start + pageRows.length,
    error: bucketError,
  }
}

// Reconciliation-report tab. Reads from v_department_audit_variance (§10.2,
// renamed 2026-08-11 from v_tenant_main_variance — there is no separate
// second amount anymore, so this view is deliberately simplified to
// "missing a Main/Audit-side match" rather than an amount-mismatch
// comparison; see the view's own header comment) for the unmatched-entries
// logic; reconciliation_exception for the allocation queue if the importer
// has written it, falling back to a direct comparison against
// v_budget_vs_actual's already-computed columns otherwise.

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

async function loadReconciliationReportData() {
  const supabase = await createClient()

  // Phase 6 Step 2 (docs/event-scoping-and-review-fixes-plan.md §1). The
  // department lookup and `v_budget_vs_actual` (rewritten with an `event_id`
  // output column by the parallel reports/export stream,
  // 20260822000007_reports_export_event_scoping.sql) can be filtered
  // directly. `v_department_audit_variance` and `reconciliation_exception`
  // cannot: neither carries an `event_id` column (doc §1.2:
  // reconciliation_exception "inherits event via its parent, no column of
  // its own", and the variance view is a thin, pre-event-scoping projection
  // of `entries` that isn't rewritten by this stream) -- so both are
  // event-scoped here by cross-referencing their `entry_id` against
  // `entries.event_id` in application code instead of in the query itself.
  const selectedEventId = await getSelectedEventId(supabase)

  const [varianceRes, deptRes, vendorRes, budgetHeadRes, exceptionRes, budgetVsActualRes, deptMembershipRes] =
    await Promise.all([
      supabase
        .from('v_department_audit_variance')
        // Item 1.2 §5: `{ count: 'exact' }` rides along on the same request
        // (no extra round trip) so the report can say when the .limit(1000)
        // below has actually truncated the result, mirroring 1.5's fix for
        // the review queue's capped query.
        .select(
          'entry_id, ubbl_number, main_number, department_id, budget_head_id, vendor_id, date, amount, variance_reason, variance_type',
          { count: 'exact' }
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
      selectedEventId === null
        ? supabase
            .from('v_budget_vs_actual')
            .select('budget_head_id, raw_label, short_label, utilised_amount, actual_amount, entry_count')
            .returns<BudgetVsActualRow[]>()
        : supabase
            .from('v_budget_vs_actual')
            .select('budget_head_id, raw_label, short_label, utilised_amount, actual_amount, entry_count')
            .eq('event_id', selectedEventId)
            .returns<BudgetVsActualRow[]>(),
      selectedEventId === null
        ? Promise.resolve({ data: [] as { department_id: number }[] })
        : supabase.from('event_department').select('department_id').eq('event_id', selectedEventId),
    ])

  const rawUnmatched = varianceRes.data ?? []
  const rawExceptionRows = exceptionRes.data ?? []

  // One lookup covering both: which of the entry ids referenced by either
  // result actually belong to the selected event.
  const candidateEntryIds = Array.from(
    new Set<number>([
      ...rawUnmatched.map((r) => r.entry_id),
      ...rawExceptionRows.map((r) => r.entry_id).filter((id): id is number => id !== null),
    ])
  )
  let eventEntryIds: Set<number> | null = null
  if (selectedEventId !== null && candidateEntryIds.length > 0) {
    const { data: entryEventRows } = await supabase
      .from('entries')
      .select('id')
      .eq('event_id', selectedEventId)
      .in('id', candidateEntryIds)
    eventEntryIds = new Set((entryEventRows ?? []).map((r) => r.id as number))
  }

  const unmatched = eventEntryIds === null ? rawUnmatched : rawUnmatched.filter((r) => eventEntryIds!.has(r.entry_id))
  const exceptionRows =
    eventEntryIds === null
      ? rawExceptionRows
      : rawExceptionRows.filter((r) => r.entry_id !== null && eventEntryIds!.has(r.entry_id))

  const allocationSource: 'exceptions' | 'computed' = exceptionRows.length > 0 ? 'exceptions' : 'computed'
  const computedAllocationMismatches = (budgetVsActualRes.data ?? []).filter((r) => {
    if (r.utilised_amount === null) return false
    const actual = r.actual_amount ?? 0
    return Math.abs(actual - r.utilised_amount) > VARIANCE_TOLERANCE
  })

  const departmentMemberIds = new Set((deptMembershipRes.data ?? []).map((r) => r.department_id))
  const deptRows = (deptRes.data ?? []).filter(
    (d) => selectedEventId === null || departmentMemberIds.has(d.id)
  )

  return {
    unmatched,
    // True row count for `v_department_audit_variance` (RLS-scoped, no
    // additional filters on this query) -- lets the UI say when the
    // `.limit(1000)` above has actually truncated the result. Not
    // event-scoped, since that filter only exists in application code above;
    // used only to flag cap truncation, not to reconcile against `unmatched`.
    varianceTotalCount: varianceRes.count ?? null,
    deptMap: new Map(deptRows.map((d) => [d.id, d.name])),
    vendorMap: new Map((vendorRes.data ?? []).map((v) => [v.id, v.display_name])),
    budgetHeadMap: new Map((budgetHeadRes.data ?? []).map((b) => [b.id, b.short_label ?? b.raw_label])),
    allocationSource,
    exceptionRows,
    computedAllocationMismatches,
    errors: {
      variance: friendlyDataError(varianceRes.error, 'reconciliation:varianceRes'),
      exceptions: friendlyDataError(exceptionRes.error, 'reconciliation:exceptionRes'),
      budgetVsActual: friendlyDataError(budgetVsActualRes.error, 'reconciliation:budgetVsActualRes'),
    },
  }
}

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string
    type?: string
    severity?: string
    page?: string
    size?: string
    sort?: string
    dir?: string
  }>
}) {
  const params = await searchParams
  const status = params.status ?? 'open'
  const type = params.type ?? 'all'
  const severity =
    params.severity && (SEVERITY_VALUES as readonly string[]).includes(params.severity)
      ? params.severity
      : 'all'
  const size = parsePageSize(params.size)
  const requestedPage = parsePageNumber(params.page)
  const queueSort = parseQueueSort(params.sort, params.dir)

  const staff = await getStaffContext()
  if (!staff) {
    return (
      <PageShell>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Sign in required</p>
            <p className="text-sm text-muted-foreground">You need to sign in to view exceptions.</p>
          </CardContent>
        </Card>
      </PageShell>
    )
  }
  if (!staff.isActive) {
    return (
      <PageShell>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Your account is pending activation</p>
            <p className="text-sm text-muted-foreground">An admin needs to activate your account first.</p>
          </CardContent>
        </Card>
      </PageShell>
    )
  }

  const canResolve = isAdminOrAbove(staff.role)

  const [
    { exceptions, totalCount: queueTotalCount, page: queuePage, rangeStart, rangeEnd, error: queueError },
    severityCounts,
    reportData,
  ] = await Promise.all([
    loadQueueData({
      status,
      type,
      severity,
      page: requestedPage,
      size,
      sort: queueSort.column,
      dir: queueSort.direction,
    }),
    loadOpenSeverityCounts(),
    loadReconciliationReportData(),
  ])

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
    { key: 'dept', header: 'Department', render: (r) => (r.department_id ? reportData.deptMap.get(r.department_id) ?? '—' : '—') },
    { key: 'vendor', header: 'Vendor', render: (r) => (r.vendor_id ? reportData.vendorMap.get(r.vendor_id) ?? `#${r.vendor_id}` : '—') },
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
    <PageShell>
      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="report">Reconciliation report</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="flex flex-col gap-4">
          <ExceptionsFilters status={status} type={type} severity={severity} />
          <SeverityCountChips counts={severityCounts} activeSeverity={severity} />

          {queueError ? (
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm font-medium">Could not load exceptions</p>
                <FriendlyError message={queueError.message} />
              </CardContent>
            </Card>
          ) : exceptions.length === 0 ? (
            <QueueEmptyState isDefaultView={status === 'open' && type === 'all' && severity === 'all'} />
          ) : (
            <div className="flex flex-col gap-2">
              <ExceptionsPagination
                page={queuePage}
                size={size}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                total={queueTotalCount}
              />
              <SeverityLegend />
              <ExceptionsTable
                exceptions={exceptions}
                canResolve={canResolve}
                sortColumn={queueSort.column}
                sortDirection={queueSort.direction}
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="report" className="flex flex-col gap-4">
          <ReportSection
            title="Missing a Main/Audit-side match"
            description={
              reportData.varianceTotalCount !== null && reportData.varianceTotalCount > 1000
                ? `Entries with no Main Entry Number recorded yet — nothing to compare against on the Audit side. Showing the latest 1,000 of ${reportData.varianceTotalCount.toLocaleString()}.`
                : 'Entries with no Main Entry Number recorded yet — nothing to compare against on the Audit side.'
            }
            action={
              <ExportCsvButton
                filename="reconciliation-unmatched.csv"
                rowCount={reportData.unmatched.length}
                csv={toCsv(reportData.unmatched, [
                  { header: 'UBBL Number', value: (r) => r.ubbl_number },
                  { header: 'Department', value: (r) => (r.department_id ? reportData.deptMap.get(r.department_id) : '') },
                  { header: 'Vendor', value: (r) => (r.vendor_id ? reportData.vendorMap.get(r.vendor_id) : '') },
                  { header: 'Date', value: (r) => r.date },
                  { header: 'Amount', value: (r) => r.amount },
                ])}
              />
            }
          >
            {reportData.errors.variance ? (
              <ReportEmptyState title="Couldn't load variance data" description={reportData.errors.variance} />
            ) : reportData.unmatched.length === 0 ? (
              <ReportEmptyState
                icon={CheckCircle2}
                title="Every entry has a Main-side match"
                description="No entries missing a Main Entry Number across the entries this account can see."
              />
            ) : (
              <DataTable
                columns={unmatchedColumns}
                rows={reportData.unmatched}
                getRowKey={(r) => r.entry_id}
                emptyTitle="Nothing unmatched"
                emptyDescription="Every entry this account can see has a Main-side match."
              />
            )}
          </ReportSection>

          <ReportSection
            title="Allocation-sum mismatches"
            description={
              reportData.allocationSource === 'exceptions'
                ? 'Open reconciliation_exception rows of type allocation_sum_mismatch — raised by the importer.'
                : 'No open exception rows yet — computed directly by comparing v_budget_vs_actual\'s reported utilised amount against the sum of amounts per head.'
            }
            action={
              reportData.allocationSource === 'exceptions' ? (
                <ExportCsvButton
                  filename="reconciliation-allocation-mismatches.csv"
                  rowCount={reportData.exceptionRows.length}
                  csv={toCsv(reportData.exceptionRows, [
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
                  rowCount={reportData.computedAllocationMismatches.length}
                  csv={toCsv(reportData.computedAllocationMismatches, [
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
            {reportData.allocationSource === 'exceptions' ? (
              <DataTable
                columns={exceptionColumns}
                rows={reportData.exceptionRows}
                getRowKey={(r) => r.id}
                emptyTitle="No open allocation exceptions"
              />
            ) : (
              <DataTable
                columns={computedColumns}
                rows={reportData.computedAllocationMismatches}
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
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Exceptions</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        The exceptions queue for resolving/dismissing flagged items, and the reconciliation report the org
        currently produces by hand — unmatched entries and allocation-sum mismatches.
      </p>
      {children}
    </div>
  )
}

function QueueEmptyState({ isDefaultView }: { isDefaultView: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border py-10 text-center">
      <p className="text-sm font-medium">{isDefaultView ? 'No open exceptions' : 'No exceptions match these filters'}</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {isDefaultView
          ? "This queue fills in as the importer, OCR pipeline, and reconciliation checks run — line-item tally mismatches, tenant/Main variances, allocation mismatches and the like (§3.10). It's expected to be empty or near-empty until an import has actually committed data and documents have been through review."
          : 'Try a different status, severity, or exception type.'}
      </p>
      {!isDefaultView && (
        <Link
          href="/exceptions"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          Clear all filters
        </Link>
      )}
    </div>
  )
}
