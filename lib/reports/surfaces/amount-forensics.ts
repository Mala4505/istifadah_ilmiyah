/**
 * Data loader for reporting-blueprint.md §8 Phase Six, Family D forensics:
 * D-07 Benford's Law leading-digit test and D-08 round-number bias. Both are
 * pure distribution tests over entries.amount (non-void), so they share one
 * surface file and one migration (20260903000010_amount_distribution_views.sql)
 * rather than being folded into a spend/vendor loader -- matching §8 Phase
 * Three's "one loader per surface, so a slow query doesn't block a page".
 *
 * Both views expose event_id as a plain output column; filtering happens here
 * at the query site (.eq('event_id', eventId)), matching every other surface
 * loader. Entries whose event can't be resolved (event_id null) are a
 * negligible, pre-event-scoping tail and are simply not part of either test
 * for a selected event -- unlike the finding views (integrity.ts), neither of
 * these carries entry-less rows that a plain .eq would wrongly drop.
 *
 * Two things are computed app-side rather than in SQL:
 *   - The Benford goodness-of-fit statistic (MAD, mean absolute deviation)
 *     and its conformity verdict. It is one scalar per event, trivially
 *     derived from the nine digit rows, and keeping the bands here means they
 *     can be retuned without a migration.
 *   - The round-number rollups. v_round_number_bias stays at (department,
 *     vendor) grain; this loader re-aggregates it to department-level,
 *     vendor-level and an overall figure, and applies a minimum-entry-count
 *     materiality bar to the two ranked rollups so a vendor with one round
 *     entry isn't reported as "100% round".
 *
 * Prior-period comparison (§6 fix #1): 'prior_event' re-runs both views
 * against the previous event for one headline delta each (Benford MAD,
 * round-number overall share). 'prior_week' has no effect -- neither view
 * carries an as-of dimension a week-old snapshot could be re-derived from
 * (same reasoning lib/reports/surfaces/vendors.ts documents).
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { ROW_CAP, resolvePreviousEvent, round2Local } from '@/lib/reports/sections/shared'

// ---------------------------------------------------------------------------
// Row shapes. These live here for now; the parent hoists them into
// lib/reports/sections/shared.tsx during Phase Six integration (matching how
// every other Phase 4/5 surface's row types were hoisted). Exported so the
// section + chart components import them from one place.
// ---------------------------------------------------------------------------

/** One row of v_benford_leading_digit: a single leading digit (1..9) for one
 *  event. `observed_pct` / `expected_pct` are percentages (0..100), already
 *  rounded to 2dp in the view; `deviation_pct` = observed − expected. */
export type BenfordDigitRow = {
  event_id: number | null
  leading_digit: number
  observed_count: number
  /** The event's window total -- the denominator every pct is taken against.
   *  Identical across all nine rows for a given event. */
  total_count: number
  observed_pct: number
  expected_pct: number
  deviation_pct: number
}

/** One row of v_round_number_bias: one (department, vendor) pair for one
 *  event. Either id (and its name) can be null -- an entry with no department
 *  or no vendor assigned. `round_share_pct` is null only when entry_count is
 *  0, which the view never emits, so treat null as 0 defensively. */
export type RoundNumberBiasRow = {
  department_id: number | null
  department_name: string | null
  vendor_id: number | null
  vendor_display_name: string | null
  event_id: number | null
  entry_count: number
  round_count: number
  round_share_pct: number | null
}

/** A department-level or vendor-level roll-up of the round-number test,
 *  built in this loader from the (department, vendor) base rows. */
export type RoundNumberRollup = {
  /** department_id or vendor_id; null bucket keyed as the string 'unassigned'. */
  key: number | 'unassigned'
  label: string
  entryCount: number
  roundCount: number
  roundSharePct: number
}

// ---------------------------------------------------------------------------
// D-07 -- Benford MAD and Nigrini conformity bands.
// ---------------------------------------------------------------------------

/** Mean absolute deviation of the observed leading-digit distribution from
 *  Benford's expected curve, on the 0..1 PROPORTION scale Nigrini's bands are
 *  defined over (the view's pcts are 0..100, hence the /100). Null when there
 *  are no digit rows / a zero window total. */
export function benfordMad(rows: BenfordDigitRow[]): number | null {
  const usable = rows.filter((r) => r.total_count > 0)
  if (usable.length === 0) return null
  const sumAbs = usable.reduce((s, r) => s + Math.abs(r.deviation_pct) / 100, 0)
  // Always divide by 9: a digit that was never observed still has a real
  // (negative) deviation and the view emits its row.
  return sumAbs / 9
}

export type BenfordConformity = {
  verdict: 'Close conformity' | 'Acceptable conformity' | 'Marginal conformity' | 'Nonconformity' | 'Not enough data'
  /** Status role for the reserved colour on the KPI badge (§6 fix #5). */
  tone: 'good' | 'warn' | 'bad' | 'neutral'
}

/**
 * Nigrini's first-digit MAD conformity bands (Mark Nigrini, *Benford's Law*,
 * 2012), on the proportion scale:
 *   MAD < 0.006          -> close conformity
 *   0.006 <= MAD < 0.012 -> acceptable conformity
 *   0.012 <= MAD < 0.015 -> marginally acceptable
 *   MAD >= 0.015         -> nonconformity
 * Rendered as: close/acceptable = green (the distribution looks organic),
 * marginal = amber, nonconformity = red (worth a manual look at the amounts).
 */
export const BENFORD_MAD_BANDS = [
  { max: 0.006, verdict: 'Close conformity', tone: 'good' },
  { max: 0.012, verdict: 'Acceptable conformity', tone: 'good' },
  { max: 0.015, verdict: 'Marginal conformity', tone: 'warn' },
  { max: Infinity, verdict: 'Nonconformity', tone: 'bad' },
] as const

export function benfordConformity(mad: number | null): BenfordConformity {
  if (mad == null) return { verdict: 'Not enough data', tone: 'neutral' }
  const band = BENFORD_MAD_BANDS.find((b) => mad < b.max) ?? BENFORD_MAD_BANDS[BENFORD_MAD_BANDS.length - 1]!
  return { verdict: band.verdict, tone: band.tone }
}

// ---------------------------------------------------------------------------
// D-08 -- round-number rollups.
// ---------------------------------------------------------------------------

/** Minimum entries a department or vendor needs before its round-number
 *  share is ranked in the headline lists. Below this the share is too noisy
 *  to mean anything (a single round entry reads as 100%). The full
 *  (department, vendor) grain is still in the table + CSV regardless. */
export const ROUND_NUMBER_MATERIALITY_MIN_ENTRIES = 5

function rollup(
  rows: RoundNumberBiasRow[],
  keyOf: (r: RoundNumberBiasRow) => number | null,
  labelOf: (r: RoundNumberBiasRow) => string | null
): RoundNumberRollup[] {
  const acc = new Map<number | 'unassigned', RoundNumberRollup>()
  for (const r of rows) {
    const rawKey = keyOf(r)
    const key: number | 'unassigned' = rawKey ?? 'unassigned'
    const existing =
      acc.get(key) ??
      ({ key, label: labelOf(r) ?? 'Unassigned', entryCount: 0, roundCount: 0, roundSharePct: 0 } satisfies RoundNumberRollup)
    existing.entryCount += r.entry_count
    existing.roundCount += r.round_count
    acc.set(key, existing)
  }
  return [...acc.values()]
    .map((g) => ({
      ...g,
      roundSharePct: g.entryCount > 0 ? round2Local((g.roundCount / g.entryCount) * 100) : 0,
    }))
    .sort((a, b) => b.roundSharePct - a.roundSharePct || b.roundCount - a.roundCount)
}

export function buildRoundNumberRollups(rows: RoundNumberBiasRow[]): {
  byDepartment: RoundNumberRollup[]
  byVendor: RoundNumberRollup[]
  overallEntryCount: number
  overallRoundCount: number
  overallSharePct: number
} {
  const byDepartment = rollup(rows, (r) => r.department_id, (r) => r.department_name).filter(
    (g) => g.entryCount >= ROUND_NUMBER_MATERIALITY_MIN_ENTRIES
  )
  const byVendor = rollup(rows, (r) => r.vendor_id, (r) => r.vendor_display_name).filter(
    (g) => g.entryCount >= ROUND_NUMBER_MATERIALITY_MIN_ENTRIES
  )
  const overallEntryCount = rows.reduce((s, r) => s + r.entry_count, 0)
  const overallRoundCount = rows.reduce((s, r) => s + r.round_count, 0)
  const overallSharePct = overallEntryCount > 0 ? round2Local((overallRoundCount / overallEntryCount) * 100) : 0
  return { byDepartment, byVendor, overallEntryCount, overallRoundCount, overallSharePct }
}

// ---------------------------------------------------------------------------
// Surface data + loader.
// ---------------------------------------------------------------------------

export type AmountForensicsSurfaceData = {
  eventName: string | null
  previousEventName: string | null
  benford: {
    rows: BenfordDigitRow[]
    error: string | null
    mad: number | null
    conformity: BenfordConformity
    totalCount: number
    previousMad: number | null
  }
  roundNumber: {
    rows: RoundNumberBiasRow[]
    error: string | null
    byDepartment: RoundNumberRollup[]
    byVendor: RoundNumberRollup[]
    overallEntryCount: number
    overallRoundCount: number
    overallSharePct: number
    previousOverallSharePct: number | null
  }
}

const BENFORD_SELECT =
  'event_id, leading_digit, observed_count, total_count, observed_pct, expected_pct, deviation_pct'
const ROUND_NUMBER_SELECT =
  'department_id, department_name, vendor_id, vendor_display_name, event_id, entry_count, round_count, round_share_pct'

export async function loadAmountForensics(compareBasis: CompareBasis): Promise<AmountForensicsSurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent(supabase)
  const eventId = selectedEvent?.id ?? null

  const [benfordRes, roundRes] = await Promise.all([
    supabase
      .from('v_benford_leading_digit')
      .select(BENFORD_SELECT)
      .eq('event_id', eventId)
      .order('leading_digit', { ascending: true })
      .returns<BenfordDigitRow[]>(),
    supabase
      .from('v_round_number_bias')
      .select(ROUND_NUMBER_SELECT)
      .eq('event_id', eventId)
      .order('round_share_pct', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<RoundNumberBiasRow[]>(),
  ])

  const benfordRows = benfordRes.data ?? []
  const roundRows = roundRes.data ?? []

  const mad = benfordMad(benfordRows)
  const totalCount = benfordRows[0]?.total_count ?? 0
  const rollups = buildRoundNumberRollups(roundRows)

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousMad: number | null = null
  let previousOverallSharePct: number | null = null

  if (previousEvent) {
    const [pBenford, pRound] = await Promise.all([
      supabase
        .from('v_benford_leading_digit')
        .select('leading_digit, total_count, deviation_pct')
        .eq('event_id', previousEvent.id)
        .returns<BenfordDigitRow[]>(),
      supabase
        .from('v_round_number_bias')
        .select('entry_count, round_count')
        .eq('event_id', previousEvent.id)
        .limit(ROW_CAP)
        .returns<{ entry_count: number; round_count: number }[]>(),
    ])
    previousMad = benfordMad((pBenford.data ?? []) as BenfordDigitRow[])
    const pEntries = (pRound.data ?? []).reduce((s, r) => s + r.entry_count, 0)
    const pRoundCount = (pRound.data ?? []).reduce((s, r) => s + r.round_count, 0)
    previousOverallSharePct = pEntries > 0 ? round2Local((pRoundCount / pEntries) * 100) : null
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    benford: {
      rows: benfordRows,
      error: friendlyDataError(benfordRes.error, 'reports:forensics:benford'),
      mad,
      conformity: benfordConformity(mad),
      totalCount,
      previousMad,
    },
    roundNumber: {
      rows: roundRows,
      error: friendlyDataError(roundRes.error, 'reports:forensics:round-number'),
      byDepartment: rollups.byDepartment,
      byVendor: rollups.byVendor,
      overallEntryCount: rollups.overallEntryCount,
      overallRoundCount: rollups.overallRoundCount,
      overallSharePct: rollups.overallSharePct,
      previousOverallSharePct,
    },
  }
}
