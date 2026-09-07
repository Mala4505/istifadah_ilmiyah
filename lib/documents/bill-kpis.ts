/**
 * Bill-level review KPIs for the /documents header (2026-09-07 request:
 * "show the user KPIs of the bills that are left to review and total etc").
 *
 * Plain module (no 'use server') that takes a caller-supplied, RLS-scoped
 * Supabase client -- same shape as lib/assignment/workload.ts -- so the
 * /documents RSC can call it directly.
 *
 * A "bill" is one `document_extraction` row (a scanned PDF can hold several
 * -- 20260817000002). The numbers here deliberately agree with the two
 * screens they summarise:
 *   * `toReview` is a head-count of `v_review_queue`, exactly how the
 *     dashboard's "Review queue depth" tile and /review's own header total
 *     count it (a bill stays in that view until all three Review stages are
 *     done -- 20260907000002).
 *   * `total` counts every bill for the selected event, in scope, whether its
 *     PDF is still in the inbox or already attached.
 *   * `reviewed = total - toReview`, so the three tiles always reconcile.
 *
 * Best-effort and defensively coded: any failed sub-query degrades its number
 * to 0 rather than throwing -- this is a header summary, not a critical path.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logRawError } from '@/lib/friendly-error'

export interface BillKpis {
  /** Every bill for the event, within scope. */
  total: number
  /** Bills that have cleared all three Review stages (`total - toReview`). */
  reviewed: number
  /** Bills still in `v_review_queue` -- not yet fully reviewed. */
  toReview: number
  /** Of `toReview`: extraction not verified yet (Review stage 1 outstanding). */
  unverified: number
  /** Of `toReview`: verified, but not yet connected to an entry and/or classified. */
  verifiedIncomplete: number
  /** Distinct PDFs still sitting in the inbox (match_status unmatched/suggested). */
  pdfsInInbox: number
  /** True when a scoping id list was supplied but empty -- caller has nothing assigned. */
  emptyScope: boolean
}

const ZERO: BillKpis = {
  total: 0,
  reviewed: 0,
  toReview: 0,
  unverified: 0,
  verifiedIncomplete: 0,
  pdfsInInbox: 0,
  emptyScope: false,
}

/**
 * @param scopeSourceDocIds
 *   `null`  -> no extra scoping; RLS is the whole gate (superadmin: the event;
 *             dept: the unmatched pool + department-matched docs).
 *   `number[]` -> restrict every count to these `source_document` ids (a
 *             regular admin: the documents assigned to them). An empty array
 *             short-circuits to all-zeros with `emptyScope: true`.
 */
export async function getBillKpis(
  supabase: SupabaseClient,
  {
    selectedEventId,
    scopeSourceDocIds,
  }: { selectedEventId: number | null; scopeSourceDocIds: number[] | null }
): Promise<BillKpis> {
  if (scopeSourceDocIds !== null && scopeSourceDocIds.length === 0) {
    return { ...ZERO, emptyScope: true }
  }

  try {
    // -- total bills for the event, in scope ---------------------------------
    // document_extraction has no event_id of its own -- it inherits the event
    // through its source_document, the same join /review's "all" count uses
    // (app/(app)/review/page.tsx).
    let totalQuery = supabase
      .from('document_extraction')
      .select('id, source_document!inner(event_id)', { count: 'exact', head: true })
    if (selectedEventId !== null) totalQuery = totalQuery.eq('source_document.event_id', selectedEventId)
    if (scopeSourceDocIds !== null) totalQuery = totalQuery.in('source_document_id', scopeSourceDocIds)

    // -- bills still needing review (matches dashboard + /review header) -----
    let queueQuery = supabase
      .from('v_review_queue')
      .select('document_extraction_id', { count: 'exact', head: true })
    if (selectedEventId !== null) queueQuery = queueQuery.eq('event_id', selectedEventId)
    if (scopeSourceDocIds !== null) queueQuery = queueQuery.in('source_document_id', scopeSourceDocIds)

    // -- of those: extraction not verified yet ------------------------------
    let unverifiedQuery = supabase
      .from('document_extraction')
      .select('id, source_document!inner(event_id)', { count: 'exact', head: true })
      .is('verified_at', null)
    if (selectedEventId !== null)
      unverifiedQuery = unverifiedQuery.eq('source_document.event_id', selectedEventId)
    if (scopeSourceDocIds !== null)
      unverifiedQuery = unverifiedQuery.in('source_document_id', scopeSourceDocIds)

    // -- distinct PDFs still in the inbox ----------------------------------
    let inboxQuery = supabase
      .from('source_document')
      .select('id', { count: 'exact', head: true })
      .in('match_status', ['unmatched', 'suggested'])
    if (selectedEventId !== null) inboxQuery = inboxQuery.eq('event_id', selectedEventId)
    if (scopeSourceDocIds !== null) inboxQuery = inboxQuery.in('id', scopeSourceDocIds)

    const [totalRes, queueRes, unverifiedRes, inboxRes] = await Promise.all([
      totalQuery,
      queueQuery,
      unverifiedQuery,
      inboxQuery,
    ])

    for (const [label, res] of [
      ['total', totalRes],
      ['queue', queueRes],
      ['unverified', unverifiedRes],
      ['inbox', inboxRes],
    ] as const) {
      if (res.error) logRawError(`documents.getBillKpis:${label}`, res.error.message)
    }

    const total = totalRes.count ?? 0
    const toReview = queueRes.count ?? 0
    const unverified = Math.min(unverifiedRes.count ?? 0, toReview)

    return {
      total,
      toReview,
      reviewed: Math.max(0, total - toReview),
      unverified,
      verifiedIncomplete: Math.max(0, toReview - unverified),
      pdfsInInbox: inboxRes.count ?? 0,
      emptyScope: false,
    }
  } catch (err) {
    logRawError('documents.getBillKpis', err instanceof Error ? err.message : String(err))
    return ZERO
  }
}
