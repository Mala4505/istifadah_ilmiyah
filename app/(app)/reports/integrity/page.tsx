import Link from 'next/link'
import { getCompareBasis } from '@/lib/reports/compare-basis'
import { loadIntegritySurface } from '@/lib/reports/surfaces/integrity'
import { HubStatusAgeingSection } from '@/components/reports/sections/hub-status-ageing'
import { OpenIssuesSection } from '@/components/reports/sections/open-issues'
import { ComplianceSection } from '@/components/reports/sections/compliance'
import { ExceptionHeatmapSection } from '@/components/reports/sections/exception-heatmap'
import { AmountAtRiskWaterfallSection } from '@/components/reports/sections/amount-at-risk-waterfall'

/**
 * Integrity surface (reporting-blueprint.md §5 / §8 Phase Three). One of the
 * five Reports front doors -- the review function's view of what the modules
 * are waiting on, what is flagged, and where money could be leaking. The
 * sticky event/compare-basis bar and the surface nav both live in
 * app/(app)/reports/layout.tsx, so this route is just: load the surface,
 * render its three sections.
 *
 * A thin route over per-section presenters (§6 fix #10): the same components
 * render on /reports (Explore), so the two surfaces stay identical by
 * construction.
 */
export const dynamic = 'force-dynamic'

export default async function IntegritySurfacePage() {
  const compareBasis = await getCompareBasis()
  const data = await loadIntegritySurface(compareBasis)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Integrity</h1>
          {data.eventName && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{data.eventName}</span>
          )}
        </div>
        <Link href="/reports" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Full report &amp; drill workspace →
        </Link>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        What the review function is working through: how long entries have sat in each Hub status, the open reconciliation
        exceptions and flags ranked by severity and ₹ at risk, and the compliance &amp; leakage findings the corpus sweep
        raises every 15 minutes. Every figure links through to the entries behind it; CSV export on every section.
      </p>
      {data.priorError && <p className="text-xs text-destructive">{data.priorError}</p>}

      <HubStatusAgeingSection
        rows={data.hubAgeing.rows}
        error={data.hubAgeing.error}
        compareBasis={compareBasis}
        buckets={data.hubAgeing.buckets}
        series={data.hubAgeing.series}
        previousCount={data.hubAgeing.previousCount}
      />
      <OpenIssuesSection
        rows={data.openIssues.rows}
        error={data.openIssues.error}
        compareBasis={compareBasis}
        series={data.openIssues.series}
        atRiskTotal={data.openIssues.atRiskTotal}
        previousAtRisk={data.openIssues.previousAtRisk}
      />
      <ComplianceSection
        rows={data.compliance.rows}
        error={data.compliance.error}
        compareBasis={compareBasis}
        series={data.compliance.series}
        atRiskTotal={data.compliance.atRiskTotal}
        byType={data.compliance.byType}
        previousAtRisk={data.compliance.previousAtRisk}
      />
      <ExceptionHeatmapSection
        rows={data.exceptionHeatmap.rows}
        error={data.exceptionHeatmap.error}
        compareBasis={compareBasis}
        previousTotalAtRisk={data.exceptionHeatmap.previousTotalAtRisk}
      />
      <AmountAtRiskWaterfallSection
        rows={data.amountAtRiskWaterfall.rows}
        error={data.amountAtRiskWaterfall.error}
        totalSpend={data.amountAtRiskWaterfall.totalSpend}
      />
    </div>
  )
}
