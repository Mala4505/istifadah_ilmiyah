import { getCachedUser } from '@/lib/supabase/server'
import { getCachedStaffProfile } from '@/lib/export/auth'
import { ReportsPeriodBar } from '@/components/app-shell/reports-period-bar'
import { ReportSurfaceNav } from '@/components/app-shell/report-surface-nav'
import { ReportIndex } from '@/components/reports/report-index'
import { SectionAnchorSync } from '@/components/reports/section-anchor-sync'
import { getReportPins } from '@/lib/reports/pins'

/**
 * Reports-only shell layout (reporting-blueprint.md §6 fix #9, §8 Phase
 * One; redesign plan Phase 3.1c). Scoped to the Reports surface via this
 * nested segment layout rather than app/(app)/layout.tsx (shared by every
 * other screen, where a comparison-basis control or a report index would be
 * meaningless).
 *
 * Layout: the sticky period bar and the five-surface nav run full width at
 * the top; below them a two-column grid puts the section index
 * (<ReportIndex>, ~13.5rem) beside the pane (`{children}`). The index reads
 * the `reports_pins` cookie here, server-side (same pattern as
 * `nav_rail_collapsed` in app/(app)/layout.tsx), so its `★ My reports` group
 * is correct on first paint. On narrow viewports the grid collapses and the
 * index stacks above the pane.
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
  const pins = await getReportPins()

  return (
    <div className="flex flex-col">
      <SectionAnchorSync />
      <ReportsPeriodBar role={profile?.role ?? null} />
      <ReportSurfaceNav />
      <div className="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside data-hide-in-present className="lg:border-r lg:border-border lg:pr-4">
          <div className="lg:sticky lg:top-4">
            <ReportIndex pins={pins} />
          </div>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  )
}
