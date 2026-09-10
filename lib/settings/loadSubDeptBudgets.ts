import type { SupabaseClient } from '@supabase/supabase-js'
import type { SubDepartmentBudgetRow } from '@/components/settings/sub-department-budget-table'

export interface SubDeptBudgetsData {
  rows: SubDepartmentBudgetRow[]
}

/**
 * Sub-department budgets area loader (Phase 2 Settings redesign). Same
 * event-membership scoping the former `loadSuperadminData` applied: only
 * sub-departments in the selected event are listed, each carrying its
 * latest allocated budget (or null) from
 * v_sub_department_budget_vs_actual. Rows are pre-sorted department then
 * sub-department, matching the old inline sort in page.tsx.
 */
export async function loadSubDeptBudgets(
  supabase: SupabaseClient,
  eventId?: number | null,
): Promise<SubDeptBudgetsData> {
  const selectedEventId = eventId ?? null

  const [
    { data: departmentsData },
    { data: subDepartmentsData },
    { data: subDepartmentMembershipData },
    { data: subDepartmentBudgetData },
  ] = await Promise.all([
    supabase.from('department').select('id, name').order('name'),
    supabase.from('sub_department').select('id, department_id, name, is_active').order('name'),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { sub_department_id: number }[] })
      : supabase
          .from('event_sub_department')
          .select('sub_department_id')
          .eq('event_id', selectedEventId),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { sub_department_id: number; budget_amount: number | null }[] })
      : supabase
          .from('v_sub_department_budget_vs_actual')
          .select('sub_department_id, budget_amount')
          .eq('event_id', selectedEventId),
  ])

  const departmentNameById = new Map<number, string>(
    (departmentsData ?? []).map((row) => [row.id as number, row.name as string]),
  )
  const subDepartmentMemberIds = new Set(
    (subDepartmentMembershipData ?? []).map((r) => r.sub_department_id),
  )
  const budgetById = new Map<number, number | null>()
  for (const row of subDepartmentBudgetData ?? []) {
    budgetById.set(row.sub_department_id as number, row.budget_amount as number | null)
  }

  const rows: SubDepartmentBudgetRow[] = (subDepartmentsData ?? [])
    .filter((row) => selectedEventId === null || subDepartmentMemberIds.has(row.id as number))
    .map((row) => ({
      id: row.id as number,
      departmentName: departmentNameById.get(row.department_id as number) ?? '—',
      name: row.name as string,
      budgetAmount: budgetById.get(row.id as number) ?? null,
    }))
    .sort((a, b) => a.departmentName.localeCompare(b.departmentName) || a.name.localeCompare(b.name))

  return { rows }
}
