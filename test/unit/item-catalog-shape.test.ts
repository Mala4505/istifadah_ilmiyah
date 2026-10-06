import { describe, expect, it } from 'vitest'
import {
  itemOptionLabel,
  sortLinesToAssign,
  toItemCatalogRow,
  toLineToAssignRow,
  type LineToAssignRow,
} from '@/lib/settings/item-catalog-shape'

describe('toItemCatalogRow', () => {
  it('maps the review view row, coercing numeric strings and defaulting nulls', () => {
    const row = toItemCatalogRow({
      id: 7,
      item_key: 'cpvc-elbow-1in',
      canonical_label: 'CPVC elbow / bend · 1in',
      item_family_id: '3',
      family_label: 'CPVC elbow / bend',
      category: 'Plumbing',
      unit_normalized: 'pcs',
      is_comparable: true,
      is_confirmed: false,
      confirmed_at: null,
      line_count: 12,
      vendor_count: 2,
      pretax_value: '4520.50',
      last_seen: '2026-09-30',
      alias_count: 5,
      unconfirmed_alias_count: 5,
      sample_descriptions: ['Elbow 1"', 'CPVC ELBOW 1 INCH', null],
    })
    expect(row).toMatchObject({
      id: 7,
      familyId: 3,
      pretaxValue: 4520.5,
      isConfirmed: false,
      sampleDescriptions: ['Elbow 1"', 'CPVC ELBOW 1 INCH'],
    })
  })

  it('treats missing counts as zero and missing value as null', () => {
    const row = toItemCatalogRow({ id: 1, item_key: 'x', canonical_label: 'X' })
    expect(row.lineCount).toBe(0)
    expect(row.pretaxValue).toBeNull()
    expect(row.familyLabel).toBeNull()
    expect(row.isComparable).toBe(true)
  })
})

describe('toLineToAssignRow', () => {
  it('drops unknown reasons and empty descriptions', () => {
    expect(toLineToAssignRow({ reason: 'whatever', raw_description: 'a' })).toBeNull()
    expect(toLineToAssignRow({ reason: 'unmatched', raw_description: '' })).toBeNull()
  })

  it('keys rows by reason + normalised description', () => {
    const row = toLineToAssignRow({
      reason: 'size_not_read',
      normalized_description: 'cpvc elbow',
      raw_description: 'CPVC Elbow',
      item_catalog_id: 4,
      canonical_label: 'CPVC elbow / bend',
      line_count: 3,
    })
    expect(row?.key).toBe('size_not_read:cpvc elbow')
    expect(row?.currentItemId).toBe(4)
    expect(row?.lineCount).toBe(3)
  })
})

describe('sortLinesToAssign', () => {
  const base: Omit<LineToAssignRow, 'key' | 'rawDescription' | 'lineCount' | 'pretaxValue'> = {
    reason: 'unmatched',
    aliasId: null,
    confidence: null,
    currentItemId: null,
    currentItemLabel: null,
    currentFamilyLabel: null,
    vendorCount: 1,
    lastSeen: null,
    unit: null,
  }
  it('orders by line count, then value, then description', () => {
    const rows: LineToAssignRow[] = [
      { ...base, key: 'a', rawDescription: 'b', lineCount: 1, pretaxValue: 100 },
      { ...base, key: 'b', rawDescription: 'a', lineCount: 1, pretaxValue: 100 },
      { ...base, key: 'c', rawDescription: 'z', lineCount: 5, pretaxValue: null },
      { ...base, key: 'd', rawDescription: 'y', lineCount: 1, pretaxValue: 900 },
    ]
    expect(sortLinesToAssign(rows).map((r) => r.key)).toEqual(['c', 'd', 'b', 'a'])
  })
})

describe('itemOptionLabel', () => {
  it('appends the family only when the label does not already start with it', () => {
    expect(itemOptionLabel({ label: 'CPVC elbow / bend · 1in', familyLabel: 'CPVC elbow / bend' })).toBe(
      'CPVC elbow / bend · 1in',
    )
    expect(itemOptionLabel({ label: 'Astral bend', familyLabel: 'CPVC elbow / bend' })).toBe(
      'Astral bend (CPVC elbow / bend)',
    )
    expect(itemOptionLabel({ label: 'Thing', familyLabel: null })).toBe('Thing')
  })
})
