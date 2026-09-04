import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { toCsv } from '@/lib/reports/csv'
import { formatINR, formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import { cn } from '@/lib/utils'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { deltaToneHigherIsBad, formatDeltaVs } from '@/lib/reports/sections/shared'
import {
  RISK_BOARD_TOP_N,
  elevatedCount,
  type RiskBand,
  type VendorRiskBoardRow,
} from '@/lib/reports/surfaces/duplicate-vendor-risk'

// reporting-blueprint.md §8 Phase Six — E-03 "Vendor risk board". "The top
// vendors by spend, each with concentration, price position, document quality
// and open flags on ONE line." Composed app-side from v_vendor_scorecard; the
// risk_score weighting is documented in lib/reports/surfaces/duplicate-vendor-risk.ts.
// Colour lands ONLY on the band pill and on the price/GSTIN outliers (§4 E-01
// rule) — the rest of the board is monochrome so the eye goes to the few
// vendors that need a look.

const BAND_LABEL: Record<RiskBand, string> = {
  elevated: 'Elevated',
  watch: 'Watch',
  standard: 'Standard',
}

const BAND_CLASS: Record<RiskBand, string> = {
  elevated: 'text-red-700 dark:text-red-300 font-semibold',
  watch: 'text-amber-700 dark:text-amber-300 font-medium',
  standard: 'text-muted-foreground',
}

function priceLabel(row: VendorRiskBoardRow): { text: string; className: string } {
  if (row.avg_price_ratio == null) return { text: 'no benchmark', className: 'text-muted-foreground' }
  const ratio = `${row.avg_price_ratio.toFixed(2)}×`
  if (row.risk_breakdown.price > 0) return { text: `${ratio} above`, className: 'text-red-700 dark:text-red-300' }
  return { text: `${ratio}`, className: 'text-muted-foreground' }
}

function gstinLabel(status: VendorRiskBoardRow['gstin_status']): { text: string; className: string } {
  if (status === 'flagged') return { text: 'Flagged', className: 'text-red-700 dark:text-red-300' }
  if (status === 'missing') return { text: 'Missing', className: 'text-amber-700 dark:text-amber-300' }
  return { text: 'Valid', className: 'text-muted-foreground' }
}

/** "{N} of the top {M} vendors by spend sit in the elevated-risk band —
 *  {lead} highest at a risk score of {score}, on {reasons}." (§6 fix #3) */
export function vendorRiskBoardSentence(rows: VendorRiskBoardRow[]): string {
  if (rows.length === 0) return 'No vendor spend recorded yet this event.'
  const elevated = rows.filter((r) => r.risk_band === 'elevated')
  if (elevated.length === 0) {
    return `None of the top ${formatNumber(rows.length)} vendors by spend reach the elevated-risk band this event — no vendor combines an above-benchmark price, open flags, weak document coverage and a flagged GSTIN.`
  }
  const lead = [...elevated].sort((a, z) => z.risk_score - a.risk_score)[0]!
  const reasons: string[] = []
  if (lead.risk_breakdown.price > 0) reasons.push('priced above our benchmark')
  if (lead.risk_breakdown.flags > 0)
    reasons.push(`${formatNumber(lead.open_flag_count)} open flag${lead.open_flag_count === 1 ? '' : 's'}`)
  if (lead.risk_breakdown.docs > 0) reasons.push('weak document coverage')
  if (lead.risk_breakdown.gstin > 0) reasons.push(lead.gstin_status === 'flagged' ? 'a flagged GSTIN' : 'no GSTIN on file')
  return `${formatNumber(elevated.length)} of the top ${formatNumber(
    rows.length
  )} vendors by spend sit in the elevated-risk band this event — ${lead.vendor_display_name} highest at a risk score of ${formatNumber(
    lead.risk_score
  )}, on ${reasons.join(', ')}.`
}

export function VendorRiskBoardSection({
  rows,
  error,
  compareBasis,
  previousElevatedCount,
}: {
  rows: VendorRiskBoardRow[]
  error: string | null
  compareBasis: CompareBasis
  previousElevatedCount: number | null
}) {
  const elevated = elevatedCount(rows)
  const previous = compareBasis === 'prior_event' ? previousElevatedCount : null

  const columns: DataTableColumn<VendorRiskBoardRow>[] = [
    { key: 'rank', header: '#', align: 'right', render: (r) => formatNumber(r.rank) },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <Link
          href={`/entries?vendor=${encodeURIComponent(r.vendor_display_name)}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {r.vendor_display_name}
        </Link>
      ),
    },
    { key: 'spend', header: 'Spend', align: 'right', render: (r) => formatINRCompact(r.spend) },
    { key: 'share', header: 'Share', align: 'right', render: (r) => formatPercent(r.share_pct) },
    { key: 'cumshare', header: 'Cumulative', align: 'right', render: (r) => formatPercent(r.cumulative_share_pct) },
    {
      key: 'price',
      header: 'Price vs benchmark',
      render: (r) => {
        const p = priceLabel(r)
        return <span className={p.className}>{p.text}</span>
      },
    },
    { key: 'docs', header: 'Doc coverage', align: 'right', render: (r) => formatPercent(r.document_coverage_pct) },
    {
      key: 'gstin',
      header: 'GSTIN',
      render: (r) => {
        const g = gstinLabel(r.gstin_status)
        return <span className={g.className}>{g.text}</span>
      },
    },
    { key: 'flags', header: 'Open flags', align: 'right', render: (r) => formatNumber(r.open_flag_count) },
    {
      key: 'atrisk',
      header: '₹ at risk',
      align: 'right',
      render: (r) => (r.open_flag_amount_at_risk != null ? formatINR(r.open_flag_amount_at_risk) : '—'),
    },
    {
      key: 'band',
      header: 'Risk',
      render: (r) => (
        <span className={cn(BAND_CLASS[r.risk_band])} title={`Risk score ${r.risk_score}/10`}>
          {BAND_LABEL[r.risk_band]}
        </span>
      ),
    },
  ]

  return (
    <ReportSection
      id="vendor-risk-board"
      title="Vendor risk board"
      description={`The top ${RISK_BOARD_TOP_N} vendors by spend, each on one line — spend and cumulative concentration, price against our own benchmark, document coverage, GSTIN status, open flags and rupees at risk, and a combined risk band. The band combines an above-benchmark price, open flags, weak document coverage and a flagged GSTIN into one explainable 0–10 score.`}
      action={
        <ExportCsvButton
          filename="vendor-risk-board.csv"
          rowCount={rows.length}
          csv={toCsv(rows, [
            { header: 'Rank', value: (r) => r.rank },
            { header: 'Vendor', value: (r) => r.vendor_display_name },
            { header: 'Spend', value: (r) => r.spend },
            { header: 'Share %', value: (r) => r.share_pct },
            { header: 'Cumulative share %', value: (r) => r.cumulative_share_pct },
            { header: 'Avg price ratio vs benchmark', value: (r) => r.avg_price_ratio },
            { header: 'Priced observations', value: (r) => r.priced_observation_count },
            { header: 'Document coverage %', value: (r) => r.document_coverage_pct },
            { header: 'GSTIN status', value: (r) => r.gstin_status },
            { header: 'Open flags', value: (r) => r.open_flag_count },
            { header: 'Open flag ₹ at risk', value: (r) => r.open_flag_amount_at_risk },
            { header: 'Risk score (0-10)', value: (r) => r.risk_score },
            { header: 'Risk band', value: (r) => r.risk_band },
            { header: 'Score — price', value: (r) => r.risk_breakdown.price },
            { header: 'Score — open flags', value: (r) => r.risk_breakdown.flags },
            { header: 'Score — doc coverage', value: (r) => r.risk_breakdown.docs },
            { header: 'Score — GSTIN', value: (r) => r.risk_breakdown.gstin },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load the vendor risk board" description={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No vendor spend yet"
          description="The board ranks vendors by spend for the selected event — it fills in once entries exist."
        />
      ) : (
        <>
          <KpiTile
            label={`Top ${formatNumber(rows.length)} vendors in the elevated-risk band`}
            value={formatNumber(elevated)}
            delta={formatDeltaVs(compareBasis, elevated, previous, 'count')}
            deltaTone={deltaToneHigherIsBad(elevated, previous)}
          />
          <p className="text-sm text-muted-foreground">{vendorRiskBoardSentence(rows)}</p>
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => r.vendor_id}
            emptyTitle="No vendor spend yet"
          />
        </>
      )}
    </ReportSection>
  )
}
