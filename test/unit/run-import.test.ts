/**
 * test/unit/run-import.test.ts
 *
 * Unit tests for the pure, DB-free helpers in lib/import/assertions.ts
 * (MASTER-PLAN §3.6, day 2): budget-head short-label parsing and the two
 * post-batch assertion functions from §3.6 point 8 / §3.4. Imported from
 * lib/import/assertions.ts directly (not lib/import/run-import.ts, which
 * re-exports the same functions) so this test never needs `pg` or the
 * server env (DATABASE_URL, SUPABASE_SECRET_KEY, …) to be present just to
 * exercise a string-parsing function. The DB-coupled orchestration
 * (runImport itself) is verified separately against the live dev Supabase
 * project — see the day-2 task report — because it opens a real `pg`
 * transaction and there is no meaningful way to fake that in a unit test
 * without reimplementing Postgres.
 */

import { describe, expect, it } from 'vitest'
import {
  checkAllocationSumMismatches,
  checkNamespaceCollisions,
  parseBudgetHeadShortLabel,
} from '@/lib/import/assertions'

describe('parseBudgetHeadShortLabel', () => {
  it('extracts the trailing parenthetical', () => {
    expect(parseBudgetHeadShortLabel('Venue setup (AVIT)')).toBe('AVIT')
    expect(parseBudgetHeadShortLabel('Venue setup (Dome Tents)')).toBe('Dome Tents')
    expect(parseBudgetHeadShortLabel('Venue setup (Other setup expenses)')).toBe('Other setup expenses')
  })

  it('returns null when there is no trailing parenthetical', () => {
    expect(parseBudgetHeadShortLabel('Venue setup')).toBeNull()
    expect(parseBudgetHeadShortLabel('')).toBeNull()
  })

  it('trims whitespace inside the parentheses', () => {
    expect(parseBudgetHeadShortLabel('Venue setup ( AVIT  )')).toBe('AVIT')
  })

  it('only matches a parenthetical anchored at the end of the string', () => {
    // A parenthetical that isn't the last thing in the label doesn't count
    // as the short label — e.g. trailing punctuation/text after it.
    expect(parseBudgetHeadShortLabel('Venue setup (AVIT) - draft')).toBeNull()
  })

  it('handles a label that is only a parenthetical', () => {
    expect(parseBudgetHeadShortLabel('(Security)')).toBe('Security')
  })

  it('treats an empty parenthetical as no short label', () => {
    expect(parseBudgetHeadShortLabel('Venue setup ()')).toBeNull()
    expect(parseBudgetHeadShortLabel('Venue setup (   )')).toBeNull()
  })
})

describe('checkAllocationSumMismatches', () => {
  it('reports no mismatch when the entry sum exactly equals utilised_amount', () => {
    const heads = [{ budgetHeadId: 1, budgetHeadLabel: 'Dome Tents', utilisedAmount: 14_200_000 }]
    const sums = new Map([[1, 14_200_000]])
    expect(checkAllocationSumMismatches(heads, sums)).toEqual([])
  })

  it('tolerates a sub-rupee rounding difference (§7 tolerance)', () => {
    const heads = [{ budgetHeadId: 5, budgetHeadLabel: 'Other setup expenses', utilisedAmount: 2_216_011.0 }]
    const sums = new Map([[5, 2_216_010.89]])
    expect(checkAllocationSumMismatches(heads, sums)).toEqual([])
  })

  it('flags a real mismatch beyond tolerance', () => {
    const heads = [{ budgetHeadId: 5, budgetHeadLabel: 'Other setup expenses', utilisedAmount: 2_216_011 }]
    const sums = new Map([[5, 2_216_111]])
    const result = checkAllocationSumMismatches(heads, sums)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      budgetHeadId: 5,
      budgetHeadLabel: 'Other setup expenses',
      expectedUtilised: 2_216_011,
      actualEntrySum: 2_216_111,
      diff: 100,
    })
  })

  it('treats a head with no entries yet (sum defaults to 0) as a mismatch against a non-zero utilised_amount', () => {
    const heads = [{ budgetHeadId: 9, budgetHeadLabel: 'Labour', utilisedAmount: 430_850 }]
    const result = checkAllocationSumMismatches(heads, new Map())
    expect(result).toHaveLength(1)
    expect(result[0]?.actualEntrySum).toBe(0)
  })

  it('does not flag the zero-spend heads (the ₹2.5cr v1 bug) — zero utilised, zero entries is consistent', () => {
    const heads = [{ budgetHeadId: 2, budgetHeadLabel: 'AVIT', utilisedAmount: 0 }]
    expect(checkAllocationSumMismatches(heads, new Map())).toEqual([])
  })

  it('skips heads with a null utilised_amount rather than treating it as zero', () => {
    const heads = [{ budgetHeadId: 3, budgetHeadLabel: 'Unknown', utilisedAmount: null }]
    const sums = new Map([[3, 500]])
    expect(checkAllocationSumMismatches(heads, sums)).toEqual([])
  })

  it('checks each head independently across multiple heads', () => {
    const heads = [
      { budgetHeadId: 1, budgetHeadLabel: 'Dome Tents', utilisedAmount: 14_200_000 },
      { budgetHeadId: 5, budgetHeadLabel: 'Other setup expenses', utilisedAmount: 2_216_011 },
      { budgetHeadId: 9, budgetHeadLabel: 'Labour', utilisedAmount: 430_850 },
    ]
    const sums = new Map([
      [1, 14_200_000],
      [5, 2_216_011],
      [9, 400_000], // mismatch
    ])
    const result = checkAllocationSumMismatches(heads, sums)
    expect(result).toHaveLength(1)
    expect(result[0]?.budgetHeadId).toBe(9)
  })
})

describe('checkNamespaceCollisions', () => {
  it('finds the known fixture collision: ADP_202608054 is a UBBL on one row and a Main number on another', () => {
    const ubblNumbers = ['ADP_202608042', 'ADP_202608054', '202608051']
    const mainNumbers = ['ADP_202608054', '2026080526']
    expect(checkNamespaceCollisions(ubblNumbers, mainNumbers)).toEqual(['ADP_202608054'])
  })

  it('returns an empty array when the two namespaces never overlap', () => {
    const ubblNumbers = ['202608051', '202608052']
    const mainNumbers = ['2026080526', '2026080527']
    expect(checkNamespaceCollisions(ubblNumbers, mainNumbers)).toEqual([])
  })

  it('de-duplicates a collision that appears on more than two rows', () => {
    const ubblNumbers = ['X', 'X', 'Y']
    const mainNumbers = ['X', 'Z']
    expect(checkNamespaceCollisions(ubblNumbers, mainNumbers)).toEqual(['X'])
  })

  it('handles empty input without throwing', () => {
    expect(checkNamespaceCollisions([], [])).toEqual([])
  })
})
