/**
 * Data loader for the Budget & Spend surface (reporting-blueprint.md §5:
 * "Department and administrative heads. Where the money went, and where it
 * is heading."). Carries the former page.tsx sections: budget vs actual by
 * head, by department, by sub-department, and spend by zone.
 *
 * Split out of the monolithic loadReportsData so this surface queries only
 * its own four views (§8 Phase Three: "Page weight and query time drop.").
 * Every view exposes `event_id` as a plain output column (20260822000007),
 * filtered here at the query site against the active event.
 *
 * Prior-period comparison (§6 fix #1): when the compare basis is
 * 'prior_event', the previous event is resolved once and each view re-run
 * against it for a headline delta. 'prior_week' has no effect here -- none
 * of these four aggregates carry an as-of dimension a week-old snapshot
 * could be re-derived from (same reasoning the former page.tsx documented).
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  ROW_CAP,
  resolvePreviousEvent,
  type BudgetVsActualRow,
  type DepartmentBudgetVsActualRow,
  type SubDepartmentBudgetVsActualRow,
  type ZoneSpendRow,
} from '@/lib/reports/sections/shared'

export type BudgetSurfaceData = {
  eventName: string | null
  previousEventName: string | null
  byHead: { rows: BudgetVsActualRow[]; error: string | null; previousActualTotal: number | null }
  byDepartment: { rows: DepartmentBudgetVsActualRow[]; error: string | null; previousActualTotal: number | null }
  bySubDepartment: { rows: SubDepartmentBudgetVsActualRow[]; error: string | null; previousActualTotal: number | null }
  byZone: { rows: ZoneSpendRow[]; error: string | null; previousTotal: number | null }
}

const HEAD_SELECT =
  'budget_head_id, raw_label, short_label, department_id, approved_amount, utilised_amount, balance_amount, actual_amount, entry_count, pct_of_approved, budget_status_note'
const DEPT_SELECT =
  'department_id, department_name, as_of, budget_amount, actual_amount, entry_count, pct_of_budget, budget_status_note'
const SUB_DEPT_SELECT =
  'sub_department_id, sub_department_name, department_id, department_name, as_of, budget_amount, actual_amount, entry_count, pct_of_budget, budget_status_note'
const ZONE_SELECT = 'zone_id, zone_name, zone_number, department_id, entry_count, total_amount'

const sumBy = <T extends Record<string, unknown>>(rows: T[] | null | undefined, key: keyof T) =>
  (rows ?? []).reduce((s, r) => s + ((r[key] as number | null) ?? 0), 0)

/**
 * Perf remediation Phase 2.2 (docs/performance-remediation-plan.md):
 * `selectedEvent` is resolved once by the caller (the page already
 * called getSelectedEvent()) and passed in, rather than this loader
 * re-resolving it itself -- same reasoning as loadHeroMetrics/
 * loadExecutiveBrief taking `eventId` as a parameter.
 */
export async function loadBudgetSurface(compareBasis: CompareBasis, selectedEvent: Event | null): Promise<BudgetSurfaceData> {
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null

  const [headRes, deptRes, subDeptRes, zoneRes] = await Promise.all([
    supabase
      .from('v_budget_vs_actual')
      .select(HEAD_SELECT)
      .eq('event_id', eventId)
      .order('actual_amount', { ascending: false, nullsFirst: false })
      .returns<BudgetVsActualRow[]>(),
    supabase
      .from('v_department_budget_vs_actual')
      .select(DEPT_SELECT)
      .eq('event_id', eventId)
      .order('actual_amount', { ascending: false, nullsFirst: false })
      .returns<DepartmentBudgetVsActualRow[]>(),
    supabase
      .from('v_sub_department_budget_vs_actual')
      .select(SUB_DEPT_SELECT)
      .eq('event_id', eventId)
      .order('actual_amount', { ascending: false, nullsFirst: false })
      .returns<SubDepartmentBudgetVsActualRow[]>(),
    supabase
      .from('v_zone_spend')
      .select(ZONE_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .returns<ZoneSpendRow[]>(),
  ])

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let prior: {
    headActualTotal: number | null
    deptActualTotal: number | null
    subDeptActualTotal: number | null
    zoneTotal: number | null
  } = { headActualTotal: null, deptActualTotal: null, subDeptActualTotal: null, zoneTotal: null }

  if (previousEvent) {
    const [pHead, pDept, pSub, pZone] = await Promise.all([
      supabase.from('v_budget_vs_actual').select('actual_amount').eq('event_id', previousEvent.id).returns<{ actual_amount: number | null }[]>(),
      supabase
        .from('v_department_budget_vs_actual')
        .select('actual_amount')
        .eq('event_id', previousEvent.id)
        .returns<{ actual_amount: number | null }[]>(),
      supabase
        .from('v_sub_department_budget_vs_actual')
        .select('actual_amount')
        .eq('event_id', previousEvent.id)
        .returns<{ actual_amount: number | null }[]>(),
      supabase.from('v_zone_spend').select('total_amount').eq('event_id', previousEvent.id).returns<{ total_amount: number | null }[]>(),
    ])
    prior = {
      headActualTotal: sumBy(pHead.data, 'actual_amount'),
      deptActualTotal: sumBy(pDept.data, 'actual_amount'),
      subDeptActualTotal: sumBy(pSub.data, 'actual_amount'),
      zoneTotal: sumBy(pZone.data, 'total_amount'),
    }
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    byHead: {
      rows: headRes.data ?? [],
      error: friendlyDataError(headRes.error, 'reports:budget:head'),
      previousActualTotal: prior.headActualTotal,
    },
    byDepartment: {
      rows: deptRes.data ?? [],
      error: friendlyDataError(deptRes.error, 'reports:budget:dept'),
      previousActualTotal: prior.deptActualTotal,
    },
    bySubDepartment: {
      rows: subDeptRes.data ?? [],
      error: friendlyDataError(subDeptRes.error, 'reports:budget:subDept'),
      previousActualTotal: prior.subDeptActualTotal,
    },
    byZone: {
      rows: (zoneRes.data ?? []).slice(0, ROW_CAP),
      error: friendlyDataError(zoneRes.error, 'reports:budget:zone'),
      previousTotal: prior.zoneTotal,
    },
  }
}
