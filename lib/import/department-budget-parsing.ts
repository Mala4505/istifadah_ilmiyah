/**
 * Pure, DB-free helpers for the department-budget import (review-page-
 * redesign plan §11). Split out of lib/import/run-department-budget-import.ts
 * for the same reason lib/import/assertions.ts is split out of run-import.ts
 * (see test/unit/run-import.test.ts's header comment): so header-matching,
 * name-normalization, and amount-parsing can be unit tested without `pg` or
 * the server env (DATABASE_URL, …) just to exercise a string function.
 *
 * Also reused by components/import/department-budget-row-log-table.tsx so
 * the dry-run preview's column-matching stays in lockstep with what the
 * importer itself actually reads — one definition of "which header counts as
 * the department/amount column," not two that could drift apart.
 */

export const DEPARTMENT_KEYS = ['department', 'department name', 'dept', 'dept name', 'name'] as const
export const AMOUNT_KEYS = [
  'budget amount',
  'amount',
  'budget',
  'budget allocation',
  'allocation amount',
  'allocated amount',
] as const

export const TOTAL_ROW_MARKERS = ['total', 'grand total', 'totals']

/** Case/whitespace-insensitive header match — same normalization idiom as
 *  components/import/row-log-table.tsx's `normalizeKey` for the entries
 *  importer's own preview table. */
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Finds the first candidate header (matched via normalizeKey) with a
 *  non-blank value in `row`, or null if none of the candidates are present /
 *  all are blank. */
export function pickField(row: Record<string, unknown>, candidates: readonly string[]): string | null {
  const normalized = new Map<string, unknown>()
  for (const [key, value] of Object.entries(row)) {
    normalized.set(normalizeKey(key), value)
  }
  for (const candidate of candidates) {
    const value = normalized.get(candidate)
    if (value !== null && value !== undefined && String(value).trim() !== '') return String(value)
  }
  return null
}

/** Case-insensitive/trimmed/whitespace-collapsed match key for department
 *  names — deliberately NOT the same normalization as vendor names
 *  (lib/normalize.ts's normalizeVendorName strips punctuation etc.):
 *  departments are a small curated list, an exact (modulo case/whitespace)
 *  match is the whole point, not fuzzy resolution. */
export function normalizeDepartmentName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** True when `departmentRaw` is a totals/grand-total row rather than an
 *  actual department name, matched case-insensitively after trimming. */
export function isTotalRowMarker(departmentRaw: string): boolean {
  return TOTAL_ROW_MARKERS.includes(departmentRaw.trim().toLowerCase())
}

/**
 * Strips thousands separators from a numeric-looking cell before parsing —
 * same fix run-import.ts's sanitizeNumericColumns applies, for the same
 * reason: xlsx's `raw:false` mode formats money cells as e.g. "12,500.00".
 *
 * Returns `null` for a blank string (amount genuinely absent) and `NaN` for
 * a non-blank string that doesn't parse as a number (present but garbled) —
 * callers distinguish the two: null is a legitimate "no budget set" import
 * row, NaN is a row-level error.
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim()
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}
