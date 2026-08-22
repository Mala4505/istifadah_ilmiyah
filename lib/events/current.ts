/**
 * Active-event resolution (Phase 6 Step 1,
 * docs/event-scoping-and-review-fixes-plan.md §1.3). Mirrors the
 * `review_queue_scope` cookie precedent (lib/actions/review.ts's
 * `setReviewQueueScope`, app/(app)/review/page.tsx:77): a cookie, read
 * server-side, defaulting to the database's `is_current` event when unset.
 *
 * Event scoping is a visibility concern, not a security one (doc §1.3) --
 * these helpers back application-level query filtering only. RLS stays
 * exactly as department-based as it is today.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Event } from '@/lib/events/types'

export const ACTIVE_EVENT_COOKIE = 'active_event_id'

interface EventRow {
  id: number
  name: string
  hijri_year: string
  starts_on: string | null
  ends_on: string | null
  is_current: boolean
  created_at: string
}

function mapEventRow(row: EventRow): Event {
  return {
    id: row.id,
    name: row.name,
    hijriYear: row.hijri_year,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    isCurrent: row.is_current,
    createdAt: row.created_at,
  }
}

/** The event where `is_current` is true. Null only if none exists, which
 *  should never happen once the Phase 6 backfill has run. */
export async function getCurrentEvent(supabase: SupabaseClient): Promise<Event | null> {
  const { data } = await supabase.from('event').select('*').eq('is_current', true).maybeSingle()
  return data ? mapEventRow(data as EventRow) : null
}

/** Reads the `active_event_id` cookie; falls back to the current event's id
 *  when the cookie is unset, unparsable, or points at a deleted event. */
export async function getSelectedEventId(supabase: SupabaseClient): Promise<number | null> {
  const cookieStore = await cookies()
  const raw = cookieStore.get(ACTIVE_EVENT_COOKIE)?.value
  const parsed = raw ? Number(raw) : NaN

  if (Number.isFinite(parsed)) {
    const { data } = await supabase.from('event').select('id').eq('id', parsed).maybeSingle()
    if (data) return data.id as number
  }

  const current = await getCurrentEvent(supabase)
  return current?.id ?? null
}

/** The full row for whichever event is currently selected (cookie, or the
 *  current event by default). Null only if the resolved id has no row. */
export async function getSelectedEvent(supabase: SupabaseClient): Promise<Event | null> {
  const selectedId = await getSelectedEventId(supabase)
  if (selectedId === null) return null

  const { data } = await supabase.from('event').select('*').eq('id', selectedId).maybeSingle()
  return data ? mapEventRow(data as EventRow) : null
}

/** All events, most recent Hijri year first -- for the switcher and the
 *  /events read-only history list. */
export async function getAllEvents(supabase: SupabaseClient): Promise<Event[]> {
  const { data } = await supabase.from('event').select('*').order('hijri_year', { ascending: false })
  return (data ?? []).map((row) => mapEventRow(row as EventRow))
}

/** True only for the current event. Past events are browsable read-only
 *  (doc §1.6) -- no new uploads, no verification, no export. Later streams
 *  gate their mutations on this before writing. */
export function isEventMutable(event: Event | null): boolean {
  return event?.isCurrent === true
}
