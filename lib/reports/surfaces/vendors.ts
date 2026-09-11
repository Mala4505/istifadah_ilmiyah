/**
 * Data loader for the Vendors & Purchases surface (reporting-blueprint.md §5:
 * "Who the money went to, and what it bought."). Carries the former page.tsx
 * sections: vendor spend (spend joined with concentration), spend by item
 * family, and rate benchmark.
 *
 * Split out of the monolithic loadReportsData / loadAnalyticsData so this
 * surface queries only its own views (§8 Phase Three: "Page weight and query
 * time drop."). Every view exposes `event_id` as a plain output column
 * (20260822000007 / 20260822000011), filtered here at the query site against
 * the active event.
 *
 * Prior-period comparison (§6 fix #1): when the compare basis is
 * 'prior_event', the previous event is resolved once and each view re-run
 * against it for a headline delta. 'prior_week' has no effect here -- none of
 * these aggregates carry an as-of dimension a week-old snapshot could be
 * re-derived from (same reasoning the former page.tsx documented).
 *
 * The vendor-spend section merges two views (§5.2): v_vendor_spend (entry-level
 * detail) joined with v_vendor_concentration (corpus-share detail) on
 * vendor_id, keyed off the spend rows since those are already filtered to
 * entry_count > 0. The concentration view's load error is carried through
 * separately so the section can warn that the share / open-flag columns may be
 * incomplete without hiding the spend rows it still has.
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { RATE_BENCHMARK_MIN_OBSERVATIONS, RATE_BENCHMARK_MIN_VENDORS } from '@/lib/analytics/thresholds'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import {
  ROW_CAP,
  resolvePreviousEvent,
  buildConcentrationCurve,
  round2Local,
  ITC_BACKED_INSTRUMENT_TYPES,
  type ConcentrationPoint,
  type InstrumentTypeMixRow,
  type MergedVendorRow,
  type RateBenchmarkRow,
  type RateObservationRow,
  type SpendByFamilyRow,
  type VendorConcentrationRow,
  type VendorSpendRow,
} from '@/lib/reports/sections/shared'

/** B-01 headline: top-8 vendors' cumulative share, for the prior-event delta. */
const CONCENTRATION_HEADLINE_COUNT = 8

function topShareOf(points: ConcentrationPoint[]): number | null {
  if (points.length === 0) return null
  return points[Math.min(CONCENTRATION_HEADLINE_COUNT, points.length) - 1]!.cumulativeSharePct
}

/** C-09 headline: share of spend (%) backed by a tax invoice, for the
 *  prior-event delta. Null when the prior event had no attributed spend. */
function backedPctOf(rows: { instrument_type: string; total_amount: number }[]): number | null {
  const total = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  if (total <= 0) return null
  const backed = rows
    .filter((r) => ITC_BACKED_INSTRUMENT_TYPES.has(r.instrument_type))
    .reduce((s, r) => s + (r.total_amount ?? 0), 0)
  return round2Local((backed / total) * 100)
}

/** "{Vendor} is the largest vendor, accounting for {pct}% of spend across N
 *  vendors." Rows are already ordered by total_amount desc (query order). */
export function vendorSpendInsight(rows: MergedVendorRow[]): string | null {
  if (rows.length === 0) return null
  const top = rows[0]!
  return top.pct_of_total_spend != null
    ? `${top.display_name} is the largest vendor, accounting for ${formatPercent(top.pct_of_total_spend)} of spend across ${formatNumber(rows.length)} vendors.`
    : `${top.display_name} is the largest vendor by spend, across ${formatNumber(rows.length)} vendors.`
}

/** "Across N comparable purchases in M item families, ₹X sits above our own
 *  median rate for the same item and unit — led by {family} at ₹Y." */
export function aboveMedianOverpaymentInsight(rows: RateObservationRow[]): string | null {
  const cmp = rows.filter((r) => r.median_rate != null && r.median_rate > 0)
  if (cmp.length === 0) return null
  const total = rows.reduce((s, r) => s + r.overpayment_amount, 0)
  const familyCount = new Set(cmp.map((r) => r.family_key)).size
  const base = `Across ${formatNumber(cmp.length)} comparable purchase${cmp.length === 1 ? '' : 's'} in ${formatNumber(
    familyCount
  )} item famil${familyCount === 1 ? 'y' : 'ies'}`
  if (total <= 0) return `${base}, none is priced above our own median rate for the same item and unit.`
  const byFamily = new Map<string, { label: string; sum: number }>()
  for (const r of rows) {
    if (r.overpayment_amount <= 0) continue
    const cur = byFamily.get(r.family_key) ?? { label: r.family_label, sum: 0 }
    cur.sum += r.overpayment_amount
    byFamily.set(r.family_key, cur)
  }
  const lead = [...byFamily.values()].sort((a, b) => b.sum - a.sum)[0]!
  return `${base}, ${formatINRCompact(total)} sits above our own median rate for the same item and unit — led by ${lead.label} at ${formatINRCompact(lead.sum)}.`
}

/** "₹X of spend (Y%) is not backed by a tax invoice or bill of supply." */
export function instrumentTypeMixInsight(rows: InstrumentTypeMixRow[]): string | null {
  const total = rows.reduce((s, r) => s + r.total_amount, 0)
  if (total <= 0) return null
  const backed = rows
    .filter((r) => ITC_BACKED_INSTRUMENT_TYPES.has(r.instrument_type))
    .reduce((s, r) => s + r.total_amount, 0)
  const unbacked = total - backed
  if (unbacked <= 0) return "Every rupee of this event's spend is backed by a tax invoice or bill of supply."
  const pct = (unbacked / total) * 100
  return `${formatINRCompact(unbacked)} of spend (${formatPercent(pct)}) is not backed by a tax invoice or bill of supply.`
}

/** "{Family} is the largest item family, at X% of tracked family spend." */
export function spendByFamilyInsight(rows: SpendByFamilyRow[]): string | null {
  const withSpend = rows.filter((r) => r.total_spend > 0)
  const total = rows.reduce((s, r) => s + r.total_spend, 0)
  if (withSpend.length === 0 || total <= 0) return null
  const top = withSpend[0]! // already ordered by total_spend desc (v_spend_by_family query)
  const share = (top.total_spend / total) * 100
  return `${top.label} is the largest item family, at ${formatPercent(share)} of tracked family spend.`
}

/** "N of M item family/unit pairs have a reliable benchmark... {family} has
 *  the widest spread — its highest rate is Xx the median." */
export function rateBenchmarkInsight(rows: RateBenchmarkRow[]): string | null {
  if (rows.length === 0) return null
  const reliableCount = rows.filter(
    (r) => r.vendor_count >= RATE_BENCHMARK_MIN_VENDORS && r.observation_count >= RATE_BENCHMARK_MIN_OBSERVATIONS
  ).length
  const widest = [...rows]
    .filter((r) => r.median_rate != null && r.median_rate > 0 && r.max_rate != null)
    .sort((a, b) => b.max_rate! / b.median_rate! - a.max_rate! / a.median_rate!)[0]
  const base = `${formatNumber(reliableCount)} of ${formatNumber(rows.length)} item family/unit pairs have a reliable benchmark (≥${RATE_BENCHMARK_MIN_VENDORS} vendors, ≥${RATE_BENCHMARK_MIN_OBSERVATIONS} observations).`
  if (!widest) return base
  return `${base} ${widest.family_label} has the widest spread — its highest rate is ${(widest.max_rate! / widest.median_rate!).toFixed(1)}x the median.`
}

export type VendorsSurfaceData = {
  eventName: string | null
  previousEventName: string | null
  vendorSpend: {
    rows: MergedVendorRow[]
    error: string | null
    concentrationError: string | null
    previousSpendTotal: number | null
    insight: string | null
  }
  spendByFamily: { rows: SpendByFamilyRow[]; error: string | null; previousSpendTotal: number | null; insight: string | null }
  rateBenchmark: { rows: RateBenchmarkRow[]; error: string | null; previousReliableCount: number | null; insight: string | null }
  /** C-04 above-median overpayment — one row per comparable rate observation. */
  overpayment: { rows: RateObservationRow[]; error: string | null; previousTotal: number | null; insight: string | null }
  /** C-09 instrument-type mix — per (department, instrument_type) entry count + ₹. */
  instrumentMix: { rows: InstrumentTypeMixRow[]; error: string | null; previousBackedPct: number | null; insight: string | null }
  /** B-01 concentration curve — cumulated app-side from v_vendor_concentration
   *  (same view the vendor-spend merge already loads), so its load error is the
   *  concentration query's error. */
  concentrationCurve: { points: ConcentrationPoint[]; error: string | null; previousTopShare: number | null }
}

const SPEND_SELECT =
  'vendor_id, display_name, entry_count, total_amount, first_entry_date, last_entry_date, entries_with_documents, document_coverage_pct'
const CONCENTRATION_SELECT =
  'vendor_id, display_name, is_confirmed, entry_count, total_amount, open_flag_count, open_flag_amount_at_risk, pct_of_total_spend'
const FAMILY_SELECT =
  'item_family_id, family_key, label, default_unit, is_confirmed, total_spend, observation_count, vendor_count'
const BENCHMARK_SELECT =
  'item_family_id, family_key, family_label, unit_normalized, median_rate, observation_count, vendor_count, min_rate, max_rate'
const RATE_OBS_SELECT =
  'rate_reference_id, item_family_id, family_key, family_label, unit_normalized, vendor_id, vendor_display_name, net_rate, quantity, observed_date, entry_id, department_id, department_name, median_rate, observation_count, vendor_count, overpayment_amount'
const INSTRUMENT_MIX_SELECT = 'department_id, department_name, instrument_type, entry_count, total_amount'

/**
 * Perf remediation Phase 2.2 (docs/performance-remediation-plan.md):
 * `selectedEvent` is resolved once by the caller (the page already
 * called getSelectedEvent()) and passed in, rather than this loader
 * re-resolving it itself -- same reasoning as loadHeroMetrics/
 * loadExecutiveBrief taking `eventId` as a parameter.
 */
export async function loadVendorsSurface(compareBasis: CompareBasis, selectedEvent: Event | null): Promise<VendorsSurfaceData> {
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null

  const [spendRes, concentrationRes, familyRes, benchmarkRes, overpaymentRes, instrumentMixRes] = await Promise.all([
    supabase
      .from('v_vendor_spend')
      .select(SPEND_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorSpendRow[]>(),
    supabase
      .from('v_vendor_concentration')
      .select(CONCENTRATION_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorConcentrationRow[]>(),
    supabase
      .from('v_spend_by_family')
      .select(FAMILY_SELECT)
      .eq('event_id', eventId)
      .order('total_spend', { ascending: false })
      .returns<SpendByFamilyRow[]>(),
    supabase
      .from('v_rate_benchmark')
      .select(BENCHMARK_SELECT)
      .eq('event_id', eventId)
      .order('observation_count', { ascending: false })
      .returns<RateBenchmarkRow[]>(),
    supabase
      .from('v_rate_observation')
      .select(RATE_OBS_SELECT)
      .eq('event_id', eventId)
      .order('overpayment_amount', { ascending: false })
      .limit(ROW_CAP)
      .returns<RateObservationRow[]>(),
    supabase
      .from('v_instrument_type_mix')
      .select(INSTRUMENT_MIX_SELECT)
      .eq('event_id', eventId)
      .returns<InstrumentTypeMixRow[]>(),
  ])

  // §5.2 merge: keyed off the spend rows (already the entry_count > 0 side),
  // pulling the corpus-share columns from concentration where the vendor is
  // present there too; missing on the concentration side falls back to null/0.
  const spendRows = (spendRes.data ?? []).filter((r) => r.entry_count > 0)
  const concentrationRows = (concentrationRes.data ?? []).filter((r) => (r.entry_count ?? 0) > 0)
  const concentrationByVendorId = new Map(concentrationRows.map((r) => [r.vendor_id, r]))
  const mergedVendorRows: MergedVendorRow[] = spendRows.map((r) => {
    const c = concentrationByVendorId.get(r.vendor_id)
    return {
      ...r,
      pct_of_total_spend: c?.pct_of_total_spend ?? null,
      open_flag_count: c?.open_flag_count ?? 0,
      open_flag_amount_at_risk: c?.open_flag_amount_at_risk ?? null,
    }
  })

  const concentrationCurve = buildConcentrationCurve(concentrationRows)

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let prior: {
    vendorSpendTotal: number | null
    familySpendTotal: number | null
    benchmarkReliableCount: number | null
    concentrationTopShare: number | null
    overpaymentTotal: number | null
    instrumentBackedPct: number | null
  } = {
    vendorSpendTotal: null,
    familySpendTotal: null,
    benchmarkReliableCount: null,
    concentrationTopShare: null,
    overpaymentTotal: null,
    instrumentBackedPct: null,
  }

  if (previousEvent) {
    const [pVendor, pFamily, pBenchmark, pConcentration, pOverpayment, pInstrumentMix] = await Promise.all([
      supabase
        .from('v_vendor_spend')
        .select('total_amount, entry_count')
        .eq('event_id', previousEvent.id)
        .returns<{ total_amount: number | null; entry_count: number }[]>(),
      supabase
        .from('v_spend_by_family')
        .select('total_spend')
        .eq('event_id', previousEvent.id)
        .returns<{ total_spend: number }[]>(),
      supabase
        .from('v_rate_benchmark')
        .select('vendor_count, observation_count')
        .eq('event_id', previousEvent.id)
        .returns<{ vendor_count: number; observation_count: number }[]>(),
      supabase
        .from('v_vendor_concentration')
        .select(CONCENTRATION_SELECT)
        .eq('event_id', previousEvent.id)
        .returns<VendorConcentrationRow[]>(),
      supabase
        .from('v_rate_observation')
        .select('overpayment_amount')
        .eq('event_id', previousEvent.id)
        .returns<{ overpayment_amount: number }[]>(),
      supabase
        .from('v_instrument_type_mix')
        .select('instrument_type, total_amount')
        .eq('event_id', previousEvent.id)
        .returns<{ instrument_type: string; total_amount: number }[]>(),
    ])
    prior = {
      vendorSpendTotal: (pVendor.data ?? [])
        .filter((r) => (r.entry_count ?? 0) > 0)
        .reduce((s, r) => s + (r.total_amount ?? 0), 0),
      familySpendTotal: (pFamily.data ?? []).reduce((s, r) => s + (r.total_spend ?? 0), 0),
      benchmarkReliableCount: (pBenchmark.data ?? []).filter(
        (r) => r.vendor_count >= RATE_BENCHMARK_MIN_VENDORS && r.observation_count >= RATE_BENCHMARK_MIN_OBSERVATIONS
      ).length,
      concentrationTopShare: topShareOf(
        buildConcentrationCurve((pConcentration.data ?? []).filter((r) => (r.entry_count ?? 0) > 0))
      ),
      overpaymentTotal: (pOverpayment.data ?? []).reduce((s, r) => s + (r.overpayment_amount ?? 0), 0),
      instrumentBackedPct: backedPctOf(pInstrumentMix.data ?? []),
    }
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    vendorSpend: {
      rows: mergedVendorRows,
      error: friendlyDataError(spendRes.error, 'reports:vendors:spend'),
      concentrationError: friendlyDataError(concentrationRes.error, 'reports:vendors:concentration'),
      previousSpendTotal: prior.vendorSpendTotal,
      insight: vendorSpendInsight(mergedVendorRows),
    },
    spendByFamily: {
      rows: familyRes.data ?? [],
      error: friendlyDataError(familyRes.error, 'reports:vendors:family'),
      previousSpendTotal: prior.familySpendTotal,
      insight: spendByFamilyInsight(familyRes.data ?? []),
    },
    rateBenchmark: {
      rows: benchmarkRes.data ?? [],
      error: friendlyDataError(benchmarkRes.error, 'reports:vendors:benchmark'),
      previousReliableCount: prior.benchmarkReliableCount,
      insight: rateBenchmarkInsight(benchmarkRes.data ?? []),
    },
    concentrationCurve: {
      points: concentrationCurve,
      error: friendlyDataError(concentrationRes.error, 'reports:vendors:concentration'),
      previousTopShare: prior.concentrationTopShare,
    },
    overpayment: {
      rows: overpaymentRes.data ?? [],
      error: friendlyDataError(overpaymentRes.error, 'reports:vendors:overpayment'),
      previousTotal: prior.overpaymentTotal,
      insight: aboveMedianOverpaymentInsight(overpaymentRes.data ?? []),
    },
    instrumentMix: {
      rows: instrumentMixRes.data ?? [],
      error: friendlyDataError(instrumentMixRes.error, 'reports:vendors:instrument-mix'),
      previousBackedPct: prior.instrumentBackedPct,
      insight: instrumentTypeMixInsight(instrumentMixRes.data ?? []),
    },
  }
}
