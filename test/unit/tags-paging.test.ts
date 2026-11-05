import { describe, expect, it } from 'vitest'
import { fetchAllPages, TAG_PAGE_SIZE, type PageResult } from '@/lib/tags/paging'

/** A fake PostgREST table: serves .range(from, to) slices and never more than `cap` rows. */
function fakeTable(total: number, cap = TAG_PAGE_SIZE) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1 }))
  const calls: Array<[number, number]> = []
  const fetchPage = async (from: number, to: number): Promise<PageResult<{ id: number }>> => {
    calls.push([from, to])
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null }
  }
  return { rows, calls, fetchPage }
}

describe('fetchAllPages', () => {
  it('reads past the 1,000-row cap', async () => {
    const t = fakeTable(2350)
    const result = await fetchAllPages(t.fetchPage)
    expect(result.error).toBeNull()
    expect(result.data).toEqual(t.rows)
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  it('stops after a short page, including an empty table', async () => {
    expect((await fetchAllPages(fakeTable(0).fetchPage)).data).toEqual([])
    const t = fakeTable(999)
    expect((await fetchAllPages(t.fetchPage)).data).toHaveLength(999)
    expect(t.calls).toHaveLength(1)
  })

  it('asks for one more (empty) page when the rows are an exact multiple of the page size', async () => {
    const t = fakeTable(2000)
    const result = await fetchAllPages(t.fetchPage)
    expect(result.data).toHaveLength(2000)
    expect(t.calls).toHaveLength(3)
  })

  it('returns the first error together with the rows read so far', async () => {
    let n = 0
    const result = await fetchAllPages<{ id: number }>(async (from) => {
      n += 1
      if (n === 2) return { data: null, error: { message: 'boom' } }
      return { data: Array.from({ length: 1000 }, (_, i) => ({ id: from + i })), error: null }
    })
    expect(result.error).toEqual({ message: 'boom' })
    expect(result.data).toHaveLength(1000)
  })

  it('honours a custom page size', async () => {
    const t = fakeTable(5)
    const result = await fetchAllPages(t.fetchPage, 2)
    expect(result.data).toEqual(t.rows)
    expect(t.calls).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ])
  })
})
