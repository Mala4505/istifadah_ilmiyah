import { describe, expect, it } from 'vitest'
import {
  buildTagCostReport,
  departmentsLabel,
  eventRelation,
  tagCostSentence,
  voidedNote,
  type TagReportEventRef,
} from '@/lib/tags/reports-shared'
import type { TagCostRow, TagRow } from '@/lib/tags/shared'
import { formatINR } from '@/lib/reports/format'

const ev = (id: number, hijriYear: string, startsOn: string | null): TagReportEventRef => ({
  id,
  name: `Ashara ${hijriYear}`,
  hijriYear,
  startsOn,
})
const E1447 = ev(1, '1447', '2025-07-01')
const E1448 = ev(2, '1448', '2026-06-20')
const E1449 = ev(3, '1449', '2027-06-10')
const EVENTS = [E1449, E1447, E1448]

const tag = (id: number, name: string, start: number, end: number | null = null): TagRow => ({
  id,
  name,
  description: null,
  start_event_id: start,
  end_event_id: end,
  created_at: '',
  updated_at: '',
})
const cost = (tag_id: number, event_id: number, c: number, entry_count: number, voided_count = 0): TagCostRow => ({
  tag_id,
  event_id,
  cost: c,
  entry_count,
  voided_count,
})

const DEPTS = new Map([
  [10, 'Sanitation'],
  [20, 'Tents'],
])
const SUBS = new Map([[100, 'Washrooms']])

function build(tags: TagRow[], costs: TagCostRow[], selectedEventId = E1448.id) {
  return buildTagCostReport({
    tags,
    scope: [
      { tag_id: 1, department_id: 10, sub_department_id: 100 },
      { tag_id: 1, department_id: 20, sub_department_id: null },
    ],
    costs,
    events: EVENTS,
    selectedEventId,
    departmentName: (id) => DEPTS.get(id) ?? `#${id}`,
    subDepartmentName: (id) => SUBS.get(id) ?? `#${id}`,
    formatMoney: formatINR,
  })
}

describe('eventRelation', () => {
  it('places events before, at and after the selected one', () => {
    expect(eventRelation(E1447, E1448)).toBe('earlier')
    expect(eventRelation(E1448, E1448)).toBe('this')
    expect(eventRelation(E1449, E1448)).toBe('later')
  })
})

describe('departmentsLabel', () => {
  it('groups sub-departments under their department', () => {
    expect(
      departmentsLabel(
        [
          { department_id: 20, sub_department_id: null },
          { department_id: 10, sub_department_id: 100 },
        ],
        (id) => DEPTS.get(id)!,
        (id) => SUBS.get(id)!
      )
    ).toBe('Sanitation (Washrooms) · Tents')
  })
})

describe('buildTagCostReport', () => {
  const tags = [tag(1, 'Washroom block', E1447.id), tag(2, 'Tent stock', E1448.id), tag(3, 'Old well', E1447.id)]
  const costs = [
    cost(1, E1447.id, 500000, 4, 1),
    cost(1, E1448.id, 12000, 1),
    cost(1, E1449.id, 3000, 1),
    cost(2, E1448.id, 80000, 2, 2),
    // An event with only voided entries: counted, never costed.
    cost(3, E1447.id, 0, 0, 1),
  ]

  it('splits each tag into carried-in, this-event and later cost', () => {
    const { rows } = build(tags, costs)
    const washroom = rows.find((r) => r.tagId === 1)!
    expect(washroom.carriedIn).toBe(500000)
    expect(washroom.thisEvent).toBe(12000)
    expect(washroom.later).toBe(3000)
    expect(washroom.voidedCount).toBe(1)
    expect(washroom.periodLabel).toBe('1447 → perpetual')
    expect(washroom.departmentsLabel).toBe('Sanitation (Washrooms) · Tents')
    expect(washroom.costSummary).toBe('built 1447 ₹5,00,000 · maintained 1448 ₹12,000 · maintained 1449 ₹3,000')
    expect(washroom.startsThisEvent).toBe(false)

    const tent = rows.find((r) => r.tagId === 2)!
    expect(tent.carriedIn).toBe(0)
    expect(tent.thisEvent).toBe(80000)
    expect(tent.startsThisEvent).toBe(true)
  })

  it('sorts by cost up to the selected event, then by name', () => {
    expect(build(tags, costs).rows.map((r) => r.tagId)).toEqual([1, 2, 3])
  })

  it('totals exclude voided entries and later events', () => {
    const { totals } = build(tags, costs)
    expect(totals).toEqual({
      tagCount: 3,
      carriedIn: 500000,
      thisEvent: 92000,
      later: 3000,
      voidedCount: 4,
      newThisEventCount: 1,
      withoutCostCount: 1,
    })
  })

  it('builds per-event built vs maintained rows, oldest first', () => {
    const { eventRows } = build(tags, costs)
    expect(eventRows.map((r) => [r.hijriYear, r.relation, r.built, r.maintained, r.tagCount, r.voidedCount])).toEqual([
      ['1447', 'earlier', 500000, 0, 1, 2],
      ['1448', 'this', 80000, 12000, 2, 2],
      ['1449', 'later', 0, 3000, 1, 0],
    ])
  })

  it('drops cost rows for events it does not know', () => {
    const { rows, eventRows } = build([tag(1, 'Washroom block', E1447.id)], [cost(1, 999, 100, 1)])
    expect(rows[0]!.carriedIn + rows[0]!.thisEvent + rows[0]!.later).toBe(0)
    expect(eventRows).toEqual([])
  })

  it('is empty without tags', () => {
    const report = build([], [])
    expect(report.rows).toEqual([])
    expect(report.totals.tagCount).toBe(0)
  })
})

describe('tagCostSentence', () => {
  const base = { later: 0, voidedCount: 0, newThisEventCount: 0, withoutCostCount: 0 }
  it('says when no tags are active', () => {
    expect(tagCostSentence({ ...base, tagCount: 0, carriedIn: 0, thisEvent: 0 }, '1448', formatINR)).toBe(
      'No tags are active in 1448.'
    )
  })
  it('reports the carried-in share with INR grouping', () => {
    expect(tagCostSentence({ ...base, tagCount: 2, carriedIn: 24176880, thisEvent: 0 }, '1449', formatINR)).toBe(
      '2 tags are active in 1449. ₹2,41,76,880 was spent on them in earlier events; ₹0 has been spent this event, so 100% of their cost so far was carried in.'
    )
  })
  it('handles tags with no spend', () => {
    expect(tagCostSentence({ ...base, tagCount: 1, carriedIn: 0, thisEvent: 0 }, '1448', formatINR)).toContain(
      '1 tag is active in 1448. None of them'
    )
  })
})

describe('voidedNote', () => {
  it('is null for zero and pluralises', () => {
    expect(voidedNote(0)).toBeNull()
    expect(voidedNote(1)).toBe('1 voided entry is linked to these tags and is left out of every cost shown here.')
    expect(voidedNote(3)).toContain('3 voided entries are linked')
  })
})
