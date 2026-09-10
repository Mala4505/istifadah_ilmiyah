import { cache } from 'react'
import type { Event } from '@/lib/events/types'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { loadIntegritySurface } from '@/lib/reports/surfaces/integrity'
import { SURFACE_SECTIONS, sectionHref } from '@/lib/reports/surface-sections'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { EmptyState } from '@/components/reports/empty-state'
import { ExceptionHeatmapSection } from '@/components/reports/sections/exception-heatmap'
import { AmountAtRiskWaterfallSection } from '@/components/reports/sections/amount-at-risk-waterfall'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'

/**
 * The "rest state" of the Integrity surface pane (redesign plan Phase 3.2 /
 * 3.3): what renders when `?report=` is unset. A hero tile row → the two
 * flagship Family-D sections (exception heat map, amount-at-risk waterfall) →
 * a disclosure listing every other Integrity breakdown as a deep link.
 *
 * Mirrors the integrity page's group signature: it takes `totalSpend` as a
 * prop (the page gets it from `loadHeroMetrics` and passes it to
 * `loadIntegritySurface`; the Phase 3.3 orchestrator will pass it in the same
 * way here) rather than loading hero metrics itself. `loadIntegritySurface`
 * is wrapped in `cache()` at module scope so this component and anything else
 * on the pane that needs the same surface share one query per request.
 *
 * The two flagship `*Section` components already render their own
 * ReportSection card, KPI tile, insight sentence, chart and table, and handle
 * their own errors via `<EmptyState>` — they are reused verbatim, not
 * re-implemented, and no second summary sentence is added. Error handling
 * here covers only what this component renders directly: the hero tiles.
 */

const getIntegritySurface = cache(loadIntegritySurface)

/**
 * The two Integrity sections promoted to full-fidelity charts in the band
 * above; every remaining `SURFACE_SECTIONS.integrity` entry becomes a link in
 * the disclosure. Counted from the module, never hardcoded — if the surface's
 * section list changes, the "Show all N breakdowns" figure follows.
 */
const FLAGSHIP_SECTION_IDS: ReadonlySet<string> = new Set(['exception-heatmap', 'amount-at-risk-waterfall'])

export async function IntegrityOverview({
  compareBasis,
  totalSpend,
  selectedEvent,
}: {
  compareBasis: CompareBasis
  totalSpend: number
  selectedEvent: Event | null
}) {
  const data = await getIntegritySurface(compareBasis, totalSpend, selectedEvent)

  const exceptionAtRisk = data.exceptionHeatmap.rows.reduce((sum, r) => sum + r.amount_at_risk, 0)
  const exceptionIssueCount = data.exceptionHeatmap.rows.reduce((sum, r) => sum + r.issue_count, 0)
  const openIssuesCount = data.openIssues.rows.length
  const agedInHubStatus = data.hubAgeing.buckets['8+']

  // The hero figures are drawn directly from these three section slices — if
  // one failed to load, show the friendly reason instead of misleading ₹0 / 0
  // tiles. The flagship sections below still surface their own errors.
  const heroError = data.openIssues.error ?? data.exceptionHeatmap.error ?? data.hubAgeing.error

  const remainingSections = SURFACE_SECTIONS.integrity.filter((s) => !FLAGSHIP_SECTION_IDS.has(s.id))

  return (
    <div className="flex flex-col gap-4">
      {/* Hero tile row — plan 3.2 step 1 */}
      {heroError ? (
        <EmptyState title="Couldn't load the integrity overview figures" description={heroError} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile label="Open ₹ at risk" value={formatINRCompact(data.openIssues.atRiskTotal)} />
          <KpiTile label="Open issues" value={formatNumber(openIssuesCount)} />
          <KpiTile
            label="Exceptions & flags ₹ at risk"
            value={formatINRCompact(exceptionAtRisk)}
            delta={`${formatNumber(exceptionIssueCount)} open ${exceptionIssueCount === 1 ? 'finding' : 'findings'}`}
            deltaTone="neutral"
          />
          <KpiTile label="Entries aged 8+ days in hub status" value={formatNumber(agedInHubStatus)} />
        </div>
      )}
      {data.priorError && <p className="text-xs text-destructive">{data.priorError}</p>}

      {/* Two flagship sections — plan 3.2 step 2. Stacked full-width rather
          than a lg:grid-cols-2 split: each section embeds its own KPI tile and
          a full multi-column DataTable, and the heat-map matrix needs the
          horizontal room for its department axis — both read badly at half the
          (already index-narrowed) pane width. Per the dataviz skill's
          judgment call, and the plan's explicit allowance for it. */}
      <div className="flex flex-col gap-4">
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

      {/* Disclosure — plan 3.2 step 3. A discovery aid: one deep link per
          remaining Integrity section, not a second copy of the page. */}
      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground marker:text-muted-foreground">
          Show all {remainingSections.length} breakdowns
        </summary>
        <ul className="mt-3 flex flex-col gap-1">
          {remainingSections.map((s) => (
            <li key={s.id}>
              <a
                href={sectionHref('integrity', s.id)}
                className="text-sm text-primary underline-offset-2 hover:underline"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
