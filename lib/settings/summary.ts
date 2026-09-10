import type { SupabaseClient } from '@supabase/supabase-js'
import { getSelectedEventId } from '@/lib/events/current'

/**
 * Count-only figures for the plain Settings list (Phase 2, Direction A).
 * Every field is a bare number rendered as sublabel text under its row --
 * never a badge, never an alert. All queries use `head: true,
 * count: 'exact'` so the landing page pulls no row payloads: the full
 * per-area data loads only once you open that area's sub-route.
 */
export interface SettingsSummary {
  activeStaff: number
  pendingStaff: number
  budgetHeadCount: number
  unmappedBudgetHeads: number
  vendorCount: number
  unconfirmedVendors: number
  subDeptBudgetSet: number
  subDeptBudgetMissing: number
  pastEventCount: number
}

async function countOf(query: PromiseLike<{ count: number | null }>): Promise<number> {
  const { count } = await query
  return count ?? 0
}

export async function getSettingsSummary(supabase: SupabaseClient): Promise<SettingsSummary> {
  const selectedEventId = await getSelectedEventId()

  const eventSubDeptTotalQuery =
    selectedEventId === null
      ? Promise.resolve({ count: 0 })
      : supabase
          .from('event_sub_department')
          .select('*', { head: true, count: 'exact' })
          .eq('event_id', selectedEventId)

  const subDeptBudgetSetQuery =
    selectedEventId === null
      ? Promise.resolve({ count: 0 })
      : supabase
          .from('v_sub_department_budget_vs_actual')
          .select('*', { head: true, count: 'exact' })
          .eq('event_id', selectedEventId)
          .not('budget_amount', 'is', null)

  const [
    activeStaff,
    pendingStaff,
    budgetHeadCount,
    unmappedBudgetHeads,
    vendorCount,
    unconfirmedVendors,
    eventSubDeptTotal,
    subDeptBudgetSet,
    pastEventCount,
  ] = await Promise.all([
    countOf(
      supabase.from('staff_profile').select('*', { head: true, count: 'exact' }).eq('is_active', true),
    ),
    countOf(
      supabase
        .from('staff_profile')
        .select('*', { head: true, count: 'exact' })
        .eq('is_active', false),
    ),
    countOf(supabase.from('budget_head').select('*', { head: true, count: 'exact' })),
    countOf(
      supabase
        .from('budget_head')
        .select('*', { head: true, count: 'exact' })
        .is('head_id', null),
    ),
    countOf(supabase.from('vendor').select('*', { head: true, count: 'exact' })),
    countOf(
      supabase.from('vendor').select('*', { head: true, count: 'exact' }).eq('is_confirmed', false),
    ),
    countOf(eventSubDeptTotalQuery),
    countOf(subDeptBudgetSetQuery),
    countOf(
      supabase.from('event').select('*', { head: true, count: 'exact' }).eq('is_current', false),
    ),
  ])

  return {
    activeStaff,
    pendingStaff,
    budgetHeadCount,
    unmappedBudgetHeads,
    vendorCount,
    unconfirmedVendors,
    subDeptBudgetSet,
    subDeptBudgetMissing: Math.max(0, eventSubDeptTotal - subDeptBudgetSet),
    pastEventCount,
  }
}
