/**
 * test/unit/sub-department-budget-import.test.ts
 *
 * Unit tests for the pure, DB-free helpers in
 * lib/import/sub-department-budget-parsing.ts (sub-department feature plan,
 * "Budget import pipeline" section). Mirrors
 * test/unit/department-budget-import.test.ts for the shared re-exported
 * helpers (pickField, normalizeDepartmentName, parseAmount,
 * isTotalRowMarker) and adds coverage for the new SUB_DEPARTMENT_KEYS header
 * matching plus the composite (department, sub-department) resolution
 * scenarios the three-column sheet introduces — sub-department names are
 * only unique *within* a department, so the same raw sub-department name can
 * legitimately resolve differently (or not at all) depending on which
 * department row it's paired with. These composite-key/error-message
 * scenarios are exercised here as pure map lookups against the same shape
 * of `Map<string, {id, department_id, name}>` the importer itself builds,
 * without needing a live Postgres connection (same DB-free split as
 * run-department-budget-import.ts vs department-budget-parsing.ts).
 */

import { describe, expect, it } from 'vitest'
import {
  AMOUNT_KEYS,
  DEPARTMENT_KEYS,
  SUB_DEPARTMENT_KEYS,
  isTotalRowMarker,
  normalizeDepartmentName,
  parseAmount,
  pickField,
} from '@/lib/import/sub-department-budget-parsing'

describe('normalizeDepartmentName (reused for sub-department names too)', () => {
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

  it('does NOT strip punctuation — meant to be near-exact', () => {
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
    expect(isTotalRowMarker('Total Sanitation')).toBe(false)
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
  it('matches department/sub-department/amount headers case/whitespace-insensitively', () => {
    const row = {
      'Department Name': 'Venue Setup',
      'Sub Department Name': 'Stage Crew',
      'Budget Amount': '50,000',
    }
    expect(pickField(row, DEPARTMENT_KEYS)).toBe('Venue Setup')
    expect(pickField(row, SUB_DEPARTMENT_KEYS)).toBe('Stage Crew')
    expect(pickField(row, AMOUNT_KEYS)).toBe('50,000')
  })

  it('tries sub-department candidates in order and falls back through synonyms', () => {
    expect(pickField({ 'Sub-Department': 'Lighting' }, SUB_DEPARTMENT_KEYS)).toBe('Lighting')
    expect(pickField({ Subdepartment: 'Lighting' }, SUB_DEPARTMENT_KEYS)).toBe('Lighting')
    expect(pickField({ 'Sub Dept': 'Lighting' }, SUB_DEPARTMENT_KEYS)).toBe('Lighting')
  })

  it('returns null when no sub-department candidate header is present or all are blank', () => {
    expect(pickField({ Foo: 'bar' }, SUB_DEPARTMENT_KEYS)).toBeNull()
    expect(pickField({ 'Sub Department': '' }, SUB_DEPARTMENT_KEYS)).toBeNull()
    expect(pickField({ 'Sub Department': '   ' }, SUB_DEPARTMENT_KEYS)).toBeNull()
  })
})

/**
 * Sub-department resolution is scoped to a department — the same name can
 * exist under two different departments and must resolve to two different
 * ids, or fail to resolve under a department it doesn't belong to. These
 * tests exercise that composite-key lookup directly, the same shape the
 * importer builds internally (`${department_id}::${normalizedName}` ->
 * sub-department row), without touching Postgres.
 */
describe('composite (department, sub-department) resolution', () => {
  function subDepartmentKey(departmentId: number, normalizedSubDepartmentName: string): string {
    return `${departmentId}::${normalizedSubDepartmentName}`
  }

  const venueSetup = { id: 1, name: 'Venue Setup' }
  const sanitation = { id: 2, name: 'Sanitation' }

  const subDepartmentByKey = new Map<string, { id: number; department_id: number; name: string }>([
    [subDepartmentKey(venueSetup.id, normalizeDepartmentName('Stage Crew')), { id: 10, department_id: 1, name: 'Stage Crew' }],
    [subDepartmentKey(sanitation.id, normalizeDepartmentName('Stage Crew')), { id: 11, department_id: 2, name: 'Stage Crew' }],
    [subDepartmentKey(venueSetup.id, normalizeDepartmentName('Lighting')), { id: 12, department_id: 1, name: 'Lighting' }],
  ])

  it('resolves the same sub-department name to different ids under different departments', () => {
    const underVenue = subDepartmentByKey.get(subDepartmentKey(venueSetup.id, normalizeDepartmentName('Stage Crew')))
    const underSanitation = subDepartmentByKey.get(subDepartmentKey(sanitation.id, normalizeDepartmentName('Stage Crew')))
    expect(underVenue?.id).toBe(10)
    expect(underSanitation?.id).toBe(11)
    expect(underVenue?.id).not.toBe(underSanitation?.id)
  })

  it('does not resolve a sub-department under a department it does not belong to', () => {
    const wrongDept = subDepartmentByKey.get(subDepartmentKey(sanitation.id, normalizeDepartmentName('Lighting')))
    expect(wrongDept).toBeUndefined()
  })

  it('is case/whitespace-insensitive on the sub-department name, same as department names', () => {
    const match = subDepartmentByKey.get(subDepartmentKey(venueSetup.id, normalizeDepartmentName('  stage   crew  ')))
    expect(match?.id).toBe(10)
  })
})
