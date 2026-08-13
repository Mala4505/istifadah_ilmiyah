import { describe, expect, it } from 'vitest'
import {
  computeGstinCheckDigit,
  isInterstateSupply,
  normalizeGstin,
  panFromGstin,
  validateGstin,
} from '@/lib/analytics/gstin'

/**
 * Every GSTIN in REAL_GSTINS was read off an actual invoice in the pilot corpus
 * (Invoices/, 21 venue-setup documents). They are the ground truth for the
 * checksum implementation: if a change to computeGstinCheckDigit breaks any of
 * these, the change is wrong, not the fixture.
 */
const REAL_GSTINS = {
  // Buyer on nearly every invoice — Dawat-E-Hadiyah, Maharashtra.
  dawatEHadiyah: '27AAATD1489N1ZA',
  // Adinath Furniture Pvt Ltd, Surat — e-invoice, IGST 18%.
  adinath: '24AAKCA3560A1Z7',
  // Creative Frames & Decor, Nanpura — the sqft-rated decor vendor.
  creativeFrames: '24BBBPS5730A1Z4',
  // Vardhaman Furnitures — check digit is a letter, exercising the >9 branch.
  vardhaman: '24ABOPD9860G1ZG',
  // Shree Bhavya Enterprise — handwritten invoice.
  shreeBhavya: '24AJYPS2255A1Z3',
} as const

describe('computeGstinCheckDigit', () => {
  it.each(Object.entries(REAL_GSTINS))(
    'reproduces the printed check digit for %s',
    (_name, gstin) => {
      expect(computeGstinCheckDigit(gstin.slice(0, 14))).toBe(gstin[14])
    }
  )

  it('returns a letter when the check value exceeds 9', () => {
    // 24ABOPD9860G1ZG sums to 200; (36 - 200 % 36) % 36 = 16 -> 'G'.
    expect(computeGstinCheckDigit('24ABOPD9860G1Z')).toBe('G')
  })

  it('returns null for input that is not exactly 14 characters', () => {
    expect(computeGstinCheckDigit('24ABOPD9860G1')).toBeNull()
    expect(computeGstinCheckDigit('24ABOPD9860G1ZG')).toBeNull()
  })

  it('returns null when a character is outside the 0-9A-Z alphabet', () => {
    expect(computeGstinCheckDigit('24ABOPD9860G1-')).toBeNull()
  })
})

describe('normalizeGstin', () => {
  it('strips the embedded spaces invoices are written with', () => {
    // Shree Bhavya's handwritten invoice reads "24 AAATD 1489 N1ZA".
    expect(normalizeGstin('24 AAATD 1489 N1ZA')).toBe('24AAATD1489N1ZA')
  })

  it('upper-cases and strips hyphens', () => {
    expect(normalizeGstin('24-aakca3560a1z7')).toBe('24AAKCA3560A1Z7')
  })
})

describe('validateGstin', () => {
  it.each(Object.entries(REAL_GSTINS))('accepts the real GSTIN %s', (_name, gstin) => {
    const result = validateGstin(gstin)
    expect(result.valid).toBe(true)
  })

  it('returns the state, PAN and entity number on success', () => {
    const result = validateGstin(REAL_GSTINS.adinath)
    expect(result).toMatchObject({
      valid: true,
      stateCode: '24',
      stateName: 'Gujarat',
      pan: 'AAKCA3560A',
      entityNumber: '1',
    })
  })

  it('accepts a GSTIN written with spaces and in lower case', () => {
    expect(validateGstin(' 27 aaatd1489 n1za ').valid).toBe(true)
  })

  it('reports empty separately from malformed', () => {
    expect(validateGstin(null)).toMatchObject({ valid: false, reason: 'empty' })
    expect(validateGstin('   ')).toMatchObject({ valid: false, reason: 'empty' })
  })

  it('rejects the wrong length', () => {
    expect(validateGstin('24AAKCA3560A1Z')).toMatchObject({ valid: false, reason: 'length' })
  })

  it('rejects a bad state code', () => {
    // 00 is not an allocated state code; the rest of the GSTIN is well-formed.
    expect(validateGstin('00AAKCA3560A1Z7')).toMatchObject({
      valid: false,
      reason: 'state_code',
    })
  })

  it('rejects a PAN field that is not 5 letters, 4 digits, 1 letter', () => {
    expect(validateGstin('24AAKC43560A1Z7')).toMatchObject({ valid: false, reason: 'shape' })
  })

  it('rejects a 14th character that is not Z', () => {
    expect(validateGstin('24AAKCA3560A1Y7')).toMatchObject({ valid: false, reason: 'shape' })
  })

  it('catches a single transposed character via the checksum', () => {
    // Adinath's GSTIN with 3560 -> 3650. Shape and state stay valid; only the
    // check digit gives it away, which is exactly the OCR failure mode.
    const result = validateGstin('24AAKCA3650A1Z7')
    expect(result).toMatchObject({ valid: false, reason: 'checksum' })
    if (!result.valid) {
      expect(result.expectedCheckDigit).toBeDefined()
      expect(result.expectedCheckDigit).not.toBe('7')
    }
  })

  it('resolves stateName for every valid code, including the two non-state ones', () => {
    // The state table backing stateCodeFromName is exhaustive (needed to
    // resolve a real invoice's free-text "Place of Supply" field), so unlike
    // an earlier, partial display map, nothing here is left unmapped.
    const built = '97AAKCA3560A1Z'
    const gstin = built + computeGstinCheckDigit(built)
    expect(validateGstin(gstin)).toMatchObject({ valid: true, stateName: 'Other Territory' })
  })
})

describe('panFromGstin', () => {
  it('extracts the PAN from a valid GSTIN', () => {
    expect(panFromGstin(REAL_GSTINS.creativeFrames)).toBe('BBBPS5730A')
  })

  it('still extracts the PAN when only the check digit is wrong', () => {
    // The clustering case: OCR fumbled the last character but the PAN — the part
    // that proves two vendor rows are one legal entity — is intact.
    expect(panFromGstin('24BBBPS5730A1Z9')).toBe('BBBPS5730A')
  })

  it('returns null when the PAN field itself is malformed', () => {
    expect(panFromGstin('24BBB1S5730A1Z4')).toBeNull()
  })

  it('returns null for wrong length or null input', () => {
    expect(panFromGstin('24BBBPS5730A')).toBeNull()
    expect(panFromGstin(null)).toBeNull()
  })
})

describe('isInterstateSupply', () => {
  it('is true for a Gujarat supplier billing a Maharashtra buyer', () => {
    // The dominant case in the corpus: Surat vendors billing Dawat-E-Hadiyah in
    // Mumbai. IGST is correct; CGST+SGST would make the ITC unclaimable.
    expect(isInterstateSupply('24', '27')).toBe(true)
  })

  it('is false within a single state', () => {
    expect(isInterstateSupply('24', '24')).toBe(false)
  })

  it('abstains rather than guessing when either side is unknown', () => {
    expect(isInterstateSupply('24', null)).toBeNull()
    expect(isInterstateSupply(null, '27')).toBeNull()
    expect(isInterstateSupply('24', '00')).toBeNull()
  })
})
