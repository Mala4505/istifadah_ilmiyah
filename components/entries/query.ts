import type { SupabaseClient } from '@supabase/supabase-js'
import { ALL_COLUMNS, type ColumnKey, type EntriesFilters, type EntriesSort, type EntryEnriched } from './types'

// The exact builder type returned by `supabase.from('v_entry_enriched').select(...)`
// (and still returned after `.order()`/`.limit()`, since both are typed to return
// `this`). Deriving it from the client rather than hand-rolling a duck-typed
// interface keeps every filter method's real signature (and return-type-is-`this`
// chaining) intact for both callers — the paged fetch below and the CSV export's
// batch loop, which both continue chaining (e.g. `.lt('id', cursor)`) on the
// result of this function.
export type EntriesQueryBuilder = ReturnType<ReturnType<SupabaseClient['from']>['select']>

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

  if (filters.type) q = q.eq('type', filters.type)
  if (filters.department) q = q.eq('department_id', filters.department)
  if (filters.budgetHead) q = q.eq('budget_head_id', filters.budgetHead)
  if (filters.adminHead) q = q.eq('admin_head_id', filters.adminHead)
  if (filters.zone) q = q.eq('zone_id', filters.zone)
  if (filters.costCenter) q = q.eq('cost_center_id', filters.costCenter)
  if (filters.vendorId) q = q.eq('vendor_id', filters.vendorId)
  if (filters.status) q = q.eq('status_id', filters.status)
  if (filters.hubStatus) q = q.eq('hub_status_id', filters.hubStatus)
  if (filters.dateFrom) q = q.gte('date', filters.dateFrom)
  if (filters.dateTo) q = q.lte('date', filters.dateTo)
  if (filters.vendor.trim()) {
    // PostgREST reserves `,` `.` `(` `)` as or()/filter-grammar delimiters, so a
    // vendor name containing any of them (e.g. "Acme (India)") breaks the
    // filter string. Double-quoting the ilike pattern's value makes those
    // characters literal (PostgREST's documented quoted-value syntax for
    // filter values) -- within the quotes, only `\` and `"` themselves still
    // need escaping. `%` is the ilike wildcard, not a PostgREST delimiter, so
    // it's left as-is and still works inside the quotes.
    const term = filters.vendor.trim()
    const escaped = term.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    q = q.or(`vendor_display_name.ilike."%${escaped}%",vendor_raw.ilike."%${escaped}%"`)
  }
  // export-pending: "hub_status_exported_at is null and hub_status_code <> 'not_set'"
  if (filters.exportPending) {
    q = q.is('hub_status_exported_at', null).neq('hub_status_code', 'not_set')
  }
  // has-variance: REPURPOSED 2026-08-11 -- amount_variance no longer exists (§3.4,
  // there is no genuinely separate second amount to diff). Now means "missing a
  // Main/Audit-side match" (main_number is null), matching v_department_audit_variance
  // (20260811000004). The richer "does a bill's consolidated entries sum to its export
  // total" check needs a defined bill-grouping key that hasn't been specified yet.
  if (filters.hasVariance) {
    q = q.is('main_number', null)
  }
  if (filters.hasDocument) {
    q = q.gt('document_count', 0)
  }

  return q
}

// 7.2 (docs/performance-remediation-plan.md Phase 7): `v_entry_enriched` has
// ~35 columns; the list/CSV column chooser only ever renders the subset
// named in `ALL_COLUMNS`. Most `ColumnKey`s map 1:1 onto a same-named view
// column, but `export_pending` is derived client-side (csv-export.ts's
// `cellValue`) from two raw columns rather than being a column itself, so it
// needs both named explicitly here despite exposing neither by that name.
const COLUMN_KEY_SELECT_COLUMNS: Record<ColumnKey, readonly string[]> = {
  type: ['type'],
  ubbl_number: ['ubbl_number'],
  main_number: ['main_number'],
  department_name: ['department_name'],
  budget_head_short_label: ['budget_head_short_label'],
  admin_head_name: ['admin_head_name'],
  zone_name: ['zone_name'],
  cost_center_name: ['cost_center_name'],
  vendor_display_name: ['vendor_display_name'],
  invoice_number: ['invoice_number'],
  date: ['date'],
  amount: ['amount'],
  status_label: ['status_label'],
  hub_status_label: ['hub_status_label'],
  export_pending: ['hub_status_exported_at', 'hub_status_code'],
  document_count: ['document_count'],
}

// Single source of truth for "which raw `v_entry_enriched` columns can the
// list/CSV path ever need" — derived from `ALL_COLUMNS` rather than
// hand-typed, so a column added there becomes selectable with no second
// edit. `id` is added unconditionally: it drives keyset pagination
// (`fetchEntriesPage`/`exportEntriesToCsv`'s cursor) and row identity even
// though it isn't itself a renderable column.
export const ENTRIES_LIST_SELECT_COLUMNS: readonly string[] = Array.from(
  new Set<string>(['id', ...ALL_COLUMNS.flatMap((c) => COLUMN_KEY_SELECT_COLUMNS[c.key])])
)

export const ENTRIES_SELECT = ENTRIES_LIST_SELECT_COLUMNS.join(', ')

// 7.2's detail-load half: the entry detail screen
// (app/(app)/entries/[id]/page.tsx) and its child components
// (components/entries/detail/{import-fields-panel,reimbursement-detail-section,
// advance-payment-detail-section}.tsx) render several fields the list/CSV
// column chooser never surfaces -- e.g. `variance_reason`, the
// `reimbursement_*`/`advance_invoice_amount` type-detail fields, and the raw
// ids (`vendor_id`, `department_id`, ...) needed to cross-reference other
// tables. Verified by reading every one of those files for every `entry.*`
// access, rather than assumed. Built as the list select's columns plus
// exactly this extra set -- not a third, independently hand-typed column
// list -- so both selects stay derived from the one place a column is added
// to `ALL_COLUMNS`. Columns confirmed unused anywhere on the detail screen,
// and left out of ENTRY_DETAIL_EXTRA_COLUMNS below because nothing on this
// screen needs them: `budget_head_id`, `status_id`, `status_code`,
// `hub_status_id`, `hub_status_changed_at`, `hub_status_changed_by`,
// `hub_status_note`, `import_batch_id`, `created_at`, `updated_at`. Four more
// -- `admin_head_name`, `zone_name`, `cost_center_name`, `document_count` --
// are equally unused here but still end up selected anyway, since they ride
// in via the shared list-select base above; kept that way for the simplicity
// of one base to extend rather than a second, near-duplicate minimal set.
const ENTRY_DETAIL_EXTRA_COLUMNS = [
  'department_id',
  'budget_head_raw_label',
  'vendor_id',
  'vendor_raw',
  'variance_reason',
  'status_raw',
  'admin_head_id',
  'zone_id',
  'cost_center_id',
  'remark',
  'settles_entry_id',
  'is_void',
  'source',
  'reimbursement_sr_no',
  'reimbursement_type',
  'reimburse_to_raw',
  'advance_invoice_amount',
] as const

export const ENTRY_DETAIL_SELECT = Array.from(
  new Set<string>([...ENTRIES_LIST_SELECT_COLUMNS, ...ENTRY_DETAIL_EXTRA_COLUMNS])
).join(', ')

// ----------------------------------------------------------------------------
// Pagination, made sort-aware (hub-refinements-plan.md §1/§2).
//
// The original pagination here was pure keyset ("cursor = last row's id",
// `.lt('id', cursor)`) and it ONLY worked because rows were always ordered
// `id desc` — the id order and the row order were the same thing by
// construction. Click-to-sort breaks that: once rows are ordered by amount,
// date, vendor or status instead of id, "the last id I saw" no longer tells
// you where the next page starts.
//
// Two real fixes exist: (a) a compound keyset cursor `(sortValue, id)` with
// `.lt`/`.gt` on both columns, or (b) offset pagination for the non-default
// sort case. This picks (b) deliberately: a correct compound cursor needs
// per-column nulls handling (nullsFirst vs nullsLast interacting with
// asc/desc) and doubles the comparison logic for marginal benefit at this
// app's documented scale (csv-export.ts: 1,000-10,000 entries total for the
// whole event) — offset pagination's O(offset) cost is negligible there, and
// a stable `id desc` tiebreaker on the secondary sort keeps page boundaries
// deterministic even when many rows share the same sort value (e.g. several
// entries on the same date). `id desc` (the pre-existing default) keeps the
// exact original keyset path unchanged — zero behavior change for anyone who
// never touches a column header.
// ----------------------------------------------------------------------------

/**
 * Opaque "where to resume" token returned by fetchEntriesPage and threaded
 * back in on the next call. Its shape depends on which pagination mode the
 * current sort uses — callers should treat it as opaque and just pass back
 * whatever `nextCursor` they were given.
 */
export type PageCursor = { kind: 'keyset'; lastId: number } | { kind: 'offset'; offset: number } | null

export type FetchPageArgs = {
  supabase: SupabaseClient
  filters: EntriesFilters
  sort: EntriesSort
  cursor: PageCursor // null = first page
  limit: number
}

export type FetchPageResult = {
  rows: EntryEnriched[]
  hasMore: boolean
  /** Pass this back as `cursor` to fetch the page after this one. Null once hasMore is false. */
  nextCursor: PageCursor
  /**
   * Total rows matching the active filters (docs/hub-screen-certification.md
   * §3.1) — carried back in `Content-Range` by `{ count: 'exact' }` on the
   * select, at no extra round trip. `null` if the server didn't return one.
   */
  total: number | null
}

type PaginationPlan =
  | { mode: 'keyset'; ascending: boolean; afterId: number | null }
  | { mode: 'offset'; ascending: boolean; offset: number }

/**
 * Pure decision of which pagination mode + starting point to use, given the
 * active sort and the cursor carried over from the previous page. Split out
 * from fetchEntriesPage so the id-vs-non-id branch (the actual "real fix"
 * from the plan) is unit-testable without a live Supabase client.
 */
export function buildPaginationPlan(sort: EntriesSort, cursor: PageCursor): PaginationPlan {
  if (sort.column === 'id') {
    return {
      mode: 'keyset',
      ascending: sort.direction === 'asc',
      afterId: cursor?.kind === 'keyset' ? cursor.lastId : null,
    }
  }
  return {
    mode: 'offset',
    ascending: sort.direction === 'asc',
    offset: cursor?.kind === 'offset' ? cursor.offset : 0,
  }
}

/**
 * Pure computation of the cursor for "the page after this one", given what
 * was just fetched. Split out for the same testability reason as
 * buildPaginationPlan above.
 */
export function computeNextCursor(args: {
  sort: EntriesSort
  cursor: PageCursor
  pageRows: EntryEnriched[]
  hasMore: boolean
}): PageCursor {
  const { sort, cursor, pageRows, hasMore } = args
  if (!hasMore) return null

  if (sort.column === 'id') {
    const last = pageRows[pageRows.length - 1]
    return last ? { kind: 'keyset', lastId: last.id } : null
  }

  const priorOffset = cursor?.kind === 'offset' ? cursor.offset : 0
  return { kind: 'offset', offset: priorOffset + pageRows.length }
}

export async function fetchEntriesPage({
  supabase,
  filters,
  sort,
  cursor,
  limit,
}: FetchPageArgs): Promise<FetchPageResult> {
  const plan = buildPaginationPlan(sort, cursor)

  // `count: 'exact'` returns the full filtered total in Content-Range
  // alongside the page slice — one request, not two (§3.1).
  // supabase-js's select-string type inference only narrows to a real
  // column-checked builder when the argument is a string *literal* type;
  // ENTRIES_SELECT is built at runtime via `.join()` (deliberately, so it
  // stays derived from ALL_COLUMNS rather than hand-typed per call site --
  // see its own comment above), so TS sees a plain widened `string` and
  // falls back to an unusable `GenericStringError` result type. Same
  // `as unknown as EntriesQueryBuilder` escape fetchAllMatchingIds already
  // uses below for an equivalent reason; the real shape comes from the
  // explicit `as EntryEnriched[]` cast on `rows` a few lines down.
  let query = supabase.from('v_entry_enriched').select(ENTRIES_SELECT, { count: 'exact' }) as unknown as EntriesQueryBuilder
  query = applyEntriesFilters(query, filters)

  if (plan.mode === 'keyset') {
    // Original path, unchanged: pure keyset pagination on id.
    query = query.order('id', { ascending: plan.ascending }).limit(limit + 1)
    if (plan.afterId !== null) {
      query = plan.ascending ? query.gt('id', plan.afterId) : query.lt('id', plan.afterId)
    }
  } else {
    // nullsFirst: false so unassigned/blank sort values (e.g. no vendor, no
    // admin-set status) always sort to the end regardless of direction,
    // rather than flip-flopping to the front on 'asc'.
    query = query
      .order(sort.column, { ascending: plan.ascending, nullsFirst: false })
      .order('id', { ascending: false }) // stable tiebreaker for equal sort values
      .range(plan.offset, plan.offset + limit) // inclusive range -> limit+1 rows, same "fetch one extra" trick
  }

  const { data, error, count } = await query
  if (error) throw error
  const rows = (data ?? []) as EntryEnriched[]
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = computeNextCursor({ sort, cursor, pageRows, hasMore })

  return { rows: pageRows, hasMore, nextCursor, total: count ?? null }
}

/**
 * Fetches only the ids of every row matching the current filters (§3.6 —
 * "select all N matching these filters"). Mirrors the keyset batch loop in
 * csv-export.ts: same `applyEntriesFilters`, `id`-desc order, page through
 * with `.lt('id', cursor)` — but selects `id` alone, so pulling tens of
 * thousands of ids stays cheap.
 */
export async function fetchAllMatchingIds(
  supabase: SupabaseClient,
  filters: EntriesFilters,
  opts?: { batchSize?: number; maxRows?: number }
): Promise<{ ids: number[]; truncated: boolean }> {
  const batchSize = opts?.batchSize ?? 1000
  const maxRows = opts?.maxRows ?? 50000
  const ids: number[] = []
  let cursor: number | null = null
  let truncated = false

  for (;;) {
    // applyEntriesFilters is generic over the default `select('*')` builder
    // shape; narrowing the select to `id` up front trips its constraint, so
    // filter first on a loosely-typed builder, then chain order/limit/lt
    // (all return `this`) and cast the row shape on the way out.
    let query = applyEntriesFilters(
      supabase.from('v_entry_enriched').select('id') as unknown as EntriesQueryBuilder,
      filters
    )
      .order('id', { ascending: false })
      .limit(batchSize)
    if (cursor !== null) query = query.lt('id', cursor)

    const { data, error } = await query
    if (error) throw error
    const rows = (data ?? []) as unknown as { id: number }[]
    if (rows.length === 0) break

    for (const row of rows) ids.push(row.id)
    cursor = rows[rows.length - 1]!.id

    if (rows.length < batchSize) break
    if (ids.length >= maxRows) {
      truncated = true
      break
    }
  }

  return { ids, truncated }
}
