/**
 * Data-access layer for the analytics engine — turns database rows into the
 * flat `DocumentFacts` / `VendorFacts` shapes the pure detectors in
 * lib/analytics/rules/ read (lib/analytics/types.ts).
 *
 * Kept separate from the detectors on purpose: everything in rules/ is a pure
 * function tested against hand-built fixtures with no database involved. This
 * file is the (untested-by-unit-test, same as lib/jobs/handlers/extract.ts)
 * seam where Supabase rows get mapped onto those fixtures' shape for real.
 */

import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { stateCodeFromName } from '@/lib/analytics/gstin'
import type {
  DocumentFacts,
  InstrumentType,
  TaxBreakdown,
  VendorFacts,
  VendorPayment,
} from '@/lib/analytics/types'

type AdminClient = SupabaseClient

/** `_verified` wins when present, per the twin-column convention (§9.2). */
function preferVerified<T>(verified: T | null | undefined, ocr: T | null | undefined): T | null {
  return verified ?? ocr ?? null
}

/**
 * Every verified document_extraction, flattened to what the compliance
 * detectors read. Only verified rows are fetched at all — runComplianceDetectors
 * would skip unverified ones anyway, and there is no reason to pull rows across
 * the wire just to discard them.
 */
export async function fetchDocumentFacts(admin: AdminClient): Promise<DocumentFacts[]> {
  const { data, error } = await admin
    .from('document_extraction')
    .select(
      `
      id,
      source_document_id,
      vendor_name_ocr, vendor_name_verified,
      vendor_gstin_ocr, vendor_gstin_verified,
      invoice_number_ocr, invoice_number_verified,
      invoice_date_ocr, invoice_date_verified,
      instrument_type_ocr, instrument_type_verified,
      subtotal_ocr, subtotal_verified,
      tax_amount_ocr, tax_amount_verified,
      total_amount_ocr, total_amount_verified,
      round_off_ocr, round_off_verified,
      tax_breakdown_ocr, tax_breakdown_verified,
      place_of_supply_ocr, place_of_supply_verified,
      verified_at,
      source_document:source_document_id (
        entry_id,
        entries:entry_id ( vendor_id )
      )
    `
    )
    .not('verified_at', 'is', null)

  if (error) {
    throw new Error(`fetchDocumentFacts: query failed: ${error.message}`)
  }

  return (data ?? []).map((row): DocumentFacts => {
    // Supabase's generated types treat a to-one embed as an array; PostgREST
    // returns a single object because source_document_id is a unique FK. Both
    // shapes are handled defensively rather than trusting the array framing.
    const sourceDoc = Array.isArray(row.source_document) ? row.source_document[0] : row.source_document
    const entryRaw = sourceDoc?.entries
    const entry = Array.isArray(entryRaw) ? entryRaw[0] : entryRaw

    return {
      documentExtractionId: row.id as number,
      sourceDocumentId: row.source_document_id as number,
      entryId: (sourceDoc?.entry_id as number | null) ?? null,
      vendorId: (entry?.vendor_id as number | null) ?? null,
      vendorName: preferVerified(row.vendor_name_verified, row.vendor_name_ocr),
      vendorGstin: preferVerified(row.vendor_gstin_verified, row.vendor_gstin_ocr),
      invoiceNumber: preferVerified(row.invoice_number_verified, row.invoice_number_ocr),
      invoiceDate: preferVerified(row.invoice_date_verified, row.invoice_date_ocr),
      instrumentType: preferVerified(
        row.instrument_type_verified,
        row.instrument_type_ocr
      ) as InstrumentType | null,
      subtotal: preferVerified(row.subtotal_verified, row.subtotal_ocr),
      taxAmount: preferVerified(row.tax_amount_verified, row.tax_amount_ocr),
      totalAmount: preferVerified(row.total_amount_verified, row.total_amount_ocr),
      roundOff: preferVerified(row.round_off_verified, row.round_off_ocr),
      taxBreakdown: preferVerified(
        row.tax_breakdown_verified,
        row.tax_breakdown_ocr
      ) as TaxBreakdown | null,
      placeOfSupplyStateCode: stateCodeFromName(
        preferVerified(row.place_of_supply_verified, row.place_of_supply_ocr)
      ),
      verifiedAt: row.verified_at as string,
    }
  })
}

/**
 * Every vendor with at least one non-void entry, each carrying its payment
 * history for the aggregate detectors (TDS, splitting, duplicate payment).
 *
 * Reads `entries` rather than `document_extraction` for the payment record:
 * entries.amount/date/invoice_number is the department's own accounting figure
 * — the thing that was actually approved and paid — and it exists independent
 * of whether a supporting document was ever uploaded or verified. A vendor's
 * TDS exposure is about what they were paid, not about how much of that spend
 * happens to have a reviewed invoice behind it yet.
 */
export async function fetchVendorFacts(admin: AdminClient): Promise<VendorFacts[]> {
  const { data: entryRows, error: entryError } = await admin
    .from('entries')
    .select('id, vendor_id, amount, date, invoice_number')
    .not('vendor_id', 'is', null)
    .eq('is_void', false)

  if (entryError) {
    throw new Error(`fetchVendorFacts: entries query failed: ${entryError.message}`)
  }

  const vendorIds = Array.from(
    new Set((entryRows ?? []).map((r) => r.vendor_id as number).filter((id) => id != null))
  )
  if (vendorIds.length === 0) return []

  const { data: vendorRows, error: vendorError } = await admin
    .from('vendor')
    .select('id, display_name, gstin')
    .in('id', vendorIds)

  if (vendorError) {
    throw new Error(`fetchVendorFacts: vendor query failed: ${vendorError.message}`)
  }

  const paymentsByVendor = new Map<number, VendorPayment[]>()
  for (const row of entryRows ?? []) {
    const vendorId = row.vendor_id as number | null
    if (vendorId == null) continue
    const amount = row.amount === null ? null : Number(row.amount)
    if (amount == null || !Number.isFinite(amount)) continue

    const list = paymentsByVendor.get(vendorId) ?? []
    list.push({
      entryId: row.id as number,
      documentExtractionId: null,
      invoiceNumber: (row.invoice_number as string | null) ?? null,
      invoiceDate: (row.date as string | null) ?? null,
      amount,
      instrumentType: null,
    })
    paymentsByVendor.set(vendorId, list)
  }

  return (vendorRows ?? []).map(
    (v): VendorFacts => ({
      vendorId: v.id as number,
      displayName: (v.display_name as string) ?? `vendor #${v.id}`,
      gstin: (v.gstin as string | null) ?? null,
      // Not yet captured anywhere on `vendor` — every TDS finding therefore
      // states its rate as an assumption rather than a determination
      // (lib/analytics/rules/vendor-patterns.ts detectTdsThreshold).
      isIndividual: null,
      payments: paymentsByVendor.get(v.id as number) ?? [],
    })
  )
}
