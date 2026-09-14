/**
 * Save-time recheck for the three amount-math `reconciliation_exception`
 * types (line_item_tally_mismatch, line_item_row_math_mismatch,
 * ocr_total_vs_amount) — 2026-09-14, in response to "can it recalculate that
 * flag on that bill and see if it's still flagged or not?".
 *
 * Mirrors the math in lib/jobs/handlers/extract.ts's `runTallyChecks`
 * (checks 1, 1b, 1c, 2), but answers a narrower question against
 * reviewer-verified values at save time: does each already-open exception
 * still hold, given what was just saved? A tri-state per type —
 * `true` (still mismatched), `false` (cleared), `null` (not evaluable, e.g.
 * no linked entry to compare against — leave the existing exception alone,
 * same "abstain on absent data" rule the compliance detectors follow).
 *
 * Deliberately does not decide what to DO with a `false` result — these are
 * the "amt issue" bucket (2026-09-14 decision): a passing recheck stamps
 * auto_recheck_note/auto_recheck_cleared_at, never status, so a human still
 * clicks Resolve. That decision lives in lib/actions/review.ts, not here.
 */

import { tallyWithinTolerance } from '@/lib/normalize'
import { lineItemRowMathMismatches, type LineItemMathInput } from '@/lib/extraction-schema'

export interface TallyRecheckInput {
  subtotal: number | null
  taxAmount: number | null
  totalAmount: number | null
  lineItems: LineItemMathInput[]
  /** The single linked entry's amount, or null when there is no (or more
   *  than one) linked entry to compare against — see the same
   *  entry_bill_link resolution rule as extract.ts's `singleEntryId`. */
  linkedEntryAmount: number | null
}

export interface TallyRecheckResult {
  line_item_tally_mismatch: boolean | null
  line_item_row_math_mismatch: boolean
  ocr_total_vs_amount: boolean | null
}

function sumLineItems(lineItems: LineItemMathInput[]): number | null {
  const amounts = lineItems.map((i) => i.amount).filter((a): a is number => a !== null)
  return amounts.length === 0 ? null : amounts.reduce((sum, a) => sum + a, 0)
}

export function recheckTallyExceptions(input: TallyRecheckInput): TallyRecheckResult {
  // Checks 1 + 1b (line_item_tally_mismatch): null unless at least one of the
  // two sub-checks has the fields it needs to run at all.
  let tallyEvaluated = false
  let tallyMismatch = false

  const linesShouldSumTo = input.subtotal ?? input.totalAmount
  const lineTotal = sumLineItems(input.lineItems)
  if (linesShouldSumTo !== null && lineTotal !== null) {
    tallyEvaluated = true
    if (!tallyWithinTolerance(lineTotal, linesShouldSumTo)) tallyMismatch = true
  }
  if (input.subtotal !== null && input.totalAmount !== null) {
    tallyEvaluated = true
    const expected = input.subtotal + (input.taxAmount ?? 0)
    if (!tallyWithinTolerance(expected, input.totalAmount)) tallyMismatch = true
  }

  // Check 1c (line_item_row_math_mismatch): always evaluable — an empty
  // result (no row has quantity+rate+amount all present) legitimately means
  // "no mismatch", same as extract.ts treats it.
  const rowMismatch = lineItemRowMathMismatches(input.lineItems).length > 0

  // Check 2 (ocr_total_vs_amount): only evaluable when there's exactly one
  // linked entry with an amount to compare against.
  const ocrVsAmount =
    input.linkedEntryAmount !== null && input.totalAmount !== null
      ? !tallyWithinTolerance(input.totalAmount, input.linkedEntryAmount)
      : null

  return {
    line_item_tally_mismatch: tallyEvaluated ? tallyMismatch : null,
    line_item_row_math_mismatch: rowMismatch,
    ocr_total_vs_amount: ocrVsAmount,
  }
}
