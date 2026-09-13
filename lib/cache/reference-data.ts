import { unstable_cache } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Perf audit Phase 2 (docs/perf-ux-audit-checklist.md): department, budget
 * head, admin head, zone, cost center, entry status, and hub status barely
 * change (a handful of times a term per the checklist) but were re-queried
 * from Postgres on every navigation. Cached here with a short revalidate
 * window and invalidated eagerly by the admin mutations that change them
 * (see REFERENCE_DATA_TAGS) -- `updateBudgetHeadMapping` and the master-data
 * CRUD actions (createDepartment/updateDepartment, createZone/updateZone,
 * createAdminHead/updateAdminHead; lib/actions/admin.ts) all call
 * revalidateTag for the table they write.
 *
 * RLS split (supabase/migrations/20260808000026_rls_policies.sql,
 * 20260819000003_role_rbac_v2.sql, 20260913000001_admin_head_zone_drop_department.sql)
 * matters here: `department`, `admin_head`, `zone`, `cost_center`,
 * `entry_status`, and `hub_status` all gate on `private.is_staff()` only --
 * every authenticated staff member reads the same rows, so one cache entry
 * serves everyone. `budget_head` alone still additionally gates through
 * `private.can_see_department()` (nullable department_id: `department_id is
 * null or can_see_department(department_id)`), which returns true
 * unconditionally for admin-or-above but only for a department-role
 * account's own assigned department(s) (staff_department) otherwise.
 * Caching that with a single global key would let whichever role's request
 * happens to run first populate the cache for every other role for the rest
 * of the revalidate window -- silently truncating the list for an admin, or
 * leaking other departments' budget-head names to a department account. The
 * fix is a per-user cache key (`userId`), same principle as
 * getCachedStaffProfile (lib/export/auth.ts) -- not a security fix on its
 * own (RLS still runs on every cache miss), just keeping the *cache* from
 * crossing the same visibility boundary RLS already draws. admin_head/zone
 * kept their per-user cache key signature below even though they no longer
 * need one (org-wide now, same as department) -- harmless, just a slightly
 * wider cache than necessary; not worth the call-site churn to remove.
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
  entryType: 'ref:entry_type',
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
  is_active: boolean
}

export interface CachedZone {
  id: number
  name: string
  zone_number: number
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
}

export interface CachedHubStatus {
  id: number
  code: string
  label: string
  sort_order: number
  is_exportable: boolean
}

export interface CachedEntryType {
  code: string
  label: string
  sort_order: number
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
        .select('id,code,label')
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

export function getCachedEntryTypes(supabase: SupabaseClient): Promise<CachedEntryType[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase.from('entry_type').select('code,label,sort_order').order('sort_order')
      return (data ?? []) as CachedEntryType[]
    },
    ['ref-entry-type'],
    { revalidate: REVALIDATE_SECONDS, tags: [REFERENCE_DATA_TAGS.entryType] }
  )()
}

// ---- Org-wide, per-user cache key kept for historical reasons -------------
// admin_head/zone are staff-wide reads now (is_staff() only, since
// 20260913000001 dropped their department_id and the can_see_department
// gate on them) -- these two could move up into the plain org-wide group
// above, but the per-user cache key is harmless, just wider than strictly
// needed, so it's left as-is. Callers still apply their own is_active /
// event-membership filtering on top of these full lists -- only the base
// table read is cached.

export function getCachedAdminHeads(
  supabase: SupabaseClient,
  userId: string | null
): Promise<CachedAdminHead[]> {
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('admin_head')
        .select('id,name,head_number,is_active')
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
        .select('id,name,zone_number,is_active')
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
