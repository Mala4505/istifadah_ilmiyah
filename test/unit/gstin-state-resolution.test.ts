import { describe, expect, it } from 'vitest'
import { stateCodeFromName } from '@/lib/analytics/gstin'

/**
 * stateCodeFromName resolves an invoice's free-text "Place of Supply" field
 * (which the extraction pipeline captures verbatim — "Maharashtra", not "27")
 * to the two-digit code the compliance detectors compare against the
 * supplier's own GSTIN-derived state. Getting this wrong means
 * detectGstTypeMismatch silently never fires, so every case here is a real
 * shape a real invoice's field can take.
 */
describe('stateCodeFromName', () => {
  it('resolves a bare two-digit code unchanged', () => {
    expect(stateCodeFromName('27')).toBe('27')
  })

  it('resolves a state name case-insensitively', () => {
    expect(stateCodeFromName('Maharashtra')).toBe('27')
    expect(stateCodeFromName('MAHARASHTRA')).toBe('27')
    expect(stateCodeFromName('maharashtra')).toBe('27')
  })

  it('trims whitespace an OCR read can introduce', () => {
    expect(stateCodeFromName('  Gujarat  ')).toBe('24')
  })

  it('resolves every state named on an invoice in the pilot corpus', () => {
    expect(stateCodeFromName('Gujarat')).toBe('24')
    expect(stateCodeFromName('Maharashtra')).toBe('27')
  })

  it('resolves a multi-word state name', () => {
    expect(stateCodeFromName('Tamil Nadu')).toBe('33')
    expect(stateCodeFromName('Andhra Pradesh')).toBe('37')
  })

  it('returns null for a name not in the table rather than guessing', () => {
    expect(stateCodeFromName('Narnia')).toBeNull()
  })

  it('returns null for a numeric code that is not a valid state code', () => {
    expect(stateCodeFromName('00')).toBeNull()
  })

  it('returns null for empty or missing input', () => {
    expect(stateCodeFromName('')).toBeNull()
    expect(stateCodeFromName('   ')).toBeNull()
    expect(stateCodeFromName(null)).toBeNull()
    expect(stateCodeFromName(undefined)).toBeNull()
  })
})
