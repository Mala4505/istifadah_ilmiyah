/**
 * Shared building blocks for the split Reports surfaces
 * (reporting-blueprint.md §8 Phase Three: "Split the page into the five
 * surfaces; move existing sections into Budget, Vendors & Purchases and
 * Integrity; keep Explore as the drill workspace.").
 *
 * The former single app/(app)/reports/page.tsx carried every row type, every
 * "one sentence under the chart" helper (§6 fix #3), the prior-period delta
 * machinery (§6 fix #1) and the budget-status colour scale inline. Each of
 * those is now needed by more than one route -- Explore (/reports) renders
 * every section, and the three audience surfaces each render their own
 * subset -- so they live here, imported by both the per-surface loaders
 * (lib/reports/surfaces/*.ts) and the per-section presenters
 * (components/reports/sections/*.tsx).
 *
 * No queries here: this module is pure helpers + types so it stays
 * importable from server and client alike. Query code lives in the surface
 * loaders.
 */
import { startOfISOWeek, subWeeks } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAllEvents } from '@/lib/events/current'
import { COMPARE_BASIS_LABELS, type CompareBasis } from '@/lib/reports/compare-basis'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'
import type { DonutSegment } from '@/components/reports/charts/donut-chart'

/** Safety cap on entry-level views at 1k-10k entry volume (blueprint §0). */
export const ROW_CAP = 1000

// ---------------------------------------------------------------------------
// Row shapes -- one per reporting view. Names and fields unchanged from the
// former page.tsx so the surface loaders' `.select(...)` strings port over
// verbatim.
// ---------------------------------------------------------------------------

export type BudgetVsActualRow = {
  budget_head_id: number
  raw_label: string
  short_label: string | null
  department_id: number | null
  approved_amount: number | null
  utilised_amount: number | null
  balance_amount: number | null
  actual_amount: number | null
  entry_count: number
  pct_of_approved: number | null
  budget_status_note: string | null
}

export type DepartmentBudgetVsActualRow = {
  department_id: number
  department_name: string
  as_of: string | null
  budget_amount: number | null
  actual_amount: number | null
  entry_count: number
  pct_of_budget: number | null
  budget_status_note: string | null
}

export type SubDepartmentBudgetVsActualRow = {
  sub_department_id: number
  sub_department_name: string
  department_id: number
  department_name: string
  as_of: string | null
  budget_amount: number | null
  actual_amount: number | null
  entry_count: number
  pct_of_budget: number | null
  budget_status_note: string | null
}

/** Display-only: a department header row followed by its sub-department rows
 *  indented underneath (blueprint's roll-up requirement). */
export type SubDepartmentBudgetTableRow = {
  kind: 'department' | 'sub-department'
  rowKey: string
  label: string
  department_id: number
  as_of: string | null
  budget_amount: number | null
  actual_amount: number | null
  entry_count: number
  pct_of_budget: number | null
  budget_status_note: string | null
}

export type VendorSpendRow = {
  vendor_id: number
  display_name: string
  entry_count: number
  total_amount: number | null
  first_entry_date: string | null
  last_entry_date: string | null
  entries_with_documents: number
  document_coverage_pct: number | null
}

export type VendorConcentrationRow = {
  vendor_id: number
  display_name: string
  is_confirmed: boolean
  entry_count: number
  total_amount: number | null
  open_flag_count: number
  open_flag_amount_at_risk: number | null
  pct_of_total_spend: number | null
}

/** v_vendor_spend joined with v_vendor_concentration on vendor_id (§5.2). */
export type MergedVendorRow = VendorSpendRow & {
  pct_of_total_spend: number | null
  open_flag_count: number
  open_flag_amount_at_risk: number | null
}

export type ZoneSpendRow = {
  zone_id: number | null
  zone_name: string
  zone_number: number | null
  department_id: number | null
  entry_count: number
  total_amount: number | null
}

export type HubAgeingRow = {
  entry_id: number
  department_id: number | null
  ubbl_number: string
  hub_status_code: string
  hub_status_label: string
  hub_status_changed_at: string | null
  days_in_status: number
  age_bucket: '0-2' | '3-7' | '8+'
}

export type OpenIssueRow = {
  source_table: string
  id: number
  entry_id: number | null
  issue_type: string
  severity: string
  amount_at_risk: number | null
  description: string | null
  status: string
  created_at: string
}

export type ComplianceRow = {
  id: number
  flag_type: string
  severity: string
  description: string | null
  amount_at_risk: number | null
  status: string
  entry_id: number | null
  vendor_id: number | null
  vendor_display_name: string | null
  department_id: number | null
  department_name: string | null
  created_at: string
  last_detected_at: string
  related_entry_ids: number[] | null
}

export type SpendByFamilyRow = {
  item_family_id: number
  family_key: string
  label: string
  default_unit: string | null
  is_confirmed: boolean
  total_spend: number
  observation_count: number
  vendor_count: number
}

export type RateBenchmarkRow = {
  item_family_id: number
  family_key: string
  family_label: string
  unit_normalized: string | null
  median_rate: number | null
  observation_count: number
  vendor_count: number
  min_rate: number | null
  max_rate: number | null
}

// ---------------------------------------------------------------------------
// Phase Four finding views (reporting-blueprint.md §8 Phase Four: C-04, C-09,
// B-01, D-01, D-02). Row shapes for the four views added in
// 20260903000002_phase_four_finding_views.sql; B-01 reuses VendorConcentrationRow
// above. Field names match the view's `select` list verbatim so the loaders'
// `.select(...)` strings port straight across.
// ---------------------------------------------------------------------------

/** C-04 -- one row per comparable rate_reference observation, with the
 *  (family, unit, event) median attached and the overpayment precomputed. */
export type RateObservationRow = {
  rate_reference_id: number
  item_family_id: number
  family_key: string
  family_label: string
  unit_normalized: string | null
  vendor_id: number | null
  vendor_display_name: string | null
  net_rate: number
  quantity: number
  observed_date: string | null
  entry_id: number | null
  department_id: number | null
  department_name: string | null
  median_rate: number | null
  observation_count: number
  vendor_count: number
  overpayment_amount: number
}

/** C-09 -- per (department, instrument_type, event) entry count + summed spend.
 *  `instrument_type` includes the synthetic 'unclassified' / 'no_document'
 *  buckets (see the migration header). */
export type InstrumentTypeMixRow = {
  department_id: number | null
  department_name: string | null
  instrument_type: string
  entry_count: number
  total_amount: number
}

/** D-01 -- per (source_table, issue_type, severity, department, event) OPEN
 *  issue count + summed ₹ at risk. */
export type ExceptionHeatmapRow = {
  source_table: string
  issue_type: string
  severity: string
  department_id: number | null
  department_name: string | null
  issue_count: number
  amount_at_risk: number
}

/** D-02 -- per (source_table, status, event) issue count + summed ₹ at risk,
 *  across ALL statuses. */
export type AmountAtRiskByStatusRow = {
  source_table: string
  status: string
  issue_count: number
  amount_at_risk: number
}

/** Human labels for the instrument_type codes (C-09). Mirrors the
 *  document_extraction_instrument_type_*_check constraint list plus the two
 *  synthetic buckets. */
export const INSTRUMENT_TYPE_LABELS: Record<string, string> = {
  tax_invoice: 'Tax invoice',
  bill_of_supply: 'Bill of supply',
  retail_cash_memo: 'Retail cash memo',
  letterhead_bill: 'Letterhead bill',
  proforma_invoice: 'Proforma invoice',
  quotation: 'Quotation',
  receipt: 'Receipt',
  delivery_challan: 'Delivery challan',
  other: 'Other',
  unclassified: 'Not yet classified',
  no_document: 'No supporting bill',
}

/** Instrument types that carry a claimable input-tax credit -- "proper" backing
 *  in the blueprint's C-09 framing ("₹X of spend is supported only by a
 *  letterhead bill ends a meeting quickly"). */
export const ITC_BACKED_INSTRUMENT_TYPES = new Set(['tax_invoice'])

/**
 * B-01 concentration curve points: vendors ranked by spend descending, each
 * carrying the cumulative share of total spend up to and including it, next to
 * the even-spend reference (rank / n). One dot per vendor; the gap between the
 * curve and the diagonal is the concentration.
 */
export type ConcentrationPoint = {
  rank: number
  vendorId: number
  vendorName: string
  spend: number
  sharePct: number
  cumulativeSharePct: number
  evenSharePct: number
}

export function buildConcentrationCurve(
  rows: { vendor_id: number; display_name: string; total_amount: number | null; pct_of_total_spend: number | null }[]
): ConcentrationPoint[] {
  const ranked = rows
    .filter((r) => (r.total_amount ?? 0) > 0)
    .sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))
  const n = ranked.length
  if (n === 0) return []
  const total = ranked.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  let running = 0
  return ranked.map((r, i) => {
    running += r.total_amount ?? 0
    const sharePct = total > 0 ? round2Local(((r.total_amount ?? 0) / total) * 100) : 0
    return {
      rank: i + 1,
      vendorId: r.vendor_id,
      vendorName: r.display_name,
      spend: r.total_amount ?? 0,
      sharePct,
      cumulativeSharePct: total > 0 ? round2Local((running / total) * 100) : 0,
      evenSharePct: round2Local(((i + 1) / n) * 100),
    }
  })
}

// ---------------------------------------------------------------------------
// Prior-period comparison (blueprint §6 fix #1). Each surface loader resolves
// the previous event once, then re-runs its own views against it; these two
// helpers keep that consistent across surfaces.
// ---------------------------------------------------------------------------

export type DeltaTone = 'good' | 'bad' | 'neutral'

/**
 * The event immediately older than `currentEventId`, or null when the basis
 * isn't 'prior_event', there's no active event, or the current event is the
 * oldest on record. Surface loaders call this before deciding whether to
 * issue their prior-period query round.
 */
export async function resolvePreviousEvent(
  supabase: SupabaseClient,
  compareBasis: CompareBasis,
  currentEventId: number | null
): Promise<{ id: number; name: string } | null> {
  if (compareBasis !== 'prior_event' || currentEventId === null) return null
  const events = await getAllEvents(supabase) // most-recent Hijri year first
  const idx = events.findIndex((e) => e.id === currentEventId)
  if (idx === -1) return null
  const previous = events[idx + 1] ?? null
  return previous ? { id: previous.id, name: previous.name } : null
}

/**
 * A KpiTile `delta` string like "+₹3.2 L vs prior event", or undefined when
 * no comparison should be shown (basis 'none', or no prior figure resolved).
 * Mirrors the former page.tsx `formatDeltaVs` exactly.
 */
export function formatDeltaVs(
  compareBasis: CompareBasis,
  current: number,
  previous: number | null,
  kind: 'inr' | 'count'
): string | undefined {
  if (previous == null || compareBasis === 'none') return undefined
  const delta = current - previous
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
  const magnitude = kind === 'inr' ? formatINRCompact(Math.abs(delta)) : formatNumber(Math.abs(delta))
  return `${sign}${magnitude} ${COMPARE_BASIS_LABELS[compareBasis]}`
}

export function deltaToneHigherIsBad(current: number, previous: number | null): DeltaTone {
  if (previous == null) return 'neutral'
  if (current > previous) return 'bad'
  if (current < previous) return 'good'
  return 'neutral'
}

export function deltaToneHigherIsGood(current: number, previous: number | null): DeltaTone {
  if (previous == null) return 'neutral'
  if (current > previous) return 'good'
  if (current < previous) return 'bad'
  return 'neutral'
}

// ---------------------------------------------------------------------------
// 8-point trailing-weekly sparkline for the Integrity sections whose rows
// already carry a per-row timestamp -- buckets already-fetched rows, issues
// no query of its own.
// ---------------------------------------------------------------------------

export const DETAIL_TREND_WEEKS = 8

export function round2Local(n: number): number {
  return Math.round(n * 100) / 100
}

export function buildTrailingWeeklySeries<T>(
  rows: T[],
  getDate: (row: T) => string | null,
  reduceBucket: (rowsInBucket: T[]) => number,
  weeks = DETAIL_TREND_WEEKS
): number[] {
  const lastWeekStart = startOfISOWeek(new Date())
  const bucketKeys: string[] = []
  for (let i = weeks - 1; i >= 0; i -= 1) {
    bucketKeys.push(subWeeks(lastWeekStart, i).toISOString().slice(0, 10))
  }
  const byKey = new Map<string, T[]>()
  for (const k of bucketKeys) byKey.set(k, [])
  for (const row of rows) {
    const raw = getDate(row)
    if (!raw) continue
    const key = startOfISOWeek(new Date(raw)).toISOString().slice(0, 10)
    const bucketRows = byKey.get(key)
    if (bucketRows) bucketRows.push(row)
  }
  return bucketKeys.map((k) => reduceBucket(byKey.get(k) ?? []))
}

// ---------------------------------------------------------------------------
// Budget-status colour scale + legend (blueprint §6 fix #5: reserved status
// colours, never the ordinal ramp). Used by all three budget sections.
// ---------------------------------------------------------------------------

/** bg-* class for a budget bar: green within budget, amber near the limit,
 *  red over. `undefined` (default accent) when there is no approved figure
 *  to compare against. */
export function budgetStatusColorClass(approved: number | null, actual: number | null): string | undefined {
  if (!approved || approved <= 0) return undefined
  const pct = ((actual ?? 0) / approved) * 100
  if (pct <= 95) return 'bg-emerald-600 dark:bg-emerald-500'
  if (pct <= 110) return 'bg-amber-500 dark:bg-amber-400'
  return 'bg-red-600 dark:bg-red-500'
}

export function BudgetStatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-emerald-600 dark:bg-emerald-500" />
        Within budget
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400" />
        Near limit
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-red-600 dark:bg-red-500" />
        Over budget
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 bg-foreground/70" />
        Approved amount
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Severity donut segments -- shared by Open Issues and Compliance.
// ---------------------------------------------------------------------------

const SEVERITY_DONUT_COLOR: Record<'high' | 'medium' | 'low', string> = {
  high: 'stroke-red-600 dark:stroke-red-400',
  medium: 'stroke-amber-500 dark:stroke-amber-400',
  low: 'stroke-muted-foreground',
}

export function severitySegments(rows: { severity: string | null }[]): DonutSegment[] {
  const counts: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 }
  for (const r of rows) {
    const k = r.severity === 'high' || r.severity === 'medium' ? r.severity : 'low'
    counts[k] += 1
  }
  return (['high', 'medium', 'low'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => ({
      key: k,
      label: k === 'high' ? 'High severity' : k === 'medium' ? 'Medium severity' : 'Low severity',
      value: counts[k],
      colorClass: SEVERITY_DONUT_COLOR[k],
    }))
}
