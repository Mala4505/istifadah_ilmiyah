import { getCachedUser } from '@/lib/supabase/server'
import { getCachedStaffProfile } from '@/lib/export/auth'
import { ReportsPeriodBar } from '@/components/app-shell/reports-period-bar'
import { ReportSurfaceNav } from '@/components/app-shell/report-surface-nav'

/**
 * Reports-only shell layout (reporting-blueprint.md §6 fix #9, §8 Phase
 * One). Scoped to the Reports surface via this nested segment layout rather
 * than app/(app)/layout.tsx (shared by every other screen, where a
 * comparison-basis control would be meaningless) or app/(app)/reports/
 * page.tsx (owned by another concurrent stream this phase -- see that
 * file's own header comment).
 *
 * `getCachedUser`/`getCachedStaffProfile` are React.cache()-wrapped
 * (lib/export/auth.ts), so re-calling them here -- already called once in
 * the parent app/(app)/layout.tsx -- is a per-request dedupe, not a second
 * query. The parent layout already redirects unauthenticated requests
 * before this segment ever renders, so `user` is expected non-null here;
 * the guard just keeps this file correct in isolation.
 */
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCachedUser()
  const profile = user ? await getCachedStaffProfile(user.id) : null

  return (
    <div className="flex flex-col">
      <ReportsPeriodBar role={profile?.role ?? null} />
      <ReportSurfaceNav />
      {children}
    </div>
  )
}
