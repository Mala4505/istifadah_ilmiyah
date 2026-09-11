/**
 * Prior-period comparison (blueprint §6 fix #1). Split out of
 * lib/reports/sections/shared.tsx because this is the one helper that
 * genuinely needs server-only `getAllEvents` (cookies()/Supabase) --
 * shared.tsx is imported by client components (e.g.
 * components/reports/sections/department-budget-explorer-client.tsx) and
 * can't carry a next/headers reach through this function.
 */
import { getAllEvents } from '@/lib/events/current'
import type { CompareBasis } from '@/lib/reports/compare-basis-labels'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The event immediately older than `currentEventId`, or null when the basis
 * isn't 'prior_event', there's no active event, or the current event is the
 * oldest on record. Surface loaders call this before deciding whether to
 * issue their prior-period query round.
 */
export async function resolvePreviousEvent(
  supabase: SupabaseClient,
  compareBasis: CompareBasis,
  currentEventId: number | null
): Promise<{ id: number; name: string } | null> {
  if (compareBasis !== 'prior_event' || currentEventId === null) return null
  const events = await getAllEvents() // most-recent Hijri year first
  const idx = events.findIndex((e) => e.id === currentEventId)
  if (idx === -1) return null
  const previous = events[idx + 1] ?? null
  return previous ? { id: previous.id, name: previous.name } : null
}
