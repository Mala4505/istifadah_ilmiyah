import { cache } from 'react'
import type { Event } from '@/lib/events/types'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { loadVendorsSurface } from '@/lib/reports/surfaces/vendors'
import { SURFACE_SECTIONS, sectionHref } from '@/lib/reports/surface-sections'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { EmptyState } from '@/components/reports/empty-state'
import { VendorConcentrationSection } from '@/components/reports/sections/vendor-concentration'
import { AboveMedianOverpaymentSection } from '@/components/reports/sections/above-median-overpayment'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'

/**
 * The "rest state" of the Vendors & Purchases surface pane (redesign plan
 * Phase 3.2 / 3.3): what renders when `?report=` is unset. A hero tile row →
 * the two flagship Family-B/C sections (vendor concentration curve,
 * above-median overpayment) → a disclosure listing every other Vendors
 * breakdown as a deep link.
 *
 * Mirrors `vendors/page.tsx`'s `VendorsSurfaceGroup` signature: it takes
 * `compareBasis` + `selectedEvent` and calls `loadVendorsSurface` with them
 * (the page already resolves both via `getCompareBasis()` / `getSelectedEvent()`;
 * the Phase 3.3 orchestrator will pass them in the same way here) rather than
 * resolving them itself. `loadVendorsSurface` is wrapped in `cache()` at module
 * scope so this component and anything else on the pane that needs the same
 * surface share one query per request.
 *
 * The two flagship `*Section` components already render their own
 * ReportSection card, KPI tile, insight sentence, chart and table, and handle
 * their own errors via `<EmptyState>` — they are reused verbatim (prop wiring
 * copied from `VendorsSurfaceGroup`), not re-implemented, and no second summary
 * sentence is added. Error handling here covers only what this component
 * renders directly: the hero tiles.
 */

const getVendorsSurface = cache(loadVendorsSurface)

/**
 * The two Vendors sections promoted to full-fidelity charts in the band above;
 * every remaining `SURFACE_SECTIONS.vendors` entry becomes a link in the
 * disclosure. Counted from the module, never hardcoded — if the surface's
 * section list changes, the "Show all N breakdowns" figure follows.
 */
const FLAGSHIP_SECTION_IDS: ReadonlySet<string> = new Set(['vendor-concentration', 'above-median-overpayment'])

/** Mirrors `vendor-concentration.tsx`'s `HEADLINE_VENDOR_COUNT` — the top-N
 *  slice the concentration headline and this hero tile both report on. */
const TOP_VENDOR_COUNT = 8

export async function VendorsOverview({
  compareBasis,
  selectedEvent,
}: {
  compareBasis: CompareBasis
  selectedEvent: Event | null
}) {
  const data = await getVendorsSurface(compareBasis, selectedEvent)

  const vendorCount = data.vendorSpend.rows.length
  const totalVendorSpend = data.vendorSpend.rows.reduce((sum, r) => sum + (r.total_amount ?? 0), 0)
  const aboveMedianTotal = data.overpayment.rows.reduce((sum, r) => sum + r.overpayment_amount, 0)

  const points = data.concentrationCurve.points
  const topCount = Math.min(TOP_VENDOR_COUNT, points.length)
  const topShare = points.length > 0 ? points[topCount - 1]!.cumulativeSharePct : null

  // The hero figures are drawn directly from these three section slices — if
  // one failed to load, show the friendly reason instead of misleading ₹0 / 0
  // tiles. The flagship sections below still surface their own errors.
  const heroError = data.vendorSpend.error ?? data.concentrationCurve.error ?? data.overpayment.error

  const remainingSections = SURFACE_SECTIONS.vendors.filter((s) => !FLAGSHIP_SECTION_IDS.has(s.id))

  return (
    <div className="flex flex-col gap-4">
      {/* Hero tile row — plan 3.2 step 1 */}
      {heroError ? (
        <EmptyState title="Couldn't load the vendors overview figures" description={heroError} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile label="Vendors with spend" value={formatNumber(vendorCount)} />
          <KpiTile label="Total vendor spend" value={formatINRCompact(totalVendorSpend)} />
          <KpiTile
            label={topCount > 0 ? `Top ${formatNumber(topCount)} vendors' share of spend` : "Top vendors' share of spend"}
            value={formatPercent(topShare)}
          />
          <KpiTile
            label="Above-median spend"
            value={formatINRCompact(aboveMedianTotal)}
            delta="above our own median rate"
            deltaTone="neutral"
          />
        </div>
      )}

      {/* Two flagship sections — plan 3.2 step 2. Stacked full-width rather
          than a lg:grid-cols-2 split: each section embeds its own KPI tile and
          the overpayment section a full eight-column DataTable plus a strip
          plot whose x-resolution needs the room, while the concentration
          curve's whole point is the gap between its line and the equal-share
          diagonal — both read badly at half the (already index-narrowed) pane
          width. Per the dataviz skill's judgment call and the plan's explicit
          allowance, and consistent with the Integrity overview's twin. */}
      <div className="flex flex-col gap-4">
        <VendorConcentrationSection
          points={data.concentrationCurve.points}
          error={data.concentrationCurve.error}
          compareBasis={compareBasis}
          previousTopShare={data.concentrationCurve.previousTopShare}
        />
        <AboveMedianOverpaymentSection
          rows={data.overpayment.rows}
          error={data.overpayment.error}
          compareBasis={compareBasis}
          previousTotal={data.overpayment.previousTotal}
        />
      </div>

      {/* Disclosure — plan 3.2 step 3. A discovery aid: one deep link per
          remaining Vendors section, not a second copy of the page. */}
      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground marker:text-muted-foreground">
          Show all {remainingSections.length} breakdowns
        </summary>
        <ul className="mt-3 flex flex-col gap-1">
          {remainingSections.map((s) => (
            <li key={s.id}>
              <a
                href={sectionHref('vendors', s.id)}
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
