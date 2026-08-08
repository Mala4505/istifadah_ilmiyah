/**
 * test/unit/import-fixture.test.ts
 *
 * Fixture test described in MASTER-PLAN §9.4 ("the real Excel file,
 * committed to test/fixtures/"). This parses the raw xlsx directly with the
 * already-installed `xlsx` package to establish ground truths about
 * test/fixtures/tenant_multiple_budget_6_20260807_102230.xlsx — the same
 * file at Departmental/tenant_multiple_budget_6_20260807_102230.xlsx.
 *
 * This is NOT testing lib/module-mapping.ts (owned by another agent, may
 * not exist yet). The parsing helpers below are a minimal, local
 * re-implementation of the "Srno present -> allocation row, forward-fill
 * budget head, Vendor Name present -> entry row, Department === 'Grand
 * Total' -> skip" rules from §9.4/§3, just enough to state facts about the
 * fixture data as raw assertions.
 *
 * IMPORTANT DISCREPANCY NOTE: MASTER-PLAN §9.4 gives "16 entry rows and 10
 * allocation rows" as the expected fixture shape. Direct inspection of the
 * real committed fixture shows 10 allocation rows (Srno 1-10) but only 14
 * rows with a non-empty Vendor Name, not 16. This file asserts the REAL,
 * observed values (10 / 14) per the instruction to establish ground truth
 * from the actual xlsx rather than from the plan's illustrative figure —
 * flagged here for the plan owner to reconcile.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import path from 'node:path'

const FIXTURE_PATH = path.resolve(
  process.cwd(),
  'test/fixtures/tenant_multiple_budget_6_20260807_102230.xlsx'
)

const SHEET_NAME = 'All Budget Entries'

interface RawRow {
  Srno: string
  'Budget Head': string
  Department: string
  'Request Amount': string
  'Approved Amount': string
  'Utilised Amount': string
  Balance: string
  'Vendor Name': string
  'Invoice Number': string
  'Invoice Amount': string
  'Invoice Date': string
  'User name': string
  'UBBL Number': string
  'Main Entry Number': string
  Status: string
  'Main Status': string
}

interface AllocationRow {
  srno: number
  budgetHead: string
  utilisedAmount: number
}

interface EntryRow {
  budgetHead: string // forward-filled from the nearest preceding allocation row
  vendorName: string
  invoiceNumber: string
  tenantAmount: number
  ubblNumber: string
  mainEntryNumber: string
}

/** "3,000,000.00" -> 3000000. Empty/non-numeric -> 0. */
function toNumber(value: string): number {
  if (!value) return 0
  const cleaned = value.replace(/,/g, '').trim()
  if (cleaned === '') return 0
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

function loadRows(): RawRow[] {
  const workbook = XLSX.readFile(FIXTURE_PATH)
  const sheet = workbook.Sheets[SHEET_NAME]
  if (!sheet) {
    throw new Error(`Sheet "${SHEET_NAME}" not found in fixture`)
  }
  return XLSX.utils.sheet_to_json<RawRow>(sheet, { raw: false, defval: '' })
}

/**
 * Minimal local re-implementation of the import rules, for establishing
 * ground truth only — the real rules live in lib/module-mapping.ts once
 * another agent writes it.
 */
function extractAllocationsAndEntries(rows: RawRow[]): {
  allocations: AllocationRow[]
  entries: EntryRow[]
} {
  const allocations: AllocationRow[] = []
  const entries: EntryRow[] = []
  let currentBudgetHead = ''

  for (const row of rows) {
    const department = (row.Department ?? '').trim()
    // Grand Total is detected by column C (Department), NOT column A
    // (Srno) — the Grand Total row's Srno cell is blank, so a naive
    // "non-empty Srno" check would never find it.
    if (department === 'Grand Total') continue

    const srnoRaw = (row.Srno ?? '').trim()
    const budgetHeadRaw = (row['Budget Head'] ?? '').trim()
    if (srnoRaw !== '') {
      currentBudgetHead = budgetHeadRaw
      allocations.push({
        srno: parseInt(srnoRaw, 10),
        budgetHead: budgetHeadRaw,
        utilisedAmount: toNumber(row['Utilised Amount']),
      })
    }

    const vendorName = (row['Vendor Name'] ?? '').trim()
    if (vendorName !== '') {
      entries.push({
        budgetHead: currentBudgetHead, // forward-filled
        vendorName,
        invoiceNumber: (row['Invoice Number'] ?? '').trim(),
        tenantAmount: toNumber(row['Invoice Amount']),
        ubblNumber: (row['UBBL Number'] ?? '').trim(),
        mainEntryNumber: (row['Main Entry Number'] ?? '').trim(),
      })
    }
  }

  return { allocations, entries }
}

describe('Departmental Excel fixture — raw ground truth (MASTER-PLAN §9.4)', () => {
  let rows: RawRow[]
  let allocations: AllocationRow[]
  let entries: EntryRow[]

  beforeAll(() => {
    rows = loadRows()
    const extracted = extractAllocationsAndEntries(rows)
    allocations = extracted.allocations
    entries = extracted.entries
  })

  it('extracts exactly 10 allocation rows and 14 entry rows — nothing else', () => {
    expect(allocations).toHaveLength(10)
    expect(entries).toHaveLength(14)
  })

  it('keeps the five zero-spend heads as allocation rows (the ₹2.5cr v1 bug)', () => {
    // A naive "skip rows with no vendor" rule would drop all five of these
    // silently — they have zero spend but must still surface as allocation
    // rows, otherwise budget-vs-actual reporting has a hole worth ₹2.5cr.
    const zeroSpendHeads = [
      'Venue setup (AVIT)',
      'Venue setup (Security)',
      'Venue setup (Tazyeen)',
      'Venue setup (Power)',
      'Venue setup (Office setup)',
    ]

    expect(zeroSpendHeads).toHaveLength(5)

    for (const head of zeroSpendHeads) {
      const allocation = allocations.find((a) => a.budgetHead === head)
      expect(allocation, `expected an allocation row for "${head}"`).toBeDefined()
      expect(allocation?.utilisedAmount).toBe(0)
    }
  })

  it("skips the Grand Total row, detected by column C (Department) not column A (Srno)", () => {
    const grandTotalRow = rows.find((r) => (r.Department ?? '').trim() === 'Grand Total')
    expect(grandTotalRow).toBeDefined()
    // The tell: Srno (column A) is blank on this row, so a naive
    // "non-empty Srno = allocation row" rule would never flag it at all —
    // it has to be caught on Department instead.
    expect((grandTotalRow?.Srno ?? '').trim()).toBe('')

    expect(allocations.some((a) => a.budgetHead === '')).toBe(false)
    expect(entries.some((e) => e.vendorName === '')).toBe(false)
  })

  it('forward-fills the two un-labeled entry sub-rows under "Venue setup (Dome Tents)" (Srno 2)', () => {
    const domeTentsAllocation = allocations.find((a) => a.srno === 2)
    expect(domeTentsAllocation?.budgetHead).toBe('Venue setup (Dome Tents)')

    const domeTentsEntries = entries.filter((e) => e.budgetHead === 'Venue setup (Dome Tents)')
    const vendorNames = domeTentsEntries.map((e) => e.vendorName)

    expect(domeTentsEntries).toHaveLength(3)
    expect(vendorNames).toContain('Eyak Ventures Private Limited') // the row that carries Srno 2 itself
    expect(vendorNames).toContain('Ashapura aircon and decor') // un-labeled sub-row, forward-filled
    expect(vendorNames).toContain('Lalaji Events India Pvt Ltd') // un-labeled sub-row, forward-filled
  })

  it('sums entry tenant_amount to equal allocation utilised_amount, per head', () => {
    const headsWithSpend = allocations.filter((a) => a.utilisedAmount > 0)
    // Sanity check the fixture actually exercises this: 5 heads have spend
    // (Dome Tents, Other setup expenses, Hall/Land Rent, Mandap, Labour).
    expect(headsWithSpend).toHaveLength(5)

    for (const allocation of headsWithSpend) {
      const headEntries = entries.filter((e) => e.budgetHead === allocation.budgetHead)
      const sum = headEntries.reduce((acc, e) => acc + e.tenantAmount, 0)
      // Compare in integer paise to avoid float noise.
      expect(
        Math.round(sum * 100),
        `sum(tenant_amount) mismatch for "${allocation.budgetHead}": ${sum} vs ${allocation.utilisedAmount}`
      ).toBe(Math.round(allocation.utilisedAmount * 100))
    }
  })

  it('detects a same-value-different-namespace collision between UBBL and Main Entry numbers', () => {
    const ubblValues = new Set(entries.map((e) => e.ubblNumber).filter((v) => v !== ''))
    const mainEntryValues = new Set(entries.map((e) => e.mainEntryNumber).filter((v) => v !== ''))

    // "ADP_202608054" is a Main Entry Number on one row (Eyak Ventures,
    // Dome Tents) and a UBBL Number on a different row (Lalaji Events,
    // also Dome Tents). Same literal string value, two different id
    // namespaces, two different real-world entities. A global-uniqueness
    // check on a single "reference number" column — without namespacing —
    // would treat these as the same entity and silently merge them. This
    // is the raw fact about the fixture that WOULD need to make a future
    // real importer raise an `id_namespace_collision` exception; no
    // importer exists yet, so this test only establishes that the
    // colliding value is present in both namespaces.
    const collision = 'ADP_202608054'
    expect(ubblValues.has(collision)).toBe(true)
    expect(mainEntryValues.has(collision)).toBe(true)

    const crossNamespaceCollisions = [...ubblValues].filter((v) => mainEntryValues.has(v))
    expect(crossNamespaceCollisions).toContain(collision)
  })
})
