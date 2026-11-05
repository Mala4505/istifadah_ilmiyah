/**
 * Server-side read for the review screen's tag notice (docs/entry-tags-plan.md, Phase 4).
 *
 * One round trip: every query below depends only on the arguments, so they all run in a
 * single Promise.all, and app/(app)/review/page.tsx fires this inside its existing Tier 2
 * batch -- no new serial hop on the review page (docs/performance-remediation-plan.md).
 * Each query is bounded by an indexed filter (tag_scope.department_id, tag_entry.entry_id,
 * tag_event_note.event_id) -- no per-row lookups, however many entries the bill has.
 *
 * Runs through the caller's own RLS-bound client: an admin only ever sees tags that touch
 * departments they can see. Errors come back as plain English via friendlyDataError.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { friendlyDataError } from '@/lib/friendly-error'
import { getAllEvents } from '@/lib/events/current'
import type { TagRow } from '@/lib/tags/shared'
import {
  buildReviewTagRows,
  distinctEntryDepartments,
  type ReviewNoticeEntry,
  type ReviewTagNoticeData,
  type ReviewTagScopeInput,
} from '@/lib/tags/review-shared'

type ScopeRowWithName = {
  tag_id: number
  department_id: number
  sub_department_id: number | null
  sub_department: { name: string } | { name: string }[] | null
}

/**
 * The tags active in `eventId` that touch ANY department of the bill's linked entries, with
 * the current event's note and which of the bill's entries are already linked to each. One
 * call per bill, not per entry: the department and entry filters are `in (...)` lists.
 * Returns null when there is nothing to look up (no event selected, no linked entry, or none
 * of them has a department) -- the notice then never renders.
 */
export async function loadReviewTagNotice(
  supabase: SupabaseClient,
  input: {
    eventId: number | null
    entries: readonly ReviewNoticeEntry[]
    departmentName: (id: number) => string | null
  }
): Promise<ReviewTagNoticeData | null> {
  const { eventId, entries } = input
  if (eventId === null || entries.length === 0) return null
  const departments = distinctEntryDepartments(entries, input.departmentName)
  if (departments.length === 0) return null
  const entryIds = entries.map((e) => e.entryId)
  const base = { departments, entries: [...entries] }

  const [activeResult, scopeResult, linkResult, noteResult, events] = await Promise.all([
    supabase.rpc('tags_active_in_event', { p_event_id: eventId }),
    supabase
      .from('tag_scope')
      .select('tag_id, department_id, sub_department_id, sub_department(name)')
      .in(
        'department_id',
        departments.map((d) => d.id)
      ),
    supabase.from('tag_entry').select('tag_id, entry_id').in('entry_id', entryIds),
    supabase.from('tag_event_note').select('tag_id, note').eq('event_id', eventId),
    getAllEvents(),
  ])

  const error =
    friendlyDataError(activeResult.error, 'review.tags.active') ??
    friendlyDataError(scopeResult.error, 'review.tags.scope') ??
    friendlyDataError(linkResult.error, 'review.tags.links') ??
    friendlyDataError(noteResult.error, 'review.tags.notes')
  if (error) return { ...base, rows: [], error }

  const scope: ReviewTagScopeInput[] = ((scopeResult.data ?? []) as unknown as ScopeRowWithName[]).map((r) => {
    const sub = Array.isArray(r.sub_department) ? r.sub_department[0] ?? null : r.sub_department
    return {
      tag_id: r.tag_id,
      department_id: r.department_id,
      sub_department_id: r.sub_department_id,
      sub_department_name: sub?.name ?? null,
    }
  })

  const rows = buildReviewTagRows({
    departments,
    activeTags: (activeResult.data ?? []) as TagRow[],
    scope,
    notes: (noteResult.data ?? []) as Array<{ tag_id: number; note: string }>,
    links: (linkResult.data ?? []) as Array<{ tag_id: number; entry_id: number }>,
    events,
  })

  return { ...base, rows, error: null }
}
