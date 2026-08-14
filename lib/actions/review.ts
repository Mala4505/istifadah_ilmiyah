'use server'

/**
 * Server actions backing the /review screen (MASTER-PLAN §7, §11.2 Day 4).
 * `S` (Hub status) reuses lib/actions/hub-status.ts directly, per the task
 * brief -- nothing here duplicates it. `R` (re-extract) posts straight to
 * the existing app/api/documents/reescalate/route.ts from the client --
 * that route already does its own role check, so no wrapper is needed here.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSignedUrl } from '@/lib/storage'

const CLAIM_STALE_AFTER_MS = 15 * 60 * 1000 // §7: "Claims expire after 15 minutes of inactivity"

export interface VerifiedHeaderInput {
  vendor_name: string | null
  vendor_gstin: string | null
  vendor_phone: string | null
  vendor_email: string | null
  vendor_address: string | null
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
  list_rate: number | null
  discount_pct: number | null
  discount_note: string | null
  net_rate: number | null
  line_amount: number | null
}

export interface SaveVerificationInput {
  sourceDocumentId: number
  header: VerifiedHeaderInput
  lineItems: VerifiedLineItemInput[]
  vendorId: number | null
}

export type SimpleActionResult = { ok: true } | { ok: false; error: string }

export type SaveVerificationResult =
  | { ok: true; lineItemsUpdated: number; rateReferenceRowsInserted: number }
  | { ok: false; error: string }

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

  const { data, error } = await supabase
    .rpc('verify_document_extraction', {
      p_source_document_id: input.sourceDocumentId,
      p_header: input.header,
      p_line_items: input.lineItems,
      p_vendor_id: input.vendorId,
    })
    .single()

  if (error) {
    return { ok: false, error: error.message }
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
    return { ok: false, error: readError.message }
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
    return { ok: false, error: updateError.message }
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
    return { ok: false, error: error.message }
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
    return { ok: false, error: error.message }
  }

  revalidatePath('/review')
  revalidatePath('/exceptions')
  return { ok: true }
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
