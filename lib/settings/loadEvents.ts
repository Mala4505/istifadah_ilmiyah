import type { SupabaseClient } from '@supabase/supabase-js'
import { getAllEvents, getSelectedEvent } from '@/lib/events/current'
import type { Event } from '@/lib/events/types'
import {
  getCachedDepartments,
  getCachedAdminHeads,
  getCachedZones,
  getCachedBudgetHeads,
} from '@/lib/cache/reference-data'
import type { MasterOption } from '@/components/events/create-event-form'

export interface EventMembership {
  departmentIds: number[]
  adminHeadIds: number[]
  zoneIds: number[]
  budgetHeadIds: number[]
  subDepartmentIds: number[]
}

export interface EventsData {
  events: Event[]
  selectedEvent: Event | null
  selectedEventId: number | null
  eventDepartmentOptions: MasterOption[]
  eventAdminHeadOptions: MasterOption[]
  eventZoneOptions: MasterOption[]
  eventBudgetHeadOptions: MasterOption[]
  eventSubDepartmentOptions: MasterOption[]
  selectedMembership: EventMembership
}

/**
 * Events area loader (Phase 2 Settings redesign). Lifts verbatim the
 * event-option assembly and the selected-event membership lookup that used
 * to sit inline in the old single Settings page's `SettingsPage` body --
 * same `is_active` filters, same sorts, same `${head_number}. ${name}` /
 * `${zone_number}. ${name}` label formatting, same `short_label ?? raw_label`
 * fallback, same `if (selectedEvent)` guard on the membership fetch and the
 * same `selectedMembership` shape.
 *
 * Reuses the same cached reference-data fetchers the page used; the three
 * department-visibility-scoped ones (`getCachedAdminHeads` / `getCachedZones`
 * / `getCachedBudgetHeads`) need the caller's `userId` for their per-user
 * cache key, so this loader takes it too.
 */
export async function loadEvents(
  supabase: SupabaseClient,
  userId: string,
): Promise<EventsData> {
  const [events, selectedEvent] = await Promise.all([getAllEvents(), getSelectedEvent()])
  const selectedEventId = selectedEvent?.id ?? null

  const [departmentData, adminHeadData, zoneData, budgetHeadData, subDepartmentRes] =
    await Promise.all([
      getCachedDepartments(supabase),
      getCachedAdminHeads(supabase, userId),
      getCachedZones(supabase, userId),
      getCachedBudgetHeads(supabase, userId),
      supabase.from('sub_department').select('id, name').eq('is_active', true).order('name'),
    ])

  const eventDepartmentOptions: MasterOption[] = departmentData
    .filter((row) => row.is_active)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => ({
      id: row.id,
      label: row.name,
    }))
  const eventAdminHeadOptions: MasterOption[] = adminHeadData
    .filter((row) => row.is_active)
    .sort((a, b) => a.head_number - b.head_number)
    .map((row) => ({
      id: row.id,
      label: `${row.head_number}. ${row.name}`,
    }))
  const eventZoneOptions: MasterOption[] = zoneData
    .filter((row) => row.is_active)
    .sort((a, b) => a.zone_number - b.zone_number)
    .map((row) => ({
      id: row.id,
      label: `${row.zone_number}. ${row.name}`,
    }))
  const eventBudgetHeadOptions: MasterOption[] = [...budgetHeadData]
    .sort((a, b) => a.raw_label.localeCompare(b.raw_label))
    .map((row) => ({
      id: row.id,
      label: row.short_label ?? row.raw_label,
    }))
  const eventSubDepartmentOptions: MasterOption[] = (subDepartmentRes.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
  }))

  let selectedMembership: EventMembership = {
    departmentIds: [],
    adminHeadIds: [],
    zoneIds: [],
    budgetHeadIds: [],
    subDepartmentIds: [],
  }
  if (selectedEvent) {
    const [depMem, headMem, zoneMem, budgetMem, subDepartmentMem] = await Promise.all([
      supabase.from('event_department').select('department_id').eq('event_id', selectedEvent.id),
      supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEvent.id),
      supabase.from('event_zone').select('zone_id').eq('event_id', selectedEvent.id),
      supabase.from('event_budget_head').select('budget_head_id').eq('event_id', selectedEvent.id),
      supabase.from('event_sub_department').select('sub_department_id').eq('event_id', selectedEvent.id),
    ])
    selectedMembership = {
      departmentIds: (depMem.data ?? []).map((r) => r.department_id),
      adminHeadIds: (headMem.data ?? []).map((r) => r.admin_head_id),
      zoneIds: (zoneMem.data ?? []).map((r) => r.zone_id),
      budgetHeadIds: (budgetMem.data ?? []).map((r) => r.budget_head_id),
      subDepartmentIds: (subDepartmentMem.data ?? []).map((r) => r.sub_department_id),
    }
  }

  return {
    events,
    selectedEvent,
    selectedEventId,
    eventDepartmentOptions,
    eventAdminHeadOptions,
    eventZoneOptions,
    eventBudgetHeadOptions,
    eventSubDepartmentOptions,
    selectedMembership,
  }
}
