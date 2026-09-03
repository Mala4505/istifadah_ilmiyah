import Link from 'next/link'
import { getCompareBasis } from '@/lib/reports/compare-basis'
import { loadVendorsSurface } from '@/lib/reports/surfaces/vendors'
import { VendorSpendSection } from '@/components/reports/sections/vendor-spend'
import { VendorConcentrationSection } from '@/components/reports/sections/vendor-concentration'
import { AboveMedianOverpaymentSection } from '@/components/reports/sections/above-median-overpayment'
import { InstrumentTypeMixSection } from '@/components/reports/sections/instrument-type-mix'
import { SpendByFamilySection } from '@/components/reports/sections/spend-by-family'
import { RateBenchmarkSection } from '@/components/reports/sections/rate-benchmark'

/**
 * Vendors & Purchases surface (reporting-blueprint.md §5 / §8 Phase Three).
 * One of the five Reports front doors -- procurement's view of who the money
 * went to and what it bought. The sticky event/compare-basis bar and the
 * surface nav both live in app/(app)/reports/layout.tsx, so this route is
 * just: load the surface, render its three sections.
 *
 * A thin route over per-section presenters (§6 fix #10): the same components
 * render on /reports (Explore), so the two surfaces stay identical by
 * construction.
 */
export const dynamic = 'force-dynamic'

export default async function VendorsSurfacePage() {
  const compareBasis = await getCompareBasis()
  const data = await loadVendorsSurface(compareBasis)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Vendors &amp; Purchases</h1>
          {data.eventName && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{data.eventName}</span>
          )}
        </div>
        <Link href="/reports" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          Full report &amp; drill workspace →
        </Link>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Who the money went to and what it bought — vendor spend with document coverage and open-flag exposure, spend grouped
        into cross-vendor item families, and median rate benchmarks wherever enough vendors bill the same family to make the
        comparison meaningful. Every vendor links through to the entries behind it; CSV export on every section.
      </p>

      <VendorSpendSection
        rows={data.vendorSpend.rows}
        error={data.vendorSpend.error}
        concentrationError={data.vendorSpend.concentrationError}
        compareBasis={compareBasis}
        previousSpendTotal={data.vendorSpend.previousSpendTotal}
      />
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
      <InstrumentTypeMixSection
        rows={data.instrumentMix.rows}
        error={data.instrumentMix.error}
        compareBasis={compareBasis}
        previousBackedPct={data.instrumentMix.previousBackedPct}
      />
      <SpendByFamilySection
        rows={data.spendByFamily.rows}
        error={data.spendByFamily.error}
        compareBasis={compareBasis}
        previousSpendTotal={data.spendByFamily.previousSpendTotal}
      />
      <RateBenchmarkSection
        rows={data.rateBenchmark.rows}
        error={data.rateBenchmark.error}
        compareBasis={compareBasis}
        previousReliableCount={data.rateBenchmark.previousReliableCount}
      />
    </div>
  )
}
