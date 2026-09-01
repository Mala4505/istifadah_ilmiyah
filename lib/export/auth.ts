/**
 * Session-bound staff/role lookup, used to gate the /export screen and its
 * mutating API routes to admin-or-above (MASTER-PLAN §4.4c: "Generate a
 * status export batch" is every cross-department action except user
 * management) — checked with the session-bound client (RLS-scoped, reads
 * only the caller's own `staff_profile` row, which its own policy always
 * allows) BEFORE anything touches the admin client that bypasses RLS.
 * Getting this check right is the whole reason the task brief calls it out
 * explicitly: the admin client used by the generator has no RLS backstop if
 * this is skipped or wrong.
 */

import { cache } from 'react'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import type { StaffRole } from '@/lib/auth/roles'
import { isAdminOrAbove, isSuperadmin } from '@/lib/auth/roles'

export interface StaffContext {
  userId: string
  role: StaffRole
  isActive: boolean
}

export interface StaffProfileRow {
  display_name: string
  role: StaffRole
  is_active: boolean
  its_number: string | null
}

/**
 * Perf audit Phase 1.2 (docs/perf-ux-audit-checklist.md): the one
 * `staff_profile` row callers need, cached per-request the same way
 * `getCachedUser()` is — `app/(app)/layout.tsx`'s nav-rail lookup and this
 * file's own `getStaffContext()` used to each run their own query for the
 * same row. Selects the superset of columns every call site needs
 * (`display_name`/`its_number` for the nav rail, `role`/`is_active` for the
 * role gates) rather than caching two differently-shaped queries.
 */
export const getCachedStaffProfile = cache(async (userId: string): Promise<StaffProfileRow | null> => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('staff_profile')
    .select('display_name, role, is_active, its_number')
    .eq('id', userId)
    .maybeSingle()
  return data
})

/** Null when there is no signed-in user, or no matching staff_profile row. */
export async function getStaffContext(): Promise<StaffContext | null> {
  const user = await getCachedUser()
  if (!user) return null

  const profile = await getCachedStaffProfile(user.id)
  if (!profile) return null

  return { userId: user.id, role: profile.role, isActive: profile.is_active }
}

export type AdminGate =
  | { ok: true; staff: StaffContext }
  | { ok: false; reason: 'signed_out' | 'inactive' | 'not_admin' }

/** The one check the /export page and its route handlers call before anything admin-scoped runs. */
export async function requireAdminOrAbove(): Promise<AdminGate> {
  const staff = await getStaffContext()
  if (!staff) return { ok: false, reason: 'signed_out' }
  if (!staff.isActive) return { ok: false, reason: 'inactive' }
  if (!isAdminOrAbove(staff.role)) return { ok: false, reason: 'not_admin' }
  return { ok: true, staff }
}

/** The one check user-management actions (create/update staff accounts) call — superadmin only. */
export async function requireSuperadmin(): Promise<AdminGate> {
  const staff = await getStaffContext()
  if (!staff) return { ok: false, reason: 'signed_out' }
  if (!staff.isActive) return { ok: false, reason: 'inactive' }
  if (!isSuperadmin(staff.role)) return { ok: false, reason: 'not_admin' }
  return { ok: true, staff }
}
