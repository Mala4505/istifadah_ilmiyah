'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { deleteDocument, getSignedUrl } from '@/lib/storage'
import { extractAndPersist } from '@/lib/jobs/handlers/extract'
import { logRawError } from '@/lib/friendly-error'
import { rankCandidates, type MatchableEntry } from '@/lib/matching'
import { normalizeVendorName } from '@/lib/normalize'
import { getSelectedEventId } from '@/lib/events/current'
import type { CandidateEntryView } from '@/components/documents/types'

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
  /** Same three fields as CandidateEntryView (components/documents/types.ts), and for the same reason: the attach-time zone/admin-head prompt (checklist 5.11) needs to know the target entry's department and current classification whether it was reached via the ranked candidates or this manual search. */
  entryDepartmentId: number | null
  adminHeadId: number | null
  zoneId: number | null
  /** Resolved alongside entryDepartmentId, same event-scoped lookup
   *  getInboxMatchCandidates uses -- lets EntryAttachCombobox show which
   *  department a searched-up entry belongs to, not just the ranked
   *  suggestions. Null when the department has no name resolvable for the
   *  selected event (see the resolution site). */
  departmentName: string | null
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
    .select('id, ubbl_number, main_number, vendor_raw, amount, date, department_id, admin_head_id, zone_id')
    .eq('is_void', false)
    .or(
      `ubbl_number.ilike.${pattern},main_number.ilike.${pattern},vendor_raw.ilike.${pattern},invoice_number.ilike.${pattern}`
    )
    .order('date', { ascending: false })
    .limit(10)

  if (error) return { ok: false, error: logRawError('documents.searchEntriesForAttach', error.message) }

  // Same event-scoped department-name resolution as getInboxMatchCandidates
  // -- cosmetic only (helps tell apart similar-looking search results), so
  // scoped to the selected event's event_department membership rather than
  // the full shared department table.
  const resultDepartmentIds = Array.from(
    new Set((data ?? []).map((e) => e.department_id as number | null).filter((id): id is number => id !== null))
  )
  const selectedEventId = await getSelectedEventId(supabase)
  const { data: eventDepartmentRows } =
    selectedEventId !== null && resultDepartmentIds.length > 0
      ? await supabase.from('event_department').select('department_id').eq('event_id', selectedEventId)
      : { data: [] as { department_id: number }[] }
  const activeDepartmentIds = new Set((eventDepartmentRows ?? []).map((r) => r.department_id as number))
  const departmentIdsToResolve = resultDepartmentIds.filter((id) => activeDepartmentIds.has(id))
  const { data: departmentsData } =
    departmentIdsToResolve.length > 0
      ? await supabase.from('department').select('id, name').in('id', departmentIdsToResolve)
      : { data: [] as { id: number; name: string }[] }
  const departmentNameById = new Map((departmentsData ?? []).map((d) => [d.id as number, d.name as string]))

  return {
    ok: true,
    results: (data ?? []).map((e) => ({
      id: e.id,
      ubblNumber: e.ubbl_number,
      mainNumber: e.main_number,
      vendorRaw: e.vendor_raw,
      amount: e.amount,
      date: e.date,
      entryDepartmentId: e.department_id,
      adminHeadId: e.admin_head_id,
      zoneId: e.zone_id,
      departmentName: e.department_id !== null ? (departmentNameById.get(e.department_id) ?? null) : null,
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

export interface DocumentViewLineItem {
  id: number
  lineOrder: number
  description: string | null
  quantity: number | null
  unit: string | null
  rate: number | null
  discount: string | null
  amount: number | null
}

export interface DocumentViewDetail {
  sourceDocumentId: number
  documentExtractionId: number
  originalFilename: string
  pageCount: number | null
  billIndex: number
  billCount: number
  verifiedAt: string | null
  vendorName: string | null
  vendorGstin: string | null
  vendorPhone: string | null
  vendorEmail: string | null
  vendorAddress: string | null
  /** Recipient/"Bill To" block -- plan §12. Our own GSTIN/name as printed on
   *  the bill; surfaced read-only here so a reviewer can confirm every filed
   *  bill carries them without re-entering /review. */
  buyerGstin: string | null
  buyerName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  subtotal: number | null
  taxAmount: number | null
  totalAmount: number | null
  notes: string | null
  lineItems: DocumentViewLineItem[]
}

/**
 * Read-only bill detail (header + line items) for lookup contexts outside
 * `/review` — the "View details" modal on `LinkedDocuments`
 * (components/entries/detail/linked-documents.tsx). Same visibility gate as
 * getDocumentPreviewUrl above (session-bound client, source_document_select
 * RLS checked first), but returns the structured OCR data instead of a PDF
 * URL so a reviewer doesn't have to re-enter the `/review` queue just to
 * see a bill's line items again.
 *
 * `entryId`, when passed, picks the specific bill matched to that entry out
 * of a multi-bill PDF (document_extraction.entry_id, same per-bill source of
 * truth used throughout review.ts); omitted or unmatched falls back to the
 * first bill by bill_index, mirroring the same convention already used to
 * build LinkedDocumentView on the entry detail page.
 */
export async function getDocumentViewDetail(
  documentId: number,
  entryId?: number
): Promise<{ ok: true; detail: DocumentViewDetail } | { ok: false; error: string }> {
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return { ok: false, error: 'Invalid document id.' }
  }

  const supabase = await createClient()

  const [sourceDocRes, extractionsRes] = await Promise.all([
    supabase.from('source_document').select('id, original_filename, page_count').eq('id', documentId).maybeSingle(),
    supabase
      .from('document_extraction')
      .select(
        'id, bill_index, entry_id, verified_at, vendor_name_ocr, vendor_name_verified, vendor_gstin_ocr, vendor_gstin_verified, vendor_phone_ocr, vendor_phone_verified, vendor_email_ocr, vendor_email_verified, vendor_address_ocr, vendor_address_verified, buyer_gstin_ocr, buyer_gstin_verified, buyer_name_ocr, buyer_name_verified, invoice_number_ocr, invoice_number_verified, invoice_date_ocr, invoice_date_verified, subtotal_ocr, subtotal_verified, tax_amount_ocr, tax_amount_verified, total_amount_ocr, total_amount_verified, notes_ocr, notes_verified'
      )
      .eq('source_document_id', documentId)
      .order('bill_index'),
  ])

  const sourceDoc = sourceDocRes.data
  const extractions = extractionsRes.data ?? []
  if (!sourceDoc || extractions.length === 0) {
    return { ok: false, error: 'This document has not been extracted yet, or is not visible to you.' }
  }

  const extraction = (entryId !== undefined ? extractions.find((e) => e.entry_id === entryId) : undefined) ?? extractions[0]!

  const { data: lineItemsData, error: lineItemsError } = await supabase
    .from('document_extraction_line_item')
    .select(
      'id, line_order, description_ocr, description_verified, quantity_ocr, quantity_verified, unit_ocr, unit_verified, unit_normalized, rate_ocr, rate_verified, discount_ocr, discount_verified, amount_ocr, amount_verified'
    )
    .eq('document_extraction_id', extraction.id)
    .order('line_order')

  if (lineItemsError) {
    return { ok: false, error: logRawError('documents.getDocumentViewDetail', lineItemsError.message) }
  }

  return {
    ok: true,
    detail: {
      sourceDocumentId: sourceDoc.id as number,
      documentExtractionId: extraction.id as number,
      originalFilename: sourceDoc.original_filename as string,
      pageCount: sourceDoc.page_count as number | null,
      billIndex: extraction.bill_index as number,
      billCount: extractions.length,
      verifiedAt: extraction.verified_at as string | null,
      vendorName: (extraction.vendor_name_verified ?? extraction.vendor_name_ocr) as string | null,
      vendorGstin: (extraction.vendor_gstin_verified ?? extraction.vendor_gstin_ocr) as string | null,
      vendorPhone: (extraction.vendor_phone_verified ?? extraction.vendor_phone_ocr) as string | null,
      vendorEmail: (extraction.vendor_email_verified ?? extraction.vendor_email_ocr) as string | null,
      vendorAddress: (extraction.vendor_address_verified ?? extraction.vendor_address_ocr) as string | null,
      buyerGstin: (extraction.buyer_gstin_verified ?? extraction.buyer_gstin_ocr) as string | null,
      buyerName: (extraction.buyer_name_verified ?? extraction.buyer_name_ocr) as string | null,
      invoiceNumber: (extraction.invoice_number_verified ?? extraction.invoice_number_ocr) as string | null,
      invoiceDate: (extraction.invoice_date_verified ?? extraction.invoice_date_ocr) as string | null,
      subtotal: (extraction.subtotal_verified ?? extraction.subtotal_ocr) as number | null,
      taxAmount: (extraction.tax_amount_verified ?? extraction.tax_amount_ocr) as number | null,
      totalAmount: (extraction.total_amount_verified ?? extraction.total_amount_ocr) as number | null,
      notes: (extraction.notes_verified ?? extraction.notes_ocr) as string | null,
      lineItems: (lineItemsData ?? []).map((li) => ({
        id: li.id as number,
        lineOrder: li.line_order as number,
        description: (li.description_verified ?? li.description_ocr) as string | null,
        quantity: (li.quantity_verified ?? li.quantity_ocr) as number | null,
        unit: ((li.unit_normalized as string | null) || (li.unit_verified ?? li.unit_ocr)) as string | null,
        rate: (li.rate_verified ?? li.rate_ocr) as number | null,
        discount: (li.discount_verified ?? li.discount_ocr) as string | null,
        amount: (li.amount_verified ?? li.amount_ocr) as number | null,
      })),
    },
  }
}

/**
 * Checklist 2.9 (plan §5, D6): the inbox used to score `rankCandidates`
 * against every unmatched/suggested bill on every server-rendered load of
 * `/documents` — up to a few thousand entries per bill, scored in the
 * request that also has to answer the page's own HTML. Moved here so
 * `app/(app)/documents/page.tsx`'s render only ever fetches the cheap,
 * unranked fields; `DocumentInbox` calls this once, client-side, after
 * mount (and again after each `router.refresh()`), so the first paint is
 * fast and ranking happens off the render path entirely.
 *
 * Deliberately NOT persisted: matching entries are the whole ledger and
 * change constantly as imports land, so a cached/stored ranking would go
 * stale exactly when it matters most (a newly-imported entry that would
 * now match an old unmatched document). Recomputing fresh on every call
 * keeps a suggestion honest at the cost of redoing the scoring work each
 * time it's asked for — the same trade this screen has always made, just
 * no longer paid inside the page's own render.
 *
 * Mirrors the exact query/scoring shape `app/(app)/documents/page.tsx` used
 * to run inline: same matched-entry exclusion, same 5,000-row recency cap,
 * same `rankCandidates` call, per bill. Returns every current
 * unmatched/suggested bill's ranked candidates in one round trip rather
 * than taking a list of ids to score — the shared candidate-pool queries
 * (matched-entry exclusion, the 5,000-row entries fetch) cost the same
 * whether scoring one bill or all of them, so there's nothing to save by
 * asking for a subset.
 */
export async function getInboxMatchCandidates(): Promise<Record<number, CandidateEntryView[]>> {
  const supabase = await createClient()

  const { data: docsData } = await supabase
    .from('source_document')
    .select('id')
    .in('match_status', ['unmatched', 'suggested'])
  const docIds = (docsData ?? []).map((d) => d.id as number)
  if (docIds.length === 0) return {}

  const { data: extractionsData } = await supabase
    .from('document_extraction')
    .select('id, vendor_name_ocr, invoice_date_ocr, total_amount_ocr, invoice_number_ocr, invoice_number_verified')
    .in('source_document_id', docIds)
  const extractions = extractionsData ?? []
  if (extractions.length === 0) return {}

  const { data: matchedRows } = await supabase
    .from('source_document')
    .select('entry_id')
    .eq('match_status', 'matched')
    .not('entry_id', 'is', null)
  const matchedEntryIds = new Set((matchedRows ?? []).map((r) => r.entry_id as number))

  const { data: entriesData } = await supabase
    .from('entries')
    .select(
      'id, department_id, vendor_raw, vendor_id, amount, date, invoice_number, ubbl_number, main_number, admin_head_id, zone_id'
    )
    .eq('is_void', false)
    .order('date', { ascending: false, nullsFirst: false })
    .limit(5000)

  const candidatePool: MatchableEntry[] = (entriesData ?? [])
    .filter((e) => !matchedEntryIds.has(e.id))
    .map((e) => ({
      id: e.id,
      vendorRaw: e.vendor_raw,
      vendorId: e.vendor_id,
      amount: e.amount,
      date: e.date,
      invoiceNumber: e.invoice_number,
      departmentId: e.department_id,
      ubblNumber: e.ubbl_number,
      mainNumber: e.main_number,
      adminHeadId: e.admin_head_id,
      zoneId: e.zone_id,
    }))

  // Phase 6 Step 2 §1: department names shown alongside a candidate are
  // scoped to the SELECTED event's event_department membership, not the
  // full shared department table -- a department retired in a prior year
  // (present on an old entry's department_id, but untouched by the current
  // year's carry-forward) shouldn't be relabeled as if it were still active.
  // A department with no membership row simply comes back with no name
  // (departmentNameById.get returns undefined -> null below), which is
  // cosmetic only -- it never affects which entries are actually candidates.
  const selectedEventId = await getSelectedEventId(supabase)
  const { data: eventDepartmentRows } =
    selectedEventId !== null
      ? await supabase.from('event_department').select('department_id').eq('event_id', selectedEventId)
      : { data: [] as { department_id: number }[] }
  const activeDepartmentIds = (eventDepartmentRows ?? []).map((r) => r.department_id as number)

  const { data: departmentsData } =
    activeDepartmentIds.length > 0
      ? await supabase.from('department').select('id, name').in('id', activeDepartmentIds)
      : { data: [] as { id: number; name: string }[] }
  const departmentNameById = new Map((departmentsData ?? []).map((d) => [d.id as number, d.name as string]))

  // Redesign plan §10: batch-resolve every extraction's normalized OCR
  // vendor name against learned vendor_alias rows in one query, rather than
  // one round trip per bill -- this function already scores every
  // unmatched/suggested bill in the inbox in one call, so the same
  // one-query-for-everything shape used for candidatePool/departmentsData
  // above applies here too.
  const normalizedVendorNameByExtractionId = new Map<number, string>()
  for (const extraction of extractions) {
    const ocrVendorName = extraction.vendor_name_ocr as string | null
    if (!ocrVendorName) continue
    const normalized = normalizeVendorName(ocrVendorName)
    if (normalized) normalizedVendorNameByExtractionId.set(extraction.id as number, normalized)
  }
  const uniqueNormalizedNames = Array.from(new Set(normalizedVendorNameByExtractionId.values()))
  const aliasVendorIdByNormalizedName = new Map<string, number>()
  if (uniqueNormalizedNames.length > 0) {
    const { data: aliasRows } = await supabase
      .from('vendor_alias')
      .select('raw_name, vendor_id')
      .in('raw_name', uniqueNormalizedNames)
    for (const row of aliasRows ?? []) {
      aliasVendorIdByNormalizedName.set(row.raw_name as string, row.vendor_id as number)
    }
  }

  const result: Record<number, CandidateEntryView[]> = {}
  for (const extraction of extractions) {
    const normalizedVendorName = normalizedVendorNameByExtractionId.get(extraction.id as number)
    const vendorAliasVendorId = normalizedVendorName
      ? (aliasVendorIdByNormalizedName.get(normalizedVendorName) ?? null)
      : null

    result[extraction.id as number] = rankCandidates(
      {
        vendorName: extraction.vendor_name_ocr as string | null,
        totalAmount: extraction.total_amount_ocr as number | null,
        invoiceDate: extraction.invoice_date_ocr as string | null,
        invoiceNumber:
          (extraction.invoice_number_verified as string | null) ?? (extraction.invoice_number_ocr as string | null),
        vendorAliasVendorId,
      },
      candidatePool
    ).map((c) => ({
      entryId: c.id,
      score: c.score,
      vendorRaw: c.vendorRaw,
      amount: c.amount,
      date: c.date,
      ubblNumber: c.ubblNumber,
      mainNumber: c.mainNumber,
      departmentName: c.departmentId !== null ? departmentNameById.get(c.departmentId) ?? null : null,
      entryDepartmentId: c.departmentId,
      adminHeadId: c.adminHeadId ?? null,
      zoneId: c.zoneId ?? null,
    }))
  }
  return result
}
