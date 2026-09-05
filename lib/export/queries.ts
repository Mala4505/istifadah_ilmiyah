/**
 * Read-side queries for the /export screen (MASTER-PLAN §3.7, §5 row 11).
 *
 * Uses the admin client throughout, same reasoning as generate-status-batch.ts:
 * the pending queue and batch history are inherently cross-department (an
 * admin reviewing what is about to leave the building needs to see all of
 * it, not just their own department slice), and the page/route calling
 * these already gates on admin role via `lib/export/auth.ts` before this
 * runs.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { getSelectedEventId } from '@/lib/events/current'

// ---------------------------------------------------------------------------
// Pending queue — entries with a Hub status not yet pushed out.
// ---------------------------------------------------------------------------

export interface PendingExportEntry {
  id: number
  ubbl_number: string
  main_number: string | null
  department_name: string | null
  hub_status_code: string | null
  hub_status_label: string | null
  hub_status_changed_at: string | null
  hub_status_note: string | null
  amount: number | null
}

export interface PendingExportQueueResult {
  entries: PendingExportEntry[]
  /** True count of everything pending, independent of `entries.length` — a
   *  truncated display must not understate what `generateStatusExportBatch`
   *  will actually pick up, since that generator re-queries uncapped. */
  totalPendingCount: number
  truncated: boolean
}

/**
 * Perf remediation 4.4 (docs/performance-remediation-plan.md): this was the
 * one genuinely unbounded query on /export — neither the id lookup nor the
 * `v_entry_enriched` read carried a `.limit()`/`.range()`. 1000 mirrors
 * `ROW_CAP` (`lib/reports/sections/shared.tsx`) — the same "how many rows
 * can an admin screen usefully render" judgment the reports surfaces already
 * standardised on — rather than inventing a different number for this
 * screen; it's also comfortably above every volume mentioned elsewhere in
 * this file's own comments (14 entries at last note).
 *
 * Ordered oldest-changed-first (`hub_status_changed_at asc nulls first`, same
 * order `generateStatusExportBatch` uses) so that IF the queue ever exceeds
 * the cap, the entries shown are the ones that have been waiting longest —
 * the ones an admin most needs to act on — rather than an arbitrary slice.
 * The true total is fetched separately (uncapped `count: 'exact', head: true`
 * on the same filter) and returned alongside `truncated`, so a caller can
 * tell an admin "there are more than you can see" instead of silently
 * showing a partial queue as if it were the whole one. Actually generating a
 * batch is unaffected either way — `generateStatusExportBatch` runs its own
 * uncapped query, independent of this read-only display path.
 */
export async function getPendingExportQueue(): Promise<PendingExportQueueResult> {
  const EXPORT_QUEUE_ROW_CAP = 1000
  const supabase = createAdminClient()
  const eventId = await getSelectedEventId()

  let idQuery = supabase
    .from('entries')
    .select('id')
    .is('hub_status_exported_at', null)
    .neq('hub_status_id', 1)
    .eq('is_void', false)
  if (eventId !== null) {
    idQuery = idQuery.eq('event_id', eventId)
  }
  // Fetch one row past the cap so truncation can be detected without a
  // separate round trip, matching the pattern app/(app)/documents/page.tsx
  // already uses for its own DOCUMENT_QUERY_CAP.
  idQuery = idQuery
    .order('hub_status_changed_at', { ascending: true, nullsFirst: true })
    .range(0, EXPORT_QUEUE_ROW_CAP)

  let countQuery = supabase
    .from('entries')
    .select('id', { count: 'exact', head: true })
    .is('hub_status_exported_at', null)
    .neq('hub_status_id', 1)
    .eq('is_void', false)
  if (eventId !== null) {
    countQuery = countQuery.eq('event_id', eventId)
  }

  const [{ data: idRows, error: idError }, { count: totalPendingCount, error: countError }] = await Promise.all([
    idQuery,
    countQuery,
  ])
  if (idError) {
    throw new Error(`getPendingExportQueue: ${idError.message}`)
  }
  if (countError) {
    throw new Error(`getPendingExportQueue: ${countError.message}`)
  }

  const fetchedIds = (idRows ?? []).map((row) => row.id as number)
  const truncated = fetchedIds.length > EXPORT_QUEUE_ROW_CAP
  const ids = truncated ? fetchedIds.slice(0, EXPORT_QUEUE_ROW_CAP) : fetchedIds
  if (ids.length === 0) {
    return { entries: [], totalPendingCount: totalPendingCount ?? 0, truncated: false }
  }

  const { data, error } = await supabase
    .from('v_entry_enriched')
    .select(
      'id, ubbl_number, main_number, department_name, hub_status_code, hub_status_label, hub_status_changed_at, hub_status_note, amount, hub_status_id, hub_status_exported_at, is_void'
    )
    .in('id', ids)
    .order('hub_status_changed_at', { ascending: true, nullsFirst: true })

  if (error) {
    throw new Error(`getPendingExportQueue: ${error.message}`)
  }
  return {
    entries: (data ?? []) as PendingExportEntry[],
    totalPendingCount: totalPendingCount ?? 0,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Batch history — immutable once generated (§3.7).
// ---------------------------------------------------------------------------

export interface ExportBatchSummary {
  id: number
  target_system: string
  format: string
  row_count: number
  storage_path: string | null
  file_hash_sha256: string | null
  status: string
  delivered_at: string | null
  acknowledged_at: string | null
  acknowledged_note: string | null
  generated_by: string | null
  created_at: string
  error_message: string | null
}

/**
 * Phase 6 Step 2: scoped to the selected event -- `status_export_batch` is
 * stamped with `event_id` at generation time (see generate-status-batch.ts),
 * so batch history for a past event stays that event's own record rather
 * than mixing years together.
 */
export async function getExportBatchHistory(): Promise<ExportBatchSummary[]> {
  const supabase = createAdminClient()
  const eventId = await getSelectedEventId()

  let query = supabase
    .from('status_export_batch')
    .select(
      'id, target_system, format, row_count, storage_path, file_hash_sha256, status, delivered_at, acknowledged_at, acknowledged_note, generated_by, created_at, error_message'
    )
    .order('created_at', { ascending: false })
  if (eventId !== null) {
    query = query.eq('event_id', eventId)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`getExportBatchHistory: ${error.message}`)
  }
  return (data ?? []) as ExportBatchSummary[]
}

// ---------------------------------------------------------------------------
// Per-row detail — the drill-in (§5 row 11: "batch history with per-row detail").
// ---------------------------------------------------------------------------

export interface ExportBatchRow {
  id: number
  entry_id: number
  ubbl_number: string
  main_number: string | null
  hub_status_code: string
  hub_status_note: string | null
  changed_at: string
  changed_by: string | null
}

export async function getExportBatchRows(batchId: number): Promise<ExportBatchRow[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('status_export_row')
    .select('id, entry_id, ubbl_number, main_number, hub_status_code, hub_status_note, changed_at, changed_by')
    .eq('status_export_batch_id', batchId)
    .order('ubbl_number', { ascending: true })

  if (error) {
    throw new Error(`getExportBatchRows: ${error.message}`)
  }
  return (data ?? []) as ExportBatchRow[]
}
