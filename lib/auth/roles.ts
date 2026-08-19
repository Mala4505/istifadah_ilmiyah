/**
 * Single source of truth for the three-tier role model (confirmed 2026-08-19,
 * `20260819000003_role_rbac_v2.sql`), replacing the scattered
 * `role === 'admin'` / `'reviewer'` / `'viewer'` checks across the app.
 *
 * These are UX-only conveniences. The real gate is always RLS
 * (`private.is_superadmin()` / `private.is_admin_or_above()` in the
 * database) — a wrong or stale check here can at worst show the wrong
 * screen, never grant a write the database would refuse.
 */
export type StaffRole = 'superadmin' | 'admin' | 'dept'

export function isSuperadmin(role: StaffRole | string | null | undefined): boolean {
  return role === 'superadmin'
}

export function isAdminOrAbove(role: StaffRole | string | null | undefined): boolean {
  return role === 'superadmin' || role === 'admin'
}
