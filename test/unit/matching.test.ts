import { describe, expect, it } from 'vitest'
import {
  amountProximityScore,
  dateProximityScore,
  invoiceNumberMatch,
  rankCandidates,
  scoreEntry,
  vendorSimilarity,
  type MatchableEntry,
} from '@/lib/matching'

function entry(overrides: Partial<MatchableEntry> & { id: number }): MatchableEntry {
  return {
    vendorRaw: null,
    amount: null,
    date: null,
    invoiceNumber: null,
    departmentId: null,
    ubblNumber: `UBBL-${overrides.id}`,
    mainNumber: null,
    ...overrides,
  }
}

describe('vendorSimilarity', () => {
  it('is 1 for names that normalize to the same key', () => {
    expect(vendorSimilarity('Sharma Traders Pvt Ltd', 'SHARMA TRADERS')).toBe(1)
  })

  it('is high but not 1 for a minor spelling difference', () => {
    const score = vendorSimilarity('Sharma Traders', 'Sharme Traders')
    expect(score).toBeGreaterThan(0.6)
    expect(score).toBeLessThan(1)
  })

  it('is low for unrelated names', () => {
    expect(vendorSimilarity('Sharma Traders', 'Global Event Rentals')).toBeLessThan(0.2)
  })

  it('is 0 when either side normalizes to empty', () => {
    expect(vendorSimilarity('', 'Sharma Traders')).toBe(0)
    expect(vendorSimilarity('Pvt Ltd', '')).toBe(0)
  })
})

describe('amountProximityScore', () => {
  it('is 1 for an exact match', () => {
    expect(amountProximityScore(45000, 45000)).toBe(1)
  })

  it('degrades toward 0 as the relative difference grows', () => {
    const close = amountProximityScore(45000, 45100) // ~0.22% off
    const far = amountProximityScore(45000, 60000) // ~25% off
    expect(close).toBeGreaterThan(0.9)
    expect(far).toBeLessThanOrEqual(0.01)
  })

  it('is 0 for non-positive or non-finite input', () => {
    expect(amountProximityScore(0, 100)).toBe(0)
    expect(amountProximityScore(-5, 100)).toBe(0)
    expect(amountProximityScore(NaN, 100)).toBe(0)
  })
})

describe('dateProximityScore', () => {
  it('is 1 for the same day', () => {
    expect(dateProximityScore('2026-08-10', '2026-08-10')).toBe(1)
  })

  it('degrades linearly and floors at 0 past the 21-day window', () => {
    expect(dateProximityScore('2026-08-01', '2026-08-22')).toBe(0)
    const mid = dateProximityScore('2026-08-01', '2026-08-08') // 7 days
    expect(mid).toBeGreaterThan(0.6)
    expect(mid).toBeLessThan(0.7)
  })

  it('is 0 for an unparsable date', () => {
    expect(dateProximityScore('not-a-date', '2026-08-10')).toBe(0)
  })
})

describe('invoiceNumberMatch', () => {
  it('is 1 for identical numbers', () => {
    expect(invoiceNumberMatch('INV-045', 'INV-045')).toBe(1)
  })

  it('is 1 after normalizing case/punctuation/whitespace differences', () => {
    expect(invoiceNumberMatch('inv 045', 'INV-045')).toBe(1)
  })

  it('is 0 for different numbers, even if short or numeric-only', () => {
    expect(invoiceNumberMatch('120', '121')).toBe(0)
  })

  it('is 0 when either side normalizes to empty', () => {
    expect(invoiceNumberMatch('', 'INV-045')).toBe(0)
    expect(invoiceNumberMatch('---', 'INV-045')).toBe(0)
  })
})

describe('scoreEntry / rankCandidates', () => {
  const doc = { vendorName: 'Sharma Traders', totalAmount: 45000, invoiceDate: '2026-08-10', invoiceNumber: null }

  it('scores a strong all-round match highest', () => {
    const strong = entry({
      id: 1,
      vendorRaw: 'Sharma Traders',
      amount: 45000,
      date: '2026-08-10',
      invoiceNumber: 'INV-045',
    })
    const weak = entry({ id: 2, vendorRaw: 'Global Event Rentals', amount: 12000, date: '2026-01-01' })
    const strongScore = scoreEntry({ ...doc, invoiceNumber: 'INV-045' }, strong).score
    const weakScore = scoreEntry(doc, weak).score
    expect(strongScore).toBeGreaterThan(weakScore)
    expect(strongScore).toBeGreaterThan(0.9)
  })

  it('without an invoice number on either side, vendor/amount/date alone caps below 1', () => {
    const strong = entry({ id: 6, vendorRaw: 'Sharma Traders', amount: 45000, date: '2026-08-10' })
    expect(scoreEntry(doc, strong).score).toBeCloseTo(0.75, 5)
  })

  it('never throws when the document or entry side is missing fields', () => {
    const bare = entry({ id: 3 })
    expect(() =>
      scoreEntry({ vendorName: null, totalAmount: null, invoiceDate: null, invoiceNumber: null }, bare)
    ).not.toThrow()
    expect(scoreEntry({ vendorName: null, totalAmount: null, invoiceDate: null, invoiceNumber: null }, bare).score).toBe(0)
  })

  it('a matching invoice number raises the score of an otherwise-partial match', () => {
    const docWithInvoice = { ...doc, invoiceNumber: 'INV-045' }
    const partial = entry({ id: 4, vendorRaw: 'Sharma Trader', amount: 46000, date: '2026-08-14' })
    const withMatchingInvoice = { ...partial, invoiceNumber: 'INV-045' }
    const withoutInvoice = { ...partial, invoiceNumber: null }
    expect(scoreEntry(docWithInvoice, withMatchingInvoice).score).toBeGreaterThan(
      scoreEntry(docWithInvoice, withoutInvoice).score
    )
  })

  it('a missing invoice number on either side just scores that dimension 0, never throws or penalizes below the baseline', () => {
    const strong = entry({ id: 5, vendorRaw: 'Sharma Traders', amount: 45000, date: '2026-08-10' })
    const withInvoiceOnDocOnly = scoreEntry({ ...doc, invoiceNumber: 'INV-045' }, strong)
    expect(withInvoiceOnDocOnly.invoiceNumberScore).toBe(0)
    expect(withInvoiceOnDocOnly.score).toBe(scoreEntry(doc, strong).score)
  })

  it('rankCandidates returns only entries at/above the minimum score, highest first, capped at the limit', () => {
    const entries: MatchableEntry[] = [
      entry({ id: 1, vendorRaw: 'Sharma Traders', amount: 45000, date: '2026-08-10' }), // exact
      entry({ id: 2, vendorRaw: 'Sharma Traders', amount: 45500, date: '2026-08-11' }), // close
      entry({ id: 3, vendorRaw: 'Sharma Trader', amount: 46000, date: '2026-08-14' }), // decent
      entry({ id: 4, vendorRaw: 'Unrelated Vendor', amount: 999, date: '2020-01-01' }), // noise
    ]
    const ranked = rankCandidates(doc, entries, { limit: 2 })
    expect(ranked).toHaveLength(2)
    expect(ranked[0]!.id).toBe(1)
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score)
    expect(ranked.some((r) => r.id === 4)).toBe(false)
  })

  it('rankCandidates returns an empty array when nothing clears the minimum score', () => {
    const entries: MatchableEntry[] = [entry({ id: 5, vendorRaw: 'Nothing Alike', amount: 1, date: '1999-01-01' })]
    expect(rankCandidates(doc, entries)).toEqual([])
  })
})
