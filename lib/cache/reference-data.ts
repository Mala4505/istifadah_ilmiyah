import { unstable_cache } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Perf audit Phase 2 (docs/perf-ux-audit-checklist.md): department, budget
 * head, admin head, zone, cost center, entry status, and hub status barely
 * change (a handful of times a term per the checklist) but were re-queried
 * from Postgres on every navigation. Cached here with a short revalidate
 * window and invalidated eagerly by the admin mutations that change them
 * (see REFERENCE_DATA_TAGS). As of this writing the only such mutation is
 * `updateBudgetHeadMapping` (lib/actions/admin.ts) -- department, admin_head,
 * zone, cost_center, entry_status, and hub_status have no admin-writable
 * path in the app yet (RLS denies authenticated insert/update/delete on all
 * but budget_head/cost_center; those rows are seeded and grow only via the
 * service-role importer or a future admin screen, per
 * 20260808000026_rls_policies.sql's own comments). Wire a revalidateTag call
 * for any of the other six the moment a mutation for them is built.
 *
 * RLS split (supabase/migrations/20260808000026_rls_policies.sql,
 * 20260819000003_role_rbac_v2.sql) matters here: `department`, `cost_center`,
 * `entry_status`, and `hub_status` gate on `private.is_staff()` only -- every
 * authenticated staff member reads the same rows, so one cache entry serves
 * everyone. `admin_head`, `zone`, and `budget_head` additionally gate through
 * `private.can_see_department()`, which returns true unconditionally for
 * admin-or-above but only for a department-role account's own assigned
 * department(s) (staff_department). Caching those three with a single global
 * key would let whichever role's request happens to run first populate the
 * cache for every other role for the rest of the revalidate window --
 * silently truncating the list for an admin, or leaking other departments'
 * admin-head/zone names to a department account. The fix is a per-user cache
 * key (`userId`), same principle as getCachedStaffProfile
 * (lib/export/auth.ts) -- not a security fix on its own (RLS still runs on
 * every cache miss), just keeping the *cache* from crossing the same
 * visibility boundary RLS already draws.
 *
 * These fetchers return the FULL table (every row RLS lets the caller see --
 * active and inactive, every department), unfiltered. Every existing call
 * site applies its own is_active / event-membership / department_id
 * filtering in JS on top of the cached array. That's deliberate: some
 * consumers (dropdown population) only want active rows for the selected
 * event, others (settings' admin table, exceptions' variance-row labelling)
 * need inactive/retired rows too so a since-deactivated department or budget
 * head still resolves a name instead of going blank. One unfiltered cache
 * per table serves both without either consumer changing behavior.
 */

const REVALIDATE_SECONDS = 180

export const REFERENCE_DATA_TAGS = {
  department: 'ref:department',
  budgetHead: 'ref:budget_head',
  adminHead: 'ref:admin_head',
  zone: 'ref:zone',
  costCenter: 'ref:cost_center',
  entryStatus: 'ref:entry_status',
  hubStatus: 'ref:hub_status',
} as const

export interface CachedDepartment {
  id: number
  name: string
  is_active: boolean
}

export interface CachedBudgetHead {
  id: number
  raw_label: string
  short_label: string | null
  department_id: number | null
}

export interface CachedAdminHead {
  id: number
  name: string
  head_number: number
  department_id: number
  is_active: boolean
}

export interface CachedZone {
  id: number
  name: string
  zone_number: number
  department_id: number
  is_active: boolean
}

export interface CachedCostCenter {
  id: number
  name: string
}

export interface CachedEntryStatus {
  id: number
  code: string
  label: string
  source_system: string
}

export interface CachedHubStatus {
  id: number
  code: string
  label: string
  sort_order: number
  is_exportable: boolean
}

// ---- Org-wide (is_staff() only) -------------------------------------------

export function getCachedDepartments(supabase: SupabaseClient): Promise<CachedDepartment[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase.from('department').select('id,name,is_active').order('name')
      return (data ?? []) as CachedDepartment[]
    },
    ['ref-department'],
    { revalidate: REVALIDATE_SECONDS, tags: [REFERENCE_DATA_TAGS.department] }
  )()
}

export function getCachedCostCenters(supabase: SupabaseClient): Promise<CachedCostCenter[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase.from('cost_center').select('id,name').order('name')
      return (data ?? []) as CachedCostCenter[]
    },
    ['ref-cost-center'],
    { revalidate: REVALIDATE_SECONDS, tags: [REFERENCE_DATA_TAGS.costCenter] }
  )()
}

export function getCachedEntryStatuses(supabase: SupabaseClient): Promise<CachedEntryStatus[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('entry_status')
        .select('id,code,label,source_system')
        .order('sort_order')
      return (data ?? []) as CachedEntryStatus[]
    },
    ['ref-entry-status'],
    { revalidate: REVALIDATE_SECONDS, tags: [REFERENCE_DATA_TAGS.entryStatus] }
  )()
}

export function getCachedHubStatuses(supabase: SupabaseClient): Promise<CachedHubStatus[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('hub_status')
        .select('id,code,label,sort_order,is_exportable')
        .order('sort_order')
      return (data ?? []) as CachedHubStatus[]
    },
    ['ref-hub-status'],
    { revalidate: REVALIDATE_SECONDS, tags: [REFERENCE_DATA_TAGS.hubStatus] }
  )()
}

// ---- Department-visibility-scoped (can_see_department gate) --------------
// Callers still apply their own is_active / event-membership / department_id
// filtering on top of these full lists -- only the base table read is cached.

export function getCachedAdminHeads(
  supabase: SupabaseClient,
  userId: string | null
): Promise<CachedAdminHead[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('admin_head')
        .select('id,name,head_number,department_id,is_active')
        .order('head_number')
      return (data ?? []) as CachedAdminHead[]
    },
    ['ref-admin-head', userId ?? 'anon'],
    { revalidate: REVALIDATE_SECONDS, tags: [REFERENCE_DATA_TAGS.adminHead] }
  )()
}

export function getCachedZones(supabase: SupabaseClient, userId: string | null): Promise<CachedZone[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('zone')
        .select('id,name,zone_number,department_id,is_active')
        .order('zone_number')
      return (data ?? []) as CachedZone[]
    },
    ['ref-zone', userId ?? 'anon'],
    { revalidate: REVALIDATE_SECONDS, tags: [REFERENCE_DATA_TAGS.zone] }
  )()
}

export function getCachedBudgetHeads(
  supabase: SupabaseClient,
  userId: string | null
): Promise<CachedBudgetHead[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('budget_head')
        .select('id,raw_label,short_label,department_id')
        .order('raw_label')
      return (data ?? []) as CachedBudgetHead[]
    },
    ['ref-budget-head', userId ?? 'anon'],
    { revalidate: REVALIDATE_SECONDS, tags: [REFERENCE_DATA_TAGS.budgetHead] }
  )()
}
