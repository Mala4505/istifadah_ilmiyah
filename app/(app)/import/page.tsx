import { createClient } from '@/lib/supabase/server'
import { ImportWorkspace } from '@/components/import/import-workspace'

/**
 * /import (MASTER-PLAN §5 screen 5, §11.1 day 2). Upload -> dry-run preview
 * with a per-row diff table -> commit; batch history below. The admin-role
 * check happens twice by design: here (server-rendered, so a non-admin
 * never even sees the upload form — the permission-denied state itself) and
 * again in app/api/import/route.ts (the actual enforcement point, since
 * this page's check is only a UX nicety — RLS/the route are what a
 * hand-crafted request cannot bypass).
 */
export default async function ImportPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let isAdmin = false
  if (user) {
    const { data: profile } = await supabase
      .from('staff_profile')
      .select('role, is_active')
      .eq('id', user.id)
      .maybeSingle()
    isAdmin = Boolean(profile?.is_active && profile.role === 'admin')
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Import</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          Phase 1A · Day 2
        </span>
      </div>
      <ImportWorkspace isAdmin={isAdmin} />
    </div>
  )
}
