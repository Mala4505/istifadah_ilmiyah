// Shared CSV cell escaping with spreadsheet formula-injection protection
// (security audit M8, docs/security-audit-fix-plan.md 5.1).
//
// Plain module on purpose (no 'use client' / 'server-only'): it is imported
// by client-side exporters and may be imported by Server Components.
//
// Why: a text cell that starts with `=`, `+`, `-`, `@`, TAB or CR is run as a
// formula by Excel / LibreOffice / Sheets when the CSV is opened (e.g. a vendor
// name of `=HYPERLINK("http://evil","click")`, which comes from OCR'd or
// imported text). Prefixing a single quote makes it plain text.

// Real numbers: -500, 1234.50, +5, 12.5%, -1,23,456.00. Deliberately strict --
// anything with an operator, letter or bracket in it does NOT match, so
// `-1+2` or `+cmd|...` are still neutralised.
const PLAIN_NUMBER = /^[-+]?\d[\d,]*(\.\d+)?%?$/

/** Defuse a text value that a spreadsheet would otherwise execute as a formula. */
export function neutraliseFormula(raw: string): string {
  if (/^[=+\-@\t\r]/.test(raw) && !PLAIN_NUMBER.test(raw)) return `'${raw}`
  return raw
}

/**
 * One CSV cell. Numbers pass through untouched (a negative amount stays
 * `-500`). Strings are formula-guarded -- except plain numeric strings, because
 * amount columns reach us as `String(row.amount)` and a negative amount must
 * stay a number in the sheet.
 */
export function csvCell(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  let s = String(raw)
  if (typeof raw === 'string') s = neutraliseFormula(s)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
