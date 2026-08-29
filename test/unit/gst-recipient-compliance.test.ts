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

/** A non-tax bill: no tax amounts, instrument_type is not tax_invoice. */
function nonTaxInput(overrides: Partial<GstRecipientComplianceInput> = {}): GstRecipientComplianceInput {
  return baseInput({
    instrumentType: 'bill_of_supply',
    cgstAmount: null,
    sgstAmount: null,
    igstAmount: null,
    taxAmount: null,
    ...overrides,
  })
}

describe('checkGstRecipientCompliance — taxInvoice flag', () => {
  it('is false when no tax is charged and instrument_type is not tax_invoice', () => {
    const result = checkGstRecipientCompliance(nonTaxInput())
    expect(result.taxInvoice).toBe(false)
  })

  it('is false when tax fields are all zero and instrument_type is not tax_invoice', () => {
    const result = checkGstRecipientCompliance(
      nonTaxInput({ instrumentType: 'retail_cash_memo', cgstAmount: 0, sgstAmount: 0, igstAmount: 0, taxAmount: 0 })
    )
    expect(result.taxInvoice).toBe(false)
  })

  it('is true on instrument_type tax_invoice alone, even with no tax amounts', () => {
    expect(checkGstRecipientCompliance(baseInput({ instrumentType: 'tax_invoice' })).taxInvoice).toBe(true)
  })

  it('is true on a non-zero cgst_amount alone, even when instrument_type is not tax_invoice', () => {
    expect(checkGstRecipientCompliance(baseInput({ instrumentType: 'letterhead_bill', cgstAmount: 90 })).taxInvoice).toBe(true)
  })

  it('is true on a non-zero tax_amount alone', () => {
    expect(checkGstRecipientCompliance(baseInput({ instrumentType: 'letterhead_bill', taxAmount: 180 })).taxInvoice).toBe(true)
  })
})

describe('checkGstRecipientCompliance — tax invoice, everything present and correct', () => {
  it('reports nothing missing', () => {
    expect(checkGstRecipientCompliance(baseInput())).toEqual({ taxInvoice: true, missing: [] })
  })
})

describe('checkGstRecipientCompliance — tax invoice, buyer GSTIN', () => {
  it('flags buyer_gstin when absent', () => {
    const result = checkGstRecipientCompliance(baseInput({ buyerGstin: null }))
    expect(result.taxInvoice).toBe(true)
    expect(result.missing).toContain('buyer_gstin')
  })

  it('flags buyer_gstin when it does not match communityGstin', () => {
    expect(checkGstRecipientCompliance(baseInput({ buyerGstin: OTHER_GSTIN })).missing).toContain('buyer_gstin')
  })

  it('matches communityGstin regardless of spacing/case (isSameGstin normalizes both)', () => {
    expect(checkGstRecipientCompliance(baseInput({ buyerGstin: ' 27 aaatd1489 n1za ' })).missing).not.toContain('buyer_gstin')
  })
})

describe('checkGstRecipientCompliance — buyer name fuzzy match', () => {
  it.each([
    ['Dawat e Hadiyah', 'exact'],
    ['DAWAT E HADIYAH', 'all caps'],
    ['Dawat-e-Hadiyah Trust', 'hyphenated with trailing Trust'],
    ['dawat.e.hadiyah', 'punctuation instead of spaces'],
  ])('accepts "%s" (%s) as a match for "Dawat e Hadiyah"', (buyerName) => {
    expect(checkGstRecipientCompliance(baseInput({ buyerName })).missing).not.toContain('buyer_name')
  })

  it('rejects an unrelated vendor name', () => {
    expect(checkGstRecipientCompliance(baseInput({ buyerName: 'Adinath Furniture Pvt Ltd' })).missing).toContain('buyer_name')
  })

  it('flags buyer_name when absent', () => {
    expect(checkGstRecipientCompliance(baseInput({ buyerName: null })).missing).toContain('buyer_name')
  })
})

describe('checkGstRecipientCompliance — invoice number (tax-invoice only)', () => {
  it('flags invoice_number when absent on a tax invoice', () => {
    expect(checkGstRecipientCompliance(baseInput({ invoiceNumber: null })).missing).toContain('invoice_number')
  })

  it('flags invoice_number when it is an empty/whitespace string on a tax invoice', () => {
    expect(checkGstRecipientCompliance(baseInput({ invoiceNumber: '   ' })).missing).toContain('invoice_number')
  })

  it('does not flag invoice_number when present', () => {
    expect(checkGstRecipientCompliance(baseInput({ invoiceNumber: 'INV-001' })).missing).not.toContain('invoice_number')
  })

  it('never flags invoice_number on a non-tax bill, even when absent', () => {
    expect(checkGstRecipientCompliance(nonTaxInput({ invoiceNumber: null })).missing).not.toContain('invoice_number')
  })
})

describe('checkGstRecipientCompliance — non-tax bill, always-on recipient identity', () => {
  it('reports nothing missing when our GSTIN and name are both present and correct', () => {
    expect(checkGstRecipientCompliance(nonTaxInput())).toEqual({ taxInvoice: false, missing: [] })
  })

  it('flags buyer_gstin when our GSTIN is absent from a non-tax bill', () => {
    const result = checkGstRecipientCompliance(nonTaxInput({ buyerGstin: null }))
    expect(result).toEqual({ taxInvoice: false, missing: ['buyer_gstin'] })
  })

  it('flags buyer_name when our name is absent from a non-tax bill', () => {
    expect(checkGstRecipientCompliance(nonTaxInput({ buyerName: null })).missing).toEqual(['buyer_name'])
  })

  it('flags buyer_gstin when the printed GSTIN is some other org', () => {
    expect(checkGstRecipientCompliance(nonTaxInput({ buyerGstin: OTHER_GSTIN })).missing).toContain('buyer_gstin')
  })

  it('does NOT flag buyer_gstin on a non-tax bill when communityGstin is not configured', () => {
    expect(
      checkGstRecipientCompliance(nonTaxInput({ communityGstin: null, buyerGstin: null })).missing
    ).not.toContain('buyer_gstin')
  })

  it('does NOT flag buyer_name on a non-tax bill when communityName is not configured', () => {
    expect(
      checkGstRecipientCompliance(nonTaxInput({ communityName: null, buyerName: null })).missing
    ).not.toContain('buyer_name')
  })
})

describe('checkGstRecipientCompliance — COMMUNITY_GSTIN / COMMUNITY_NAME unset on a tax invoice', () => {
  it('can never pass buyer_gstin while taxInvoice when communityGstin is null', () => {
    const result = checkGstRecipientCompliance(baseInput({ communityGstin: null }))
    expect(result.taxInvoice).toBe(true)
    expect(result.missing).toContain('buyer_gstin')
  })

  it('can never pass buyer_name while taxInvoice when communityName is null', () => {
    const result = checkGstRecipientCompliance(baseInput({ communityName: null }))
    expect(result.taxInvoice).toBe(true)
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
    const result = checkGstRecipientCompliance(baseInput({ buyerGstin: null, invoiceNumber: null }))
    expect(result.missing).toEqual(expect.arrayContaining(['buyer_gstin', 'invoice_number']))
    expect(result.missing).not.toContain('buyer_name')
  })
})
