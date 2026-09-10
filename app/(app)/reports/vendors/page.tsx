import { Suspense, cache } from 'react'
import Link from 'next/link'
import { getSelectedEvent } from '@/lib/events/current'
import type { Event } from '@/lib/events/types'
import { getCompareBasis, type CompareBasis } from '@/lib/reports/compare-basis'
import { loadVendorsSurface } from '@/lib/reports/surfaces/vendors'
import { loadPurchaseTree } from '@/lib/reports/surfaces/purchase-tree'
import { loadRateDriftDiscount } from '@/lib/reports/surfaces/rate-drift-discount'
import { loadQuantityZonePrice } from '@/lib/reports/surfaces/quantity-zone-price'
import { loadVendorScorecard } from '@/lib/reports/surfaces/vendor-scorecard'
import { loadVendorDependency } from '@/lib/reports/surfaces/vendor-dependency'
import { loadRelatedPartyGstin } from '@/lib/reports/surfaces/related-party-gstin'
import { loadHsnGstAnomaly } from '@/lib/reports/surfaces/hsn-gst-anomaly'
import { loadDuplicateVendorRisk } from '@/lib/reports/surfaces/duplicate-vendor-risk'
import { VendorSpendSection } from '@/components/reports/sections/vendor-spend'
import { VendorConcentrationSection } from '@/components/reports/sections/vendor-concentration'
import { AboveMedianOverpaymentSection } from '@/components/reports/sections/above-median-overpayment'
import { InstrumentTypeMixSection } from '@/components/reports/sections/instrument-type-mix'
import { SpendByFamilySection } from '@/components/reports/sections/spend-by-family'
import { RateBenchmarkSection } from '@/components/reports/sections/rate-benchmark'
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
import { HsnGstAnomalySection } from '@/components/reports/sections/hsn-gst-anomaly'
import { VendorRiskBoardSection } from '@/components/reports/sections/vendor-risk-board'
import { SectionSkeleton } from '@/components/reports/sections/surface-loading'
import { VendorsOverview } from '@/components/reports/overviews/vendors-overview'
import {
  OVERVIEW_SECTION,
  resolveSection,
  isSectionInPane,
  groupHiddenInPane,
} from '@/lib/reports/surface-sections'

/**
 * Vendors & Purchases surface (reporting-blueprint.md §5 / §8 Phase Three).
 * One of the five Reports front doors -- procurement's view of who the money
 * went to and what it bought. The sticky event/compare-basis bar and the
 * surface nav both live in app/(app)/reports/layout.tsx, so this route is
 * just: load the surface, render its sections.
 *
 * A thin route over per-section presenters (§6 fix #10): the same components
 * render on /reports (Explore), so the two surfaces stay identical by
 * construction.
 *
 * §8 Phase Five adds the rest of the line-item family (C-02, C-05..C-08) and
 * the vendor family (B-02..B-09), each with its own single-surface loader
 * (lib/reports/surfaces/{purchase-tree,rate-drift-discount,
 * quantity-zone-price,vendor-scorecard,vendor-dependency,
 * related-party-gstin}.ts) so a slow query on one report never blocks
 * another (§8 Phase Three's "one loader per surface" reasoning, applied here
 * one loader per *report cluster* since these were built independently).
 *
 * Perf remediation Phase 6.1 (docs/performance-remediation-plan.md): each
 * loader below used to be one member of a single page-wide `Promise.all`,
 * so the slowest of the nine gated every section, including ones that
 * resolved instantly. Each is now awaited inside its own async Server
 * Component behind its own `<Suspense>`. `loadQuantityZonePrice` feeds two
 * non-adjacent groups of sections -- wrapped in `cache()` so both groups
 * share one query instead of running it twice.
 */
export const dynamic = 'force-dynamic'

const getQuantityZonePrice = cache(loadQuantityZonePrice)

export default async function VendorsSurfacePage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string }>
}) {
  const { report } = await searchParams
  const active = resolveSection('vendors', report)
  const isOverview = active.id === OVERVIEW_SECTION.id
  const only = isOverview ? null : active.id

  const compareBasis = await getCompareBasis()
  const selectedEvent = await getSelectedEvent()
  const eventName = selectedEvent?.name ?? null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Vendors &amp; Purchases</h1>
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
            Who the money went to and what it bought — vendor spend with document coverage and open-flag exposure, spend
            grouped into cross-vendor item families, and median rate benchmarks wherever enough vendors bill the same
            family to make the comparison meaningful. Every vendor links through to the entries behind it; CSV export on
            every section.
          </p>
          <Suspense fallback={<SectionSkeleton />}>
            <VendorsOverview compareBasis={compareBasis} selectedEvent={selectedEvent} />
          </Suspense>
        </>
      ) : (
        <>
          <Suspense fallback={<SectionSkeleton />}>
            <VendorsSurfaceGroup only={only} compareBasis={compareBasis} selectedEvent={selectedEvent} />
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
            <HsnGstAnomalyGroup only={only} compareBasis={compareBasis} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <VendorRiskBoardGroup only={only} compareBasis={compareBasis} />
          </Suspense>
        </>
      )}
    </div>
  )
}

async function VendorsSurfaceGroup({ only, compareBasis, selectedEvent }: { only: string | null; compareBasis: CompareBasis; selectedEvent: Event | null }) {
  if (groupHiddenInPane(only, ['vendor-spend', 'vendor-concentration', 'above-median-overpayment', 'instrument-type-mix', 'spend-by-family', 'rate-benchmark'])) return null
  const data = await loadVendorsSurface(compareBasis, selectedEvent)
  return (
    <>
      {isSectionInPane(only, 'vendor-spend') && (
        <VendorSpendSection
          rows={data.vendorSpend.rows}
          error={data.vendorSpend.error}
          concentrationError={data.vendorSpend.concentrationError}
          compareBasis={compareBasis}
          previousSpendTotal={data.vendorSpend.previousSpendTotal}
        />
      )}
      {isSectionInPane(only, 'vendor-concentration') && (
        <VendorConcentrationSection
          points={data.concentrationCurve.points}
          error={data.concentrationCurve.error}
          compareBasis={compareBasis}
          previousTopShare={data.concentrationCurve.previousTopShare}
        />
      )}
      {isSectionInPane(only, 'above-median-overpayment') && (
        <AboveMedianOverpaymentSection
          rows={data.overpayment.rows}
          error={data.overpayment.error}
          compareBasis={compareBasis}
          previousTotal={data.overpayment.previousTotal}
        />
      )}
      {isSectionInPane(only, 'instrument-type-mix') && (
        <InstrumentTypeMixSection
          rows={data.instrumentMix.rows}
          error={data.instrumentMix.error}
          compareBasis={compareBasis}
          previousBackedPct={data.instrumentMix.previousBackedPct}
        />
      )}
      {isSectionInPane(only, 'spend-by-family') && (
        <SpendByFamilySection
          rows={data.spendByFamily.rows}
          error={data.spendByFamily.error}
          compareBasis={compareBasis}
          previousSpendTotal={data.spendByFamily.previousSpendTotal}
        />
      )}
      {isSectionInPane(only, 'rate-benchmark') && (
        <RateBenchmarkSection
          rows={data.rateBenchmark.rows}
          error={data.rateBenchmark.error}
          compareBasis={compareBasis}
          previousReliableCount={data.rateBenchmark.previousReliableCount}
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
        />
      )}
      {isSectionInPane(only, 'vendor-exclusivity') && (
        <VendorExclusivitySection
          rows={vendorDependency.vendorExclusivity.rows}
          error={vendorDependency.vendorExclusivity.error}
          compareBasis={compareBasis}
          previousMaterialCount={vendorDependency.vendorExclusivity.previousMaterialCount}
        />
      )}
      {isSectionInPane(only, 'new-vendor-first-bill') && (
        <NewVendorFirstBillSection
          rows={vendorDependency.newVendorFirstBill.rows}
          error={vendorDependency.newVendorFirstBill.error}
          compareBasis={compareBasis}
          previousFindingCount={vendorDependency.newVendorFirstBill.previousFindingCount}
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
        />
      )}
      {isSectionInPane(only, 'gstin-tax-exposure') && (
        <GstinTaxExposureSection
          rows={relatedPartyGstin.taxCreditExposure.rows}
          error={relatedPartyGstin.taxCreditExposure.error}
          compareBasis={compareBasis}
          previousAtRiskTotal={relatedPartyGstin.taxCreditExposure.previousAtRiskTotal}
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
        />
      )}
      {isSectionInPane(only, 'discount-consistency') && (
        <DiscountConsistencySection
          groups={rateDriftDiscount.discountConsistency.groups}
          error={rateDriftDiscount.discountConsistency.error}
          compareBasis={compareBasis}
          previousInconsistentCount={rateDriftDiscount.discountConsistency.previousInconsistentCount}
          coverage={rateDriftDiscount.discountConsistency.coverage}
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
        />
      )}
      {isSectionInPane(only, 'zone-unit-economics') && (
        <ZoneUnitEconomicsSection
          rows={quantityZonePrice.zoneUnitEconomics.rows}
          error={quantityZonePrice.zoneUnitEconomics.error}
          compareBasis={compareBasis}
          previousWideSpreadCount={quantityZonePrice.zoneUnitEconomics.previousWideSpreadCount}
        />
      )}
    </>
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
    />
  )
}

async function VendorRiskBoardGroup({ only, compareBasis }: { only: string | null; compareBasis: CompareBasis }) {
  if (groupHiddenInPane(only, ['vendor-risk-board'])) return null
  const dupRisk = await loadDuplicateVendorRisk(compareBasis)
  return (
    <VendorRiskBoardSection
      rows={dupRisk.vendorRiskBoard.rows}
      error={dupRisk.vendorRiskBoard.error}
      compareBasis={compareBasis}
      previousElevatedCount={dupRisk.vendorRiskBoard.previousElevatedCount}
    />
  )
}
