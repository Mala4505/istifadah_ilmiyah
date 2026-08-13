/**
 * Shared shapes for the Phase 2 analytics engine (MASTER-PLAN §14, §18).
 *
 * Detectors are pure functions: facts in, flag proposals out. No I/O, no
 * database access, no clock reads except the one passed in. That is what makes
 * them testable against the real corpus without a database, and it is why
 * flags-run is a thin gather-then-write shell around them.
 */

/** Instrument types, mirroring the check constraint in 20260814000002. */
export type InstrumentType =
  | 'tax_invoice'
  | 'bill_of_supply'
  | 'retail_cash_memo'
  | 'letterhead_bill'
  | 'proforma_invoice'
  | 'quotation'
  | 'receipt'
  | 'delivery_challan'
  | 'other'

/** Flag types, mirroring the check constraint in 20260814000003. */
export type FlagType =
  | 'vendor_cluster'
  | 'duplicate_payment'
  | 'rate_drift'
  | 'discount_inconsistency'
  | 'missing_documentation'
  | 'vendor_splitting'
  | 'rate_above_benchmark'
  | 'gst_not_charged'
  | 'gstin_invalid'
  | 'gstin_missing'
  | 'gst_type_mismatch'
  | 'gst_rate_anomaly'
  | 'tax_math_mismatch'
  | 'tds_threshold'

export type Severity = 'low' | 'medium' | 'high'

/** Per-component GST, as stored in document_extraction.tax_breakdown. */
export interface TaxComponent {
  rate: number | null
  amount: number | null
}

export interface TaxBreakdown {
  cgst?: TaxComponent | null
  sgst?: TaxComponent | null
  igst?: TaxComponent | null
  cess?: TaxComponent | null
}

/**
 * One verified document, flattened to exactly what the detectors read.
 *
 * Every money field is nullable because every one of them is genuinely absent on
 * some real document in the corpus — a handwritten cash memo has no subtotal, a
 * letterhead bill has no tax line, a bill of supply has no GSTIN. Detectors must
 * abstain on absent data rather than treat null as zero; a flag raised because a
 * field was never captured is indistinguishable, to the reviewer, from a flag
 * raised because something is wrong, and it is the fastest way to erode trust in
 * the queue.
 */
export interface DocumentFacts {
  documentExtractionId: number
  sourceDocumentId: number
  entryId: number | null
  vendorId: number | null
  vendorName: string | null
  vendorGstin: string | null
  invoiceNumber: string | null
  /** ISO yyyy-mm-dd. */
  invoiceDate: string | null
  instrumentType: InstrumentType | null
  subtotal: number | null
  taxAmount: number | null
  totalAmount: number | null
  roundOff: number | null
  taxBreakdown: TaxBreakdown | null
  /** Two-digit GST state code, already resolved from the printed place of supply. */
  placeOfSupplyStateCode: string | null
  /** Whether a human has verified this extraction. Detectors only run on verified rows. */
  verifiedAt: string | null
}

/** One payment/bill against a vendor, for the aggregate detectors. */
export interface VendorPayment {
  entryId: number | null
  documentExtractionId: number | null
  invoiceNumber: string | null
  invoiceDate: string | null
  amount: number
  instrumentType: InstrumentType | null
}

export interface VendorFacts {
  vendorId: number
  displayName: string
  gstin: string | null
  /** True when the vendor is a natural person / HUF — changes the TDS rate. */
  isIndividual: boolean | null
  payments: VendorPayment[]
}

/**
 * A detector's output. Maps 1:1 onto the arguments of public.upsert_flag
 * (20260814000003), so flags-run does no translation beyond snake-casing.
 *
 * `dedupKey` is the contract that makes re-running safe: it must be derived
 * purely from the facts that identify the finding, never from the run, the
 * clock, or a row id that could change. Get it wrong and either every run
 * inserts duplicates, or a reviewer's dismissal is silently resurrected.
 */
export interface FlagProposal {
  flagType: FlagType
  dedupKey: string
  description: string
  severity: Severity
  entryId?: number | null
  relatedEntryIds?: number[] | null
  vendorId?: number | null
  amountAtRisk?: number | null
  evidence?: Record<string, unknown> | null
}
