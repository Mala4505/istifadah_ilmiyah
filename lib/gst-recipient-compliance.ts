/**
 * GST recipient-compliance check (redesign plan §12).
 *
 * Pure, no I/O, deterministic — same class of function as
 * lib/analytics/gstin.ts, and exercised the same way in
 * test/unit/gst-recipient-compliance.test.ts.
 *
 * Under GST rules, a valid tax invoice a registered recipient can claim
 * input tax credit against must show the recipient's name, GSTIN, and the
 * invoice number — not just the seller's details. This module decides,
 * from already-extracted fields, whether that requirement is triggered on a
 * given bill and, if so, which of the three items are missing. The model
 * only writes what it read (or blank) into buyer_gstin/buyer_name — mirroring
 * isOwnOrgGstin/validateGstin in lib/analytics/gstin.ts and
 * lib/jobs/handlers/extract.ts, the compliance *decision* itself stays here
 * as deterministic code, never a model judgment call.
 */

import { isSameGstin } from '@/lib/analytics/gstin'
import { vendorSimilarity } from '@/lib/matching'

/**
 * Fuzzy buyer-name match threshold, applied to `vendorSimilarity` (bigram
 * Dice coefficient over `normalizeVendorName` output, lib/matching.ts).
 *
 * Chosen and verified (test/unit/gst-recipient-compliance.test.ts) against
 * realistic variants of one real community name from the pilot corpus,
 * "Dawat e Hadiyah" (see REAL_GSTINS.dawatEHadiyah, test/unit/gstin.test.ts —
 * the same organization is the *buyer* on nearly every invoice in the
 * corpus, which is exactly the case this check exists for):
 *   - "Dawat e Hadiyah" vs "Dawat-e-Hadiyah Trust" scores ~0.82 (nb is na
 *     plus a trailing "trust" token that survives normalizeVendorName,
 *     since "trust" isn't a stripped legal suffix) — the extra token still
 *     leaves every one of na's bigrams intact inside nb.
 *   - "Dawat e Hadiyah" vs "DAWAT E HADIYAH" scores 1 (case-only difference,
 *     collapsed by normalizeVendorName before comparison).
 *   - "Dawat e Hadiyah" vs an unrelated vendor name (e.g. "Adinath Furniture
 *     Pvt Ltd") scores near 0 — no shared bigrams once each name is reduced
 *     to its own distinct set of tokens.
 * 0.5 sits comfortably below the ~0.82 floor of a genuine variant and far
 * above the near-0 ceiling of an unrelated name, so it isn't a close call in
 * either direction.
 */
const BUYER_NAME_SIMILARITY_THRESHOLD = 0.5

export interface GstRecipientComplianceInput {
  /** The value about to be written to buyer_gstin_ocr — already run through
   *  the checksum guard in lib/jobs/handlers/extract.ts, so a checksum
   *  failure arrives here as null, same as a field the model left blank. */
  buyerGstin: string | null
  buyerName: string | null
  /** bill.invoice_number */
  invoiceNumber: string | null
  /** serverEnv.COMMUNITY_GSTIN || null */
  communityGstin: string | null
  /** serverEnv.COMMUNITY_NAME || null */
  communityName: string | null
  cgstAmount: number | null
  sgstAmount: number | null
  igstAmount: number | null
  taxAmount: number | null
  instrumentType: string | null
}

export type GstComplianceMissingItem = 'buyer_gstin' | 'buyer_name' | 'invoice_number'

export interface GstRecipientComplianceResult {
  triggered: boolean
  missing: GstComplianceMissingItem[]
}

function isPresent(value: string | null): value is string {
  return value !== null && value.trim() !== ''
}

/**
 * Whether any GST amount field is present and non-zero. `0` and `null` both
 * count as "not charged" — a zero-rated line still needs no recipient
 * details, and this mirrors the trigger condition's own "present and
 * non-zero" wording (redesign plan §12).
 */
function hasNonZeroAmount(value: number | null): boolean {
  return value !== null && value !== 0
}

/**
 * Decides whether the GST recipient-compliance check applies to a bill and,
 * if so, which of buyer GSTIN / buyer name / invoice number are missing.
 *
 * Trigger condition (redesign plan §12, locked): any of
 * cgst/sgst/igst/tax_amount present and non-zero, OR instrument_type ===
 * 'tax_invoice'. When neither holds, the check does not run at all —
 * `{ triggered: false, missing: [] }`, nothing else evaluated.
 *
 * When triggered, all three are checked independently (missing any one is
 * enough to add it to `missing`; a bill can be missing all three, some, or
 * none):
 *   - buyer_gstin: present AND matches communityGstin (isSameGstin).
 *   - buyer_name: present AND fuzzy-matches communityName at or above
 *     BUYER_NAME_SIMILARITY_THRESHOLD (vendorSimilarity).
 *   - invoice_number: present (no match target — the invoice number is
 *     genuinely bill-specific).
 * communityGstin/communityName unset (empty COMMUNITY_GSTIN/COMMUNITY_NAME,
 * mapped to null by the caller) means those two checks can never pass while
 * triggered — there is no known value to confirm against, so buyer_gstin/
 * buyer_name are always reported missing in that case regardless of what
 * was read off the page.
 */
export function checkGstRecipientCompliance(
  input: GstRecipientComplianceInput
): GstRecipientComplianceResult {
  const triggered =
    hasNonZeroAmount(input.cgstAmount) ||
    hasNonZeroAmount(input.sgstAmount) ||
    hasNonZeroAmount(input.igstAmount) ||
    hasNonZeroAmount(input.taxAmount) ||
    input.instrumentType === 'tax_invoice'

  if (!triggered) return { triggered: false, missing: [] }

  const missing: GstComplianceMissingItem[] = []

  const buyerGstinOk =
    isPresent(input.buyerGstin) &&
    isPresent(input.communityGstin) &&
    isSameGstin(input.buyerGstin, input.communityGstin)
  if (!buyerGstinOk) missing.push('buyer_gstin')

  const buyerNameOk =
    isPresent(input.buyerName) &&
    isPresent(input.communityName) &&
    vendorSimilarity(input.buyerName, input.communityName) >= BUYER_NAME_SIMILARITY_THRESHOLD
  if (!buyerNameOk) missing.push('buyer_name')

  if (!isPresent(input.invoiceNumber)) missing.push('invoice_number')

  return { triggered: true, missing }
}
