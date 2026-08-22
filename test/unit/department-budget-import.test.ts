/**
 * test/unit/department-budget-import.test.ts
 *
 * Unit tests for the pure, DB-free helpers in
 * lib/import/department-budget-parsing.ts (review-page-redesign plan §11).
 * Imported directly from that module (not lib/import/run-department-budget-
 * import.ts, which opens a real `pg` transaction) so this test never needs
 * DATABASE_URL or a live Postgres connection just to exercise header
 * matching / name normalization / amount parsing — same split as
 * test/unit/run-import.test.ts against lib/import/assertions.ts.
 */

import { describe, expect, it } from 'vitest'
import {
  AMOUNT_KEYS,
  DEPARTMENT_KEYS,
  isTotalRowMarker,
  normalizeDepartmentName,
  parseAmount,
  pickField,
} from '@/lib/import/department-budget-parsing'

describe('normalizeDepartmentName', () => {
  it('trims and lowercases', () => {
    expect(normalizeDepartmentName('  Venue Setup  ')).toBe('venue setup')
  })

  it('collapses internal whitespace runs', () => {
    expect(normalizeDepartmentName('Venue   Setup')).toBe('venue setup')
    expect(normalizeDepartmentName('Venue\tSetup')).toBe('venue setup')
  })

  it('is case-insensitive so differently-cased sheet values still match', () => {
    expect(normalizeDepartmentName('VENUE SETUP')).toBe(normalizeDepartmentName('venue setup'))
  })

  it('does NOT strip punctuation — unlike vendor-name normalization, this is meant to be near-exact', () => {
    expect(normalizeDepartmentName('Venue Setup (AVIT)')).toBe('venue setup (avit)')
  })
})

describe('isTotalRowMarker', () => {
  it('matches common totals-row labels case-insensitively', () => {
    expect(isTotalRowMarker('Total')).toBe(true)
    expect(isTotalRowMarker('GRAND TOTAL')).toBe(true)
    expect(isTotalRowMarker('  totals  ')).toBe(true)
  })

  it('does not match a real department name', () => {
    expect(isTotalRowMarker('Venue Setup')).toBe(false)
    expect(isTotalRowMarker('Total Sanitation')).toBe(false) // contains "total" but isn't only that
  })
})

describe('parseAmount', () => {
  it('parses a plain number string', () => {
    expect(parseAmount('12500')).toBe(12500)
  })

  it('strips thousands separators before parsing', () => {
    expect(parseAmount('12,500.00')).toBe(12500)
    expect(parseAmount('1,20,00,000')).toBe(12000000) // Indian digit grouping
  })

  it('returns null for a blank cell — a legitimate "no budget set" row, not an error', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('   ')).toBeNull()
  })

  it('returns NaN for a non-numeric, non-blank cell — a row-level error, distinct from absent', () => {
    expect(Number.isNaN(parseAmount('N/A'))).toBe(true)
    expect(Number.isNaN(parseAmount('twelve thousand'))).toBe(true)
  })
})

describe('pickField', () => {
  it('matches a candidate header case/whitespace-insensitively', () => {
    const row = { 'Department Name': 'Venue Setup', 'Budget Amount': '50,000' }
    expect(pickField(row, DEPARTMENT_KEYS)).toBe('Venue Setup')
    expect(pickField(row, AMOUNT_KEYS)).toBe('50,000')
  })

  it('tries candidates in order and falls back through synonyms', () => {
    const row = { Dept: 'Sanitation', Budget: '1000' }
    expect(pickField(row, DEPARTMENT_KEYS)).toBe('Sanitation')
    expect(pickField(row, AMOUNT_KEYS)).toBe('1000')
  })

  it('returns null when no candidate header is present or all are blank', () => {
    expect(pickField({ Foo: 'bar' }, DEPARTMENT_KEYS)).toBeNull()
    expect(pickField({ Department: '' }, DEPARTMENT_KEYS)).toBeNull()
    expect(pickField({ Department: '   ' }, DEPARTMENT_KEYS)).toBeNull()
  })
})
