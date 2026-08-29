import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  applyEntriesFilters,
  buildPaginationPlan,
  computeNextCursor,
  fetchAllMatchingIds,
  type PageCursor,
} from '@/components/entries/query'
import { DEFAULT_FILTERS, DEFAULT_SORT, type EntriesSort, type EntryEnriched, type SortColumn } from '@/components/entries/types'
import { nextSort } from '@/components/ui/sortable-table-head'

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

// A minimal chainable stand-in for the real Supabase/PostgREST query builder.
// `applyEntriesFilters` only ever calls filter methods that return `this`, so
// a Proxy that records every call and hands back itself is enough to inspect
// the exact `.or()` string it constructs -- without needing a live client.
function createMockQuery() {
  const calls: Record<string, unknown[][]> = {}
  const builder = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return (...args: unknown[]) => {
          calls[prop] = calls[prop] ?? []
          calls[prop].push(args)
          return builder
        }
      },
    }
  ) as unknown as Parameters<typeof applyEntriesFilters>[0]
  return { builder, calls }
}

// Pulls out the single string argument passed to `.or()`, asserting it was
// actually called -- avoids repeating a non-null-assertion chain (and the
// `noUncheckedIndexedAccess` errors that come with it) at every call site.
function orFilterArg(calls: Record<string, unknown[][]>): string {
  const orCalls = calls.or
  if (!orCalls || !orCalls[0]) throw new Error('expected .or() to have been called')
  return orCalls[0][0] as string
}

describe('applyEntriesFilters -- vendor search with parentheses (hub-screen-certification.md 1.4)', () => {
  it('quotes the ilike value so a vendor name containing parentheses does not break or() group syntax', () => {
    const { builder, calls } = createMockQuery()
    applyEntriesFilters(builder, { ...DEFAULT_FILTERS, vendor: 'Acme (India)' })

    const filterString = orFilterArg(calls)

    // The exact known-good shape: both ilike values double-quoted, parens left
    // untouched inside the quotes, `%` wildcards intact.
    expect(filterString).toBe(
      'vendor_display_name.ilike."%Acme (India)%",vendor_raw.ilike."%Acme (India)%"'
    )

    // Structural check independent of the exact string: strip out the quoted
    // value segments and confirm no stray '(' or ')' remains to be misread as
    // an or()-group delimiter by PostgREST's parser.
    const withoutQuotedValues = filterString.replace(/"[^"]*"/g, '""')
    expect(withoutQuotedValues).not.toMatch(/[()]/)

    // The comma that separates the two ilike conditions must be the one
    // between the two quoted segments, not one PostgREST could misparse as
    // ending the or() list early inside a value.
    expect(filterString.split('.ilike.')).toHaveLength(3)
  })

  it('escapes an embedded double quote so it cannot terminate the quoted value early', () => {
    const { builder, calls } = createMockQuery()
    applyEntriesFilters(builder, { ...DEFAULT_FILTERS, vendor: 'Say "Hi" Traders' })

    const filterString = orFilterArg(calls)
    expect(filterString).toBe(
      'vendor_display_name.ilike."%Say \\"Hi\\" Traders%",vendor_raw.ilike."%Say \\"Hi\\" Traders%"'
    )
  })

  it('leaves a plain vendor term (no reserved characters) matching the original literal search text', () => {
    const { builder, calls } = createMockQuery()
    applyEntriesFilters(builder, { ...DEFAULT_FILTERS, vendor: 'Acme Traders' })

    const filterString = orFilterArg(calls)
    expect(filterString).toBe('vendor_display_name.ilike."%Acme Traders%",vendor_raw.ilike."%Acme Traders%"')
  })
})

// A mock client whose `v_entry_enriched` "select('id')" query resolves to the
// fixed id set, honouring the `.lt('id', cursor)` keyset cursor and `.limit()`
// that fetchAllMatchingIds walks it with. Every filter method returns `this`.
function createIdClient(allIds: number[]): SupabaseClient {
  const sorted = [...allIds].sort((a, b) => b - a)
  return {
    from() {
      return {
        select() {
          const state: { limit: number; lt: number | null } = { limit: Number.POSITIVE_INFINITY, lt: null }
          const builder: Record<string, unknown> = {}
          const passthrough = () => builder
          for (const m of ['eq', 'gte', 'lte', 'is', 'neq', 'gt', 'or', 'order']) builder[m] = passthrough
          builder.limit = (n: number) => {
            state.limit = n
            return builder
          }
          builder.lt = (_col: string, v: number) => {
            state.lt = v
            return builder
          }
          builder.then = (resolve: (r: { data: { id: number }[]; error: null }) => void) => {
            let rows = sorted.map((id) => ({ id }))
            if (state.lt !== null) rows = rows.filter((r) => r.id < (state.lt as number))
            rows = rows.slice(0, state.limit)
            resolve({ data: rows, error: null })
          }
          return builder
        },
      }
    },
  } as unknown as SupabaseClient
}

describe('fetchAllMatchingIds (hub-screen-certification.md §3.6)', () => {
  it('returns every matching id, in id-desc order, walking multiple keyset batches', async () => {
    const client = createIdClient([5, 1, 9, 3, 7])
    const { ids, truncated } = await fetchAllMatchingIds(client, DEFAULT_FILTERS, { batchSize: 2 })
    expect(ids).toEqual([9, 7, 5, 3, 1])
    expect(truncated).toBe(false)
  })

  it('stops and flags truncated once maxRows is reached', async () => {
    const client = createIdClient([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    const { ids, truncated } = await fetchAllMatchingIds(client, DEFAULT_FILTERS, { batchSize: 2, maxRows: 4 })
    expect(ids).toEqual([10, 9, 8, 7])
    expect(truncated).toBe(true)
  })

  it('returns an empty, non-truncated result when nothing matches', async () => {
    const { ids, truncated } = await fetchAllMatchingIds(createIdClient([]), DEFAULT_FILTERS)
    expect(ids).toEqual([])
    expect(truncated).toBe(false)
  })
})

describe('nextSort (hub-screen-certification.md §3.2)', () => {
  const descendingFirst = new Set<SortColumn>(['date', 'amount', 'document_count'])
  const from = (column: SortColumn, direction: 'asc' | 'desc') => ({ column, direction })

  it('opens a descending-first column descending on first click', () => {
    expect(nextSort(from('id', 'desc'), 'amount', descendingFirst)).toEqual({ column: 'amount', direction: 'desc' })
    expect(nextSort(from('id', 'desc'), 'document_count', descendingFirst)).toEqual({
      column: 'document_count',
      direction: 'desc',
    })
  })

  it('opens a normal column ascending on first click', () => {
    expect(nextSort(from('id', 'desc'), 'vendor_display_name', descendingFirst)).toEqual({
      column: 'vendor_display_name',
      direction: 'asc',
    })
    expect(nextSort(from('amount', 'desc'), 'type', descendingFirst)).toEqual({ column: 'type', direction: 'asc' })
  })

  it('flips direction when the already-active column is clicked again', () => {
    expect(nextSort(from('amount', 'desc'), 'amount', descendingFirst)).toEqual({ column: 'amount', direction: 'asc' })
    expect(nextSort(from('amount', 'asc'), 'amount', descendingFirst)).toEqual({ column: 'amount', direction: 'desc' })
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
