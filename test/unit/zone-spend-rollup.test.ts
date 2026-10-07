import { describe, expect, it } from 'vitest'
import { rollUpZoneSpend } from '@/lib/reports/zone-spend-rollup'
import type { ZoneSpendRow } from '@/lib/reports/sections/shared'

// v_zone_spend is (zone, department, event) grain; the zone-spend section
// needs one row per zone. These pin the rollup the loader now applies.
const row = (over: Partial<ZoneSpendRow>): ZoneSpendRow => ({
  zone_id: 1,
  zone_name: 'Zone 1',
  zone_number: 1,
  department_id: 10,
  entry_count: 1,
  total_amount: 100,
  ...over,
})

describe('rollUpZoneSpend', () => {
  it('merges a zone split across departments into one row', () => {
    const out = rollUpZoneSpend([
      row({ department_id: 10, entry_count: 2, total_amount: 1_00_000 }),
      row({ department_id: 11, entry_count: 3, total_amount: 50_000 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ zone_id: 1, entry_count: 5, total_amount: 1_50_000, department_id: null })
  })

  it('keeps department_id when every row for the zone shares it', () => {
    const out = rollUpZoneSpend([row({ total_amount: 10 }), row({ total_amount: 20 })])
    expect(out[0]!.department_id).toBe(10)
  })

  it('treats null zone_id as one "unassigned" zone and sorts by total desc', () => {
    const out = rollUpZoneSpend([
      row({ zone_id: 2, zone_name: 'Zone 2', total_amount: 5 }),
      row({ zone_id: null, zone_name: 'unassigned', department_id: 1, total_amount: 40 }),
      row({ zone_id: null, zone_name: 'unassigned', department_id: 2, total_amount: 60 }),
    ])
    expect(out.map((r) => [r.zone_name, r.total_amount])).toEqual([
      ['unassigned', 100],
      ['Zone 2', 5],
    ])
  })

  it('keeps a null total when every merged row is null, and does not mutate input', () => {
    const input = [row({ total_amount: null }), row({ department_id: 11, total_amount: null })]
    const out = rollUpZoneSpend(input)
    expect(out[0]!.total_amount).toBeNull()
    expect(input[0]!.entry_count).toBe(1)
  })
})
