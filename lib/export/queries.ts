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

/**
 * Everything with `hub_status_exported_at is null and hub_status_id <> 1`
 * (§3.4's `entries_pending_export_idx`), read from `v_entry_enriched` for
 * display-ready department/status labels. Voided entries excluded — same
 * judgement call as the generator.
 *
 * Phase 6 Step 2 (docs/event-scoping-and-review-fixes-plan.md §1): scoped to
 * the selected event. `v_entry_enriched` itself is out of this stream's
 * ownership and doesn't expose `event_id` (Stream A/B territory) — rather
 * than touch it, the qualifying entry ids are resolved directly against
 * `entries.event_id` first, then that id set filters the existing
 * `v_entry_enriched` read. At this app's volumes (doc §0: 14 entries) a
 * two-step read costs nothing and keeps this stream's file ownership clean.
 */
export async function getPendingExportQueue(): Promise<PendingExportEntry[]> {
  const supabase = createAdminClient()
  const eventId = await getSelectedEventId(supabase)

  let idQuery = supabase
    .from('entries')
    .select('id')
    .is('hub_status_exported_at', null)
    .neq('hub_status_id', 1)
    .eq('is_void', false)
  if (eventId !== null) {
    idQuery = idQuery.eq('event_id', eventId)
  }
  const { data: idRows, error: idError } = await idQuery
  if (idError) {
    throw new Error(`getPendingExportQueue: ${idError.message}`)
  }
  const ids = (idRows ?? []).map((row) => row.id as number)
  if (ids.length === 0) return []

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
  return (data ?? []) as PendingExportEntry[]
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
  const eventId = await getSelectedEventId(supabase)

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
