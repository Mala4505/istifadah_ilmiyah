/**
 * Data loader for three Phase Five reports (reporting-blueprint.md §8 Phase
 * Five, Family C / B) added to the Vendors & Purchases surface and Explore:
 *
 *   C-07 Quantity purchased by unit    -- v_quantity_by_unit
 *   C-08 Unit economics by zone        -- v_zone_unit_economics
 *   B-06 Price ranking per item family -- v_vendor_price_by_family
 *
 * Mirrors lib/reports/surfaces/vendors.ts's shape exactly: every view exposes
 * `event_id` as a plain output column (not selected into the row types below,
 * same as VendorSpendRow/RateBenchmarkRow -- it exists purely for the
 * `.eq('event_id', ...)` filter at the query site), and the prior-period
 * comparison (§6 fix #1) resolves the previous event once and re-runs a
 * lightweight version of each query against it for one headline delta number
 * per section. 'prior_week' has no effect here, same reasoning vendors.ts
 * documents -- none of these three aggregates carry an as-of dimension a
 * week-old snapshot could be re-derived from.
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { RATE_BENCHMARK_MIN_VENDORS } from '@/lib/analytics/thresholds'
import {
  resolvePreviousEvent,
  type QuantityByUnitRow,
  type ZoneUnitEconomicsRow,
  type VendorPriceByFamilyRow,
} from '@/lib/reports/sections/shared'

// QuantityByUnitRow / ZoneUnitEconomicsRow / VendorPriceByFamilyRow now live
// in lib/reports/sections/shared.tsx (hoisted during Phase Five integration);
// re-exported here so existing imports from this loader file keep working.
export type { QuantityByUnitRow, ZoneUnitEconomicsRow, VendorPriceByFamilyRow }

const QUANTITY_SELECT =
  'item_family_id, family_key, family_label, unit_normalized, total_quantity, observation_count, vendor_count, entry_count'
const ZONE_ECONOMICS_SELECT =
  'item_family_id, family_key, family_label, unit_normalized, zone_id, zone_name, zone_number, median_rate, avg_rate, observation_count, family_median_rate, zone_count'
const VENDOR_PRICE_SELECT =
  'item_family_id, family_key, family_label, unit_normalized, vendor_id, vendor_display_name, median_rate, observation_count, min_rate, max_rate, family_median_rate, vendor_count'

/**
 * C-08 headline threshold: how wide a family's cross-zone median-rate spread
 * has to be, as a percentage of its own family_median_rate, before it counts
 * toward "families with a notable cross-zone spread". Not one of the
 * statutory/discretionary thresholds in lib/analytics/thresholds.ts (this
 * loader can't add one there -- see INTEGRATION NOTES); 15% sits below
 * RATE_ABOVE_BENCHMARK_PCT (25%, the above-benchmark *flagging* threshold in
 * that file) because a cross-zone spread is a softer signal than a single
 * purchase priced over benchmark -- it's surfaced here for a look, not scored
 * as a finding.
 */
const ZONE_SPREAD_HEADLINE_PCT = 15

function familyUnitKey(itemFamilyId: number, unit: string | null): string {
  return `${itemFamilyId}::${unit ?? ''}`
}

/** Count of distinct (item_family, unit) pairs whose cross-zone median-rate
 *  spread exceeds ZONE_SPREAD_HEADLINE_PCT of the family median. */
function countWideSpreadFamilies(
  rows: { item_family_id: number; unit_normalized: string | null; median_rate: number | null; family_median_rate: number | null }[]
): number {
  const byGroup = new Map<string, { min: number; max: number; familyMedian: number | null }>()
  for (const r of rows) {
    if (r.median_rate == null) continue
    const key = familyUnitKey(r.item_family_id, r.unit_normalized)
    const g = byGroup.get(key)
    if (!g) {
      byGroup.set(key, { min: r.median_rate, max: r.median_rate, familyMedian: r.family_median_rate })
    } else {
      g.min = Math.min(g.min, r.median_rate)
      g.max = Math.max(g.max, r.median_rate)
    }
  }
  let count = 0
  for (const g of byGroup.values()) {
    if (g.familyMedian == null || g.familyMedian <= 0) continue
    const spreadPct = ((g.max - g.min) / g.familyMedian) * 100
    if (spreadPct > ZONE_SPREAD_HEADLINE_PCT) count += 1
  }
  return count
}

/** Count of distinct (item_family, unit) pairs with >= RATE_BENCHMARK_MIN_VENDORS
 *  vendors priced -- the same "reliable enough to rank" bar rate-benchmark.tsx
 *  already uses for its own headline. */
function countMultiVendorFamilies(rows: { item_family_id: number; unit_normalized: string | null; vendor_count: number }[]): number {
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.vendor_count >= RATE_BENCHMARK_MIN_VENDORS) seen.add(familyUnitKey(r.item_family_id, r.unit_normalized))
  }
  return seen.size
}

export type QuantityZonePriceData = {
  eventName: string | null
  previousEventName: string | null
  /** C-07 */
  quantityByUnit: { rows: QuantityByUnitRow[]; error: string | null; previousPairCount: number | null }
  /** C-08 */
  zoneUnitEconomics: { rows: ZoneUnitEconomicsRow[]; error: string | null; previousWideSpreadCount: number | null }
  /** B-06 */
  vendorPriceByFamily: { rows: VendorPriceByFamilyRow[]; error: string | null; previousMultiVendorCount: number | null }
}

/**
 * Perf remediation Phase 2.2 (docs/performance-remediation-plan.md):
 * `selectedEvent` is resolved once by the caller (the page already
 * called getSelectedEvent()) and passed in, rather than this loader
 * re-resolving it itself -- same reasoning as loadHeroMetrics/
 * loadExecutiveBrief taking `eventId` as a parameter.
 */
export async function loadQuantityZonePrice(compareBasis: CompareBasis, selectedEvent: Event | null): Promise<QuantityZonePriceData> {
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null

  const [quantityRes, zoneEconomicsRes, vendorPriceRes] = await Promise.all([
    supabase
      .from('v_quantity_by_unit')
      .select(QUANTITY_SELECT)
      .eq('event_id', eventId)
      .order('total_quantity', { ascending: false })
      .returns<QuantityByUnitRow[]>(),
    supabase
      .from('v_zone_unit_economics')
      .select(ZONE_ECONOMICS_SELECT)
      .eq('event_id', eventId)
      .order('median_rate', { ascending: false, nullsFirst: false })
      .returns<ZoneUnitEconomicsRow[]>(),
    supabase
      .from('v_vendor_price_by_family')
      .select(VENDOR_PRICE_SELECT)
      .eq('event_id', eventId)
      .order('median_rate', { ascending: false, nullsFirst: false })
      .returns<VendorPriceByFamilyRow[]>(),
  ])

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let prior: { pairCount: number | null; wideSpreadCount: number | null; multiVendorCount: number | null } = {
    pairCount: null,
    wideSpreadCount: null,
    multiVendorCount: null,
  }

  if (previousEvent) {
    const [pQuantity, pZoneEconomics, pVendorPrice] = await Promise.all([
      supabase.from('v_quantity_by_unit').select('item_family_id').eq('event_id', previousEvent.id).returns<{ item_family_id: number }[]>(),
      supabase
        .from('v_zone_unit_economics')
        .select('item_family_id, unit_normalized, median_rate, family_median_rate')
        .eq('event_id', previousEvent.id)
        .returns<{ item_family_id: number; unit_normalized: string | null; median_rate: number | null; family_median_rate: number | null }[]>(),
      supabase
        .from('v_vendor_price_by_family')
        .select('item_family_id, unit_normalized, vendor_count')
        .eq('event_id', previousEvent.id)
        .returns<{ item_family_id: number; unit_normalized: string | null; vendor_count: number }[]>(),
    ])
    prior = {
      pairCount: (pQuantity.data ?? []).length,
      wideSpreadCount: countWideSpreadFamilies(pZoneEconomics.data ?? []),
      multiVendorCount: countMultiVendorFamilies(pVendorPrice.data ?? []),
    }
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    quantityByUnit: {
      rows: quantityRes.data ?? [],
      error: friendlyDataError(quantityRes.error, 'reports:quantity-zone-price:quantity'),
      previousPairCount: prior.pairCount,
    },
    zoneUnitEconomics: {
      rows: zoneEconomicsRes.data ?? [],
      error: friendlyDataError(zoneEconomicsRes.error, 'reports:quantity-zone-price:zone-economics'),
      previousWideSpreadCount: prior.wideSpreadCount,
    },
    vendorPriceByFamily: {
      rows: vendorPriceRes.data ?? [],
      error: friendlyDataError(vendorPriceRes.error, 'reports:quantity-zone-price:vendor-price'),
      previousMultiVendorCount: prior.multiVendorCount,
    },
  }
}

// Exported for the section components' headline computations (kept here so
// the "what counts as a notable spread / a reliably ranked family" logic has
// one implementation shared between the current-event and prior-event runs).
export { countWideSpreadFamilies, countMultiVendorFamilies, ZONE_SPREAD_HEADLINE_PCT }
