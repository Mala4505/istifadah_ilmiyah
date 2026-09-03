import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { ConcentrationCurveChart } from '@/components/reports/charts/concentration-curve-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs, type ConcentrationPoint } from '@/lib/reports/sections/shared'

// reporting-blueprint.md B-01 (flagship) — the vendor concentration curve.
// "Produces one sentence leadership acts on: 62% of spend sits with 8 of 140
// vendors." Pure app-side cumulation over v_vendor_concentration; no new view.

const HALF_SHARE = 50
const HEADLINE_VENDOR_COUNT = 8

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
            delta={formatDeltaVs(compareBasis, topShare, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(topShare, previous)}
          />
          <p className="text-sm text-muted-foreground">{concentrationSentence(points)}</p>
          <ConcentrationCurveChart points={points} />
        </>
      )}
    </ReportSection>
  )
}
