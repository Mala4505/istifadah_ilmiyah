import { friendlyDataError } from '@/lib/friendly-error'
import Link from 'next/link'
import { ScanLine, TriangleAlert, Wallet, UploadCloud, FileScan, ArrowRight, ListChecks, Tag } from 'lucide-react'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { getCachedStaffProfile } from '@/lib/export/auth'
import { getSelectedEventId } from '@/lib/events/current'
import { StatTile } from '@/components/dashboard/stat-tile'
import { StatusCountCard, dashboardStatusBadgeVariant, type StatusCount } from '@/components/dashboard/status-count-card'
import { ImportWorkspace } from '@/components/import/import-workspace'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'
import { isAdminOrAbove } from '@/lib/auth/roles'

// Screen 2 — Dashboard (MASTER-PLAN §5, day 6). Reads from the §10.2
// reporting views (RLS-scoped via security_invoker) rather than assembling
// its own joins. Every tile links to its filtered list per §5's note.
export const dynamic = 'force-dynamic'

type OpenIssueRow = { amount_at_risk: number | null; event_id: number | null }
type BudgetVsActualRow = {
  budget_head_id: number
  actual_amount: number | null
  approved_amount: number | null
  budget_status_note: string | null
}
type ImportBatchRow = { id: number; row_count: number | null; mode: string; status: string }
type EntryStatusCountRow = {
  dimension: 'status' | 'hub_status'
  status_id: number | null
  status_code: string
  status_label: string
  sort_order: number
  entry_count: number
}

async function loadDashboardData() {
  const supabase = await createClient()

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  // Phase 0 §0.2 (docs/pre-deploy-findings-and-plan.md): this tile used to
  // read v_open_issues completely unfiltered by event, while Reports read it
  // filtered and Exceptions read the base table with a broken filter (§0.1)
  // -- three different counts for the same backlog. Event-scoped here the
  // same way Reports and Exceptions now are: keep rows in the active event
  // OR rows whose event can't be resolved at all (a vendor-level flag with
  // no entry/document/batch to attribute to any single event), never drop
  // them outright.
  //
  // Phase 6 §6.1: five more query sites on this page were missed by the
  // original event-scoping pass and silently summed across every event --
  // v_review_queue, v_budget_vs_actual, import_batch, source_document, and
  // v_entry_status_counts. All five now filter the same way Reports'
  // loadReportsData does (app/(app)/reports/page.tsx) -- a plain
  // `.eq('event_id', selectedEventId)`, not the OR-null form v_open_issues
  // needs, because each resolves event_id through a column that is `not
  // null` on its base table (entries/source_document/import_batch/
  // budget_allocation all got `event_id ... not null` in
  // 20260822000005_event_scoping.sql) rather than through a best-effort
  // multi-table coalesce. v_entry_status_counts's event_id column is added by
  // a parallel migration (20260822000011_analytics_event_scoping.sql) landing
  // alongside this change -- filtering here assumes it exists.
  const selectedEventId = await getSelectedEventId()

  const [reviewQueueRes, openIssuesRes, budgetRes, importsRes, unmatchedDocsRes, profileRes, statusCountsRes] =
    await Promise.all([
      supabase
        .from('v_review_queue')
        .select('document_extraction_id', { count: 'exact', head: true })
        .eq('event_id', selectedEventId),
      selectedEventId === null
        ? supabase.from('v_open_issues').select('amount_at_risk, event_id').returns<OpenIssueRow[]>()
        : supabase
            .from('v_open_issues')
            .select('amount_at_risk, event_id')
            .or(`event_id.eq.${selectedEventId},event_id.is.null`)
            .returns<OpenIssueRow[]>(),
      supabase
        .from('v_budget_vs_actual')
        .select('budget_head_id, actual_amount, approved_amount, budget_status_note')
        .eq('event_id', selectedEventId)
        .returns<BudgetVsActualRow[]>(),
      supabase
        .from('import_batch')
        .select('id, row_count, mode, status')
        .eq('event_id', selectedEventId)
        .gte('started_at', startOfToday.toISOString())
        .returns<ImportBatchRow[]>(),
      supabase
        .from('source_document')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', selectedEventId)
        .in('match_status', ['unmatched', 'suggested']),
      (async () => {
        const user = await getCachedUser()
        if (!user) return { data: null }
        const profile = await getCachedStaffProfile(user.id)
        return { data: profile }
      })(),
      supabase
        .from('v_entry_status_counts')
        .select('dimension, status_id, status_code, status_label, sort_order, entry_count')
        .eq('event_id', selectedEventId)
        .returns<EntryStatusCountRow[]>(),
    ])

  const openIssues = openIssuesRes.data ?? []
  const budgetRows = budgetRes.data ?? []
  const importBatches = importsRes.data ?? []
  const isAdmin = Boolean(profileRes.data?.is_active && isAdminOrAbove(profileRes.data.role))

  // Status-count summary (Hub Refinements plan §0 item 3) -- v_entry_status_counts
  // (20260817000001) returns one row per (dimension, status value); split it back
  // into the three independent dimensions (§2 of that plan) and sort each by the
  // lookup table's own sort_order rather than count, so the badge order matches
  // the filter dropdowns on /entries.
  const statusCountRows = statusCountsRes.data ?? []
  const toStatusCounts = (dimension: EntryStatusCountRow['dimension']): StatusCount[] =>
    statusCountRows
      .filter((r) => r.dimension === dimension)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((r) => ({ id: r.status_id, code: r.status_code, label: r.status_label, count: r.entry_count }))

  return {
    reviewQueueDepth: reviewQueueRes.count ?? 0,
    reviewQueueError: friendlyDataError(reviewQueueRes.error, 'dashboard:reviewQueueRes'),

    openIssuesCount: openIssues.length,
    openIssuesAtRisk: openIssues.reduce((sum, r) => sum + (r.amount_at_risk ?? 0), 0),
    openIssuesError: friendlyDataError(openIssuesRes.error, 'dashboard:openIssuesRes'),

    totalActualSpend: budgetRows.reduce((sum, r) => sum + (r.actual_amount ?? 0), 0),
    headsWithoutApprovedBudget: budgetRows.filter((r) => r.budget_status_note === 'no approved budget')
      .length,
    totalHeads: budgetRows.length,
    budgetError: friendlyDataError(budgetRes.error, 'dashboard:budgetRes'),

    importBatchCount: importBatches.length,
    importRowCount: importBatches.reduce((sum, r) => sum + (r.row_count ?? 0), 0),
    importsError: friendlyDataError(importsRes.error, 'dashboard:importsRes'),

    unmatchedDocsCount: unmatchedDocsRes.count ?? 0,
    unmatchedDocsError: friendlyDataError(unmatchedDocsRes.error, 'dashboard:unmatchedDocsRes'),

    statusCounts: toStatusCounts('status'),
    hubStatusCounts: toStatusCounts('hub_status'),
    statusCountsError: friendlyDataError(statusCountsRes.error, 'dashboard:statusCountsRes'),

    isAdmin,
  }
}

export default async function DashboardPage() {
  const data = await loadDashboardData()

  // §7.5 (docs/pre-deploy-findings-and-plan.md): "The tile reads ₹2.32 Cr
  // with the subtitle '10 of 10 heads have no approved budget'. If nothing
  // has a budget, nothing can be burning -- that figure is just spend to
  // date." When every head is missing an approved amount, the denominator
  // for "burn" doesn't exist at all -- rename the tile rather than keep
  // labelling a plain spend total as a burn rate against a budget that isn't
  // there.
  const allHeadsLackApprovedBudget = data.totalHeads > 0 && data.headsWithoutApprovedBudget === data.totalHeads

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Review queue depth, open exceptions by ₹ at risk, budget burn, today&apos;s imports, and
          documents waiting to be matched.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Review queue depth"
          value={formatNumber(data.reviewQueueDepth)}
          hint={
            data.reviewQueueDepth === 0
              ? 'Nothing waiting on review yet'
              : 'Unverified extractions waiting'
          }
          href="/review"
          icon={ScanLine}
          error={data.reviewQueueError}
        />
        <StatTile
          label="Open exceptions — ₹ at risk"
          value={formatINRCompact(data.openIssuesAtRisk)}
          hint={
            data.openIssuesCount === 0
              ? 'No open exceptions'
              : `${formatNumber(data.openIssuesCount)} open, sorted by severity`
          }
          href="/exceptions"
          icon={TriangleAlert}
          tone={data.openIssuesCount > 0 ? 'critical' : 'default'}
          error={data.openIssuesError}
        />
        <StatTile
          label={allHeadsLackApprovedBudget ? 'Spend to date' : 'Budget burn'}
          value={formatINRCompact(data.totalActualSpend)}
          hint={
            data.totalHeads === 0
              ? 'No budget heads allocated yet'
              : allHeadsLackApprovedBudget
                ? `No approved budget on any of ${data.totalHeads} heads yet — spend so far, not a burn rate`
                : data.headsWithoutApprovedBudget > 0
                  ? `${data.headsWithoutApprovedBudget} of ${data.totalHeads} heads have no approved budget`
                  : `Across ${data.totalHeads} budget heads`
          }
          href="/reports#budget-vs-actual"
          icon={Wallet}
          tone={!allHeadsLackApprovedBudget && data.headsWithoutApprovedBudget > 0 ? 'warning' : 'default'}
          error={data.budgetError}
        />
        {/* Running an import is admin-only (§4.4c), and /import refuses
            everyone else server-side — a department account was being shown a
            tile whose only destination is a permission-denied page. */}
        {data.isAdmin && (
          <StatTile
            label="Today's imports"
            value={formatNumber(data.importBatchCount)}
            hint={
              data.importBatchCount === 0
                ? 'No import batches started today'
                : `${formatNumber(data.importRowCount)} rows across ${data.importBatchCount} batch${data.importBatchCount === 1 ? '' : 'es'}`
            }
            href="/import"
            icon={UploadCloud}
            error={data.importsError}
          />
        )}
        <StatTile
          label="Documents to match"
          value={formatNumber(data.unmatchedDocsCount)}
          hint={
            data.unmatchedDocsCount === 0
              ? 'Inbox is clear'
              : 'Waiting to be attached to an entry'
          }
          href="/documents"
          icon={FileScan}
          tone={data.unmatchedDocsCount > 0 ? 'warning' : 'default'}
          error={data.unmatchedDocsError}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground">Status breakdown</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every entry carries three independent status fields — Status and Audit status are
            read-only, copied in from the Departmental import and Audit-portal scrape; Hub status
            is the only one this app writes, and the only thing ever exported back out. Every
            count below links to the matching filter on Entries.
          </p>
        </div>
        {data.statusCountsError ? (
          <Card>
            <CardContent className="py-4">
              <p className="text-sm text-destructive">Couldn&apos;t load the status breakdown.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <StatusCountCard
              title="Status"
              icon={ListChecks}
              rows={data.statusCounts}
              paramKey="st"
              variantFor={dashboardStatusBadgeVariant}
              emptyHint="No entries imported yet."
            />
            <StatusCountCard
              title="Hub status"
              icon={Tag}
              rows={data.hubStatusCounts}
              paramKey="hs"
              variantFor={dashboardStatusBadgeVariant}
              emphasizeCodes={['awaiting_verification', 'awaiting_validation']}
              emptyHint="No entries imported yet."
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Getting data in — two steps</h2>
        {/* §7.8: step 1's dropzone card and step 2's single-button card used to
            read as visually lopsided (a tall card next to a short one, so the
            row looked unfinished). items-stretch + h-full on both columns
            makes step 2 match step 1's height whatever that turns out to be,
            and the added "what happens" list gives the short card comparable
            content weight instead of just whitespace. */}
        <div className="grid items-stretch gap-4 lg:grid-cols-2">
          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
                1
              </span>
              Import ledger data
            </div>
            {data.isAdmin ? (
              // §7.7 (docs/pre-deploy-findings-and-plan.md): the dry-run/commit
              // result inside ImportWorkspace renders RowLogTable, an
              // 8-column table with several fixed/whitespace-nowrap cells
              // (components/import/row-log-table.tsx) that easily exceeds a
              // 430px phone viewport. That table doesn't make sense to
              // stack, so this contains its overflow to a local horizontal
              // scrollbar instead of pushing the whole page wider —
              // overflow-y-visible keeps this from also becoming an
              // accidental vertical scroll container per the CSS spec's
              // "auto" side-effect when only overflow-x is set.
              <div className="overflow-x-auto overflow-y-visible">
                <ImportWorkspace isAdmin={data.isAdmin} />
              </div>
            ) : (
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="text-base">Import ledger data</CardTitle>
                  <CardDescription>
                    Bringing in the Departmental export or reading the Audit portal is restricted to
                    admins. Ask an admin if new data needs to land.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
          </div>

          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
                2
              </span>
              Upload &amp; OCR documents
            </div>
            <Card className="flex h-full flex-col">
              <CardHeader>
                <CardTitle className="text-base">Document inbox</CardTitle>
                <CardDescription>
                  Once entries exist, upload the invoice/bill PDFs — they&apos;re OCR&rsquo;d and
                  matched to an entry automatically where possible, or attached by hand.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li>Automatic OCR extraction, usually within a minute of upload</li>
                  <li>Matched to its ledger entry automatically when vendor and amount line up</li>
                  <li>Left for manual matching in the inbox when nothing lines up — nothing is dropped silently</li>
                </ul>
                <Button asChild variant="outline">
                  <Link href="/documents">
                    Go to document inbox
                    <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
