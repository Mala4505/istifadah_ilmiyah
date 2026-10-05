import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { cellValueOf, nodeText, toCellValue } from '@/lib/table-values'

describe('toCellValue', () => {
  it('reads INR money, counts and percents as numbers', () => {
    expect(toCellValue('₹2,41,76,880')).toBe(24176880)
    expect(toCellValue('1,234')).toBe(1234)
    expect(toCellValue('12.5%')).toBe(12.5)
    expect(toCellValue('-₹500')).toBe(-500)
  })

  it('reads display dates as timestamps so they sort chronologically', () => {
    expect(toCellValue('05 Oct 2026')).toBe(Date.parse('05 Oct 2026'))
    expect(toCellValue('2026-10-05')).toBe(Date.parse('2026-10-05'))
  })

  it('treats blanks and dash placeholders as null (sorted last)', () => {
    expect(toCellValue('—')).toBeNull()
    expect(toCellValue('')).toBeNull()
    expect(toCellValue(null)).toBeNull()
  })

  it('keeps other text as text', () => {
    expect(toCellValue('Acme Traders')).toBe('Acme Traders')
  })
})

describe('nodeText / cellValueOf', () => {
  it('walks element children', () => {
    const node = createElement('a', { href: '/x' }, 'Vendor ', createElement('b', null, 'One'))
    expect(nodeText(node)).toBe('Vendor One')
  })

  it('derives a numeric sort value from a rendered money cell', () => {
    expect(cellValueOf(createElement('span', null, '₹1,000'))).toBe(1000)
  })
})
