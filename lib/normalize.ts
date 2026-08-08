/**
 * Pure normalization functions (MASTER-PLAN §3.4, §3.2, §3.8, §7, §9.4).
 *
 * These are the "duplicates every advance payment if it drifts" functions —
 * no side effects, no I/O, fully deterministic given their inputs. Every
 * runtime-shape edge case called out in §9.4 is exercised in
 * test/unit/normalize.test.ts.
 */

/**
 * Normalizes a UBBL/Main entry number to its canonical string form
 * (MASTER-PLAN §3.4).
 *
 * The Departmental/Main exports mix integers (`202608051`) and strings
 * (`'ADP_202608054'`) for the same logical column. SheetJS/openpyxl hand
 * back a JS number for the former; naively stringifying a float produces
 * `"202608051"` on one runtime and `"202608051.0"` on another, which breaks
 * the unique key `entries.ubbl_number` and silently duplicates rows on the
 * next import. This function is the single choke point that prevents that.
 *
 * Rules (exact, per §3.4):
 * - number input: reject non-finite (NaN/Infinity), reject a fractional
 *   part, otherwise `String(Math.trunc(n))`.
 * - string input: `.trim()`.
 * - anything else (null, undefined, boolean, object, bigint, symbol):
 *   throws a TypeError with a clear message.
 *
 * Judgment calls beyond the literal spec (documented, not silent):
 * - Numbers outside `Number.isSafeInteger` range are rejected too — an ID
 *   that has already lost precision is corrupt data, not a valid ID, and
 *   `Math.trunc` alone would silently produce the wrong string for it.
 * - An empty string (or a string that is only whitespace) is rejected
 *   after trimming — a blank ID is not a valid ID.
 */
export function normalizeId(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`normalizeId: non-finite number is not a valid id (received ${value})`)
    }
    if (value !== Math.trunc(value)) {
      throw new TypeError(`normalizeId: number with a fractional part is not a valid id (received ${value})`)
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`normalizeId: number outside the safe integer range is not a valid id (received ${value})`)
    }
    return String(Math.trunc(value))
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') {
      throw new TypeError('normalizeId: empty string is not a valid id')
    }
    return trimmed
  }

  throw new TypeError(
    `normalizeId: unsupported value type "${value === null ? 'null' : typeof value}" — only finite, whole numbers and non-empty strings are valid ids`
  )
}

/** Legal-entity suffix tokens stripped from the end of a normalized vendor name. */
const LEGAL_SUFFIX_TOKENS = new Set([
  'pvt',
  'private',
  'ltd',
  'limited',
  'llp',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
])

/**
 * Normalizes a free-text vendor name to a stable identity key
 * (MASTER-PLAN §3.2).
 *
 * lowercase → strip punctuation → collapse whitespace → strip trailing
 * legal-entity suffix tokens (repeatedly, e.g. "Pvt Ltd" is two tokens).
 *
 * Deliberately does NOT special-case parentheses: stripping punctuation
 * (including parens) turns `'Poonam Ajay kumar Sharma (Poonam Devi
 * Sharma)'` into `'poonam ajay kumar sharma poonam devi sharma'` — stable,
 * non-empty, and does not crash, which is exactly what §9.4 requires. It
 * does not attempt to *interpret* the alias (that is a human/vendor_alias
 * concern per §3.2), only to avoid corrupting the key.
 */
export function normalizeVendorName(raw: string): string {
  const lowered = raw.toLowerCase()
  // Strip everything that is not a letter, digit, or whitespace.
  const stripped = lowered.replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0)

  // Strip trailing legal-suffix tokens, but never strip the name down to
  // nothing — a company literally named "Pvt Ltd" keeps at least one token.
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]
    if (last !== undefined && LEGAL_SUFFIX_TOKENS.has(last)) {
      tokens.pop()
    } else {
      break
    }
  }

  return tokens.join(' ')
}

/** Controlled vocabulary for line-item units (MASTER-PLAN §3.8, §561). */
const UNIT_LOOKUP: Record<string, string> = {
  sqft: 'sqft',
  no: 'nos',
  nos: 'nos',
  numbers: 'nos',
  day: 'day',
  days: 'day',
  kg: 'kg',
  kgs: 'kg',
  runningfeet: 'rft',
  rft: 'rft',
}

/**
 * Normalizes a unit-of-measure string to the small controlled vocabulary
 * used by `document_extraction_line_item.unit_normalized` (MASTER-PLAN
 * §3.8, §561).
 *
 * This is a dropdown-assisted field set at verify time, not a hard
 * validator — unrecognized input passes through trimmed + lowercased
 * rather than throwing, so a human can still see (and correct) whatever
 * the OCR actually produced.
 */
export function normalizeUnit(raw: string): string {
  const cleaned = raw.trim().toLowerCase()
  const key = cleaned.replace(/[.\s]/g, '')
  const mapped = UNIT_LOOKUP[key]
  return mapped ?? cleaned
}

/**
 * Tally/reconciliation epsilon check (MASTER-PLAN §7, §9.4).
 *
 * Two amounts are "within tolerance" when their absolute difference is no
 * more than the TIGHTER of a flat ₹1 and 0.05% of the larger of the two
 * amounts. At any realistic invoice/entry amount (above ~₹2,000) the 0.05%
 * bound exceeds ₹1, so the effective tolerance caps at a flat ₹1 — which is
 * what the §7 review-screen footer shows ("variance ₹1 · within
 * tolerance") and what §9.4's own examples require:
 *   - `2216011.00` vs `2216010.89` (diff ₹0.11) → within the ₹1 cap → passes.
 *   - `2216011` vs `2216111` (diff ₹100) → exceeds the ₹1 cap → fails,
 *     even though ₹100 is well under 0.05% of ~₹22 lakh (~₹1,108) — a pure
 *     percentage-only reading would wrongly pass this case, which is why
 *     the tighter (not looser) of the two bounds is used.
 * For small amounts (below ~₹2,000) the 0.05% bound is the tighter one,
 * giving proportionally stricter tolerance where a flat ₹1 would be too
 * generous relative to the amount.
 */
export function tallyWithinTolerance(a: number, b: number): boolean {
  const diff = Math.abs(a - b)
  const larger = Math.max(Math.abs(a), Math.abs(b))
  const tolerance = Math.min(1, larger * 0.0005)
  return diff <= tolerance
}
