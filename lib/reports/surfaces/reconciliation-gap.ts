/**
 * Data loader for reporting-blueprint.md §8 Phase Six (Forensics) cluster
 * D-05 + D-06, over 20260903000009_reconciliation_gap_views.sql.
 *
 *   D-05  Ledger vs bill reconciliation -- the distribution of the gap
 *         between the ledger figure (entries.amount) and the person-verified
 *         bill total. Most gaps are zero; the tail is the report.
 *   D-06  Entries with no supporting bill -- a rupee figure for the
 *         undocumented pile, broken out by department and by vendor.
 *
 * One surface file for both because they share a spine (the entry ->
 * document-extraction join and its dedup) and a page ("Forensics"), matching
 * §8 Phase Three's "one loader per surface" split. Each view exposes
 * `event_id` as a plain output column; filtering happens here at the query
 * site. Row types live here for now -- the parent hoists them into
 * lib/reports/sections/shared.tsx during integration, as it did for every
 * Phase 4/5 row type.
 *
 * Prior-period comparison (§6 fix #1): 'prior_event' re-runs the two
 * headline figures (D-05 material-gap count + ₹, D-06 undocumented ₹) against
 * the previous event. 'prior_week' has no effect -- neither view carries an
 * as-of dimension a week-old snapshot could be re-derived from (same
 * reasoning lib/reports/surfaces/vendor-scorecard.ts documents).
 *
 * ROW_CAP note: v_ledger_bill_reconciliation and v_entries_without_bill are
 * entry-grain and capped at ROW_CAP like every other surface. The D-05 "top
 * 20 by rupee value" is ordered in SQL, so the cap never hides a bigger gap
 * than one shown. The D-06 headline ₹ is taken from
 * v_entries_without_bill_rollup (one row per department / vendor, not per
 * entry) precisely so a capped detail fetch cannot under-report the pile.
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { MEDIUM_SEVERITY_AMOUNT } from '@/lib/analytics/thresholds'
import { ROW_CAP, resolvePreviousEvent, round2Local } from '@/lib/reports/sections/shared'

// ---------------------------------------------------------------------------
// Row shapes -- field names match each view's `select` list verbatim so the
// `.select(...)` strings below port straight into shared.tsx on integration.
// ---------------------------------------------------------------------------

/** D-05 -- one row per non-void entry that has a person-verified bill total.
 *  `gap_amount` is signed (entry_amount - bill_total); `abs_gap_amount` its
 *  magnitude; `gap_pct` the magnitude as a percent of entry_amount (null when
 *  entry_amount is null or zero). entry_amount itself is nullable. */
export type LedgerBillReconciliationRow = {
  entry_id: number
  department_id: number | null
  department_name: string | null
  vendor_id: number | null
  vendor_display_name: string | null
  invoice_number: string | null
  entry_amount: number | null
  bill_total: number
  gap_amount: number | null
  abs_gap_amount: number | null
  gap_pct: number | null
  entry_date: string | null
  event_id: number | null
}

/** D-06 -- one row per non-void entry with no usable (verified-total) bill.
 *  `has_document` false = nothing uploaded; true = uploaded but unverified. */
export type EntryWithoutBillRow = {
  entry_id: number
  department_id: number | null
  department_name: string | null
  vendor_id: number | null
  vendor_display_name: string | null
  entry_amount: number | null
  entry_date: string | null
  has_document: boolean
  event_id: number | null
}

/** D-06 -- v_entries_without_bill pre-aggregated to one row per (dimension,
 *  entity, event). `dimension` is 'department' or 'vendor'. */
export type UndocumentedRollupRow = {
  dimension: 'department' | 'vendor'
  dimension_id: number | null
  dimension_name: string | null
  entry_count: number
  no_document_count: number
  undocumented_amount: number
  event_id: number | null
}

// ---------------------------------------------------------------------------
// D-05 materiality bar.
// ---------------------------------------------------------------------------

/**
 * A reconciliation gap is "non-trivial" when it clears the medium-severity
 * rupee bar OR is at least MATERIAL_GAP_PCT of the entry amount.
 *
 * The rupee bar is MEDIUM_SEVERITY_AMOUNT (₹10,000) from
 * lib/analytics/thresholds.ts -- the same figure the analytics engine uses to
 * escalate a finding, reused here rather than inventing a second undocumented
 * number for the same "is this worth a reviewer's time" judgment.
 *
 * OR, not AND, because the two bars catch different things: a ₹12k gap on a
 * ₹40 L bill is worth a look even at 0.3%, and a 4% gap on a ₹60k bill is
 * worth a look even at ₹2.4k. Tune either bar here -- the histogram's
 * "material" shading and the KPI both read from this one predicate.
 */
export const MATERIAL_GAP_PCT = 1

export function isMaterialGap(row: { abs_gap_amount: number | null; gap_pct: number | null }): boolean {
  return (row.abs_gap_amount ?? 0) >= MEDIUM_SEVERITY_AMOUNT || (row.gap_pct ?? 0) >= MATERIAL_GAP_PCT
}

// ---------------------------------------------------------------------------
// D-05 gap-percentage histogram. Bucketed server-side; the chart is handed
// only `{ bucketLabel, count, material }` so no threshold constant crosses
// the client boundary.
// ---------------------------------------------------------------------------

export type GapHistogramBucket = { bucketLabel: string; count: number; material: boolean }

const GAP_PCT_BUCKETS: { label: string; test: (r: LedgerBillReconciliationRow) => boolean }[] = [
  { label: 'No gap', test: (r) => r.abs_gap_amount === 0 },
  { label: '0-1%', test: (r) => r.gap_pct != null && r.gap_pct > 0 && r.gap_pct < 1 },
  { label: '1-5%', test: (r) => r.gap_pct != null && r.gap_pct >= 1 && r.gap_pct < 5 },
  { label: '5-10%', test: (r) => r.gap_pct != null && r.gap_pct >= 5 && r.gap_pct < 10 },
  { label: '10-25%', test: (r) => r.gap_pct != null && r.gap_pct >= 10 && r.gap_pct < 25 },
  { label: '25%+', test: (r) => r.gap_pct != null && r.gap_pct >= 25 },
  { label: 'Not computable', test: (r) => r.gap_pct == null },
]

function buildGapHistogram(rows: LedgerBillReconciliationRow[]): GapHistogramBucket[] {
  return GAP_PCT_BUCKETS.map(({ label, test }) => {
    const inBucket = rows.filter(test)
    return {
      bucketLabel: label,
      count: inBucket.length,
      // A bucket is "material" if any of its rows clears the materiality bar.
      // "No gap" never is; a high-₹ gap that happens to be a tiny percentage
      // still lights up whichever percent bucket it lands in.
      material: inBucket.some(isMaterialGap),
    }
  }).filter((b) => b.count > 0)
}

// ---------------------------------------------------------------------------

export type ReconciliationGapSurfaceData = {
  eventName: string | null
  previousEventName: string | null
  ledgerBillReconciliation: {
    rows: LedgerBillReconciliationRow[]
    error: string | null
    materialCount: number
    materialAbsGapTotal: number
    histogram: GapHistogramBucket[]
    previousMaterialCount: number | null
    previousMaterialAbsGapTotal: number | null
  }
  entriesWithoutBill: {
    rows: EntryWithoutBillRow[]
    error: string | null
    byDepartment: UndocumentedRollupRow[]
    byVendor: UndocumentedRollupRow[]
    totalUndocumented: number
    noDocumentCount: number
    eventSpend: number
    undocumentedPctOfSpend: number | null
    previousTotalUndocumented: number | null
  }
}

const RECON_SELECT =
  'entry_id, department_id, department_name, vendor_id, vendor_display_name, invoice_number, entry_amount, bill_total, gap_amount, abs_gap_amount, gap_pct, entry_date, event_id'
const NOBILL_SELECT =
  'entry_id, department_id, department_name, vendor_id, vendor_display_name, entry_amount, entry_date, has_document, event_id'
const ROLLUP_SELECT =
  'dimension, dimension_id, dimension_name, entry_count, no_document_count, undocumented_amount, event_id'

const sumBy = <T,>(rows: T[], pick: (r: T) => number | null | undefined): number =>
  round2Local(rows.reduce((s, r) => s + (pick(r) ?? 0), 0))

export async function loadReconciliationGap(compareBasis: CompareBasis): Promise<ReconciliationGapSurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  const eventId = selectedEvent?.id ?? null

  const [reconRes, noBillRes, rollupRes, spendRes] = await Promise.all([
    supabase
      .from('v_ledger_bill_reconciliation')
      .select(RECON_SELECT)
      .eq('event_id', eventId)
      .order('abs_gap_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<LedgerBillReconciliationRow[]>(),
    supabase
      .from('v_entries_without_bill')
      .select(NOBILL_SELECT)
      .eq('event_id', eventId)
      .order('entry_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<EntryWithoutBillRow[]>(),
    supabase
      .from('v_entries_without_bill_rollup')
      .select(ROLLUP_SELECT)
      .eq('event_id', eventId)
      // 'department' sorts before 'vendor', and department rows are the ones
      // the grand total is taken from -- keep them ahead of the cap.
      .order('dimension', { ascending: true })
      .order('undocumented_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<UndocumentedRollupRow[]>(),
    // Event's total non-void spend, for the D-06 "% of event spend" figure
    // (mirrors lib/reports/surfaces/integrity.ts's totalSpend query).
    supabase
      .from('entries')
      .select('amount')
      .eq('event_id', eventId)
      .eq('is_void', false)
      .returns<{ amount: number | null }[]>(),
  ])

  const reconRows = reconRes.data ?? []
  const noBillRows = noBillRes.data ?? []
  const rollupRows = rollupRes.data ?? []

  const materialRows = reconRows.filter(isMaterialGap)
  const materialCount = materialRows.length
  const materialAbsGapTotal = sumBy(materialRows, (r) => r.abs_gap_amount)
  const histogram = buildGapHistogram(reconRows)

  const byDepartment = rollupRows
    .filter((r) => r.dimension === 'department')
    .sort((a, b) => b.undocumented_amount - a.undocumented_amount)
  const byVendor = rollupRows
    .filter((r) => r.dimension === 'vendor')
    .sort((a, b) => b.undocumented_amount - a.undocumented_amount)

  const totalUndocumented = sumBy(byDepartment, (r) => r.undocumented_amount)
  const noDocumentCount = byDepartment.reduce((s, r) => s + r.no_document_count, 0)
  const eventSpend = sumBy(spendRes.data ?? [], (r) => r.amount)
  const undocumentedPctOfSpend = eventSpend > 0 ? round2Local((totalUndocumented / eventSpend) * 100) : null

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousMaterialCount: number | null = null
  let previousMaterialAbsGapTotal: number | null = null
  let previousTotalUndocumented: number | null = null

  if (previousEvent) {
    const [pRecon, pRollup] = await Promise.all([
      supabase
        .from('v_ledger_bill_reconciliation')
        .select('abs_gap_amount, gap_pct')
        .eq('event_id', previousEvent.id)
        .limit(ROW_CAP)
        .returns<{ abs_gap_amount: number | null; gap_pct: number | null }[]>(),
      supabase
        .from('v_entries_without_bill_rollup')
        .select('undocumented_amount')
        .eq('event_id', previousEvent.id)
        .eq('dimension', 'department')
        .limit(ROW_CAP)
        .returns<{ undocumented_amount: number }[]>(),
    ])
    const pMaterial = (pRecon.data ?? []).filter(isMaterialGap)
    previousMaterialCount = pMaterial.length
    previousMaterialAbsGapTotal = sumBy(pMaterial, (r) => r.abs_gap_amount)
    previousTotalUndocumented = sumBy(pRollup.data ?? [], (r) => r.undocumented_amount)
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    ledgerBillReconciliation: {
      rows: reconRows,
      error: friendlyDataError(reconRes.error, 'reports:forensics:ledger-bill-reconciliation'),
      materialCount,
      materialAbsGapTotal,
      histogram,
      previousMaterialCount,
      previousMaterialAbsGapTotal,
    },
    entriesWithoutBill: {
      rows: noBillRows,
      error:
        friendlyDataError(noBillRes.error, 'reports:forensics:entries-without-bill') ??
        friendlyDataError(rollupRes.error, 'reports:forensics:entries-without-bill-rollup') ??
        friendlyDataError(spendRes.error, 'reports:forensics:event-spend'),
      byDepartment,
      byVendor,
      totalUndocumented,
      noDocumentCount,
      eventSpend,
      undocumentedPctOfSpend,
      previousTotalUndocumented,
    },
  }
}
