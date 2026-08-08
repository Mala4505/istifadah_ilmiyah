import { describe, expect, it } from 'vitest'
import { normalizeId, normalizeVendorName, normalizeUnit, tallyWithinTolerance } from '@/lib/normalize'

describe('normalizeId', () => {
  // MASTER-PLAN §9.4: "Integer 202608051 and string 'ADP_202608054'
  // produce the same result on both runtimes; floats rejected; whitespace
  // trimmed."
  it('normalizes a numeric UBBL to a clean integer string', () => {
    expect(normalizeId(202608051)).toBe('202608051')
  })

  it('normalizes a string id to its trimmed form', () => {
    expect(normalizeId('ADP_202608054')).toBe('ADP_202608054')
  })

  it('trims surrounding whitespace on string ids', () => {
    expect(normalizeId('  ADP_202608054  ')).toBe('ADP_202608054')
  })

  it('treats a number with a trailing .0 the same as its integer form', () => {
    // JS collapses 202608051 and 202608051.0 to the same number, so this
    // is really asserting normalizeId is stable across that non-distinction.
    expect(normalizeId(202608051.0)).toBe('202608051')
  })

  it('rejects a number with a genuine fractional part', () => {
    expect(() => normalizeId(202608051.5)).toThrow(TypeError)
  })

  it('rejects NaN', () => {
    expect(() => normalizeId(NaN)).toThrow(TypeError)
  })

  it('rejects Infinity and -Infinity', () => {
    expect(() => normalizeId(Infinity)).toThrow(TypeError)
    expect(() => normalizeId(-Infinity)).toThrow(TypeError)
  })

  it('rejects numbers outside the safe integer range', () => {
    expect(() => normalizeId(Number.MAX_SAFE_INTEGER + 10)).toThrow(TypeError)
  })

  it('rejects null and undefined', () => {
    expect(() => normalizeId(null)).toThrow(TypeError)
    expect(() => normalizeId(undefined)).toThrow(TypeError)
  })

  it('rejects objects, booleans, and other non-id shapes', () => {
    expect(() => normalizeId({})).toThrow(TypeError)
    expect(() => normalizeId(true)).toThrow(TypeError)
    expect(() => normalizeId([])).toThrow(TypeError)
  })

  it('rejects an empty or whitespace-only string', () => {
    expect(() => normalizeId('')).toThrow(TypeError)
    expect(() => normalizeId('   ')).toThrow(TypeError)
  })

  it('preserves negative integers as a clean string', () => {
    expect(normalizeId(-42)).toBe('-42')
  })
})

describe('normalizeVendorName', () => {
  // MASTER-PLAN §9.4: "'Al Nafees Tech' / 'AL NAFEES TECH.' / 'Al  Nafees
  // Tech' collapse to one key; 'Poonam Ajay kumar Sharma (Poonam Devi
  // Sharma)' is stable"
  it('collapses case, punctuation, and repeated whitespace variants to the same key', () => {
    const a = normalizeVendorName('Al Nafees Tech')
    const b = normalizeVendorName('AL NAFEES TECH.')
    const c = normalizeVendorName('Al  Nafees  Tech')
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a).toBe('al nafees tech')
  })

  it('does not crash on, or empty out, a parenthesized alias', () => {
    const result = normalizeVendorName('Poonam Ajay kumar Sharma (Poonam Devi Sharma)')
    expect(result).not.toBe('')
    expect(result).toBe('poonam ajay kumar sharma poonam devi sharma')
  })

  it('is stable across repeated calls (idempotent-ish on already-normalized input)', () => {
    const once = normalizeVendorName('Al Nafees Tech')
    const twice = normalizeVendorName(once)
    expect(once).toBe(twice)
  })

  it('strips common legal suffixes', () => {
    expect(normalizeVendorName('Acme Traders Pvt Ltd')).toBe('acme traders')
    expect(normalizeVendorName('Acme Traders Private Limited')).toBe('acme traders')
    expect(normalizeVendorName('Acme LLP')).toBe('acme')
    expect(normalizeVendorName('Acme Inc.')).toBe('acme')
  })

  it('never strips a name down to an empty string', () => {
    expect(normalizeVendorName('Pvt Ltd')).not.toBe('')
  })
})

describe('normalizeUnit', () => {
  // MASTER-PLAN §9.4: "sqft / sq ft / SQ.FT. → one value"
  it('collapses sqft variants', () => {
    expect(normalizeUnit('sqft')).toBe('sqft')
    expect(normalizeUnit('sq ft')).toBe('sqft')
    expect(normalizeUnit('SQ.FT.')).toBe('sqft')
    expect(normalizeUnit('sq.ft')).toBe('sqft')
  })

  it('collapses nos variants', () => {
    expect(normalizeUnit('nos')).toBe('nos')
    expect(normalizeUnit('no.')).toBe('nos')
    expect(normalizeUnit('numbers')).toBe('nos')
  })

  it('collapses day variants', () => {
    expect(normalizeUnit('day')).toBe('day')
    expect(normalizeUnit('days')).toBe('day')
  })

  it('collapses kg variants', () => {
    expect(normalizeUnit('kg')).toBe('kg')
    expect(normalizeUnit('kgs')).toBe('kg')
  })

  it('collapses running-feet variants', () => {
    expect(normalizeUnit('running feet')).toBe('rft')
    expect(normalizeUnit('rft')).toBe('rft')
    expect(normalizeUnit('r.ft')).toBe('rft')
  })

  it('passes unrecognized units through trimmed and lowercased, without throwing', () => {
    expect(normalizeUnit('  Litre  ')).toBe('litre')
    expect(() => normalizeUnit('bags')).not.toThrow()
    expect(normalizeUnit('bags')).toBe('bags')
  })
})

describe('tallyWithinTolerance', () => {
  // MASTER-PLAN §9.4: "2216011.00 vs 2216010.89 passes; 2216011 vs
  // 2216111 fails"
  it('passes for a small rounding-scale discrepancy', () => {
    expect(tallyWithinTolerance(2216011.0, 2216010.89)).toBe(true)
  })

  it('fails for a ₹100 discrepancy even though it is a tiny percentage of the total', () => {
    expect(tallyWithinTolerance(2216011, 2216111)).toBe(false)
  })

  it('passes for identical amounts', () => {
    expect(tallyWithinTolerance(100, 100)).toBe(true)
  })

  it('passes for an exact ₹1 discrepancy at the boundary', () => {
    expect(tallyWithinTolerance(500000, 500001)).toBe(true)
  })

  it('fails for a discrepancy just over ₹1 on a large amount', () => {
    expect(tallyWithinTolerance(500000, 500001.01)).toBe(false)
  })

  it('applies a tighter-than-₹1 tolerance for small amounts', () => {
    // 0.05% of 100 is 0.05 — smaller than the ₹1 floor, so a ₹0.20 gap
    // on a ₹100 comparison must fail even though it is under ₹1.
    expect(tallyWithinTolerance(100, 100.2)).toBe(false)
    expect(tallyWithinTolerance(100, 100.02)).toBe(true)
  })

  it('is symmetric in its arguments', () => {
    expect(tallyWithinTolerance(2216011.0, 2216010.89)).toBe(
      tallyWithinTolerance(2216010.89, 2216011.0)
    )
  })
})
