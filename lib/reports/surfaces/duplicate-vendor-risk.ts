/**
 * Data loader for reporting-blueprint.md §8 Phase Six:
 *   D-04  Duplicate payment register  -> v_duplicate_payment_register
 *         (20260903000016_duplicate_register_vendor_risk_views.sql)
 *   E-03  Vendor risk board           -> composed here from v_vendor_scorecard
 *         (20260903000006) + its own pct_of_total_spend, NO new view.
 *
 * New surface file (strictly additive per this pass's remit). The two reports
 * ship together because both are "one line per {cluster,vendor}, ranked, with
 * a reserved-colour outlier call-out and a rupee headline" and neither needs
 * a heavy chart.
 *
 * Prior-period comparison (§6 fix #1): when the basis is 'prior_event' the
 * previous event is resolved once and each surface re-queries its own view
 * against it for the single headline delta it shows. 'prior_week' has no
 * effect -- neither view carries an as-of dimension a week-old snapshot could
 * be re-derived from (same reasoning lib/reports/surfaces/vendor-scorecard.ts
 * documents).
 *
 * Row types (DuplicatePaymentClusterRow, VendorRiskBoardRow) live here for
 * now; the parent hoists them into lib/reports/sections/shared.tsx during
 * integration and re-exports them from here so these imports keep working.
 *
 * -------------------------------------------------------------------------
 * E-03 risk_score -- an explainable additive points model (max 10). Four
 * independent signals, each capped, so no single dimension can dominate and a
 * reviewer can always read the score back to its parts:
 *
 *   Price vs our own benchmark   avg_price_ratio > 1.25 (RATE_ABOVE_BENCHMARK_PCT
 *                                band -- materially above)            +3
 *                                avg_price_ratio > 1.05 (outside the
 *                                PRICE_POSITION_TOLERANCE "near" band) +2
 *                                at/below benchmark, or no priced obs   0
 *   Open flags                   open_flag_count >= 3                  +3
 *                                open_flag_count >= 1                  +2
 *                                none                                  0
 *   Document coverage            document_coverage_pct < 50            +2
 *                                document_coverage_pct < 80            +1
 *                                >= 80, or unknown (null)               0
 *   GSTIN status                 'flagged' (open checksum/self-bill exc) +2
 *                                'missing'                             +1
 *                                'valid'                                0
 *
 * risk_band:  score >= 5 -> 'elevated'   (red)
 *             score >= 2 -> 'watch'      (amber)
 *             else       -> 'standard'   (neutral/green)
 *
 * Reserved status colours only (§6 fix #5): the band drives green/amber/red on
 * the outliers, never a per-vendor hue. The weighting is policy, kept here in
 * named constants so it is one edit to retune and always explainable.
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { RATE_ABOVE_BENCHMARK_PCT } from '@/lib/analytics/thresholds'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'
import { ROW_CAP, resolvePreviousEvent } from '@/lib/reports/sections/shared'
import { PRICE_POSITION_TOLERANCE } from '@/lib/reports/surfaces/vendor-scorecard'

// ---------------------------------------------------------------------------
// D-04 -- one row per duplicate-payment cluster (v_duplicate_payment_register).
// ---------------------------------------------------------------------------
export type DuplicatePaymentClusterRow = {
  flag_id: number
  severity: 'low' | 'medium' | 'high'
  status: 'open' | 'confirmed' | 'dismissed'
  vendor_id: number | null
  vendor_display_name: string | null
  department_id: number | null
  department_name: string | null
  entry_ids: number[]
  entry_count_in_cluster: number
  /** 'vendor + invoice number' | 'vendor + amount + date window' |
   *  'document hash' | 'heuristic' -- see the view header. */
  match_basis: string
  /** Rupees that would be / were paid twice. From flags.amount_at_risk
   *  (= min of the two bill amounts), or amount * (count - 1) as fallback. */
  duplicate_amount: number
  first_entry_date: string | null
  last_entry_date: string | null
  created_at: string
  last_detected_at: string
  event_id: number | null
}

const CLUSTER_SELECT =
  'flag_id, severity, status, vendor_id, vendor_display_name, department_id, department_name, entry_ids, entry_count_in_cluster, match_basis, duplicate_amount, first_entry_date, last_entry_date, created_at, last_detected_at, event_id'

/** "Prevented" = money a duplicate payment would have cost, on every cluster a
 *  reviewer has NOT dismissed. A dismissed cluster was checked and found to be
 *  two legitimate charges -- nothing was ever at risk there. Open + confirmed
 *  clusters both count: open is "caught, pending sign-off", confirmed is
 *  "caught and agreed". */
export function preventedAmount(rows: DuplicatePaymentClusterRow[]): number {
  return rows
    .filter((r) => r.status !== 'dismissed')
    .reduce((sum, r) => sum + (r.duplicate_amount ?? 0), 0)
}

export function preventedClusterCount(rows: DuplicatePaymentClusterRow[]): number {
  return rows.filter((r) => r.status !== 'dismissed').length
}

export type DuplicateRegisterStatusBreakdown = {
  flaggedCount: number
  flaggedAmount: number
  confirmedCount: number
  confirmedAmount: number
  dismissedCount: number
  dismissedAmount: number
  openCount: number
  openAmount: number
}

export function statusBreakdown(rows: DuplicatePaymentClusterRow[]): DuplicateRegisterStatusBreakdown {
  const b: DuplicateRegisterStatusBreakdown = {
    flaggedCount: rows.length,
    flaggedAmount: rows.reduce((s, r) => s + (r.duplicate_amount ?? 0), 0),
    confirmedCount: 0,
    confirmedAmount: 0,
    dismissedCount: 0,
    dismissedAmount: 0,
    openCount: 0,
    openAmount: 0,
  }
  for (const r of rows) {
    const amt = r.duplicate_amount ?? 0
    if (r.status === 'confirmed') {
      b.confirmedCount += 1
      b.confirmedAmount += amt
    } else if (r.status === 'dismissed') {
      b.dismissedCount += 1
      b.dismissedAmount += amt
    } else {
      b.openCount += 1
      b.openAmount += amt
    }
  }
  return b
}

/** "₹X across N duplicate clusters has been prevented this event — ₹Y
 *  confirmed by a reviewer, ₹Z still open. {lead vendor} accounts for the
 *  largest single cluster at ₹W." */
export function duplicateRegisterInsight(rows: DuplicatePaymentClusterRow[]): string | null {
  if (rows.length === 0) return null
  const prevented = preventedAmount(rows)
  const clusters = preventedClusterCount(rows)
  const b = statusBreakdown(rows)
  const lead = [...rows].sort((a, z) => (z.duplicate_amount ?? 0) - (a.duplicate_amount ?? 0))[0]!
  const leadText =
    lead.vendor_display_name != null
      ? ` ${lead.vendor_display_name} accounts for the largest single cluster at ${formatINRCompact(lead.duplicate_amount)}.`
      : ''
  return (
    `${formatINRCompact(prevented)} across ${formatNumber(clusters)} duplicate ` +
    `cluster${clusters === 1 ? '' : 's'} has been prevented this event — ` +
    `${formatINRCompact(b.confirmedAmount)} confirmed by a reviewer, ${formatINRCompact(b.openAmount)} still open.` +
    leadText
  )
}

// ---------------------------------------------------------------------------
// E-03 -- vendor risk board, composed from v_vendor_scorecard.
// ---------------------------------------------------------------------------

/** How many of the top-by-spend vendors the board shows. */
export const RISK_BOARD_TOP_N = 15

export type RiskBand = 'standard' | 'watch' | 'elevated'

/** Raw scorecard columns the risk board reads (subset of v_vendor_scorecard). */
type ScorecardInput = {
  vendor_id: number
  display_name: string
  total_amount: number | null
  pct_of_total_spend: number | null
  avg_price_ratio: number | null
  priced_observation_count: number
  document_coverage_pct: number | null
  gstin_status: 'missing' | 'flagged' | 'valid'
  open_flag_count: number
  open_flag_amount_at_risk: number | null
}

const SCORECARD_SELECT =
  'vendor_id, display_name, total_amount, pct_of_total_spend, avg_price_ratio, priced_observation_count, document_coverage_pct, gstin_status, open_flag_count, open_flag_amount_at_risk'

/** avg_price_ratio at/above which price counts as "materially above" our own
 *  benchmark (RATE_ABOVE_BENCHMARK_PCT is a percentage, e.g. 25 -> 1.25×). */
const PRICE_MATERIALLY_ABOVE_RATIO = 1 + RATE_ABOVE_BENCHMARK_PCT / 100

export function pricePoints(row: { avg_price_ratio: number | null }): number {
  if (row.avg_price_ratio == null) return 0
  if (row.avg_price_ratio > PRICE_MATERIALLY_ABOVE_RATIO) return 3
  if (row.avg_price_ratio > 1 + PRICE_POSITION_TOLERANCE) return 2
  return 0
}

export function openFlagPoints(row: { open_flag_count: number }): number {
  if (row.open_flag_count >= 3) return 3
  if (row.open_flag_count >= 1) return 2
  return 0
}

export function docCoveragePoints(row: { document_coverage_pct: number | null }): number {
  if (row.document_coverage_pct == null) return 0
  if (row.document_coverage_pct < 50) return 2
  if (row.document_coverage_pct < 80) return 1
  return 0
}

export function gstinPoints(row: { gstin_status: 'missing' | 'flagged' | 'valid' }): number {
  if (row.gstin_status === 'flagged') return 2
  if (row.gstin_status === 'missing') return 1
  return 0
}

export function riskScore(row: ScorecardInput): number {
  return pricePoints(row) + openFlagPoints(row) + docCoveragePoints(row) + gstinPoints(row)
}

export function riskBand(score: number): RiskBand {
  if (score >= 5) return 'elevated'
  if (score >= 2) return 'watch'
  return 'standard'
}

export type VendorRiskBoardRow = {
  vendor_id: number
  vendor_display_name: string
  rank: number
  spend: number
  share_pct: number | null
  /** Cumulative share of total spend across the ranked board, up to and
   *  including this vendor. */
  cumulative_share_pct: number
  avg_price_ratio: number | null
  priced_observation_count: number
  document_coverage_pct: number | null
  gstin_status: 'missing' | 'flagged' | 'valid'
  open_flag_count: number
  open_flag_amount_at_risk: number | null
  risk_score: number
  risk_band: RiskBand
  /** The individual point contributions, for the "why" tooltip / CSV. */
  risk_breakdown: { price: number; flags: number; docs: number; gstin: number }
}

function buildRiskBoard(rows: ScorecardInput[]): VendorRiskBoardRow[] {
  const ranked = rows
    .filter((r) => (r.total_amount ?? 0) > 0)
    .sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))
    .slice(0, RISK_BOARD_TOP_N)

  let cumulative = 0
  return ranked.map((r, i) => {
    cumulative += r.pct_of_total_spend ?? 0
    const breakdown = {
      price: pricePoints(r),
      flags: openFlagPoints(r),
      docs: docCoveragePoints(r),
      gstin: gstinPoints(r),
    }
    const score = breakdown.price + breakdown.flags + breakdown.docs + breakdown.gstin
    return {
      vendor_id: r.vendor_id,
      vendor_display_name: r.display_name,
      rank: i + 1,
      spend: r.total_amount ?? 0,
      share_pct: r.pct_of_total_spend,
      cumulative_share_pct: Math.round(cumulative * 100) / 100,
      avg_price_ratio: r.avg_price_ratio,
      priced_observation_count: r.priced_observation_count,
      document_coverage_pct: r.document_coverage_pct,
      gstin_status: r.gstin_status,
      open_flag_count: r.open_flag_count,
      open_flag_amount_at_risk: r.open_flag_amount_at_risk,
      risk_score: score,
      risk_band: riskBand(score),
      risk_breakdown: breakdown,
    }
  })
}

export function elevatedCount(rows: VendorRiskBoardRow[]): number {
  return rows.filter((r) => r.risk_band === 'elevated').length
}

/** "N of the top M vendors by spend sit in the elevated-risk band —
 *  {lead} highest at a risk score of {score}, on {reasons}." */
export function vendorRiskBoardInsight(rows: VendorRiskBoardRow[]): string | null {
  if (rows.length === 0) return null
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

// ---------------------------------------------------------------------------

export type DuplicateVendorRiskData = {
  eventName: string | null
  previousEventName: string | null
  duplicateRegister: {
    rows: DuplicatePaymentClusterRow[]
    error: string | null
    previousPreventedAmount: number | null
    previousPreventedClusterCount: number | null
    insight: string | null
  }
  vendorRiskBoard: {
    rows: VendorRiskBoardRow[]
    error: string | null
    previousElevatedCount: number | null
    insight: string | null
  }
}

export async function loadDuplicateVendorRisk(compareBasis: CompareBasis): Promise<DuplicateVendorRiskData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  const eventId = selectedEvent?.id ?? null

  const [registerRes, scorecardRes] = await Promise.all([
    // v_duplicate_payment_register carries entry-less / out-of-scope clusters
    // with a null event_id -- keep them with `.or`, never a plain `.eq`
    // (Phase 0 §0.2), same as v_compliance_summary.
    eventId === null
      ? supabase
          .from('v_duplicate_payment_register')
          .select(CLUSTER_SELECT)
          .order('duplicate_amount', { ascending: false, nullsFirst: false })
          .limit(ROW_CAP)
          .returns<DuplicatePaymentClusterRow[]>()
      : supabase
          .from('v_duplicate_payment_register')
          .select(CLUSTER_SELECT)
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .order('duplicate_amount', { ascending: false, nullsFirst: false })
          .limit(ROW_CAP)
          .returns<DuplicatePaymentClusterRow[]>(),
    supabase
      .from('v_vendor_scorecard')
      .select(SCORECARD_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<ScorecardInput[]>(),
  ])

  const registerRows = registerRes.data ?? []
  const riskBoardRows = buildRiskBoard(scorecardRes.data ?? [])

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousPreventedAmount: number | null = null
  let previousPreventedClusterCount: number | null = null
  let previousElevatedCount: number | null = null

  if (previousEvent) {
    const [pRegister, pScorecard] = await Promise.all([
      supabase
        .from('v_duplicate_payment_register')
        .select('status, duplicate_amount')
        .or(`event_id.eq.${previousEvent.id},event_id.is.null`)
        .limit(ROW_CAP)
        .returns<Pick<DuplicatePaymentClusterRow, 'status' | 'duplicate_amount'>[]>(),
      supabase
        .from('v_vendor_scorecard')
        .select(SCORECARD_SELECT)
        .eq('event_id', previousEvent.id)
        .limit(ROW_CAP)
        .returns<ScorecardInput[]>(),
    ])
    const pRegRows = (pRegister.data ?? []) as DuplicatePaymentClusterRow[]
    previousPreventedAmount = preventedAmount(pRegRows)
    previousPreventedClusterCount = preventedClusterCount(pRegRows)
    previousElevatedCount = elevatedCount(buildRiskBoard(pScorecard.data ?? []))
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    duplicateRegister: {
      rows: registerRows,
      error: friendlyDataError(registerRes.error, 'reports:duplicate-register'),
      previousPreventedAmount,
      previousPreventedClusterCount,
      insight: duplicateRegisterInsight(registerRows),
    },
    vendorRiskBoard: {
      rows: riskBoardRows,
      error: friendlyDataError(scorecardRes.error, 'reports:vendor-risk-board'),
      previousElevatedCount,
      insight: vendorRiskBoardInsight(riskBoardRows),
    },
  }
}
