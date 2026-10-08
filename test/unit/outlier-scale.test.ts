import { describe, expect, it } from 'vitest'
import { niceCeil, outlierScale } from '@/lib/reports/outlier-scale'

const CR = 1_00_00_000
const L = 1_00_000

describe('outlierScale', () => {
  it('caps above the next department when one dwarfs the rest (Venue Setup case)', () => {
    const r = outlierScale([50 * CR, 4.2 * CR, 2.5 * CR, 90 * L, 45 * L])
    expect(r.cap).toBe(6 * CR) // 4.2 Cr × 1.2 = 5.04 Cr → rounded up to 6 Cr
    expect(r.outlierCount).toBe(1)
  })

  it('handles two outliers', () => {
    const r = outlierScale([50 * CR, 40 * CR, 3 * CR, 2 * CR])
    expect(r.cap).not.toBeNull()
    expect(r.outlierCount).toBe(2)
    expect(r.cap!).toBeGreaterThanOrEqual(3 * CR)
    expect(r.cap!).toBeLessThan(40 * CR)
  })

  it('leaves an even spread alone', () => {
    expect(outlierScale([10, 8, 6, 5, 3]).cap).toBeNull()
  })

  it('needs at least 3 positive values', () => {
    expect(outlierScale([100, 1]).cap).toBeNull()
    expect(outlierScale([100, 1, 0, 0]).cap).toBeNull()
  })

  it('never caps below the next value', () => {
    const r = outlierScale([1000, 99, 50, 10])
    expect(r.cap!).toBeGreaterThanOrEqual(99)
    expect(r.outlierCount).toBe(1)
  })
})

describe('niceCeil', () => {
  it('rounds up to a clean step without nearly doubling the value', () => {
    expect(niceCeil(5.04 * CR)).toBe(6 * CR)
    expect(niceCeil(4.8)).toBe(5)
    expect(niceCeil(2.2)).toBe(2.5)
    expect(niceCeil(110)).toBe(120)
    expect(niceCeil(100)).toBe(100)
    expect(niceCeil(0)).toBe(0)
  })
})
