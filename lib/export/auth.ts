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

import { createClient } from '@/lib/supabase/server'
import type { StaffRole } from '@/lib/auth/roles'
import { isAdminOrAbove, isSuperadmin } from '@/lib/auth/roles'

export interface StaffContext {
  userId: string
  role: StaffRole
  isActive: boolean
}

/** Null when there is no signed-in user, or no matching staff_profile row. */
export async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile, error } = await supabase
    .from('staff_profile')
    .select('role, is_active')
    .eq('id', user.id)
    .single()
  if (error || !profile) return null

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
