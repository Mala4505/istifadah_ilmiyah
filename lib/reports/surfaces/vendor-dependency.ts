/**
 * Data loader for reporting-blueprint.md §3 Family B, Phase Five: B-03
 * Department dependency, B-04 Vendor exclusivity, B-05 New vendor / first
 * bill. Belongs on the Vendors & Purchases surface (§5) and on Explore.
 *
 * Each section reads its own view (20260903000007_vendor_dependency_views.sql)
 * filtered to the active event at the query site -- the views expose
 * event_id as a plain output column, matching every other reporting view in
 * this codebase (20260822000011's convention).
 *
 * Prior-period comparison (§6 fix #1): when the compare basis is
 * 'prior_event', the previous event is resolved once and each view re-run
 * against it for a single headline delta number. 'prior_week' has no effect
 * here -- none of these three views carry an as-of dimension a week-old
 * snapshot could be re-derived from (same reasoning lib/reports/surfaces/
 * vendors.ts documents for its own aggregates).
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  ROW_CAP,
  resolvePreviousEvent,
  type DepartmentVendorDependencyRow,
  type VendorExclusivityRow,
  type VendorFirstBillRow,
} from '@/lib/reports/sections/shared'

// DepartmentVendorDependencyRow / VendorExclusivityRow / VendorFirstBillRow
// now live in lib/reports/sections/shared.tsx (hoisted during Phase Five
// integration); re-exported here so existing imports from this loader file
// keep working.
export type { DepartmentVendorDependencyRow, VendorExclusivityRow, VendorFirstBillRow }

/** B-03 finding threshold — a department is single-source-dependent once its
 *  top vendor clears more than half its spend. */
export const DEPARTMENT_DEPENDENCY_THRESHOLD_PCT = 50

/** B-04 materiality cut for the headline (not the table/chart population,
 *  which shows every single-department vendor): the top decile of spend
 *  among ALL vendors active in the event, single-department or not. A
 *  single-department vendor whose spend clears this bar is "especially at
 *  high value" per the blueprint's B-04 framing. */
const MATERIALITY_PERCENTILE = 0.9

/** Nearest-rank percentile over a small in-memory array — these view results
 *  are one row per vendor for one event, never large enough to need a DB-side
 *  percentile_cont. Returns null when there's nothing to rank. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]!
}

/** B-03 headline: how many departments are past the single-vendor threshold. */
export function countOverThreshold(rows: { top_vendor_share_pct: number | null }[]): number {
  return rows.filter((r) => (r.top_vendor_share_pct ?? 0) > DEPARTMENT_DEPENDENCY_THRESHOLD_PCT).length
}

/** B-04 headline: single-department vendors whose spend clears the top-decile
 *  materiality bar computed across every vendor active in the event. */
export function countMaterialSingleDepartmentVendors(rows: VendorExclusivityRow[]): number {
  const threshold = percentile(
    rows.map((r) => r.total_spend),
    MATERIALITY_PERCENTILE
  )
  if (threshold == null) return 0
  return rows.filter((r) => r.distinct_department_count === 1 && r.total_spend >= threshold).length
}

/** B-05 headline: vendors first seen mid-event whose opening bill is also
 *  their largest to date. */
export function countNewVendorFirstBillFindings(rows: { is_new_mid_event: boolean; opening_bill_is_largest: boolean }[]): number {
  return rows.filter((r) => r.is_new_mid_event && r.opening_bill_is_largest).length
}

export type VendorDependencyData = {
  eventName: string | null
  previousEventName: string | null
  departmentDependency: {
    rows: DepartmentVendorDependencyRow[]
    error: string | null
    previousOverThresholdCount: number | null
  }
  vendorExclusivity: {
    rows: VendorExclusivityRow[]
    error: string | null
    previousMaterialCount: number | null
  }
  newVendorFirstBill: {
    rows: VendorFirstBillRow[]
    error: string | null
    previousFindingCount: number | null
  }
}

const DEPARTMENT_DEPENDENCY_SELECT =
  'department_id, department_name, event_id, top_vendor_id, top_vendor_display_name, top_vendor_spend, department_total_spend, vendor_count, top_vendor_share_pct'
const VENDOR_EXCLUSIVITY_SELECT =
  'vendor_id, vendor_display_name, event_id, distinct_department_count, department_id, department_name, total_spend, entry_count'
const VENDOR_FIRST_BILL_SELECT =
  'vendor_id, vendor_display_name, event_id, first_entry_date, first_entry_amount, max_entry_amount, total_spend, entry_count, event_first_entry_date, is_new_mid_event, opening_bill_is_largest'

/**
 * Perf remediation Phase 2.2 (docs/performance-remediation-plan.md):
 * `selectedEvent` is resolved once by the caller (the page already
 * called getSelectedEvent()) and passed in, rather than this loader
 * re-resolving it itself -- same reasoning as loadHeroMetrics/
 * loadExecutiveBrief taking `eventId` as a parameter.
 */
export async function loadVendorDependency(compareBasis: CompareBasis, selectedEvent: Event | null): Promise<VendorDependencyData> {
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null

  const [departmentDependencyRes, vendorExclusivityRes, vendorFirstBillRes] = await Promise.all([
    supabase
      .from('v_department_vendor_dependency')
      .select(DEPARTMENT_DEPENDENCY_SELECT)
      .eq('event_id', eventId)
      .order('top_vendor_share_pct', { ascending: false, nullsFirst: false })
      .returns<DepartmentVendorDependencyRow[]>(),
    supabase
      .from('v_vendor_exclusivity')
      .select(VENDOR_EXCLUSIVITY_SELECT)
      .eq('event_id', eventId)
      .order('total_spend', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorExclusivityRow[]>(),
    supabase
      .from('v_vendor_first_bill')
      .select(VENDOR_FIRST_BILL_SELECT)
      .eq('event_id', eventId)
      .order('first_entry_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorFirstBillRow[]>(),
  ])

  const departmentDependencyRows = departmentDependencyRes.data ?? []
  const vendorExclusivityRows = vendorExclusivityRes.data ?? []
  const vendorFirstBillRows = vendorFirstBillRes.data ?? []

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let prior: {
    overThresholdCount: number | null
    materialCount: number | null
    findingCount: number | null
  } = { overThresholdCount: null, materialCount: null, findingCount: null }

  if (previousEvent) {
    const [pDeptDependency, pVendorExclusivity, pVendorFirstBill] = await Promise.all([
      supabase
        .from('v_department_vendor_dependency')
        .select('top_vendor_share_pct')
        .eq('event_id', previousEvent.id)
        .returns<{ top_vendor_share_pct: number | null }[]>(),
      supabase
        .from('v_vendor_exclusivity')
        .select('distinct_department_count, total_spend')
        .eq('event_id', previousEvent.id)
        .returns<{ distinct_department_count: number; total_spend: number }[]>(),
      supabase
        .from('v_vendor_first_bill')
        .select('is_new_mid_event, opening_bill_is_largest')
        .eq('event_id', previousEvent.id)
        .returns<{ is_new_mid_event: boolean; opening_bill_is_largest: boolean }[]>(),
    ])
    prior = {
      overThresholdCount: countOverThreshold(pDeptDependency.data ?? []),
      materialCount: countMaterialSingleDepartmentVendors(
        (pVendorExclusivity.data ?? []).map((r) => ({
          vendor_id: 0,
          vendor_display_name: '',
          event_id: previousEvent.id,
          distinct_department_count: r.distinct_department_count,
          department_id: null,
          department_name: null,
          total_spend: r.total_spend,
          entry_count: 0,
        }))
      ),
      findingCount: countNewVendorFirstBillFindings(pVendorFirstBill.data ?? []),
    }
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    departmentDependency: {
      rows: departmentDependencyRows,
      error: friendlyDataError(departmentDependencyRes.error, 'reports:vendors:department-dependency'),
      previousOverThresholdCount: prior.overThresholdCount,
    },
    vendorExclusivity: {
      rows: vendorExclusivityRows,
      error: friendlyDataError(vendorExclusivityRes.error, 'reports:vendors:vendor-exclusivity'),
      previousMaterialCount: prior.materialCount,
    },
    newVendorFirstBill: {
      rows: vendorFirstBillRows,
      error: friendlyDataError(vendorFirstBillRes.error, 'reports:vendors:new-vendor-first-bill'),
      previousFindingCount: prior.findingCount,
    },
  }
}
