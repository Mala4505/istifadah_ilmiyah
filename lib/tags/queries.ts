/**
 * Server-side loaders for the Tags pages. Every query runs through the caller's own
 * (RLS-bound) Supabase client: a department user only ever gets the tags that touch their
 * departments, and the cost view is security_invoker, so totals only include entries that
 * user may see. Errors come back as plain-English strings via friendlyDataError -- raw text
 * goes to the server log, never to the page.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { friendlyDataError } from '@/lib/friendly-error'
import { getAllEvents } from '@/lib/events/current'
import { getCachedDepartments } from '@/lib/cache/reference-data'
import type { Event } from '@/lib/events/types'
import { TAG_ENTRY_CHUNK, chunk } from '@/lib/tags/entries-shared'
import { fetchAllPages } from '@/lib/tags/paging'
import {
  sortLinkedEntries,
  type DepartmentRef,
  type SubDepartmentRef,
  type TagCostRow,
  type TagEventNoteRow,
  type TagRow,
  type TagScopeRow,
} from '@/lib/tags/shared'

export interface TagReferenceData {
  events: Event[]
  /** Active departments only -- what a picker should offer. */
  departments: DepartmentRef[]
  /** Every department, active or not -- so a retired one still resolves a name. */
  allDepartments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  allSubDepartments: SubDepartmentRef[]
  error: string | null
}

/** Events, departments and sub-departments -- the lookups every Tags screen needs. */
export async function loadTagReferenceData(supabase: SupabaseClient): Promise<TagReferenceData> {
  const [events, departments, subResult] = await Promise.all([
    getAllEvents(),
    getCachedDepartments(supabase),
    supabase.from('sub_department').select('id, name, department_id, is_active').order('name'),
  ])

  const subRows = (subResult.data ?? []) as Array<{
    id: number
    name: string
    department_id: number
    is_active: boolean
  }>
  const allSubDepartments = subRows.map((s) => ({ id: s.id, name: s.name, departmentId: s.department_id }))

  return {
    events,
    departments: departments.filter((d) => d.is_active).map((d) => ({ id: d.id, name: d.name })),
    allDepartments: departments.map((d) => ({ id: d.id, name: d.name })),
    subDepartments: subRows
      .filter((s) => s.is_active)
      .map((s) => ({ id: s.id, name: s.name, departmentId: s.department_id })),
    allSubDepartments,
    error: friendlyDataError(subResult.error, 'tags.loadReferenceData'),
  }
}

export interface TagListData {
  tags: TagRow[]
  scope: TagScopeRow[]
  costs: TagCostRow[]
  /** Notes for the selected event only, keyed by tag id. */
  notesByTag: Map<number, string>
  error: string | null
}

const TAG_COLUMNS = 'id, name, description, start_event_id, end_event_id, created_at, updated_at'
const SCOPE_COLUMNS = 'id, tag_id, department_id, sub_department_id, source'

/** The tags active in `eventId`, with their scope, per-event cost and that event's note. */
export async function loadTagsActiveInEvent(supabase: SupabaseClient, eventId: number): Promise<TagListData> {
  const empty = (error: string | null): TagListData => ({
    tags: [],
    scope: [],
    costs: [],
    notesByTag: new Map(),
    error,
  })

  const { data, error } = await supabase.rpc('tags_active_in_event', { p_event_id: eventId })
  const tagsError = friendlyDataError(error, 'tags.activeInEvent')
  if (tagsError) return empty(tagsError)

  const tags = ((data ?? []) as TagRow[]).slice().sort((a, b) => a.name.localeCompare(b.name))
  if (tags.length === 0) return empty(null)
  const tagIds = tags.map((t) => t.id)

  const [scopeResult, costResult, noteResult] = await Promise.all([
    supabase.from('tag_scope').select(SCOPE_COLUMNS).in('tag_id', tagIds),
    supabase.from('tag_cost_by_event').select('tag_id, event_id, cost, entry_count, voided_count').in('tag_id', tagIds),
    supabase.from('tag_event_note').select('tag_id, event_id, note').in('tag_id', tagIds).eq('event_id', eventId),
  ])

  const notesByTag = new Map<number, string>()
  for (const row of (noteResult.data ?? []) as TagEventNoteRow[]) notesByTag.set(row.tag_id, row.note)

  return {
    tags,
    scope: (scopeResult.data ?? []) as TagScopeRow[],
    costs: ((costResult.data ?? []) as TagCostRow[]).map(normaliseCost),
    notesByTag,
    error:
      friendlyDataError(scopeResult.error, 'tags.scope') ??
      friendlyDataError(costResult.error, 'tags.cost') ??
      friendlyDataError(noteResult.error, 'tags.notes'),
  }
}

/** A linked entry as the tag detail page shows it (v_entry_enriched columns). */
export interface LinkedEntry {
  id: number
  ubbl_number: string
  event_id: number
  date: string | null
  amount: number | null
  is_void: boolean
  void_note: string | null
  department_id: number | null
  department_name: string | null
  sub_department_id: number | null
  sub_department_name: string | null
  vendor_display_name: string | null
  vendor_raw: string | null
  status_label: string | null
}

export const LINKED_ENTRY_COLUMNS =
  'id, ubbl_number, event_id, date, amount, is_void, void_note, department_id, department_name, sub_department_id, sub_department_name, vendor_display_name, vendor_raw, status_label'

export interface TagDetailData {
  tag: TagRow | null
  scope: TagScopeRow[]
  costs: TagCostRow[]
  notes: TagEventNoteRow[]
  entries: LinkedEntry[]
  /** Links this user cannot see the entry for (entries RLS) -- counted, never listed. */
  hiddenEntryCount: number
  error: string | null
}

export async function loadTagDetail(supabase: SupabaseClient, tagId: number): Promise<TagDetailData> {
  const empty = (error: string | null, tag: TagRow | null = null): TagDetailData => ({
    tag,
    scope: [],
    costs: [],
    notes: [],
    entries: [],
    hiddenEntryCount: 0,
    error,
  })

  const [tagResult, scopeResult, costResult, noteResult, linkResult] = await Promise.all([
    supabase.from('tag').select(TAG_COLUMNS).eq('id', tagId).maybeSingle(),
    supabase.from('tag_scope').select(SCOPE_COLUMNS).eq('tag_id', tagId),
    supabase.from('tag_cost_by_event').select('tag_id, event_id, cost, entry_count, voided_count').eq('tag_id', tagId),
    supabase.from('tag_event_note').select('tag_id, event_id, note').eq('tag_id', tagId),
    // Paged: PostgREST stops at 1,000 rows, and a tag can be linked to more entries than that.
    fetchAllPages<{ entry_id: number }>(
      (from, to) =>
        supabase
          .from('tag_entry')
          .select('entry_id')
          .eq('tag_id', tagId)
          .order('entry_id')
          .range(from, to) as unknown as PromiseLike<{ data: Array<{ entry_id: number }> | null; error: { message: string } | null }>
    ),
  ])

  const tagError = friendlyDataError(tagResult.error, 'tags.detail')
  if (tagError) return empty(tagError)
  const tag = (tagResult.data as TagRow | null) ?? null
  if (!tag) return empty(null)

  const entryIds = linkResult.data.map((r) => r.entry_id)
  let entries: LinkedEntry[] = []
  let entriesError: string | null = null
  if (entryIds.length > 0) {
    // Looked up in chunks (short `in.(...)` URLs, never near the row cap) and put back in
    // display order in code.
    const results = await Promise.all(
      chunk(entryIds, TAG_ENTRY_CHUNK).map((ids) =>
        supabase.from('v_entry_enriched').select(LINKED_ENTRY_COLUMNS).in('id', ids)
      )
    )
    entriesError = results.map((r) => friendlyDataError(r.error, 'tags.detail.entries')).find((e) => e !== null) ?? null
    entries = sortLinkedEntries(results.flatMap((r) => (r.data ?? []) as unknown as LinkedEntry[]))
  }

  return {
    tag,
    scope: (scopeResult.data ?? []) as TagScopeRow[],
    costs: ((costResult.data ?? []) as TagCostRow[]).map(normaliseCost),
    notes: (noteResult.data ?? []) as TagEventNoteRow[],
    entries,
    hiddenEntryCount: Math.max(0, entryIds.length - entries.length),
    error:
      entriesError ??
      friendlyDataError(scopeResult.error, 'tags.detail.scope') ??
      friendlyDataError(costResult.error, 'tags.detail.cost') ??
      friendlyDataError(noteResult.error, 'tags.detail.notes') ??
      friendlyDataError(linkResult.error, 'tags.detail.links'),
  }
}

/** PostgREST returns numeric/bigint as JSON numbers, but coerce anyway so arithmetic is safe. */
function normaliseCost(row: TagCostRow): TagCostRow {
  return {
    ...row,
    cost: Number(row.cost) || 0,
    entry_count: Number(row.entry_count) || 0,
    voided_count: Number(row.voided_count) || 0,
  }
}
