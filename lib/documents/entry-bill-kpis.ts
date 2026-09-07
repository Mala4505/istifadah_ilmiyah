/**
 * Entry-side "waiting on a bill" KPIs for the /entries header (operator
 * request, 2026-09-07). The mirror image of lib/documents/bill-kpis.ts: that
 * one answers "how many scanned bills are still to review"; this one answers
 * "how many entries are still waiting for a bill at all".
 *
 * Plain module (no 'use server') taking a caller-supplied, RLS-scoped Supabase
 * client, so the /entries RSC can call it directly -- same shape as
 * getBillKpis. Reads `v_entry_enriched` (security_invoker -> the viewer's
 * department scoping from entries_select applies), the same view the list
 * itself pages through, so the tile numbers and the "Has document" /
 * "Awaiting bill" filters can never disagree.
 *
 * A row counts as "has a bill" when `document_count > 0` -- i.e. at least one
 * `source_document` is linked to the entry, whether directly
 * (source_document.entry_id) or via one of its bills
 * (document_extraction.entry_id). Void entries are excluded from every count.
 *
 * Best-effort and defensively coded: any failed sub-query degrades to 0 rather
 * than throwing -- this is a header summary, not a critical path.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logRawError } from '@/lib/friendly-error'

export interface EntryBillKpis {
  /** Every non-void entry for the selected event, within RLS scope. */
  total: number
  /** Of `total`: at least one linked document (`document_count > 0`). */
  withDocument: number
  /** Of `total`: no linked document yet (`total - withDocument`). */
  awaitingDocument: number
}

const ZERO: EntryBillKpis = { total: 0, withDocument: 0, awaitingDocument: 0 }

export async function getEntryBillKpis(
  supabase: SupabaseClient,
  { selectedEventId }: { selectedEventId: number | null }
): Promise<EntryBillKpis> {
  try {
    const base = () => {
      let q = supabase
        .from('v_entry_enriched')
        .select('id', { count: 'exact', head: true })
        .eq('is_void', false)
      if (selectedEventId !== null) q = q.eq('event_id', selectedEventId)
      return q
    }

    const [totalRes, withDocRes] = await Promise.all([base(), base().gt('document_count', 0)])

    for (const [label, res] of [
      ['total', totalRes],
      ['withDocument', withDocRes],
    ] as const) {
      if (res.error) logRawError(`entries.getEntryBillKpis:${label}`, res.error.message)
    }

    const total = totalRes.count ?? 0
    const withDocument = Math.min(withDocRes.count ?? 0, total)

    return { total, withDocument, awaitingDocument: Math.max(0, total - withDocument) }
  } catch (err) {
    logRawError('entries.getEntryBillKpis', err instanceof Error ? err.message : String(err))
    return ZERO
  }
}
