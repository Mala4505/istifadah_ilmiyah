import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { ConcentrationCurveChart } from '@/components/reports/charts/lazy'
import { DonutChart, type DonutSegment } from '@/components/reports/charts/lazy'
import { CATEGORICAL_PALETTE, OTHER_STEP } from '@/components/reports/charts/categorical-palette'
import { toCsv } from '@/lib/reports/csv'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs, type ConcentrationPoint } from '@/lib/reports/sections/shared'

// reporting-blueprint.md B-01 (flagship) — the vendor concentration curve.
// "Produces one sentence leadership acts on: 62% of spend sits with 8 of 140
// vendors." Pure app-side cumulation over v_vendor_concentration; no new view.

const HALF_SHARE = 50
const HEADLINE_VENDOR_COUNT = 8
const DONUT_BAND = 5

/**
 * Headline donut (visual-optimisation plan Phase 3.5): the curve answers "how
 * steep is the dependence" for analysts, but the leadership question is a
 * share -- so lead with three bands, Top 5 / Next 5 / Everyone else, in ₹.
 * Two categorical hues + the neutral "Other" step; bands that would be empty
 * (an event with ≤ 5 or ≤ 10 vendors) are simply omitted. `points` arrives
 * ranked largest-first (rank 1 = biggest).
 */
export function concentrationBands(points: ConcentrationPoint[]): DonutSegment[] {
  const sum = (from: number, to: number) => points.slice(from, to).reduce((s, p) => s + p.spend, 0)
  const top = Math.min(DONUT_BAND, points.length)
  const next = Math.min(DONUT_BAND * 2, points.length) - top
  const rest = points.length - top - next
  const bands: DonutSegment[] = [
    {
      key: 'top',
      label: `Top ${formatNumber(top)} vendors`,
      value: sum(0, top),
      colorClass: CATEGORICAL_PALETTE[0]!.strokeClass,
      hex: CATEGORICAL_PALETTE[0]!.hex,
    },
    {
      key: 'next',
      label: `Next ${formatNumber(next)} vendors`,
      value: sum(top, top + next),
      colorClass: CATEGORICAL_PALETTE[1]!.strokeClass,
      hex: CATEGORICAL_PALETTE[1]!.hex,
    },
    {
      key: 'rest',
      label: `Everyone else (${formatNumber(rest)} vendors)`,
      value: sum(top + next, points.length),
      colorClass: OTHER_STEP.strokeClass,
      hex: OTHER_STEP.hex,
    },
  ]
  // An empty band sums to 0 — drop it rather than draw a ₹0 legend line.
  return bands.filter((b) => b.value > 0)
}

/** The fewest top-ranked vendors whose combined spend clears `threshold`%. */
export function vendorsToReachShare(points: ConcentrationPoint[], threshold: number): number | null {
  const hit = points.find((p) => p.cumulativeSharePct >= threshold)
  return hit ? hit.rank : null
}

/** "The top 8 of 140 vendors carry 62% of this event's spend." (§6 fix #3) */
export function concentrationSentence(points: ConcentrationPoint[]): string {
  if (points.length === 0) return 'No vendor spend recorded yet.'
  const n = points.length
  const halfAt = vendorsToReachShare(points, HALF_SHARE)
  const topShare = points[Math.min(HEADLINE_VENDOR_COUNT, n) - 1]!.cumulativeSharePct
  const topCount = Math.min(HEADLINE_VENDOR_COUNT, n)
  const lead = `The top ${formatNumber(topCount)} of ${formatNumber(n)} vendors carry ${formatPercent(topShare)} of this event's spend.`
  if (halfAt == null || halfAt >= n) return lead
  return `${lead} Half of all spend sits with just ${formatNumber(halfAt)} of them.`
}

export function VendorConcentrationSection({
  points,
  error,
  compareBasis,
  previousTopShare,
}: {
  points: ConcentrationPoint[]
  error: string | null
  compareBasis: CompareBasis
  previousTopShare: number | null
}) {
  const n = points.length
  const topCount = Math.min(HEADLINE_VENDOR_COUNT, n)
  const topShare = n > 0 ? points[topCount - 1]!.cumulativeSharePct : 0
  const previous = compareBasis === 'prior_event' ? previousTopShare : null
  const bands = concentrationBands(points)
  const totalSpend = points.reduce((s, p) => s + p.spend, 0)

  return (
    <ReportSection
      id="vendor-concentration"
      title="Vendor concentration curve"
      description="Cumulative share of spend as vendors are added, ranked largest first. The gap between the curve and the straight “equal share” line is how dependent this event is on a handful of suppliers — one axis, one line, deliberately not a dual-scale Pareto."
      action={
        <ExportCsvButton
          filename="vendor-concentration-curve.csv"
          rowCount={points.length}
          csv={toCsv(points, [
            { header: 'Rank', value: (p) => p.rank },
            { header: 'Vendor', value: (p) => p.vendorName },
            { header: 'Spend', value: (p) => p.spend },
            { header: 'Share %', value: (p) => p.sharePct },
            { header: 'Cumulative share %', value: (p) => p.cumulativeSharePct },
            { header: 'Even-share %', value: (p) => p.evenSharePct },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load vendor concentration" description={error} />
      ) : points.length === 0 ? (
        <EmptyState title="No vendor spend yet" description="Vendors are created automatically as entries import." />
      ) : (
        <>
          <KpiTile
            label={`Top ${topCount} vendors' share of spend`}
            value={formatPercent(topShare)}
            delta={formatDeltaVs(compareBasis, topShare, previous, 'pp')}
            deltaTone={deltaToneHigherIsBad(topShare, previous)}
          />
          <p className="text-sm text-muted-foreground">{concentrationSentence(points)}</p>
          {bands.length > 1 && (
            <DonutChart segments={bands} centerLabel={formatINRCompact(totalSpend)} valueFormat="inr-compact" />
          )}
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Full curve</p>
          <ConcentrationCurveChart points={points} />
        </>
      )}
    </ReportSection>
  )
}
