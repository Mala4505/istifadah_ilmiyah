import Link from 'next/link'
import { getCompareBasis } from '@/lib/reports/compare-basis'
import { loadBudgetSurface } from '@/lib/reports/surfaces/budget'
import { loadBudgetStructure } from '@/lib/reports/surfaces/budget-structure'
import { loadAdminHeadAccountability } from '@/lib/reports/surfaces/admin-head'
import { loadEntryTypeFlow } from '@/lib/reports/surfaces/entry-type-flow'
import { loadSpendCurveOpenAgeing } from '@/lib/reports/surfaces/spend-curve-open-ageing'
import { loadEventComparison } from '@/lib/reports/surfaces/event-comparison'
import { BudgetByHeadSection } from '@/components/reports/sections/budget-by-head'
import { DepartmentBudgetSection } from '@/components/reports/sections/department-budget'
import { SubDepartmentBudgetSection } from '@/components/reports/sections/sub-department-budget'
import { ZoneSpendSection } from '@/components/reports/sections/zone-spend'
import { AdminHeadAccountabilitySection } from '@/components/reports/sections/admin-head-accountability'
import { BudgetRevisionHistorySection } from '@/components/reports/sections/budget-revision-history'
import { ZoneCategoryMatrixSection } from '@/components/reports/sections/zone-category-matrix'
import { BudgetCategoryMixSection } from '@/components/reports/sections/budget-category-mix'
import { EntryTypeSplitSection } from '@/components/reports/sections/entry-type-split'
import { OutstandingAdvanceAgeingSection } from '@/components/reports/sections/outstanding-advance-ageing'
import { ReimbursementProfileSection } from '@/components/reports/sections/reimbursement-profile'
import { SpendCurveSection } from '@/components/reports/sections/spend-curve'
import { EventComparisonSection } from '@/components/reports/sections/event-comparison'
import { parsePositiveIntParam } from '@/lib/reports/search-params'

/**
 * Budget & Spend surface (reporting-blueprint.md §5 / §8 Phase Three). One
 * of the five Reports front doors -- department and administrative heads'
 * view of where the money went and where it is heading. The sticky
 * event/compare-basis bar and the surface nav both live in
 * app/(app)/reports/layout.tsx.
 *
 * A thin route over per-section presenters (§6 fix #10): the same
 * components render on /reports (Explore), so the two surfaces stay
 * identical by construction.
 *
 * Carries the full Family A catalogue: A-01 (three-level budget vs actual),
 * A-02 (revision history), A-04 (admin-head accountability), A-05 (zone
 * cost map), A-06 (zone x category matrix), A-07 (category mix), A-08
 * (entry-type split), A-09 (advance ageing), A-10 (reimbursement profile),
 * A-11 (spend curve & peak weeks), A-12 (event-over-event).
 */
export const dynamic = 'force-dynamic'

export default async function BudgetSurfacePage({
  searchParams,
}: {
  searchParams: Promise<{ revision_head_id?: string }>
}) {
  const compareBasis = await getCompareBasis()
  const sp = await searchParams
  const revisionHeadId = parsePositiveIntParam(sp.revision_head_id)

  const [data, structure, adminHead, entryTypeFlow, spendCurve, eventComparison] = await Promise.all([
    loadBudgetSurface(compareBasis),
    loadBudgetStructure(compareBasis, revisionHeadId),
    loadAdminHeadAccountability(compareBasis),
    loadEntryTypeFlow(compareBasis),
    loadSpendCurveOpenAgeing(compareBasis),
    loadEventComparison(),
  ])

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
        Budget against actual at three levels — head, department, sub-department — the administrative head each rupee sits
        under, spend across the 13 zones and by category, how the money splits by entry type, the advances still
        outstanding, the reimbursement profile, the weekly spend curve, and this event against the last. Every figure links
        through to the entries behind it.
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
      <BudgetRevisionHistorySection
        rows={structure.revisionHistory.rows}
        error={structure.revisionHistory.error}
        selectedHeadId={structure.revisionHeadId}
      />
      <AdminHeadAccountabilitySection
        rows={adminHead.accountability.rows}
        error={adminHead.accountability.error}
        compareBasis={compareBasis}
        previousSpendTotal={adminHead.accountability.previousSpendTotal}
      />
      <ZoneSpendSection
        rows={data.byZone.rows}
        error={data.byZone.error}
        compareBasis={compareBasis}
        previousTotal={data.byZone.previousTotal}
      />
      <ZoneCategoryMatrixSection rows={structure.zoneCategoryMatrix.rows} error={structure.zoneCategoryMatrix.error} />
      <BudgetCategoryMixSection rows={structure.budgetCategoryMix.rows} error={structure.budgetCategoryMix.error} />
      <EntryTypeSplitSection
        rows={entryTypeFlow.entryTypeSplit.rows}
        error={entryTypeFlow.entryTypeSplit.error}
        compareBasis={compareBasis}
        previousReimbursementSharePct={entryTypeFlow.entryTypeSplit.previousReimbursementSharePct}
      />
      <OutstandingAdvanceAgeingSection
        rows={entryTypeFlow.outstandingAdvanceAgeing.rows}
        error={entryTypeFlow.outstandingAdvanceAgeing.error}
        compareBasis={compareBasis}
        previousOutstandingCount={entryTypeFlow.outstandingAdvanceAgeing.previousOutstandingCount}
        previousOutstandingAmount={entryTypeFlow.outstandingAdvanceAgeing.previousOutstandingAmount}
      />
      <ReimbursementProfileSection
        rows={entryTypeFlow.reimbursementProfile.rows}
        byType={entryTypeFlow.reimbursementProfile.byType}
        error={entryTypeFlow.reimbursementProfile.error}
        byTypeError={entryTypeFlow.reimbursementProfile.byTypeError}
        compareBasis={compareBasis}
        previousTotalReimbursed={entryTypeFlow.reimbursementProfile.previousTotalReimbursed}
        previousReimburseeCount={entryTypeFlow.reimbursementProfile.previousReimburseeCount}
      />
      <SpendCurveSection
        rows={spendCurve.spendCurve.rows}
        error={spendCurve.spendCurve.error}
        compareBasis={compareBasis}
        totalSpend={spendCurve.spendCurve.totalSpend}
        eventWeekCount={spendCurve.spendCurve.eventWeekCount}
        peakWeekStart={spendCurve.spendCurve.peakWeekStart}
        peakWeekAmount={spendCurve.spendCurve.peakWeekAmount}
        meanWeeklyAmount={spendCurve.spendCurve.meanWeeklyAmount}
        peakMultipleOfMean={spendCurve.spendCurve.peakMultipleOfMean}
        previousPeakWeekAmount={spendCurve.spendCurve.previousPeakWeekAmount}
      />
      <EventComparisonSection
        hasComparison={eventComparison.hasComparison}
        currentEventName={eventComparison.currentEventName}
        baseEventName={eventComparison.baseEventName}
        rows={eventComparison.rows}
        error={eventComparison.error}
        currentTotal={eventComparison.currentTotal}
        baseTotal={eventComparison.baseTotal}
      />
    </div>
  )
}
