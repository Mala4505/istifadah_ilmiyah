import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type DepartmentOption,
  type HubStatusRow,
  type SubDepartmentRow,
  type ZoneRow,
} from '@/lib/settings/shape'

export interface HeadRow {
  id: number
  departmentId: number
  headNumber: number
  name: string
}

export interface MasterData {
  departments: DepartmentOption[]
  heads: HeadRow[]
  zones: ZoneRow[]
  subDepartments: SubDepartmentRow[]
  hubStatuses: HubStatusRow[]
}

/**
 * Master-data area loader (Phase 2 Settings redesign). Departments,
 * admin heads, zones and sub-departments are filtered through the
 * selected event's membership tables, exactly as the former
 * `loadSuperadminData` did (with the same "no event resolves -> no
 * filtering" fallback). Hub statuses are global. Sub-department budget
 * amounts come from v_sub_department_budget_vs_actual so the compacted
 * per-department view can still show them.
 */
export async function loadMasterData(
  supabase: SupabaseClient,
  eventId?: number | null,
): Promise<MasterData> {
  const selectedEventId = eventId ?? null

  const [
    { data: departmentsData },
    { data: headsData },
    { data: zonesData },
    { data: subDepartmentsData },
    { data: hubStatusesData },
    { data: departmentMembershipData },
    { data: headMembershipData },
    { data: zoneMembershipData },
    { data: subDepartmentMembershipData },
    { data: subDepartmentBudgetData },
  ] = await Promise.all([
    supabase.from('department').select('id, name').order('name'),
    supabase
      .from('admin_head')
      .select('id, department_id, head_number, name')
      .order('department_id')
      .order('head_number'),
    supabase
      .from('zone')
      .select('id, department_id, zone_number, name')
      .order('department_id')
      .order('zone_number'),
    supabase.from('sub_department').select('id, department_id, name, is_active').order('name'),
    supabase
      .from('hub_status')
      .select('id, code, label, sort_order, is_exportable, is_terminal')
      .order('sort_order'),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { department_id: number }[] })
      : supabase.from('event_department').select('department_id').eq('event_id', selectedEventId),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { admin_head_id: number }[] })
      : supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEventId),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { zone_id: number }[] })
      : supabase.from('event_zone').select('zone_id').eq('event_id', selectedEventId),
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

  const departmentMemberIds = new Set((departmentMembershipData ?? []).map((r) => r.department_id))
  const headMemberIds = new Set((headMembershipData ?? []).map((r) => r.admin_head_id))
  const zoneMemberIds = new Set((zoneMembershipData ?? []).map((r) => r.zone_id))
  const subDepartmentMemberIds = new Set(
    (subDepartmentMembershipData ?? []).map((r) => r.sub_department_id),
  )
  const budgetById = new Map<number, number | null>()
  for (const row of subDepartmentBudgetData ?? []) {
    budgetById.set(row.sub_department_id as number, row.budget_amount as number | null)
  }

  const departments: DepartmentOption[] = (departmentsData ?? [])
    .filter((d) => selectedEventId === null || departmentMemberIds.has(d.id as number))
    .map((d) => ({ id: d.id as number, name: d.name as string }))

  const heads: HeadRow[] = (headsData ?? [])
    .filter((row) => selectedEventId === null || headMemberIds.has(row.id as number))
    .map((row) => ({
      id: row.id as number,
      departmentId: row.department_id as number,
      headNumber: row.head_number as number,
      name: row.name as string,
    }))

  const zones: ZoneRow[] = (zonesData ?? [])
    .filter((row) => selectedEventId === null || zoneMemberIds.has(row.id as number))
    .map((row) => ({
      id: row.id as number,
      departmentId: row.department_id as number,
      zoneNumber: row.zone_number as number,
      name: row.name as string,
    }))

  const subDepartments: SubDepartmentRow[] = (subDepartmentsData ?? [])
    .filter((row) => selectedEventId === null || subDepartmentMemberIds.has(row.id as number))
    .map((row) => ({
      id: row.id as number,
      departmentId: row.department_id as number,
      name: row.name as string,
      isActive: row.is_active as boolean,
      budgetAmount: budgetById.get(row.id as number) ?? null,
    }))

  const hubStatuses: HubStatusRow[] = (hubStatusesData ?? []).map((row) => ({
    id: row.id as number,
    code: row.code as string,
    label: row.label as string,
    sortOrder: row.sort_order as number,
    isExportable: row.is_exportable as boolean,
    isTerminal: row.is_terminal as boolean,
  }))

  return { departments, heads, zones, subDepartments, hubStatuses }
}
