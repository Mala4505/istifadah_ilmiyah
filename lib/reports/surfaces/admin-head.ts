/**
 * Data loader for reporting-blueprint.md §3 Family A: A-04 administrative head
 * accountability ("Spend, entry volume and budget adherence per named head.
 * The dimension exists and is currently almost unreported — yet it is the one
 * that attaches a number to a person.").
 *
 * Its own surface file (§8 Phase Three's "one loader per surface"), strictly
 * additive — no shared file is touched. The row shape lives here for now; the
 * parent hoists it into lib/reports/sections/shared.tsx during integration.
 *
 * ── What "budget adherence" resolves to ──────────────────────────────────
 * v_admin_head_spend (20260903000001) gives spend / entry_count /
 * document_coverage_pct per (admin_head, event). It carries NO budget figure,
 * and the schema has no way to give it one: budget_allocation is keyed to
 * budget_head, department_budget_allocation to department — there is no FK
 * from admin_head to any budget object. The organisation simply does not
 * budget at head level.
 *
 * So adherence is shown honestly at the department the head belongs to.
 * v_admin_head_spend already carries department_id, so this loader does an
 * app-side join (no new view needed — it keeps this a purely additive file)
 * against:
 *   • v_department_budget_vs_actual  → the owning department's latest budget
 *     position (budget_amount, actual_amount, pct_of_budget, status note).
 *   • v_department_risk_summary      → the owning department's open ₹ at risk
 *     and open issue count.
 * Both are labelled "department …" everywhere they surface — this is context
 * on the head's department, not a per-head budget the data cannot represent.
 *
 * share_of_event_pct is computed here: the head's spend over the sum of all
 * heads' spend this event (entries with no admin_head_id are excluded from
 * both sides, so shares sum to 100% across the rows shown).
 *
 * Prior-period comparison (§6 fix #1): 'prior_event' resolves the previous
 * event once and re-sums v_admin_head_spend against it for the one headline
 * delta (spend through named heads). 'prior_week' has no effect — none of
 * these three aggregates carry an as-of dimension a week-old snapshot could
 * be re-derived from (same reasoning lib/reports/surfaces/budget.ts documents).
 *
 * RLS: entries is department-scoped, so a department-scoped reviewer sees
 * v_admin_head_spend rows only for heads in their department(s); the two
 * department context views are likewise filtered. Totals and shares are
 * therefore "within what you can see", consistent with every other surface.
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { ROW_CAP, resolvePreviousEvent, round2Local } from '@/lib/reports/sections/shared'

/** Raw projection of v_admin_head_spend for one (admin_head, event). */
export type AdminHeadSpendRow = {
  admin_head_id: number
  admin_head_name: string
  department_id: number | null
  department_name: string | null
  event_id: number | null
  entry_count: number
  total_amount: number | null
  entries_with_documents: number
  document_coverage_pct: number | null
}

/**
 * A-04 presentation row: one named administrative head this event, with the
 * OWNING DEPARTMENT's budget position and ₹-at-risk attached as context
 * (camelCase because this is an app-side composed shape, not a 1:1 view
 * projection — same convention as VendorCluster in shared.tsx).
 */
export type AdminHeadAccountabilityRow = {
  adminHeadId: number
  adminHeadName: string
  departmentId: number | null
  departmentName: string | null
  entryCount: number
  totalAmount: number
  entriesWithDocuments: number
  documentCoveragePct: number | null
  /** total_amount / sum of all heads' spend this event, 0–100. */
  shareOfEventPct: number
  /** Owning department's latest budget position this event. null when the
   *  head has no department, or the department has no budget imported. */
  departmentBudgetAmount: number | null
  departmentActualAmount: number | null
  departmentPctOfBudget: number | null
  departmentBudgetStatusNote: string | null
  /** Owning department's open ₹ at risk / open issue count
   *  (v_department_risk_summary). null when nothing is attributable. */
  departmentAmountAtRisk: number | null
  departmentOpenIssueCount: number | null
}

export type AdminHeadAccountabilitySurfaceData = {
  eventName: string | null
  previousEventName: string | null
  accountability: {
    rows: AdminHeadAccountabilityRow[]
    error: string | null
    /** Sum of totalAmount across the rows — the KPI headline figure. */
    spendThroughHeads: number
    previousSpendTotal: number | null
  }
}

const SPEND_SELECT =
  'admin_head_id, admin_head_name, department_id, department_name, event_id, entry_count, total_amount, entries_with_documents, document_coverage_pct'

type DeptBudgetContextRow = {
  department_id: number
  budget_amount: number | null
  actual_amount: number | null
  pct_of_budget: number | null
  budget_status_note: string | null
}

type DeptRiskContextRow = {
  department_id: number
  amount_at_risk: number | null
  open_issue_count: number
}

/** A-04 adherence outlier: the head's owning department is materially over
 *  its budget. Kept here so the section and any future consumer agree on the
 *  bar — 110% mirrors budgetStatusColorClass's "over" step in shared.tsx. */
export const DEPARTMENT_OVER_BUDGET_PCT = 110

export function headDepartmentIsOverBudget(row: AdminHeadAccountabilityRow): boolean {
  return row.departmentPctOfBudget != null && row.departmentPctOfBudget > DEPARTMENT_OVER_BUDGET_PCT
}

export async function loadAdminHeadAccountability(
  compareBasis: CompareBasis
): Promise<AdminHeadAccountabilitySurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent(supabase)
  const eventId = selectedEvent?.id ?? null

  const [spendRes, deptBudgetRes, deptRiskRes] = await Promise.all([
    supabase
      .from('v_admin_head_spend')
      .select(SPEND_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<AdminHeadSpendRow[]>(),
    supabase
      .from('v_department_budget_vs_actual')
      .select('department_id, budget_amount, actual_amount, pct_of_budget, budget_status_note')
      .eq('event_id', eventId)
      .returns<DeptBudgetContextRow[]>(),
    supabase
      .from('v_department_risk_summary')
      .select('department_id, amount_at_risk, open_issue_count')
      .eq('event_id', eventId)
      .returns<DeptRiskContextRow[]>(),
  ])

  const spendRows = spendRes.data ?? []
  const budgetByDept = new Map<number, DeptBudgetContextRow>(
    (deptBudgetRes.data ?? []).map((r) => [r.department_id, r])
  )
  const riskByDept = new Map<number, DeptRiskContextRow>(
    (deptRiskRes.data ?? []).map((r) => [r.department_id, r])
  )

  const eventTotal = spendRows.reduce((sum, r) => sum + (r.total_amount ?? 0), 0)

  const rows: AdminHeadAccountabilityRow[] = spendRows.map((r) => {
    const budget = r.department_id != null ? budgetByDept.get(r.department_id) : undefined
    const risk = r.department_id != null ? riskByDept.get(r.department_id) : undefined
    const totalAmount = r.total_amount ?? 0
    return {
      adminHeadId: r.admin_head_id,
      adminHeadName: r.admin_head_name,
      departmentId: r.department_id,
      departmentName: r.department_name,
      entryCount: r.entry_count,
      totalAmount,
      entriesWithDocuments: r.entries_with_documents,
      documentCoveragePct: r.document_coverage_pct,
      shareOfEventPct: eventTotal > 0 ? round2Local((totalAmount / eventTotal) * 100) : 0,
      departmentBudgetAmount: budget?.budget_amount ?? null,
      departmentActualAmount: budget?.actual_amount ?? null,
      departmentPctOfBudget: budget?.pct_of_budget ?? null,
      departmentBudgetStatusNote: budget?.budget_status_note ?? null,
      departmentAmountAtRisk: risk?.amount_at_risk ?? null,
      departmentOpenIssueCount: risk?.open_issue_count ?? null,
    }
  })

  const error =
    friendlyDataError(spendRes.error, 'reports:admin-head:spend') ??
    friendlyDataError(deptBudgetRes.error, 'reports:admin-head:dept-budget') ??
    friendlyDataError(deptRiskRes.error, 'reports:admin-head:dept-risk')

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousSpendTotal: number | null = null
  if (previousEvent) {
    const pSpend = await supabase
      .from('v_admin_head_spend')
      .select('total_amount')
      .eq('event_id', previousEvent.id)
      .returns<{ total_amount: number | null }[]>()
    previousSpendTotal = (pSpend.data ?? []).reduce((sum, r) => sum + (r.total_amount ?? 0), 0)
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    accountability: {
      rows,
      error,
      spendThroughHeads: eventTotal,
      previousSpendTotal,
    },
  }
}
