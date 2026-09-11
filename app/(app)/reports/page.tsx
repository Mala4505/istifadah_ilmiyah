import { Suspense, cache } from 'react'
import { getSelectedEvent } from '@/lib/events/current'
import type { Event } from '@/lib/events/types'
import { getCompareBasis, type CompareBasis } from '@/lib/reports/compare-basis'
import { loadHeroMetrics } from '@/lib/reports/hero-metrics'
import { loadBudgetSurface } from '@/lib/reports/surfaces/budget'
import { loadVendorsSurface } from '@/lib/reports/surfaces/vendors'
import { loadIntegritySurface } from '@/lib/reports/surfaces/integrity'
import { loadPurchaseTree } from '@/lib/reports/surfaces/purchase-tree'
import { loadRateDriftDiscount } from '@/lib/reports/surfaces/rate-drift-discount'
import { loadQuantityZonePrice } from '@/lib/reports/surfaces/quantity-zone-price'
import { loadVendorScorecard } from '@/lib/reports/surfaces/vendor-scorecard'
import { loadVendorDependency } from '@/lib/reports/surfaces/vendor-dependency'
import { loadRelatedPartyGstin } from '@/lib/reports/surfaces/related-party-gstin'
import { loadBudgetStructure } from '@/lib/reports/surfaces/budget-structure'
import { loadAdminHeadAccountability } from '@/lib/reports/surfaces/admin-head'
import { loadEntryTypeFlow } from '@/lib/reports/surfaces/entry-type-flow'
import { loadSpendCurveOpenAgeing } from '@/lib/reports/surfaces/spend-curve-open-ageing'
import { loadEventComparison } from '@/lib/reports/surfaces/event-comparison'
import { loadReconciliationGap } from '@/lib/reports/surfaces/reconciliation-gap'
import { loadAmountForensics } from '@/lib/reports/surfaces/amount-forensics'
import { loadDuplicateVendorRisk } from '@/lib/reports/surfaces/duplicate-vendor-risk'
import { loadThresholdSplitting } from '@/lib/reports/surfaces/threshold-splitting'
import { loadHsnGstAnomaly } from '@/lib/reports/surfaces/hsn-gst-anomaly'
import { loadRupeeProvenance } from '@/lib/reports/surfaces/rupee-provenance'
import { loadWeeklyDigest } from '@/lib/reports/weekly-digest'
import { parsePositiveIntParam } from '@/lib/reports/search-params'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { TrendChart } from '@/components/reports/charts/trend-chart'
import { DonutChart, type DonutSegment } from '@/components/reports/charts/donut-chart'
import { FunnelChart } from '@/components/reports/charts/funnel-chart'
import { ORDINAL_RAMP } from '@/components/reports/charts/ordinal-ramp'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'
import { SectionSkeleton } from '@/components/reports/sections/surface-loading'
import { BudgetByHeadSection } from '@/components/reports/sections/budget-by-head'
import { DepartmentBudgetExplorerSection } from '@/components/reports/sections/department-budget-explorer'
import { ZoneSpendSection } from '@/components/reports/sections/zone-spend'
import { VendorSpendSection } from '@/components/reports/sections/vendor-spend'
import { VendorConcentrationSection } from '@/components/reports/sections/vendor-concentration'
import { AboveMedianOverpaymentSection } from '@/components/reports/sections/above-median-overpayment'
import { InstrumentTypeMixSection } from '@/components/reports/sections/instrument-type-mix'
import { SpendByFamilySection } from '@/components/reports/sections/spend-by-family'
import { RateBenchmarkSection } from '@/components/reports/sections/rate-benchmark'
import { HubStatusAgeingSection } from '@/components/reports/sections/hub-status-ageing'
import { OpenIssuesSection } from '@/components/reports/sections/open-issues'
import { ComplianceSection } from '@/components/reports/sections/compliance'
import { ExceptionHeatmapSection } from '@/components/reports/sections/exception-heatmap'
import { AmountAtRiskWaterfallSection } from '@/components/reports/sections/amount-at-risk-waterfall'
import { PurchaseTreeSection } from '@/components/reports/sections/purchase-tree'
import { VendorScorecardSection } from '@/components/reports/sections/vendor-scorecard'
import { VendorActivitySpanSection } from '@/components/reports/sections/vendor-activity-span'
import { DepartmentDependencySection } from '@/components/reports/sections/department-dependency'
import { VendorExclusivitySection } from '@/components/reports/sections/vendor-exclusivity'
import { NewVendorFirstBillSection } from '@/components/reports/sections/new-vendor-first-bill'
import { VendorPriceRankingSection } from '@/components/reports/sections/vendor-price-ranking'
import { RelatedPartyClustersSection } from '@/components/reports/sections/related-party-clusters'
import { GstinTaxExposureSection } from '@/components/reports/sections/gstin-tax-exposure'
import { RateDriftSection } from '@/components/reports/sections/rate-drift'
import { DiscountConsistencySection } from '@/components/reports/sections/discount-consistency'
import { QuantityByUnitSection } from '@/components/reports/sections/quantity-by-unit'
import { ZoneUnitEconomicsSection } from '@/components/reports/sections/zone-unit-economics'
import { AdminHeadAccountabilitySection } from '@/components/reports/sections/admin-head-accountability'
import { BudgetRevisionHistorySection } from '@/components/reports/sections/budget-revision-history'
import { ZoneCategoryMatrixSection } from '@/components/reports/sections/zone-category-matrix'
import { BudgetCategoryMixSection } from '@/components/reports/sections/budget-category-mix'
import { EntryTypeSplitSection } from '@/components/reports/sections/entry-type-split'
import { OutstandingAdvanceAgeingSection } from '@/components/reports/sections/outstanding-advance-ageing'
import { ReimbursementProfileSection } from '@/components/reports/sections/reimbursement-profile'
import { SpendCurveSection } from '@/components/reports/sections/spend-curve'
import { EventComparisonSection } from '@/components/reports/sections/event-comparison'
import { OpenItemAgeingSection } from '@/components/reports/sections/open-item-ageing'
import { DuplicatePaymentRegisterSection } from '@/components/reports/sections/duplicate-payment-register'
import { LedgerBillReconciliationSection } from '@/components/reports/sections/ledger-bill-reconciliation'
import { EntriesWithoutBillSection } from '@/components/reports/sections/entries-without-bill'
import { BenfordDigitTestSection } from '@/components/reports/sections/benford-digit-test'
import { RoundNumberBiasSection } from '@/components/reports/sections/round-number-bias'
import { ThresholdSplittingSection } from '@/components/reports/sections/threshold-splitting'
import { HsnGstAnomalySection } from '@/components/reports/sections/hsn-gst-anomaly'
import { VendorRiskBoardSection } from '@/components/reports/sections/vendor-risk-board'
import { WeeklyDigestSection } from '@/components/reports/sections/weekly-digest'
import { RupeeProvenanceSection } from '@/components/reports/sections/rupee-provenance'
import { BoardPackList } from '@/components/reports/sections/board-pack-list'
import {
  OVERVIEW_SECTION,
  resolveSection,
  isSectionInPane,
  groupHiddenInPane,
} from '@/lib/reports/surface-sections'

// Screen 10 — Reports, "Explore" surface (reporting-blueprint.md §5 / §8
// Phase Three: "keep Explore as the drill workspace"). The former single
// 1937-line page is now four audience front doors -- Executive Brief
// (/reports/brief), Budget & Spend (/reports/budget), Vendors & Purchases
// (/reports/vendors), Integrity (/reports/integrity) -- plus this one, the
// power-user pivot/drill workspace that still carries every section and its
// CSV export in one scroll.
//
// Composition, not duplication: each section is the same presenter component
// the audience surfaces render, fed by the same three per-surface loaders
// (lib/reports/surfaces/*.ts). Explore and the surfaces stay identical by
// construction. The sticky event/compare-basis bar and the surface nav live
// in app/(app)/reports/layout.tsx.
//
// Row-level views still originate from flags-run
// (lib/jobs/handlers/flags-run.ts), which re-queues itself every 15 minutes.
//
// Perf remediation Phase 6.1 (docs/performance-remediation-plan.md): this
// page used to await one 21-member `Promise.all` before returning any JSX,
// so the single slowest loader gated every section including ones that
// resolved instantly. Every loader below now runs inside its own async
// Server Component behind its own `<Suspense>` boundary, so each section
// streams in as soon as its own query settles. `loadHeroMetrics` stays a
// plain top-level `await` (unchanged from the Phase 2.4 pattern) since it
// feeds the above-the-fold Overview band directly -- nothing on this page
// should paint before it, and it is the one loader every "done when the
// hero paints before the slowest surface" check is measured against.
// A handful of loaders (budget, vendors, integrity, quantity-zone-price,
// budget-structure, spend-curve-open-ageing, duplicate-vendor-risk) feed two
// or three separate, non-adjacent groups of sections in the layout below --
// each is wrapped in `cache()` so every group sharing a loader still fires
// one query, not two or three, exactly preserving the section order and
// grid placement of the pre-Phase-6.1 page. One section moved: the
// "couldn't resolve the prior comparison period" banner used to render
// above the Overview band (it reads off the integrity loader, which the
// Overview band's hero loader does not touch) -- it now renders with the
// first integrity-fed group in the two-column grid below, since showing it
// before Overview would otherwise force hero to wait on integrity too.
export const dynamic = 'force-dynamic'

const getBudgetSurface = cache(loadBudgetSurface)
const getVendorsSurface = cache(loadVendorsSurface)
const getIntegritySurface = cache(loadIntegritySurface)
const getQuantityZonePrice = cache(loadQuantityZonePrice)
const getBudgetStructure = cache(loadBudgetStructure)
const getSpendCurveOpenAgeing = cache(loadSpendCurveOpenAgeing)
const getDuplicateVendorRisk = cache(loadDuplicateVendorRisk)

function seriesDelta(series: number[]): number | null {
  if (series.length < 2) return null
  return series[series.length - 1]! - series[series.length - 2]!
}
function formatDeltaINR(delta: number | null): string | undefined {
  if (delta == null) return undefined
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
  return `${sign}${formatINRCompact(Math.abs(delta))} this week`
}
function formatDeltaCount(delta: number | null, noun: string): string | undefined {
  if (delta == null) return undefined
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
  return `${sign}${formatNumber(Math.abs(delta))} ${noun} this week`
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ trace_entry_id?: string; revision_head_id?: string; report?: string }>
}) {
  const selectedEvent = await getSelectedEvent()
  const currentEventId = selectedEvent?.id ?? null
  const compareBasis = await getCompareBasis()
  const sp = await searchParams
  const traceEntryId = parsePositiveIntParam(sp.trace_entry_id)
  const revisionHeadId = parsePositiveIntParam(sp.revision_head_id)
  const active = resolveSection('explore', sp.report)
  const isOverview = active.id === OVERVIEW_SECTION.id
  // On Explore, `?report=` unset rests on the overview band below; when set,
  // every group still mounts but skips its loader unless it owns this id.
  const only = isOverview ? null : active.id

  // Perf remediation Phase 2.4 (docs/performance-remediation-plan.md):
  // loadHeroMetrics runs first, sequentially, so its already-computed
  // totalSpend can be passed into loadIntegritySurface instead of that
  // loader re-fetching and re-summing the same non-void `entries` rows a
  // second time in the same request -- same pattern already used by
  // loadExecutiveBrief on /reports/brief. Phase 6.1: this stays a plain
  // top-level await (not Suspense-wrapped) -- it is the Overview band's own
  // data and must paint before, not behind, every other section.
  const hero = await loadHeroMetrics(currentEventId)

  const eventName = selectedEvent?.name ?? null

  // ---- Overview band (hero KPIs, spend pace, hub-status mix, pipeline) ----
  const spendDelta = seriesDelta(hero.kpi.weeklySpendSeries)
  const entryDelta = seriesDelta(hero.kpi.weeklyEntrySeries)
  const riskDelta = seriesDelta(hero.kpi.weeklyAtRiskSeries)

  const hubStatusSegments: DonutSegment[] = hero.hubStatus.map((s, i) => ({
    key: s.key,
    label: s.label,
    value: s.value,
    colorClass: ORDINAL_RAMP[i % ORDINAL_RAMP.length]!.strokeClass,
  }))

  const spendTrendPoints = hero.spendTrend.map((p) => ({ label: p.weekLabel, actual: p.actual, target: p.target }))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Explore</h1>
        {eventName && (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{eventName}</span>
        )}
      </div>
      {isOverview && (
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every report section, reachable from the index on the left — the pivot-and-drill workspace behind the four
          focused surfaces above. This rests on an overview of the event (spend pace, Hub status mix, document pipeline);
          pick any report from the index to swap the pane to that one section at full fidelity, with its CSV export.
        </p>
      )}

      {isOverview ? (
      <section id="overview" className="flex scroll-mt-20 flex-col gap-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">This event, so far</h2>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile
            label="Total spend to date"
            value={formatINRCompact(hero.kpi.totalSpend)}
            delta={formatDeltaINR(spendDelta)}
            deltaTone="neutral"
            series={hero.kpi.weeklySpendSeries}
          />
          <KpiTile
            label="Entries this event"
            value={formatNumber(hero.kpi.totalEntries)}
            delta={formatDeltaCount(entryDelta, 'this week')}
            deltaTone="neutral"
            series={hero.kpi.weeklyEntrySeries}
          />
          <KpiTile
            label="Open ₹ at risk"
            value={formatINRCompact(hero.kpi.openAmountAtRisk)}
            delta={formatDeltaINR(riskDelta)}
            deltaTone={riskDelta == null ? 'neutral' : riskDelta > 0 ? 'bad' : 'good'}
            series={hero.kpi.weeklyAtRiskSeries}
          />
          <KpiTile
            label="Avg. days to review"
            value={hero.kpi.avgDaysToReview != null ? hero.kpi.avgDaysToReview.toFixed(1) : '—'}
            series={hero.kpi.weeklyAvgDaysSeries}
          />
        </div>
        {hero.errors.kpi && <p className="text-xs text-destructive">{hero.errors.kpi}</p>}
        <p className="text-xs text-muted-foreground">
          These 4 tiles always compare the last two weeks within this event — independent of the comparison period
          selected above.
        </p>

        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <ReportSection id="spend-pace" title="Spend pace" description="Cumulative spend for this event against an even-pace target line.">
            {hero.errors.spendTrend ? (
              <EmptyState title="Couldn't load spend pace" description={hero.errors.spendTrend} />
            ) : spendTrendPoints.length === 0 ? (
              <EmptyState title="Not enough data yet" description="Needs at least one entry, or an event with start/end dates set." />
            ) : (
              <TrendChart points={spendTrendPoints} valueFormat="inr-compact" />
            )}
          </ReportSection>

          <div className="flex flex-col gap-4">
            <ReportSection id="hub-status-mix" title="Hub status mix" description="Where every entry sits in the review workflow right now.">
              {hero.errors.hubStatus ? (
                <EmptyState title="Couldn't load Hub status" description={hero.errors.hubStatus} />
              ) : hubStatusSegments.every((s) => s.value === 0) || hubStatusSegments.length === 0 ? (
                <EmptyState title="No entries yet" />
              ) : (
                <DonutChart segments={hubStatusSegments} centerLabel={`${formatNumber(hero.hubStatus.reduce((s, r) => s + r.value, 0))} entries`} />
              )}
            </ReportSection>

            <ReportSection id="document-pipeline" title="Document pipeline" description="Uploaded bills, and how many make it through each stage.">
              {hero.errors.pipeline ? (
                <EmptyState title="Couldn't load the pipeline" description={hero.errors.pipeline} />
              ) : hero.pipeline.every((p) => p.count === 0) ? (
                <EmptyState title="No documents uploaded yet" />
              ) : (
                <FunnelChart stages={hero.pipeline} />
              )}
            </ReportSection>
          </div>
        </div>
      </section>
      ) : (
      <>
      <Suspense fallback={<SectionSkeleton />}>
        <BudgetGroup1 only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <VendorsGroup1 only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <BudgetGroup2 only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <IntegrityGroup1 only={only} compareBasis={compareBasis} totalSpend={hero.kpi.totalSpend} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <VendorsGroup2 only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <VendorsGroup3 only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <IntegrityGroup2 only={only} compareBasis={compareBasis} totalSpend={hero.kpi.totalSpend} selectedEvent={selectedEvent} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton />}>
        <PurchaseTreeGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <VendorScorecardGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <VendorDependencyGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <VendorPriceRankingGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <RelatedPartyGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <RateDriftDiscountGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <QuantityZoneGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <BudgetStructureGroup1 only={only} compareBasis={compareBasis} revisionHeadId={revisionHeadId} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <AdminHeadGroup only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <BudgetStructureGroup2 only={only} compareBasis={compareBasis} revisionHeadId={revisionHeadId} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <EntryTypeFlowGroup only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <SpendCurveGroup1 only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <EventComparisonGroup only={only} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <SpendCurveGroup2 only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <DuplicateRegisterGroup only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <ReconciliationGroup only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <ForensicsGroup only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <ThresholdSplittingGroup only={only} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <HsnGstAnomalyGroup only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <VendorRiskBoardGroup only={only} compareBasis={compareBasis} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <WeeklyDigestGroup only={only} eventId={currentEventId} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton />}>
        <RupeeProvenanceGroup only={only} compareBasis={compareBasis} traceEntryId={traceEntryId} />
      </Suspense>
      {isSectionInPane(only, 'board-packs') && (
        <Suspense fallback={<SectionSkeleton />}>
          <BoardPackList selectedEvent={selectedEvent} />
        </Suspense>
      )}
      </>
      )}
    </div>
  )
}

async function BudgetGroup1({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['budget-vs-actual', 'department-budget-explorer'])) return null
  const budget = await getBudgetSurface(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'budget-vs-actual') && (
        <BudgetByHeadSection
          rows={budget.byHead.rows}
          deptRows={budget.byDepartment.rows}
          error={budget.byHead.error}
          compareBasis={compareBasis}
          previousActualTotal={budget.byHead.previousActualTotal}
          insight={budget.byHead.insight}
        />
      )}
      {isSectionInPane(only, 'department-budget-explorer') && (
        <DepartmentBudgetExplorerSection
          deptRows={budget.byDepartment.rows}
          subDeptRows={budget.bySubDepartment.rows}
          deptError={budget.byDepartment.error}
          subDeptError={budget.bySubDepartment.error}
          compareBasis={compareBasis}
          previousDeptActualTotal={budget.byDepartment.previousActualTotal}
          eventName={selectedEvent?.name ?? null}
        />
      )}
    </>
  )
}

async function BudgetGroup2({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['zone-spend'])) return null
  const budget = await getBudgetSurface(compareBasis, selectedEvent)
  return (
    <ZoneSpendSection
      rows={budget.byZone.rows}
      error={budget.byZone.error}
      compareBasis={compareBasis}
      previousTotal={budget.byZone.previousTotal}
      insight={budget.byZone.insight}
    />
  )
}

async function VendorsGroup1({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['vendor-spend'])) return null
  const vendors = await getVendorsSurface(compareBasis, selectedEvent)
  return (
    <VendorSpendSection
      rows={vendors.vendorSpend.rows}
      error={vendors.vendorSpend.error}
      concentrationError={vendors.vendorSpend.concentrationError}
      compareBasis={compareBasis}
      previousSpendTotal={vendors.vendorSpend.previousSpendTotal}
      insight={vendors.vendorSpend.insight}
    />
  )
}

async function VendorsGroup2({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['spend-by-family', 'rate-benchmark'])) return null
  const vendors = await getVendorsSurface(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'spend-by-family') && (
        <SpendByFamilySection
          rows={vendors.spendByFamily.rows}
          error={vendors.spendByFamily.error}
          compareBasis={compareBasis}
          previousSpendTotal={vendors.spendByFamily.previousSpendTotal}
          insight={vendors.spendByFamily.insight}
        />
      )}
      {isSectionInPane(only, 'rate-benchmark') && (
        <RateBenchmarkSection
          rows={vendors.rateBenchmark.rows}
          error={vendors.rateBenchmark.error}
          compareBasis={compareBasis}
          previousReliableCount={vendors.rateBenchmark.previousReliableCount}
          insight={vendors.rateBenchmark.insight}
        />
      )}
    </>
  )
}

async function VendorsGroup3({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['vendor-concentration', 'above-median-overpayment', 'instrument-type-mix'])) return null
  const vendors = await getVendorsSurface(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'vendor-concentration') && (
        <VendorConcentrationSection
          points={vendors.concentrationCurve.points}
          error={vendors.concentrationCurve.error}
          compareBasis={compareBasis}
          previousTopShare={vendors.concentrationCurve.previousTopShare}
        />
      )}
      {isSectionInPane(only, 'above-median-overpayment') && (
        <AboveMedianOverpaymentSection
          rows={vendors.overpayment.rows}
          error={vendors.overpayment.error}
          compareBasis={compareBasis}
          previousTotal={vendors.overpayment.previousTotal}
          insight={vendors.overpayment.insight}
        />
      )}
      {isSectionInPane(only, 'instrument-type-mix') && (
        <InstrumentTypeMixSection
          rows={vendors.instrumentMix.rows}
          error={vendors.instrumentMix.error}
          compareBasis={compareBasis}
          previousBackedPct={vendors.instrumentMix.previousBackedPct}
          insight={vendors.instrumentMix.insight}
        />
      )}
    </>
  )
}

async function IntegrityGroup1({
  only,
  compareBasis,
  totalSpend,
  selectedEvent,
}: {
  only: string | null
  compareBasis: CompareBasis
  totalSpend: number
  selectedEvent: Event | null
}) {
  if (groupHiddenInPane(only, ['hub-status-ageing', 'open-issues', 'compliance'])) return null
  const integrity = await getIntegritySurface(compareBasis, totalSpend, selectedEvent)
  return (
    <>
      {integrity.priorError && <p className="text-xs text-destructive">{integrity.priorError}</p>}
      {isSectionInPane(only, 'hub-status-ageing') && (
        <HubStatusAgeingSection
          rows={integrity.hubAgeing.rows}
          error={integrity.hubAgeing.error}
          compareBasis={compareBasis}
          buckets={integrity.hubAgeing.buckets}
          series={integrity.hubAgeing.series}
          previousCount={integrity.hubAgeing.previousCount}
          insight={integrity.hubAgeing.insight}
        />
      )}
      {isSectionInPane(only, 'open-issues') && (
        <OpenIssuesSection
          rows={integrity.openIssues.rows}
          error={integrity.openIssues.error}
          compareBasis={compareBasis}
          series={integrity.openIssues.series}
          atRiskTotal={integrity.openIssues.atRiskTotal}
          previousAtRisk={integrity.openIssues.previousAtRisk}
          insight={integrity.openIssues.insight}
        />
      )}
      {isSectionInPane(only, 'compliance') && (
        <ComplianceSection
          rows={integrity.compliance.rows}
          error={integrity.compliance.error}
          compareBasis={compareBasis}
          series={integrity.compliance.series}
          atRiskTotal={integrity.compliance.atRiskTotal}
          byType={integrity.compliance.byType}
          previousAtRisk={integrity.compliance.previousAtRisk}
          insight={integrity.compliance.insight}
        />
      )}
    </>
  )
}

async function IntegrityGroup2({
  only,
  compareBasis,
  totalSpend,
  selectedEvent,
}: {
  only: string | null
  compareBasis: CompareBasis
  totalSpend: number
  selectedEvent: Event | null
}) {
  if (groupHiddenInPane(only, ['exception-heatmap', 'amount-at-risk-waterfall'])) return null
  const integrity = await getIntegritySurface(compareBasis, totalSpend, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'exception-heatmap') && (
        <ExceptionHeatmapSection
          rows={integrity.exceptionHeatmap.rows}
          error={integrity.exceptionHeatmap.error}
          compareBasis={compareBasis}
          previousTotalAtRisk={integrity.exceptionHeatmap.previousTotalAtRisk}
          insight={integrity.exceptionHeatmap.insight}
        />
      )}
      {isSectionInPane(only, 'amount-at-risk-waterfall') && (
        <AmountAtRiskWaterfallSection
          rows={integrity.amountAtRiskWaterfall.rows}
          totalSpend={integrity.amountAtRiskWaterfall.totalSpend}
          error={integrity.amountAtRiskWaterfall.error}
          insight={integrity.amountAtRiskWaterfall.insight}
        />
      )}
    </>
  )
}

async function PurchaseTreeGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['purchase-tree'])) return null
  const purchaseTree = await loadPurchaseTree(compareBasis, selectedEvent)
  return (
    <PurchaseTreeSection
      rows={purchaseTree.purchaseTree.rows}
      error={purchaseTree.purchaseTree.error}
      compareBasis={compareBasis}
      previousTotal={purchaseTree.purchaseTree.previousTotal}
      insight={purchaseTree.purchaseTree.insight}
    />
  )
}

async function VendorScorecardGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['vendor-scorecard', 'vendor-activity-span'])) return null
  const vendorScorecard = await loadVendorScorecard(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'vendor-scorecard') && (
        <VendorScorecardSection
          rows={vendorScorecard.scorecard.rows}
          error={vendorScorecard.scorecard.error}
          compareBasis={compareBasis}
          previousAttentionCount={vendorScorecard.scorecard.previousAttentionCount}
          insight={vendorScorecard.scorecard.insight}
        />
      )}
      {isSectionInPane(only, 'vendor-activity-span') && (
        <VendorActivitySpanSection
          rows={vendorScorecard.activitySpan.rows}
          error={vendorScorecard.activitySpan.error}
          compareBasis={compareBasis}
          previousMaterialCount={vendorScorecard.activitySpan.previousMaterialCount}
          eventStartsOn={vendorScorecard.eventStartsOn}
          eventEndsOn={vendorScorecard.eventEndsOn}
          insight={vendorScorecard.activitySpan.insight}
        />
      )}
    </>
  )
}

async function VendorDependencyGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['department-dependency', 'vendor-exclusivity', 'new-vendor-first-bill'])) return null
  const vendorDependency = await loadVendorDependency(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'department-dependency') && (
        <DepartmentDependencySection
          rows={vendorDependency.departmentDependency.rows}
          error={vendorDependency.departmentDependency.error}
          compareBasis={compareBasis}
          previousOverThresholdCount={vendorDependency.departmentDependency.previousOverThresholdCount}
          insight={vendorDependency.departmentDependency.insight}
        />
      )}
      {isSectionInPane(only, 'vendor-exclusivity') && (
        <VendorExclusivitySection
          rows={vendorDependency.vendorExclusivity.rows}
          error={vendorDependency.vendorExclusivity.error}
          compareBasis={compareBasis}
          previousMaterialCount={vendorDependency.vendorExclusivity.previousMaterialCount}
          insight={vendorDependency.vendorExclusivity.insight}
        />
      )}
      {isSectionInPane(only, 'new-vendor-first-bill') && (
        <NewVendorFirstBillSection
          rows={vendorDependency.newVendorFirstBill.rows}
          error={vendorDependency.newVendorFirstBill.error}
          compareBasis={compareBasis}
          previousFindingCount={vendorDependency.newVendorFirstBill.previousFindingCount}
          insight={vendorDependency.newVendorFirstBill.insight}
        />
      )}
    </>
  )
}

async function VendorPriceRankingGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['vendor-price-ranking'])) return null
  const quantityZonePrice = await getQuantityZonePrice(compareBasis, selectedEvent)
  return (
    <VendorPriceRankingSection
      rows={quantityZonePrice.vendorPriceByFamily.rows}
      error={quantityZonePrice.vendorPriceByFamily.error}
      compareBasis={compareBasis}
      previousMultiVendorCount={quantityZonePrice.vendorPriceByFamily.previousMultiVendorCount}
      insight={quantityZonePrice.vendorPriceByFamily.insight}
    />
  )
}

async function RelatedPartyGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['related-party-clusters', 'gstin-tax-exposure'])) return null
  const relatedPartyGstin = await loadRelatedPartyGstin(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'related-party-clusters') && (
        <RelatedPartyClustersSection
          edges={relatedPartyGstin.relatedPartyClusters.edges}
          clusters={relatedPartyGstin.relatedPartyClusters.clusters}
          error={relatedPartyGstin.relatedPartyClusters.error}
          insight={relatedPartyGstin.relatedPartyClusters.insight}
        />
      )}
      {isSectionInPane(only, 'gstin-tax-exposure') && (
        <GstinTaxExposureSection
          rows={relatedPartyGstin.taxCreditExposure.rows}
          error={relatedPartyGstin.taxCreditExposure.error}
          compareBasis={compareBasis}
          previousAtRiskTotal={relatedPartyGstin.taxCreditExposure.previousAtRiskTotal}
          insight={relatedPartyGstin.taxCreditExposure.insight}
        />
      )}
    </>
  )
}

async function RateDriftDiscountGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['rate-drift', 'discount-consistency'])) return null
  const rateDriftDiscount = await loadRateDriftDiscount(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'rate-drift') && (
        <RateDriftSection
          series={rateDriftDiscount.rateDrift.series}
          error={rateDriftDiscount.rateDrift.error}
          compareBasis={compareBasis}
          previousDriftingCount={rateDriftDiscount.rateDrift.previousDriftingCount}
          insight={rateDriftDiscount.rateDrift.insight}
        />
      )}
      {isSectionInPane(only, 'discount-consistency') && (
        <DiscountConsistencySection
          groups={rateDriftDiscount.discountConsistency.groups}
          error={rateDriftDiscount.discountConsistency.error}
          compareBasis={compareBasis}
          previousInconsistentCount={rateDriftDiscount.discountConsistency.previousInconsistentCount}
          coverage={rateDriftDiscount.discountConsistency.coverage}
          insight={rateDriftDiscount.discountConsistency.insight}
        />
      )}
    </>
  )
}

async function QuantityZoneGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['quantity-by-unit', 'zone-unit-economics'])) return null
  const quantityZonePrice = await getQuantityZonePrice(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'quantity-by-unit') && (
        <QuantityByUnitSection
          rows={quantityZonePrice.quantityByUnit.rows}
          error={quantityZonePrice.quantityByUnit.error}
          compareBasis={compareBasis}
          previousPairCount={quantityZonePrice.quantityByUnit.previousPairCount}
          insight={quantityZonePrice.quantityByUnit.insight}
        />
      )}
      {isSectionInPane(only, 'zone-unit-economics') && (
        <ZoneUnitEconomicsSection
          rows={quantityZonePrice.zoneUnitEconomics.rows}
          error={quantityZonePrice.zoneUnitEconomics.error}
          compareBasis={compareBasis}
          previousWideSpreadCount={quantityZonePrice.zoneUnitEconomics.previousWideSpreadCount}
          insight={quantityZonePrice.zoneUnitEconomics.insight}
        />
      )}
    </>
  )
}

async function BudgetStructureGroup1({ only, compareBasis, revisionHeadId }: { only: string | null; compareBasis: CompareBasis; revisionHeadId: number | null }) {
  if (groupHiddenInPane(only, ['budget-revision-history'])) return null
  const budgetStructure = await getBudgetStructure(compareBasis, revisionHeadId)
  return (
    <BudgetRevisionHistorySection
      rows={budgetStructure.revisionHistory.rows}
      error={budgetStructure.revisionHistory.error}
      selectedHeadId={budgetStructure.revisionHeadId}
      insight={budgetStructure.revisionHistory.insight}
    />
  )
}

async function BudgetStructureGroup2({ only, compareBasis, revisionHeadId }: { only: string | null; compareBasis: CompareBasis; revisionHeadId: number | null }) {
  if (groupHiddenInPane(only, ['zone-category-matrix', 'budget-category-mix'])) return null
  const budgetStructure = await getBudgetStructure(compareBasis, revisionHeadId)
  return (
    <>
      {isSectionInPane(only, 'zone-category-matrix') && (
        <ZoneCategoryMatrixSection
          rows={budgetStructure.zoneCategoryMatrix.rows}
          error={budgetStructure.zoneCategoryMatrix.error}
          insight={budgetStructure.zoneCategoryMatrix.insight}
        />
      )}
      {isSectionInPane(only, 'budget-category-mix') && (
        <BudgetCategoryMixSection
          rows={budgetStructure.budgetCategoryMix.rows}
          error={budgetStructure.budgetCategoryMix.error}
          insight={budgetStructure.budgetCategoryMix.insight}
        />
      )}
    </>
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

async function SpendCurveGroup1({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['spend-curve'])) return null
  const spendCurveOpen = await getSpendCurveOpenAgeing(compareBasis)
  return (
    <SpendCurveSection
      rows={spendCurveOpen.spendCurve.rows}
      error={spendCurveOpen.spendCurve.error}
      compareBasis={compareBasis}
      totalSpend={spendCurveOpen.spendCurve.totalSpend}
      eventWeekCount={spendCurveOpen.spendCurve.eventWeekCount}
      peakWeekStart={spendCurveOpen.spendCurve.peakWeekStart}
      peakWeekAmount={spendCurveOpen.spendCurve.peakWeekAmount}
      meanWeeklyAmount={spendCurveOpen.spendCurve.meanWeeklyAmount}
      peakMultipleOfMean={spendCurveOpen.spendCurve.peakMultipleOfMean}
      previousPeakWeekAmount={spendCurveOpen.spendCurve.previousPeakWeekAmount}
      insight={spendCurveOpen.spendCurve.insight}
    />
  )
}

async function SpendCurveGroup2({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['open-item-ageing'])) return null
  const spendCurveOpen = await getSpendCurveOpenAgeing(compareBasis)
  return (
    <OpenItemAgeingSection
      rows={spendCurveOpen.openItemAgeing.rows}
      error={spendCurveOpen.openItemAgeing.error}
      compareBasis={compareBasis}
      agedOpenCount={spendCurveOpen.openItemAgeing.agedOpenCount}
      agedAmountAtRisk={spendCurveOpen.openItemAgeing.agedAmountAtRisk}
      previousAgedOpenCount={spendCurveOpen.openItemAgeing.previousAgedOpenCount}
      insight={spendCurveOpen.openItemAgeing.insight}
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

async function DuplicateRegisterGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['duplicate-payment-register'])) return null
  const dupVendorRisk = await getDuplicateVendorRisk(compareBasis)
  return (
    <DuplicatePaymentRegisterSection
      rows={dupVendorRisk.duplicateRegister.rows}
      error={dupVendorRisk.duplicateRegister.error}
      compareBasis={compareBasis}
      previousPreventedAmount={dupVendorRisk.duplicateRegister.previousPreventedAmount}
      insight={dupVendorRisk.duplicateRegister.insight}
    />
  )
}

async function ReconciliationGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['ledger-bill-reconciliation', 'entries-without-bill'])) return null
  const reconciliationGap = await loadReconciliationGap(compareBasis)
  return (
    <>
      {isSectionInPane(only, 'ledger-bill-reconciliation') && (
        <LedgerBillReconciliationSection
          rows={reconciliationGap.ledgerBillReconciliation.rows}
          error={reconciliationGap.ledgerBillReconciliation.error}
          histogram={reconciliationGap.ledgerBillReconciliation.histogram}
          materialCount={reconciliationGap.ledgerBillReconciliation.materialCount}
          materialAbsGapTotal={reconciliationGap.ledgerBillReconciliation.materialAbsGapTotal}
          compareBasis={compareBasis}
          previousMaterialCount={reconciliationGap.ledgerBillReconciliation.previousMaterialCount}
          insight={reconciliationGap.ledgerBillReconciliation.insight}
        />
      )}
      {isSectionInPane(only, 'entries-without-bill') && (
        <EntriesWithoutBillSection
          rows={reconciliationGap.entriesWithoutBill.rows}
          error={reconciliationGap.entriesWithoutBill.error}
          byDepartment={reconciliationGap.entriesWithoutBill.byDepartment}
          byVendor={reconciliationGap.entriesWithoutBill.byVendor}
          totalUndocumented={reconciliationGap.entriesWithoutBill.totalUndocumented}
          noDocumentCount={reconciliationGap.entriesWithoutBill.noDocumentCount}
          undocumentedPctOfSpend={reconciliationGap.entriesWithoutBill.undocumentedPctOfSpend}
          compareBasis={compareBasis}
          previousTotalUndocumented={reconciliationGap.entriesWithoutBill.previousTotalUndocumented}
          insight={reconciliationGap.entriesWithoutBill.insight}
        />
      )}
    </>
  )
}

async function ForensicsGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['benford-digit-test', 'round-number-bias'])) return null
  const amountForensics = await loadAmountForensics(compareBasis)
  return (
    <>
      {isSectionInPane(only, 'benford-digit-test') && (
        <BenfordDigitTestSection
          rows={amountForensics.benford.rows}
          error={amountForensics.benford.error}
          mad={amountForensics.benford.mad}
          conformity={amountForensics.benford.conformity}
          totalCount={amountForensics.benford.totalCount}
          compareBasis={compareBasis}
          previousMad={amountForensics.benford.previousMad}
          insight={amountForensics.benford.insight}
        />
      )}
      {isSectionInPane(only, 'round-number-bias') && (
        <RoundNumberBiasSection
          rows={amountForensics.roundNumber.rows}
          error={amountForensics.roundNumber.error}
          byDepartment={amountForensics.roundNumber.byDepartment}
          byVendor={amountForensics.roundNumber.byVendor}
          overallEntryCount={amountForensics.roundNumber.overallEntryCount}
          overallRoundCount={amountForensics.roundNumber.overallRoundCount}
          overallSharePct={amountForensics.roundNumber.overallSharePct}
          compareBasis={compareBasis}
          previousOverallSharePct={amountForensics.roundNumber.previousOverallSharePct}
          insight={amountForensics.roundNumber.insight}
        />
      )}
    </>
  )
}

async function ThresholdSplittingGroup({ only }: { only: string | null }) {
  if (groupHiddenInPane(only, ['threshold-splitting'])) return null
  const thresholdSplit = await loadThresholdSplitting()
  return (
    <ThresholdSplittingSection
      activeThresholds={thresholdSplit.activeThresholds}
      thresholdError={thresholdSplit.thresholdError}
      histogram={thresholdSplit.histogram}
      entryCount={thresholdSplit.entryCount}
      entriesError={thresholdSplit.entriesError}
      splittingFlags={thresholdSplit.splittingFlags}
      splittingFlagsError={thresholdSplit.splittingFlagsError}
      insight={thresholdSplit.insight}
    />
  )
}

async function HsnGstAnomalyGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['hsn-gst-anomaly'])) return null
  const hsnGstAnomaly = await loadHsnGstAnomaly(compareBasis)
  return (
    <HsnGstAnomalySection
      rows={hsnGstAnomaly.rows}
      error={hsnGstAnomaly.error}
      hsnRateTableEmpty={hsnGstAnomaly.hsnRateTableEmpty}
      coveragePct={hsnGstAnomaly.coveragePct}
      previousCoveragePct={hsnGstAnomaly.previousCoveragePct}
      anomalyCount={hsnGstAnomaly.anomalyCount}
      billsWithBothRates={hsnGstAnomaly.billsWithBothRates}
      compareBasis={compareBasis}
      insight={hsnGstAnomaly.insight}
    />
  )
}

async function VendorRiskBoardGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['vendor-risk-board'])) return null
  const dupVendorRisk = await getDuplicateVendorRisk(compareBasis)
  return (
    <VendorRiskBoardSection
      rows={dupVendorRisk.vendorRiskBoard.rows}
      error={dupVendorRisk.vendorRiskBoard.error}
      compareBasis={compareBasis}
      previousElevatedCount={dupVendorRisk.vendorRiskBoard.previousElevatedCount}
      insight={dupVendorRisk.vendorRiskBoard.insight}
    />
  )
}

async function WeeklyDigestGroup({ only, eventId }: { only: string | null; eventId: number | null }) {
  if (groupHiddenInPane(only, ['weekly-digest'])) return null
  const weeklyDigest = await loadWeeklyDigest(eventId)
  const digestErrorText = Object.values(weeklyDigest.errors).find((e): e is string => e != null) ?? null
  return (
    <WeeklyDigestSection
      items={weeklyDigest.items}
      hasError={digestErrorText != null}
      errorText={digestErrorText}
      insight={weeklyDigest.insight}
    />
  )
}

async function RupeeProvenanceGroup({ only, compareBasis, traceEntryId }: { only: string | null; compareBasis: CompareBasis; traceEntryId: number | null }) {
  if (groupHiddenInPane(only, ['rupee-provenance'])) return null
  const rupeeProvenance = await loadRupeeProvenance(compareBasis, traceEntryId)
  return (
    <RupeeProvenanceSection
      candidates={rupeeProvenance.candidates}
      candidatesError={rupeeProvenance.candidatesError}
      chain={rupeeProvenance.chain}
      traceEntryId={rupeeProvenance.traceEntryId}
      insight={rupeeProvenance.insight}
    />
  )
}
