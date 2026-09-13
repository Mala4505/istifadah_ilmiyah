/**
 * Data loader for reporting-blueprint.md §3 Family A: A-04 administrative head
 * accountability ("Spend, entry volume and budget adherence per named head.
 * The dimension exists and is currently almost unreported — yet it is the one
 * that attaches a number to a person.").
 *
 * Its own surface file (§8 Phase Three's "one loader per surface"), strictly
 * additive — no shared file is touched. The row shape lives here for now; the
 * parent hoists it into lib/reports/sections/shared.tsx during integration.
 *
 * ── Why there's no "budget adherence" here anymore ──────────────────────
 * v_admin_head_spend gives spend / entry_count / document_coverage_pct per
 * (admin_head, event) — it carries no budget figure of its own, and the
 * schema has no way to give it one (budget_allocation is keyed to
 * budget_head, department_budget_allocation to department; there's no FK
 * from admin_head to either). Earlier this surface borrowed the head's
 * *owning department's* budget position as adjacent context — until
 * 20260913000001_admin_head_zone_drop_department.sql removed admin_head's
 * department_id entirely (it was seeded under department_id=1 'Venue Setup'
 * for every row, so that "department" was never a meaningful attribution to
 * begin with — see that migration's header for the full reasoning). So this
 * surface is now honestly just what it can measure directly: spend, entry
 * volume, and document coverage per head, ranked, with no borrowed
 * department framing.
 *
 * share_of_event_pct is computed here: the head's spend over the sum of all
 * heads' spend this event (entries with no admin_head_id are excluded from
 * both sides, so shares sum to 100% across the rows shown).
 *
 * Prior-period comparison (§6 fix #1): 'prior_event' resolves the previous
 * event once and re-sums v_admin_head_spend against it for the one headline
 * delta (spend through named heads). 'prior_week' has no effect — none of
 * these three aggregates carry an as-of dimension a week-old snapshot could
 * be re-derived from (same reasoning lib/reports/surfaces/budget.ts documents).
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { ROW_CAP, round2Local } from '@/lib/reports/sections/shared'
import { resolvePreviousEvent } from '@/lib/reports/sections/resolve-previous-event'

/** Raw projection of v_admin_head_spend for one (admin_head, event). */
export type AdminHeadSpendRow = {
  admin_head_id: number
  admin_head_name: string
  event_id: number | null
  entry_count: number
  total_amount: number | null
  entries_with_documents: number
  document_coverage_pct: number | null
}

/**
 * A-04 presentation row: one named administrative head this event
 * (camelCase because this is an app-side composed shape, not a 1:1 view
 * projection — same convention as VendorCluster in shared.tsx).
 */
export type AdminHeadAccountabilityRow = {
  adminHeadId: number
  adminHeadName: string
  entryCount: number
  totalAmount: number
  entriesWithDocuments: number
  documentCoveragePct: number | null
  /** total_amount / sum of all heads' spend this event, 0–100. */
  shareOfEventPct: number
}

export type AdminHeadAccountabilitySurfaceData = {
  eventName: string | null
  previousEventName: string | null
  accountability: {
    rows: AdminHeadAccountabilityRow[]
    error: string | null
    /** Sum of totalAmount across the rows — the KPI headline figure. */
    spendThroughHeads: number
    previousSpendTotal: number | null
    insight: string | null
  }
}

/** Mirrors admin-head-accountability.tsx's adminHeadAccountabilitySentence. */
function adminHeadAccountabilityInsight(rows: AdminHeadAccountabilityRow[]): string | null {
  if (rows.length === 0) return null
  const total = rows.reduce((sum, r) => sum + r.totalAmount, 0)
  const lead = [...rows].sort((a, b) => b.totalAmount - a.totalAmount)[0]!
  return `${formatNumber(rows.length)} administrative head${rows.length === 1 ? '' : 's'} account for ${formatINRCompact(
    total
  )} this event — led by ${lead.adminHeadName} at ${formatINRCompact(lead.totalAmount)} (${formatPercent(
    lead.shareOfEventPct
  )} of the total).`
}

const SPEND_SELECT =
  'admin_head_id, admin_head_name, event_id, entry_count, total_amount, entries_with_documents, document_coverage_pct'

export async function loadAdminHeadAccountability(
  compareBasis: CompareBasis
): Promise<AdminHeadAccountabilitySurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  const eventId = selectedEvent?.id ?? null

  const spendRes = await supabase
    .from('v_admin_head_spend')
    .select(SPEND_SELECT)
    .eq('event_id', eventId)
    .order('total_amount', { ascending: false, nullsFirst: false })
    .limit(ROW_CAP)
    .returns<AdminHeadSpendRow[]>()

  const spendRows = spendRes.data ?? []
  const eventTotal = spendRows.reduce((sum, r) => sum + (r.total_amount ?? 0), 0)

  const rows: AdminHeadAccountabilityRow[] = spendRows.map((r) => {
    const totalAmount = r.total_amount ?? 0
    return {
      adminHeadId: r.admin_head_id,
      adminHeadName: r.admin_head_name,
      entryCount: r.entry_count,
      totalAmount,
      entriesWithDocuments: r.entries_with_documents,
      documentCoveragePct: r.document_coverage_pct,
      shareOfEventPct: eventTotal > 0 ? round2Local((totalAmount / eventTotal) * 100) : 0,
    }
  })

  const error = friendlyDataError(spendRes.error, 'reports:admin-head:spend')

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousSpendTotal: number | null = null
  if (previousEvent) {
    const pSpend = await supabase
      .from('v_admin_head_spend')
      .select('total_amount')
      .eq('event_id', previousEvent.id)
      .returns<{ total_amount: number | null }[]>()
    previousSpendTotal = (pSpend.data ?? []).reduce((sum, r) => sum + (r.total_amount ?? 0), 0)
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    accountability: {
      rows,
      error,
      spendThroughHeads: eventTotal,
      previousSpendTotal,
      insight: adminHeadAccountabilityInsight(rows),
    },
  }
}
