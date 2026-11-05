/**
 * Server-side reads for the Entries screens' tag features (docs/entry-tags-plan.md, Phase 3).
 * Everything runs through the caller's own RLS-bound client, so a department user only ever
 * sees tags that touch their departments. These reads are secondary to the screen they sit
 * on: a failure comes back as a plain-English string (friendlyDataError) and the caller
 * decides how loud to be -- the entries list never fails because tags could not load.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { friendlyDataError } from '@/lib/friendly-error'
import { getAllEvents } from '@/lib/events/current'
import { getCachedDepartments } from '@/lib/cache/reference-data'
import { loadTagReferenceData } from '@/lib/tags/queries'
import {
  TAG_ENTRY_CHUNK,
  buildEarlierTagNotices,
  chunk,
  defaultScopeFromEntries,
  defaultStartEventId,
  type AddToTagOptions,
  type EarlierTagSummary,
  type TagNoticeGroup,
  type TagOption,
} from '@/lib/tags/entries-shared'
import { fetchAllPages, type PageResult } from '@/lib/tags/paging'
import { groupByKey, tagPeriodLabel, type TagRow } from '@/lib/tags/shared'

const TAG_COLUMNS = 'id, name, description, start_event_id, end_event_id, created_at, updated_at'

// ---- Tags from earlier years, active in the selected event ------------------------------

export interface EarlierTagsResult {
  tags: EarlierTagSummary[]
  error: string | null
}

/**
 * The tags active in `eventId` that started in an EARLIER event, with the departments they
 * cover. A tag started in this very event is not "from earlier years", so it is left out.
 */
export async function loadEarlierTagSummaries(
  supabase: SupabaseClient,
  eventId: number | null
): Promise<EarlierTagsResult> {
  if (eventId === null) return { tags: [], error: null }

  const [activeResult, events] = await Promise.all([
    supabase.rpc('tags_active_in_event', { p_event_id: eventId }),
    getAllEvents(),
  ])
  const activeError = friendlyDataError(activeResult.error, 'entries.tags.active')
  if (activeError) return { tags: [], error: activeError }

  const earlier = ((activeResult.data ?? []) as TagRow[]).filter((t) => t.start_event_id !== eventId)
  if (earlier.length === 0) return { tags: [], error: null }

  const { data, error } = await supabase
    .from('tag_scope')
    .select('tag_id, department_id')
    .in('tag_id', earlier.map((t) => t.id))
  const scopeError = friendlyDataError(error, 'entries.tags.scope')
  if (scopeError) return { tags: [], error: scopeError }

  const departmentsByTag = groupByKey((data ?? []) as Array<{ tag_id: number; department_id: number }>, (r) => r.tag_id)
  const eventById = new Map(events.map((e) => [e.id, e]))

  return {
    tags: earlier.map((t): EarlierTagSummary => ({
      id: t.id,
      name: t.name,
      startEventId: t.start_event_id,
      endEventId: t.end_event_id,
      periodLabel: tagPeriodLabel(
        eventById.get(t.start_event_id),
        t.end_event_id === null ? null : eventById.get(t.end_event_id)
      ),
      departmentIds: [...new Set((departmentsByTag.get(t.id) ?? []).map((r) => r.department_id))],
    })),
    error: null,
  }
}

// ---- One entry's tag section ------------------------------------------------------------

export interface EntryTagRow {
  id: number
  name: string
  description: string | null
  periodLabel: string
  departmentNames: string[]
}

export interface EntryTagSection {
  /** The tags this entry belongs to (RLS decides which the viewer may see). */
  tags: EntryTagRow[]
  /** Earlier-year tags on this entry's department that it is not already linked to. */
  notices: TagNoticeGroup[]
  error: string | null
}

/** Everything the entry detail page's tag section shows, in one parallel round of reads. */
export async function loadEntryTagSection(
  supabase: SupabaseClient,
  input: {
    entryId: number
    departmentId: number | null
    departmentName: string | null
    selectedEventId: number | null
  }
): Promise<EntryTagSection> {
  const { entryId, departmentId, departmentName, selectedEventId } = input

  const [linkResult, earlier] = await Promise.all([
    supabase.from('tag_entry').select('tag_id').eq('entry_id', entryId),
    loadEarlierTagSummaries(supabase, selectedEventId),
  ])
  const linkError = friendlyDataError(linkResult.error, 'entries.tags.links')
  const tagIds = ((linkResult.data ?? []) as Array<{ tag_id: number }>).map((r) => r.tag_id)

  let tags: EntryTagRow[] = []
  let detailError: string | null = null
  if (!linkError && tagIds.length > 0) {
    const [tagResult, scopeResult, events, departments] = await Promise.all([
      supabase.from('tag').select(TAG_COLUMNS).in('id', tagIds),
      supabase.from('tag_scope').select('tag_id, department_id').in('tag_id', tagIds),
      getAllEvents(),
      getCachedDepartments(supabase),
    ])
    detailError =
      friendlyDataError(tagResult.error, 'entries.tags.detail') ??
      friendlyDataError(scopeResult.error, 'entries.tags.detail.scope')
    const eventById = new Map(events.map((e) => [e.id, e]))
    const departmentNameById = new Map(departments.map((d) => [d.id, d.name]))
    const scopeByTag = groupByKey((scopeResult.data ?? []) as Array<{ tag_id: number; department_id: number }>, (r) => r.tag_id)
    tags = ((tagResult.data ?? []) as TagRow[])
      .map((t): EntryTagRow => ({
        id: t.id,
        name: t.name,
        description: t.description,
        periodLabel: tagPeriodLabel(
          eventById.get(t.start_event_id),
          t.end_event_id === null ? null : eventById.get(t.end_event_id)
        ),
        departmentNames: [...new Set((scopeByTag.get(t.id) ?? []).map((r) => departmentNameById.get(r.department_id) ?? 'Unknown'))].sort(
          (a, b) => a.localeCompare(b)
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const notices =
    departmentId !== null && departmentName
      ? buildEarlierTagNotices(earlier.tags, [{ id: departmentId, name: departmentName }], new Set(tagIds))
      : []

  return { tags, notices, error: linkError ?? detailError ?? earlier.error }
}

// ---- Add-to-tag dialog options ----------------------------------------------------------

export type AddToTagOptionsResult = { ok: true; options: AddToTagOptions } | { ok: false; error: string }

/**
 * Loaded when the Add-to-tag dialog opens (super-admin only -- the calling action gates it):
 * events, departments, the tags that exist, and the defaults derived from the entries being
 * tagged (their departments, and the oldest of their events).
 */
export async function loadAddToTagOptions(
  supabase: SupabaseClient,
  entryIds: readonly number[],
  selectedEventId: number | null
): Promise<AddToTagOptionsResult> {
  const [reference, tagResult, scopeResult, events, ...entryResults] = await Promise.all([
    loadTagReferenceData(supabase),
    // Both paged: PostgREST stops at 1,000 rows, and the scope table has several rows per tag.
    // Ordered by the primary key so the pages neither overlap nor skip.
    fetchAllPages<TagRow>((from, to) =>
      supabase.from('tag').select(TAG_COLUMNS).order('id').range(from, to) as unknown as PromiseLike<PageResult<TagRow>>
    ),
    fetchAllPages<{ tag_id: number; department_id: number }>(
      (from, to) =>
        supabase.from('tag_scope').select('tag_id, department_id').order('id').range(from, to) as unknown as PromiseLike<
          PageResult<{ tag_id: number; department_id: number }>
        >
    ),
    getAllEvents(),
    ...chunk(entryIds, TAG_ENTRY_CHUNK).map((ids) =>
      supabase.from('v_entry_enriched').select('id, event_id, department_id').in('id', ids)
    ),
  ])

  const error =
    reference.error ??
    friendlyDataError(tagResult.error, 'entries.tags.options.tags') ??
    friendlyDataError(scopeResult.error, 'entries.tags.options.scope') ??
    entryResults.map((r) => friendlyDataError(r.error, 'entries.tags.options.entries')).find((e) => e !== null) ??
    null
  if (error) return { ok: false, error }

  const entries = entryResults.flatMap(
    (r) => (r.data ?? []) as Array<{ id: number; event_id: number; department_id: number | null }>
  )
  const eventById = new Map(events.map((e) => [e.id, e]))
  const scopeByTag = groupByKey(scopeResult.data, (r) => r.tag_id)

  const tags = tagResult.data.map((t): TagOption => ({
    id: t.id,
    name: t.name,
    description: t.description,
    periodLabel: tagPeriodLabel(
      eventById.get(t.start_event_id),
      t.end_event_id === null ? null : eventById.get(t.end_event_id)
    ),
    departmentIds: [...new Set((scopeByTag.get(t.id) ?? []).map((r) => r.department_id))],
  }))
  tags.sort((a, b) => a.name.localeCompare(b.name))

  return {
    ok: true,
    options: {
      events,
      departments: reference.departments,
      subDepartments: reference.subDepartments,
      tags,
      selectedEventId,
      defaultScope: defaultScopeFromEntries(entries),
      defaultStartEventId: defaultStartEventId(
        entries.map((e) => e.event_id),
        events,
        selectedEventId
      ),
      entryCount: entries.length,
    },
  }
}
