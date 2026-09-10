import type { SupabaseClient } from '@supabase/supabase-js'
import type { StaffRow } from '@/components/admin/users-table'
import { extractDepartmentIds, type DepartmentOption } from '@/lib/settings/shape'

export interface UsersData {
  departments: DepartmentOption[]
  staff: StaffRow[]
}

/**
 * Users & Roles area loader (Phase 2 Settings redesign). The department
 * list is event-scoped exactly as the former `loadSuperadminData` scoped
 * it -- the create-user dialog and the per-row department picker only
 * offer departments that belong to the selected event.
 */
export async function loadUsers(
  supabase: SupabaseClient,
  eventId?: number | null,
): Promise<UsersData> {
  const selectedEventId = eventId ?? null

  const [{ data: departmentsData }, { data: staffData }, { data: departmentMembershipData }] =
    await Promise.all([
      supabase.from('department').select('id, name').order('name'),
      supabase
        .from('staff_profile')
        .select(
          'id, display_name, role, is_active, its_number, contact_email, staff_department(department_id)',
        )
        .order('display_name'),
      selectedEventId === null
        ? Promise.resolve({ data: [] as { department_id: number }[] })
        : supabase.from('event_department').select('department_id').eq('event_id', selectedEventId),
    ])

  const departmentMemberIds = new Set((departmentMembershipData ?? []).map((r) => r.department_id))

  const departments: DepartmentOption[] = (departmentsData ?? [])
    .filter((department) => selectedEventId === null || departmentMemberIds.has(department.id as number))
    .map((department) => ({ id: department.id as number, name: department.name as string }))

  const staff: StaffRow[] = (staffData ?? []).map((row) => ({
    id: row.id as string,
    displayName: row.display_name as string,
    itsNumber: row.its_number as string | null,
    contactEmail: row.contact_email as string | null,
    role: row.role as StaffRow['role'],
    departmentIds: extractDepartmentIds(row.staff_department),
    isActive: row.is_active as boolean,
  }))

  return { departments, staff }
}
