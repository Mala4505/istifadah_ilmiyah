import { differenceInCalendarDays } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import { friendlyDataError } from '@/lib/friendly-error'
import { createClient } from '@/lib/supabase/server'
import { computeProjectedLanding, type EventDatesRow } from '@/lib/reports/hero-metrics'
import { formatINRCompact, formatPercent } from '@/lib/reports/format'

// Executive Brief data layer — reporting-blueprint.md §5 (Screen architecture)
// and §8 Phase Two ("Views for E-01, E-02, A-03 and A-04. Build the Executive
// Brief on top of them."). Composes the per-department views added in
// 20260903000001_executive_brief_views.sql (v_department_documentation_coverage,
// v_department_risk_summary) with the pre-existing v_department_budget_vs_actual
// and v_vendor_concentration, plus this event's dates, into:
//   - E-01 department league table (leagueTable)
//   - E-02 attention-map points (attentionPoints)
//   - E-04 "needs your decision" (needsDecision)
//   - the Brief's 5-tile KPI row and its computed "what changed" sentences
// A-03's per-department "projected landing" (the league table's own column) and
// the event-wide landing figure in the KPI row both reuse
// computeProjectedLanding from hero-metrics.ts rather than re-deriving the
// run-rate math here — see that function's header for why the event-wide
// weekly spend-trend chart itself (hero.spendTrend) is loaded there, not here.
// A-04 (admin-head accountability) has its view (v_admin_head_spend) ready per
// the Phase Two build sequence but is not part of the Brief screen itself
// (blueprint §5's Brief composition list doesn't include it) — that view
// is for the Family A surface Phase Three adds.
//
// Follows this module family's conventions exactly (hero-metrics.ts,
// loadReportsData/loadAnalyticsData in app/(app)/reports/page.tsx): own
// createClient() call, `.returns<T[]>()` on every typed query, every `.error`
// piped through `friendlyDataError` before it leaves this module.

const OPEN_ISSUES_ROW_CAP = 1000
const NEEDS_DECISION_COUNT = 10
const CONCENTRATION_VENDOR_COUNT = 8

type DepartmentBudgetRow = {
  department_id: number
  department_name: string
  budget_amount: number | null
  actual_amount: number | null
  entry_count: number
  pct_of_budget: number | null
  budget_status_note: string | null
}

type DepartmentDocCoverageRow = {
  department_id: number
  department_name: string
  entry_count: number
  entries_with_documents: number
  document_coverage_pct: number | null
}

type DepartmentRiskRow = {
  department_id: number
  department_name: string
  open_issue_count: number
  amount_at_risk: number | null
}

type VendorConcentrationRow = {
  vendor_id: number
  display_name: string
  total_amount: number | null
  pct_of_total_spend: number | null
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

type EntryDeptLookupRow = {
  id: number
  department_id: number | null
}

type EventRow = EventDatesRow & { name: string }

export type DepartmentLeagueRow = {
  departmentId: number
  departmentName: string
  spend: number
  spendSharePct: number | null
  budgetAmount: number | null
  pctOfBudget: number | null
  budgetStatusNote: string | null
  projectedLandingPct: number | null
  documentCoveragePct: number | null
  amountAtRisk: number
  openIssueCount: number
}

export type NeedsDecisionRow = {
  key: string
  issueType: string
  severity: string
  amountAtRisk: number | null
  description: string | null
  owner: string
  ageDays: number
}

export type ExecutiveBrief = {
  eventName: string | null
  eventDates: EventDatesRow | null
  kpi: {
    spendVsBudgetValue: string
    spendVsBudgetDelta: string
    spendVsBudgetTone: 'good' | 'bad' | 'neutral'
    projectedLandingValue: string
    projectedLandingTone: 'good' | 'bad' | 'neutral'
    vendorConcentrationValue: string
    vendorConcentrationLabel: string
    aboveMedianSpendValue: string
    openAmountAtRiskValue: string
  }
  sentences: string[]
  leagueTable: DepartmentLeagueRow[]
  attentionPoints: { key: number; label: string; x: number; y: number }[]
  needsDecision: NeedsDecisionRow[]
  errors: {
    league: string | null
    needsDecision: string | null
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * `totalSpend`/`openAmountAtRisk` are passed in already computed by
 * loadHeroMetrics (the page calls both loaders off the same eventId) rather
 * than re-querying `entries`/`v_open_issues` a second time here for figures
 * this module would otherwise duplicate.
 *
 * `client` is an optional pre-built Supabase client — see loadHeroMetrics's
 * header for why the `board_pack` job passes a service-role client here.
 */
export async function loadExecutiveBrief(
  eventId: number | null,
  totalSpend: number,
  openAmountAtRisk: number,
  client?: SupabaseClient
): Promise<ExecutiveBrief> {
  const supabase: SupabaseClient = client ?? (await createClient())

  const [budgetRes, docCoverageRes, riskRes, vendorRes, eventRes, issuesRes, overpaymentRes] = await Promise.all([
    supabase
      .from('v_department_budget_vs_actual')
      .select('department_id, department_name, budget_amount, actual_amount, entry_count, pct_of_budget, budget_status_note')
      .eq('event_id', eventId)
      .returns<DepartmentBudgetRow[]>(),
    supabase
      .from('v_department_documentation_coverage')
      .select('department_id, department_name, entry_count, entries_with_documents, document_coverage_pct')
      .eq('event_id', eventId)
      .returns<DepartmentDocCoverageRow[]>(),
    supabase
      .from('v_department_risk_summary')
      .select('department_id, department_name, open_issue_count, amount_at_risk')
      .eq('event_id', eventId)
      .returns<DepartmentRiskRow[]>(),
    supabase
      .from('v_vendor_concentration')
      .select('vendor_id, display_name, total_amount, pct_of_total_spend')
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(50)
      .returns<VendorConcentrationRow[]>(),
    eventId === null
      ? Promise.resolve({ data: null, error: null } as { data: EventRow | null; error: { message: string } | null })
      : supabase.from('event').select('name, starts_on, ends_on').eq('id', eventId).maybeSingle<EventRow>(),
    // Same eventId-null-vs-not OR-branch as hero-metrics.ts's issuesRes: a
    // plain `.eq('event_id', eventId)` would silently drop document-/batch-
    // level exceptions and vendor-level flags that have no traceable event.
    eventId === null
      ? supabase
          .from('v_open_issues')
          .select('source_table, id, entry_id, issue_type, severity, amount_at_risk, description, status, created_at')
          .limit(OPEN_ISSUES_ROW_CAP)
          .returns<OpenIssueRow[]>()
      : supabase
          .from('v_open_issues')
          .select('source_table, id, entry_id, issue_type, severity, amount_at_risk, description, status, created_at')
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(OPEN_ISSUES_ROW_CAP)
          .returns<OpenIssueRow[]>(),
    // C-04 above-median overpayment headline (blueprint §5 Brief KPI row). Entry-
    // derived, so a plain event_id filter is correct — no is.null branch.
    supabase
      .from('v_rate_observation')
      .select('overpayment_amount')
      .eq('event_id', eventId)
      .returns<{ overpayment_amount: number }[]>(),
  ])

  const budgetErr = friendlyDataError(budgetRes.error, 'executiveBrief:budgetRes')
  const docCoverageErr = friendlyDataError(docCoverageRes.error, 'executiveBrief:docCoverageRes')
  const riskErr = friendlyDataError(riskRes.error, 'executiveBrief:riskRes')
  const vendorErr = friendlyDataError(vendorRes.error, 'executiveBrief:vendorRes')
  const eventErr = friendlyDataError(eventRes.error, 'executiveBrief:eventRes')
  const issuesErr = friendlyDataError(issuesRes.error, 'executiveBrief:issuesRes')
  const overpaymentErr = friendlyDataError(overpaymentRes.error, 'executiveBrief:overpaymentRes')

  const budgetRows = budgetRes.data ?? []
  const docCoverageRows = docCoverageRes.data ?? []
  const riskRows = riskRes.data ?? []
  const vendorRows = vendorRes.data ?? []
  const eventRow = eventRes.data ?? null
  const issueRows = issuesRes.data ?? []
  const aboveMedianSpend = (overpaymentRes.data ?? []).reduce((s, r) => s + (r.overpayment_amount ?? 0), 0)

  const eventDates: EventDatesRow | null = eventRow ? { starts_on: eventRow.starts_on, ends_on: eventRow.ends_on } : null

  // ---- E-01 department league table ------------------------------------------

  const docCoverageByDept = new Map(docCoverageRows.map((r) => [r.department_id, r]))
  const riskByDept = new Map(riskRows.map((r) => [r.department_id, r]))
  const totalDeptSpend = budgetRows.reduce((s, r) => s + (r.actual_amount ?? 0), 0)

  const leagueTable: DepartmentLeagueRow[] = budgetRows
    .map((r) => {
      const spend = r.actual_amount ?? 0
      const landing = computeProjectedLanding(spend, eventDates)
      const projectedLandingPct =
        landing && r.budget_amount != null && r.budget_amount > 0 ? round2((landing.projectedTotal / r.budget_amount) * 100) : null
      const doc = docCoverageByDept.get(r.department_id)
      const risk = riskByDept.get(r.department_id)
      return {
        departmentId: r.department_id,
        departmentName: r.department_name,
        spend,
        spendSharePct: totalDeptSpend > 0 ? round2((spend / totalDeptSpend) * 100) : null,
        budgetAmount: r.budget_amount,
        pctOfBudget: r.pct_of_budget,
        budgetStatusNote: r.budget_status_note,
        projectedLandingPct,
        documentCoveragePct: doc?.document_coverage_pct ?? null,
        amountAtRisk: risk?.amount_at_risk ?? 0,
        openIssueCount: risk?.open_issue_count ?? 0,
      }
    })
    // Biggest departments first, matching v_department_budget_vs_actual's own
    // actual_amount-descending order used everywhere else in Reports.
    .sort((a, b) => b.spend - a.spend)

  const attentionPoints = leagueTable
    .filter((r) => r.spend > 0)
    .map((r) => ({ key: r.departmentId, label: r.departmentName, x: r.spend, y: r.documentCoveragePct ?? 0 }))

  // ---- E-04 "Needs your decision" --------------------------------------------

  const topIssues = [...issueRows].sort((a, b) => (b.amount_at_risk ?? 0) - (a.amount_at_risk ?? 0)).slice(0, NEEDS_DECISION_COUNT)
  const issueEntryIds = Array.from(new Set(topIssues.map((i) => i.entry_id).filter((id): id is number => id !== null)))
  const entryDeptRes =
    issueEntryIds.length === 0
      ? { data: [] as EntryDeptLookupRow[], error: null as { message: string } | null }
      : await supabase.from('entries').select('id, department_id').in('id', issueEntryIds).returns<EntryDeptLookupRow[]>()
  const entryDeptErr = friendlyDataError(entryDeptRes.error, 'executiveBrief:entryDeptRes')
  const deptIdByEntryId = new Map((entryDeptRes.data ?? []).map((e) => [e.id, e.department_id]))
  const deptNameById = new Map(budgetRows.map((r) => [r.department_id, r.department_name]))

  const now = new Date()
  const needsDecision: NeedsDecisionRow[] = topIssues.map((issue) => {
    const deptId = issue.entry_id != null ? (deptIdByEntryId.get(issue.entry_id) ?? null) : null
    return {
      key: `${issue.source_table}:${issue.id}`,
      issueType: issue.issue_type,
      severity: issue.severity,
      amountAtRisk: issue.amount_at_risk,
      description: issue.description,
      owner: (deptId != null ? deptNameById.get(deptId) : null) ?? 'Unassigned',
      ageDays: Math.max(0, differenceInCalendarDays(now, new Date(issue.created_at))),
    }
  })

  // ---- KPI row -----------------------------------------------------------------

  const totalBudget = budgetRows.reduce((s, r) => s + (r.budget_amount ?? 0), 0)
  const hasBudget = totalBudget > 0
  const pctOfBudget = hasBudget ? round2((totalSpend / totalBudget) * 100) : null

  const eventLanding = computeProjectedLanding(totalSpend, eventDates)
  const projectedLandingPct = eventLanding && hasBudget ? round2((eventLanding.projectedTotal / totalBudget) * 100) : null

  const topVendors = vendorRows.slice(0, CONCENTRATION_VENDOR_COUNT)
  const concentrationPct = round2(topVendors.reduce((s, v) => s + (v.pct_of_total_spend ?? 0), 0))

  const kpi: ExecutiveBrief['kpi'] = {
    spendVsBudgetValue: formatINRCompact(totalSpend),
    spendVsBudgetDelta: hasBudget ? `${formatPercent(pctOfBudget)} of approved budget` : 'No approved budget set',
    spendVsBudgetTone: !hasBudget ? 'neutral' : pctOfBudget! > 100 ? 'bad' : 'neutral',
    projectedLandingValue: projectedLandingPct != null ? formatPercent(projectedLandingPct) : '—',
    projectedLandingTone: projectedLandingPct == null ? 'neutral' : projectedLandingPct > 100 ? 'bad' : 'good',
    vendorConcentrationValue: topVendors.length > 0 ? formatPercent(concentrationPct) : '—',
    vendorConcentrationLabel: `Top ${topVendors.length || CONCENTRATION_VENDOR_COUNT} vendors' share of spend`,
    aboveMedianSpendValue: formatINRCompact(aboveMedianSpend),
    openAmountAtRiskValue: formatINRCompact(openAmountAtRisk),
  }

  // ---- "What changed this week" sentences ---------------------------------------
  // Band 2 of the Brief (§5): plain sentences computed from the same rows the
  // tiles/charts above already fetched, not a new query — "most viewers read
  // the sentence and not the chart" (§6 fix #3).

  const sentences: string[] = []

  const overBudgetCount = leagueTable.filter((r) => r.pctOfBudget != null && r.pctOfBudget >= 90).length
  if (overBudgetCount > 0) {
    const windowNote =
      eventDates?.ends_on != null
        ? ` with ${Math.max(0, differenceInCalendarDays(new Date(eventDates.ends_on), now))} days left in the event`
        : ''
    sentences.push(`${overBudgetCount} department${overBudgetCount === 1 ? ' is' : 's are'} at or above 90% of budget${windowNote}.`)
  }

  const totalAtRisk = leagueTable.reduce((s, r) => s + r.amountAtRisk, 0)
  const topRisk = [...leagueTable].filter((r) => r.amountAtRisk > 0).sort((a, b) => b.amountAtRisk - a.amountAtRisk)[0]
  if (topRisk) {
    sentences.push(
      `${formatINRCompact(totalAtRisk)} sits in open issues across the event, led by ${topRisk.departmentName} at ${formatINRCompact(topRisk.amountAtRisk)}.`
    )
  }

  if (topVendors.length > 0) {
    sentences.push(`The top ${topVendors.length} vendors carry ${formatPercent(concentrationPct)} of this event's spend.`)
  }

  if (projectedLandingPct != null) {
    sentences.push(
      projectedLandingPct > 100
        ? `At the current pace, spend projects to ${formatPercent(projectedLandingPct)} of budget by the event's end.`
        : `At the current pace, spend is projecting to land at ${formatPercent(projectedLandingPct)} of budget.`
    )
  }

  return {
    eventName: eventRow?.name ?? null,
    eventDates,
    kpi,
    sentences,
    leagueTable,
    attentionPoints,
    needsDecision,
    errors: {
      league: budgetErr ?? docCoverageErr ?? riskErr ?? vendorErr ?? eventErr ?? overpaymentErr,
      needsDecision: issuesErr ?? entryDeptErr,
    },
  }
}
