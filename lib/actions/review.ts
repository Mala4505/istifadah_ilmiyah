'use server'

/**
 * Server actions backing the /review screen (MASTER-PLAN §7, §11.2 Day 4).
 * `S` (Hub status) reuses lib/actions/hub-status.ts directly, per the task
 * brief -- nothing here duplicates it. `R` (re-extract) posts straight to
 * the existing app/api/documents/reescalate/route.ts from the client --
 * that route already does its own role check, so no wrapper is needed here.
 */

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSignedUrl } from '@/lib/storage'
import { logRawError } from '@/lib/friendly-error'
import { normalizeVendorName } from '@/lib/normalize'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { reExtractFieldScoped, reExtractPageScoped } from '@/lib/jobs/handlers/rescope-extract'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'

const CLAIM_STALE_AFTER_MS = 15 * 60 * 1000 // §7: "Claims expire after 15 minutes of inactivity"

export interface VerifiedHeaderInput {
  vendor_name: string | null
  vendor_gstin: string | null
  vendor_phone: string | null
  vendor_email: string | null
  vendor_address: string | null
  /** Recipient/"Bill To" block -- plan §12 GST recipient-compliance check. */
  buyer_gstin: string | null
  buyer_name: string | null
  invoice_number: string | null
  invoice_date: string | null
  subtotal: number | null
  tax_amount: number | null
  total_amount: number | null
  notes: string | null
}

export interface VerifiedLineItemInput {
  id: number
  description: string | null
  hsn_sac_code: string | null
  quantity: number | null
  quantity_raw_text: string | null
  unit: string | null
  unit_normalized: string | null
  rate: number | null
  discount: string | null
  amount: number | null
}

export interface SaveVerificationInput {
  sourceDocumentId: number
  documentExtractionId: number
  header: VerifiedHeaderInput
  lineItems: VerifiedLineItemInput[]
  vendorId: number | null
  /** Checklist 5.18 (plan §13): the extraction run ReviewDocumentDetail was
   *  built from (lib/review/types.ts's currentExtractionRunId). Passed
   *  through to the RPC's p_expected_extraction_run_id -- null skips the
   *  conflict check entirely (e.g. a caller that doesn't track it). */
  expectedExtractionRunId: number | null
}

export type SimpleActionResult = { ok: true } | { ok: false; error: string }

export type SaveVerificationResult =
  | { ok: true; lineItemsUpdated: number; rateReferenceRowsInserted: number }
  | { ok: false; error: string; conflict?: true }

/**
 * Save (`Enter` per field, `Cmd/Ctrl-Enter` for the whole document). Calls
 * the atomic RPC from 20260813000002_verify_document_extraction.sql -- one
 * transaction writes every `_verified` column AND the rate_reference rows,
 * which a sequence of plain `.update()`/`.insert()` calls cannot guarantee.
 */
export async function saveVerification(input: SaveVerificationInput): Promise<SaveVerificationResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }

  // event-scoping-and-review-fixes-plan.md §1.6: past events are browsable
  // read-only -- no new uploads, no verification, no export. Gated on the
  // currently SELECTED event (not this document's own event_id): the queue
  // itself is already filtered to the selected event
  // (app/(app)/review/page.tsx), so a document reachable here belongs to it
  // by construction.
  const selectedEvent = await getSelectedEvent(supabase)
  if (!isEventMutable(selectedEvent)) {
    return { ok: false, error: 'This event is closed to edits. Switch to the current event to verify documents.' }
  }

  const { data, error } = await supabase
    .rpc('verify_document_extraction', {
      p_document_extraction_id: input.documentExtractionId,
      p_header: input.header,
      p_line_items: input.lineItems,
      p_vendor_id: input.vendorId,
      p_expected_extraction_run_id: input.expectedExtractionRunId,
    })
    .single()

  if (error) {
    // 5.18: a version-conflict raise (private.verify_document_extraction,
    // 20260821000003) is distinguished from every other RPC failure by this
    // prefix -- surfaced as its own `conflict` flag rather than folded into
    // the generic friendly-error string, so the caller can show something
    // more specific than a toast that vanishes (ReviewWorkspace.handleSave).
    const conflict = error.message.startsWith('SAVE_CONFLICT:')
    return {
      ok: false,
      error: logRawError('review.saveVerification', error.message),
      ...(conflict ? { conflict: true as const } : {}),
    }
  }

  const result = data as {
    document_extraction_id: number
    line_items_updated: number
    rate_reference_rows_inserted: number
  } | null

  revalidatePath('/review')

  return {
    ok: true,
    lineItemsUpdated: result?.line_items_updated ?? 0,
    rateReferenceRowsInserted: result?.rate_reference_rows_inserted ?? 0,
  }
}

export interface ClaimResult {
  ok: true
  claimedByMe: true
}
export interface ClaimBlockedResult {
  ok: false
  needsTakeover: true
  claimedByDisplayName: string
  claimedAt: string
}
export interface ClaimErrorResult {
  ok: false
  needsTakeover?: false
  error: string
}

/**
 * Claim/lock (§7 concurrency rule). `takeover: true` forces the claim even
 * if another reviewer's claim is still fresh -- the UI only sends that after
 * the reviewer has explicitly confirmed "Being reviewed by X -- take over?".
 *
 * The claimant's display name has to come from the admin client:
 * `staff_profile_select` RLS (20260808000026_rls_policies.sql) only lets a
 * user read their OWN row or an admin read any row -- a plain reviewer
 * cannot select a colleague's profile through the session-bound client. That
 * policy protects role/department/is_active from casual browsing; a display
 * name shown only after this function has already confirmed (via the
 * session-bound client, i.e. under normal RLS) that the caller may see this
 * *document* is a narrow, deliberate exception, not a bypass of the
 * document-visibility rule itself.
 */
export async function claimReviewDocument(
  sourceDocumentId: number,
  options: { takeover?: boolean } = {}
): Promise<ClaimResult | ClaimBlockedResult | ClaimErrorResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }

  const { data: doc, error: readError } = await supabase
    .from('source_document')
    .select('id, claimed_by, claimed_at')
    .eq('id', sourceDocumentId)
    .maybeSingle()

  if (readError) {
    return { ok: false, error: logRawError('review.claimReviewDocument', readError.message) }
  }
  if (!doc) {
    return { ok: false, error: 'Document not found, or you do not have visibility into it.' }
  }

  const claimedBy = doc.claimed_by as string | null
  const claimedAt = doc.claimed_at as string | null
  const isStale = claimedAt !== null && Date.now() - new Date(claimedAt).getTime() > CLAIM_STALE_AFTER_MS
  const claimedBySomeoneElse = claimedBy !== null && claimedBy !== user.id

  if (claimedBySomeoneElse && !isStale && !options.takeover) {
    const admin = createAdminClient()
    const { data: claimant } = await admin
      .from('staff_profile')
      .select('display_name')
      .eq('id', claimedBy as string)
      .maybeSingle()

    return {
      ok: false,
      needsTakeover: true,
      claimedByDisplayName: (claimant?.display_name as string | undefined) ?? 'another reviewer',
      claimedAt: claimedAt as string,
    }
  }

  const { error: updateError } = await supabase
    .from('source_document')
    .update({ claimed_by: user.id, claimed_at: new Date().toISOString() })
    .eq('id', sourceDocumentId)

  if (updateError) {
    return { ok: false, error: logRawError('review.claimReviewDocument', updateError.message) }
  }

  return { ok: true, claimedByMe: true }
}

/**
 * Signed URL for the browser's PDF viewer (§4.3: "served through short-lived
 * signed URLs generated server-side"). Reads the row through the
 * session-bound client FIRST -- if `source_document_select` RLS (which
 * implies `private.can_see_source_document`) doesn't return a row, nothing
 * ever reaches the admin client that mints the URL.
 */
export async function getReviewDocumentUrl(
  sourceDocumentId: number
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: doc, error } = await supabase
    .from('source_document')
    .select('storage_path')
    .eq('id', sourceDocumentId)
    .maybeSingle()

  if (error) {
    return { ok: false, error: logRawError('review.getReviewDocumentUrl', error.message) }
  }
  if (!doc) {
    return { ok: false, error: 'Document not found, or you do not have visibility into it.' }
  }

  try {
    const url = await getSignedUrl(doc.storage_path as string, 300)
    return { ok: true, url }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * `E` -- flag as exception, with a required note (§7). A single-table
 * insert gated by the new `reconciliation_exception_insert` RLS policy
 * (20260813000003), not a SECURITY DEFINER RPC -- there is no multi-table
 * write or cross-department concern here the way save/verify has.
 */
export async function flagReviewException(input: {
  sourceDocumentId: number
  documentExtractionId: number
  entryId: number | null
  note: string
}): Promise<SimpleActionResult> {
  const note = input.note.trim()
  if (!note) {
    return { ok: false, error: 'A note is required to flag an exception.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }

  const { error } = await supabase.from('reconciliation_exception').insert({
    entry_id: input.entryId,
    document_extraction_id: input.documentExtractionId,
    exception_type: 'other',
    severity: 'medium',
    description: note,
    status: 'open',
  })

  if (error) {
    return { ok: false, error: logRawError('review.flagReviewException', error.message) }
  }

  revalidatePath('/review')
  revalidatePath('/exceptions')
  return { ok: true }
}

/**
 * Attaches a single bill (`document_extraction` row) to its ledger entry --
 * the per-bill counterpart to attachDocumentToEntry
 * (lib/actions/documents.ts), which stays whole-document. Only meaningful
 * once a source_document produces more than one bill (Phase 2, plan.md
 * §3): single-bill documents keep matching via source_document.entry_id
 * through the existing document-inbox flow, untouched.
 *
 * Redesign plan §10: this is also the review page's one write path for
 * "attach a bill to an entry" (MatchStrip's Attach button, its ranked
 * candidates, and EntryAttachCombobox's manual search all call this same
 * function), so it's the single place to learn a vendor_alias from the
 * correction -- see learnVendorAliasesFromAttach below.
 */
export async function attachExtractionToEntry(input: {
  documentExtractionId: number
  entryId: number
}): Promise<SimpleActionResult> {
  if (!Number.isInteger(input.documentExtractionId) || !Number.isInteger(input.entryId)) {
    return { ok: false, error: 'Invalid document extraction or entry id.' }
  }

  const supabase = await createClient()

  // event-scoping-and-review-fixes-plan.md §1.6: same guard as
  // saveVerification above -- attaching a bill to an entry is a ledger
  // mutation, so it's blocked while a past (non-current) event is selected.
  const selectedEvent = await getSelectedEvent(supabase)
  if (!isEventMutable(selectedEvent)) {
    return { ok: false, error: 'This event is closed to edits. Switch to the current event to attach documents.' }
  }

  const { data, error } = await supabase
    .from('document_extraction')
    .update({ entry_id: input.entryId })
    .eq('id', input.documentExtractionId)
    .select('id, vendor_name_ocr, vendor_name_verified')

  if (error) return { ok: false, error: logRawError('review.attachExtractionToEntry', error.message) }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        'No document extraction was updated. This usually means a viewer role (reviewer/admin required), or the document is no longer visible to you.',
    }
  }

  revalidatePath('/review')

  // Best-effort learning step -- awaited so it actually runs before this
  // server action returns, but never allowed to turn a successful attach
  // into a failure (see the function's own try/catch).
  await learnVendorAliasesFromAttach({
    entryId: input.entryId,
    vendorNameOcr: data[0]?.vendor_name_ocr as string | null,
    vendorNameVerified: data[0]?.vendor_name_verified as string | null,
  })

  return { ok: true }
}

/**
 * Redesign plan §10: "auto-learn from corrections." When a bill is attached
 * to an entry that already has a resolved `vendor_id`, record the bill's
 * OCR vendor name (and, if the reviewer corrected it, the corrected name
 * too) as a `vendor_alias` for that vendor -- so the NEXT bill from the
 * same vendor, spelled the same way, gets a confident vendor match in
 * lib/matching.ts (`vendorScoreFor`) instead of relying on bigram fuzzy
 * similarity alone. Purely a write for future scoring -- no `vendor_id`
 * column is added to `document_extraction`, and nothing already on screen
 * is pre-filled or auto-corrected by this (§10's explicit "score only, no
 * auto-fill" decision).
 *
 * Runs on the admin (service-role) client deliberately: `vendor_alias` has
 * no insert policy for `authenticated` at all (20260808000026_rls_policies.sql
 * -- "aliases are recorded by the import/OCR resolution pipeline (service_role)
 * or the admin vendor-merge tooling; deny-by-default for authenticated"), the
 * same reason claimReviewDocument above reaches for the admin client to read
 * staff_profile.
 *
 * `raw_name` is written as the NORMALIZED name (normalizeVendorName), not the
 * literal OCR/typed string -- lib/matching.ts looks an alias up by normalizing
 * the document's OCR vendor name and matching it against `raw_name` directly,
 * so the two sides must agree on the same key. `on conflict (raw_name) do
 * nothing` (via `ignoreDuplicates`) enforces the table's own rule verbatim:
 * never overwrite an existing alias to point at a different vendor.
 */
async function learnVendorAliasesFromAttach(params: {
  entryId: number
  vendorNameOcr: string | null
  vendorNameVerified: string | null
}): Promise<void> {
  try {
    const admin = createAdminClient()

    const { data: entry, error: entryError } = await admin
      .from('entries')
      .select('vendor_id')
      .eq('id', params.entryId)
      .maybeSingle()

    if (entryError) {
      logRawError('review.learnVendorAliasesFromAttach', entryError.message)
      return
    }

    const vendorId = (entry?.vendor_id as number | null | undefined) ?? null
    if (vendorId === null) return

    const ocrRaw = params.vendorNameOcr?.trim() ?? ''
    const normalizedOcr = ocrRaw ? normalizeVendorName(ocrRaw) : ''

    const aliasRows: { vendor_id: number; raw_name: string; source: 'ocr' | 'manual' }[] = []
    if (normalizedOcr) {
      aliasRows.push({ vendor_id: vendorId, raw_name: normalizedOcr, source: 'ocr' })
    }

    // A reviewer correction: vendor_name_verified diverges from vendor_name_ocr.
    const verifiedRaw = params.vendorNameVerified?.trim() ?? ''
    if (verifiedRaw && verifiedRaw !== ocrRaw) {
      const normalizedVerified = normalizeVendorName(verifiedRaw)
      if (normalizedVerified && normalizedVerified !== normalizedOcr) {
        aliasRows.push({ vendor_id: vendorId, raw_name: normalizedVerified, source: 'manual' })
      }
    }

    if (aliasRows.length === 0) return

    const { error: aliasError } = await admin
      .from('vendor_alias')
      .upsert(aliasRows, { onConflict: 'raw_name', ignoreDuplicates: true })

    if (aliasError) {
      logRawError('review.learnVendorAliasesFromAttach', aliasError.message)
    }
  } catch (err) {
    // Never let a learning-step failure surface as an attach failure.
    logRawError('review.learnVendorAliasesFromAttach', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Stage 3 (Classify, §8) persistence: admin head + zone, ridden on the same
 * Cmd/Ctrl-Enter save as everything else (§7's "all three stages commit on
 * the same save" -- see review-workspace.tsx's handleSave). Deliberately
 * NOT saveEntryEnrichment (lib/actions/entry-enrichment.ts): that action
 * unconditionally overwrites cost_center_id and remark on every call, and
 * this screen never touches either -- reusing it would silently clobber
 * whatever an entry's detail page had set.
 */
export async function saveEntryClassification(input: {
  entryId: number
  adminHeadId: number | null
  zoneId: number | null
}): Promise<SimpleActionResult> {
  if (!Number.isInteger(input.entryId)) {
    return { ok: false, error: 'Invalid entry id.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('entries')
    .update({ admin_head_id: input.adminHeadId, zone_id: input.zoneId })
    .eq('id', input.entryId)
    .select('id')

  if (error) return { ok: false, error: logRawError('review.saveEntryClassification', error.message) }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        'No entry was updated. This usually means a viewer role (reviewer/admin required), or the entry is no longer visible to you.',
    }
  }

  revalidatePath('/review')
  return { ok: true }
}

/**
 * Checklist 5.21 (plan §13 V1): "Add a row" in the empty-line-items state.
 * Inserts one blank `document_extraction_line_item` row -- every `_ocr`/
 * `_verified` column left null, only `document_extraction_id` and
 * `line_order` set -- so the reviewer can type straight into a normal row
 * that flows through buildSavePayload/saveVerification unchanged on the next
 * save. A plain session-bound insert, not a SECURITY DEFINER RPC: same shape
 * as flagReviewException's reconciliation_exception insert above -- a
 * single-table write RLS can gate on its own
 * (document_extraction_line_item_insert, new migration, checklist 5.21),
 * with no multi-table concern the way verify_document_extraction has.
 *
 * line_order is computed from a preceding select rather than a single atomic
 * insert-with-subquery -- PostgREST's insert only accepts JSON values, not a
 * SQL subquery expression, so there's no way to do "coalesce(max(line_order),
 * 0) + 1" in one round trip without a dedicated RPC. This document is already
 * claim-locked to one reviewer at a time (§7), so two concurrent "Add a row"
 * calls racing each other here is not a realistic scenario.
 */
export async function addLineItem(
  documentExtractionId: number
): Promise<{ ok: true; lineItem: { id: number; lineOrder: number } } | { ok: false; error: string }> {
  if (!Number.isInteger(documentExtractionId)) {
    return { ok: false, error: 'Invalid document extraction id.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }

  const { data: maxRow, error: maxError } = await supabase
    .from('document_extraction_line_item')
    .select('line_order')
    .eq('document_extraction_id', documentExtractionId)
    .order('line_order', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (maxError) {
    return { ok: false, error: logRawError('review.addLineItem', maxError.message) }
  }

  const nextLineOrder = ((maxRow?.line_order as number | undefined) ?? 0) + 1

  const { data, error } = await supabase
    .from('document_extraction_line_item')
    .insert({ document_extraction_id: documentExtractionId, line_order: nextLineOrder })
    .select('id, line_order')
    .single()

  if (error) {
    return { ok: false, error: logRawError('review.addLineItem', error.message) }
  }

  revalidatePath('/review')
  return { ok: true, lineItem: { id: data.id as number, lineOrder: data.line_order as number } }
}

export interface VendorSearchResult {
  id: number
  displayName: string
  gstin: string | null
}

/**
 * `/` -- vendor autocomplete (§7). Queries `vendor` server-side via ILIKE,
 * which the `vendor_trgm_idx` GIN trigram index (20260808000008) accelerates
 * for `%term%` patterns -- no need to ship the whole table to the client the
 * way components/admin/vendor-merge-panel.tsx does for the (small, curated)
 * admin merge list.
 */
export async function searchReviewVendors(query: string): Promise<VendorSearchResult[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const supabase = await createClient()
  const escaped = trimmed.replace(/[%_]/g, '\\$&')
  const { data, error } = await supabase
    .from('vendor')
    .select('id, display_name, gstin')
    .or(`display_name.ilike.%${escaped}%,normalized_name.ilike.%${escaped.toLowerCase()}%`)
    .order('display_name')
    .limit(15)

  if (error || !data) return []
  return data.map((v) => ({
    id: v.id as number,
    displayName: v.display_name as string,
    gstin: (v.gstin as string | null) ?? null,
  }))
}

/**
 * event-scoping-and-review-fixes-plan.md §2.4: "stop the vendor overwrite."
 * Selecting a vendor from the `/` picker (handleVendorSelect in
 * review-workspace.tsx) no longer overwrites the on-screen OCR vendor name --
 * it only links vendorId. When the reviewer confirms via the resulting
 * "record as another spelling?" dialog, this is the write path: it records
 * the OCR spelling as a `vendor_alias` for the linked vendor, using the exact
 * same convention as learnVendorAliasesFromAttach above (normalized raw_name,
 * admin/service-role client because `vendor_alias` denies inserts to
 * `authenticated` by RLS, `onConflict: 'raw_name', ignoreDuplicates: true` so
 * an existing alias is never repointed to a different vendor). Never touches
 * component state -- the OCR field on screen is left exactly as it was
 * whether the reviewer accepts or declines.
 */
export async function confirmVendorAlias(input: {
  vendorId: number
  rawName: string
}): Promise<SimpleActionResult> {
  if (!Number.isInteger(input.vendorId)) {
    return { ok: false, error: 'Invalid vendor id.' }
  }

  const normalized = normalizeVendorName(input.rawName.trim())
  if (!normalized) return { ok: true }

  const admin = createAdminClient()
  const { error } = await admin
    .from('vendor_alias')
    .upsert({ vendor_id: input.vendorId, raw_name: normalized, source: 'manual' }, { onConflict: 'raw_name', ignoreDuplicates: true })

  if (error) return { ok: false, error: logRawError('review.confirmVendorAlias', error.message) }
  return { ok: true }
}

/**
 * Unverified/All toggle (review-page-layout-redesign-plan.md §1). Persisted as
 * a cookie rather than a `?scope=` query param: review-workspace.tsx's
 * Prev/Next navigation does `router.push('/review?id=${id}')` with no scope
 * param, so a URL-only toggle would silently reset to "pending" on every
 * click. A cookie survives that without touching review-workspace.tsx.
 */
export async function setReviewQueueScope(scope: 'pending' | 'all'): Promise<{ ok: true }> {
  ;(await cookies()).set('review_queue_scope', scope, { path: '/', maxAge: 60 * 60 * 24 * 365 })
  return { ok: true }
}

/**
 * Phase 4 (event-scoping-and-review-fixes-plan.md §2.5): a reviewer manually
 * overriding the model's per-page classification -- skip a page the model
 * kept (skip: true), or unskip one the model dismissed (skip: false, usually
 * followed by `reExtractPage` below to actually OCR it). Writes the SAME
 * columns a fresh model classification would (`is_financial_document`,
 * `skip_reason`), plus `skip_source: 'manual'` so the UI can badge this as a
 * human decision -- `reExtractPageScoped` resets `skip_source` back to
 * 'model' once a fresh model read supersedes it (see that function's doc
 * comment). A plain session-bound update, RLS-gated by the existing
 * `document_page_update` policy (`is_reviewer_or_admin()` +
 * `can_see_source_document()`, 20260808000026_rls_policies.sql) -- no new
 * policy needed, same pattern as saveEntryClassification above.
 */
export async function setPageSkipOverride(input: {
  sourceDocumentId: number
  pageNumber: number
  skip: boolean
}): Promise<SimpleActionResult> {
  if (!Number.isInteger(input.sourceDocumentId) || !Number.isInteger(input.pageNumber)) {
    return { ok: false, error: 'Invalid document or page number.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }

  const { data, error } = await supabase
    .from('document_page')
    .update({
      is_financial_document: !input.skip,
      skip_reason: input.skip ? 'manual' : null,
      skip_source: 'manual',
      manually_set_by: user.id,
      manually_set_at: new Date().toISOString(),
    })
    .eq('source_document_id', input.sourceDocumentId)
    .eq('page_number', input.pageNumber)
    .select('page_number')

  if (error) return { ok: false, error: logRawError('review.setPageSkipOverride', error.message) }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        'No page was updated. This usually means a viewer role (reviewer/admin required), or the page is no longer visible to you.',
    }
  }

  revalidatePath('/review')
  return { ok: true }
}

export type ReExtractPageResult =
  | { ok: true; created: boolean; documentExtractionId: number | null; billCount: number; lineItemCount: number }
  | { ok: false; error: string }

/**
 * Phase 4 §2.5/§2.6: "OCR a page the model skipped" (or re-run a single-page
 * bill's own OCR). Delegates the actual pipeline call + persistence to
 * `reExtractPageScoped` (lib/jobs/handlers/rescope-extract.ts) -- this
 * wrapper only owns the auth gate (same isAdminOrAbove check as the existing
 * whole-document `/api/documents/reescalate` route, since this also runs a
 * paid Claude call through the admin client, bypassing RLS) and cache
 * revalidation. Behaves like a scoped version of the existing "Re-extract"
 * button: on success the caller should `router.refresh()` (see
 * review-workspace.tsx's `handleReExtract`) rather than patch local state --
 * a newly-discovered bill has no prior local state to patch, and an existing
 * single-page bill's full OCR read genuinely does replace everything on
 * screen for it, same as today's whole-document re-extract.
 */
export async function reExtractPage(input: {
  sourceDocumentId: number
  pageNumber: number
}): Promise<ReExtractPageResult> {
  if (!Number.isInteger(input.sourceDocumentId) || !Number.isInteger(input.pageNumber)) {
    return { ok: false, error: 'Invalid document or page number.' }
  }

  const staff = await getStaffContext()
  if (!staff) return { ok: false, error: 'You must be signed in.' }
  if (!staff.isActive) return { ok: false, error: 'Your account is pending activation.' }
  if (!isAdminOrAbove(staff.role)) {
    return { ok: false, error: 'Re-running extraction is an admin action.' }
  }

  try {
    const admin = createAdminClient()
    const result = await reExtractPageScoped(admin, {
      sourceDocumentId: input.sourceDocumentId,
      pageNumber: input.pageNumber,
      triggeredBy: staff.userId,
    })
    revalidatePath('/review')
    return { ok: true, ...result }
  } catch (err) {
    return {
      ok: false,
      error: logRawError('review.reExtractPage', err instanceof Error ? err.message : String(err)),
    }
  }
}

/**
 * Header-only field names `reExtractField` accepts -- a deliberate v1 subset
 * of `UNCERTAIN_FIELD_NAMES` (lib/extraction-schema.ts) that excludes the
 * five `line_item_*` names. A line item's re-read can come back with a
 * different `line_order` than the one already saved (re-extraction has no
 * guarantee of stable ordering across two independent runs), so matching a
 * re-read line item back to the correct existing row is a real design
 * problem this pass does not solve -- surfacing it as a type-level omission
 * here (rather than a runtime check) so the UI (review-workspace.tsx) can
 * only ever offer this for a header field in the first place.
 */
export type ReExtractableHeaderField =
  | 'vendor_name'
  | 'vendor_gstin'
  | 'vendor_phone'
  | 'vendor_email'
  | 'vendor_address'
  | 'invoice_number'
  | 'invoice_date'
  | 'subtotal'
  | 'tax_amount'
  | 'total_amount'

export type ReExtractFieldResult =
  | { ok: true; newValue: string | number | null }
  | { ok: false; error: string }

/**
 * Phase 4 §2.6: re-extract ONE flagged header field, writing back only that
 * field's `_ocr` column. Everything else on the bill -- every other `_ocr`
 * column, every `_verified` column, `current_extraction_run_id`, line items
 * -- is left exactly as it was, which is what lets a reviewer's in-progress,
 * unsaved edits to sibling fields survive this call. That guarantee is why
 * this action deliberately does NOT `revalidatePath`/expect a
 * `router.refresh()` the way every other write action here does: a refresh
 * would re-fetch ReviewDocumentDetail and, because `currentExtractionRunId`
 * is part of the workspace's React `key` (lib/review/types.ts's doc
 * comment), remount the whole form and discard those same unsaved edits --
 * exactly the outcome this feature exists to avoid. The caller
 * (review-workspace.tsx) must instead take `newValue` from the result and
 * patch its own local header state for that one field, the same way
 * `handleAddLineItem` appends to local `lineItems` state without a refresh.
 */
export async function reExtractField(input: {
  documentExtractionId: number
  field: ReExtractableHeaderField
}): Promise<ReExtractFieldResult> {
  if (!Number.isInteger(input.documentExtractionId)) {
    return { ok: false, error: 'Invalid document extraction id.' }
  }

  const staff = await getStaffContext()
  if (!staff) return { ok: false, error: 'You must be signed in.' }
  if (!staff.isActive) return { ok: false, error: 'Your account is pending activation.' }
  if (!isAdminOrAbove(staff.role)) {
    return { ok: false, error: 'Re-running extraction is an admin action.' }
  }

  try {
    const admin = createAdminClient()
    const result = await reExtractFieldScoped(admin, {
      documentExtractionId: input.documentExtractionId,
      field: input.field,
      triggeredBy: staff.userId,
    })
    return { ok: true, newValue: result.newValue }
  } catch (err) {
    return {
      ok: false,
      error: logRawError('review.reExtractField', err instanceof Error ? err.message : String(err)),
    }
  }
}
