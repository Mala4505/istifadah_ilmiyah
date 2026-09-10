import type { SupabaseClient } from '@supabase/supabase-js'
import type { BudgetHeadRow, HeadOption } from '@/components/admin/budget-head-table'
import { extractDepartmentName } from '@/lib/settings/shape'

export interface BudgetHeadsData {
  budgetHeads: BudgetHeadRow[]
  heads: HeadOption[]
}

/**
 * Budget Heads area loader (Phase 2 Settings redesign). `heads` (the
 * admin-head mapping targets) is event-scoped exactly as the former
 * `loadSuperadminData` scoped it; the budget-head list itself is not
 * event-scoped -- it is the full imported set, unmapped rows included.
 */
export async function loadBudgetHeads(
  supabase: SupabaseClient,
  eventId?: number | null,
): Promise<BudgetHeadsData> {
  const selectedEventId = eventId ?? null

  const [{ data: budgetHeadsData }, { data: headsData }, { data: headMembershipData }] =
    await Promise.all([
      supabase
        .from('budget_head')
        .select('id, raw_label, short_label, department_id, head_id, department:department_id(name)')
        .order('raw_label'),
      supabase
        .from('admin_head')
        .select('id, department_id, head_number, name')
        .order('department_id')
        .order('head_number'),
      selectedEventId === null
        ? Promise.resolve({ data: [] as { admin_head_id: number }[] })
        : supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEventId),
    ])

  const headMemberIds = new Set((headMembershipData ?? []).map((r) => r.admin_head_id))

  const budgetHeads: BudgetHeadRow[] = (budgetHeadsData ?? []).map((row) => ({
    id: row.id as number,
    rawLabel: row.raw_label as string,
    shortLabel: row.short_label as string | null,
    departmentId: row.department_id as number | null,
    departmentName: extractDepartmentName(row.department),
    headId: row.head_id as number | null,
  }))

  const heads: HeadOption[] = (headsData ?? [])
    .filter((row) => selectedEventId === null || headMemberIds.has(row.id as number))
    .map((row) => ({
      id: row.id as number,
      departmentId: row.department_id as number,
      headNumber: row.head_number as number,
      name: row.name as string,
    }))

  return { budgetHeads, heads }
}
