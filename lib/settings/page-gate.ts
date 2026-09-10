import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove, isSuperadmin } from '@/lib/auth/roles'
import { getSelectedEventId } from '@/lib/events/current'
import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

export type SettingsPageGate =
  | { ok: true; userId: string; supabase: SupabaseClient; selectedEventId: number | null }
  | { ok: false; reason: 'signed_out' | 'inactive' | 'not_admin' | 'not_superadmin' }

/**
 * The gate every focused Settings sub-route runs before loading its area
 * data (Phase 2, Direction A). Mirrors the former single page's sequence
 * -- signed in, active, admin-or-above -- and adds the superadmin check
 * the old page applied per-tab (TAB_DEFS `superadminOnly`), since all
 * five structural sub-routes were superadmin-only tabs. A hidden nav
 * link is not a permission check; this is the real one, run server-side
 * on every sub-route regardless of what the landing list showed.
 */
export async function requireSettingsSuperadminPage(): Promise<SettingsPageGate> {
  const staff = await getStaffContext()
  if (!staff) return { ok: false, reason: 'signed_out' }
  if (!staff.isActive) return { ok: false, reason: 'inactive' }
  if (!isAdminOrAbove(staff.role)) return { ok: false, reason: 'not_admin' }
  if (!isSuperadmin(staff.role)) return { ok: false, reason: 'not_superadmin' }

  const [supabase, selectedEventId] = await Promise.all([createClient(), getSelectedEventId()])
  return { ok: true, userId: staff.userId, supabase, selectedEventId }
}
