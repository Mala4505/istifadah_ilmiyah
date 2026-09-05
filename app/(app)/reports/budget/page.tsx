import { Suspense, cache } from 'react'
import Link from 'next/link'
import { getSelectedEvent } from '@/lib/events/current'
import type { Event } from '@/lib/events/types'
import { getCompareBasis, type CompareBasis } from '@/lib/reports/compare-basis'
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
import { SectionSkeleton } from '@/components/reports/sections/surface-loading'
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
 *
 * Perf remediation Phase 6.1 (docs/performance-remediation-plan.md): each
 * loader below used to be one member of a single page-wide `Promise.all`,
 * so the slowest of the six gated every section, including ones that
 * resolved instantly. Each is now awaited inside its own async Server
 * Component behind its own `<Suspense>`. `loadBudgetSurface` and
 * `loadBudgetStructure` each feed two non-adjacent groups of sections --
 * wrapped in `cache()` so each group pair shares one query instead of
 * running it twice.
 */
export const dynamic = 'force-dynamic'

const getBudgetSurface = cache(loadBudgetSurface)
const getBudgetStructure = cache(loadBudgetStructure)

export default async function BudgetSurfacePage({
  searchParams,
}: {
  searchParams: Promise<{ revision_head_id?: string }>
}) {
  const compareBasis = await getCompareBasis()
  const selectedEvent = await getSelectedEvent()
  const eventName = selectedEvent?.name ?? null
  const sp = await searchParams
  const revisionHeadId = parsePositiveIntParam(sp.revision_head_id)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Budget &amp; Spend</h1>
          {eventName && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{eventName}</span>
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

      <Suspense fallback={<SectionSkeleton />}>
        <BudgetByHeadGroup compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <RevisionHistoryGroup compareBasis={compareBasis} revisionHeadId={revisionHeadId} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <AdminHeadGroup compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <ZoneSpendGroup compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <ZoneCategoryGroup compareBasis={compareBasis} revisionHeadId={revisionHeadId} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <EntryTypeFlowGroup compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <SpendCurveGroup compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <EventComparisonGroup />
      </Suspense>
    </div>
  )
}

async function BudgetByHeadGroup({ compareBasis, selectedEvent }: { compareBasis: CompareBasis; selectedEvent: Event | null }) {
  const data = await getBudgetSurface(compareBasis, selectedEvent)
  return (
    <>
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
    </>
  )
}

async function RevisionHistoryGroup({ compareBasis, revisionHeadId }: { compareBasis: CompareBasis; revisionHeadId: number | null }) {
  const structure = await getBudgetStructure(compareBasis, revisionHeadId)
  return (
    <BudgetRevisionHistorySection
      rows={structure.revisionHistory.rows}
      error={structure.revisionHistory.error}
      selectedHeadId={structure.revisionHeadId}
    />
  )
}

async function AdminHeadGroup({ compareBasis }: { compareBasis: CompareBasis }) {
  const adminHead = await loadAdminHeadAccountability(compareBasis)
  return (
    <AdminHeadAccountabilitySection
      rows={adminHead.accountability.rows}
      error={adminHead.accountability.error}
      compareBasis={compareBasis}
      previousSpendTotal={adminHead.accountability.previousSpendTotal}
    />
  )
}

async function ZoneSpendGroup({ compareBasis, selectedEvent }: { compareBasis: CompareBasis; selectedEvent: Event | null }) {
  const data = await getBudgetSurface(compareBasis, selectedEvent)
  return (
    <ZoneSpendSection
      rows={data.byZone.rows}
      error={data.byZone.error}
      compareBasis={compareBasis}
      previousTotal={data.byZone.previousTotal}
    />
  )
}

async function ZoneCategoryGroup({ compareBasis, revisionHeadId }: { compareBasis: CompareBasis; revisionHeadId: number | null }) {
  const structure = await getBudgetStructure(compareBasis, revisionHeadId)
  return (
    <>
      <ZoneCategoryMatrixSection rows={structure.zoneCategoryMatrix.rows} error={structure.zoneCategoryMatrix.error} />
      <BudgetCategoryMixSection rows={structure.budgetCategoryMix.rows} error={structure.budgetCategoryMix.error} />
    </>
  )
}

async function EntryTypeFlowGroup({ compareBasis }: { compareBasis: CompareBasis }) {
  const entryTypeFlow = await loadEntryTypeFlow(compareBasis)
  return (
    <>
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
    </>
  )
}

async function SpendCurveGroup({ compareBasis }: { compareBasis: CompareBasis }) {
  const spendCurve = await loadSpendCurveOpenAgeing(compareBasis)
  return (
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
  )
}

async function EventComparisonGroup() {
  const eventComparison = await loadEventComparison()
  return (
    <EventComparisonSection
      hasComparison={eventComparison.hasComparison}
      currentEventName={eventComparison.currentEventName}
      baseEventName={eventComparison.baseEventName}
      rows={eventComparison.rows}
      error={eventComparison.error}
      currentTotal={eventComparison.currentTotal}
      baseTotal={eventComparison.baseTotal}
    />
  )
}
