import { describe, expect, it } from 'vitest'
import {
  buildCostSegments,
  compareEvents,
  dedupeScopePicks,
  eventsInTagPeriod,
  filterTagIdsByScope,
  formatCostSummary,
  groupByKey,
  groupEntriesByEvent,
  groupScopeByDepartment,
  sortEventsAscending,
  sortLinkedEntries,
  summarizeEntries,
  tagPeriodLabel,
  type EventOrderRef,
} from '@/lib/tags/shared'
import { formatINR } from '@/lib/reports/format'

const e = (id: number, hijriYear: string, startsOn: string | null = null): EventOrderRef => ({
  id,
  hijriYear,
  startsOn,
})
const E1447 = e(1, '1447', '2025-07-01')
const E1448 = e(2, '1448', '2026-06-20')
const E1449 = e(3, '1449', '2027-06-10')
const ALL = [E1449, E1447, E1448]

describe('compareEvents', () => {
  it('orders by starts_on when both have one', () => {
    expect(compareEvents(E1447, E1448)).toBeLessThan(0)
    expect(compareEvents(E1449, E1448)).toBeGreaterThan(0)
    expect(compareEvents(E1448, E1448)).toBe(0)
  })

  it('falls back to hijri_year when a date is missing, comparing length first so 999 < 1448', () => {
    expect(compareEvents(e(10, '999'), e(11, '1448'))).toBeLessThan(0)
    expect(compareEvents(e(11, '1448'), e(12, '1449', '2027-01-01'))).toBeLessThan(0)
  })

  it('falls back to hijri_year when both dates are equal', () => {
    expect(compareEvents(e(1, '1448', '2026-01-01'), e(2, '1449', '2026-01-01'))).toBeLessThan(0)
  })

  it('sorts ascending without mutating the input', () => {
    expect(sortEventsAscending(ALL).map((x) => x.hijriYear)).toEqual(['1447', '1448', '1449'])
    expect(ALL.map((x) => x.hijriYear)).toEqual(['1449', '1447', '1448'])
  })
})

describe('tagPeriodLabel', () => {
  it('shows perpetual for an open-ended tag', () => {
    expect(tagPeriodLabel(E1448, null)).toBe('1448 → perpetual')
  })
  it('shows start and end years', () => {
    expect(tagPeriodLabel(E1448, E1449)).toBe('1448 → 1449')
  })
  it('collapses a one-event tag', () => {
    expect(tagPeriodLabel(E1448, E1448)).toBe('1448 only')
  })
  it('does not throw when the start event is unknown', () => {
    expect(tagPeriodLabel(undefined, null)).toBe('? → perpetual')
  })
})

describe('eventsInTagPeriod', () => {
  it('runs to the newest event when perpetual', () => {
    expect(eventsInTagPeriod(ALL, 2, null).map((x) => x.id)).toEqual([2, 3])
  })
  it('stops at the end event, inclusive', () => {
    expect(eventsInTagPeriod(ALL, 1, 2).map((x) => x.id)).toEqual([1, 2])
  })
  it('is empty when the start event is unknown', () => {
    expect(eventsInTagPeriod(ALL, 99, null)).toEqual([])
  })
})

describe('cost summary', () => {
  const costs = [
    { event_id: 3, cost: 12000, entry_count: 2 },
    { event_id: 2, cost: 24176880, entry_count: 5 },
  ]

  it('labels the start event built and later events maintained, oldest first', () => {
    const segments = buildCostSegments(2, costs, ALL)
    expect(segments.map((s) => [s.hijriYear, s.role])).toEqual([
      ['1448', 'built'],
      ['1449', 'maintained'],
    ])
  })

  it('formats "built 1448 ₹X · maintained 1449 ₹Y" with INR grouping', () => {
    const text = formatCostSummary(buildCostSegments(2, costs, ALL), formatINR)
    expect(text).toBe('built 1448 ₹2,41,76,880 · maintained 1449 ₹12,000')
  })

  it('skips events that only hold voided entries and events it cannot resolve', () => {
    const segments = buildCostSegments(
      2,
      [
        { event_id: 2, cost: 0, entry_count: 0 },
        { event_id: 3, cost: 500, entry_count: 1 },
        { event_id: 77, cost: 900, entry_count: 1 },
      ],
      ALL
    )
    expect(segments.map((s) => s.eventId)).toEqual([3])
  })

  it('is empty text when there is no spend', () => {
    expect(formatCostSummary([], formatINR)).toBe('')
  })

  it('coerces numeric strings the way PostgREST can return them', () => {
    const segments = buildCostSegments(2, [{ event_id: 2, cost: '1500.50' as unknown as number, entry_count: '2' as unknown as number }], ALL)
    expect(segments[0]).toMatchObject({ cost: 1500.5, entryCount: 2 })
  })
})

describe('scope helpers', () => {
  const dept = (id: number) => ({ 1: 'Sanitation', 2: 'Kitchen' })[id as 1 | 2] ?? '?'
  const sub = (id: number) => ({ 10: 'Wudu area', 11: 'Block B' })[id as 10 | 11] ?? '?'

  it('groups sub-departments under their department, sorted by name', () => {
    const groups = groupScopeByDepartment(
      [
        { department_id: 1, sub_department_id: 11 },
        { department_id: 2, sub_department_id: null },
        { department_id: 1, sub_department_id: 10 },
        { department_id: 1, sub_department_id: null },
      ],
      dept,
      sub
    )
    expect(groups).toEqual([
      { departmentId: 2, departmentName: 'Kitchen', subDepartmentNames: [] },
      { departmentId: 1, departmentName: 'Sanitation', subDepartmentNames: ['Block B', 'Wudu area'] },
    ])
  })

  const scope = [
    { tag_id: 1, department_id: 1, sub_department_id: null },
    { tag_id: 2, department_id: 1, sub_department_id: 10 },
    { tag_id: 3, department_id: 2, sub_department_id: null },
  ]

  it('returns null (keep all) when no filter is set', () => {
    expect(filterTagIdsByScope(scope, { departmentId: null, subDepartmentId: null })).toBeNull()
  })
  it('filters by department', () => {
    expect([...filterTagIdsByScope(scope, { departmentId: 1, subDepartmentId: null })!].sort()).toEqual([1, 2])
  })
  it('filters by department and sub-department together, keeping department-wide tags', () => {
    // Tag 1 covers all of department 1 (no sub-department row), so it covers sub-department 10 too.
    expect([...filterTagIdsByScope(scope, { departmentId: 1, subDepartmentId: 10 })!].sort()).toEqual([1, 2])
  })
  it('does not match a department-wide row of another department', () => {
    expect([...filterTagIdsByScope(scope, { departmentId: 2, subDepartmentId: 10 })!]).toEqual([3])
  })
  it('does not match a tag scoped to a different sub-department of the same department', () => {
    const other = [
      { tag_id: 5, department_id: 1, sub_department_id: 11 },
      { tag_id: 6, department_id: 1, sub_department_id: 10 },
    ]
    expect([...filterTagIdsByScope(other, { departmentId: 1, subDepartmentId: 10 })!]).toEqual([6])
  })
  it('with only a sub-department chosen, matches that sub-department exactly (no department to widen to)', () => {
    expect([...filterTagIdsByScope(scope, { departmentId: null, subDepartmentId: 10 })!]).toEqual([2])
  })

  it('drops repeated scope picks', () => {
    expect(
      dedupeScopePicks([
        { departmentId: 1, subDepartmentId: null },
        { departmentId: 1, subDepartmentId: 10 },
        { departmentId: 1, subDepartmentId: null },
      ])
    ).toHaveLength(2)
  })
})

describe('linked entries', () => {
  const entries = [
    { id: 1, event_id: 3, amount: 1000, is_void: false },
    { id: 2, event_id: 2, amount: 5000, is_void: false },
    { id: 3, event_id: 2, amount: 7000, is_void: true },
    { id: 4, event_id: 2, amount: null, is_void: false },
    { id: 5, event_id: 99, amount: 1, is_void: false },
  ]

  it('excludes voided entries from the total but counts them', () => {
    expect(summarizeEntries(entries.slice(1, 4))).toEqual({ total: 5000, activeCount: 2, voidedCount: 1 })
  })

  it('groups by event oldest first and drops entries from unknown events', () => {
    const groups = groupEntriesByEvent(entries, ALL)
    expect(groups.map((g) => [g.event.hijriYear, g.entries.map((x) => x.id)])).toEqual([
      ['1448', [2, 3, 4]],
      ['1449', [1]],
    ])
  })

  it('groupByKey keeps insertion order within a key', () => {
    const grouped = groupByKey([{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }], (r) => r.k)
    expect(grouped.get('a')!.map((r) => r.v)).toEqual([1, 3])
  })
})

describe('sortLinkedEntries', () => {
  it('puts the newest date first, undated entries last, and breaks ties by highest id', () => {
    const rows = [
      { id: 1, date: '2026-01-01' },
      { id: 2, date: null },
      { id: 3, date: '2026-03-01' },
      { id: 4, date: '2026-01-01' },
      { id: 5, date: null },
    ]
    expect(sortLinkedEntries(rows).map((r) => r.id)).toEqual([3, 4, 1, 5, 2])
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]) // input untouched
  })
})
