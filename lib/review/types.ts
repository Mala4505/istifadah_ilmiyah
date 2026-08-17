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
  listRate: { ocr: number | null; verified: number | null }
  discountPct: { ocr: number | null; verified: number | null }
  discountNote: { ocr: string | null; verified: string | null }
  netRate: { ocr: number | null; verified: number | null }
  lineAmount: { ocr: number | null; verified: number | null }
}

export interface HeaderFieldSet<T> {
  vendorName: T
  vendorGstin: T
  vendorPhone: T
  vendorEmail: T
  vendorAddress: T
  invoiceNumber: T
  invoiceDate: T
  subtotal: T
  taxAmount: T
  totalAmount: T
  notes: T
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
}

export interface ReviewDocumentDetail {
  sourceDocumentId: number
  documentExtractionId: number
  originalFilename: string
  matchStatus: string
  entryId: number | null
  entryUbblNumber: string | null
  entryInvoiceNumber: string | null
  entryAmount: number | null
  entryVendorId: number | null
  entryVendorDisplayName: string | null
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
  header: HeaderFieldSet<{ ocr: string | number | null; verified: string | number | null }>
  lineItems: LineItemDetail[]
  pages: PageStatus[]
  openExceptions: OpenExceptionSummary[]
  canSetHubStatus: boolean
  hubStatusCode: string | null
  hubStatusOptions: { id: number; code: string; label: string }[]
}
