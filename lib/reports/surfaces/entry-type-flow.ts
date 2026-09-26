/**
 * Data loader for reporting-blueprint.md §8 Phase Six, Budget & Spend cluster:
 * A-08 entry-type split by department, A-09 outstanding-advance ageing, A-10
 * reimbursement profile. Queries the four views in
 * 20260903000014_entry_type_flow_views.sql.
 *
 * Its own surface file (not folded into lib/reports/surfaces/budget.ts) so a
 * slow query on one Phase Six section doesn't block the rest of the Budget &
 * Spend page -- the same "one loader per surface" reasoning §8 Phase Three
 * gives -- and so this session stays strictly additive.
 *
 * Every view exposes `event_id` as a plain output column; filtering happens
 * here. Prior-period comparison (§6 fix #1): 'prior_event' resolves the
 * previous event once and re-queries the aggregate views against it for the
 * single headline delta each section shows. 'prior_week' has no effect --
 * none of these views carry an as-of dimension a week-old snapshot could be
 * re-derived from (v_outstanding_advance_ageing recomputes days_outstanding
 * from current_date on every read).
 *
 * Row types are declared here (not in lib/reports/sections/shared.tsx) for
 * now, per this session's additive-only remit; the parent hoists them into
 * shared.tsx during integration. Sections import them from this file.
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import { formatINRCompact, formatNumber, formatPercent, humanizeCode } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { ROW_CAP } from '@/lib/reports/sections/shared'
import { resolvePreviousEvent } from '@/lib/reports/sections/resolve-previous-event'

// ---------------------------------------------------------------------------
// Row shapes -- field names match each view's SELECT list verbatim so the
// `.select(...)` strings below port straight across.
// ---------------------------------------------------------------------------

/** A-08 -- one row per (department, entry type, event) from
 *  v_entry_type_by_department. department_* are null for the no-department
 *  bucket. `type` is the raw entries.type code. */
export type EntryTypeByDepartmentRow = {
  department_id: number | null
  department_name: string | null
  type: string
  type_label: string
  entry_count: number
  total_amount: number
  event_id: number | null
}

export type AdvanceAgeBucket = '0-30' | '31-60' | '61-90' | '90+'

/** A-09 -- one row per outstanding advance entry from
 *  v_outstanding_advance_ageing. `age_bucket` / `days_outstanding` are null
 *  when the advance has no date. */
export type OutstandingAdvanceAgeingRow = {
  entry_id: number
  department_id: number | null
  department_name: string | null
  admin_head_id: number | null
  admin_head_name: string | null
  vendor_id: number | null
  vendor_display_name: string | null
  advance_amount: number | null
  advance_date: string | null
  days_outstanding: number | null
  age_bucket: AdvanceAgeBucket | null
  invoice_amount: number | null
  event_id: number | null
}

/** One row per (vendor, department, event) from v_vendor_advance_position --
 *  see that view's own header (20260926000005) for why this is a live sum,
 *  not a link table. `settlement_count === 0` means every advance for this
 *  vendor is still awaiting its final invoice (balance_owed reads 0 in that
 *  case, not "fully paid" -- the section component must say so explicitly). */
export type VendorAdvancePositionRow = {
  event_id: number | null
  department_id: number | null
  department_name: string | null
  vendor_key: string
  vendor_id: number | null
  vendor_display_name: string
  advance_given: number
  advance_count: number
  settled_invoice_total: number
  balance_owed: number
  settlement_count: number
}

/** A-10 -- one row per (reimbursee, event) from v_reimbursement_profile.
 *  `department_id` is the reimbursee's modal department for the event. */
export type ReimbursementProfileRow = {
  reimbursee_key: string
  reimbursee_name: string
  reimburse_to_vendor_id: number | null
  department_id: number | null
  department_name: string | null
  entry_count: number
  total_amount: number
  first_date: string | null
  last_date: string | null
  event_id: number | null
}

/** A-10 companion -- one row per (reimbursement_type, event) from
 *  v_reimbursement_by_type, across every reimbursee. */
export type ReimbursementByTypeRow = {
  event_id: number | null
  reimbursement_type: string
  entry_count: number
  total_amount: number
}

// ---------------------------------------------------------------------------
// Shared thresholds + pure helpers (server-only -- used by the section
// components, never imported by the 'use client' charts).
// ---------------------------------------------------------------------------

/** Reimbursement share of total spend at or above which A-08 treats the mix
 *  as a control signal and colours the KPI + chart segment as a warning
 *  (blueprint: "a high reimbursement share is a control signal"). A judgment
 *  call, not a regulated figure -- kept here rather than in
 *  lib/analytics/thresholds.ts because that file is off-limits this session;
 *  parent may promote it during integration. */
export const REIMBURSEMENT_SHARE_HIGH_PCT = 15

export type EntryTypeShare = {
  totalSpend: number
  reimbursementSpend: number
  reimbursementSharePct: number
}

/** Reimbursement ₹ as a share of all-types ₹ for the current event's rows. */
export function reimbursementShare(rows: EntryTypeByDepartmentRow[]): EntryTypeShare {
  const totalSpend = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  const reimbursementSpend = rows
    .filter((r) => r.type === 'reimbursement')
    .reduce((s, r) => s + (r.total_amount ?? 0), 0)
  const reimbursementSharePct = totalSpend > 0 ? (reimbursementSpend / totalSpend) * 100 : 0
  return { totalSpend, reimbursementSpend, reimbursementSharePct }
}

/** The department with the highest reimbursement share of its own spend
 *  (min 2 entries of reimbursement so a single one-off doesn't top the list),
 *  or null when no department has any reimbursement. */
export function topReimbursementDepartment(rows: EntryTypeByDepartmentRow[]): {
  departmentId: number | null
  departmentName: string
  sharePct: number
  reimbursementSpend: number
} | null {
  const byDept = new Map<
    string,
    { departmentId: number | null; departmentName: string; total: number; reimb: number; reimbCount: number }
  >()
  for (const r of rows) {
    const key = r.department_id == null ? 'null' : String(r.department_id)
    const entry =
      byDept.get(key) ??
      {
        departmentId: r.department_id,
        departmentName: r.department_name ?? 'No department',
        total: 0,
        reimb: 0,
        reimbCount: 0,
      }
    entry.total += r.total_amount ?? 0
    if (r.type === 'reimbursement') {
      entry.reimb += r.total_amount ?? 0
      entry.reimbCount += r.entry_count
    }
    byDept.set(key, entry)
  }
  let best: { departmentId: number | null; departmentName: string; sharePct: number; reimbursementSpend: number } | null =
    null
  for (const d of byDept.values()) {
    if (d.reimbCount < 2 || d.total <= 0) continue
    const sharePct = (d.reimb / d.total) * 100
    if (!best || sharePct > best.sharePct) {
      best = { departmentId: d.departmentId, departmentName: d.departmentName, sharePct, reimbursementSpend: d.reimb }
    }
  }
  return best
}

// ---------------------------------------------------------------------------

const ENTRY_TYPE_SELECT = 'department_id, department_name, type, type_label, entry_count, total_amount'
const ADVANCE_SELECT =
  'entry_id, department_id, department_name, admin_head_id, admin_head_name, vendor_id, vendor_display_name, advance_amount, advance_date, days_outstanding, age_bucket, invoice_amount'
const REIMBURSEMENT_SELECT =
  'reimbursee_key, reimbursee_name, reimburse_to_vendor_id, department_id, department_name, entry_count, total_amount, first_date, last_date'
const REIMBURSEMENT_TYPE_SELECT = 'reimbursement_type, entry_count, total_amount'
const VENDOR_ADVANCE_POSITION_SELECT =
  'department_id, department_name, vendor_key, vendor_id, vendor_display_name, advance_given, advance_count, settled_invoice_total, balance_owed, settlement_count'

export type EntryTypeFlowSurfaceData = {
  eventName: string | null
  previousEventName: string | null
  entryTypeSplit: {
    rows: EntryTypeByDepartmentRow[]
    error: string | null
    previousReimbursementSharePct: number | null
    insight: string | null
  }
  outstandingAdvanceAgeing: {
    rows: OutstandingAdvanceAgeingRow[]
    error: string | null
    previousOutstandingCount: number | null
    previousOutstandingAmount: number | null
    insight: string | null
  }
  reimbursementProfile: {
    rows: ReimbursementProfileRow[]
    byType: ReimbursementByTypeRow[]
    error: string | null
    byTypeError: string | null
    previousTotalReimbursed: number | null
    previousReimburseeCount: number | null
    insight: string | null
  }
  vendorAdvancePosition: {
    rows: VendorAdvancePositionRow[]
    error: string | null
    insight: string | null
  }
}

/** Mirrors entry-type-split.tsx's entryTypeSplitSentence. */
function entryTypeSplitInsight(rows: EntryTypeByDepartmentRow[]): string | null {
  if (rows.length === 0) return null
  const share = reimbursementShare(rows)
  const top = topReimbursementDepartment(rows)
  if (!top) {
    return `Reimbursements are ${formatPercent(share.reimbursementSharePct)} of ${formatINRCompact(
      share.totalSpend
    )} total spend this event — no department leans on them materially.`
  }
  return `Reimbursements are ${formatPercent(share.reimbursementSharePct)} of ${formatINRCompact(
    share.totalSpend
  )} total spend this event; ${top.departmentName} leans on them most at ${formatPercent(
    top.sharePct
  )} of its own spend (${formatINRCompact(top.reimbursementSpend)}).`
}

/** Mirrors outstanding-advance-ageing.tsx's outstandingAdvanceSentence. */
function outstandingAdvanceInsight(rows: OutstandingAdvanceAgeingRow[]): string | null {
  if (rows.length === 0) return null
  const total = rows.reduce((s, r) => s + (r.advance_amount ?? 0), 0)
  const over90 = rows.filter((r) => r.age_bucket === '90+').reduce((s, r) => s + (r.advance_amount ?? 0), 0)
  const oldest = [...rows].sort((a, b) => (b.days_outstanding ?? -1) - (a.days_outstanding ?? -1))[0]!
  const owner =
    oldest.admin_head_name ?? oldest.department_name ?? oldest.vendor_display_name ?? 'an unassigned advance'
  return `${formatINRCompact(total)} across ${formatNumber(rows.length)} advance${
    rows.length === 1 ? '' : 's'
  } is unsettled this event, ${formatINRCompact(over90)} of it over 90 days — the oldest sits ${formatNumber(
    oldest.days_outstanding ?? 0
  )} days out, owned by ${owner}.`
}

/** Mirrors reimbursement-profile.tsx's reimbursementProfileSentence. */
function reimbursementProfileInsight(
  rows: ReimbursementProfileRow[],
  byType: ReimbursementByTypeRow[]
): string | null {
  if (rows.length === 0) return null
  const total = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  const lead = [...rows].sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))[0]!
  const topType = [...byType].sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))[0]
  const typeBit = topType
    ? ` — ${humanizeCode(topType.reimbursement_type)} is the dominant type at ${formatINRCompact(topType.total_amount)}`
    : ''
  return `${formatNumber(rows.length)} reimbursee${rows.length === 1 ? '' : 's'} drew ${formatINRCompact(
    total
  )} this event; ${lead.reimbursee_name} is the largest at ${formatINRCompact(lead.total_amount)}${typeBit}.`
}

/** "₹X given as advances to N vendors, ₹Y of it still owed once finalised
 *  (settled with M vendors); Z vendors have no finalised invoice at all yet."
 *  Summed straight off the view -- no per-row linking involved (see the
 *  view's own header for why). */
function vendorAdvancePositionInsight(rows: VendorAdvancePositionRow[]): string | null {
  if (rows.length === 0) return null
  const totalGiven = rows.reduce((s, r) => s + r.advance_given, 0)
  const totalOwed = rows.reduce((s, r) => s + r.balance_owed, 0)
  const awaitingCount = rows.filter((r) => r.advance_count > 0 && r.settlement_count === 0).length
  const vendorCount = rows.filter((r) => r.advance_count > 0).length
  if (vendorCount === 0) return null
  const awaitingBit =
    awaitingCount > 0
      ? `, ${formatNumber(awaitingCount)} vendor${awaitingCount === 1 ? '' : 's'} with no finalised invoice yet`
      : ''
  return `${formatINRCompact(totalGiven)} given as advances across ${formatNumber(
    vendorCount
  )} vendor${vendorCount === 1 ? '' : 's'}; ${formatINRCompact(totalOwed)} still owed on finalised invoices${awaitingBit}.`
}

export async function loadEntryTypeFlow(compareBasis: CompareBasis): Promise<EntryTypeFlowSurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  const eventId = selectedEvent?.id ?? null

  const [splitRes, advanceRes, reimbRes, reimbTypeRes, vendorPositionRes] = await Promise.all([
    supabase
      .from('v_entry_type_by_department')
      .select(ENTRY_TYPE_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<EntryTypeByDepartmentRow[]>(),
    supabase
      .from('v_outstanding_advance_ageing')
      .select(ADVANCE_SELECT)
      .eq('event_id', eventId)
      .order('days_outstanding', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<OutstandingAdvanceAgeingRow[]>(),
    supabase
      .from('v_reimbursement_profile')
      .select(REIMBURSEMENT_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<ReimbursementProfileRow[]>(),
    supabase
      .from('v_reimbursement_by_type')
      .select(REIMBURSEMENT_TYPE_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<ReimbursementByTypeRow[]>(),
    supabase
      .from('v_vendor_advance_position')
      .select(VENDOR_ADVANCE_POSITION_SELECT)
      .eq('event_id', eventId)
      .order('advance_given', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<VendorAdvancePositionRow[]>(),
  ])

  const splitRows = splitRes.data ?? []
  const advanceRows = advanceRes.data ?? []
  const reimbRows = reimbRes.data ?? []
  const reimbTypeRows = reimbTypeRes.data ?? []
  const vendorPositionRows = vendorPositionRes.data ?? []

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousReimbursementSharePct: number | null = null
  let previousOutstandingCount: number | null = null
  let previousOutstandingAmount: number | null = null
  let previousTotalReimbursed: number | null = null
  let previousReimburseeCount: number | null = null

  if (previousEvent) {
    const [pSplit, pAdvance, pReimb] = await Promise.all([
      supabase
        .from('v_entry_type_by_department')
        .select('type, total_amount')
        .eq('event_id', previousEvent.id)
        .returns<{ type: string; total_amount: number }[]>(),
      supabase
        .from('v_outstanding_advance_ageing')
        .select('advance_amount')
        .eq('event_id', previousEvent.id)
        .returns<{ advance_amount: number | null }[]>(),
      supabase
        .from('v_reimbursement_profile')
        .select('total_amount')
        .eq('event_id', previousEvent.id)
        .returns<{ total_amount: number }[]>(),
    ])
    const pSplitRows = pSplit.data ?? []
    if (pSplitRows.length > 0) {
      const total = pSplitRows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
      const reimb = pSplitRows.filter((r) => r.type === 'reimbursement').reduce((s, r) => s + (r.total_amount ?? 0), 0)
      previousReimbursementSharePct = total > 0 ? (reimb / total) * 100 : 0
    }
    const pAdvanceRows = pAdvance.data ?? []
    previousOutstandingCount = pAdvanceRows.length
    previousOutstandingAmount = pAdvanceRows.reduce((s, r) => s + (r.advance_amount ?? 0), 0)
    const pReimbRows = pReimb.data ?? []
    previousReimburseeCount = pReimbRows.length
    previousTotalReimbursed = pReimbRows.reduce((s, r) => s + (r.total_amount ?? 0), 0)
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    entryTypeSplit: {
      rows: splitRows,
      error: friendlyDataError(splitRes.error, 'reports:budget:entry-type-split'),
      previousReimbursementSharePct,
      insight: entryTypeSplitInsight(splitRows),
    },
    outstandingAdvanceAgeing: {
      rows: advanceRows,
      error: friendlyDataError(advanceRes.error, 'reports:budget:outstanding-advance-ageing'),
      previousOutstandingCount,
      previousOutstandingAmount,
      insight: outstandingAdvanceInsight(advanceRows),
    },
    reimbursementProfile: {
      rows: reimbRows,
      byType: reimbTypeRows,
      error: friendlyDataError(reimbRes.error, 'reports:budget:reimbursement-profile'),
      byTypeError: friendlyDataError(reimbTypeRes.error, 'reports:budget:reimbursement-by-type'),
      previousTotalReimbursed,
      previousReimburseeCount,
      insight: reimbursementProfileInsight(reimbRows, reimbTypeRows),
    },
    vendorAdvancePosition: {
      rows: vendorPositionRows,
      error: friendlyDataError(vendorPositionRes.error, 'reports:budget:vendor-advance-position'),
      insight: vendorAdvancePositionInsight(vendorPositionRows),
    },
  }
}
