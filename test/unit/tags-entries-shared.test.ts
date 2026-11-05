import { describe, expect, it } from 'vitest'
import {
  TAG_ENTRY_CHUNK,
  addedToTagMessage,
  buildEarlierTagNotices,
  chunk,
  defaultScopeFromEntries,
  defaultStartEventId,
  linkedEntriesMessage,
  mergeAddToTagOptions,
  noticeHeadline,
  noticePeriod,
  noticeText,
  rankTagsForDepartments,
  type AddToTagOptions,
  type EarlierTagSummary,
  type TagOption,
} from '@/lib/tags/entries-shared'
import { TAG_ENTRIES_PER_CALL } from '@/lib/tags/limits'
import type { EventOrderRef } from '@/lib/tags/shared'

const tag = (over: Partial<EarlierTagSummary> & Pick<EarlierTagSummary, 'id' | 'name'>): EarlierTagSummary => ({
  startEventId: 1,
  endEventId: null,
  periodLabel: '1447 → perpetual',
  departmentIds: [10],
  ...over,
})

const SANITATION = { id: 10, name: 'Sanitation' }
const KITCHEN = { id: 20, name: 'Kitchen' }

describe('noticePeriod', () => {
  it('says "perpetual" when there is no end event', () => {
    expect(noticePeriod({ endEventId: null, periodLabel: '1447 → perpetual' })).toBe('perpetual')
  })
  it('keeps the full period when the tag ends', () => {
    expect(noticePeriod({ endEventId: 3, periodLabel: '1447 → 1449' })).toBe('1447 → 1449')
  })
})

describe('buildEarlierTagNotices', () => {
  const washroom = tag({ id: 1, name: 'Washroom block' })
  const tents = tag({ id: 2, name: 'Tent stock', endEventId: 3, periodLabel: '1447 → 1449', departmentIds: [10, 20] })
  const stove = tag({ id: 3, name: 'Stove', departmentIds: [20] })

  it('groups tags by department and sorts them by name', () => {
    const groups = buildEarlierTagNotices([washroom, tents, stove], [SANITATION, KITCHEN])
    expect(groups.map((g) => g.departmentName)).toEqual(['Sanitation', 'Kitchen'])
    expect(groups[0]!.tags.map((t) => t.name)).toEqual(['Tent stock', 'Washroom block'])
    expect(groups[1]!.tags.map((t) => t.name)).toEqual(['Stove', 'Tent stock'])
  })

  it('omits a department that has no tags', () => {
    expect(buildEarlierTagNotices([stove], [SANITATION, KITCHEN]).map((g) => g.departmentId)).toEqual([20])
    expect(buildEarlierTagNotices([], [SANITATION])).toEqual([])
    expect(buildEarlierTagNotices([washroom], [])).toEqual([])
  })

  it('drops excluded tags, e.g. ones the entry already belongs to', () => {
    const groups = buildEarlierTagNotices([washroom, tents], [SANITATION], new Set([2]))
    expect(groups[0]!.tags.map((t) => t.id)).toEqual([1])
    expect(buildEarlierTagNotices([washroom], [SANITATION], new Set([1]))).toEqual([])
  })

  it('does not repeat a department listed twice', () => {
    expect(buildEarlierTagNotices([washroom], [SANITATION, SANITATION])).toHaveLength(1)
  })

  it('labels the period as perpetual or with its range', () => {
    const [group] = buildEarlierTagNotices([washroom, tents], [SANITATION])
    expect(group!.tags.map((t) => t.period)).toEqual(['1447 → 1449', 'perpetual'])
  })
})

describe('notice wording', () => {
  const group = {
    departmentId: 10,
    departmentName: 'Sanitation',
    tags: [
      { id: 1, name: 'Washroom block', period: 'perpetual' },
      { id: 2, name: 'Tent stock', period: '1447 → 1449' },
    ],
  }
  it('pluralises the headline', () => {
    expect(noticeHeadline(group)).toBe('Sanitation has 2 tags from earlier years')
    expect(noticeHeadline({ ...group, tags: group.tags.slice(0, 1) })).toBe('Sanitation has 1 tag from earlier years')
  })
  it('reads as one sentence', () => {
    expect(noticeText(group)).toBe(
      'Sanitation has 2 tags from earlier years: Washroom block (perpetual), Tent stock (1447 → 1449)'
    )
  })
})

describe('chunk', () => {
  it('splits into slices of at most the size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })
  it('defaults to the shared chunk size', () => {
    const ids = Array.from({ length: TAG_ENTRY_CHUNK * 2 + 1 }, (_, i) => i)
    expect(chunk(ids).map((c) => c.length)).toEqual([TAG_ENTRY_CHUNK, TAG_ENTRY_CHUNK, 1])
  })
})

describe('defaultScopeFromEntries', () => {
  it('gives one department-only pick per distinct department, ordered by id', () => {
    expect(defaultScopeFromEntries([{ department_id: 20 }, { department_id: 10 }, { department_id: 20 }])).toEqual([
      { departmentId: 10, subDepartmentId: null },
      { departmentId: 20, subDepartmentId: null },
    ])
  })
  it('skips entries with no department', () => {
    expect(defaultScopeFromEntries([{ department_id: null }])).toEqual([])
  })
})

describe('defaultStartEventId', () => {
  const e = (id: number, hijriYear: string, startsOn: string | null = null): EventOrderRef => ({ id, hijriYear, startsOn })
  const events = [e(1, '1447', '2025-07-01'), e(2, '1448', '2026-06-20'), e(3, '1449', '2027-06-10')]
  it('is the oldest event among the entries', () => {
    expect(defaultStartEventId([3, 2], events, 3)).toBe(2)
    expect(defaultStartEventId([3, 1, 2], events, 3)).toBe(1)
  })
  it('is the entries\' event when they are all in the selected one', () => {
    expect(defaultStartEventId([3], events, 3)).toBe(3)
  })
  it('falls back to the selected event when the entries\' events are unknown', () => {
    expect(defaultStartEventId([], events, 2)).toBe(2)
    expect(defaultStartEventId([99], events, 2)).toBe(2)
    expect(defaultStartEventId([], events, null)).toBeNull()
  })
})

describe('rankTagsForDepartments', () => {
  const opt = (id: number, name: string, departmentIds: number[]): TagOption => ({
    id,
    name,
    description: null,
    periodLabel: '1447 → perpetual',
    departmentIds,
  })
  it('puts tags on the entries\' departments first, each half by name', () => {
    const ranked = rankTagsForDepartments(
      [opt(1, 'Zebra', [10]), opt(2, 'Apple', [20]), opt(3, 'Mango', [10]), opt(4, 'Banana', [30])],
      [10]
    )
    expect(ranked.map((t) => t.name)).toEqual(['Mango', 'Zebra', 'Apple', 'Banana'])
    expect(ranked.map((t) => t.matches)).toEqual([true, true, false, false])
  })
  it('matches nothing when no department is known', () => {
    expect(rankTagsForDepartments([opt(1, 'A', [10])], []).every((t) => !t.matches)).toBe(true)
  })
})

describe('addedToTagMessage', () => {
  it('pluralises', () => {
    expect(addedToTagMessage(1, 'Washroom block')).toBe('Added 1 entry to "Washroom block".')
    expect(addedToTagMessage(3, 'Washroom block')).toBe('Added 3 entries to "Washroom block".')
  })
  it('counts only the newly linked entries and says how many were already there', () => {
    expect(addedToTagMessage(2, 'Washroom block', 5)).toBe('Added 2 entries to "Washroom block". 3 were already on it.')
    expect(addedToTagMessage(4, 'Washroom block', 5)).toBe('Added 4 entries to "Washroom block". 1 was already on it.')
  })
  it('says so when nothing new was added', () => {
    expect(addedToTagMessage(0, 'Washroom block', 1)).toBe('That entry was already on "Washroom block".')
    expect(addedToTagMessage(0, 'Washroom block', 3)).toBe('Those entries were already on "Washroom block".')
  })
  it('groups large counts the Indian way', () => {
    expect(addedToTagMessage(1234567, 'X')).toBe('Added 12,34,567 entries to "X".')
  })
})

describe('linkedEntriesMessage', () => {
  it('reports only newly linked entries', () => {
    expect(linkedEntriesMessage(1)).toBe('Linked 1 entry.')
    expect(linkedEntriesMessage(2, 5)).toBe('Linked 2 entries. 3 were already linked.')
    expect(linkedEntriesMessage(0, 1)).toBe('That entry was already linked.')
    expect(linkedEntriesMessage(0, 4)).toBe('Those entries were already linked.')
  })
})

describe('batch sizes', () => {
  it('a client batch always fits under what one server call accepts', () => {
    expect(TAG_ENTRY_CHUNK).toBeLessThanOrEqual(TAG_ENTRIES_PER_CALL)
  })
  it('a selection of 3,000 entries splits into calls that each stay under the cap', () => {
    const ids = Array.from({ length: 3000 }, (_, i) => i + 1)
    const calls = chunk(ids, TAG_ENTRIES_PER_CALL)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.length <= TAG_ENTRIES_PER_CALL)).toBe(true)
    expect(calls.flat()).toEqual(ids)
  })
})

describe('mergeAddToTagOptions', () => {
  const events = [
    { id: 1, name: 'E1', hijriYear: '1447', startsOn: null, endsOn: null, isCurrent: false, createdAt: '' },
    { id: 2, name: 'E2', hijriYear: '1448', startsOn: null, endsOn: null, isCurrent: false, createdAt: '' },
    { id: 3, name: 'E3', hijriYear: '1449', startsOn: null, endsOn: null, isCurrent: true, createdAt: '' },
  ]
  const part = (over: Partial<AddToTagOptions>): AddToTagOptions => ({
    events,
    departments: [{ id: 10, name: 'Sanitation' }],
    subDepartments: [],
    tags: [],
    selectedEventId: 3,
    defaultScope: [],
    defaultStartEventId: 3,
    entryCount: 0,
    ...over,
  })
  it('returns a single batch unchanged', () => {
    const only = part({ entryCount: 5, defaultStartEventId: 2 })
    expect(mergeAddToTagOptions([only])).toBe(only)
  })
  it('unions the departments, takes the oldest start event, sums the entry counts', () => {
    const merged = mergeAddToTagOptions([
      part({ entryCount: 1000, defaultStartEventId: 2, defaultScope: [{ departmentId: 20, subDepartmentId: null }] }),
      part({
        entryCount: 500,
        defaultStartEventId: 1,
        defaultScope: [
          { departmentId: 10, subDepartmentId: null },
          { departmentId: 20, subDepartmentId: null },
        ],
      }),
    ])
    expect(merged.entryCount).toBe(1500)
    expect(merged.defaultStartEventId).toBe(1)
    expect(merged.defaultScope).toEqual([
      { departmentId: 10, subDepartmentId: null },
      { departmentId: 20, subDepartmentId: null },
    ])
  })
  it('ignores a batch with no readable entries when picking the start event', () => {
    // That batch falls back to the selected event (3); it must not pull the result later.
    const merged = mergeAddToTagOptions([
      part({ entryCount: 0, defaultStartEventId: 3 }),
      part({ entryCount: 10, defaultStartEventId: 2 }),
    ])
    expect(merged.defaultStartEventId).toBe(2)
  })
  it('falls back to the first batch default when no batch had entries', () => {
    const merged = mergeAddToTagOptions([part({ defaultStartEventId: 3 }), part({ defaultStartEventId: 3 })])
    expect(merged.defaultStartEventId).toBe(3)
    expect(merged.entryCount).toBe(0)
  })
  it('refuses an empty list', () => {
    expect(() => mergeAddToTagOptions([])).toThrow()
  })
})
