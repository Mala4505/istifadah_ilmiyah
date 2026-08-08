/**
 * Pure, DB-free helpers for the import pipeline (MASTER-PLAN §3.6 day 2).
 * Deliberately split out of lib/import/run-import.ts — that file imports
 * `pg` and `@/lib/env` (which validates the full server env, including
 * DATABASE_URL/SUPABASE_SECRET_KEY, at module load time), so importing it
 * from a unit test would require real credentials just to exercise a
 * string-parsing function. Nothing in this file touches a database or an
 * environment variable, so test/unit/run-import.test.ts can import it on
 * its own.
 */

import { tallyWithinTolerance } from '@/lib/normalize'

/**
 * Parses the short label out of a raw budget-head label's trailing
 * parenthetical, e.g. `"Venue setup (AVIT)"` -> `"AVIT"`. No trailing
 * parenthetical -> null. Only the LAST parenthetical group counts, so a name
 * that itself contains parentheses earlier is left alone up to that point.
 */
export function parseBudgetHeadShortLabel(rawLabel: string): string | null {
  const match = rawLabel.match(/\(([^()]+)\)\s*$/)
  const short = match?.[1]?.trim()
  return short && short.length > 0 ? short : null
}

export interface AllocationSumMismatch {
  budgetHeadId: number
  budgetHeadLabel: string
  expectedUtilised: number
  actualEntrySum: number
  diff: number
}

/**
 * §3.6 point 8 / §3.4: sum(entry.tenant_amount) must equal
 * allocation.utilised_amount, per head, within the standard tally tolerance
 * (MASTER-PLAN §7 / normalize.ts tallyWithinTolerance). Pure over plain
 * maps so it can be tested without a database.
 */
export function checkAllocationSumMismatches(
  heads: Array<{ budgetHeadId: number; budgetHeadLabel: string; utilisedAmount: number | null }>,
  entrySumsByHead: Map<number, number>
): AllocationSumMismatch[] {
  const mismatches: AllocationSumMismatch[] = []
  for (const head of heads) {
    if (head.utilisedAmount === null) continue
    const actual = entrySumsByHead.get(head.budgetHeadId) ?? 0
    if (!tallyWithinTolerance(actual, head.utilisedAmount)) {
      mismatches.push({
        budgetHeadId: head.budgetHeadId,
        budgetHeadLabel: head.budgetHeadLabel,
        expectedUtilised: head.utilisedAmount,
        actualEntrySum: actual,
        diff: actual - head.utilisedAmount,
      })
    }
  }
  return mismatches
}

/**
 * §3.4 / §3.6 point 8's namespace-collision check: no value may appear in
 * both the ubbl_number and main_number columns across different rows.
 * Pure set-intersection over plain arrays so it can be tested without a
 * database.
 */
export function checkNamespaceCollisions(ubblNumbers: string[], mainNumbers: string[]): string[] {
  const mainSet = new Set(mainNumbers)
  const collisions = new Set<string>()
  for (const ubbl of ubblNumbers) {
    if (mainSet.has(ubbl)) collisions.add(ubbl)
  }
  return [...collisions].sort()
}
