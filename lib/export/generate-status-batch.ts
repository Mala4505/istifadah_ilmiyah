/**
 * Status export generation — the outward path (MASTER-PLAN §3.7, §11.1 Day 5).
 *
 * `generateStatusExportBatch` is the one place the two Hub-owned statuses
 * (`awaiting_verification` / `awaiting_validation`) leave the building. It
 * runs as a *sequence* of admin-client calls, not a single Postgres
 * transaction — supabase-js/PostgREST has no multi-statement transaction
 * primitive without a stored procedure, and §3.7 itself says "in one
 * transaction/sequence", so a carefully-ordered sequence with a fail-fast
 * pure phase before any DB write, plus a `status = 'failed'` marker on the
 * batch if a later step breaks, is the pragmatic week-1 shape. Ordered so
 * that the riskiest/slowest step (building the .xlsx) happens BEFORE any
 * row is written, and so that a failure after the batch row exists is
 * always recorded on that row rather than silently lost.
 *
 * Uses the admin (service-role) client throughout, per the task brief:
 * this is a cross-department operation by design (§3.7), and the
 * authorization check ("admin-only", §4.4c) is the caller's
 * responsibility — see `lib/export/auth.ts` — not re-checked here.
 */

import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { createAdminClient } from '@/lib/supabase/admin'
import { putDocument, getSignedUrl } from '@/lib/storage'
import { hubStatusToExportRow, type HubStatusEntry } from '@/lib/module-mapping'

export type ExportTargetSystem = 'departmental' | 'main' | 'both'
export type ExportBatchStatus = 'generated' | 'delivered' | 'acknowledged' | 'failed'

const EXPORT_STORAGE_PREFIX = 'status-exports'

// ---------------------------------------------------------------------------
// generateStatusExportBatch
// ---------------------------------------------------------------------------

export interface GenerateStatusBatchInput {
  targetSystem: ExportTargetSystem
  /** auth.uid() of the admin who triggered generation; null if unattributed. */
  generatedBy: string | null
}

export interface GeneratedBatchSummary {
  batchId: number
  targetSystem: ExportTargetSystem
  rowCount: number
  storagePath: string
  fileHashSha256: string
}

export type GenerateStatusBatchOutcome =
  | { ok: true; batch: GeneratedBatchSummary }
  | { ok: true; batch: null; reason: 'nothing_pending' }
  | { ok: false; error: string }

interface PendingEntryRow {
  id: number
  ubbl_number: string
  main_number: string | null
  hub_status_id: number
  hub_status_note: string | null
  hub_status_changed_at: string | null
  hub_status_changed_by: string | null
  updated_at: string
}

export async function generateStatusExportBatch(
  input: GenerateStatusBatchInput
): Promise<GenerateStatusBatchOutcome> {
  const supabase = createAdminClient()

  try {
    // 1. The pending queue (§3.7 flow, §3.4 entries_pending_export_idx):
    //    hub_status_exported_at is null and hub_status_id <> 1 ('not_set').
    //    JUDGEMENT CALL: also excludes is_void = true. Not stated explicitly in §3.7,
    //    but consistent with §3.4's "voided, never removed" semantics — a decision
    //    made on an entry that has since been voided should not leave the building.
    const { data: pendingEntries, error: entriesError } = await supabase
      .from('entries')
      .select(
        'id, ubbl_number, main_number, hub_status_id, hub_status_note, hub_status_changed_at, hub_status_changed_by, updated_at'
      )
      .is('hub_status_exported_at', null)
      .neq('hub_status_id', 1)
      .eq('is_void', false)
      .order('hub_status_changed_at', { ascending: true, nullsFirst: true })

    if (entriesError) {
      return { ok: false, error: `Failed to load the pending export queue: ${entriesError.message}` }
    }
    const rows = (pendingEntries ?? []) as PendingEntryRow[]
    if (rows.length === 0) {
      return { ok: true, batch: null, reason: 'nothing_pending' }
    }

    // 2. Resolve hub_status_id -> code for whatever distinct statuses are present.
    const statusIds = Array.from(new Set(rows.map((e) => e.hub_status_id)))
    const { data: statusRows, error: statusError } = await supabase
      .from('hub_status')
      .select('id, code')
      .in('id', statusIds)
    if (statusError || !statusRows) {
      return { ok: false, error: `Failed to resolve Hub status codes: ${statusError?.message ?? 'no rows returned'}` }
    }
    const codeById = new Map<number, string>(statusRows.map((s: { id: number; code: string }) => [s.id, s.code]))

    // 3. Snapshot every entry into the export-row shape via the shared transform
    //    (§3.7: "the mirror of the import transform"). Snapshotted now — must not
    //    depend on a later edit to the entry.
    const snapshots = rows.map((entry) => {
      const hubStatusCode = codeById.get(entry.hub_status_id)
      if (!hubStatusCode) {
        throw new Error(`entry ${entry.id}: hub_status_id ${entry.hub_status_id} has no matching hub_status row`)
      }
      const hubEntry: HubStatusEntry = {
        ubblNumber: entry.ubbl_number,
        mainNumber: entry.main_number,
        hubStatusCode,
        hubStatusNote: entry.hub_status_note,
        // Defensive fallback: status_export_row.changed_at is NOT NULL, but
        // hub_status_changed_at is nullable in the schema. Every status change made
        // through the app's own action stamps it via the entries_before_update
        // trigger, so this fallback should never actually trigger in practice — it
        // exists so a write never fails on a null the DB forbids.
        hubStatusChangedAt: entry.hub_status_changed_at ?? entry.updated_at ?? new Date().toISOString(),
      }
      return {
        entryId: entry.id,
        changedBy: entry.hub_status_changed_by,
        row: hubStatusToExportRow(hubEntry),
      }
    })

    // 4. Build the .xlsx BEFORE any database write — keyed on BOTH UBBL Number and
    //    Main Entry Number (§3.7: "because those two namespaces overlap and the
    //    receiving module must be able to match on the one it owns").
    const worksheetData = snapshots.map(({ row }) => ({
      'UBBL Number': row.ubbl_number,
      'Main Entry Number': row.main_number ?? '',
      'Hub Status Code': row.hub_status_code,
      'Hub Status Note': row.hub_status_note ?? '',
      'Changed At': row.changed_at ?? '',
    }))
    const worksheet = XLSX.utils.json_to_sheet(worksheetData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Hub Status Export')
    const fileBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const fileHashSha256 = createHash('sha256').update(fileBuffer).digest('hex')

    // 5. Create the batch row first — its id becomes part of the storage path.
    const { data: batchRow, error: batchInsertError } = await supabase
      .from('status_export_batch')
      .insert({
        target_system: input.targetSystem,
        format: 'xlsx',
        row_count: snapshots.length,
        status: 'generated',
        generated_by: input.generatedBy,
      })
      .select('id')
      .single()

    if (batchInsertError || !batchRow) {
      return {
        ok: false,
        error: `Failed to create the export batch: ${batchInsertError?.message ?? 'insert returned no row'}`,
      }
    }
    const batchId = batchRow.id as number

    // 6. Upload the file. On failure, mark the batch 'failed' rather than leaving it
    //    stuck in 'generated' with no file behind it.
    const storagePath = `${EXPORT_STORAGE_PREFIX}/${batchId}/status-export-${batchId}.xlsx`
    try {
      await putDocument(
        storagePath,
        fileBuffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : String(uploadError)
      await supabase.from('status_export_batch').update({ status: 'failed', error_message: message }).eq('id', batchId)
      return { ok: false, error: `Batch ${batchId} created but file upload failed: ${message}` }
    }

    // 7. Snapshot rows — permanent record of what was sent (§3.7, §4.4d: indefinite).
    const rowInserts = snapshots.map(({ entryId, changedBy, row }) => ({
      status_export_batch_id: batchId,
      entry_id: entryId,
      ubbl_number: row.ubbl_number,
      main_number: row.main_number,
      hub_status_code: row.hub_status_code,
      hub_status_note: row.hub_status_note,
      changed_at: row.changed_at as string,
      changed_by: changedBy,
    }))
    const { error: rowInsertError } = await supabase.from('status_export_row').insert(rowInserts)
    if (rowInsertError) {
      await supabase
        .from('status_export_batch')
        .update({ status: 'failed', error_message: rowInsertError.message })
        .eq('id', batchId)
      return { ok: false, error: `Batch ${batchId}: file uploaded but writing export rows failed: ${rowInsertError.message}` }
    }

    // 8. Record the file on the batch row.
    const { error: batchUpdateError } = await supabase
      .from('status_export_batch')
      .update({ storage_path: storagePath, file_hash_sha256: fileHashSha256 })
      .eq('id', batchId)
    if (batchUpdateError) {
      return {
        ok: false,
        error: `Batch ${batchId} generated and rows recorded, but saving the file path failed: ${batchUpdateError.message}`,
      }
    }

    // 9. Mark every included entry exported — this is what removes them from the
    //    pending queue. If this step fails, the rows already written above stand as
    //    the permanent record of what was sent; the entries simply remain in the
    //    queue and would be picked up again by the next run (a human should confirm
    //    before re-running, to avoid a duplicate row for the same status change).
    const entryIds = snapshots.map((s) => s.entryId)
    const { error: entriesUpdateError } = await supabase
      .from('entries')
      .update({ hub_status_exported_at: new Date().toISOString(), hub_status_export_batch_id: batchId })
      .in('id', entryIds)
    if (entriesUpdateError) {
      return {
        ok: false,
        error: `Batch ${batchId} was generated and recorded, but marking ${entryIds.length} entries as exported failed: ${entriesUpdateError.message}. The batch file and export-row records are valid; the entries remain in the pending queue.`,
      }
    }

    return {
      ok: true,
      batch: {
        batchId,
        targetSystem: input.targetSystem,
        rowCount: snapshots.length,
        storagePath,
        fileHashSha256,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// updateExportBatchStatus — delivered / acknowledged (§3.7: "manually in
// week 1, because delivery is a person sending a file").
// ---------------------------------------------------------------------------

export interface UpdateBatchStatusInput {
  batchId: number
  status: 'delivered' | 'acknowledged'
  note?: string
}

export async function updateExportBatchStatus(
  input: UpdateBatchStatusInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = createAdminClient()

  const { data: existing, error: fetchError } = await supabase
    .from('status_export_batch')
    .select('id, status')
    .eq('id', input.batchId)
    .single()
  if (fetchError || !existing) {
    return { ok: false, error: `Export batch ${input.batchId} was not found.` }
  }

  // Forward-only lifecycle (§3.7): generated -> delivered -> acknowledged. A
  // "delivered export is never rewritten" extends to not letting the status
  // machine run backwards or skip a step.
  const allowedNextStatus: Record<string, string> = { generated: 'delivered', delivered: 'acknowledged' }
  if (allowedNextStatus[existing.status] !== input.status) {
    return {
      ok: false,
      error: `Cannot move batch ${input.batchId} from "${existing.status}" to "${input.status}".`,
    }
  }

  const patch =
    input.status === 'delivered'
      ? { status: 'delivered' as const, delivered_at: new Date().toISOString() }
      : {
          status: 'acknowledged' as const,
          acknowledged_at: new Date().toISOString(),
          acknowledged_note: input.note?.trim() || null,
        }

  const { error: updateError } = await supabase.from('status_export_batch').update(patch).eq('id', input.batchId)
  if (updateError) {
    return { ok: false, error: updateError.message }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// getExportBatchDownloadUrl — a short-lived signed URL, never a raw storage
// path (§4.3: "Nothing renders a raw storage path in the browser").
// ---------------------------------------------------------------------------

export async function getExportBatchDownloadUrl(
  batchId: number
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('status_export_batch')
    .select('storage_path')
    .eq('id', batchId)
    .single()
  if (error || !data?.storage_path) {
    return { ok: false, error: 'No file is available for this batch.' }
  }
  try {
    const url = await getSignedUrl(data.storage_path as string)
    return { ok: true, url }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
