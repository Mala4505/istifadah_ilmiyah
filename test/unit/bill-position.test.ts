import { describe, expect, it } from 'vitest'
import { computeBillPosition } from '@/lib/review/bill-position'

describe('computeBillPosition — "Bill N of M in this PDF" (§2.2)', () => {
  const four = [
    { id: 101, billIndex: 0 },
    { id: 102, billIndex: 1 },
    { id: 103, billIndex: 2 },
    { id: 104, billIndex: 3 },
  ]

  it('numbers every bill 1..M against all siblings', () => {
    expect(four.map((b) => computeBillPosition(four, b.id))).toEqual([
      { index: 0, count: 4 },
      { index: 1, count: 4 },
      { index: 2, count: 4 },
      { index: 3, count: 4 },
    ])
  })

  it('stays contiguous when bill_index has a gap (a skipped single-page bill was deleted)', () => {
    // Bill at bill_index 1 deleted: raw bill_index would render "Bill 4 of 3".
    const gappy = [four[0]!, four[2]!, four[3]!]
    expect(computeBillPosition(gappy, 104)).toEqual({ index: 2, count: 3 })
    expect(computeBillPosition(gappy, 103)).toEqual({ index: 1, count: 3 })
  })

  it('orders by bill_index regardless of input order', () => {
    const shuffled = [four[3]!, four[0]!, four[2]!, four[1]!]
    expect(computeBillPosition(shuffled, 103)).toEqual({ index: 2, count: 4 })
  })

  it('never yields N > M when the current bill is missing from the list', () => {
    const pos = computeBillPosition(four.slice(0, 3), 104)
    expect(pos.index + 1).toBeLessThanOrEqual(pos.count)
  })
})
