/**
 * Data loader for the Integrity surface (reporting-blueprint.md §5: the
 * review function's view -- what the modules are waiting on, what is flagged,
 * and where money could be leaking). Carries the former page.tsx sections:
 * Hub-status ageing, open issues digest, and compliance & leakage.
 *
 * Split out of the monolithic loadReportsData / loadAnalyticsData so this
 * surface queries only its own three views (§8 Phase Three: "Page weight and
 * query time drop."). Every view exposes `event_id` as a plain output column
 * (20260822000007 / 20260822000011), filtered here at the query site.
 *
 * Prior-period comparison (§6 fix #1) differs from the Budget surface: these
 * three sections' rows each carry a per-row timestamp from the current fetch,
 * so 'prior_week' computes a best-effort week-old proxy from the
 * already-fetched rows at zero extra query cost (7-days-ago cutoff), exactly
 * as the former page.tsx did. 'prior_event' re-runs each view against the
 * previous event's id. The loader resolves the final `previous` figure per
 * section given `compareBasis`, mirroring the former page.tsx's
 * `ageingTotalPrevious` / `openIssuesAtRiskPrevious` /
 * `complianceAtRiskPrevious` expressions.
 *
 * The v_open_issues / v_compliance_summary event filter is the `.or(event_id
 * .eq.X, event_id.is.null)` branch, NOT a plain `.eq('event_id', X)` -- a
 * plain equality silently drops every open finding whose event can't be
 * resolved (document-/batch-level exceptions, vendor-level flags), the
 * Phase 0 §0.2 bug. Same for the prior-event versions of those two queries.
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  ROW_CAP,
  resolvePreviousEvent,
  buildTrailingWeeklySeries,
  round2Local,
  type HubAgeingRow,
  type OpenIssueRow,
  type ComplianceRow,
  type ExceptionHeatmapRow,
  type AmountAtRiskByStatusRow,
} from '@/lib/reports/sections/shared'

export type IntegritySurfaceData = {
  eventName: string | null
  previousEventName: string | null
  /** Prior-event query round error, surfaced as one page-level line (mirrors
   *  the former page.tsx's single `priorEvent.error` line). */
  priorError: string | null
  hubAgeing: {
    rows: HubAgeingRow[]
    error: string | null
    buckets: { '0-2': number; '3-7': number; '8+': number }
    series: number[]
    previousCount: number | null
  }
  openIssues: {
    rows: OpenIssueRow[]
    error: string | null
    series: number[]
    atRiskTotal: number
    previousAtRisk: number | null
  }
  compliance: {
    rows: ComplianceRow[]
    error: string | null
    series: number[]
    atRiskTotal: number
    byType: [string, number][]
    previousAtRisk: number | null
  }
  /** D-01 exception heat map (v_exception_heatmap). Same `.or(event_id.eq.X,
   *  event_id.is.null)` scoping as v_open_issues — the view carries
   *  entry-less findings (vendor-level flag, batch-level exception) with a
   *  null event_id. */
  exceptionHeatmap: {
    rows: ExceptionHeatmapRow[]
    error: string | null
    previousTotalAtRisk: number | null
  }
  /** D-02 amount-at-risk waterfall (v_amount_at_risk_by_status across ALL
   *  statuses) plus the event's total non-void spend for the top stage. */
  amountAtRiskWaterfall: {
    rows: AmountAtRiskByStatusRow[]
    totalSpend: number
    error: string | null
  }
}

const AGEING_SELECT =
  'entry_id, department_id, ubbl_number, hub_status_code, hub_status_label, hub_status_changed_at, days_in_status, age_bucket'
const ISSUES_SELECT =
  'source_table, id, entry_id, issue_type, severity, amount_at_risk, description, status, created_at'
const COMPLIANCE_SELECT =
  'id, flag_type, severity, description, amount_at_risk, status, entry_id, vendor_id, vendor_display_name, department_id, department_name, created_at, last_detected_at, related_entry_ids'
const HEATMAP_SELECT =
  'source_table, issue_type, severity, department_id, department_name, issue_count, amount_at_risk'
const AT_RISK_STATUS_SELECT = 'source_table, status, issue_count, amount_at_risk'

const sumBy = <T extends Record<string, unknown>>(rows: T[] | null | undefined, key: keyof T) =>
  (rows ?? []).reduce((s, r) => s + ((r[key] as number | null) ?? 0), 0)

/**
 * Perf remediation Phase 2.4 (docs/performance-remediation-plan.md):
 * `totalSpend` is passed in already computed by loadHeroMetrics -- this
 * module's own comment at the old query site said as much ("mirrors
 * lib/reports/hero-metrics.ts's totalSpend") but still re-ran the same
 * `entries` fetch and JS reduce a second time, concurrently with hero's own,
 * on every /reports load. Same fix already applied to loadExecutiveBrief
 * (lib/reports/executive-brief.ts).
 */
export async function loadIntegritySurface(
  compareBasis: CompareBasis,
  totalSpend: number,
  selectedEvent: Event | null
): Promise<IntegritySurfaceData> {
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null

  const [ageingRes, issuesRes, complianceRes, heatmapRes, atRiskRes] = await Promise.all([
    supabase
      .from('v_hub_status_ageing')
      .select(AGEING_SELECT)
      .eq('event_id', eventId)
      .order('days_in_status', { ascending: false })
      .limit(ROW_CAP)
      .returns<HubAgeingRow[]>(),
    // Phase 0 §0.2: keep rows whose event can't be resolved (document-/
    // batch-level exceptions, vendor-level flags) regardless of the active
    // event -- a plain `.eq('event_id', eventId)` silently drops them.
    eventId === null
      ? supabase.from('v_open_issues').select(ISSUES_SELECT).limit(ROW_CAP).returns<OpenIssueRow[]>()
      : supabase
          .from('v_open_issues')
          .select(ISSUES_SELECT)
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(ROW_CAP)
          .returns<OpenIssueRow[]>(),
    eventId === null
      ? supabase.from('v_compliance_summary').select(COMPLIANCE_SELECT).limit(ROW_CAP).returns<ComplianceRow[]>()
      : supabase
          .from('v_compliance_summary')
          .select(COMPLIANCE_SELECT)
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(ROW_CAP)
          .returns<ComplianceRow[]>(),
    // D-01 / D-02 union flags + reconciliation_exception the same way
    // v_open_issues does, so the same Phase 0 §0.2 rule applies: keep rows
    // whose event can't be resolved regardless of the active event.
    eventId === null
      ? supabase.from('v_exception_heatmap').select(HEATMAP_SELECT).limit(ROW_CAP).returns<ExceptionHeatmapRow[]>()
      : supabase
          .from('v_exception_heatmap')
          .select(HEATMAP_SELECT)
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(ROW_CAP)
          .returns<ExceptionHeatmapRow[]>(),
    eventId === null
      ? supabase
          .from('v_amount_at_risk_by_status')
          .select(AT_RISK_STATUS_SELECT)
          .limit(ROW_CAP)
          .returns<AmountAtRiskByStatusRow[]>()
      : supabase
          .from('v_amount_at_risk_by_status')
          .select(AT_RISK_STATUS_SELECT)
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(ROW_CAP)
          .returns<AmountAtRiskByStatusRow[]>(),
  ])

  const ageingRows = ageingRes.data ?? []
  const issueRows = issuesRes.data ?? []
  const complianceRows = complianceRes.data ?? []
  const heatmapRows = heatmapRes.data ?? []
  const atRiskRows = atRiskRes.data ?? []

  const ageingBuckets = {
    '0-2': ageingRows.filter((r) => r.age_bucket === '0-2').length,
    '3-7': ageingRows.filter((r) => r.age_bucket === '3-7').length,
    '8+': ageingRows.filter((r) => r.age_bucket === '8+').length,
  }

  const ageingSeries = buildTrailingWeeklySeries(ageingRows, (r) => r.hub_status_changed_at, (rs) => rs.length)
  const issuesSeries = buildTrailingWeeklySeries(
    issueRows,
    (r) => r.created_at,
    (rs) => round2Local(rs.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0))
  )
  const complianceSeries = buildTrailingWeeklySeries(
    complianceRows,
    (r) => r.created_at,
    (rs) => round2Local(rs.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0))
  )

  const openIssuesAtRiskTotal = issueRows.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0)
  const complianceTotalAtRisk = complianceRows.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0)

  const complianceByType: [string, number][] = Object.entries(
    complianceRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.flag_type] = (acc[r.flag_type] ?? 0) + 1
      return acc
    }, {})
  ).sort((a, b) => b[1] - a[1])

  // 'prior_week' proxy: rows whose own timestamp is <= 7 days ago -- shifts
  // the figure back a week from already-fetched data, no second query.
  // Directional rather than exact (undercounts rows resolved out since then),
  // same caveat the former page.tsx documented.
  const priorWeekCutoff = new Date(Date.now() - 7 * 86_400_000)

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let prior: {
    ageingCount: number | null
    issuesAtRisk: number | null
    complianceAtRisk: number | null
    heatmapAtRisk: number | null
  } = {
    ageingCount: null,
    issuesAtRisk: null,
    complianceAtRisk: null,
    heatmapAtRisk: null,
  }
  let priorError: string | null = null

  if (previousEvent) {
    const [pAgeing, pIssues, pCompliance, pHeatmap] = await Promise.all([
      supabase
        .from('v_hub_status_ageing')
        .select('age_bucket')
        .eq('event_id', previousEvent.id)
        .limit(ROW_CAP)
        .returns<{ age_bucket: string }[]>(),
      // previousEvent.id is never null here (resolvePreviousEvent guards it),
      // so the `.or()` branch always applies -- same shape as above.
      supabase
        .from('v_open_issues')
        .select('amount_at_risk')
        .or(`event_id.eq.${previousEvent.id},event_id.is.null`)
        .limit(ROW_CAP)
        .returns<{ amount_at_risk: number | null }[]>(),
      supabase
        .from('v_compliance_summary')
        .select('amount_at_risk')
        .or(`event_id.eq.${previousEvent.id},event_id.is.null`)
        .limit(ROW_CAP)
        .returns<{ amount_at_risk: number | null }[]>(),
      supabase
        .from('v_exception_heatmap')
        .select('amount_at_risk')
        .or(`event_id.eq.${previousEvent.id},event_id.is.null`)
        .limit(ROW_CAP)
        .returns<{ amount_at_risk: number | null }[]>(),
    ])
    priorError =
      friendlyDataError(pAgeing.error, 'reports:integrity:priorAgeing') ??
      friendlyDataError(pIssues.error, 'reports:integrity:priorIssues') ??
      friendlyDataError(pCompliance.error, 'reports:integrity:priorCompliance') ??
      friendlyDataError(pHeatmap.error, 'reports:integrity:priorHeatmap')
    prior = {
      ageingCount: (pAgeing.data ?? []).length,
      issuesAtRisk: sumBy(pIssues.data, 'amount_at_risk'),
      complianceAtRisk: sumBy(pCompliance.data, 'amount_at_risk'),
      heatmapAtRisk: sumBy(pHeatmap.data, 'amount_at_risk'),
    }
  }

  const ageingPrevious =
    compareBasis === 'prior_event'
      ? prior.ageingCount
      : compareBasis === 'prior_week'
        ? ageingRows.filter(
            (r) => r.hub_status_changed_at != null && new Date(r.hub_status_changed_at) <= priorWeekCutoff
          ).length
        : null
  const issuesPrevious =
    compareBasis === 'prior_event'
      ? prior.issuesAtRisk
      : compareBasis === 'prior_week'
        ? issueRows.filter((r) => new Date(r.created_at) <= priorWeekCutoff).reduce((s, r) => s + (r.amount_at_risk ?? 0), 0)
        : null
  const compliancePrevious =
    compareBasis === 'prior_event'
      ? prior.complianceAtRisk
      : compareBasis === 'prior_week'
        ? complianceRows
            .filter((r) => new Date(r.created_at) <= priorWeekCutoff)
            .reduce((s, r) => s + (r.amount_at_risk ?? 0), 0)
        : null

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    priorError,
    hubAgeing: {
      rows: ageingRows,
      error: friendlyDataError(ageingRes.error, 'reports:integrity:ageing'),
      buckets: ageingBuckets,
      series: ageingSeries,
      previousCount: ageingPrevious,
    },
    openIssues: {
      rows: issueRows,
      error: friendlyDataError(issuesRes.error, 'reports:integrity:issues'),
      series: issuesSeries,
      atRiskTotal: openIssuesAtRiskTotal,
      previousAtRisk: issuesPrevious,
    },
    compliance: {
      rows: complianceRows,
      error: friendlyDataError(complianceRes.error, 'reports:integrity:compliance'),
      series: complianceSeries,
      atRiskTotal: complianceTotalAtRisk,
      byType: complianceByType,
      previousAtRisk: compliancePrevious,
    },
    exceptionHeatmap: {
      rows: heatmapRows,
      error: friendlyDataError(heatmapRes.error, 'reports:integrity:heatmap'),
      previousTotalAtRisk: compareBasis === 'prior_event' ? prior.heatmapAtRisk : null,
    },
    amountAtRiskWaterfall: {
      rows: atRiskRows,
      totalSpend,
      error: friendlyDataError(atRiskRes.error, 'reports:integrity:atRiskByStatus'),
    },
  }
}
