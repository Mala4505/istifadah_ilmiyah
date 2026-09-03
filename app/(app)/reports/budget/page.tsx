import Link from 'next/link'
import { getCompareBasis } from '@/lib/reports/compare-basis'
import { loadBudgetSurface } from '@/lib/reports/surfaces/budget'
import { BudgetByHeadSection } from '@/components/reports/sections/budget-by-head'
import { DepartmentBudgetSection } from '@/components/reports/sections/department-budget'
import { SubDepartmentBudgetSection } from '@/components/reports/sections/sub-department-budget'
import { ZoneSpendSection } from '@/components/reports/sections/zone-spend'

/**
 * Budget & Spend surface (reporting-blueprint.md §5 / §8 Phase Three). One
 * of the five Reports front doors -- department and administrative heads'
 * view of where the money went and where it is heading. The sticky
 * event/compare-basis bar and the surface nav both live in
 * app/(app)/reports/layout.tsx, so this route is just: load the surface,
 * render its four sections.
 *
 * A thin route over per-section presenters (§6 fix #10): the same
 * components render on /reports (Explore), so the two surfaces stay
 * identical by construction.
 */
export const dynamic = 'force-dynamic'

export default async function BudgetSurfacePage() {
  const compareBasis = await getCompareBasis()
  const data = await loadBudgetSurface(compareBasis)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Budget &amp; Spend</h1>
          {data.eventName && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{data.eventName}</span>
          )}
        </div>
        <Link href="/reports" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Full report &amp; drill workspace →
        </Link>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Budget against actual at three levels — head, department, sub-department — plus spend across the 13 zones. Every figure
        links through to the entries behind it; heads and departments with no approved budget show a status note, not a
        misleading −100%.
      </p>

      <BudgetByHeadSection
        rows={data.byHead.rows}
        deptRows={data.byDepartment.rows}
        error={data.byHead.error}
        compareBasis={compareBasis}
        previousActualTotal={data.byHead.previousActualTotal}
      />
      <DepartmentBudgetSection
        rows={data.byDepartment.rows}
        error={data.byDepartment.error}
        compareBasis={compareBasis}
        previousActualTotal={data.byDepartment.previousActualTotal}
      />
      <SubDepartmentBudgetSection
        rows={data.bySubDepartment.rows}
        deptRows={data.byDepartment.rows}
        error={data.bySubDepartment.error}
        compareBasis={compareBasis}
        previousActualTotal={data.bySubDepartment.previousActualTotal}
      />
      <ZoneSpendSection
        rows={data.byZone.rows}
        error={data.byZone.error}
        compareBasis={compareBasis}
        previousTotal={data.byZone.previousTotal}
      />
    </div>
  )
}
