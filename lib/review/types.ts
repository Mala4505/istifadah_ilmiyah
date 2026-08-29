/**
 * Shared shapes between app/(app)/review/page.tsx (server) and
 * components/review/* (client) -- MASTER-PLAN §7, §11.2 Day 4.
 */

export type ConfidenceTint = 'green' | 'amber' | 'red' | 'none'

/** Green ≥0.9, amber 0.7-0.9, red <0.7 (§7). One tint per document -- confidence is
 * stored per `ocr_extraction_run`, not per field (§3.8's schema note). */
export function confidenceTint(confidence: number | null): ConfidenceTint {
  if (confidence === null) return 'none'
  if (confidence >= 0.9) return 'green'
  if (confidence >= 0.7) return 'amber'
  return 'red'
}

export interface QueueEntry {
  sourceDocumentId: number
  documentExtractionId: number
  originalFilename: string
  extractionConfidence: number | null
  maxOpenSeverityRank: number
  openIssueCount: number
  queueAmount: number | null
  billIndex: number
  billCount: number
}

export interface LineItemDetail {
  id: number
  lineOrder: number
  description: { ocr: string | null; verified: string | null }
  hsnSacCode: { ocr: string | null; verified: string | null }
  quantity: { ocr: number | null; verified: number | null }
  quantityRawText: { ocr: string | null; verified: string | null }
  unit: { ocr: string | null; verified: string | null }
  unitNormalized: string | null
  rate: { ocr: number | null; verified: number | null }
  discount: { ocr: string | null; verified: string | null }
  amount: { ocr: number | null; verified: number | null }
}

export interface HeaderFieldSet<T> {
  vendorName: T
  vendorGstin: T
  vendorPhone: T
  vendorEmail: T
  vendorAddress: T
  /** Recipient/"Bill To" block -- plan §12. Rendered on every bill
   *  (recipient-identity expansion, 2026-08-29); `gstCharged` only varies
   *  the block's helper text now. */
  buyerGstin: T
  buyerName: T
  invoiceNumber: T
  invoiceDate: T
  subtotal: T
  taxAmount: T
  totalAmount: T
  notes: T
}

/**
 * One field the model transcribed but doubts (`document_extraction.uncertain_fields_ocr`,
 * mirrors `ExtractionUncertainField` in lib/extraction-schema.ts field-for-field).
 * `bbox_*` are fractions (0-1) of the source page's full width/height, not pixels —
 * `components/review/pdf-viewer.tsx` converts to on-screen pixels at whatever
 * scale/rotation it's currently rendering.
 */
export interface UncertainField {
  field: string
  lineOrder: number | null
  pageNumber: number
  bboxX0: number
  bboxY0: number
  bboxX1: number
  bboxY1: number
}

export interface OpenExceptionSummary {
  id: number
  exceptionType: string
  severity: 'low' | 'medium' | 'high'
  description: string | null
  createdAt: string
}

/** Per-page classification verdict from `document_page` (written by the extract
 * job, lib/jobs/handlers/extract.ts) -- surfaced here so the review UI can show
 * which pages were skipped and why, instead of silently dropping them from the
 * extraction with no visible record. */
export interface PageStatus {
  pageNumber: number
  isFinancialDocument: boolean | null
  skipReason: string | null
  classificationConfidence: number | null
  /** Phase 4 (§2.5): 'manual' once a reviewer has explicitly set this page's
   *  skip state via setPageSkipOverride (lib/actions/review.ts) -- 'model'
   *  is both the default and what a fresh classification (including a
   *  scoped re-OCR, §2.6) resets it back to. */
  skipSource: 'model' | 'manual'
  /** True once every bill whose page_number_start..page_number_end range
   *  covers this page has verified_at set -- i.e. this page's own review
   *  work (whichever document_extraction(s) it belongs to) is done.
   *  Computed in page.tsx from the sibling-bills query, not stored on
   *  document_page itself (a page has no single verified state of its own;
   *  it inherits one from whichever bill(s) span it). */
  verified: boolean
}

/** A ranked ledger-entry candidate for a still-unmatched bill, scored by
 * `lib/matching.ts`'s `rankCandidates` against this bill's own OCR'd
 * vendor/amount/date (MASTER-PLAN §7, "suggested" match state). */
export interface MatchCandidate {
  entryId: number
  score: number
  vendorRaw: string | null
  amount: number | null
  date: string | null
  ubblNumber: string
  mainNumber: string | null
  /** So the Connect step can show which department a candidate belongs to
   *  while a reviewer is still picking among several similar-looking
   *  entries -- null when the entry's department has no name resolvable
   *  (see the resolution site for why that can happen). */
  departmentName: string | null
}

/** One sibling bill from the same multi-bill PDF, for the bill rail (§7).
 * `matched` reflects only `document_extraction.entry_id` -- the same
 * per-bill signal `EntryAttachCombobox` reads/writes. `verifiedAt` mirrors
 * `document_extraction.verified_at` -- 2.3: lets review-workspace.tsx find
 * the next unverified sibling in this document for Save to advance to,
 * without depending on the (possibly filtered) review queue. */
export interface SiblingBill {
  documentExtractionId: number
  billIndex: number
  matched: boolean
  verifiedAt: string | null
  /** This bill's own page range within the shared source PDF -- lets the PDF
   *  viewer's thumbnail rail (which shows every page of the source document,
   *  not just this bill's own pages) work out which sibling bill owns a page
   *  a reviewer clicks, so selecting it can switch the whole workspace to
   *  that bill instead of just scrolling the canvas to a page whose OCR data
   *  isn't the one on screen. */
  pageNumberStart: number | null
  pageNumberEnd: number | null
}

export interface ReviewDocumentDetail {
  sourceDocumentId: number
  documentExtractionId: number
  billIndex: number
  billCount: number
  pageNumberStart: number | null
  pageNumberEnd: number | null
  originalFilename: string
  matchStatus: string
  entryId: number | null
  entryUbblNumber: string | null
  entryInvoiceNumber: string | null
  entryAmount: number | null
  entryVendorId: number | null
  /** Populated only when `entryId !== null` -- the matched entry's
   * department, and stage-3 (Classify) options scoped to that department
   * (same pattern as app/(app)/entries/[id]/page.tsx). */
  entryDepartmentId: number | null
  /** Resolved alongside entryDepartmentId -- shown in the Connect segment
   *  once a bill is matched, replacing the vendor name/variance shown
   *  beforehand (plan: department is the more useful glance-check once a
   *  match is made). Null when the department has no name resolvable for
   *  the selected event (same event-scoped rule as MatchCandidate's own
   *  departmentName). */
  entryDepartmentName: string | null
  entryAdminHeadId: number | null
  entryZoneId: number | null
  entrySubDepartmentId: number | null
  adminHeadOptions: { id: number; head_number: number; name: string }[]
  zoneOptions: { id: number; zone_number: number; name: string }[]
  subDepartmentOptions: { id: number; name: string }[]
  /** Ranked suggestions when this bill has no ledger match yet; empty
   * (never computed) once `entryId !== null`. */
  matchCandidates: MatchCandidate[]
  /** Every bill sharing this source_document_id, including this one, for
   * the bill rail on multi-bill PDFs. Empty when `billCount === 1`. */
  siblingBills: SiblingBill[]
  claimedBy: string | null
  claimedAt: string | null
  claimedByIsMe: boolean
  currentUserId: string
  /** Changes on every `R` re-extraction -- used as part of the React `key` in
   * page.tsx so a re-run remounts the workspace with fresh form state instead
   * of stale local state fighting new server props. */
  currentExtractionRunId: number | null
  extractionConfidence: number | null
  legibility: 'clear' | 'partial' | 'poor' | null
  model: string | null
  verifiedAt: string | null
  /** Plan §12: whether GST is charged on this bill (any of cgst/sgst/igst/
   *  tax_amount present and non-zero, or instrument_type_ocr === 'tax_invoice').
   *  Drives whether the buyer GSTIN/name fields and the recipient-compliance
   *  exception have anything to show -- both stay genuinely absent, not just
   *  hidden, when this is false (plan §12: "nothing about it appears anywhere
   *  in the UI"). */
  gstCharged: boolean
  header: HeaderFieldSet<{ ocr: string | number | null; verified: string | number | null }>
  lineItems: LineItemDetail[]
  uncertainFields: UncertainField[]
  pages: PageStatus[]
  openExceptions: OpenExceptionSummary[]
  canSetHubStatus: boolean
  hubStatusCode: string | null
  hubStatusOptions: { id: number; code: string; label: string }[]
}
