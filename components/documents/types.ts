/** Shared types for the /documents inbox (MASTER-PLAN §5 row 6, §11.2 Day 3). */

export interface DocumentExtractionSummary {
  vendorNameOcr: string | null
  invoiceDateOcr: string | null
  invoiceNumberOcr: string | null
  totalAmountOcr: number | null
}

export interface CandidateEntryView {
  entryId: number
  score: number
  vendorRaw: string | null
  amount: number | null
  date: string | null
  ubblNumber: string
  mainNumber: string | null
  departmentName: string | null
}

export interface InboxDocumentView {
  id: number
  originalFilename: string
  uploadStatus: 'uploaded' | 'processing' | 'processed' | 'failed'
  matchStatus: 'unmatched' | 'suggested' | 'matched' | 'no_entry_expected'
  uploadedAt: string
  pageCount: number | null
  extraction: DocumentExtractionSummary | null
  candidates: CandidateEntryView[]
}
