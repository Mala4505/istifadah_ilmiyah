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
import { DepartmentBudgetExplorerSection } from '@/components/reports/sections/department-budget-explorer'
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
import { BudgetOverview } from '@/components/reports/overviews/budget-overview'
import {
  OVERVIEW_SECTION,
  resolveSection,
  isSectionInPane,
  groupHiddenInPane,
} from '@/lib/reports/surface-sections'

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
  searchParams: Promise<{ revision_head_id?: string; report?: string }>
}) {
  const compareBasis = await getCompareBasis()
  const selectedEvent = await getSelectedEvent()
  const eventName = selectedEvent?.name ?? null
  const sp = await searchParams
  const revisionHeadId = parsePositiveIntParam(sp.revision_head_id)
  const active = resolveSection('budget', sp.report)
  const isOverview = active.id === OVERVIEW_SECTION.id
  const only = isOverview ? null : active.id

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
      {isOverview ? (
        <>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Budget against actual at three levels — head, department, sub-department — the administrative head each rupee
            sits under, spend across the 13 zones and by category, how the money splits by entry type, the advances still
            outstanding, the reimbursement profile, the weekly spend curve, and this event against the last. Every figure
            links through to the entries behind it.
          </p>
          <Suspense fallback={<SectionSkeleton />}>
            <BudgetOverview compareBasis={compareBasis} selectedEvent={selectedEvent} />
          </Suspense>
        </>
      ) : (
        <>
          <Suspense fallback={<SectionSkeleton />}>
            <BudgetByHeadGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <RevisionHistoryGroup only={only} compareBasis={compareBasis} revisionHeadId={revisionHeadId} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <AdminHeadGroup only={only} compareBasis={compareBasis} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <ZoneSpendGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <ZoneCategoryGroup only={only} compareBasis={compareBasis} revisionHeadId={revisionHeadId} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <EntryTypeFlowGroup only={only} compareBasis={compareBasis} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <SpendCurveGroup only={only} compareBasis={compareBasis} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <EventComparisonGroup only={only} />
          </Suspense>
        </>
      )}
    </div>
  )
}

async function BudgetByHeadGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (
    groupHiddenInPane(only, [
      'budget-vs-actual',
      'department-budget-vs-actual',
      'sub-department-budget-vs-actual',
      'department-budget-explorer',
    ])
  )
    return null
  const data = await getBudgetSurface(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'budget-vs-actual') && (
        <BudgetByHeadSection
          rows={data.byHead.rows}
          deptRows={data.byDepartment.rows}
          error={data.byHead.error}
          compareBasis={compareBasis}
          previousActualTotal={data.byHead.previousActualTotal}
          insight={data.byHead.insight}
        />
      )}
      {isSectionInPane(only, 'department-budget-vs-actual') && (
        <DepartmentBudgetSection
          rows={data.byDepartment.rows}
          error={data.byDepartment.error}
          compareBasis={compareBasis}
          previousActualTotal={data.byDepartment.previousActualTotal}
          insight={data.byDepartment.insight}
          eventName={selectedEvent?.name ?? null}
        />
      )}
      {isSectionInPane(only, 'sub-department-budget-vs-actual') && (
        <SubDepartmentBudgetSection
          rows={data.bySubDepartment.rows}
          deptRows={data.byDepartment.rows}
          error={data.bySubDepartment.error}
          compareBasis={compareBasis}
          previousActualTotal={data.bySubDepartment.previousActualTotal}
          insight={data.bySubDepartment.insight}
        />
      )}
      {isSectionInPane(only, 'department-budget-explorer') && (
        <DepartmentBudgetExplorerSection
          deptRows={data.byDepartment.rows}
          subDeptRows={data.bySubDepartment.rows}
          deptError={data.byDepartment.error}
          subDeptError={data.bySubDepartment.error}
          compareBasis={compareBasis}
          previousDeptActualTotal={data.byDepartment.previousActualTotal}
          eventName={selectedEvent?.name ?? null}
        />
      )}
    </>
  )
}

async function RevisionHistoryGroup({ only, compareBasis, revisionHeadId }: { only: string | null; compareBasis: CompareBasis; revisionHeadId: number | null }) {
  if (groupHiddenInPane(only, ['budget-revision-history'])) return null
  const structure = await getBudgetStructure(compareBasis, revisionHeadId)
  return (
    <BudgetRevisionHistorySection
      rows={structure.revisionHistory.rows}
      error={structure.revisionHistory.error}
      selectedHeadId={structure.revisionHeadId}
      insight={structure.revisionHistory.insight}
    />
  )
}

async function AdminHeadGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['admin-head-accountability'])) return null
  const adminHead = await loadAdminHeadAccountability(compareBasis)
  return (
    <AdminHeadAccountabilitySection
      rows={adminHead.accountability.rows}
      error={adminHead.accountability.error}
      compareBasis={compareBasis}
      previousSpendTotal={adminHead.accountability.previousSpendTotal}
      insight={adminHead.accountability.insight}
    />
  )
}

async function ZoneSpendGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['zone-spend'])) return null
  const data = await getBudgetSurface(compareBasis, selectedEvent)
  return (
    <ZoneSpendSection
      rows={data.byZone.rows}
      error={data.byZone.error}
      compareBasis={compareBasis}
      previousTotal={data.byZone.previousTotal}
      insight={data.byZone.insight}
    />
  )
}

async function ZoneCategoryGroup({ only, compareBasis, revisionHeadId }: { only: string | null; compareBasis: CompareBasis; revisionHeadId: number | null }) {
  if (groupHiddenInPane(only, ['zone-category-matrix', 'budget-category-mix'])) return null
  const structure = await getBudgetStructure(compareBasis, revisionHeadId)
  return (
    <>
      {isSectionInPane(only, 'zone-category-matrix') && (
        <ZoneCategoryMatrixSection
          rows={structure.zoneCategoryMatrix.rows}
          error={structure.zoneCategoryMatrix.error}
          insight={structure.zoneCategoryMatrix.insight}
        />
      )}
      {isSectionInPane(only, 'budget-category-mix') && (
        <BudgetCategoryMixSection
          rows={structure.budgetCategoryMix.rows}
          error={structure.budgetCategoryMix.error}
          insight={structure.budgetCategoryMix.insight}
        />
      )}
    </>
  )
}

async function EntryTypeFlowGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['entry-type-split', 'outstanding-advance-ageing', 'reimbursement-profile'])) return null
  const entryTypeFlow = await loadEntryTypeFlow(compareBasis)
  return (
    <>
      {isSectionInPane(only, 'entry-type-split') && (
        <EntryTypeSplitSection
          rows={entryTypeFlow.entryTypeSplit.rows}
          error={entryTypeFlow.entryTypeSplit.error}
          compareBasis={compareBasis}
          previousReimbursementSharePct={entryTypeFlow.entryTypeSplit.previousReimbursementSharePct}
          insight={entryTypeFlow.entryTypeSplit.insight}
        />
      )}
      {isSectionInPane(only, 'outstanding-advance-ageing') && (
        <OutstandingAdvanceAgeingSection
          rows={entryTypeFlow.outstandingAdvanceAgeing.rows}
          error={entryTypeFlow.outstandingAdvanceAgeing.error}
          compareBasis={compareBasis}
          previousOutstandingCount={entryTypeFlow.outstandingAdvanceAgeing.previousOutstandingCount}
          previousOutstandingAmount={entryTypeFlow.outstandingAdvanceAgeing.previousOutstandingAmount}
          insight={entryTypeFlow.outstandingAdvanceAgeing.insight}
        />
      )}
      {isSectionInPane(only, 'reimbursement-profile') && (
        <ReimbursementProfileSection
          rows={entryTypeFlow.reimbursementProfile.rows}
          byType={entryTypeFlow.reimbursementProfile.byType}
          error={entryTypeFlow.reimbursementProfile.error}
          byTypeError={entryTypeFlow.reimbursementProfile.byTypeError}
          compareBasis={compareBasis}
          previousTotalReimbursed={entryTypeFlow.reimbursementProfile.previousTotalReimbursed}
          previousReimburseeCount={entryTypeFlow.reimbursementProfile.previousReimburseeCount}
          insight={entryTypeFlow.reimbursementProfile.insight}
        />
      )}
    </>
  )
}

async function SpendCurveGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['spend-curve'])) return null
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
      insight={spendCurve.spendCurve.insight}
    />
  )
}

async function EventComparisonGroup({ only }: { only: string | null }) {
  if (groupHiddenInPane(only, ['event-comparison'])) return null
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
      insight={eventComparison.insight}
    />
  )
}
