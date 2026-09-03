import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { getCompareBasis } from '@/lib/reports/compare-basis'
import { loadHeroMetrics } from '@/lib/reports/hero-metrics'
import { loadBudgetSurface } from '@/lib/reports/surfaces/budget'
import { loadVendorsSurface } from '@/lib/reports/surfaces/vendors'
import { loadIntegritySurface } from '@/lib/reports/surfaces/integrity'
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

export default async function ReportsPage() {
  const eventSupabase = await createClient()
  const selectedEvent = await getSelectedEvent(eventSupabase)
  const currentEventId = selectedEvent?.id ?? null
  const compareBasis = await getCompareBasis()

  const [hero, budget, vendors, integrity] = await Promise.all([
    loadHeroMetrics(currentEventId),
    loadBudgetSurface(compareBasis),
    loadVendorsSurface(compareBasis),
    loadIntegritySurface(compareBasis),
  ])

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
        benchmarking, and the Phase Four finding reports — vendor concentration, above-median overpayment, instrument-type
        mix, the exception heat map, and the amount-at-risk waterfall.
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
    </div>
  )
}
