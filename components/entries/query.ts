import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntriesFilters, EntryEnriched } from './types'

// The exact builder type returned by `supabase.from('v_entry_enriched').select(...)`
// (and still returned after `.order()`/`.limit()`, since both are typed to return
// `this`). Deriving it from the client rather than hand-rolling a duck-typed
// interface keeps every filter method's real signature (and return-type-is-`this`
// chaining) intact for both callers — the paged fetch below and the CSV export's
// batch loop, which both continue chaining (e.g. `.lt('id', cursor)`) on the
// result of this function.
type EntriesQueryBuilder = ReturnType<ReturnType<SupabaseClient['from']>['select']>

/**
 * Shared filter application over `v_entry_enriched` (MASTER-PLAN §10.2) —
 * used by both the paged fetch (entries-explorer.tsx) and the "fetch
 * everything matching" CSV export, so the two can never silently diverge.
 *
 * `security_invoker = true` on the view means RLS on the underlying
 * `entries` table (§4.2 `entries_select`) applies exactly as if this were a
 * direct query — a viewer scoped to one department gets zero rows back for
 * every other department, with no filter-bar logic required to enforce it.
 */
export function applyEntriesFilters<T extends EntriesQueryBuilder>(query: T, filters: EntriesFilters): T {
  let q = query

  if (filters.department) q = q.eq('department_id', filters.department)
  if (filters.budgetHead) q = q.eq('budget_head_id', filters.budgetHead)
  if (filters.head) q = q.eq('head_id', filters.head)
  if (filters.zone) q = q.eq('zone_id', filters.zone)
  if (filters.tenantStatus) q = q.eq('tenant_status_id', filters.tenantStatus)
  if (filters.mainStatus) q = q.eq('main_status_id', filters.mainStatus)
  if (filters.hubStatus) q = q.eq('hub_status_id', filters.hubStatus)
  if (filters.dateFrom) q = q.gte('date', filters.dateFrom)
  if (filters.dateTo) q = q.lte('date', filters.dateTo)
  if (filters.vendor.trim()) {
    const term = filters.vendor.trim().replace(/[%,]/g, '')
    q = q.or(`vendor_display_name.ilike.%${term}%,vendor_raw.ilike.%${term}%`)
  }
  // export-pending: "hub_status_exported_at is null and hub_status_code <> 'not_set'"
  if (filters.exportPending) {
    q = q.is('hub_status_exported_at', null).neq('hub_status_code', 'not_set')
  }
  // has-variance: amount_variance <> 0. Postgres's `<>` against NULL is UNKNOWN, not
  // TRUE, so this naturally excludes entries missing one side of the amount too —
  // exactly the "both amounts present and they differ" semantic §5 asks for.
  if (filters.hasVariance) {
    q = q.neq('amount_variance', 0)
  }
  if (filters.hasDocument) {
    q = q.gt('document_count', 0)
  }

  return q
}

export const ENTRIES_SELECT = '*'

export type FetchPageArgs = {
  supabase: SupabaseClient
  filters: EntriesFilters
  cursor: number | null // last row's id from the previous page; null = first page
  limit: number
}

export type FetchPageResult = {
  rows: EntryEnriched[]
  hasMore: boolean
}

/** Keyset pagination on `id desc` — see components/entries/entries-explorer.tsx for why. */
export async function fetchEntriesPage({ supabase, filters, cursor, limit }: FetchPageArgs): Promise<FetchPageResult> {
  let query = supabase.from('v_entry_enriched').select(ENTRIES_SELECT).order('id', { ascending: false }).limit(limit + 1)
  query = applyEntriesFilters(query, filters)
  if (cursor !== null) {
    query = query.lt('id', cursor)
  }
  const { data, error } = await query
  if (error) throw error
  const rows = (data ?? []) as EntryEnriched[]
  const hasMore = rows.length > limit
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore }
}
