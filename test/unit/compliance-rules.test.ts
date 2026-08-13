import { describe, expect, it } from 'vitest'
import {
  detectGstNotCharged,
  detectGstRateAnomaly,
  detectGstTypeMismatch,
  detectGstinInvalid,
  detectGstinMissing,
  detectTaxMathMismatch,
  runComplianceDetectors,
} from '@/lib/analytics/rules/compliance'
import type { DocumentFacts } from '@/lib/analytics/types'

/**
 * Fixtures below are transcribed from real documents in Invoices/ (the 21-document
 * pilot corpus). The clean ones matter as much as the dirty ones: a compliance
 * detector that flags a correct invoice costs a reviewer more than one that
 * misses a bad one, because it teaches them to ignore the queue.
 */

function facts(overrides: Partial<DocumentFacts> = {}): DocumentFacts {
  return {
    documentExtractionId: 1,
    sourceDocumentId: 1,
    entryId: 100,
    vendorId: 10,
    vendorName: 'Test Vendor',
    vendorGstin: null,
    invoiceNumber: 'TEST-1',
    invoiceDate: '2025-08-15',
    instrumentType: 'tax_invoice',
    subtotal: null,
    taxAmount: null,
    totalAmount: null,
    roundOff: null,
    taxBreakdown: null,
    placeOfSupplyStateCode: null,
    verifiedAt: '2026-08-14T00:00:00Z',
    ...overrides,
  }
}

/** Adinath Furniture Pvt Ltd — e-invoice AFPL/SOS/TI/65, 13-Aug-25. Fully compliant. */
const ADINATH = facts({
  documentExtractionId: 3,
  vendorName: 'Adinath Furniture Pvt Ltd',
  vendorGstin: '24AAKCA3560A1Z7',
  invoiceNumber: 'AFPL/SOS/TI/65',
  invoiceDate: '2025-08-13',
  instrumentType: 'tax_invoice',
  subtotal: 3000,
  taxAmount: 540,
  totalAmount: 3540,
  roundOff: 0,
  taxBreakdown: { igst: { rate: 18, amount: 540 }, cgst: null, sgst: null },
  placeOfSupplyStateCode: '27',
})

/** Creative Frames & Decor — invoice 65, 09-08-2025. Gypsum ceiling + transport. */
const CREATIVE_FRAMES = facts({
  documentExtractionId: 5,
  vendorName: 'Creative Frames & Decor',
  vendorGstin: '24BBBPS5730A1Z4',
  invoiceNumber: '65',
  invoiceDate: '2025-08-09',
  instrumentType: 'tax_invoice',
  subtotal: 25350,
  taxAmount: 4563,
  totalAmount: 29913,
  roundOff: 0,
  taxBreakdown: { igst: { rate: 18, amount: 4563 }, cgst: null, sgst: null },
  placeOfSupplyStateCode: '27',
})

/** Shabbir I Batliwala — bill 52, 18/8/2025. Letterhead bill, PAN only, no GST. */
const SHABBIR = facts({
  documentExtractionId: 11,
  vendorName: 'Shabbir I Batliwala',
  vendorGstin: null,
  invoiceNumber: '52',
  invoiceDate: '2025-08-18',
  instrumentType: 'letterhead_bill',
  subtotal: null,
  taxAmount: null,
  totalAmount: 92436,
  roundOff: null,
  taxBreakdown: null,
  placeOfSupplyStateCode: null,
})

/** Noble Enterprise — cash memo 30090, 19/8/25. Stationery, ₹2,690. */
const NOBLE = facts({
  documentExtractionId: 21,
  vendorName: 'Noble Enterprise',
  vendorGstin: null,
  invoiceNumber: '30090',
  invoiceDate: '2025-08-19',
  instrumentType: 'retail_cash_memo',
  totalAmount: 2690,
})

/** Juzer S. Saleh — bill of supply 675, 18-8-25. Unregistered but correct instrument. */
const JUZER = facts({
  documentExtractionId: 18,
  vendorName: 'Juzer S. Saleh',
  vendorGstin: null,
  invoiceNumber: '675',
  invoiceDate: '2025-08-18',
  instrumentType: 'bill_of_supply',
  totalAmount: 11000,
})

describe('compliance detectors — real compliant invoices raise nothing', () => {
  it.each([
    ['Adinath e-invoice', ADINATH],
    ['Creative Frames invoice 65', CREATIVE_FRAMES],
  ])('%s produces no flags', (_name, doc) => {
    expect(runComplianceDetectors(doc)).toEqual([])
  })
})

describe('detectGstNotCharged', () => {
  it('flags the ₹92,436 letterhead bill and estimates the credit foregone', () => {
    const flag = detectGstNotCharged(SHABBIR)
    expect(flag).not.toBeNull()
    expect(flag?.flagType).toBe('gst_not_charged')
    // 92,436 × 18% — the credit that would have existed had the supplier been registered.
    expect(flag?.amountAtRisk).toBeCloseTo(16638.48, 2)
    expect(flag?.vendorId).toBe(SHABBIR.vendorId)
  })

  it('marks the figure as an estimate rather than a measurement', () => {
    const flag = detectGstNotCharged(SHABBIR)
    expect(flag?.evidence).toMatchObject({ estimate: true, assumed_gst_rate: 18 })
  })

  it('stays silent on a small cash memo', () => {
    // ₹2,690 of stationery from an unregistered shop is ordinary. Flagging it
    // buries the ₹92,436 finding sitting next to it in the same queue.
    expect(detectGstNotCharged(NOBLE)).toBeNull()
  })

  it('stays silent on a bill of supply', () => {
    // Correct instrument for a composition/exempt supplier — lawful, not a leak.
    expect(detectGstNotCharged(JUZER)).toBeNull()
  })

  it('abstains when the instrument type was never captured', () => {
    expect(detectGstNotCharged(facts({ instrumentType: null, totalAmount: 90000 }))).toBeNull()
  })

  it('abstains when tax was in fact charged', () => {
    expect(
      detectGstNotCharged(facts({ instrumentType: 'letterhead_bill', totalAmount: 90000, taxAmount: 16200 }))
    ).toBeNull()
  })
})

describe('detectGstinMissing', () => {
  it('flags a tax invoice with no GSTIN', () => {
    const flag = detectGstinMissing(
      facts({ instrumentType: 'tax_invoice', vendorGstin: null, taxAmount: 4563 })
    )
    expect(flag?.flagType).toBe('gstin_missing')
    expect(flag?.severity).toBe('high')
    expect(flag?.amountAtRisk).toBe(4563)
  })

  it('does not fire on non-tax-invoice instruments', () => {
    expect(detectGstinMissing(SHABBIR)).toBeNull()
    expect(detectGstinMissing(JUZER)).toBeNull()
    expect(detectGstinMissing(NOBLE)).toBeNull()
  })

  it('does not fire when the GSTIN is present', () => {
    expect(detectGstinMissing(ADINATH)).toBeNull()
  })

  it('treats a whitespace-only GSTIN as missing', () => {
    expect(detectGstinMissing(facts({ vendorGstin: '   ' }))?.flagType).toBe('gstin_missing')
  })
})

describe('detectGstinInvalid', () => {
  it('catches a transposed digit via the check digit', () => {
    // Adinath's real GSTIN with 3560 -> 3650: shape and state stay valid.
    const flag = detectGstinInvalid(facts({ vendorGstin: '24AAKCA3650A1Z7' }))
    expect(flag?.flagType).toBe('gstin_invalid')
    expect(flag?.evidence).toMatchObject({ failure_reason: 'checksum' })
  })

  it('accepts every real GSTIN in the corpus', () => {
    expect(detectGstinInvalid(ADINATH)).toBeNull()
    expect(detectGstinInvalid(CREATIVE_FRAMES)).toBeNull()
  })

  it('accepts a GSTIN written with spaces, as handwritten invoices do', () => {
    expect(detectGstinInvalid(facts({ vendorGstin: '24 AAKCA 3560 A1Z7' }))).toBeNull()
  })

  it('stays out of gstin_missing territory when there is no GSTIN at all', () => {
    expect(detectGstinInvalid(SHABBIR)).toBeNull()
  })

  it('says explicitly that it has not confirmed registration', () => {
    const flag = detectGstinInvalid(facts({ vendorGstin: '24AAKCA3650A1Z7' }))
    expect(String(flag?.evidence?.note)).toContain('does not confirm')
  })
})

describe('detectTaxMathMismatch', () => {
  it('passes invoices that reconcile exactly', () => {
    expect(detectTaxMathMismatch(ADINATH)).toBeNull()
    expect(detectTaxMathMismatch(CREATIVE_FRAMES)).toBeNull()
  })

  it('flags a total that does not follow from its parts', () => {
    const flag = detectTaxMathMismatch(
      facts({ subtotal: 25350, taxAmount: 4563, totalAmount: 31000 })
    )
    expect(flag?.flagType).toBe('tax_math_mismatch')
    expect(flag?.amountAtRisk).toBeCloseTo(1087, 2)
  })

  it('accounts for an explicit round-off line', () => {
    // Without capturing round_off this correct invoice would be flagged.
    expect(
      detectTaxMathMismatch(facts({ subtotal: 44062.77, taxAmount: 7931.3, totalAmount: 52000, roundOff: 5.93 }))
    ).toBeNull()
  })

  it('abstains when the subtotal was never captured', () => {
    // Handwritten cash memos have a total and nothing else. Treating the missing
    // subtotal as zero would flag every one of them.
    expect(detectTaxMathMismatch(NOBLE)).toBeNull()
    expect(detectTaxMathMismatch(SHABBIR)).toBeNull()
  })
})

describe('detectGstRateAnomaly', () => {
  it('accepts an exact 18% invoice', () => {
    expect(detectGstRateAnomaly(CREATIVE_FRAMES)).toBeNull()
  })

  it('accepts a rate that is off only by invoice rounding', () => {
    // 4,428 on 24,600 = 17.902%... within tolerance of the 18% slab.
    expect(detectGstRateAnomaly(facts({ subtotal: 24600, taxAmount: 4427.9 }))).toBeNull()
  })

  it('flags a rate that is not a slab at all', () => {
    // 20% has never been a GST slab; 18% is unambiguously the nearest.
    const flag = detectGstRateAnomaly(facts({ subtotal: 20000, taxAmount: 4000 }))
    expect(flag?.flagType).toBe('gst_rate_anomaly')
    expect(flag?.evidence).toMatchObject({ implied_rate_pct: 20, nearest_slab_pct: 18 })
    expect(flag?.amountAtRisk).toBeCloseTo(400, 2)
  })

  it('resolves an exact tie to the higher slab', () => {
    // 15% is equidistant from 12% and 18%. Taking the lower slab would report a
    // ₹600 discrepancy against 12% rather than ₹600 against 18% — same size here,
    // but on an asymmetric pair it would understate the finding. The rule is to
    // never round in the direction that makes the problem look smaller.
    const flag = detectGstRateAnomaly(facts({ subtotal: 20000, taxAmount: 3000 }))
    expect(flag?.evidence).toMatchObject({ implied_rate_pct: 15, nearest_slab_pct: 18 })
  })

  it('accepts a zero-rated supply', () => {
    expect(detectGstRateAnomaly(facts({ subtotal: 20000, taxAmount: 0 }))).toBeNull()
  })

  it('abstains without a taxable value', () => {
    expect(detectGstRateAnomaly(facts({ subtotal: null, taxAmount: 500 }))).toBeNull()
    expect(detectGstRateAnomaly(facts({ subtotal: 0, taxAmount: 500 }))).toBeNull()
  })
})

describe('detectGstTypeMismatch', () => {
  it('accepts IGST on a Gujarat-to-Maharashtra supply', () => {
    // The dominant pattern in the corpus: Surat vendors billing Mumbai.
    expect(detectGstTypeMismatch(ADINATH)).toBeNull()
    expect(detectGstTypeMismatch(CREATIVE_FRAMES)).toBeNull()
  })

  it('flags CGST+SGST charged on an interstate supply', () => {
    const flag = detectGstTypeMismatch(
      facts({
        vendorGstin: '24AAKCA3560A1Z7',
        placeOfSupplyStateCode: '27',
        taxAmount: 540,
        taxBreakdown: { cgst: { rate: 9, amount: 270 }, sgst: { rate: 9, amount: 270 }, igst: null },
      })
    )
    expect(flag?.flagType).toBe('gst_type_mismatch')
    expect(flag?.amountAtRisk).toBe(540)
    expect(flag?.evidence).toMatchObject({ is_interstate: true, expected_head: 'IGST' })
  })

  it('flags IGST charged within a single state', () => {
    const flag = detectGstTypeMismatch(
      facts({
        vendorGstin: '24AAKCA3560A1Z7',
        placeOfSupplyStateCode: '24',
        taxAmount: 540,
        taxBreakdown: { igst: { rate: 18, amount: 540 }, cgst: null, sgst: null },
      })
    )
    expect(flag?.evidence).toMatchObject({ is_interstate: false, expected_head: 'CGST + SGST' })
  })

  it('abstains when the place of supply was never captured', () => {
    // The common case outside GST invoices — guessing here would flag correct
    // invoices whose only fault is an uncaptured field.
    expect(
      detectGstTypeMismatch(
        facts({
          vendorGstin: '24AAKCA3560A1Z7',
          placeOfSupplyStateCode: null,
          taxBreakdown: { igst: { rate: 18, amount: 540 } },
        })
      )
    ).toBeNull()
  })

  it('abstains when no tax was charged under any head', () => {
    expect(
      detectGstTypeMismatch(
        facts({
          vendorGstin: '24AAKCA3560A1Z7',
          placeOfSupplyStateCode: '27',
          taxBreakdown: { igst: { rate: 0, amount: 0 }, cgst: null, sgst: null },
        })
      )
    ).toBeNull()
  })
})

describe('runComplianceDetectors', () => {
  it('skips unverified extractions entirely', () => {
    // Flagging off an unreviewed OCR read sends reviewers after the model's
    // mistakes rather than the vendor's.
    expect(runComplianceDetectors({ ...SHABBIR, verifiedAt: null })).toEqual([])
  })

  it('returns the single expected finding for the letterhead bill', () => {
    const flags = runComplianceDetectors(SHABBIR)
    expect(flags.map((f) => f.flagType)).toEqual(['gst_not_charged'])
  })

  it('produces stable dedup keys across runs', () => {
    const first = runComplianceDetectors(SHABBIR)
    const second = runComplianceDetectors(SHABBIR)
    expect(first.map((f) => f.dedupKey)).toEqual(second.map((f) => f.dedupKey))
  })
})
