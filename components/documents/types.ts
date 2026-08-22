/** Shared types for the /documents inbox (MASTER-PLAN §5 row 6, §11.2 Day 3). */

export interface CandidateEntryView {
  entryId: number
  score: number
  vendorRaw: string | null
  amount: number | null
  date: string | null
  ubblNumber: string
  mainNumber: string | null
  departmentName: string | null
  /**
   * Carried alongside `departmentName` (a display string) so the
   * attach-time zone/admin-head prompt (checklist 5.11, plan §8 Z2) can
   * scope its dropdown options and pre-fill lookup without a second
   * round trip — `departmentName` alone isn't enough to filter
   * department-scoped admin_head/zone rows by id.
   */
  entryDepartmentId: number | null
  adminHeadId: number | null
  zoneId: number | null
}

/**
 * One bill within a `source_document` — `document_extraction` became 1:many
 * per document in `20260817000002_document_extraction_multi_bill.sql` (a
 * single scanned PDF can contain several distinct bills). `candidates` is
 * ranked against this bill's own OCR fields, not the document's, so a
 * multi-bill PDF doesn't rank every bill against whichever one happened to
 * be extracted last.
 */
export interface DocumentExtractionSummary {
  id: number
  billIndex: number
  vendorNameOcr: string | null
  invoiceDateOcr: string | null
  invoiceNumberOcr: string | null
  totalAmountOcr: number | null
  /**
   * `document_extraction.verified_at` — set by the Review screen on every
   * save (`/review?id=<bill_id>`, reachable pre-attach from this bill's own
   * "Correct the extracted fields in Review" link). Non-null here is a real,
   * expected state for a still-unmatched document, not a data anomaly — a
   * bill can be reviewed before its document is ever attached to an entry.
   */
  verifiedAt: string | null
  candidates: CandidateEntryView[]
}

export interface InboxDocumentView {
  id: number
  originalFilename: string
  uploadStatus: 'uploaded' | 'processing' | 'processed' | 'failed'
  matchStatus: 'unmatched' | 'suggested' | 'matched' | 'no_entry_expected' | 'canceled'
  uploadedAt: string
  pageCount: number | null
  /** One entry per bill extracted from this document, ordered by `bill_index`. Empty until extraction finishes. */
  extraction: DocumentExtractionSummary[]
  /** Latest `ocr_extraction_run.error_message` for this document — populated only when `uploadStatus` is `'failed'`. */
  failureReason: string | null
}
