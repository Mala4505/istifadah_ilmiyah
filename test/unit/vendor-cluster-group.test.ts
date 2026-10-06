import { describe, expect, it } from 'vitest'
import {
  buildClusterProposals,
  dismissalPairs,
  pickSuggestedRoot,
  type CandidateEdgeRow,
  type ProposalVendor,
} from '@/lib/vendor-clusters/group'

function vendor(id: number, overrides: Partial<ProposalVendor> = {}): ProposalVendor {
  return { id, displayName: `Vendor ${id}`, gstin: null, phone: null, address: null, isConfirmed: false, ...overrides }
}

function edge(a: number, b: number, reason: string, detail: string | null = null, score: number | null = null): CandidateEdgeRow {
  return { vendor_id_a: a, vendor_id_b: b, reason, detail, score }
}

const byId = (vendors: ProposalVendor[]) => new Map(vendors.map((v) => [v.id, v]))

describe('buildClusterProposals', () => {
  it('chains pairwise edges into one connected group', () => {
    const vendors = byId([vendor(1), vendor(2), vendor(3), vendor(4), vendor(5)])
    const proposals = buildClusterProposals(
      [edge(1, 2, 'phone', '9876543210'), edge(2, 3, 'similar_name', 'a ~ b', 0.7), edge(4, 5, 'gstin_pan', 'ABCDE1234F')],
      vendors,
    )
    expect(proposals).toHaveLength(2)
    // gstin_pan outranks phone, so the {4,5} group leads.
    expect(proposals[0]!.key).toBe('4-5')
    expect(proposals[1]!.key).toBe('1-2-3')
    expect(proposals[1]!.reasons).toEqual(['phone', 'similar_name'])
    expect(proposals[1]!.edges).toHaveLength(2)
  })

  it('drops unknown reasons and edges whose vendor was not loaded', () => {
    const proposals = buildClusterProposals(
      [edge(1, 2, 'bogus'), edge(1, 99, 'phone'), edge(3, 3, 'phone')],
      byId([vendor(1), vendor(2), vendor(3)]),
    )
    expect(proposals).toEqual([])
  })
})

describe('pickSuggestedRoot', () => {
  it('prefers confirmed, then GSTIN-bearing, then lowest id', () => {
    expect(pickSuggestedRoot([vendor(3), vendor(1), vendor(2)])).toBe(1)
    expect(pickSuggestedRoot([vendor(1), vendor(2, { gstin: '27ABCDE1234F1Z5' })])).toBe(2)
    expect(
      pickSuggestedRoot([vendor(1, { gstin: '27ABCDE1234F1Z5' }), vendor(2, { isConfirmed: true })]),
    ).toBe(2)
  })
})

describe('dismissalPairs', () => {
  it('returns each unordered pair once with a < b', () => {
    expect(dismissalPairs([3, 1, 2, 1])).toEqual([
      { vendor_id_a: 1, vendor_id_b: 2 },
      { vendor_id_a: 1, vendor_id_b: 3 },
      { vendor_id_a: 2, vendor_id_b: 3 },
    ])
  })
})
