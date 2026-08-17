import { describe, expect, it } from 'vitest'
import { buildPaginationPlan, computeNextCursor, type PageCursor } from '@/components/entries/query'
import { DEFAULT_SORT, type EntriesSort, type EntryEnriched } from '@/components/entries/types'

// Minimal fixture -- only `id` is read by the pure cursor logic under test here.
function row(id: number): EntryEnriched {
  return { id } as EntryEnriched
}

const amountSort: EntriesSort = { column: 'amount', direction: 'asc' }

describe('buildPaginationPlan', () => {
  it('uses keyset mode for the default id-desc sort, with no starting point on the first page', () => {
    const plan = buildPaginationPlan(DEFAULT_SORT, null)
    expect(plan).toEqual({ mode: 'keyset', ascending: false, afterId: null })
  })

  it('resumes keyset pagination from the prior page\'s last id', () => {
    const cursor: PageCursor = { kind: 'keyset', lastId: 42 }
    const plan = buildPaginationPlan(DEFAULT_SORT, cursor)
    expect(plan).toEqual({ mode: 'keyset', ascending: false, afterId: 42 })
  })

  it('respects ascending direction for an id sort', () => {
    const plan = buildPaginationPlan({ column: 'id', direction: 'asc' }, null)
    expect(plan.mode).toBe('keyset')
    expect(plan.ascending).toBe(true)
  })

  it('falls back to offset mode for any non-id sort column -- keyset on id no longer means anything once row order is by amount/date/vendor/status', () => {
    const plan = buildPaginationPlan(amountSort, null)
    expect(plan).toEqual({ mode: 'offset', ascending: true, offset: 0 })
  })

  it('resumes offset pagination from the prior page\'s offset cursor', () => {
    const cursor: PageCursor = { kind: 'offset', offset: 100 }
    const plan = buildPaginationPlan(amountSort, cursor)
    expect(plan).toEqual({ mode: 'offset', ascending: true, offset: 100 })
  })

  it('ignores a keyset cursor left over from a prior (different) sort rather than misusing it as an offset', () => {
    const staleCursor: PageCursor = { kind: 'keyset', lastId: 99 }
    const plan = buildPaginationPlan(amountSort, staleCursor)
    expect(plan).toEqual({ mode: 'offset', ascending: true, offset: 0 })
  })

  it('ignores an offset cursor left over from a prior non-id sort when back on the default id sort', () => {
    const staleCursor: PageCursor = { kind: 'offset', offset: 250 }
    const plan = buildPaginationPlan(DEFAULT_SORT, staleCursor)
    expect(plan).toEqual({ mode: 'keyset', ascending: false, afterId: null })
  })
})

describe('computeNextCursor', () => {
  it('returns null once there is no more data, regardless of sort', () => {
    expect(computeNextCursor({ sort: DEFAULT_SORT, cursor: null, pageRows: [row(1)], hasMore: false })).toBeNull()
    expect(computeNextCursor({ sort: amountSort, cursor: null, pageRows: [row(1)], hasMore: false })).toBeNull()
  })

  it('for the default id sort, carries the last row\'s id forward as a keyset cursor', () => {
    const pageRows = [row(10), row(9), row(8)]
    const next = computeNextCursor({ sort: DEFAULT_SORT, cursor: null, pageRows, hasMore: true })
    expect(next).toEqual({ kind: 'keyset', lastId: 8 })
  })

  it('for a non-id sort, advances the offset by however many rows were just returned', () => {
    const pageRows = [row(1), row(2), row(3)]
    const next = computeNextCursor({
      sort: amountSort,
      cursor: { kind: 'offset', offset: 50 },
      pageRows,
      hasMore: true,
    })
    expect(next).toEqual({ kind: 'offset', offset: 53 })
  })

  it('treats a missing/null prior offset cursor as offset 0 (first page)', () => {
    const pageRows = [row(1), row(2)]
    const next = computeNextCursor({ sort: amountSort, cursor: null, pageRows, hasMore: true })
    expect(next).toEqual({ kind: 'offset', offset: 2 })
  })

  it('returns null if hasMore is somehow true but no rows came back, rather than an unusable keyset cursor', () => {
    const next = computeNextCursor({ sort: DEFAULT_SORT, cursor: null, pageRows: [], hasMore: true })
    expect(next).toBeNull()
  })
})

describe('keyset vs offset mode selection stays correct across a full page sequence', () => {
  it('a 3-page walk through amount-sorted data never repeats or skips a row', () => {
    const allRows = Array.from({ length: 7 }, (_, i) => row(i + 1))
    const limit = 3
    let cursor: PageCursor = null
    const seenIds: number[] = []

    for (let guard = 0; guard < 10; guard++) {
      const plan = buildPaginationPlan(amountSort, cursor)
      expect(plan.mode).toBe('offset')
      const offset = plan.mode === 'offset' ? plan.offset : 0
      const slice = allRows.slice(offset, offset + limit + 1)
      const hasMore = slice.length > limit
      const pageRows = hasMore ? slice.slice(0, limit) : slice
      seenIds.push(...pageRows.map((r) => r.id))
      cursor = computeNextCursor({ sort: amountSort, cursor, pageRows, hasMore })
      if (!hasMore) break
    }

    expect(seenIds).toEqual(allRows.map((r) => r.id))
  })
})
