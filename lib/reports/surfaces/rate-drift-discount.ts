/**
 * Data loader for reporting-blueprint.md §8 Phase Five, Family C:
 * "C-05 Rate drift across the event" and "C-06 Discount consistency".
 *
 * Both read the two views added in
 * 20260903000004_rate_drift_discount_views.sql:
 *   - v_rate_drift: one row per (vendor, item family, event, ISO week) with
 *     that week's min/median/max net_rate, plus the whole series' first and
 *     last week's median and a precomputed drift_pct.
 *   - v_discount_consistency: one row per (vendor, department, item family,
 *     event) with rate_reference.discount_pct's avg/min/max for that group,
 *     plus family-wide coverage counts (family_observation_count /
 *     family_discount_count) carried on every row for the same family+event.
 *
 * C-05 gate (blueprint spec): only vendor×item-family pairs with >= 2
 * observations across >= 2 distinct weeks. A series with >= 2 distinct weeks
 * already has >= 2 observations (one per week, minimum), so filtering on
 * `series_week_count >= 2` is sufficient and is applied here rather than in
 * the view, so the raw per-week rows stay available for anything else that
 * might query the view directly.
 *
 * C-06 coverage discipline (same as C-03/C-04, per the schema-reality note in
 * the Phase Five shared context): rate_reference.discount_pct is populated
 * only by the retired verify_document_extraction bodies
 * (20260813000002/20260814000011/20260817000003) -- the current one
 * (20260820000003) never writes it -- so against the present corpus this
 * view is expected to return few or zero rows. The loader computes a
 * corpus-wide coverage ratio (family_discount_count / family_observation_count,
 * summed over each DISTINCT (item_family_id, event_id) pair, since those two
 * columns repeat per row within a family) for the section to state plainly,
 * and the section's empty state explains what fills it in.
 *
 * Event scoping (§6 fix #1 precedent): both views expose event_id as a plain
 * column (20260822000011). rate_reference carries no event_id of its own --
 * it is resolved via `left join entries`, so an observation with no linked
 * entry, or one whose linked entry sits in a department the caller's RLS
 * hides, reads back with a null event_id and must be KEPT, not dropped --
 * hence `.or('event_id.eq.<id>,event_id.is.null')` rather than a plain
 * `.eq()`, same as v_open_issues / v_compliance_summary (and the no-active-
 * event case skips the filter entirely rather than filtering to
 * `.is.null`-only, same as lib/reports/surfaces/integrity.ts).
 *
 * Prior-period comparison (§6 fix #1): when the compare basis is
 * 'prior_event', the previous event is resolved once and each view re-run
 * against it for a headline delta. 'prior_week' has no effect here -- neither
 * aggregate carries an as-of dimension a week-old snapshot could be
 * re-derived from (same reasoning the vendors surface loader documents).
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  ROW_CAP,
  resolvePreviousEvent,
  round2Local,
  type RateDriftRow,
  type DiscountConsistencyRow,
} from '@/lib/reports/sections/shared'

// RateDriftRow / DiscountConsistencyRow (the view-shape rows) now live in
// lib/reports/sections/shared.tsx (hoisted during Phase Five integration);
// re-exported here so existing imports from this loader file keep working.
// RateDriftSeries / DiscountConsistencyGroup (the app-shape types) and their
// builder functions stay here -- report-specific, not view rows.
export type { RateDriftRow, DiscountConsistencyRow }

/** C-05 headline gate: a vendor×item-family series counts as "drifting" once
 *  its last-week median sits this many percentage points above its
 *  first-week median. A judgement call (no external benchmark exists for
 *  "meaningful mid-event escalation"), documented here rather than buried. */
export const RATE_DRIFT_FLAG_PCT = 15

/** C-06 headline gate: a vendor+item-family is "inconsistent" once the
 *  spread between its highest- and lowest-discounted department is at least
 *  this many percentage points. */
export const DISCOUNT_SPREAD_FLAG_PP = 5

// ---------------------------------------------------------------------------
// Row shapes -- field names match each view's `select` list verbatim so the
// `.select(...)` strings below port straight into shared.tsx on integration.
// ---------------------------------------------------------------------------

/** One vendor×item-family series (C-05), the shape both the section and the
 *  chart consume -- built app-side from the per-week rows since the "only
 *  series with >= 2 distinct weeks" gate and the per-series drift_pct are
 *  most naturally expressed once per series, not once per week. */
export type RateDriftSeries = {
  key: string
  vendorId: number | null
  vendorName: string
  familyKey: string
  familyLabel: string
  weeks: { weekStart: string; medianRate: number; observationCount: number; minRate: number; maxRate: number }[]
  firstWeekMedian: number
  lastWeekMedian: number
  driftPct: number | null
}

/** One vendor+item-family group (C-06), the shape both the section and the
 *  chart consume -- the department rows plus the spread the blueprint asks
 *  the app to compute (max department discount − min department discount). */
export type DiscountConsistencyGroup = {
  key: string
  vendorId: number | null
  vendorName: string
  familyKey: string
  familyLabel: string
  departments: { departmentId: number | null; departmentName: string; avgDiscountPct: number; observationCount: number }[]
  spreadPp: number
  familyObservationCount: number
  familyDiscountCount: number
}

const RATE_DRIFT_SELECT =
  'vendor_id, vendor_display_name, item_family_id, family_key, family_label, event_id, week_start, observation_count, min_rate, median_rate, max_rate, series_week_count, series_observation_count, first_week_start, first_week_median, last_week_start, last_week_median, drift_pct'
const DISCOUNT_CONSISTENCY_SELECT =
  'vendor_id, vendor_display_name, item_family_id, family_key, family_label, department_id, department_name, event_id, observation_count, avg_discount_pct, min_discount_pct, max_discount_pct, family_observation_count, family_discount_count'

/** Builds one RateDriftSeries per (vendor, item family), from the raw
 *  per-week rows a single event's worth of v_rate_drift returns, keeping
 *  only series with >= 2 distinct weeks (blueprint's comparability gate). */
export function buildRateDriftSeries(rows: RateDriftRow[]): RateDriftSeries[] {
  const byKey = new Map<string, RateDriftRow[]>()
  for (const r of rows) {
    const key = `${r.vendor_id ?? 'null'}::${r.item_family_id}`
    const bucket = byKey.get(key) ?? []
    bucket.push(r)
    byKey.set(key, bucket)
  }
  const series: RateDriftSeries[] = []
  for (const [key, groupRows] of byKey) {
    const first = groupRows[0]!
    if (first.series_week_count < 2) continue
    series.push({
      key,
      vendorId: first.vendor_id,
      vendorName: first.vendor_display_name ?? (first.vendor_id != null ? `#${first.vendor_id}` : 'Unknown vendor'),
      familyKey: first.family_key,
      familyLabel: first.family_label,
      weeks: [...groupRows]
        .sort((a, b) => a.week_start.localeCompare(b.week_start))
        .map((r) => ({
          weekStart: r.week_start,
          medianRate: r.median_rate,
          observationCount: r.observation_count,
          minRate: r.min_rate,
          maxRate: r.max_rate,
        })),
      firstWeekMedian: first.first_week_median,
      lastWeekMedian: first.last_week_median,
      driftPct: first.drift_pct,
    })
  }
  return series
}

/** Builds one DiscountConsistencyGroup per (vendor, item family), from the
 *  raw per-department rows a single event's worth of v_discount_consistency
 *  returns. The spread is max(avg_discount_pct) − min(avg_discount_pct)
 *  across the group's departments -- the blueprint's "the app can also
 *  compute" figure. */
export function buildDiscountConsistencyGroups(rows: DiscountConsistencyRow[]): DiscountConsistencyGroup[] {
  const byKey = new Map<string, DiscountConsistencyRow[]>()
  for (const r of rows) {
    const key = `${r.vendor_id ?? 'null'}::${r.item_family_id}`
    const bucket = byKey.get(key) ?? []
    bucket.push(r)
    byKey.set(key, bucket)
  }
  const groups: DiscountConsistencyGroup[] = []
  for (const [key, groupRows] of byKey) {
    const first = groupRows[0]!
    const departments = groupRows
      .map((r) => ({
        departmentId: r.department_id,
        departmentName: r.department_name ?? (r.department_id != null ? `#${r.department_id}` : 'Unattributed'),
        avgDiscountPct: r.avg_discount_pct,
        observationCount: r.observation_count,
      }))
      .sort((a, b) => b.avgDiscountPct - a.avgDiscountPct)
    const spreadPp =
      departments.length > 0
        ? round2Local(Math.max(...departments.map((d) => d.avgDiscountPct)) - Math.min(...departments.map((d) => d.avgDiscountPct)))
        : 0
    groups.push({
      key,
      vendorId: first.vendor_id,
      vendorName: first.vendor_display_name ?? (first.vendor_id != null ? `#${first.vendor_id}` : 'Unknown vendor'),
      familyKey: first.family_key,
      familyLabel: first.family_label,
      departments,
      spreadPp,
      familyObservationCount: first.family_observation_count,
      familyDiscountCount: first.family_discount_count,
    })
  }
  return groups
}

/** Corpus-wide discount coverage: family_observation_count/family_discount_count
 *  repeat per row within a (item_family_id, event_id) pair, so this dedupes
 *  by that pair before summing -- otherwise a family with several
 *  vendor/department rows would count its coverage once per row instead of
 *  once per family. */
function discountCoverage(rows: DiscountConsistencyRow[]): { observed: number; total: number } {
  const byFamilyEvent = new Map<string, { total: number; observed: number }>()
  for (const r of rows) {
    const key = `${r.item_family_id}::${r.event_id ?? 'null'}`
    if (!byFamilyEvent.has(key)) {
      byFamilyEvent.set(key, { total: r.family_observation_count, observed: r.family_discount_count })
    }
  }
  let total = 0
  let observed = 0
  for (const v of byFamilyEvent.values()) {
    total += v.total
    observed += v.observed
  }
  return { observed, total }
}

export type RateDriftDiscountData = {
  eventName: string | null
  previousEventName: string | null
  rateDrift: {
    series: RateDriftSeries[]
    error: string | null
    /** Count of drifting series (>= RATE_DRIFT_FLAG_PCT) in the prior event, for the KPI delta. */
    previousDriftingCount: number | null
  }
  discountConsistency: {
    groups: DiscountConsistencyGroup[]
    error: string | null
    coverage: { observed: number; total: number }
    /** Count of inconsistent groups (>= DISCOUNT_SPREAD_FLAG_PP) in the prior event, for the KPI delta. */
    previousInconsistentCount: number | null
  }
}

/**
 * Perf remediation Phase 2.2 (docs/performance-remediation-plan.md):
 * `selectedEvent` is resolved once by the caller (the page already
 * called getSelectedEvent()) and passed in, rather than this loader
 * re-resolving it itself -- same reasoning as loadHeroMetrics/
 * loadExecutiveBrief taking `eventId` as a parameter.
 */
export async function loadRateDriftDiscount(compareBasis: CompareBasis, selectedEvent: Event | null): Promise<RateDriftDiscountData> {
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null

  // No active event: no filter at all, rather than an `.is.null`-only filter
  // that would drop every real observation -- same precedent as
  // lib/reports/surfaces/integrity.ts's v_open_issues/v_compliance_summary
  // handling (Phase 0 §0.2).
  const [driftRes, discountRes] = await Promise.all([
    eventId === null
      ? supabase
          .from('v_rate_drift')
          .select(RATE_DRIFT_SELECT)
          .order('week_start', { ascending: true })
          .limit(ROW_CAP)
          .returns<RateDriftRow[]>()
      : supabase
          .from('v_rate_drift')
          .select(RATE_DRIFT_SELECT)
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .order('week_start', { ascending: true })
          .limit(ROW_CAP)
          .returns<RateDriftRow[]>(),
    eventId === null
      ? supabase.from('v_discount_consistency').select(DISCOUNT_CONSISTENCY_SELECT).limit(ROW_CAP).returns<DiscountConsistencyRow[]>()
      : supabase
          .from('v_discount_consistency')
          .select(DISCOUNT_CONSISTENCY_SELECT)
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(ROW_CAP)
          .returns<DiscountConsistencyRow[]>(),
  ])

  const driftSeries = buildRateDriftSeries(driftRes.data ?? [])
  const discountGroups = buildDiscountConsistencyGroups(discountRes.data ?? [])
  const coverage = discountCoverage(discountRes.data ?? [])

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousDriftingCount: number | null = null
  let previousInconsistentCount: number | null = null

  if (previousEvent) {
    const previousFilter = `event_id.eq.${previousEvent.id},event_id.is.null`
    const [pDrift, pDiscount] = await Promise.all([
      supabase.from('v_rate_drift').select(RATE_DRIFT_SELECT).or(previousFilter).returns<RateDriftRow[]>(),
      supabase.from('v_discount_consistency').select(DISCOUNT_CONSISTENCY_SELECT).or(previousFilter).returns<DiscountConsistencyRow[]>(),
    ])
    previousDriftingCount = buildRateDriftSeries(pDrift.data ?? []).filter(
      (s) => s.driftPct != null && s.driftPct >= RATE_DRIFT_FLAG_PCT
    ).length
    previousInconsistentCount = buildDiscountConsistencyGroups(pDiscount.data ?? []).filter(
      (g) => g.spreadPp >= DISCOUNT_SPREAD_FLAG_PP
    ).length
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    rateDrift: {
      series: driftSeries,
      error: friendlyDataError(driftRes.error, 'reports:vendors:rate-drift'),
      previousDriftingCount,
    },
    discountConsistency: {
      groups: discountGroups,
      error: friendlyDataError(discountRes.error, 'reports:vendors:discount-consistency'),
      coverage,
      previousInconsistentCount,
    },
  }
}
