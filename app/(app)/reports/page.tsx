import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { getCompareBasis } from '@/lib/reports/compare-basis'
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
import { BudgetByHeadSection } from '@/components/reports/sections/budget-by-head'
import { DepartmentBudgetSection } from '@/components/reports/sections/department-budget'
import { SubDepartmentBudgetSection } from '@/components/reports/sections/sub-department-budget'
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
export const dynamic = 'force-dynamic'

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'budget-vs-actual', label: 'Budget vs Actual' },
  { id: 'department-budget-vs-actual', label: 'Department Budget vs Actual' },
  { id: 'sub-department-budget-vs-actual', label: 'Sub-department Budget vs Actual' },
  { id: 'vendor-spend', label: 'Vendor Spend' },
  { id: 'zone-spend', label: 'Spend by Zone' },
  { id: 'hub-status-ageing', label: 'Hub-status Ageing' },
  { id: 'open-issues', label: 'Open Issues' },
  { id: 'compliance', label: 'Compliance & Leakage' },
  { id: 'spend-by-family', label: 'Spend by Item Family' },
  { id: 'rate-benchmark', label: 'Rate Benchmark' },
  { id: 'vendor-concentration', label: 'Concentration Curve' },
  { id: 'above-median-overpayment', label: 'Above-median Overpayment' },
  { id: 'instrument-type-mix', label: 'Instrument-type Mix' },
  { id: 'exception-heatmap', label: 'Exception Heat Map' },
  { id: 'amount-at-risk-waterfall', label: 'Amount-at-risk Waterfall' },
  // §8 Phase Five
  { id: 'purchase-tree', label: 'Purchase Tree' },
  { id: 'vendor-scorecard', label: 'Vendor Scorecard' },
  { id: 'vendor-activity-span', label: 'Vendor Activity Span & Dormancy' },
  { id: 'department-dependency', label: 'Department Dependency' },
  { id: 'vendor-exclusivity', label: 'Vendor Exclusivity' },
  { id: 'new-vendor-first-bill', label: 'New Vendor, First Bill' },
  { id: 'vendor-price-ranking', label: 'Price Ranking per Family' },
  { id: 'related-party-clusters', label: 'Related-party Clusters' },
  { id: 'gstin-tax-exposure', label: 'GSTIN Validity & Tax Exposure' },
  { id: 'rate-drift', label: 'Rate Drift Across the Event' },
  { id: 'discount-consistency', label: 'Discount Consistency' },
  { id: 'quantity-by-unit', label: 'Quantity by Unit' },
  { id: 'zone-unit-economics', label: 'Unit Economics by Zone' },
  // §8 Phase Six + the Family A/D/E catalogue gaps
  { id: 'admin-head-accountability', label: 'Admin-head Accountability' },
  { id: 'budget-revision-history', label: 'Budget Revision History' },
  { id: 'zone-category-matrix', label: 'Zone × Category Matrix' },
  { id: 'budget-category-mix', label: 'Budget Category Mix' },
  { id: 'entry-type-split', label: 'Entry-type Split by Department' },
  { id: 'outstanding-advance-ageing', label: 'Outstanding Advance Ageing' },
  { id: 'reimbursement-profile', label: 'Reimbursement Profile' },
  { id: 'spend-curve', label: 'Spend Curve & Peak Weeks' },
  { id: 'event-comparison', label: 'Event-over-event Comparison' },
  { id: 'open-item-ageing', label: 'Open-item Ageing' },
  { id: 'duplicate-payment-register', label: 'Duplicate Payment Register' },
  { id: 'ledger-bill-reconciliation', label: 'Ledger vs Bill Reconciliation' },
  { id: 'entries-without-bill', label: 'Entries with No Supporting Bill' },
  { id: 'benford-digit-test', label: "Benford's Law Digit Test" },
  { id: 'round-number-bias', label: 'Round-number Bias' },
  { id: 'threshold-splitting', label: 'Threshold Splitting' },
  { id: 'hsn-gst-anomaly', label: 'HSN Coverage & GST Anomaly' },
  { id: 'vendor-risk-board', label: 'Vendor Risk Board' },
  { id: 'weekly-digest', label: 'Weekly Digest' },
  { id: 'rupee-provenance', label: 'Rupee Provenance Trace' },
  { id: 'board-packs', label: 'Board Packs' },
] as const

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
  searchParams: Promise<{ trace_entry_id?: string; revision_head_id?: string }>
}) {
  const eventSupabase = await createClient()
  const selectedEvent = await getSelectedEvent(eventSupabase)
  const currentEventId = selectedEvent?.id ?? null
  const compareBasis = await getCompareBasis()
  const sp = await searchParams
  const traceEntryId = parsePositiveIntParam(sp.trace_entry_id)
  const revisionHeadId = parsePositiveIntParam(sp.revision_head_id)

  const [
    hero,
    budget,
    vendors,
    integrity,
    purchaseTree,
    rateDriftDiscount,
    quantityZonePrice,
    vendorScorecard,
    vendorDependency,
    relatedPartyGstin,
    budgetStructure,
    adminHead,
    entryTypeFlow,
    spendCurveOpen,
    eventComparison,
    reconciliationGap,
    amountForensics,
    dupVendorRisk,
    thresholdSplit,
    hsnGstAnomaly,
    rupeeProvenance,
    weeklyDigest,
  ] = await Promise.all([
    loadHeroMetrics(currentEventId),
    loadBudgetSurface(compareBasis),
    loadVendorsSurface(compareBasis),
    loadIntegritySurface(compareBasis),
    loadPurchaseTree(compareBasis),
    loadRateDriftDiscount(compareBasis),
    loadQuantityZonePrice(compareBasis),
    loadVendorScorecard(compareBasis),
    loadVendorDependency(compareBasis),
    loadRelatedPartyGstin(compareBasis),
    loadBudgetStructure(compareBasis, revisionHeadId),
    loadAdminHeadAccountability(compareBasis),
    loadEntryTypeFlow(compareBasis),
    loadSpendCurveOpenAgeing(compareBasis),
    loadEventComparison(),
    loadReconciliationGap(compareBasis),
    loadAmountForensics(compareBasis),
    loadDuplicateVendorRisk(compareBasis),
    loadThresholdSplitting(),
    loadHsnGstAnomaly(compareBasis),
    loadRupeeProvenance(compareBasis, traceEntryId),
    loadWeeklyDigest(currentEventId),
  ])

  const digestErrorText = Object.values(weeklyDigest.errors).find((e): e is string => e != null) ?? null

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
      <p className="max-w-2xl text-sm text-muted-foreground">
        Every report section in one scroll, with CSV on each — the pivot-and-drill workspace behind the four focused
        surfaces above. An overview of this event (spend pace, Hub status mix, document pipeline), then budget vs actual,
        vendor spend, zone spend, Hub-status ageing, open issues, compliance &amp; leakage flags, item-family spend, rate
        benchmarking, the Phase Four finding reports — vendor concentration, above-median overpayment, instrument-type
        mix, the exception heat map, and the amount-at-risk waterfall — and the Phase Five reports: the purchase tree,
        vendor scorecards and activity spans, department/vendor dependency and exclusivity, new-vendor first bills, price
        ranking per item family, related-party vendor clusters, GSTIN validity &amp; tax exposure, rate drift, discount
        consistency, and quantity/unit-economics by zone.
      </p>

      <nav className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border pb-3 text-xs">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="text-muted-foreground hover:text-foreground hover:underline">
            {s.label}
          </a>
        ))}
      </nav>

      {integrity.priorError && <p className="text-xs text-destructive">{integrity.priorError}</p>}

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

      <BudgetByHeadSection
        rows={budget.byHead.rows}
        deptRows={budget.byDepartment.rows}
        error={budget.byHead.error}
        compareBasis={compareBasis}
        previousActualTotal={budget.byHead.previousActualTotal}
      />
      <DepartmentBudgetSection
        rows={budget.byDepartment.rows}
        error={budget.byDepartment.error}
        compareBasis={compareBasis}
        previousActualTotal={budget.byDepartment.previousActualTotal}
      />
      <SubDepartmentBudgetSection
        rows={budget.bySubDepartment.rows}
        deptRows={budget.byDepartment.rows}
        error={budget.bySubDepartment.error}
        compareBasis={compareBasis}
        previousActualTotal={budget.bySubDepartment.previousActualTotal}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <VendorSpendSection
          rows={vendors.vendorSpend.rows}
          error={vendors.vendorSpend.error}
          concentrationError={vendors.vendorSpend.concentrationError}
          compareBasis={compareBasis}
          previousSpendTotal={vendors.vendorSpend.previousSpendTotal}
        />
        <ZoneSpendSection
          rows={budget.byZone.rows}
          error={budget.byZone.error}
          compareBasis={compareBasis}
          previousTotal={budget.byZone.previousTotal}
        />
        <HubStatusAgeingSection
          rows={integrity.hubAgeing.rows}
          error={integrity.hubAgeing.error}
          compareBasis={compareBasis}
          buckets={integrity.hubAgeing.buckets}
          series={integrity.hubAgeing.series}
          previousCount={integrity.hubAgeing.previousCount}
        />
        <OpenIssuesSection
          rows={integrity.openIssues.rows}
          error={integrity.openIssues.error}
          compareBasis={compareBasis}
          series={integrity.openIssues.series}
          atRiskTotal={integrity.openIssues.atRiskTotal}
          previousAtRisk={integrity.openIssues.previousAtRisk}
        />
        <ComplianceSection
          rows={integrity.compliance.rows}
          error={integrity.compliance.error}
          compareBasis={compareBasis}
          series={integrity.compliance.series}
          atRiskTotal={integrity.compliance.atRiskTotal}
          byType={integrity.compliance.byType}
          previousAtRisk={integrity.compliance.previousAtRisk}
        />
        <SpendByFamilySection
          rows={vendors.spendByFamily.rows}
          error={vendors.spendByFamily.error}
          compareBasis={compareBasis}
          previousSpendTotal={vendors.spendByFamily.previousSpendTotal}
        />
        <RateBenchmarkSection
          rows={vendors.rateBenchmark.rows}
          error={vendors.rateBenchmark.error}
          compareBasis={compareBasis}
          previousReliableCount={vendors.rateBenchmark.previousReliableCount}
        />
      </div>

      {/* Phase Four finding reports (reporting-blueprint.md §8): B-01, C-04,
          C-09, D-01, D-02. Full width — each carries a flagship chart that
          reads badly in the two-column grid above. */}
      <VendorConcentrationSection
        points={vendors.concentrationCurve.points}
        error={vendors.concentrationCurve.error}
        compareBasis={compareBasis}
        previousTopShare={vendors.concentrationCurve.previousTopShare}
      />
      <AboveMedianOverpaymentSection
        rows={vendors.overpayment.rows}
        error={vendors.overpayment.error}
        compareBasis={compareBasis}
        previousTotal={vendors.overpayment.previousTotal}
      />
      <InstrumentTypeMixSection
        rows={vendors.instrumentMix.rows}
        error={vendors.instrumentMix.error}
        compareBasis={compareBasis}
        previousBackedPct={vendors.instrumentMix.previousBackedPct}
      />
      <ExceptionHeatmapSection
        rows={integrity.exceptionHeatmap.rows}
        error={integrity.exceptionHeatmap.error}
        compareBasis={compareBasis}
        previousTotalAtRisk={integrity.exceptionHeatmap.previousTotalAtRisk}
      />
      <AmountAtRiskWaterfallSection
        rows={integrity.amountAtRiskWaterfall.rows}
        totalSpend={integrity.amountAtRiskWaterfall.totalSpend}
        error={integrity.amountAtRiskWaterfall.error}
      />

      {/* §8 Phase Five -- the rest of the line-item family (C-02, C-05..C-08)
          and the vendor family (B-02..B-09). Same full-width treatment as the
          Phase Four reports above. */}
      <PurchaseTreeSection
        rows={purchaseTree.purchaseTree.rows}
        error={purchaseTree.purchaseTree.error}
        compareBasis={compareBasis}
        previousTotal={purchaseTree.purchaseTree.previousTotal}
      />
      <VendorScorecardSection
        rows={vendorScorecard.scorecard.rows}
        error={vendorScorecard.scorecard.error}
        compareBasis={compareBasis}
        previousAttentionCount={vendorScorecard.scorecard.previousAttentionCount}
      />
      <VendorActivitySpanSection
        rows={vendorScorecard.activitySpan.rows}
        error={vendorScorecard.activitySpan.error}
        compareBasis={compareBasis}
        previousMaterialCount={vendorScorecard.activitySpan.previousMaterialCount}
        eventStartsOn={vendorScorecard.eventStartsOn}
        eventEndsOn={vendorScorecard.eventEndsOn}
      />
      <DepartmentDependencySection
        rows={vendorDependency.departmentDependency.rows}
        error={vendorDependency.departmentDependency.error}
        compareBasis={compareBasis}
        previousOverThresholdCount={vendorDependency.departmentDependency.previousOverThresholdCount}
      />
      <VendorExclusivitySection
        rows={vendorDependency.vendorExclusivity.rows}
        error={vendorDependency.vendorExclusivity.error}
        compareBasis={compareBasis}
        previousMaterialCount={vendorDependency.vendorExclusivity.previousMaterialCount}
      />
      <NewVendorFirstBillSection
        rows={vendorDependency.newVendorFirstBill.rows}
        error={vendorDependency.newVendorFirstBill.error}
        compareBasis={compareBasis}
        previousFindingCount={vendorDependency.newVendorFirstBill.previousFindingCount}
      />
      <VendorPriceRankingSection
        rows={quantityZonePrice.vendorPriceByFamily.rows}
        error={quantityZonePrice.vendorPriceByFamily.error}
        compareBasis={compareBasis}
        previousMultiVendorCount={quantityZonePrice.vendorPriceByFamily.previousMultiVendorCount}
      />
      <RelatedPartyClustersSection
        edges={relatedPartyGstin.relatedPartyClusters.edges}
        clusters={relatedPartyGstin.relatedPartyClusters.clusters}
        error={relatedPartyGstin.relatedPartyClusters.error}
      />
      <GstinTaxExposureSection
        rows={relatedPartyGstin.taxCreditExposure.rows}
        error={relatedPartyGstin.taxCreditExposure.error}
        compareBasis={compareBasis}
        previousAtRiskTotal={relatedPartyGstin.taxCreditExposure.previousAtRiskTotal}
      />
      <RateDriftSection
        series={rateDriftDiscount.rateDrift.series}
        error={rateDriftDiscount.rateDrift.error}
        compareBasis={compareBasis}
        previousDriftingCount={rateDriftDiscount.rateDrift.previousDriftingCount}
      />
      <DiscountConsistencySection
        groups={rateDriftDiscount.discountConsistency.groups}
        error={rateDriftDiscount.discountConsistency.error}
        compareBasis={compareBasis}
        previousInconsistentCount={rateDriftDiscount.discountConsistency.previousInconsistentCount}
        coverage={rateDriftDiscount.discountConsistency.coverage}
      />
      <QuantityByUnitSection
        rows={quantityZonePrice.quantityByUnit.rows}
        error={quantityZonePrice.quantityByUnit.error}
        compareBasis={compareBasis}
        previousPairCount={quantityZonePrice.quantityByUnit.previousPairCount}
      />
      <ZoneUnitEconomicsSection
        rows={quantityZonePrice.zoneUnitEconomics.rows}
        error={quantityZonePrice.zoneUnitEconomics.error}
        compareBasis={compareBasis}
        previousWideSpreadCount={quantityZonePrice.zoneUnitEconomics.previousWideSpreadCount}
      />

      {/* §8 Phase Six + the Family A/D/E catalogue gaps. Full width, same
          treatment as the Phase Four/Five reports above. */}
      <BudgetRevisionHistorySection
        rows={budgetStructure.revisionHistory.rows}
        error={budgetStructure.revisionHistory.error}
        selectedHeadId={budgetStructure.revisionHeadId}
      />
      <AdminHeadAccountabilitySection
        rows={adminHead.accountability.rows}
        error={adminHead.accountability.error}
        compareBasis={compareBasis}
        previousSpendTotal={adminHead.accountability.previousSpendTotal}
      />
      <ZoneCategoryMatrixSection rows={budgetStructure.zoneCategoryMatrix.rows} error={budgetStructure.zoneCategoryMatrix.error} />
      <BudgetCategoryMixSection rows={budgetStructure.budgetCategoryMix.rows} error={budgetStructure.budgetCategoryMix.error} />
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
      <OpenItemAgeingSection
        rows={spendCurveOpen.openItemAgeing.rows}
        error={spendCurveOpen.openItemAgeing.error}
        compareBasis={compareBasis}
        agedOpenCount={spendCurveOpen.openItemAgeing.agedOpenCount}
        agedAmountAtRisk={spendCurveOpen.openItemAgeing.agedAmountAtRisk}
        previousAgedOpenCount={spendCurveOpen.openItemAgeing.previousAgedOpenCount}
      />
      <DuplicatePaymentRegisterSection
        rows={dupVendorRisk.duplicateRegister.rows}
        error={dupVendorRisk.duplicateRegister.error}
        compareBasis={compareBasis}
        previousPreventedAmount={dupVendorRisk.duplicateRegister.previousPreventedAmount}
      />
      <LedgerBillReconciliationSection
        rows={reconciliationGap.ledgerBillReconciliation.rows}
        error={reconciliationGap.ledgerBillReconciliation.error}
        histogram={reconciliationGap.ledgerBillReconciliation.histogram}
        materialCount={reconciliationGap.ledgerBillReconciliation.materialCount}
        materialAbsGapTotal={reconciliationGap.ledgerBillReconciliation.materialAbsGapTotal}
        compareBasis={compareBasis}
        previousMaterialCount={reconciliationGap.ledgerBillReconciliation.previousMaterialCount}
      />
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
      />
      <BenfordDigitTestSection
        rows={amountForensics.benford.rows}
        error={amountForensics.benford.error}
        mad={amountForensics.benford.mad}
        conformity={amountForensics.benford.conformity}
        totalCount={amountForensics.benford.totalCount}
        compareBasis={compareBasis}
        previousMad={amountForensics.benford.previousMad}
      />
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
      />
      <ThresholdSplittingSection
        activeThresholds={thresholdSplit.activeThresholds}
        thresholdError={thresholdSplit.thresholdError}
        histogram={thresholdSplit.histogram}
        entryCount={thresholdSplit.entryCount}
        entriesError={thresholdSplit.entriesError}
        splittingFlags={thresholdSplit.splittingFlags}
        splittingFlagsError={thresholdSplit.splittingFlagsError}
      />
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
      <VendorRiskBoardSection
        rows={dupVendorRisk.vendorRiskBoard.rows}
        error={dupVendorRisk.vendorRiskBoard.error}
        compareBasis={compareBasis}
        previousElevatedCount={dupVendorRisk.vendorRiskBoard.previousElevatedCount}
      />
      <WeeklyDigestSection items={weeklyDigest.items} hasError={digestErrorText != null} errorText={digestErrorText} />
      <RupeeProvenanceSection
        candidates={rupeeProvenance.candidates}
        candidatesError={rupeeProvenance.candidatesError}
        chain={rupeeProvenance.chain}
        traceEntryId={rupeeProvenance.traceEntryId}
      />
      <BoardPackList />
    </div>
  )
}
