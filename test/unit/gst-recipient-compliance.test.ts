import { describe, expect, it } from 'vitest'
import { checkGstRecipientCompliance, type GstRecipientComplianceInput } from '@/lib/gst-recipient-compliance'

/**
 * Community GSTIN/name used across these tests: Dawat-E-Hadiyah, Maharashtra
 * — the same real GSTIN as REAL_GSTINS.dawatEHadiyah in test/unit/gstin.test.ts,
 * which is the buyer on nearly every invoice in the pilot corpus. Reusing it
 * here keeps the fixture grounded in a real value rather than a synthetic one.
 */
const COMMUNITY_GSTIN = '27AAATD1489N1ZA'
const COMMUNITY_NAME = 'Dawat e Hadiyah'

/** A different, unrelated but structurally valid GSTIN (Adinath Furniture,
 *  see test/unit/gstin.test.ts REAL_GSTINS.adinath). */
const OTHER_GSTIN = '24AAKCA3560A1Z7'

function baseInput(overrides: Partial<GstRecipientComplianceInput> = {}): GstRecipientComplianceInput {
  return {
    buyerGstin: COMMUNITY_GSTIN,
    buyerName: COMMUNITY_NAME,
    invoiceNumber: 'INV-001',
    communityGstin: COMMUNITY_GSTIN,
    communityName: COMMUNITY_NAME,
    cgstAmount: null,
    sgstAmount: null,
    igstAmount: null,
    taxAmount: null,
    instrumentType: 'tax_invoice',
    ...overrides,
  }
}

describe('checkGstRecipientCompliance — trigger condition', () => {
  it('does not trigger when no tax is charged and instrument_type is not tax_invoice', () => {
    const result = checkGstRecipientCompliance(
      baseInput({ instrumentType: 'bill_of_supply', cgstAmount: null, sgstAmount: null, igstAmount: null, taxAmount: null })
    )
    expect(result).toEqual({ triggered: false, missing: [] })
  })

  it('does not trigger when tax fields are all zero and instrument_type is not tax_invoice', () => {
    const result = checkGstRecipientCompliance(
      baseInput({
        instrumentType: 'retail_cash_memo',
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        taxAmount: 0,
      })
    )
    expect(result).toEqual({ triggered: false, missing: [] })
  })

  it('triggers on instrument_type tax_invoice alone, even with no tax amounts', () => {
    const result = checkGstRecipientCompliance(baseInput({ instrumentType: 'tax_invoice' }))
    expect(result.triggered).toBe(true)
  })

  it('triggers on a non-zero cgst_amount alone, even when instrument_type is not tax_invoice', () => {
    const result = checkGstRecipientCompliance(
      baseInput({ instrumentType: 'letterhead_bill', cgstAmount: 90 })
    )
    expect(result.triggered).toBe(true)
  })

  it('triggers on a non-zero tax_amount alone', () => {
    const result = checkGstRecipientCompliance(
      baseInput({ instrumentType: 'letterhead_bill', taxAmount: 180 })
    )
    expect(result.triggered).toBe(true)
  })
})

describe('checkGstRecipientCompliance — when triggered, everything present and correct', () => {
  it('reports nothing missing', () => {
    const result = checkGstRecipientCompliance(baseInput())
    expect(result).toEqual({ triggered: true, missing: [] })
  })
})

describe('checkGstRecipientCompliance — buyer GSTIN', () => {
  it('flags buyer_gstin when absent', () => {
    const result = checkGstRecipientCompliance(baseInput({ buyerGstin: null }))
    expect(result.triggered).toBe(true)
    expect(result.missing).toContain('buyer_gstin')
  })

  it('flags buyer_gstin when it does not match communityGstin', () => {
    const result = checkGstRecipientCompliance(baseInput({ buyerGstin: OTHER_GSTIN }))
    expect(result.missing).toContain('buyer_gstin')
  })

  it('matches communityGstin regardless of spacing/case (isSameGstin normalizes both)', () => {
    const result = checkGstRecipientCompliance(baseInput({ buyerGstin: ' 27 aaatd1489 n1za ' }))
    expect(result.missing).not.toContain('buyer_gstin')
  })
})

describe('checkGstRecipientCompliance — buyer name fuzzy match', () => {
  it.each([
    ['Dawat e Hadiyah', 'exact'],
    ['DAWAT E HADIYAH', 'all caps'],
    ['Dawat-e-Hadiyah Trust', 'hyphenated with trailing Trust'],
    ['dawat.e.hadiyah', 'punctuation instead of spaces'],
  ])('accepts "%s" (%s) as a match for "Dawat e Hadiyah"', (buyerName) => {
    const result = checkGstRecipientCompliance(baseInput({ buyerName }))
    expect(result.missing).not.toContain('buyer_name')
  })

  it('rejects an unrelated vendor name', () => {
    const result = checkGstRecipientCompliance(baseInput({ buyerName: 'Adinath Furniture Pvt Ltd' }))
    expect(result.missing).toContain('buyer_name')
  })

  it('flags buyer_name when absent', () => {
    const result = checkGstRecipientCompliance(baseInput({ buyerName: null }))
    expect(result.missing).toContain('buyer_name')
  })
})

describe('checkGstRecipientCompliance — invoice number', () => {
  it('flags invoice_number when absent', () => {
    const result = checkGstRecipientCompliance(baseInput({ invoiceNumber: null }))
    expect(result.missing).toContain('invoice_number')
  })

  it('flags invoice_number when it is an empty/whitespace string', () => {
    const result = checkGstRecipientCompliance(baseInput({ invoiceNumber: '   ' }))
    expect(result.missing).toContain('invoice_number')
  })

  it('does not flag invoice_number when present', () => {
    const result = checkGstRecipientCompliance(baseInput({ invoiceNumber: 'INV-001' }))
    expect(result.missing).not.toContain('invoice_number')
  })
})

describe('checkGstRecipientCompliance — COMMUNITY_GSTIN / COMMUNITY_NAME unset', () => {
  it('can never pass buyer_gstin while triggered when communityGstin is null', () => {
    const result = checkGstRecipientCompliance(baseInput({ communityGstin: null }))
    expect(result.triggered).toBe(true)
    expect(result.missing).toContain('buyer_gstin')
  })

  it('can never pass buyer_name while triggered when communityName is null', () => {
    const result = checkGstRecipientCompliance(baseInput({ communityName: null }))
    expect(result.triggered).toBe(true)
    expect(result.missing).toContain('buyer_name')
  })

  it('flags both when neither community value is configured, invoice_number still independent', () => {
    const result = checkGstRecipientCompliance(
      baseInput({ communityGstin: null, communityName: null, invoiceNumber: 'INV-042' })
    )
    expect(result.missing).toEqual(expect.arrayContaining(['buyer_gstin', 'buyer_name']))
    expect(result.missing).not.toContain('invoice_number')
  })
})

describe('checkGstRecipientCompliance — combined missing items', () => {
  it('can report multiple missing items at once, one exception worth of detail', () => {
    const result = checkGstRecipientCompliance(
      baseInput({ buyerGstin: null, invoiceNumber: null })
    )
    expect(result.missing).toEqual(expect.arrayContaining(['buyer_gstin', 'invoice_number']))
    expect(result.missing).not.toContain('buyer_name')
  })
})
