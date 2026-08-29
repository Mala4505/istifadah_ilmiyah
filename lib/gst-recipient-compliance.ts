/**
 * GST recipient-compliance check (redesign plan §12).
 *
 * Pure, no I/O, deterministic — same class of function as
 * lib/analytics/gstin.ts, and exercised the same way in
 * test/unit/gst-recipient-compliance.test.ts.
 *
 * Under GST rules, a valid tax invoice a registered recipient can claim
 * input tax credit against must show the recipient's name, GSTIN, and the
 * invoice number — not just the seller's details. Separately, the community
 * requires its own GSTIN and name to appear on *every* bill it files, tax
 * or not. This module decides, from already-extracted fields, which of
 * buyer GSTIN / buyer name / invoice number are missing on a given bill and
 * whether GST is charged on it, so the caller can raise the ITC rule at
 * `high` severity and the always-on identity rule at `low`. The model
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
  /**
   * True when GST is actually charged on this bill (any tax component present
   * and non-zero, or instrument_type === 'tax_invoice'). Distinguishes the
   * two rules the caller enforces at different severities:
   *   - taxInvoice true  → the ITC rule: buyer GSTIN + buyer name + invoice
   *     number must all be present and correct, raised `high`.
   *   - taxInvoice false → the always-on recipient-identity rule: our own
   *     GSTIN and name must still appear on every bill, raised `low`.
   */
  taxInvoice: boolean
  /**
   * Which required items fail their check. buyer_gstin / buyer_name are
   * evaluated on every bill; invoice_number only when `taxInvoice` is true
   * (its presence is an ITC-claim requirement, not part of always-on
   * recipient identity). Under the always-on rule an item is only reported
   * when there is a configured community target to check it against —
   * under the tax-invoice rule an unconfigured target still counts as
   * missing (there is no known value to confirm, so the bill can't be shown
   * compliant). Empty array = compliant for whichever rule applies.
   */
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
 * Decides which of buyer GSTIN / buyer name / invoice number fail their check
 * on a bill, and whether GST is charged on it (`taxInvoice`) so the caller
 * can pick the right severity.
 *
 * Two rules, both evaluated here (redesign plan §12; recipient-identity
 * expansion confirmed with the user 2026-08-29):
 *
 *   1. Always-on recipient identity — our own GSTIN and name must appear on
 *      *every* bill, tax or not. buyer_gstin / buyer_name are checked on
 *      every call. An item is only reported when there is a configured
 *      community target to check against (communityGstin / communityName
 *      non-null): with no known value there is nothing to assert against a
 *      non-tax bill.
 *
 *   2. Tax-invoice ITC rule — when `taxInvoice` is true (any of
 *      cgst/sgst/igst/tax_amount present and non-zero, OR instrument_type ===
 *      'tax_invoice'), invoice_number is additionally required, and an
 *      unconfigured community target still counts as missing (there is no
 *      known value to confirm the bill against, so it can't be shown
 *      compliant).
 *
 * Each item is checked independently — a bill can fail all three, some, or
 * none. Match logic:
 *   - buyer_gstin: present AND matches communityGstin (isSameGstin).
 *   - buyer_name: present AND fuzzy-matches communityName at or above
 *     BUYER_NAME_SIMILARITY_THRESHOLD (vendorSimilarity).
 *   - invoice_number: present (no match target — genuinely bill-specific).
 */
export function checkGstRecipientCompliance(
  input: GstRecipientComplianceInput
): GstRecipientComplianceResult {
  const taxInvoice =
    hasNonZeroAmount(input.cgstAmount) ||
    hasNonZeroAmount(input.sgstAmount) ||
    hasNonZeroAmount(input.igstAmount) ||
    hasNonZeroAmount(input.taxAmount) ||
    input.instrumentType === 'tax_invoice'

  const missing: GstComplianceMissingItem[] = []

  const buyerGstinOk =
    isPresent(input.buyerGstin) &&
    isPresent(input.communityGstin) &&
    isSameGstin(input.buyerGstin, input.communityGstin)
  // On a tax invoice the item is always asserted (an unconfigured target
  // can't clear it). On a non-tax bill it's only asserted when we have a
  // configured GSTIN to compare against.
  if (!buyerGstinOk && (taxInvoice || isPresent(input.communityGstin))) missing.push('buyer_gstin')

  const buyerNameOk =
    isPresent(input.buyerName) &&
    isPresent(input.communityName) &&
    vendorSimilarity(input.buyerName, input.communityName) >= BUYER_NAME_SIMILARITY_THRESHOLD
  if (!buyerNameOk && (taxInvoice || isPresent(input.communityName))) missing.push('buyer_name')

  if (taxInvoice && !isPresent(input.invoiceNumber)) missing.push('invoice_number')

  return { taxInvoice, missing }
}
