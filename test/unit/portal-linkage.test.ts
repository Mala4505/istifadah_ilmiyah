/**
 * Audit-portal -> Hub-entry linkage (MASTER-PLAN §17.23, Phase 3 item 1).
 *
 * The Audit portal shows only its own "Entry Number" — it does NOT show the
 * originating UBBL number (confirmed 2026-08-13). Everything the Audit import
 * can do therefore rests on one claim: that number is the same value the
 * Departmental export carries in its "Main Entry Number" column, which the
 * .xlsx import writes to `entries.main_number`.
 *
 * That claim is the single point of failure for the whole Audit direction, and
 * it is about two external systems neither of us controls — so it is pinned
 * here against BOTH real sources rather than assumed:
 *
 *   - the real Departmental export in Departmental/, read at test time
 *   - the Audit portal's real rows, transcribed from the 2026-08-13 screenshot
 *
 * If either side ever renumbers, this test fails with the exact unmatched
 * values, instead of a production import quietly reporting every row as
 * `audit_unmatched`.
 */

import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import path from 'node:path'
import { parsePortalTable } from '@/lib/import/portal-mapping'
import { parseDepartmentalRow, INITIAL_DEPARTMENTAL_CONTEXT, type DepartmentalRowContext } from '@/lib/module-mapping'

const EXPORT_PATH = path.join(
  process.cwd(),
  'Departmental',
  'tenant_multiple_budget_6_20260807_102230.xlsx'
)

/** The Audit portal table, transcribed from the 2026-08-13 screenshot. */
const AUDIT_HEADERS = [
  'Entry Number',
  'Invoice',
  'Budget Head',
  'Vendor',
  'Amount',
  'Status',
  'Date',
  'Department',
  'Action Button',
]

const AUDIT_ROWS: string[][] = [
  ['2026080532', 'NA', 'Venue Setup', 'Avs Decor Pvt Ltd', '14,49,393.00', 'Tax Invoice Upload Pending (Paid)', '05/08/2026', 'Istifada Ilmiyah', 'View'],
  ['2026080531', '123', 'Venue Setup', 'Poonam Ajay kumar Sharma (Poonam Devi Sharma)', '8,400.00', 'Paid', '05/08/2026', 'Istifada Ilmiyah', 'View'],
  ['2026080530', '122', 'Venue Setup', 'Poonam Ajay kumar Sharma (Poonam Devi Sharma)', '8,000.00', 'Paid', '05/08/2026', 'Istifada Ilmiyah', 'View'],
  ['2026080529', '121', 'Venue Setup', 'Poonam Ajay kumar Sharma (Poonam Devi Sharma)', '4,700.00', 'Paid', '05/08/2026', 'Istifada Ilmiyah', 'View'],
  ['2026080528', 'SLTG-20', 'Venue Setup', 'Al Nafees Tech', '7,42,118.00', 'Paid', '05/08/2026', 'Istifada Ilmiyah', 'View'],
  ['2026080527', '120', 'Venue Setup', 'Poonam Ajay kumar Sharma (Poonam Devi Sharma)', '9,750.00', 'Paid', '05/08/2026', 'Istifada Ilmiyah', 'View'],
  ['2026080526', '756', 'Venue Setup', 'Juzer saifuddin saleh', '12,500.00', 'Paid', '05/08/2026', 'Istifada Ilmiyah', 'View'],
  ['2026080525', '755', 'Venue Setup', 'Juzer saifuddin saleh', '12,000.00', 'Paid', '05/08/2026', 'Istifada Ilmiyah', 'View'],
]

/** main_number -> ubbl_number, exactly as the .xlsx import would write them. */
function departmentalMainToUbbl(): Map<string, string> {
  const workbook = XLSX.readFile(EXPORT_PATH)
  const sheet = workbook.Sheets['All Budget Entries']!
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: '',
  })

  const map = new Map<string, string>()
  let context: DepartmentalRowContext = INITIAL_DEPARTMENTAL_CONTEXT
  for (const rawRow of rawRows) {
    const { row, nextContext } = parseDepartmentalRow(rawRow, context)
    context = nextContext
    if (row.entry?.mainNumber) map.set(row.entry.mainNumber, row.entry.ubblNumber)
  }
  return map
}

describe('Audit portal entry numbers link to Hub entries via main_number', () => {
  const mainToUbbl = departmentalMainToUbbl()
  const scraped = parsePortalTable({
    headers: AUDIT_HEADERS,
    rows: AUDIT_ROWS,
    sourceSystem: 'audit',
  })

  it('reads every Audit row as a main_number and no ubbl_number', () => {
    for (const row of scraped.rows) {
      expect(row.mainNumber).not.toBeNull()
      expect(row.ubblNumber).toBeNull()
    }
  })

  it('matches every Audit row to a departmental entry', () => {
    const unmatched = scraped.rows
      .map((r) => r.mainNumber!)
      .filter((mainNumber) => !mainToUbbl.has(mainNumber))

    // Named explicitly so a failure says WHICH numbers stopped matching.
    expect(unmatched).toEqual([])
  })

  it('resolves each Audit row to the expected departmental UBBL number', () => {
    const resolved = scraped.rows.map((r) => [r.mainNumber, mainToUbbl.get(r.mainNumber!)])
    expect(resolved).toEqual([
      ['2026080532', '202608058'],
      ['2026080531', '202608057'],
      ['2026080530', '202608056'],
      ['2026080529', '202608055'],
      ['2026080528', '202608054'],
      ['2026080527', '202608053'],
      ['2026080526', '202608051'],
      ['2026080525', '202608052'],
    ])
  })

  it('never maps two Audit rows onto the same Hub entry', () => {
    const ubbls = scraped.rows.map((r) => mainToUbbl.get(r.mainNumber!))
    expect(new Set(ubbls).size).toBe(ubbls.length)
  })

  it('documents the entries the Audit portal has not reached yet', () => {
    // Two departmental entries carry no Main Entry Number at all, so nothing on
    // the Audit side can ever link to them until the Departmental system
    // assigns one. Asserted so the count is a known quantity rather than a
    // surprise in a variance report.
    const workbook = XLSX.readFile(EXPORT_PATH)
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      workbook.Sheets['All Budget Entries']!,
      { raw: false, defval: '' }
    )
    let context: DepartmentalRowContext = INITIAL_DEPARTMENTAL_CONTEXT
    let entriesWithoutMain = 0
    let totalEntries = 0
    for (const rawRow of rawRows) {
      const { row, nextContext } = parseDepartmentalRow(rawRow, context)
      context = nextContext
      if (row.entry) {
        totalEntries++
        if (!row.entry.mainNumber) entriesWithoutMain++
      }
    }
    expect(totalEntries).toBe(14)
    expect(entriesWithoutMain).toBe(2)
  })

  it('carries the audit status through as the audit-side status', () => {
    // The Audit portal's plain "Status" column IS the audit status — there is
    // no separate "Audit Status" column on it — so run-portal-import falls back
    // to `status` when `auditStatus` is absent. Pinned here because that
    // fallback is what makes the whole import write anything at all.
    expect(scraped.rows[0]!.auditStatus).toBeNull()
    expect(scraped.rows[0]!.status?.raw).toBe('Tax Invoice Upload Pending (Paid)')
    expect(scraped.rows[1]!.status?.code).toBe('paid')
  })
})
