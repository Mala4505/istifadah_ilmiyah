/**
 * Data loader for reporting-blueprint.md §3 Family B: B-02 vendor scorecard
 * and B-09 activity span & dormancy. Split into its own surface file (rather
 * than added to lib/reports/surfaces/vendors.ts) so it queries only its own
 * two views (20260903000006_vendor_scorecard_dormancy_views.sql) — matching
 * §8 Phase Three's "one loader per surface, so a slow query doesn't block a
 * page" reasoning, and keeping this a strictly additive file per this
 * session's remit.
 *
 * Both views expose `event_id` as a plain output column; filtering happens
 * here at the query site, matching every other surface loader.
 *
 * Prior-period comparison (§6 fix #1): when the compare basis is
 * 'prior_event', the previous event is resolved once and a lightweight
 * re-query against it produces the one headline delta number each section
 * needs. 'prior_week' has no effect here — neither view carries an as-of
 * dimension a week-old snapshot could be re-derived from (same reasoning
 * lib/reports/surfaces/vendors.ts documents for its own aggregates).
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { CONCENTRATION_MIN_TOTAL } from '@/lib/analytics/thresholds'
import {
  ROW_CAP,
  resolvePreviousEvent,
  type VendorScorecardRow,
  type VendorActivitySpanRow,
} from '@/lib/reports/sections/shared'

// VendorScorecardRow / VendorActivitySpanRow now live in
// lib/reports/sections/shared.tsx (hoisted during Phase Five integration);
// re-exported here so existing imports from this loader file keep working.
export type { VendorScorecardRow, VendorActivitySpanRow }

const SCORECARD_SELECT =
  'vendor_id, display_name, normalized_name, is_confirmed, entry_count, total_amount, first_entry_date, last_entry_date, entries_with_documents, document_coverage_pct, pct_of_total_spend, gstin, gstin_status, avg_price_ratio, priced_observation_count, avg_discount_pct, discount_observation_count, flag_history_count, open_flag_count, open_flag_amount_at_risk'

const ACTIVITY_SPAN_SELECT =
  'vendor_id, display_name, normalized_name, first_entry_date, last_entry_date, active_span_days, entry_count, distinct_active_days, max_gap_days, total_spend, max_single_amount, single_appearance, active_dates'

/** How far a vendor's average price ratio has to sit from 1.0× before the
 *  scorecard calls it "above" or "below" our own benchmark rather than "near"
 *  it — the same kind of tolerance-band reasoning GST_RATE_TOLERANCE_PCT
 *  applies to implied tax rates (lib/analytics/thresholds.ts), just for a
 *  price ratio instead of a percentage-point gap. Exported so the chart and
 *  section agree on one definition of "above benchmark". */
export const PRICE_POSITION_TOLERANCE = 0.05

export function priceIsAboveBenchmark(row: { avg_price_ratio: number | null }): boolean {
  return row.avg_price_ratio != null && row.avg_price_ratio > 1 + PRICE_POSITION_TOLERANCE
}

/** B-02 headline predicate: "number of vendors with an open flag OR priced
 *  above benchmark" (per this report's task brief). */
export function vendorNeedsAttention(row: { open_flag_count: number; avg_price_ratio: number | null }): boolean {
  return row.open_flag_count > 0 || priceIsAboveBenchmark(row)
}

/** B-09 materiality bar for "appears once for a LARGE amount" — reusing
 *  CONCENTRATION_MIN_TOTAL (lib/analytics/thresholds.ts: "the total a
 *  cluster must reach before it is worth surfacing") rather than inventing a
 *  second, undocumented magic number for the same kind of judgment call. If
 *  the two should diverge, promote this to its own named constant in that
 *  file — see INTEGRATION NOTES. */
export const SINGLE_APPEARANCE_MATERIALITY_THRESHOLD = CONCENTRATION_MIN_TOTAL

export function isMaterialSingleAppearance(row: { single_appearance: boolean; total_spend: number | null }): boolean {
  return row.single_appearance && (row.total_spend ?? 0) >= SINGLE_APPEARANCE_MATERIALITY_THRESHOLD
}

export type VendorScorecardSurfaceData = {
  eventName: string | null
  previousEventName: string | null
  /** Event date bounds for the activity timeline chart's shared time axis
   *  (blueprint: "X axis = calendar weeks of the event"). Null when the
   *  selected event has no recorded start/end — the chart falls back to the
   *  min/max of the rows it's given. */
  eventStartsOn: string | null
  eventEndsOn: string | null
  scorecard: {
    rows: VendorScorecardRow[]
    error: string | null
    previousAttentionCount: number | null
  }
  activitySpan: {
    rows: VendorActivitySpanRow[]
    error: string | null
    previousMaterialCount: number | null
    previousMaterialAmount: number | null
  }
}

/**
 * Perf remediation Phase 2.2 (docs/performance-remediation-plan.md):
 * `selectedEvent` is resolved once by the caller (the page already
 * called getSelectedEvent()) and passed in, rather than this loader
 * re-resolving it itself -- same reasoning as loadHeroMetrics/
 * loadExecutiveBrief taking `eventId` as a parameter.
 */
export async function loadVendorScorecard(compareBasis: CompareBasis, selectedEvent: Event | null): Promise<VendorScorecardSurfaceData> {
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null

  const [scorecardRes, activityRes] = await Promise.all([
    supabase
      .from('v_vendor_scorecard')
      .select(SCORECARD_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorScorecardRow[]>(),
    supabase
      .from('v_vendor_activity_span')
      .select(ACTIVITY_SPAN_SELECT)
      .eq('event_id', eventId)
      .order('total_spend', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorActivitySpanRow[]>(),
  ])

  const scorecardRows = scorecardRes.data ?? []
  const activityRows = activityRes.data ?? []

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousAttentionCount: number | null = null
  let previousMaterialCount: number | null = null
  let previousMaterialAmount: number | null = null

  if (previousEvent) {
    const [pScorecard, pActivity] = await Promise.all([
      supabase
        .from('v_vendor_scorecard')
        .select('open_flag_count, avg_price_ratio')
        .eq('event_id', previousEvent.id)
        .returns<{ open_flag_count: number; avg_price_ratio: number | null }[]>(),
      supabase
        .from('v_vendor_activity_span')
        .select('single_appearance, total_spend')
        .eq('event_id', previousEvent.id)
        .returns<{ single_appearance: boolean; total_spend: number | null }[]>(),
    ])
    previousAttentionCount = (pScorecard.data ?? []).filter(vendorNeedsAttention).length
    const materialPrev = (pActivity.data ?? []).filter(isMaterialSingleAppearance)
    previousMaterialCount = materialPrev.length
    previousMaterialAmount = materialPrev.reduce((s, r) => s + (r.total_spend ?? 0), 0)
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    eventStartsOn: selectedEvent?.startsOn ?? null,
    eventEndsOn: selectedEvent?.endsOn ?? null,
    scorecard: {
      rows: scorecardRows,
      error: friendlyDataError(scorecardRes.error, 'reports:vendors:scorecard'),
      previousAttentionCount,
    },
    activitySpan: {
      rows: activityRows,
      error: friendlyDataError(activityRes.error, 'reports:vendors:activity-span'),
      previousMaterialCount,
      previousMaterialAmount,
    },
  }
}
