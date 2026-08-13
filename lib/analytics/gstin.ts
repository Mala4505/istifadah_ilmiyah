/**
 * GSTIN structural validation (Phase 2, compliance pillar).
 *
 * Pure, no I/O, deterministic — same class of function as lib/normalize.ts, and
 * exercised the same way in test/unit/gstin.test.ts.
 *
 * This validates the *structure* of a GSTIN, not its existence. A GSTIN that
 * passes here may still be deregistered or belong to someone else; only the GSTN
 * portal can answer that. What it does catch — and what it is here for — is the
 * far more common failure: a GSTIN mis-keyed during data entry or mis-read by
 * OCR. Those produce a checksum failure essentially every time, because the
 * check digit is computed over all fourteen preceding characters.
 *
 * Getting this wrong in the other direction matters too: flagging a *valid*
 * GSTIN as invalid sends a reviewer to re-check a correct invoice, and a
 * detector that cries wolf gets switched off. The checksum implementation below
 * was verified by hand against four GSTINs taken from real invoices in the
 * corpus before being written (see test/unit/gstin.test.ts).
 */

/** Positional value alphabet for the check-digit computation: 0-9 then A-Z. */
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * State codes in use. 01–38 are states/UTs; 97 is "Other Territory" (offshore),
 * 99 is "Centre Jurisdiction". Codes 26 and 34 were merged/retired in the UT
 * reorganisations but remain valid on historical invoices, so they are accepted.
 */
const VALID_STATE_CODES = new Set<string>([
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
  '97',
  '99',
])

/** Human-readable state names, for the flag description. Not exhaustive by design —
 *  an unmapped-but-valid code falls back to the bare code rather than throwing. */
const STATE_NAMES: Record<string, string> = {
  '24': 'Gujarat',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '19': 'West Bengal',
  '23': 'Madhya Pradesh',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
}

/**
 * 15 characters: 2-digit state code, 10-character PAN, 1 entity number,
 * a literal 'Z', then the check digit.
 *
 * The 14th character is 'Z' on every GSTIN issued to date — it is a reserved
 * placeholder, not a variable field. Anchoring on it is a cheap, high-signal
 * catch for a transposition that would otherwise only surface as a checksum
 * failure with no explanation of *what* was wrong.
 */
const GSTIN_SHAPE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])(Z)([0-9A-Z])$/

export type GstinFailureReason =
  | 'empty'
  | 'length'
  | 'shape'
  | 'state_code'
  | 'checksum'

export type GstinValidation =
  | {
      valid: true
      gstin: string
      stateCode: string
      stateName: string | null
      pan: string
      entityNumber: string
    }
  | {
      valid: false
      gstin: string
      reason: GstinFailureReason
      /** Set only when reason === 'checksum': what the check digit should have been. */
      expectedCheckDigit?: string
      message: string
    }

/**
 * Normalizes a GSTIN as written on an invoice into its canonical comparison form.
 *
 * Invoices in the corpus write GSTINs with embedded spaces (`24 AAATD 1489 N1ZA`)
 * and in lower case; handwritten ones do both. Normalizing before validating is
 * what makes the difference between "OCR read it fine, we rejected it on
 * formatting" and a genuine finding.
 */
export function normalizeGstin(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

/**
 * Computes the GSTIN check digit over the first 14 characters.
 *
 * The algorithm is the GSTN-published variant of the Luhn mod-N scheme:
 * each character's positional value is multiplied by an alternating 1/2 factor
 * (factor 1 on even indices), the product is folded as `floor(p/36) + (p % 36)`,
 * and the check digit is whatever brings the running total to a multiple of 36.
 *
 * Returns null if any of the first 14 characters is outside the alphabet, which
 * means the caller already failed the shape check and there is nothing to compute.
 */
export function computeGstinCheckDigit(first14: string): string | null {
  if (first14.length !== 14) return null

  let sum = 0
  for (let i = 0; i < 14; i += 1) {
    const value = CHARSET.indexOf(first14[i] as string)
    if (value === -1) return null
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }

  return CHARSET[(36 - (sum % 36)) % 36] as string
}

/**
 * Validates a GSTIN and, on success, returns the fields the compliance detectors
 * need: the state code (for the interstate IGST-vs-CGST/SGST test) and the
 * embedded PAN (for vendor clustering — two "different" vendors sharing a PAN
 * are the same legal entity).
 */
export function validateGstin(raw: string | null | undefined): GstinValidation {
  if (raw == null || raw.trim() === '') {
    return { valid: false, gstin: '', reason: 'empty', message: 'No GSTIN present.' }
  }

  const gstin = normalizeGstin(raw)

  if (gstin.length !== 15) {
    return {
      valid: false,
      gstin,
      reason: 'length',
      message: `GSTIN must be 15 characters; got ${gstin.length}.`,
    }
  }

  const match = GSTIN_SHAPE.exec(gstin)
  if (match === null) {
    return {
      valid: false,
      gstin,
      reason: 'shape',
      message:
        'GSTIN does not match the required pattern (2-digit state, 10-character PAN, entity number, Z, check digit).',
    }
  }

  const stateCode = match[1] as string
  const pan = match[2] as string
  const entityNumber = match[3] as string

  if (!VALID_STATE_CODES.has(stateCode)) {
    return {
      valid: false,
      gstin,
      reason: 'state_code',
      message: `"${stateCode}" is not a valid GST state code.`,
    }
  }

  const expected = computeGstinCheckDigit(gstin.slice(0, 14))
  if (expected === null || expected !== gstin[14]) {
    return {
      valid: false,
      gstin,
      reason: 'checksum',
      expectedCheckDigit: expected ?? undefined,
      message:
        `Check digit is "${gstin[14]}" but should be "${expected ?? '?'}" — ` +
        'the GSTIN is mis-typed or mis-read.',
    }
  }

  return {
    valid: true,
    gstin,
    stateCode,
    stateName: STATE_NAMES[stateCode] ?? null,
    pan,
    entityNumber,
  }
}

/**
 * Extracts the PAN from a GSTIN without requiring the checksum to pass.
 *
 * Vendor clustering wants the PAN even off a GSTIN whose last character OCR got
 * wrong: characters 3–12 are their own well-formed field, and a shared PAN is
 * strong evidence two vendor records are one entity regardless of whether the
 * check digit survived the scan. Returns null when the PAN field itself is
 * malformed, since at that point there is nothing to cluster on.
 */
export function panFromGstin(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const gstin = normalizeGstin(raw)
  if (gstin.length !== 15) return null
  const pan = gstin.slice(2, 12)
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? pan : null
}

/**
 * Whether a supply between two state codes must be charged IGST.
 *
 * Interstate → IGST. Intrastate → CGST + SGST. Charging the wrong pair does not
 * change what the buyer pays, which is exactly why it goes unnoticed — but it
 * makes the input tax credit unclaimable until the supplier files an amendment,
 * so the money is real.
 *
 * Returns null when either side is unknown, so the detector abstains rather than
 * guessing; a false "wrong GST type" flag on an invoice whose place of supply
 * simply was not captured is worse than no flag.
 */
export function isInterstateSupply(
  supplierStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined
): boolean | null {
  if (!supplierStateCode || !placeOfSupplyStateCode) return null
  if (!VALID_STATE_CODES.has(supplierStateCode)) return null
  if (!VALID_STATE_CODES.has(placeOfSupplyStateCode)) return null
  return supplierStateCode !== placeOfSupplyStateCode
}
