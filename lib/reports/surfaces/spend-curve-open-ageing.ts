/**
 * Data loader for reporting-blueprint.md §8 Phase Six, cluster 7:
 *   A-11  Spend curve & peak weeks   -> Budget & Spend surface + Explore
 *   D-03  Open item ageing           -> Integrity surface + Explore
 *
 * One loader for two sections that live on different surfaces (the parent
 * wires A-11's section into Budget and D-03's into Integrity, and both into
 * Explore) -- they share nothing at query time but are the same Phase Six
 * cluster and the same migration (20260903000015), so a single loader keeps
 * the wiring in one place. Both views expose `event_id` as a plain output
 * column; filtering happens here.
 *
 * A-11 is NOT the Explore "spend pace" chart: that one is cumulative
 * actual-vs-even-pace (lib/reports/hero-metrics.ts computeSpendTrend). A-11
 * is per-week (non-cumulative) spend with the single peak week marked and the
 * weekly mean as a reference line -- "when does the pressure land".
 *
 * D-03 is NOT hub-status ageing: that ages the workflow pipeline (entries
 * sitting in Awaiting Verification / Validation). D-03 ages OPEN exceptions
 * and flags -- the review queue being sat on -- by days open and severity,
 * with the owning department.
 *
 * Prior-period comparison (§6 fix #1): 'prior_event' resolves the previous
 * event once and re-queries each view against it for one headline delta.
 * 'prior_week' has no effect on either section -- v_weekly_spend_curve is
 * already a full time series (the chart shows the trend directly, no
 * single-number week-over-week delta applies) and v_open_item_ageing has no
 * as-of dimension a week-old snapshot could be rebuilt from (same reasoning
 * lib/reports/surfaces/vendor-scorecard.ts documents).
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { ROW_CAP, resolvePreviousEvent, round2Local } from '@/lib/reports/sections/shared'

/** A-11 -- one row per (event, ISO week) across the gap-filled event span
 *  (20260903000015_spend_curve_open_ageing_views.sql). The four window
 *  helper columns carry the same value on every row of an event. */
export type WeeklySpendCurveRow = {
  event_id: number
  week_start: string
  entry_count: number
  total_amount: number
  event_week_count: number
  peak_week_start: string
  peak_week_amount: number
  mean_weekly_amount: number
}

/** D-03 -- one row per OPEN reconciliation_exception / flag. `id` is unique
 *  only within `source_table` (key rows on `${source_table}-${id}`).
 *  `entry_id` / `department_id` / `department_name` are null for the
 *  document-, batch- and vendor-level items; `event_id` is null when none of
 *  the item's parents carry an event (kept via `.or(...is.null)`). */
export type OpenItemAgeingRow = {
  source_table: 'reconciliation_exception' | 'flags'
  id: number
  issue_type: string
  severity: string
  amount_at_risk: number | null
  entry_id: number | null
  department_id: number | null
  department_name: string | null
  created_at: string
  days_open: number
  age_bucket: '0-7' | '8-30' | '31-60' | '60+'
  event_id: number | null
}

const SPEND_CURVE_SELECT =
  'event_id, week_start, entry_count, total_amount, event_week_count, peak_week_start, peak_week_amount, mean_weekly_amount'
const OPEN_ITEM_AGEING_SELECT =
  'source_table, id, issue_type, severity, amount_at_risk, entry_id, department_id, department_name, created_at, days_open, age_bucket, event_id'

/** age_bucket values that count as "aged" for D-03's headline ("open >30
 *  days"). Kept here so the section and any prior-period query agree. */
export const AGED_OPEN_BUCKETS: ReadonlySet<OpenItemAgeingRow['age_bucket']> = new Set(['31-60', '60+'])

export function isAgedOpenItem(row: Pick<OpenItemAgeingRow, 'age_bucket'>): boolean {
  return AGED_OPEN_BUCKETS.has(row.age_bucket)
}

export type SpendCurveOpenAgeingData = {
  eventName: string | null
  previousEventName: string | null
  spendCurve: {
    rows: WeeklySpendCurveRow[]
    error: string | null
    totalSpend: number
    eventWeekCount: number
    peakWeekStart: string | null
    peakWeekAmount: number
    meanWeeklyAmount: number
    /** peak_week_amount / mean_weekly_amount, or null when the mean is 0. */
    peakMultipleOfMean: number | null
    /** prior_event only: that event's peak_week_amount. */
    previousPeakWeekAmount: number | null
  }
  openItemAgeing: {
    rows: OpenItemAgeingRow[]
    error: string | null
    /** count of rows in the 31-60 / 60+ buckets. */
    agedOpenCount: number
    /** summed amount_at_risk across those aged rows. */
    agedAmountAtRisk: number
    /** prior_event only: that event's aged-open count. */
    previousAgedOpenCount: number | null
  }
}

export async function loadSpendCurveOpenAgeing(compareBasis: CompareBasis): Promise<SpendCurveOpenAgeingData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  const eventId = selectedEvent?.id ?? null

  const [curveRes, ageingRes] = await Promise.all([
    supabase
      .from('v_weekly_spend_curve')
      .select(SPEND_CURVE_SELECT)
      .eq('event_id', eventId)
      .order('week_start', { ascending: true })
      .limit(ROW_CAP)
      .returns<WeeklySpendCurveRow[]>(),
    // Phase 0 §0.2: an entry-less exception/flag has a null event_id -- keep
    // those regardless of the active event, never a plain `.eq`.
    eventId === null
      ? supabase
          .from('v_open_item_ageing')
          .select(OPEN_ITEM_AGEING_SELECT)
          .order('days_open', { ascending: false })
          .limit(ROW_CAP)
          .returns<OpenItemAgeingRow[]>()
      : supabase
          .from('v_open_item_ageing')
          .select(OPEN_ITEM_AGEING_SELECT)
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .order('days_open', { ascending: false })
          .limit(ROW_CAP)
          .returns<OpenItemAgeingRow[]>(),
  ])

  const curveRows = curveRes.data ?? []
  const ageingRows = ageingRes.data ?? []

  const first = curveRows[0]
  const totalSpend = round2Local(curveRows.reduce((s, r) => s + (r.total_amount ?? 0), 0))
  const peakWeekAmount = first?.peak_week_amount ?? 0
  const meanWeeklyAmount = first?.mean_weekly_amount ?? 0
  const peakMultipleOfMean = meanWeeklyAmount > 0 ? round2Local(peakWeekAmount / meanWeeklyAmount) : null

  const agedRows = ageingRows.filter(isAgedOpenItem)
  const agedOpenCount = agedRows.length
  const agedAmountAtRisk = round2Local(agedRows.reduce((s, r) => s + (r.amount_at_risk ?? 0), 0))

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousPeakWeekAmount: number | null = null
  let previousAgedOpenCount: number | null = null

  if (previousEvent) {
    const [pCurve, pAgeing] = await Promise.all([
      supabase
        .from('v_weekly_spend_curve')
        .select('peak_week_amount')
        .eq('event_id', previousEvent.id)
        .limit(1)
        .returns<{ peak_week_amount: number }[]>(),
      supabase
        .from('v_open_item_ageing')
        .select('age_bucket')
        .or(`event_id.eq.${previousEvent.id},event_id.is.null`)
        .limit(ROW_CAP)
        .returns<{ age_bucket: OpenItemAgeingRow['age_bucket'] }[]>(),
    ])
    previousPeakWeekAmount = pCurve.data?.[0]?.peak_week_amount ?? null
    previousAgedOpenCount = pAgeing.error ? null : (pAgeing.data ?? []).filter(isAgedOpenItem).length
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    spendCurve: {
      rows: curveRows,
      error: friendlyDataError(curveRes.error, 'reports:spend-curve'),
      totalSpend,
      eventWeekCount: first?.event_week_count ?? curveRows.length,
      peakWeekStart: first?.peak_week_start ?? null,
      peakWeekAmount,
      meanWeeklyAmount,
      peakMultipleOfMean,
      previousPeakWeekAmount,
    },
    openItemAgeing: {
      rows: ageingRows,
      error: friendlyDataError(ageingRes.error, 'reports:open-item-ageing'),
      agedOpenCount,
      agedAmountAtRisk,
      previousAgedOpenCount,
    },
  }
}
