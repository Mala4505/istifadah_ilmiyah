/**
 * Data loader for reporting-blueprint.md §4 D-09 -- Threshold splitting.
 * "Histogram of invoice amounts. A spike just below an approval limit is
 * deliberate splitting -- but the limits have to be recorded first."
 *
 * Entirely app-side: no view. Three reads --
 *   1. approval_threshold (20260903000018) -- the recorded limits. EMPTY today
 *      (the org runs no formal limit, lib/analytics/thresholds.ts APPROVAL_LIMIT
 *      = null). The loader resolves the latest effective row per scope
 *      (org-wide or per department) and hands the section `activeThresholds`.
 *      When there are none, the section shows the bare histogram and says so.
 *   2. entries.amount (non-void, event-scoped) -- bucketed here into a fixed
 *      set of rupee bands. `entries` is department-scoped by RLS, so a scoped
 *      reviewer's histogram covers only their departments -- acceptable, same
 *      as every other entries-derived report.
 *   3. v_compliance_summary filtered to flag_type = 'vendor_splitting' -- the
 *      existing pattern detector's output (lib/analytics/thresholds.ts
 *      SPLITTING_* / CONCENTRATION_MIN_TOTAL). Surfaced regardless of whether
 *      any approval_threshold rows exist -- a concentration-mode splitting
 *      flag is real even with no limit to breach. Scoped with the
 *      `.or(event_id.eq.X,event_id.is.null)` branch (a vendor_splitting flag
 *      has entry_id null, hence a null event_id -- the Phase 0 §0.2 rule).
 *
 * Prior-period comparison does not apply here -- a histogram of the current
 * event's amounts has no meaningful week-old or prior-event headline scalar
 * the section needs -- so this loader takes no `compareBasis` (unlike the
 * other surfaces). The parent's route wires it without one.
 *
 * Row types live here for now; the parent hoists them into shared.tsx.
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import { ROW_CAP, round2Local } from '@/lib/reports/sections/shared'

// A generous cap: the corpus is a single event's worth of bills (hundreds),
// well under this. Bumped above ROW_CAP because this is a raw-amount scan, not
// a ranked list where only the top matters.
const AMOUNT_SCAN_CAP = 20_000

/** One recorded approval limit. `department_id` null = an org-wide rule. */
export type ApprovalThresholdRow = {
  id: number
  department_id: number | null
  min_amount: number
  escalates_to: string
  effective_from: string
  note: string | null
}

/** The limit in force for one scope right now (latest effective_from <= today
 *  for that department, or org-wide). */
export type ActiveThreshold = {
  minAmount: number
  escalatesTo: string
  departmentId: number | null
  departmentName: string | null
  effectiveFrom: string
}

/** One histogram bar. `belowThreshold` marks a bar sitting at or just under a
 *  recorded limit -- where a splitting spike would show. */
export type AmountHistogramBucket = {
  bucketLabel: string
  min: number
  /** null = open-ended top bucket. */
  max: number | null
  count: number
  totalAmount: number
  belowThreshold: boolean
}

/** A vendor_splitting flag from v_compliance_summary. */
export type SplittingFlagRow = {
  id: number
  severity: string | null
  description: string | null
  amount_at_risk: number | null
  status: string | null
  vendor_id: number | null
  vendor_display_name: string | null
  department_id: number | null
  department_name: string | null
  related_entry_ids: number[] | null
  created_at: string
  event_id: number | null
}

// Fixed rupee bands. Chosen to be dense in the region where approval limits
// for an organisation this size would plausibly sit (₹25k - ₹5L) and coarse
// in the long tail.
const BUCKET_EDGES = [0, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]

function bucketLabel(min: number, max: number | null): string {
  const f = (n: number) => (n >= 100_000 ? `${n / 100_000}L` : n >= 1_000 ? `${n / 1_000}k` : `${n}`)
  if (max === null) return `₹${f(min)}+`
  return `₹${f(min)}–${f(max)}`
}

export function buildAmountHistogram(
  amounts: number[],
  activeThresholds: ActiveThreshold[]
): AmountHistogramBucket[] {
  const buckets: AmountHistogramBucket[] = []
  for (let i = 0; i < BUCKET_EDGES.length; i++) {
    const min = BUCKET_EDGES[i]!
    const max = i + 1 < BUCKET_EDGES.length ? BUCKET_EDGES[i + 1]! : null
    buckets.push({ bucketLabel: bucketLabel(min, max), min, max, count: 0, totalAmount: 0, belowThreshold: false })
  }
  for (const amount of amounts) {
    if (amount == null || Number.isNaN(amount)) continue
    const idx = buckets.findIndex((b) => amount >= b.min && (b.max === null || amount < b.max))
    const bucket = idx >= 0 ? buckets[idx]! : buckets[buckets.length - 1]!
    bucket.count += 1
    bucket.totalAmount = round2Local(bucket.totalAmount + amount)
  }
  // Mark the bucket a limit falls in, and the one immediately below it, as the
  // "just below the limit" region a splitting spike would occupy.
  const limits = [...new Set(activeThresholds.map((t) => t.minAmount))]
  for (const limit of limits) {
    const containingIdx = buckets.findIndex((b) => limit > b.min && (b.max === null || limit <= b.max))
    if (containingIdx >= 0) {
      buckets[containingIdx]!.belowThreshold = true
      if (containingIdx > 0) buckets[containingIdx - 1]!.belowThreshold = true
    }
  }
  return buckets
}

/** Latest effective limit per scope (department id, or null for org-wide). */
export function resolveActiveThresholds(
  rows: ApprovalThresholdRow[],
  departmentNames: Map<number, string>,
  today = new Date()
): ActiveThreshold[] {
  const todayIso = today.toISOString().slice(0, 10)
  const byScope = new Map<number | 'org', ApprovalThresholdRow>()
  for (const r of rows) {
    if (r.effective_from > todayIso) continue
    const key: number | 'org' = r.department_id ?? 'org'
    const current = byScope.get(key)
    if (!current || r.effective_from > current.effective_from || (r.effective_from === current.effective_from && r.id > current.id)) {
      byScope.set(key, r)
    }
  }
  return [...byScope.values()]
    .map((r) => ({
      minAmount: r.min_amount,
      escalatesTo: r.escalates_to,
      departmentId: r.department_id,
      departmentName: r.department_id != null ? (departmentNames.get(r.department_id) ?? null) : null,
      effectiveFrom: r.effective_from,
    }))
    .sort((a, b) => a.minAmount - b.minAmount)
}

export type ThresholdSplittingSurfaceData = {
  eventName: string | null
  thresholdRows: ApprovalThresholdRow[]
  activeThresholds: ActiveThreshold[]
  thresholdError: string | null
  histogram: AmountHistogramBucket[]
  entryCount: number
  entriesError: string | null
  splittingFlags: SplittingFlagRow[]
  splittingFlagsError: string | null
}

const THRESHOLD_SELECT = 'id, department_id, min_amount, escalates_to, effective_from, note'
const FLAG_SELECT =
  'id, severity, description, amount_at_risk, status, vendor_id, vendor_display_name, department_id, department_name, related_entry_ids, created_at, event_id'

export async function loadThresholdSplitting(): Promise<ThresholdSplittingSurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent(supabase)
  const eventId = selectedEvent?.id ?? null

  const splittingQuery =
    eventId === null
      ? supabase
          .from('v_compliance_summary')
          .select(FLAG_SELECT)
          .eq('flag_type', 'vendor_splitting')
          .limit(ROW_CAP)
          .returns<SplittingFlagRow[]>()
      : supabase
          .from('v_compliance_summary')
          .select(FLAG_SELECT)
          .eq('flag_type', 'vendor_splitting')
          .or(`event_id.eq.${eventId},event_id.is.null`)
          .limit(ROW_CAP)
          .returns<SplittingFlagRow[]>()

  const [thresholdRes, entriesRes, deptRes, splittingRes] = await Promise.all([
    supabase
      .from('approval_threshold')
      .select(THRESHOLD_SELECT)
      .order('effective_from', { ascending: false })
      .limit(ROW_CAP)
      .returns<ApprovalThresholdRow[]>(),
    supabase
      .from('entries')
      .select('amount')
      .eq('event_id', eventId)
      .eq('is_void', false)
      .not('amount', 'is', null)
      .limit(AMOUNT_SCAN_CAP)
      .returns<{ amount: number | null }[]>(),
    supabase.from('department').select('id, name').returns<{ id: number; name: string }[]>(),
    splittingQuery,
  ])

  const thresholdRows = thresholdRes.data ?? []
  const departmentNames = new Map((deptRes.data ?? []).map((d) => [d.id, d.name]))
  const activeThresholds = resolveActiveThresholds(thresholdRows, departmentNames)

  const amounts = (entriesRes.data ?? []).map((r) => r.amount).filter((a): a is number => a != null)
  const histogram = buildAmountHistogram(amounts, activeThresholds)

  return {
    eventName: selectedEvent?.name ?? null,
    thresholdRows,
    activeThresholds,
    thresholdError: friendlyDataError(thresholdRes.error, 'reports:threshold-splitting:thresholds'),
    histogram,
    entryCount: amounts.length,
    entriesError:
      friendlyDataError(entriesRes.error, 'reports:threshold-splitting:entries') ??
      friendlyDataError(deptRes.error, 'reports:threshold-splitting:departments'),
    splittingFlags: splittingRes.data ?? [],
    splittingFlagsError: friendlyDataError(splittingRes.error, 'reports:threshold-splitting:flags'),
  }
}
