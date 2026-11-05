import { describe, expect, it } from 'vitest'
import {
  buildReviewTagRows,
  defaultLinkEntryId,
  distinctEntryDepartments,
  orderReviewTagRows,
  reviewTagCoverageLabel,
  reviewTagNoticeHeading,
  tagRowEntryFit,
  tagRowMatchesEntry,
  unlinkedEntriesForTag,
  type ReviewNoticeEntry,
  type ReviewTagRow,
  type ReviewTagScopeInput,
} from '@/lib/tags/review-shared'

const SANITATION = 7
const VENUE = 9
const KITCHEN = 11

const events = [
  { id: 1, hijriYear: '1447' },
  { id: 2, hijriYear: '1448' },
  { id: 3, hijriYear: '1449' },
]

const activeTags = [
  { id: 10, name: 'Washroom block', start_event_id: 2, end_event_id: null },
  { id: 11, name: 'Tent stock', start_event_id: 1, end_event_id: 3 },
  { id: 12, name: 'Stage lights', start_event_id: 3, end_event_id: 3 },
]

const sanitation = { id: SANITATION, name: 'Sanitation' }
const venue = { id: VENUE, name: 'Venue Setup' }

function scope(tag_id: number, department_id: number, sub: [number, string] | null): ReviewTagScopeInput {
  return {
    tag_id,
    department_id,
    sub_department_id: sub ? sub[0] : null,
    sub_department_name: sub ? sub[1] : null,
  }
}

describe('buildReviewTagRows', () => {
  it('keeps only active tags with scope in the bill departments', () => {
    const rows = buildReviewTagRows({
      departments: [sanitation],
      activeTags,
      scope: [scope(10, SANITATION, null), scope(11, SANITATION, [51, 'Tents']), scope(12, VENUE, null)],
      notes: [],
      links: [],
      events,
    })
    expect(rows.map((r) => r.tagId)).toEqual([11, 10]) // by name: Tent stock, Washroom block
  })

  it('ignores scope rows for tags that are not active in the event', () => {
    const rows = buildReviewTagRows({
      departments: [sanitation],
      activeTags: [],
      scope: [scope(10, SANITATION, null)],
      notes: [],
      links: [],
      events,
    })
    expect(rows).toEqual([])
  })

  it('fills period, note, coverage and per-entry linked state', () => {
    const rows = buildReviewTagRows({
      departments: [sanitation],
      activeTags,
      scope: [
        scope(11, SANITATION, [52, 'Washrooms']),
        scope(11, SANITATION, [51, 'Tents']),
        scope(11, SANITATION, [51, 'Tents']),
        scope(10, SANITATION, null),
        scope(12, SANITATION, null),
      ],
      notes: [{ tag_id: 11, note: '1449: 12 tents torn' }],
      links: [{ tag_id: 10, entry_id: 301 }],
      events,
    })
    const byId = new Map(rows.map((r) => [r.tagId, r]))
    expect(byId.get(10)).toMatchObject({
      periodLabel: '1448 → perpetual',
      note: null,
      coverage: [{ departmentId: SANITATION, coversWholeDepartment: true, subDepartments: [] }],
      linkedEntryIds: [301],
    })
    expect(byId.get(11)).toMatchObject({
      periodLabel: '1447 → 1449',
      note: '1449: 12 tents torn',
      coverage: [
        {
          departmentId: SANITATION,
          coversWholeDepartment: false,
          subDepartments: [
            { id: 51, name: 'Tents' },
            { id: 52, name: 'Washrooms' },
          ],
        },
      ],
      linkedEntryIds: [],
    })
    expect(byId.get(12)?.periodLabel).toBe('1449 only')
  })

  it('never errors on a missing sub-department name or unknown events', () => {
    const rows = buildReviewTagRows({
      departments: [sanitation],
      activeTags: [{ id: 20, name: 'Old store', start_event_id: 99, end_event_id: 98 }],
      scope: [{ tag_id: 20, department_id: SANITATION, sub_department_id: 5, sub_department_name: null }],
      notes: [],
      links: [],
      events,
    })
    expect(rows[0]?.periodLabel).toBe('? → ?')
    expect(rows[0]?.coverage[0]?.subDepartments).toEqual([{ id: 5, name: 'Unnamed sub-department' }])
  })

  it('covers every department of a multi-entry bill and lists a tag once', () => {
    const rows = buildReviewTagRows({
      departments: [venue, sanitation],
      activeTags,
      scope: [
        scope(10, SANITATION, null),
        scope(10, VENUE, [61, 'Stage']),
        scope(12, VENUE, null),
        scope(11, KITCHEN, null), // not a bill department: ignored
      ],
      notes: [],
      links: [
        { tag_id: 10, entry_id: 301 },
        { tag_id: 10, entry_id: 302 },
      ],
      events,
    })
    expect(rows.map((r) => r.tagId)).toEqual([12, 10]) // Stage lights, Washroom block; Tent stock not touched
    const washroom = rows.find((r) => r.tagId === 10)!
    expect(washroom.coverage.map((c) => c.departmentName)).toEqual(['Sanitation', 'Venue Setup'])
    expect(washroom.linkedEntryIds).toEqual([301, 302])
  })

  it('does not repeat a tag the rpc returned twice', () => {
    const rows = buildReviewTagRows({
      departments: [sanitation],
      activeTags: [activeTags[0]!, activeTags[0]!],
      scope: [scope(10, SANITATION, null)],
      notes: [],
      links: [],
      events,
    })
    expect(rows).toHaveLength(1)
  })
})

function row(partial: Partial<ReviewTagRow> & Pick<ReviewTagRow, 'tagId' | 'name'>): ReviewTagRow {
  return {
    periodLabel: '1448 → perpetual',
    note: null,
    coverage: [],
    linkedEntryIds: [],
    ...partial,
  }
}

function cover(departmentId: number, whole: boolean, subs: Array<[number, string]> = []) {
  return {
    departmentId,
    departmentName: departmentId === SANITATION ? 'Sanitation' : 'Venue Setup',
    coversWholeDepartment: whole,
    subDepartments: subs.map(([id, name]) => ({ id, name })),
  }
}

describe('tagRowEntryFit / tagRowMatchesEntry / orderReviewTagRows', () => {
  const whole = row({ tagId: 1, name: 'Zeta whole', coverage: [cover(SANITATION, true)] })
  const tents = row({ tagId: 2, name: 'Alpha tents', coverage: [cover(SANITATION, false, [[51, 'Tents']])] })
  const wash = row({ tagId: 3, name: 'Beta wash', coverage: [cover(SANITATION, false, [[52, 'Washrooms']])] })
  const stage = row({ tagId: 4, name: 'Gamma stage', coverage: [cover(VENUE, true)] })

  it('whole-department tags always match; sub-department tags need the same pick', () => {
    expect(tagRowMatchesEntry(whole, { departmentId: SANITATION, subDepartmentId: null })).toBe(true)
    expect(tagRowMatchesEntry(whole, { departmentId: SANITATION, subDepartmentId: 51 })).toBe(true)
    expect(tagRowMatchesEntry(tents, { departmentId: SANITATION, subDepartmentId: null })).toBe(false)
    expect(tagRowMatchesEntry(tents, { departmentId: SANITATION, subDepartmentId: 51 })).toBe(true)
    expect(tagRowMatchesEntry(tents, { departmentId: SANITATION, subDepartmentId: 52 })).toBe(false)
  })

  it('fit is 0 for another department, 1 for department only, 2 for a direct match', () => {
    expect(tagRowEntryFit(tents, { departmentId: VENUE, subDepartmentId: null })).toBe(0)
    expect(tagRowEntryFit(tents, { departmentId: null, subDepartmentId: null })).toBe(0)
    expect(tagRowEntryFit(tents, { departmentId: SANITATION, subDepartmentId: 52 })).toBe(1)
    expect(tagRowEntryFit(tents, { departmentId: SANITATION, subDepartmentId: 51 })).toBe(2)
  })

  it('puts tags matching ANY entry first (live sub-department), then by name, without dropping any', () => {
    const entries = [
      { departmentId: SANITATION, subDepartmentId: 52 },
      { departmentId: VENUE, subDepartmentId: null },
    ]
    expect(orderReviewTagRows([whole, tents, wash, stage], entries).map((r) => r.tagId)).toEqual([3, 4, 1, 2])
    expect(
      orderReviewTagRows([whole, tents, wash], [{ departmentId: SANITATION, subDepartmentId: null }]).map(
        (r) => r.tagId
      )
    ).toEqual([1, 2, 3])
  })

  it('does not mutate its input', () => {
    const input = [whole, tents, wash]
    orderReviewTagRows(input, [{ departmentId: SANITATION, subDepartmentId: 52 }])
    expect(input.map((r) => r.tagId)).toEqual([1, 2, 3])
  })
})

describe('distinctEntryDepartments', () => {
  it('returns each department once, sorted by name, skipping entries with none', () => {
    const names = new Map([
      [SANITATION, 'Sanitation'],
      [VENUE, 'Venue Setup'],
    ])
    const result = distinctEntryDepartments(
      [{ departmentId: VENUE }, { departmentId: null }, { departmentId: SANITATION }, { departmentId: VENUE }],
      (id) => names.get(id) ?? null
    )
    expect(result).toEqual([sanitation, venue])
  })
})

describe('link choice', () => {
  const entries: ReviewNoticeEntry[] = [
    { entryId: 301, ubblNumber: 'U-301', amount: 90000, departmentId: VENUE, subDepartmentId: null },
    { entryId: 302, ubblNumber: 'U-302', amount: 50000, departmentId: SANITATION, subDepartmentId: 52 },
    { entryId: 303, ubblNumber: 'U-303', amount: 10000, departmentId: SANITATION, subDepartmentId: 51 },
  ]
  const tents = row({ tagId: 2, name: 'Tents', coverage: [cover(SANITATION, false, [[51, 'Tents']])] })

  it('defaults to the entry whose department and sub-department the tag covers', () => {
    expect(defaultLinkEntryId(tents, entries)).toBe(303)
  })

  it('falls back to a department-only match, then to the first entry', () => {
    expect(defaultLinkEntryId(tents, entries.slice(0, 2))).toBe(302)
    expect(defaultLinkEntryId(tents, entries.slice(0, 1))).toBe(301)
    expect(defaultLinkEntryId(tents, [])).toBeNull()
  })

  it('ties go to the earlier (larger) entry', () => {
    const whole = row({ tagId: 1, name: 'Whole', coverage: [cover(SANITATION, true)] })
    expect(defaultLinkEntryId(whole, entries.slice(1))).toBe(302)
  })

  it('unlinkedEntriesForTag drops entries already linked, per entry', () => {
    expect(unlinkedEntriesForTag(entries, new Set([302])).map((e) => e.entryId)).toEqual([301, 303])
    expect(unlinkedEntriesForTag(entries, new Set([301, 302, 303]))).toEqual([])
  })
})

describe('labels', () => {
  it('coverage label', () => {
    expect(reviewTagCoverageLabel({ coverage: [cover(SANITATION, true)] })).toBe('Whole department')
    expect(reviewTagCoverageLabel({ coverage: [cover(SANITATION, true, [[1, 'Tents']])] })).toBe(
      'Whole department, Tents'
    )
    expect(
      reviewTagCoverageLabel({
        coverage: [
          cover(SANITATION, false, [
            [1, 'Tents'],
            [2, 'Washrooms'],
          ]),
        ],
      })
    ).toBe('Tents, Washrooms')
  })

  it('prefixes the department when the bill spans several', () => {
    expect(
      reviewTagCoverageLabel({ coverage: [cover(SANITATION, false, [[1, 'Tents']]), cover(VENUE, true)] }, true)
    ).toBe('Sanitation: Tents; Venue Setup: Whole department')
  })

  it('heading pluralises, handles several departments and a missing name', () => {
    expect(reviewTagNoticeHeading(['Sanitation'], 2)).toBe('Sanitation has 2 tags on record')
    expect(reviewTagNoticeHeading(['Sanitation'], 1)).toBe('Sanitation has 1 tag on record')
    expect(reviewTagNoticeHeading([], 1)).toBe('This department has 1 tag on record')
    expect(reviewTagNoticeHeading(['  '], 3)).toBe('This department has 3 tags on record')
    expect(reviewTagNoticeHeading(['Sanitation', 'Venue Setup'], 3)).toBe(
      "This bill's 2 departments have 3 tags on record"
    )
  })
})
