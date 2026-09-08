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
import { isSameGstin, validateGstin } from '@/lib/analytics/gstin'
import { serverEnv } from '@/lib/env.server'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { reExtractFieldScoped, reExtractPageScoped } from '@/lib/jobs/handlers/rescope-extract'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'
import { computeMatchCandidates } from '@/lib/review/match-candidates'
import type { MatchCandidate } from '@/lib/review/types'

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
  | {
      ok: true
      lineItemsUpdated: number
      rateReferenceRowsInserted: number
      /** Set when this save created or resolved a vendor from the verified
       *  name because the bill had none linked ("create + link a vendor when
       *  none is linked", 2026-09-07) -- the form uses it to show the link
       *  without a reload. Null when a vendor was already linked or the name
       *  was blank. */
      resolvedVendor: { id: number; displayName: string } | null
    }
  | { ok: false; error: string; conflict?: true }

/**
 * "Create + link a vendor when none is linked" (confirmed with the user
 * 2026-09-07). When a bill is saved with a verified vendor name but no
 * resolved `vendor_id`, apply the schema's documented resolution rule
 * (20260808000008_vendor_and_alias.sql): normalize the name, match it against
 * an existing `vendor.normalized_name` or `vendor_alias.raw_name`, and when
 * nothing matches create a new unconfirmed `vendor` plus its own `manual`
 * alias. Returns the resolved row so this save's `rate_reference` rows get
 * attributed and the Review form can show the link.
 *
 * Admin (service-role) client: `vendor` has no INSERT policy for
 * `authenticated` and `vendor_alias` has no write policy at all
 * (20260808000026_rls_policies.sql) -- same reason learnVendorAliasesFromAttach
 * reaches for it. Best-effort: any failure is logged and returns null rather
 * than failing the whole save.
 */
async function resolveOrCreateVendorForVerifiedName(
  rawName: string
): Promise<{ id: number; displayName: string } | null> {
  const normalized = normalizeVendorName(rawName)
  if (!normalized) return null
  const displayName = rawName.trim()
  try {
    const admin = createAdminClient()

    const [{ data: byName }, { data: byAlias }] = await Promise.all([
      admin.from('vendor').select('id, display_name').eq('normalized_name', normalized).maybeSingle(),
      admin.from('vendor_alias').select('vendor_id').eq('raw_name', normalized).maybeSingle(),
    ])
    if (byName?.id != null) {
      return { id: byName.id as number, displayName: (byName.display_name as string) ?? displayName }
    }
    if (byAlias?.vendor_id != null) {
      const { data: aliased } = await admin
        .from('vendor')
        .select('display_name')
        .eq('id', byAlias.vendor_id as number)
        .maybeSingle()
      return { id: byAlias.vendor_id as number, displayName: (aliased?.display_name as string) ?? displayName }
    }

    const { data: created, error: createError } = await admin
      .from('vendor')
      .insert({ display_name: displayName, normalized_name: normalized, is_confirmed: false })
      .select('id')
      .single()
    if (createError || !created) {
      // A concurrent save for the same new name may have inserted it between
      // the lookup above and here -- re-read on the unique normalized_name
      // before giving up.
      const { data: raced } = await admin
        .from('vendor')
        .select('id, display_name')
        .eq('normalized_name', normalized)
        .maybeSingle()
      if (raced?.id != null) {
        return { id: raced.id as number, displayName: (raced.display_name as string) ?? displayName }
      }
      if (createError) logRawError('review.resolveOrCreateVendorForVerifiedName', createError.message)
      return null
    }

    await admin
      .from('vendor_alias')
      .upsert(
        { vendor_id: created.id as number, raw_name: normalized, source: 'manual' },
        { onConflict: 'raw_name', ignoreDuplicates: true }
      )
    return { id: created.id as number, displayName }
  } catch (err) {
    logRawError('review.resolveOrCreateVendorForVerifiedName', err instanceof Error ? err.message : String(err))
    return null
  }
}

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
  const selectedEvent = await getSelectedEvent()
  if (!isEventMutable(selectedEvent)) {
    return { ok: false, error: 'This event is closed to edits. Switch to the current event to verify documents.' }
  }

  // "Create + link a vendor when none is linked" (2026-09-07): a corrected
  // vendor name on an otherwise-unlinked bill should land in the vendor master
  // -- so future bills from the same vendor resolve automatically and this
  // save's rate_reference rows get attributed. Resolves against an existing
  // vendor first; only creates when nothing matches. Best-effort: a null here
  // just means the save proceeds unattributed, exactly as before.
  let resolvedVendor: { id: number; displayName: string } | null = null
  const verifiedVendorName = input.header.vendor_name?.trim() ?? ''
  if (input.vendorId === null && verifiedVendorName !== '') {
    resolvedVendor = await resolveOrCreateVendorForVerifiedName(verifiedVendorName)
  }
  const effectiveVendorId = input.vendorId ?? resolvedVendor?.id ?? null

  const { data, error } = await supabase
    .rpc('verify_document_extraction', {
      p_document_extraction_id: input.documentExtractionId,
      p_header: input.header,
      p_line_items: input.lineItems,
      p_vendor_id: effectiveVendorId,
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

  // The extract handler raises vendor_gstin_invalid_checksum /
  // vendor_gstin_is_own_org against the OCR value (lib/jobs/handlers/extract.ts);
  // validateGstin/isSameGstin only run in that job, never on the verified
  // value. Once the reviewer has corrected vendor_gstin and saved, close those
  // exceptions here so they don't need a second trip to /exceptions. Only when
  // the corrected value is unambiguously good — present, passes its checksum,
  // and isn't the community's own GSTIN; anything short of that leaves the
  // exception open for a human to judge.
  const verifiedGstin = input.header.vendor_gstin?.trim() ?? ''
  const gstinNowClean =
    verifiedGstin !== '' &&
    validateGstin(verifiedGstin).valid &&
    !(serverEnv.COMMUNITY_GSTIN !== '' && isSameGstin(verifiedGstin, serverEnv.COMMUNITY_GSTIN))
  if (gstinNowClean) {
    await supabase
      .from('reconciliation_exception')
      .update({
        status: 'resolved',
        resolution_note: 'Vendor GSTIN corrected and verified on review.',
        resolved_by: user.id,
        resolved_at: new Date().toISOString(),
      })
      .eq('document_extraction_id', input.documentExtractionId)
      .eq('status', 'open')
      .in('exception_type', ['vendor_gstin_invalid_checksum', 'vendor_gstin_is_own_org'])
  }

  // Same idea for the buyer/recipient GSTIN (2026-09-07): the extract handler
  // keeps a checksum-failing buyer_gstin as-read and flags
  // buyer_gstin_invalid_checksum. Once the reviewer has fixed the character
  // and the verified value passes its checksum, close it here -- no own-org
  // exclusion this time, since the buyer GSTIN is *supposed* to be the
  // community's own.
  const verifiedBuyerGstin = input.header.buyer_gstin?.trim() ?? ''
  if (verifiedBuyerGstin !== '' && validateGstin(verifiedBuyerGstin).valid) {
    await supabase
      .from('reconciliation_exception')
      .update({
        status: 'resolved',
        resolution_note: 'Buyer GSTIN corrected and verified on review.',
        resolved_by: user.id,
        resolved_at: new Date().toISOString(),
      })
      .eq('document_extraction_id', input.documentExtractionId)
      .eq('status', 'open')
      .eq('exception_type', 'buyer_gstin_invalid_checksum')
  }

  revalidatePath('/review')
  // The document inbox renders each bill's verified vendor/amount/invoice
  // values and its "Reviewed" badge straight off this row -- without this it
  // keeps serving the pre-save cached RSC payload until something else
  // revalidates /documents.
  revalidatePath('/documents')

  return {
    ok: true,
    lineItemsUpdated: result?.line_items_updated ?? 0,
    rateReferenceRowsInserted: result?.rate_reference_rows_inserted ?? 0,
    resolvedVendor,
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

  const staleThresholdIso = new Date(Date.now() - CLAIM_STALE_AFTER_MS).toISOString()

  // Hub cert 1.8 ("Race"): a single conditional UPDATE, not a read-then-write
  // -- the old version read claimed_by/claimed_at, decided in JS whether the
  // claim was free, and only then issued an UNCONDITIONAL update, so two
  // reviewers who both read a null/stale claim in the same instant both
  // passed the check and both wrote, each told they'd won. PostgREST ANDs
  // every chained filter and `.or()` groups its own comma-separated
  // conditions, so this compiles to one statement:
  //   UPDATE source_document SET claimed_by = $me, claimed_at = now()
  //   WHERE id = $id AND (claimed_by IS NULL OR claimed_by = $me OR claimed_at < $stale)
  // which is atomic at Postgres's row-lock level: whichever request's UPDATE
  // actually commits first is guaranteed to be the only one that can still
  // see the row as claimable, because the second commits only after the
  // first's row lock releases and re-evaluates the WHERE clause against the
  // first request's own just-written claimed_by. `takeover: true` widens the
  // WHERE to accept ANY current claimant -- the caller only sends that after
  // the reviewer has explicitly confirmed the takeover prompt.
  let query = supabase
    .from('source_document')
    .update({ claimed_by: user.id, claimed_at: new Date().toISOString() })
    .eq('id', sourceDocumentId)

  if (!options.takeover) {
    query = query.or(`claimed_by.is.null,claimed_by.eq.${user.id},claimed_at.lt.${staleThresholdIso}`)
  }

  const { data: claimedRows, error: updateError } = await query.select('id')

  if (updateError) {
    return { ok: false, error: logRawError('review.claimReviewDocument', updateError.message) }
  }

  if (claimedRows && claimedRows.length > 0) {
    return { ok: true, claimedByMe: true }
  }

  // Zero rows updated: either the document doesn't exist/isn't visible to
  // this reviewer, or -- the race window this replaces the old
  // read-then-write with -- someone else's claim won the moment the WHERE
  // clause above was evaluated. Re-read (unconditionally, so it isn't
  // filtered out by the same WHERE that just failed) to tell those apart and
  // to get the current claimant's display name for the takeover prompt. The
  // claimant's display name has to come from the admin client:
  // `staff_profile_select` RLS (20260808000026_rls_policies.sql) only lets a
  // user read their OWN row or an admin read any row -- a plain reviewer
  // cannot select a colleague's profile through the session-bound client.
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

  const admin = createAdminClient()
  const { data: claimant } = claimedBy
    ? await admin.from('staff_profile').select('display_name').eq('id', claimedBy).maybeSingle()
    : { data: null }

  return {
    ok: false,
    needsTakeover: true,
    claimedByDisplayName: (claimant?.display_name as string | undefined) ?? 'another reviewer',
    claimedAt: claimedAt ?? new Date().toISOString(),
  }
}

/**
 * Release (hub-screen-certification.md §3 item 1.8, "Never released"): the
 * counterpart to claimReviewDocument's write, called from
 * review-workspace.tsx's unmount/document-change cleanup so a reviewer who
 * navigates away stops blocking colleagues behind a 15-minute takeover
 * prompt for no reason. Guarded server-side to only clear a claim still held
 * by the CALLING user (`.eq('claimed_by', user.id)`) -- if a takeover already
 * moved the claim to someone else before this fires (a slow unmount racing a
 * colleague's takeover), this must not clear THEIR claim. Best-effort by
 * design: the caller fires this without awaiting it from an effect cleanup,
 * so a failure here only means the claim sits until its own 15-minute
 * staleness window lapses -- exactly today's existing fallback, not a
 * regression.
 */
export async function releaseReviewDocument(sourceDocumentId: number): Promise<SimpleActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }

  const { error } = await supabase
    .from('source_document')
    .update({ claimed_by: null, claimed_at: null })
    .eq('id', sourceDocumentId)
    .eq('claimed_by', user.id)

  if (error) {
    return { ok: false, error: logRawError('review.releaseReviewDocument', error.message) }
  }
  return { ok: true }
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
  // (private.assert_entry_bill_link_allowed re-checks this in SQL too.)
  const selectedEvent = await getSelectedEvent()
  if (!isEventMutable(selectedEvent)) {
    return { ok: false, error: 'This event is closed to edits. Switch to the current event to attach documents.' }
  }

  // entry-bill links (Phase 3): still a single-entry REPLACE for this bill
  // (matches the current combobox's replace-on-click). Phase 5's multi-select
  // combobox switches to addBillEntryLink / detachExtractionFromEntry /
  // setBillEntryLinks. document_extraction.entry_id follows via the mirror
  // trigger.
  const { error } = await supabase.rpc('set_bill_entry_links', {
    p_document_extraction_id: input.documentExtractionId,
    p_entry_ids: [input.entryId],
  })
  if (error) return { ok: false, error: logRawError('review.attachExtractionToEntry', error.message) }

  const { data: bill } = await supabase
    .from('document_extraction')
    .select('vendor_name_ocr, vendor_name_verified')
    .eq('id', input.documentExtractionId)
    .maybeSingle()

  revalidatePath('/review')
  // The inbox's match state / "Connect" column reads this bill's entry_id --
  // revalidate so an attach done from the Review screen is reflected there.
  revalidatePath('/documents')

  // Best-effort learning step -- awaited so it actually runs before this
  // server action returns, but never allowed to turn a successful attach
  // into a failure (see the function's own try/catch).
  await learnVendorAliasesFromAttach({
    entryId: input.entryId,
    vendorNameOcr: (bill?.vendor_name_ocr as string | null) ?? null,
    vendorNameVerified: (bill?.vendor_name_verified as string | null) ?? null,
  })

  return { ok: true }
}

/**
 * entry-bill links: add ONE entry to a bill's link set without disturbing the
 * others (the additive click in Phase 5's multi-select combobox). Keeps the
 * same event guard and vendor-alias learning as attachExtractionToEntry.
 */
export async function addBillEntryLink(input: {
  documentExtractionId: number
  entryId: number
}): Promise<SimpleActionResult> {
  if (!Number.isInteger(input.documentExtractionId) || !Number.isInteger(input.entryId)) {
    return { ok: false, error: 'Invalid document extraction or entry id.' }
  }

  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  if (!isEventMutable(selectedEvent)) {
    return { ok: false, error: 'This event is closed to edits. Switch to the current event to attach documents.' }
  }

  const { error } = await supabase.rpc('add_bill_entry_link', {
    p_document_extraction_id: input.documentExtractionId,
    p_entry_id: input.entryId,
  })
  if (error) return { ok: false, error: logRawError('review.addBillEntryLink', error.message) }

  const { data: bill } = await supabase
    .from('document_extraction')
    .select('vendor_name_ocr, vendor_name_verified')
    .eq('id', input.documentExtractionId)
    .maybeSingle()

  revalidatePath('/review')
  revalidatePath('/documents')

  await learnVendorAliasesFromAttach({
    entryId: input.entryId,
    vendorNameOcr: (bill?.vendor_name_ocr as string | null) ?? null,
    vendorNameVerified: (bill?.vendor_name_verified as string | null) ?? null,
  })

  return { ok: true }
}

/**
 * entry-bill links: remove ONE entry from a bill's link set. The inverse of
 * addBillEntryLink -- the ✕ on a linked row in Phase 5's combobox.
 */
export async function detachExtractionFromEntry(input: {
  documentExtractionId: number
  entryId: number
}): Promise<SimpleActionResult> {
  if (!Number.isInteger(input.documentExtractionId) || !Number.isInteger(input.entryId)) {
    return { ok: false, error: 'Invalid document extraction or entry id.' }
  }

  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  if (!isEventMutable(selectedEvent)) {
    return { ok: false, error: 'This event is closed to edits. Switch to the current event to change links.' }
  }

  const { error } = await supabase.rpc('remove_bill_entry_link', {
    p_document_extraction_id: input.documentExtractionId,
    p_entry_id: input.entryId,
  })
  if (error) return { ok: false, error: logRawError('review.detachExtractionFromEntry', error.message) }

  revalidatePath('/review')
  revalidatePath('/documents')
  return { ok: true }
}

/**
 * entry-bill links: atomically replace a bill's ENTIRE link set (Phase 5's
 * "select every entry under this bill" in one shot).
 */
export async function setBillEntryLinks(input: {
  documentExtractionId: number
  entryIds: number[]
}): Promise<SimpleActionResult> {
  if (!Number.isInteger(input.documentExtractionId)) {
    return { ok: false, error: 'Invalid document extraction id.' }
  }
  const entryIds = (input.entryIds ?? []).filter((id) => Number.isInteger(id) && id > 0)

  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  if (!isEventMutable(selectedEvent)) {
    return { ok: false, error: 'This event is closed to edits. Switch to the current event to change links.' }
  }

  const { error } = await supabase.rpc('set_bill_entry_links', {
    p_document_extraction_id: input.documentExtractionId,
    p_entry_ids: entryIds,
  })
  if (error) return { ok: false, error: logRawError('review.setBillEntryLinks', error.message) }

  revalidatePath('/review')
  revalidatePath('/documents')
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
  subDepartmentId: number | null
}): Promise<SimpleActionResult> {
  if (!Number.isInteger(input.entryId)) {
    return { ok: false, error: 'Invalid entry id.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('entries')
    .update({ admin_head_id: input.adminHeadId, zone_id: input.zoneId, sub_department_id: input.subDepartmentId })
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
  revalidatePath('/entries')
  revalidatePath(`/entries/${input.entryId}`)
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
 * Live re-tally of the Connect step's suggestions (2026-09-07). The page
 * load computes these once from the bill's OCR'd fields; this recomputes
 * them from the *current* Verify-step vendor + total + date whenever the
 * reviewer changes any of those, so a fixed vendor name or corrected total
 * immediately re-ranks the ledger instead of waiting for a full reload.
 * Runs the identical `computeMatchCandidates` pipeline the page load uses.
 *
 * Session-scoped `createClient` (RLS-enforced): the caller can only ever
 * rank against entries their own role may see. Returns an empty list once
 * the bill is attached — there is nothing left to suggest.
 */
export async function refreshMatchCandidates(input: {
  documentExtractionId: number
  vendorId: number | null
  vendorName: string | null
  totalAmount: number | null
  invoiceDate: string | null
  invoiceNumber: string | null
}): Promise<{ ok: true; candidates: MatchCandidate[] } | { ok: false; error: string }> {
  const supabase = await createClient()

  const { data: extraction, error } = await supabase
    .from('document_extraction')
    .select('id, entry_id')
    .eq('id', input.documentExtractionId)
    .maybeSingle()

  if (error) return { ok: false, error: logRawError('review.refreshMatchCandidates', error.message) }
  if (!extraction) return { ok: false, error: 'That bill no longer exists.' }
  if ((extraction.entry_id as number | null) !== null) return { ok: true, candidates: [] }

  const selectedEventId = (await getSelectedEvent())?.id ?? null

  try {
    const candidates = await computeMatchCandidates(
      supabase,
      {
        vendorId: input.vendorId,
        vendorName: input.vendorName,
        totalAmount: input.totalAmount,
        invoiceDate: input.invoiceDate,
        invoiceNumber: input.invoiceNumber,
      },
      selectedEventId,
    )
    return { ok: true, candidates }
  } catch (err) {
    return {
      ok: false,
      error: logRawError('review.refreshMatchCandidates', err instanceof Error ? err.message : String(err)),
    }
  }
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
 * Superadmin-only reviewer filter for the /review queue (document-assignment,
 * 2026-08-29). Same cookie-not-query-param reasoning as setReviewQueueScope
 * above -- review-workspace.tsx's Prev/Next carries no params, so a URL-only
 * filter would reset on every click. `null` (or '') clears the filter, i.e.
 * back to "All reviewers". app/(app)/review/page.tsx reads the cookie and,
 * when set, keeps only queue rows whose source_document is assigned to that
 * staff id.
 */
export async function setReviewQueueAssignee(value: string | null): Promise<{ ok: true }> {
  const jar = await cookies()
  if (value) {
    jar.set('review_queue_assignee', value, { path: '/', maxAge: 60 * 60 * 24 * 365 })
  } else {
    jar.delete('review_queue_assignee')
  }
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
 *
 * Bug found in a later session review (2026-08-22): skip: true used to only
 * touch document_page, so a page that had already produced a bill kept that
 * bill fully live in document_extraction -- dimmed thumbnail, unchanged
 * review queue. Fixed below by deleting the bill this page already produced
 * (single-page bills only -- a page inside an existing multi-page bill is
 * left alone, same "out of scope, don't partially unwind a shared bill"
 * reasoning `reExtractPageScoped` already applies). Needs the new
 * `document_extraction_delete` RLS policy (20260822000009) --
 * document_extraction had select/update policies only before this.
 * document_extraction_line_item and reconciliation_exception both
 * cascade-delete off document_extraction_id, so the bill's line items and
 * any exceptions raised against it (e.g. gst_recipient_compliance_missing)
 * go with it automatically. The one thing that does NOT cascade is
 * rate_reference.line_item_id (`on delete no action`, by design -- it is a
 * persistent rate-benchmark table, not meant to silently lose history) --
 * if this bill was already verified and saved once, a rate_reference row
 * may already reference one of its line items, and the delete below fails
 * with a foreign-key violation. Treated as a real "can't do this" case, not
 * a bug: caught specifically so the reviewer gets a plain-English reason
 * instead of a raw Postgres error, and the page's own skip flag is
 * deliberately NOT applied when this happens -- a visual-only skip with the
 * bill still live underneath is exactly the bug this fix exists to close,
 * so failing the whole action here is more honest than a partial one.
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

  if (input.skip) {
    const { data: existingBills, error: existingBillsError } = await supabase
      .from('document_extraction')
      .select('id, page_number_start, page_number_end')
      .eq('source_document_id', input.sourceDocumentId)

    if (existingBillsError) {
      return { ok: false, error: logRawError('review.setPageSkipOverride', existingBillsError.message) }
    }

    const containingBill = (existingBills ?? []).find(
      (b) => (b.page_number_start as number) <= input.pageNumber && input.pageNumber <= (b.page_number_end as number)
    )

    // Only a bill made up of exactly this one page is safe to remove here --
    // a multi-page bill's other pages are still real, so this page's own
    // skip toggle is applied (below) without touching that shared bill.
    if (containingBill && containingBill.page_number_start === containingBill.page_number_end) {
      const { error: deleteError } = await supabase.from('document_extraction').delete().eq('id', containingBill.id)

      if (deleteError) {
        if (deleteError.code === '23503') {
          return {
            ok: false,
            error:
              'This page already produced a bill that has been reviewed and saved, and rate data from it ' +
              'is now referenced elsewhere -- it can\'t be removed automatically. Ask an admin to remove it.',
          }
        }
        return { ok: false, error: logRawError('review.setPageSkipOverride', deleteError.message) }
      }
    }
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
 * would re-fetch ReviewDocumentDetail with a bumped `currentExtractionRunId`,
 * which review-workspace.tsx's 5.7 reset-on-prop-change block (perf
 * remediation, docs/performance-remediation-plan.md) treats the same as a
 * fresh extraction and would reset every field back to its OCR baseline --
 * discarding those same unsaved edits, exactly the outcome this feature
 * exists to avoid. The caller
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
