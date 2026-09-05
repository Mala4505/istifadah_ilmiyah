/**
 * Data loader for reporting-blueprint.md §4 C-10 -- HSN coverage & GST anomaly.
 * Reads v_hsn_gst_anomaly (20260903000020), one row per bill
 * (document_extraction) that has line items.
 *
 * Two halves, deliberately independent (see the view header):
 *   - COVERAGE: what share of billed spend carries an HSN/SAC code. Works with
 *     zero rows in hsn_gst_rate.
 *   - ANOMALY: how many bills charge a GST rate that departs from the rate the
 *     matched codes imply. Inert (implied_gst_rate null everywhere, no
 *     anomalies) until an admin populates hsn_gst_rate -- the loader reports
 *     `hsnRateTableEmpty` so the section can say why the anomaly half is dark.
 *
 * event_id is filtered here at the query site (.eq), matching every other
 * surface loader. Bills whose entry sits outside a department-scoped
 * reviewer's scope come back with a null event_id (the view's LEFT JOIN to
 * entries) and drop out of a plain .eq -- acceptable: a reviewer only sees
 * their own departments' coverage, same as every other entries-derived report.
 *
 * Prior-period comparison (§6 fix #1): 'prior_event' re-runs the view against
 * the previous event for one headline delta (coverage %). 'prior_week' has no
 * effect -- the view carries no as-of dimension.
 *
 * Row types live here for now; the parent hoists them into
 * lib/reports/sections/shared.tsx during integration.
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { ROW_CAP, resolvePreviousEvent, round2Local } from '@/lib/reports/sections/shared'

/** One row of v_hsn_gst_anomaly -- one bill. `entry_id` / vendor / department
 *  / `event_id` are null for a bill whose entry is outside the caller's RLS
 *  scope. `implied_gst_rate` is null when no line code matched hsn_gst_rate
 *  (always, while that table is empty). `charged_gst_rate` is null when the
 *  bill has no taxable value or no tax figure. `is_anomaly` is only ever true
 *  when both rates are known. */
export type HsnGstAnomalyRow = {
  bill_id: number
  entry_id: number | null
  vendor_id: number | null
  vendor_display_name: string | null
  department_id: number | null
  department_name: string | null
  line_count: number
  lines_with_hsn: number
  lines_matched: number
  hsn_coverage_pct: number | null
  taxable_value: number | null
  tax_amount: number | null
  billed_amount: number | null
  implied_gst_rate: number | null
  charged_gst_rate: number | null
  rate_gap_pp: number | null
  is_anomaly: boolean
  event_id: number | null
}

const SELECT =
  'bill_id, entry_id, vendor_id, vendor_display_name, department_id, department_name, line_count, lines_with_hsn, lines_matched, hsn_coverage_pct, taxable_value, tax_amount, billed_amount, implied_gst_rate, charged_gst_rate, rate_gap_pp, is_anomaly, event_id'

/** Billed-spend-weighted HSN/SAC coverage: each bill contributes its own
 *  line-level coverage fraction, weighted by its rupee value. Null when there
 *  is no billed spend at all. */
export function hsnCoveragePct(rows: HsnGstAnomalyRow[]): number | null {
  let weighted = 0
  let total = 0
  for (const r of rows) {
    const amount = r.billed_amount ?? 0
    if (amount <= 0) continue
    total += amount
    weighted += amount * ((r.hsn_coverage_pct ?? 0) / 100)
  }
  if (total <= 0) return null
  return round2Local((weighted / total) * 100)
}

export type HsnGstAnomalySurfaceData = {
  eventName: string | null
  previousEventName: string | null
  rows: HsnGstAnomalyRow[]
  error: string | null
  /** True when hsn_gst_rate has no rows -- the anomaly half is inert. */
  hsnRateTableEmpty: boolean
  hsnRateTableError: string | null
  coveragePct: number | null
  previousCoveragePct: number | null
  anomalyCount: number
  billsWithBothRates: number
  billedSpendTotal: number
}

export async function loadHsnGstAnomaly(compareBasis: CompareBasis): Promise<HsnGstAnomalySurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  const eventId = selectedEvent?.id ?? null

  const [rowsRes, rateCountRes] = await Promise.all([
    supabase
      .from('v_hsn_gst_anomaly')
      .select(SELECT)
      .eq('event_id', eventId)
      .order('billed_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<HsnGstAnomalyRow[]>(),
    supabase.from('hsn_gst_rate').select('code', { count: 'exact', head: true }),
  ])

  const rows = rowsRes.data ?? []
  const coveragePct = hsnCoveragePct(rows)
  const anomalyCount = rows.filter((r) => r.is_anomaly).length
  const billsWithBothRates = rows.filter(
    (r) => r.implied_gst_rate != null && r.charged_gst_rate != null
  ).length
  const billedSpendTotal = round2Local(rows.reduce((s, r) => s + (r.billed_amount ?? 0), 0))

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousCoveragePct: number | null = null
  if (previousEvent) {
    const pRes = await supabase
      .from('v_hsn_gst_anomaly')
      .select('billed_amount, hsn_coverage_pct')
      .eq('event_id', previousEvent.id)
      .limit(ROW_CAP)
      .returns<Pick<HsnGstAnomalyRow, 'billed_amount' | 'hsn_coverage_pct'>[]>()
    previousCoveragePct = hsnCoveragePct((pRes.data ?? []) as HsnGstAnomalyRow[])
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    rows,
    error: friendlyDataError(rowsRes.error, 'reports:hsn-gst-anomaly'),
    hsnRateTableEmpty: (rateCountRes.count ?? 0) === 0,
    hsnRateTableError: friendlyDataError(rateCountRes.error, 'reports:hsn-gst-anomaly:rate-table'),
    coveragePct,
    previousCoveragePct,
    anomalyCount,
    billsWithBothRates,
    billedSpendTotal,
  }
}
