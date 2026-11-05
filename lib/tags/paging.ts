/**
 * Paging for the Tags reads. PostgREST answers at most 1,000 rows per request (the project's
 * max-rows setting), silently: a query with no range simply stops at 1,000, and a tag with
 * more linked entries than that would lose the rest without any error. Plain module -- no
 * 'use client' / 'use server' -- so loaders, server actions and tests all import it.
 */

/** Rows asked for per request; equal to PostgREST's own cap, so a full page means "maybe more". */
export const TAG_PAGE_SIZE = 1000

export interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

/**
 * Reads every row a query can return by asking for consecutive `.range(from, to)` pages until
 * one comes back short. `fetchPage` must apply a STABLE, UNIQUE ordering (e.g. by a primary
 * key) -- without one, rows can repeat or go missing between pages. Stops at the first error
 * and returns it together with what was read so far.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number = TAG_PAGE_SIZE
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) return { data: rows, error }
    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return { data: rows, error: null }
  }
}
