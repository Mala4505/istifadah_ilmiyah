import { ScanLine, TriangleAlert, Wallet, UploadCloud } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { StatTile } from '@/components/dashboard/stat-tile'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'

// Screen 2 — Dashboard (MASTER-PLAN §5, day 6). Reads from the §10.2
// reporting views (RLS-scoped via security_invoker) rather than assembling
// its own joins. Every tile links to its filtered list per §5's note.
export const dynamic = 'force-dynamic'

type OpenIssueRow = { amount_at_risk: number | null }
type BudgetVsActualRow = {
  budget_head_id: number
  actual_amount: number | null
  approved_amount: number | null
  budget_status_note: string | null
}
type ImportBatchRow = { id: number; row_count: number | null; mode: string; status: string }

async function loadDashboardData() {
  const supabase = await createClient()

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const [reviewQueueRes, openIssuesRes, budgetRes, importsRes] = await Promise.all([
    supabase
      .from('v_review_queue')
      .select('document_extraction_id', { count: 'exact', head: true }),
    supabase.from('v_open_issues').select('amount_at_risk').returns<OpenIssueRow[]>(),
    supabase
      .from('v_budget_vs_actual')
      .select('budget_head_id, actual_amount, approved_amount, budget_status_note')
      .returns<BudgetVsActualRow[]>(),
    supabase
      .from('import_batch')
      .select('id, row_count, mode, status')
      .gte('started_at', startOfToday.toISOString())
      .returns<ImportBatchRow[]>(),
  ])

  const openIssues = openIssuesRes.data ?? []
  const budgetRows = budgetRes.data ?? []
  const importBatches = importsRes.data ?? []

  return {
    reviewQueueDepth: reviewQueueRes.count ?? 0,
    reviewQueueError: reviewQueueRes.error?.message ?? null,

    openIssuesCount: openIssues.length,
    openIssuesAtRisk: openIssues.reduce((sum, r) => sum + (r.amount_at_risk ?? 0), 0),
    openIssuesError: openIssuesRes.error?.message ?? null,

    totalActualSpend: budgetRows.reduce((sum, r) => sum + (r.actual_amount ?? 0), 0),
    headsWithoutApprovedBudget: budgetRows.filter((r) => r.budget_status_note === 'no approved budget')
      .length,
    totalHeads: budgetRows.length,
    budgetError: budgetRes.error?.message ?? null,

    importBatchCount: importBatches.length,
    importRowCount: importBatches.reduce((sum, r) => sum + (r.row_count ?? 0), 0),
    importsError: importsRes.error?.message ?? null,
  }
}

export default async function DashboardPage() {
  const data = await loadDashboardData()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          Phase 1A · Day 6
        </span>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Review queue depth, open exceptions by ₹ at risk, budget burn, and today&apos;s imports.
      </p>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Review queue depth"
          value={formatNumber(data.reviewQueueDepth)}
          hint={
            data.reviewQueueDepth === 0
              ? 'Empty until Phase 1B ships extraction'
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
          label="Budget burn"
          value={formatINRCompact(data.totalActualSpend)}
          hint={
            data.totalHeads === 0
              ? 'No budget heads allocated yet'
              : data.headsWithoutApprovedBudget > 0
                ? `${data.headsWithoutApprovedBudget} of ${data.totalHeads} heads have no approved budget`
                : `Across ${data.totalHeads} budget heads`
          }
          href="/reports#budget-vs-actual"
          icon={Wallet}
          tone={data.headsWithoutApprovedBudget > 0 ? 'warning' : 'default'}
          error={data.budgetError}
        />
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
      </div>
    </div>
  )
}
