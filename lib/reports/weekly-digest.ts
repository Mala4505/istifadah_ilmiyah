import { differenceInCalendarDays } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import { friendlyDataError } from '@/lib/friendly-error'
import { createClient } from '@/lib/supabase/server'
import { formatINR, formatINRCompact, formatPercent, humanizeCode } from '@/lib/reports/format'
import {
  ROW_CAP,
  round2Local,
  type ComplianceRow,
  type OpenIssueRow,
  type DepartmentBudgetVsActualRow,
  type RateObservationRow,
  type RateDriftRow,
  type VendorFirstBillRow,
} from '@/lib/reports/sections/shared'

// Weekly digest -- reporting-blueprint.md §3 E-04 ("The ten things most worth
// attention this week, ranked by rupees, each written as a plain sentence with
// an owner. The only report a busy person reads end to end.") and §8 Phase Six.
//
// This is deliberately NOT a new view. Every candidate source is an EXISTING
// reporting view; the "what surfaced or worsened in the last 7 days" filter and
// the cross-source ranking are pure application composition here, exactly the
// way lib/reports/executive-brief.ts fans several views out with Promise.all,
// reuses their rows, and resolves an owner from admin_head / department. E-04 is
// broader than the Brief's band-4 "Needs your decision" panel (open issues by
// ₹): it also pulls in budget-pace breaches, above-median overpayment spikes,
// rate drift, new-vendor-first-bill, and the round-number / duplicate /
// concentration compliance flags -- but only where they surfaced or worsened
// this week.
//
// Six candidate sources, each contributing 0-N items into one shared scoring
// and sort (by rupees, descending), capped at ten:
//
//   1. v_compliance_summary   -- every open flag type (duplicate payment,
//        round-number bias, vendor concentration / splitting, GST, ...). "This
//        week" = created_at OR last_detected_at within 7 days, so a flag that
//        merely WORSENED (was re-detected) this week counts too. Same
//        `.or(event_id.eq.X,event_id.is.null)` scoping as the Brief / Integrity
//        surface -- a vendor-level flag has a null event_id and must be kept.
//   2. v_open_issues          -- reconciliation_exception rows only (the flags
//        half of this view is already covered by source 1 above; taking both
//        would double-count). "This week" = created_at within 7 days.
//   3. v_department_budget_vs_actual -- a department at/above 90% of its budget.
//        There is no allocation-crossing history to diff against, so this is
//        best-effort "as of today" (ageDays = null) per the blueprint's own
//        allowance.
//   4. v_rate_observation (C-04) -- above-our-own-median overpayment, one row
//        per comparable observation, aggregated here per (vendor, item family).
//        "This week" = observed_date within 7 days. Plain `.eq('event_id')`
//        (no is-null branch) matching executive-brief.ts's own C-04 query.
//   5. v_rate_drift (C-05)    -- a (vendor, item family) series whose latest
//        week is within 7 days and whose median has drifted up since week one.
//        The rupee figure is an ESTIMATE: per-unit drift × observations in the
//        series (the view carries no quantity). `.or` event scoping (the view
//        resolves event via rate_reference.entry_id, which can be null).
//   6. v_vendor_first_bill (B-05) -- a vendor genuinely new mid-event whose
//        first bill landed within 7 days. Rupee figure = that opening invoice.
//
// "Owner" (blueprint §3): admin_head name, else department name, else
// "Unassigned" -- resolved from entries.admin_head_id / entries.department_id
// for the entry behind a finding, or (for vendor-keyed sources that carry no
// entry) the modal department / admin head across that vendor's entries this
// event. Mirrors executive-brief.ts's owner resolution, extended to admin_head.

const WINDOW_DAYS = 7
const DIGEST_CAP = 10

/** A department at or above this % of its budget is a pace breach worth a
 *  line. Not in lib/analytics/thresholds.ts (that file is statutory / detector
 *  policy); this is a reporting-surface display cut, kept local like the
 *  Brief's own `pctOfBudget >= 90` sentence gate in executive-brief.ts. */
const BUDGET_PACE_WARN_PCT = 90

/** Below this week-over-week median move, a "drift" is rounding noise, not a
 *  finding. Assumption for E-04 only -- distinct from thresholds.ts's
 *  RATE_ABOVE_BENCHMARK_PCT (25), which measures a single rate against a family
 *  median, not a series against its own first week. */
const RATE_DRIFT_MIN_PCT = 10

export type WeeklyDigestCategory =
  | 'compliance_flag'
  | 'reconciliation'
  | 'budget_pace'
  | 'overpayment'
  | 'rate_drift'
  | 'new_vendor'

export type WeeklyDigestItem = {
  /** Stable unique key across a refresh -- `${category}:${sourceId}`. */
  key: string
  /** 1-based, assigned after the cross-source sort. */
  rank: number
  /** The "what" clause, a plain readable sentence on its own. The ₹ figure,
   *  owner and age are separate fields the section lays out around it. */
  headline: string
  /** Rupees, for ranking and display. Null only when a source genuinely has
   *  no rupee figure (kept, sorted last). */
  amount: number | null
  /** admin_head name, else department name, else "Unassigned". */
  owner: string
  /** Days since the finding surfaced / was last detected. Null for the
   *  best-effort budget-pace source ("as of today"). */
  ageDays: number | null
  /** Deep link to the entries / report behind this line. */
  href: string
  category: WeeklyDigestCategory
}

export type WeeklyDigestData = {
  eventName: string | null
  items: WeeklyDigestItem[]
  errors: {
    compliance: string | null
    reconciliation: string | null
    budget: string | null
    overpayment: string | null
    rateDrift: string | null
    newVendor: string | null
    owners: string | null
  }
}

type EntryOwnerRow = { id: number; department_id: number | null; admin_head_id: number | null }
type VendorOwnerRow = { vendor_id: number | null; department_id: number | null; admin_head_id: number | null }

const COMPLIANCE_SELECT =
  'id, flag_type, severity, description, amount_at_risk, status, entry_id, vendor_id, vendor_display_name, department_id, department_name, created_at, last_detected_at, related_entry_ids'
const ISSUES_SELECT =
  'source_table, id, entry_id, issue_type, severity, amount_at_risk, description, status, created_at'
const BUDGET_SELECT =
  'department_id, department_name, budget_amount, actual_amount, entry_count, pct_of_budget, budget_status_note'
const RATE_OBS_SELECT =
  'rate_reference_id, item_family_id, family_key, family_label, unit_normalized, vendor_id, vendor_display_name, net_rate, quantity, observed_date, entry_id, department_id, department_name, median_rate, observation_count, vendor_count, overpayment_amount'
const RATE_DRIFT_SELECT =
  'vendor_id, vendor_display_name, item_family_id, family_key, family_label, event_id, week_start, observation_count, min_rate, median_rate, max_rate, series_week_count, series_observation_count, first_week_start, first_week_median, last_week_start, last_week_median, drift_pct'
const FIRST_BILL_SELECT =
  'vendor_id, vendor_display_name, event_id, first_entry_date, first_entry_amount, max_entry_amount, total_spend, entry_count, event_first_entry_date, is_new_mid_event, opening_bill_is_largest'

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** admin_head name > department name > "Unassigned" -- the blueprint's owner
 *  chain. */
function resolveOwner(
  departmentId: number | null,
  adminHeadId: number | null,
  deptNames: Map<number, string>,
  headNames: Map<number, string>
): string {
  if (adminHeadId != null && headNames.has(adminHeadId)) return headNames.get(adminHeadId)!
  if (departmentId != null && deptNames.has(departmentId)) return deptNames.get(departmentId)!
  return 'Unassigned'
}

/** Most frequent non-null value of `key` across `rows` (deterministic: ties
 *  broken by lower id). */
function modal(rows: VendorOwnerRow[], key: 'department_id' | 'admin_head_id'): number | null {
  const counts = new Map<number, number>()
  for (const r of rows) {
    const v = r[key]
    if (v == null) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best: number | null = null
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && best != null && v < best)) {
      best = v
      bestCount = c
    }
  }
  return best
}

function ageLabelDays(iso: string | null): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return Math.max(0, differenceInCalendarDays(new Date(), d))
}

/**
 * `client` is an optional pre-built Supabase client — see loadHeroMetrics's
 * header (lib/reports/hero-metrics.ts) for why the `board_pack` job passes a
 * service-role client here instead of relying on `createClient()`.
 */
export async function loadWeeklyDigest(
  eventId: number | null,
  client?: SupabaseClient
): Promise<WeeklyDigestData> {
  const supabase: SupabaseClient = client ?? (await createClient())

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
  const sinceYmd = ymd(since)
  const eventScope = eventId === null ? null : `event_id.eq.${eventId},event_id.is.null`

  const [complianceRes, reconciliationRes, budgetRes, overpaymentRes, rateDriftRes, firstBillRes, eventRes] =
    await Promise.all([
      // 1 -- compliance flags: event-scoped OR entry-less, AND recent (surfaced
      // or worsened). Two chained `.or()` groups are ANDed by PostgREST.
      (() => {
        let q = supabase.from('v_compliance_summary').select(COMPLIANCE_SELECT)
        if (eventScope) q = q.or(eventScope)
        return q
          .or(`created_at.gte.${sinceYmd},last_detected_at.gte.${sinceYmd}`)
          .limit(ROW_CAP)
          .returns<ComplianceRow[]>()
      })(),
      // 2 -- reconciliation exceptions only (flags half is source 1).
      (() => {
        let q = supabase
          .from('v_open_issues')
          .select(ISSUES_SELECT)
          .eq('source_table', 'reconciliation_exception')
          .gte('created_at', sinceYmd)
        if (eventScope) q = q.or(eventScope)
        return q.limit(ROW_CAP).returns<OpenIssueRow[]>()
      })(),
      // 3 -- budget pace: entry-derived, plain event filter (matches
      // executive-brief.ts). `.gte` drops null pct rows for free.
      supabase
        .from('v_department_budget_vs_actual')
        .select(BUDGET_SELECT)
        .eq('event_id', eventId)
        .gte('pct_of_budget', BUDGET_PACE_WARN_PCT)
        .returns<DepartmentBudgetVsActualRow[]>(),
      // 4 -- C-04 overpayment, entry-derived, plain event filter (matches
      // executive-brief.ts's own v_rate_observation query).
      supabase
        .from('v_rate_observation')
        .select(RATE_OBS_SELECT)
        .eq('event_id', eventId)
        .gt('overpayment_amount', 0)
        .gte('observed_date', sinceYmd)
        .returns<RateObservationRow[]>(),
      // 5 -- C-05 rate drift: event resolved via rate_reference.entry_id
      // (nullable) so keep the is-null rows, same as the Vendors surface.
      (() => {
        let q = supabase
          .from('v_rate_drift')
          .select(RATE_DRIFT_SELECT)
          .gt('drift_pct', RATE_DRIFT_MIN_PCT)
          .gte('last_week_start', sinceYmd)
        if (eventScope) q = q.or(eventScope)
        return q.limit(ROW_CAP).returns<RateDriftRow[]>()
      })(),
      // 6 -- B-05 new vendor first bill, entry-derived, plain event filter
      // (matches the Vendors surface's own v_vendor_first_bill query).
      supabase
        .from('v_vendor_first_bill')
        .select(FIRST_BILL_SELECT)
        .eq('event_id', eventId)
        .eq('is_new_mid_event', true)
        .gte('first_entry_date', sinceYmd)
        .returns<VendorFirstBillRow[]>(),
      eventId === null
        ? Promise.resolve({ data: null, error: null } as { data: { name: string } | null; error: { message: string } | null })
        : supabase.from('event').select('name').eq('id', eventId).maybeSingle<{ name: string }>(),
    ])

  const complianceErr = friendlyDataError(complianceRes.error, 'weeklyDigest:compliance')
  const reconciliationErr = friendlyDataError(reconciliationRes.error, 'weeklyDigest:reconciliation')
  const budgetErr = friendlyDataError(budgetRes.error, 'weeklyDigest:budget')
  const overpaymentErr = friendlyDataError(overpaymentRes.error, 'weeklyDigest:overpayment')
  const rateDriftErr = friendlyDataError(rateDriftRes.error, 'weeklyDigest:rateDrift')
  const newVendorErr = friendlyDataError(firstBillRes.error, 'weeklyDigest:newVendor')

  const complianceRows = complianceRes.data ?? []
  const reconciliationRows = reconciliationRes.data ?? []
  const budgetRows = budgetRes.data ?? []
  const overpaymentRows = overpaymentRes.data ?? []
  const rateDriftRows = rateDriftRes.data ?? []
  const firstBillRows = firstBillRes.data ?? []

  // ---- Owner resolution -----------------------------------------------------
  // entry_ids behind flags / reconciliation exceptions; vendor_ids behind the
  // vendor-keyed sources that carry no entry.
  const entryIds = Array.from(
    new Set(
      [
        ...complianceRows.map((r) => r.entry_id),
        ...reconciliationRows.map((r) => r.entry_id),
      ].filter((id): id is number => id != null)
    )
  )
  const vendorIds = Array.from(
    new Set(
      [
        ...complianceRows.filter((r) => r.entry_id == null).map((r) => r.vendor_id),
        ...overpaymentRows.map((r) => r.vendor_id),
        ...rateDriftRows.map((r) => r.vendor_id),
        ...firstBillRows.map((r) => r.vendor_id),
      ].filter((id): id is number => id != null)
    )
  )

  const [entryOwnerRes, vendorEntriesRes, deptRes, headRes] = await Promise.all([
    entryIds.length === 0
      ? Promise.resolve({ data: [] as EntryOwnerRow[], error: null as { message: string } | null })
      : supabase.from('entries').select('id, department_id, admin_head_id').in('id', entryIds).returns<EntryOwnerRow[]>(),
    vendorIds.length === 0
      ? Promise.resolve({ data: [] as VendorOwnerRow[], error: null as { message: string } | null })
      : supabase
          .from('entries')
          .select('vendor_id, department_id, admin_head_id')
          .in('vendor_id', vendorIds)
          .eq('event_id', eventId)
          .eq('is_void', false)
          .limit(ROW_CAP)
          .returns<VendorOwnerRow[]>(),
    supabase.from('department').select('id, name').returns<{ id: number; name: string }[]>(),
    supabase.from('admin_head').select('id, name').returns<{ id: number; name: string }[]>(),
  ])

  const ownersErr =
    friendlyDataError(entryOwnerRes.error, 'weeklyDigest:entryOwner') ??
    friendlyDataError(vendorEntriesRes.error, 'weeklyDigest:vendorEntries') ??
    friendlyDataError(deptRes.error, 'weeklyDigest:department') ??
    friendlyDataError(headRes.error, 'weeklyDigest:adminHead')

  const deptNames = new Map((deptRes.data ?? []).map((d) => [d.id, d.name]))
  const headNames = new Map((headRes.data ?? []).map((h) => [h.id, h.name]))
  const entryOwnerById = new Map((entryOwnerRes.data ?? []).map((e) => [e.id, e]))

  const vendorRowsByVendor = new Map<number, VendorOwnerRow[]>()
  for (const r of vendorEntriesRes.data ?? []) {
    if (r.vendor_id == null) continue
    const list = vendorRowsByVendor.get(r.vendor_id) ?? []
    list.push(r)
    vendorRowsByVendor.set(r.vendor_id, list)
  }

  function ownerForEntry(entryId: number | null): string {
    const e = entryId != null ? entryOwnerById.get(entryId) : undefined
    return resolveOwner(e?.department_id ?? null, e?.admin_head_id ?? null, deptNames, headNames)
  }
  function ownerForVendor(vendorId: number | null): string {
    const rows = vendorId != null ? (vendorRowsByVendor.get(vendorId) ?? []) : []
    if (rows.length === 0) return 'Unassigned'
    return resolveOwner(modal(rows, 'department_id'), modal(rows, 'admin_head_id'), deptNames, headNames)
  }

  // ---- Candidate items ----------------------------------------------------
  const items: Omit<WeeklyDigestItem, 'rank'>[] = []

  // 1 -- compliance flags
  for (const r of complianceRows) {
    const surfaced = (r.created_at ?? '').slice(0, 10) >= sinceYmd
    const what = (r.description && r.description.trim().length > 0 ? r.description.trim() : humanizeCode(r.flag_type))
    const vendorPrefix = r.vendor_display_name && !what.includes(r.vendor_display_name) ? `${r.vendor_display_name}: ` : ''
    items.push({
      key: `compliance_flag:${r.id}`,
      headline: `${vendorPrefix}${what}${surfaced ? '' : ' (re-flagged this week)'}`,
      amount: r.amount_at_risk ?? null,
      owner:
        r.entry_id != null
          ? ownerForEntry(r.entry_id)
          : r.department_name ?? ownerForVendor(r.vendor_id),
      ageDays: ageLabelDays(r.created_at),
      href: r.vendor_id != null ? `/entries?vendor_id=${r.vendor_id}` : r.department_id != null ? `/entries?department_id=${r.department_id}` : '/reports/integrity',
      category: 'compliance_flag',
    })
  }

  // 2 -- reconciliation exceptions
  for (const r of reconciliationRows) {
    const e = r.entry_id != null ? entryOwnerById.get(r.entry_id) : undefined
    const what = r.description && r.description.trim().length > 0 ? r.description.trim() : humanizeCode(r.issue_type)
    items.push({
      key: `reconciliation:${r.id}`,
      headline: what,
      amount: r.amount_at_risk ?? null,
      owner: ownerForEntry(r.entry_id),
      ageDays: ageLabelDays(r.created_at),
      href: e?.department_id != null ? `/entries?department_id=${e.department_id}` : '/reports/integrity',
      category: 'reconciliation',
    })
  }

  // 3 -- budget-pace breaches ("as of today")
  for (const r of budgetRows) {
    if (r.pct_of_budget == null) continue
    const over = r.pct_of_budget >= 100
    items.push({
      key: `budget_pace:${r.department_id}`,
      headline: over
        ? `${r.department_name} is over its ${formatINRCompact(r.budget_amount)} budget — ${formatPercent(r.pct_of_budget)} spent (as of today)`
        : `${r.department_name} has spent ${formatPercent(r.pct_of_budget)} of its ${formatINRCompact(r.budget_amount)} budget (as of today)`,
      amount: r.actual_amount ?? null,
      owner: resolveOwner(r.department_id, null, deptNames, headNames),
      ageDays: null,
      href: `/entries?department_id=${r.department_id}`,
      category: 'budget_pace',
    })
  }

  // 4 -- above-median overpayment, aggregated per (vendor, item family)
  const overpaymentByPair = new Map<
    string,
    {
      vendorId: number | null
      vendorName: string | null
      familyLabel: string
      departmentId: number | null
      total: number
      lineCount: number
      latestObserved: string | null
    }
  >()
  for (const r of overpaymentRows) {
    const pairKey = `${r.vendor_id ?? 'null'}::${r.item_family_id}`
    const acc = overpaymentByPair.get(pairKey) ?? {
      vendorId: r.vendor_id,
      vendorName: r.vendor_display_name,
      familyLabel: r.family_label,
      departmentId: r.department_id,
      total: 0,
      lineCount: 0,
      latestObserved: null,
    }
    acc.total += r.overpayment_amount ?? 0
    acc.lineCount += 1
    if (r.department_id != null && acc.departmentId == null) acc.departmentId = r.department_id
    if (r.observed_date && (acc.latestObserved == null || r.observed_date > acc.latestObserved)) {
      acc.latestObserved = r.observed_date
    }
    overpaymentByPair.set(pairKey, acc)
  }
  for (const [pairKey, acc] of overpaymentByPair) {
    if (acc.total <= 0) continue
    const vendorName = acc.vendorName ?? 'An unnamed vendor'
    items.push({
      key: `overpayment:${pairKey}`,
      headline: `${vendorName} billed ${acc.familyLabel} above our own median rate on ${acc.lineCount} line${acc.lineCount === 1 ? '' : 's'} this week`,
      amount: round2Local(acc.total),
      owner:
        acc.departmentId != null
          ? resolveOwner(acc.departmentId, null, deptNames, headNames)
          : ownerForVendor(acc.vendorId),
      ageDays: ageLabelDays(acc.latestObserved),
      href: acc.vendorId != null ? `/entries?vendor_id=${acc.vendorId}` : '/reports/vendors',
      category: 'overpayment',
    })
  }

  // 5 -- rate drift, deduped per (vendor, item family) -- the view repeats the
  // series-level columns on every weekly row.
  const seenDriftPairs = new Set<string>()
  for (const r of rateDriftRows) {
    const pairKey = `${r.vendor_id ?? 'null'}::${r.item_family_id}`
    if (seenDriftPairs.has(pairKey)) continue
    seenDriftPairs.add(pairKey)
    if (r.drift_pct == null || r.drift_pct <= RATE_DRIFT_MIN_PCT) continue
    const perUnitDrift = r.last_week_median - r.first_week_median
    const estimate = perUnitDrift > 0 ? round2Local(perUnitDrift * r.series_observation_count) : null
    const vendorName = r.vendor_display_name ?? 'An unnamed vendor'
    items.push({
      key: `rate_drift:${pairKey}`,
      headline: `${vendorName}'s rate for ${r.family_label} has drifted +${formatPercent(r.drift_pct)} since the first week, now ${formatINR(r.last_week_median)} (estimated exposure)`,
      amount: estimate,
      owner: ownerForVendor(r.vendor_id),
      ageDays: ageLabelDays(r.last_week_start),
      href: r.vendor_id != null ? `/entries?vendor_id=${r.vendor_id}` : '/reports/vendors',
      category: 'rate_drift',
    })
  }

  // 6 -- new vendor, first bill this week
  for (const r of firstBillRows) {
    const vendorName = r.vendor_display_name ?? 'An unnamed vendor'
    items.push({
      key: `new_vendor:${r.vendor_id}`,
      headline: `${vendorName} billed us for the first time this event${r.opening_bill_is_largest ? ', and the opening invoice is already their largest' : ''}`,
      amount: r.first_entry_amount ?? null,
      owner: ownerForVendor(r.vendor_id),
      ageDays: ageLabelDays(r.first_entry_date),
      href: `/entries?vendor_id=${r.vendor_id}`,
      category: 'new_vendor',
    })
  }

  // ---- Merge, rank by rupees, cap at ten --------------------------------
  const ranked: WeeklyDigestItem[] = items
    .sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1))
    .slice(0, DIGEST_CAP)
    .map((it, i) => ({ ...it, rank: i + 1 }))

  return {
    eventName: eventRes.data?.name ?? null,
    items: ranked,
    errors: {
      compliance: complianceErr,
      reconciliation: reconciliationErr,
      budget: budgetErr,
      overpayment: overpaymentErr,
      rateDrift: rateDriftErr,
      newVendor: newVendorErr,
      owners: ownersErr,
    },
  }
}
