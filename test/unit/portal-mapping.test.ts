/**
 * Unit tests for lib/import/portal-mapping.ts (MASTER-PLAN §17.23, Phase 3).
 *
 * The fixture below is transcribed from the Audit portal screenshot supplied
 * 2026-08-12 — the real header row and the real rendered cell values,
 * including the Indian digit grouping ("14,49,393.00"), the DD/MM/YYYY dates,
 * the compound status chip ("Tax Invoice Upload Pending (Paid)"), and the "NA"
 * invoice number. This is the ground truth the mapper is written against; if
 * the portal changes, change the fixture first and let these tests fail.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveEntryType,
  mapPortalHeaders,
  normalizeHeader,
  parsePortalAmount,
  parsePortalDate,
  parsePortalStatus,
  parsePortalTable,
  slugifyStatus,
  toPortalStringOrNull,
} from '@/lib/import/portal-mapping'

// --- Fixture: the Audit portal table, exactly as rendered ------------------

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

// --- normalizeHeader -------------------------------------------------------

describe('normalizeHeader', () => {
  it('folds case, punctuation and whitespace to a single comparable key', () => {
    expect(normalizeHeader('Entry Number')).toBe('entry number')
    expect(normalizeHeader('  ENTRY   NUMBER  ')).toBe('entry number')
    expect(normalizeHeader('Entry-Number')).toBe('entry number')
  })

  it('strips the sort-arrow and non-breaking-space glyphs a grid injects', () => {
    expect(normalizeHeader('Amount ▲')).toBe('amount')
    expect(normalizeHeader('Vendor ▼')).toBe('vendor')
  })

  it('returns an empty string for null/undefined rather than throwing', () => {
    expect(normalizeHeader(null)).toBe('')
    expect(normalizeHeader(undefined)).toBe('')
  })
})

// --- mapPortalHeaders ------------------------------------------------------

describe('mapPortalHeaders', () => {
  it('maps every data column of the real Audit header row', () => {
    const { byField } = mapPortalHeaders(AUDIT_HEADERS)
    expect(byField).toEqual({
      entryNumber: 0,
      invoiceNumber: 1,
      budgetHead: 2,
      vendor: 3,
      amount: 4,
      status: 5,
      date: 6,
      department: 7,
    })
  })

  it('treats "Action Button" as a control column, not an unmapped one', () => {
    const { unmappedHeaders } = mapPortalHeaders(AUDIT_HEADERS)
    expect(unmappedHeaders).toEqual([])
  })

  it('reports a genuinely unknown column so a portal change is visible', () => {
    const { unmappedHeaders } = mapPortalHeaders([...AUDIT_HEADERS, 'Sanction Ref'])
    expect(unmappedHeaders).toEqual(['Sanction Ref'])
  })

  it('prefers the longest matching synonym over a shorter one', () => {
    // "Audit Status" must not be swallowed by the bare "status" synonym.
    const { byField } = mapPortalHeaders(['Status', 'Audit Status', 'Invoice Number'])
    expect(byField.status).toBe(0)
    expect(byField.auditStatus).toBe(1)
    expect(byField.invoiceNumber).toBe(2)
  })

  it('reports an ambiguous field instead of silently picking one', () => {
    const { byField, ambiguousFields } = mapPortalHeaders(['Amount', 'Invoice Amount'])
    expect(byField.amount).toBe(0)
    expect(ambiguousFields.amount).toEqual([0, 1])
  })

  it('maps the verification-stage column the Audit portal is expected to add', () => {
    const { byField } = mapPortalHeaders([...AUDIT_HEADERS, 'Verification Status'])
    expect(byField.verificationStatus).toBe(AUDIT_HEADERS.length)
  })

  it('maps explicit UBBL and Main columns when the portal exposes both', () => {
    const { byField } = mapPortalHeaders(['UBBL Number', 'Main Entry Number', 'Entry Number'])
    expect(byField.ubblNumber).toBe(0)
    expect(byField.mainNumber).toBe(1)
    expect(byField.entryNumber).toBe(2)
  })
})

// --- parsePortalAmount -----------------------------------------------------

describe('parsePortalAmount', () => {
  it('reads Indian digit grouping without misreading it as decimals', () => {
    // 14,49,393.00 is fourteen lakh — the single most expensive thing to get
    // wrong on this path.
    expect(parsePortalAmount('14,49,393.00')).toBe(1449393)
    expect(parsePortalAmount('7,42,118.00')).toBe(742118)
    expect(parsePortalAmount('1,00,00,000.50')).toBe(10000000.5)
  })

  it('reads Western grouping identically', () => {
    expect(parsePortalAmount('1,234,567.89')).toBe(1234567.89)
    expect(parsePortalAmount('12,500.00')).toBe(12500)
  })

  it('handles currency prefixes', () => {
    expect(parsePortalAmount('₹8,400.00')).toBe(8400)
    expect(parsePortalAmount('Rs. 8,400.00')).toBe(8400)
    expect(parsePortalAmount('INR 8400')).toBe(8400)
  })

  it('handles all three negative conventions', () => {
    expect(parsePortalAmount('-1,200.00')).toBe(-1200)
    expect(parsePortalAmount('1,200.00-')).toBe(-1200)
    expect(parsePortalAmount('(1,200.00)')).toBe(-1200)
  })

  it('returns null for absent and unparseable cells rather than NaN or 0', () => {
    expect(parsePortalAmount('')).toBeNull()
    expect(parsePortalAmount('NA')).toBeNull()
    expect(parsePortalAmount('-')).toBeNull()
    expect(parsePortalAmount(null)).toBeNull()
    expect(parsePortalAmount('pending')).toBeNull()
    expect(parsePortalAmount('1.2.3')).toBeNull()
  })
})

// --- parsePortalDate -------------------------------------------------------

describe('parsePortalDate', () => {
  it('reads the portal DD/MM/YYYY as day-first', () => {
    expect(parsePortalDate('05/08/2026')).toBe('2026-08-05')
    expect(parsePortalDate('31/12/2026')).toBe('2026-12-31')
    expect(parsePortalDate('5/8/2026')).toBe('2026-08-05')
  })

  it('accepts the dash and dot separators the .xlsx export uses', () => {
    expect(parsePortalDate('05-08-2026')).toBe('2026-08-05')
    expect(parsePortalDate('05.08.2026')).toBe('2026-08-05')
  })

  it('passes an unambiguous ISO date straight through', () => {
    expect(parsePortalDate('2026-08-05')).toBe('2026-08-05')
  })

  it('drops a trailing clock time', () => {
    expect(parsePortalDate('05/08/2026 14:32')).toBe('2026-08-05')
    expect(parsePortalDate('2026-08-05T14:32:00')).toBe('2026-08-05')
  })

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(parsePortalDate('31/02/2026')).toBeNull()
    expect(parsePortalDate('32/01/2026')).toBeNull()
    expect(parsePortalDate('05/13/2026')).toBeNull()
    expect(parsePortalDate('00/08/2026')).toBeNull()
  })

  it('handles the leap-year boundary', () => {
    expect(parsePortalDate('29/02/2028')).toBe('2028-02-29')
    expect(parsePortalDate('29/02/2026')).toBeNull()
    expect(parsePortalDate('29/02/2100')).toBeNull()
    expect(parsePortalDate('29/02/2000')).toBe('2000-02-29')
  })

  it('never introduces a time zone shift', () => {
    // The bug this guards is a UTC+5:30 box turning 05/08 into 04/08. A pure
    // string transform cannot do that; assert the exact output to keep it so.
    expect(parsePortalDate('01/01/2026')).toBe('2026-01-01')
  })

  it('returns null rather than guessing at an unrecognised shape', () => {
    expect(parsePortalDate('Aug 5, 2026')).toBeNull()
    expect(parsePortalDate('05/08/26')).toBeNull()
    expect(parsePortalDate('NA')).toBeNull()
  })
})

// --- parsePortalStatus -----------------------------------------------------

describe('parsePortalStatus', () => {
  it('splits the compound chip into stage and qualifier, keeping the raw', () => {
    expect(parsePortalStatus('Tax Invoice Upload Pending (Paid)')).toEqual({
      raw: 'Tax Invoice Upload Pending (Paid)',
      code: 'tax_invoice_upload_pending_paid',
      baseCode: 'tax_invoice_upload_pending',
      qualifier: 'paid',
    })
  })

  it('leaves a simple chip with a null qualifier', () => {
    expect(parsePortalStatus('Paid')).toEqual({
      raw: 'Paid',
      code: 'paid',
      baseCode: 'paid',
      qualifier: null,
    })
  })

  it('returns null for an empty status cell', () => {
    expect(parsePortalStatus('')).toBeNull()
    expect(parsePortalStatus(null)).toBeNull()
  })

  it('slugifies consistently', () => {
    expect(slugifyStatus('Sent to Main')).toBe('sent_to_main')
    expect(slugifyStatus('  Under  Verification!  ')).toBe('under_verification')
  })
})

// --- toPortalStringOrNull --------------------------------------------------

describe('toPortalStringOrNull', () => {
  it('nulls the portal placeholders', () => {
    expect(toPortalStringOrNull('NA')).toBeNull()
    expect(toPortalStringOrNull('N/A')).toBeNull()
    expect(toPortalStringOrNull('-')).toBeNull()
    expect(toPortalStringOrNull('   ')).toBeNull()
  })

  it('strips the non-breaking space a grid renders for an empty cell', () => {
    expect(toPortalStringOrNull(' ')).toBeNull()
    expect(toPortalStringOrNull('Al Nafees Tech')).toBe('Al Nafees Tech')
  })

  it('preserves a real value untouched', () => {
    expect(toPortalStringOrNull('SLTG-20')).toBe('SLTG-20')
    expect(toPortalStringOrNull('  123 ')).toBe('123')
  })
})

// --- deriveEntryType -------------------------------------------------------

describe('deriveEntryType', () => {
  it('applies the same prefix rule as the .xlsx path', () => {
    expect(deriveEntryType('ADP_202608042')).toBe('advance_payment')
    expect(deriveEntryType('RB202608042')).toBe('reimbursement')
    expect(deriveEntryType('2026080532')).toBe('invoice')
  })

  it('checks ADP_ before RB so neither falls through to the other', () => {
    expect(deriveEntryType('ADP_RB123')).toBe('advance_payment')
  })
})

// --- parsePortalTable ------------------------------------------------------

describe('parsePortalTable (Audit portal fixture)', () => {
  const result = parsePortalTable({
    headers: AUDIT_HEADERS,
    rows: AUDIT_ROWS,
    sourceSystem: 'audit',
  })

  it('parses all eight rows with no warnings', () => {
    expect(result.rows).toHaveLength(8)
    expect(result.warnings).toEqual([])
  })

  it('routes the ambiguous "Entry Number" to main_number on the Audit portal', () => {
    expect(result.rows[0]!.mainNumber).toBe('2026080532')
    expect(result.rows[0]!.ubblNumber).toBeNull()
  })

  it('routes the same column to ubbl_number on the Departmental portal', () => {
    const departmental = parsePortalTable({
      headers: AUDIT_HEADERS,
      rows: AUDIT_ROWS,
      sourceSystem: 'departmental',
    })
    expect(departmental.rows[0]!.ubblNumber).toBe('2026080532')
    expect(departmental.rows[0]!.mainNumber).toBeNull()
  })

  it('lets an explicit UBBL column override the generic Entry Number', () => {
    const withBoth = parsePortalTable({
      headers: ['Entry Number', 'UBBL Number', 'Amount'],
      rows: [['2026080532', 'ADP_202608042', '100.00']],
      sourceSystem: 'audit',
    })
    expect(withBoth.rows[0]!.mainNumber).toBe('2026080532')
    expect(withBoth.rows[0]!.ubblNumber).toBe('ADP_202608042')
  })

  it('parses the full first row correctly', () => {
    const row = result.rows[0]!
    expect(row.rowNumber).toBe(1)
    expect(row.mainNumber).toBe('2026080532')
    expect(row.invoiceNumber).toBeNull() // rendered "NA"
    expect(row.vendorRaw).toBe('Avs Decor Pvt Ltd')
    expect(row.amount).toBe(1449393)
    expect(row.date).toBe('2026-08-05')
    expect(row.departmentRaw).toBe('Istifada Ilmiyah')
    expect(row.budgetHeadRaw).toBe('Venue Setup')
    expect(row.status?.baseCode).toBe('tax_invoice_upload_pending')
    expect(row.status?.qualifier).toBe('paid')
    expect(row.skipReason).toBeNull()
  })

  it('preserves the raw row verbatim for the audit trail', () => {
    expect(result.rows[0]!.rawRow).toEqual({
      'Entry Number': '2026080532',
      Invoice: 'NA',
      'Budget Head': 'Venue Setup',
      Vendor: 'Avs Decor Pvt Ltd',
      Amount: '14,49,393.00',
      Status: 'Tax Invoice Upload Pending (Paid)',
      Date: '05/08/2026',
      Department: 'Istifada Ilmiyah',
      'Action Button': 'View',
    })
  })

  it('sums the fixture to the amount a reviewer would tally by hand', () => {
    const total = result.rows.reduce((sum, r) => sum + (r.amount ?? 0), 0)
    expect(total).toBe(1449393 + 8400 + 8000 + 4700 + 742118 + 9750 + 12500 + 12000)
  })

  it('skips a total row instead of importing it as an entry', () => {
    const withTotal = parsePortalTable({
      headers: AUDIT_HEADERS,
      rows: [...AUDIT_ROWS, ['', '', '', 'Grand Total', '22,46,861.00', '', '', '', '']],
      sourceSystem: 'audit',
    })
    expect(withTotal.rows[8]!.skipReason).toBe('total_row')
  })

  it('skips a row with no usable identifier rather than aborting the table', () => {
    const withBlank = parsePortalTable({
      headers: AUDIT_HEADERS,
      rows: [['', '123', 'Venue Setup', 'Someone', '100.00', 'Paid', '05/08/2026', 'Istifada Ilmiyah', 'View']],
      sourceSystem: 'audit',
    })
    expect(withBlank.rows[0]!.skipReason).toBe('no_identifier')
    expect(withBlank.rows[0]!.mainNumber).toBeNull()
  })

  it('warns about an unrecognised column but still parses the known ones', () => {
    const withExtra = parsePortalTable({
      headers: [...AUDIT_HEADERS, 'Sanction Ref'],
      rows: AUDIT_ROWS.map((r) => [...r, 'SR-9']),
      sourceSystem: 'audit',
    })
    expect(withExtra.warnings).toHaveLength(1)
    expect(withExtra.warnings[0]).toContain('Sanction Ref')
    expect(withExtra.rows[0]!.amount).toBe(1449393)
  })

  it('tolerates a short row without throwing', () => {
    const short = parsePortalTable({
      headers: AUDIT_HEADERS,
      rows: [['2026080532', '123']],
      sourceSystem: 'audit',
    })
    expect(short.rows[0]!.mainNumber).toBe('2026080532')
    expect(short.rows[0]!.amount).toBeNull()
    expect(short.rows[0]!.rawRow['Vendor']).toBe('')
  })
})
