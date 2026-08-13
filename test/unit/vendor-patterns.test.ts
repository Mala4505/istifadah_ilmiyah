import { describe, expect, it } from 'vitest'
import {
  detectDuplicatePayment,
  detectTdsThreshold,
  detectVendorSplitting,
  financialYearOf,
  runVendorDetectors,
} from '@/lib/analytics/rules/vendor-patterns'
import type { VendorFacts, VendorPayment } from '@/lib/analytics/types'

function payment(overrides: Partial<VendorPayment> = {}): VendorPayment {
  return {
    entryId: null,
    documentExtractionId: null,
    invoiceNumber: null,
    invoiceDate: '2025-08-15',
    amount: 10_000,
    instrumentType: 'tax_invoice',
    ...overrides,
  }
}

function vendor(overrides: Partial<VendorFacts> = {}): VendorFacts {
  return {
    vendorId: 1,
    displayName: 'Test Vendor',
    gstin: null,
    isIndividual: null,
    payments: [],
    ...overrides,
  }
}

describe('financialYearOf', () => {
  it('starts the year on 1 April', () => {
    expect(financialYearOf('2025-04-01')).toBe('FY2025-26')
    expect(financialYearOf('2026-03-31')).toBe('FY2025-26')
  })

  it('puts a March date in the year that began the previous April', () => {
    // A calendar-year bucket would split this vendor's payments across two
    // buckets and miss an aggregate crossing that legally happened in one.
    expect(financialYearOf('2026-01-15')).toBe('FY2025-26')
  })

  it('rolls over on 1 April', () => {
    expect(financialYearOf('2026-04-01')).toBe('FY2026-27')
  })

  it('handles the corpus dates', () => {
    expect(financialYearOf('2025-08-18')).toBe('FY2025-26')
  })
})

describe('detectTdsThreshold', () => {
  /** Shabbir I Batliwala — four bills, the pattern the plan could not see. */
  const SHABBIR = vendor({
    vendorId: 11,
    displayName: 'Shabbir I Batliwala',
    isIndividual: true,
    payments: [
      payment({ entryId: 201, invoiceNumber: '52', invoiceDate: '2025-08-18', amount: 92_436 }),
      payment({ entryId: 202, invoiceNumber: '53', invoiceDate: '2025-08-19', amount: 18_400 }),
      payment({ entryId: 203, invoiceNumber: '54', invoiceDate: '2025-08-20', amount: 22_150 }),
      payment({ entryId: 204, invoiceNumber: '55', invoiceDate: '2025-08-21', amount: 14_900 }),
    ],
  })

  it('flags the aggregate crossing across four separate bills', () => {
    const flags = detectTdsThreshold(SHABBIR)
    expect(flags).toHaveLength(1)
    expect(flags[0]?.flagType).toBe('tds_threshold')
    expect(flags[0]?.evidence).toMatchObject({
      financial_year: 'FY2025-26',
      bill_count: 4,
      cumulative_amount: 147_886,
      crosses_annual_aggregate_limb: true,
      crosses_single_payment_limb: true,
    })
  })

  it('uses the 1% individual rate when the constitution is known', () => {
    const flags = detectTdsThreshold(SHABBIR)
    expect(flags[0]?.amountAtRisk).toBeCloseTo(1478.86, 2)
  })

  it('assumes the higher 2% rate when the constitution is unknown, and says so', () => {
    const flags = detectTdsThreshold({ ...SHABBIR, isIndividual: null })
    expect(flags[0]?.amountAtRisk).toBeCloseTo(2957.72, 2)
    expect(String(flags[0]?.evidence?.rate_basis)).toContain('unknown')
  })

  it('asks for the works-contract determination rather than asserting liability', () => {
    const flags = detectTdsThreshold(SHABBIR)
    expect(flags[0]?.evidence?.requires_human_determination).toBeDefined()
    expect(flags[0]?.description).toContain('Confirm the nature of the supply')
  })

  it('fires on the single-payment limb alone', () => {
    const flags = detectTdsThreshold(
      vendor({ payments: [payment({ entryId: 1, amount: 45_000 })] })
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]?.evidence).toMatchObject({
      crosses_single_payment_limb: true,
      crosses_annual_aggregate_limb: false,
    })
  })

  it('stays silent below both limbs', () => {
    const flags = detectTdsThreshold(
      vendor({
        payments: [
          payment({ entryId: 1, amount: 20_000 }),
          payment({ entryId: 2, amount: 25_000 }),
        ],
      })
    )
    expect(flags).toEqual([])
  })

  it('buckets by financial year, not calendar year', () => {
    // ₹60,000 in Feb and ₹60,000 in May are ₹120,000 in a calendar year but sit
    // in two different financial years, and neither crosses the annual limb.
    const flags = detectTdsThreshold(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2026-02-10', amount: 60_000 }),
          payment({ entryId: 2, invoiceDate: '2026-05-10', amount: 60_000 }),
        ],
      })
    )
    expect(flags).toHaveLength(2)
    expect(flags.map((f) => f.evidence?.financial_year).sort()).toEqual(['FY2025-26', 'FY2026-27'])
    for (const flag of flags) {
      expect(flag.evidence).toMatchObject({ crosses_annual_aggregate_limb: false })
    }
  })

  it('produces one stable dedup key per vendor per financial year', () => {
    const first = detectTdsThreshold(SHABBIR)
    const second = detectTdsThreshold(SHABBIR)
    expect(first[0]?.dedupKey).toBe('tds_threshold:11:FY2025-26')
    expect(second[0]?.dedupKey).toBe(first[0]?.dedupKey)
  })
})

/**
 * APPROVAL_LIMIT is null — confirmed 2026-08-12 that the organisation has no
 * formal delegated-authority limit — so the detector runs in CONCENTRATION mode.
 * These tests assert that behaviour. If a limit is ever configured the detector
 * switches to splitting mode and these expectations change with it, which is why
 * each one names the mode it is exercising.
 */
describe('detectVendorSplitting — concentration mode (no approval limit)', () => {
  it('flags a materially large cluster of bills in a short window', () => {
    const flags = detectVendorSplitting(
      vendor({
        displayName: 'Frequent Biller Ltd',
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 24_000 }),
          payment({ entryId: 2, invoiceDate: '2025-08-05', amount: 23_500 }),
          payment({ entryId: 3, invoiceDate: '2025-08-09', amount: 22_000 }),
        ],
      })
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]?.amountAtRisk).toBe(69_500)
    expect(flags[0]?.evidence).toMatchObject({
      mode: 'concentration',
      bill_count: 3,
      window_days: 8,
    })
  })

  it('records that no approval limit is configured', () => {
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 24_000 }),
          payment({ entryId: 2, invoiceDate: '2025-08-05', amount: 23_500 }),
          payment({ entryId: 3, invoiceDate: '2025-08-09', amount: 22_000 }),
        ],
      })
    )
    expect(flags[0]?.evidence).toMatchObject({
      approval_limit_configured: false,
      approval_limit: null,
    })
  })

  it('says explicitly that nothing was breached', () => {
    // Without a limit there is no control to breach. Implying otherwise would be
    // an accusation the data does not support.
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 24_000 }),
          payment({ entryId: 2, invoiceDate: '2025-08-05', amount: 23_500 }),
          payment({ entryId: 3, invoiceDate: '2025-08-09', amount: 22_000 }),
        ],
      })
    )
    expect(flags[0]?.description).toContain('not a control breach')
  })

  it('caps severity at medium however large the cluster', () => {
    // An un-breached pattern must not sit at the same severity as a real control
    // failure, or the queue stops distinguishing them.
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 400_000 }),
          payment({ entryId: 2, invoiceDate: '2025-08-05', amount: 350_000 }),
          payment({ entryId: 3, invoiceDate: '2025-08-09', amount: 300_000 }),
        ],
      })
    )
    expect(flags[0]?.severity).toBe('medium')
  })

  it('counts large bills too, since there is no limit to sit under', () => {
    // In splitting mode the ₹92,436 bill would be excluded as separately
    // approved; in concentration mode it is part of the cluster.
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 92_436 }),
          payment({ entryId: 2, invoiceDate: '2025-08-05', amount: 23_500 }),
          payment({ entryId: 3, invoiceDate: '2025-08-09', amount: 22_000 }),
        ],
      })
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]?.evidence).toMatchObject({ bill_count: 3, total_amount: 137_936 })
  })

  it('does not group bills spread beyond the window', () => {
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-01-01', amount: 24_000 }),
          payment({ entryId: 2, invoiceDate: '2025-05-01', amount: 23_500 }),
          payment({ entryId: 3, invoiceDate: '2025-09-01', amount: 22_000 }),
        ],
      })
    )
    expect(flags).toEqual([])
  })

  it('stays silent when the cluster is immaterial', () => {
    // Three small bills to one vendor in a week is ordinary trading, not a
    // finding. The materiality floor is the only thing preventing this detector
    // from reporting every vendor in the book.
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 5_000 }),
          payment({ entryId: 2, invoiceDate: '2025-08-05', amount: 6_000 }),
          payment({ entryId: 3, invoiceDate: '2025-08-09', amount: 7_000 }),
        ],
      })
    )
    expect(flags).toEqual([])
  })

  it('stays silent below the minimum bill count however large the total', () => {
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 500_000 }),
          payment({ entryId: 2, invoiceDate: '2025-08-05', amount: 400_000 }),
        ],
      })
    )
    expect(flags).toEqual([])
  })

  it('reports one flag per cluster, not one per starting bill', () => {
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 24_000 }),
          payment({ entryId: 2, invoiceDate: '2025-08-02', amount: 23_500 }),
          payment({ entryId: 3, invoiceDate: '2025-08-03', amount: 22_000 }),
          payment({ entryId: 4, invoiceDate: '2025-08-04', amount: 21_000 }),
        ],
      })
    )
    // A naive implementation emits one per window start; the tail windows here
    // are all shorter than the minimum, so exactly one cluster survives.
    expect(flags).toHaveLength(1)
    expect(flags[0]?.relatedEntryIds).toEqual([1, 2, 3, 4])
  })

  it('describes the pattern without asserting intent', () => {
    const flags = detectVendorSplitting(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceDate: '2025-08-01', amount: 24_000 }),
          payment({ entryId: 2, invoiceDate: '2025-08-05', amount: 23_500 }),
          payment({ entryId: 3, invoiceDate: '2025-08-09', amount: 22_000 }),
        ],
      })
    )
    expect(flags[0]?.description).toContain('confirm whether')
    expect(flags[0]?.description).not.toMatch(/evad|fraud|deliberate/i)
  })
})

describe('detectDuplicatePayment', () => {
  it('treats a repeated invoice number as high severity', () => {
    const flags = detectDuplicatePayment(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceNumber: '65', invoiceDate: '2025-08-09', amount: 29_913 }),
          payment({ entryId: 2, invoiceNumber: '65', invoiceDate: '2025-08-20', amount: 6_608 }),
        ],
      })
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]?.severity).toBe('high')
    expect(flags[0]?.evidence).toMatchObject({ match_basis: 'invoice_number' })
  })

  it('flags near-identical amounts inside the window', () => {
    const flags = detectDuplicatePayment(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceNumber: 'A', invoiceDate: '2025-08-09', amount: 29_913 }),
          payment({ entryId: 2, invoiceNumber: 'B', invoiceDate: '2025-08-14', amount: 29_950 }),
        ],
      })
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]?.evidence).toMatchObject({ match_basis: 'amount', gap_days: 5 })
    expect(flags[0]?.amountAtRisk).toBe(29_913)
  })

  it('ignores identical amounts outside the window', () => {
    const flags = detectDuplicatePayment(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceNumber: 'A', invoiceDate: '2025-01-09', amount: 29_913 }),
          payment({ entryId: 2, invoiceNumber: 'B', invoiceDate: '2025-08-14', amount: 29_913 }),
        ],
      })
    )
    expect(flags).toEqual([])
  })

  it('does not pair genuinely different amounts', () => {
    const flags = detectDuplicatePayment(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceNumber: 'A', invoiceDate: '2025-08-09', amount: 29_913 }),
          payment({ entryId: 2, invoiceNumber: 'B', invoiceDate: '2025-08-14', amount: 6_608 }),
        ],
      })
    )
    expect(flags).toEqual([])
  })

  it('emits a stable, order-independent dedup key', () => {
    const forward = vendor({
      payments: [
        payment({ entryId: 1, invoiceNumber: 'A', invoiceDate: '2025-08-09', amount: 29_913 }),
        payment({ entryId: 2, invoiceNumber: 'B', invoiceDate: '2025-08-14', amount: 29_950 }),
      ],
    })
    const reversed = vendor({ payments: [...forward.payments].reverse() })
    expect(detectDuplicatePayment(forward)[0]?.dedupKey).toBe(
      detectDuplicatePayment(reversed)[0]?.dedupKey
    )
  })

  it('does not pair two blank invoice numbers as a number match', () => {
    const flags = detectDuplicatePayment(
      vendor({
        payments: [
          payment({ entryId: 1, invoiceNumber: '  ', invoiceDate: '2025-08-09', amount: 1_000 }),
          payment({ entryId: 2, invoiceNumber: '  ', invoiceDate: '2025-08-14', amount: 5_000 }),
        ],
      })
    )
    expect(flags).toEqual([])
  })
})

describe('runVendorDetectors', () => {
  it('returns nothing for a vendor with a single small bill', () => {
    expect(runVendorDetectors(vendor({ payments: [payment({ entryId: 1, amount: 2_690 })] }))).toEqual([])
  })

  it('skips payments with no usable date', () => {
    expect(
      runVendorDetectors(
        vendor({ payments: [payment({ entryId: 1, invoiceDate: null, amount: 200_000 })] })
      )
    ).toEqual([])
  })
})
