import { describe, expect, it } from 'vitest'
import { recheckTallyExceptions, type TallyRecheckInput } from '@/lib/analytics/tally-recheck'

function input(overrides: Partial<TallyRecheckInput> = {}): TallyRecheckInput {
  return {
    subtotal: null,
    taxAmount: null,
    totalAmount: null,
    lineItems: [],
    linkedEntryAmount: null,
    ...overrides,
  }
}

describe('recheckTallyExceptions', () => {
  it('clears line_item_tally_mismatch once corrected line items sum to the subtotal', () => {
    const result = recheckTallyExceptions(
      input({
        subtotal: 1000,
        taxAmount: 180,
        totalAmount: 1180,
        lineItems: [{ description: 'Widget', quantity: 10, rate: 100, discount: null, amount: 1000 }],
      })
    )
    expect(result.line_item_tally_mismatch).toBe(false)
  })

  it('still reports line_item_tally_mismatch when the edit did not fix the arithmetic', () => {
    const result = recheckTallyExceptions(
      input({
        subtotal: 1000,
        taxAmount: 180,
        totalAmount: 1180,
        lineItems: [{ description: 'Widget', quantity: 10, rate: 90, discount: null, amount: 900 }],
      })
    )
    expect(result.line_item_tally_mismatch).toBe(true)
  })

  it('returns null for line_item_tally_mismatch when there is nothing to compare (abstains, does not clear)', () => {
    const result = recheckTallyExceptions(input({ lineItems: [{ description: 'x', quantity: null, rate: null, discount: null, amount: null }] }))
    expect(result.line_item_tally_mismatch).toBeNull()
  })

  it('clears line_item_row_math_mismatch once a row is corrected to match quantity x rate', () => {
    const result = recheckTallyExceptions(
      input({ lineItems: [{ description: 'Widget', quantity: 2, rate: 50, discount: null, amount: 100 }] })
    )
    expect(result.line_item_row_math_mismatch).toBe(false)
  })

  it('still reports line_item_row_math_mismatch when a row still does not reconcile', () => {
    const result = recheckTallyExceptions(
      input({ lineItems: [{ description: 'Widget', quantity: 2, rate: 50, discount: null, amount: 500 }] })
    )
    expect(result.line_item_row_math_mismatch).toBe(true)
  })

  it('clears ocr_total_vs_amount once the verified total matches the linked entry amount', () => {
    const result = recheckTallyExceptions(input({ totalAmount: 5000, linkedEntryAmount: 5000 }))
    expect(result.ocr_total_vs_amount).toBe(false)
  })

  it('still reports ocr_total_vs_amount when the verified total still disagrees with the entry', () => {
    const result = recheckTallyExceptions(input({ totalAmount: 5000, linkedEntryAmount: 4000 }))
    expect(result.ocr_total_vs_amount).toBe(true)
  })

  it('returns null for ocr_total_vs_amount when there is no single linked entry to compare against', () => {
    const result = recheckTallyExceptions(input({ totalAmount: 5000, linkedEntryAmount: null }))
    expect(result.ocr_total_vs_amount).toBeNull()
  })
})
