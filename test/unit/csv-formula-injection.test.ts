import { describe, expect, it } from 'vitest'
import { csvCell, neutraliseFormula } from '@/lib/csv-safe'
import { toCsv } from '@/lib/reports/csv'

describe('csvCell formula-injection guard (audit M8)', () => {
  it('prefixes a quote to a vendor name that would run as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(neutraliseFormula('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`)
  })

  it.each(['=1+1', '+cmd|calc', '-1+2', '@SUM(A1)', '\tfoo', '\rfoo', '-cmd|calc'])(
    'neutralises %j',
    (v) => {
      expect(csvCell(v).startsWith(`'`) || csvCell(v).startsWith(`"'`)).toBe(true)
    },
  )

  it('leaves a negative amount untouched, as a number or as a numeric string', () => {
    expect(csvCell(-500)).toBe('-500')
    expect(csvCell('-500')).toBe('-500')
    expect(csvCell('-1234.50')).toBe('-1234.50')
    expect(csvCell('+5')).toBe('+5')
  })

  it('leaves ordinary text, empties and dates alone', () => {
    expect(csvCell('Acme Traders')).toBe('Acme Traders')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell('—')).toBe('—')
  })

  it('still quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })
})

describe('toCsv (reports exporter) uses the guard', () => {
  it('neutralises a malicious cell but keeps a negative number', () => {
    const csv = toCsv(
      [{ vendor: '=HYPERLINK("x")', amount: -500 }],
      [
        { header: 'Vendor', value: (r) => r.vendor },
        { header: 'Amount', value: (r) => r.amount },
      ],
    )
    expect(csv).toBe(`Vendor,Amount\r\n"'=HYPERLINK(""x"")",-500`)
  })
})
