'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { deleteDocument, getSignedUrl } from '@/lib/storage'
import { extractAndPersist } from '@/lib/jobs/handlers/extract'
import { logRawError } from '@/lib/friendly-error'

/**
 * Document-inbox actions (MASTER-PLAN §5 row 6, §11.2 Day 3): attach, bulk
 * attach, and "no entry expected" for the `/documents` screen. Same shape
 * as lib/actions/hub-status.ts — session-bound client so RLS
 * (source_document_update: private.is_reviewer_or_admin(), 20260808000026)
 * is the real gate, and a 0-rows-updated result is reported as a friendly
 * error string rather than a silent no-op or a thrown exception.
 */

type ActionResult = { ok: true } | { ok: false; error: string }

const PERMISSION_HINT =
  'This usually means a viewer role (reviewer/admin required), or the document is no longer visible to you.'

/** Deletion is admin-only and refuses verified extractions, so its failures need their own hint. */
const DELETE_PERMISSION_HINT =
  'Deleting needs the admin role, and a document whose extraction has already been verified cannot be deleted — cancel it instead.'

/**
 * Attaches one document to one entry: sets `entry_id` and flips
 * `match_status` to 'matched' (§3.8). The inverse of "no entry expected" —
 * a document can move between the two as long as it stays reviewer/admin
 * gated, so no guard against re-attaching an already-matched document.
 */
export async function attachDocumentToEntry(input: {
  documentId: number
  entryId: number
}): Promise<ActionResult> {
  if (!Number.isInteger(input.documentId) || !Number.isInteger(input.entryId)) {
    return { ok: false, error: 'Invalid document or entry id.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('source_document')
    .update({ entry_id: input.entryId, match_status: 'matched' })
    .eq('id', input.documentId)
    .select('id')

  if (error) return { ok: false, error: logRawError('documents.attachDocumentToEntry', error.message) }
  if (!data || data.length === 0) {
    return { ok: false, error: `No document was updated. ${PERMISSION_HINT}` }
  }

  revalidatePath('/documents')
  revalidatePath('/entries')
  revalidatePath(`/entries/${input.entryId}`)
  return { ok: true }
}

/**
 * Manual "Extract now" bypass (Documents inbox: no worker is guaranteed to
 * be draining `public.job_queue` right now, so staff should never be stuck
 * waiting on one). Same permission gate as attachDocumentToEntry above — an
 * update on `source_document`, gated by `source_document_update` RLS
 * (private.is_reviewer_or_admin(), 20260808000026), with a 0-rows result
 * read as "not visible / not permitted" rather than a silent no-op. Once
 * the gate passes, this hands off to extractAndPersist — the same function
 * the `extract_document` job handler (lib/jobs/handlers/extract.ts) and
 * `/api/documents/reescalate` both call — which runs on the service-role
 * client, bypasses `job_queue` entirely, and owns its own upload_status
 * bookkeeping (processing → processed/failed), so this action only needs to
 * gate access and turn a thrown error into an ActionResult.
 */
export async function manualExtractNow(documentId: number): Promise<ActionResult> {
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return { ok: false, error: 'Invalid document id.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('source_document')
    .update({ upload_status: 'processing' })
    .eq('id', documentId)
    .select('id')

  if (error) return { ok: false, error: logRawError('documents.manualExtractNow', error.message) }
  if (!data || data.length === 0) {
    return { ok: false, error: `No document was updated. ${PERMISSION_HINT}` }
  }

  try {
    // `initial`, not `manual_reescalation`: this button runs Haiku (no model
    // is passed, so extractAndPersist takes its default) on a document that
    // has not been extracted yet. It is a first extraction that happens to be
    // hand-triggered because no worker is guaranteed to be draining the queue
    // — not a reviewer asking for a second opinion. Logging it as a
    // re-escalation made `ocr_extraction_run` misreport both the cost split
    // between first passes and re-runs, and the "did Haiku struggle here?"
    // history the review screen reads. The real re-escalation path is
    // app/api/documents/reescalate/route.ts, which forces Sonnet.
    await extractAndPersist({ sourceDocumentId: documentId, runReason: 'initial' })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Extraction failed.' }
  }

  revalidatePath('/documents')
  return { ok: true }
}

export interface BulkAttachPair {
  documentId: number
  entryId: number
}

export interface BulkAttachResult {
  success: boolean
  attachedCount: number
  requestedCount: number
  failedDocumentIds: number[]
  error?: string
}

/**
 * Bulk-attach across multiple documents to their respective (suggested or
 * hand-picked) entries in one UI action (§11.2 Day 3: "bulk attach"). Each
 * pair targets a different entry, so this cannot be a single `.in()`
 * update — it is one update per pair, same as setHubStatus's per-row
 * partial-success accounting: a document that fails (permission, RLS
 * visibility, or a bad id) is reported, not silently dropped.
 */
export async function bulkAttachDocuments(pairs: BulkAttachPair[]): Promise<BulkAttachResult> {
  const cleanPairs = pairs.filter(
    (p) => Number.isInteger(p.documentId) && p.documentId > 0 && Number.isInteger(p.entryId) && p.entryId > 0
  )
  const requestedCount = cleanPairs.length

  if (requestedCount === 0) {
    return {
      success: false,
      attachedCount: 0,
      requestedCount: 0,
      failedDocumentIds: [],
      error: 'No documents selected.',
    }
  }

  const supabase = await createClient()
  const failedDocumentIds: number[] = []
  let attachedCount = 0

  for (const pair of cleanPairs) {
    const { data, error } = await supabase
      .from('source_document')
      .update({ entry_id: pair.entryId, match_status: 'matched' })
      .eq('id', pair.documentId)
      .select('id')

    if (error || !data || data.length === 0) {
      failedDocumentIds.push(pair.documentId)
    } else {
      attachedCount++
    }
  }

  revalidatePath('/documents')
  revalidatePath('/entries')

  if (attachedCount === 0) {
    return {
      success: false,
      attachedCount,
      requestedCount,
      failedDocumentIds,
      error: `No documents were attached. ${PERMISSION_HINT}`,
    }
  }
  if (attachedCount < requestedCount) {
    return {
      success: true,
      attachedCount,
      requestedCount,
      failedDocumentIds,
      error: `${requestedCount - attachedCount} of ${requestedCount} selected documents could not be attached.`,
    }
  }
  return { success: true, attachedCount, requestedCount, failedDocumentIds: [] }
}

/**
 * Parks a document with genuinely no matching entry (§11.2 Day 3 exit
 * criterion: "a document with genuinely no entry can be parked without
 * pretending otherwise"). Does not clear `entry_id` — a document is either
 * unattached already or this is being used to explicitly un-match, and in
 * both cases only the status, not any existing link, is this action's job.
 */
export async function markNoEntryExpected(documentId: number): Promise<ActionResult> {
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return { ok: false, error: 'Invalid document id.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('source_document')
    .update({ match_status: 'no_entry_expected' })
    .eq('id', documentId)
    .select('id')

  if (error) return { ok: false, error: logRawError('documents.markNoEntryExpected', error.message) }
  if (!data || data.length === 0) {
    return { ok: false, error: `No document was updated. ${PERMISSION_HINT}` }
  }

  revalidatePath('/documents')
  return { ok: true }
}

/**
 * Detaches a document from an entry: clears `entry_id` and sends it back to
 * 'unmatched' so it reappears in the inbox rather than staying invisibly
 * linked to the wrong entry. The inverse of attachDocumentToEntry.
 */
export async function detachDocumentFromEntry(
  documentId: number,
  entryId: number
): Promise<ActionResult> {
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return { ok: false, error: 'Invalid document id.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('source_document')
    .update({ entry_id: null, match_status: 'unmatched' })
    .eq('id', documentId)
    .select('id')

  if (error) return { ok: false, error: logRawError('documents.detachDocumentFromEntry', error.message) }
  if (!data || data.length === 0) {
    return { ok: false, error: `No document was updated. ${PERMISSION_HINT}` }
  }

  revalidatePath('/documents')
  revalidatePath('/entries')
  revalidatePath(`/entries/${entryId}`)
  return { ok: true }
}

export interface BulkDeleteResult {
  success: boolean
  deletedCount: number
  requestedCount: number
  failedDocumentIds: number[]
  error?: string
}

/**
 * The one removal action on the documents inbox: deletes the document,
 * everything extracted from it, any queued extraction work, and the stored
 * PDF itself.
 *
 * There used to be a separate non-destructive "cancel tracking" (flip
 * match_status to 'canceled', keep every row) alongside this. Removed on
 * direct instruction: a document that's hidden from the inbox but still sits
 * in the database, still holds a queued `extract_document` job (job_queue has
 * no foreign key to source_document, so nothing about flipping a status
 * column ever touched it), and still gets extracted — and billed — the moment
 * a worker reaches it, is not what "canceled" means to someone using this
 * screen. If it's hidden, it should be gone. So there is one action now, and
 * it does the real thing.
 *
 * Row deletion goes through the `delete_source_document` RPC
 * (20260820000001) rather than `.delete()` from here, because delete is
 * revoked on every table in `public` (20260808000026) and stays revoked — the
 * RPC is the single gated entry point, and it enforces the admin check and the
 * refusal to delete a verified extraction.
 *
 * Storage is cleaned up here rather than in SQL, since Postgres cannot reach
 * the storage bucket. The RPC returns the `storage_path` it deleted precisely
 * so this step has something to act on. Ordering is deliberate: the row goes
 * first, and a failure to remove the file afterwards is logged but does not
 * fail the action. An orphaned PDF in a private bucket is untidy; a
 * source_document row pointing at a file that no longer exists is a broken
 * review screen.
 *
 * Per-row like the other bulk actions, so one refusal (verified, or not
 * visible to this user) doesn't block the rest of the selection.
 */
export async function deleteDocuments(documentIds: number[]): Promise<BulkDeleteResult> {
  const cleanIds = documentIds.filter((id) => Number.isInteger(id) && id > 0)
  const requestedCount = cleanIds.length

  if (requestedCount === 0) {
    return {
      success: false,
      deletedCount: 0,
      requestedCount: 0,
      failedDocumentIds: [],
      error: 'No documents selected.',
    }
  }

  const supabase = await createClient()
  const failedDocumentIds: number[] = []
  const storagePaths: string[] = []
  let deletedCount = 0

  for (const documentId of cleanIds) {
    const { data, error } = await supabase.rpc('delete_source_document', { p_id: documentId })

    if (error) {
      logRawError('documents.deleteDocuments', error.message)
      failedDocumentIds.push(documentId)
      continue
    }
    // null => no row matched (already gone). Counted as success so deleting
    // the same selection twice is idempotent rather than a spurious failure.
    if (typeof data === 'string' && data !== '') storagePaths.push(data)
    deletedCount++
  }

  // Best-effort, and deliberately after the rows are gone — see the doc
  // comment above on why a storage failure must not fail the action.
  for (const path of storagePaths) {
    try {
      await deleteDocument(path)
    } catch (err) {
      logRawError('documents.deleteDocuments.storage', err instanceof Error ? err.message : String(err))
    }
  }

  revalidatePath('/documents')
  revalidatePath('/review')
  revalidatePath('/')

  if (deletedCount === 0) {
    return {
      success: false,
      deletedCount,
      requestedCount,
      failedDocumentIds,
      error: `No documents were deleted. ${DELETE_PERMISSION_HINT}`,
    }
  }
  if (deletedCount < requestedCount) {
    return {
      success: true,
      deletedCount,
      requestedCount,
      failedDocumentIds,
      error: `${requestedCount - deletedCount} of ${requestedCount} selected documents could not be deleted. ${DELETE_PERMISSION_HINT}`,
    }
  }
  return { success: true, deletedCount, requestedCount, failedDocumentIds: [] }
}

export interface EntrySearchResult {
  id: number
  ubblNumber: string
  mainNumber: string | null
  vendorRaw: string | null
  amount: number | null
  date: string | null
}

/**
 * Manual fallback for when the automatic vendor/amount/date suggestion
 * (lib/matching.ts) misses or is wrong. Matches on UBBL number, Main
 * number, vendor, or invoice number — the identifiers a reviewer is most
 * likely to have on hand while looking at the document. Read-only, so any
 * active staff can call it (entries_select RLS, department-scoped);
 * writing still goes through attachDocumentToEntry / bulkAttachDocuments.
 */
export async function searchEntriesForAttach(
  query: string
): Promise<{ ok: true; results: EntrySearchResult[] } | { ok: false; error: string }> {
  const trimmed = query.trim().replace(/,/g, ' ')
  if (trimmed.length < 2) {
    return { ok: true, results: [] }
  }

  const supabase = await createClient()
  const pattern = `%${trimmed}%`
  const { data, error } = await supabase
    .from('entries')
    .select('id, ubbl_number, main_number, vendor_raw, amount, date')
    .eq('is_void', false)
    .or(
      `ubbl_number.ilike.${pattern},main_number.ilike.${pattern},vendor_raw.ilike.${pattern},invoice_number.ilike.${pattern}`
    )
    .order('date', { ascending: false })
    .limit(10)

  if (error) return { ok: false, error: logRawError('documents.searchEntriesForAttach', error.message) }

  return {
    ok: true,
    results: (data ?? []).map((e) => ({
      id: e.id,
      ubblNumber: e.ubbl_number,
      mainNumber: e.main_number,
      vendorRaw: e.vendor_raw,
      amount: e.amount,
      date: e.date,
    })),
  }
}

/**
 * Time-limited signed URL so a reviewer can glance at the original PDF from
 * the inbox card (optional per the task brief — kept minimal, no viewer
 * chrome; that is Day 4's job). Visibility is checked FIRST with the
 * session-bound client — `source_document_select` RLS
 * (private.can_see_source_document) — before lib/storage.ts's
 * service-role-backed signer ever runs, so an unmatched-but-invisible or
 * cross-department document can't be previewed just by guessing an id.
 */
export async function getDocumentPreviewUrl(
  documentId: number
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return { ok: false, error: 'Invalid document id.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('source_document')
    .select('storage_path')
    .eq('id', documentId)
    .maybeSingle()

  if (error || !data) {
    return { ok: false, error: 'Document not found, or not visible to you.' }
  }

  try {
    const url = await getSignedUrl(data.storage_path)
    return { ok: true, url }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create a preview link.' }
  }
}
