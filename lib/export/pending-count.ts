/**
 * Reusable "how many entries are waiting to be pushed out" query (MASTER-PLAN
 * §5 Navigation: "The Export item carries a badge with the pending-export
 * count, because an unexported status decision is work the modules are
 * still waiting on").
 *
 * Deliberately takes a caller-supplied Supabase client rather than
 * constructing its own — the nav rail (owned by another agent,
 * `components/app-shell/nav-rail.tsx`, not touched here) runs on every
 * page for every signed-in user, so it should call this with the
 * session-bound client (`lib/supabase/server.ts`) and let RLS scope the
 * count to whatever departments that user can see, exactly like every
 * other nav badge would. The /export page itself (admin-only) instead
 * wants the *global* count, so it passes the admin client. Same query,
 * either client — the caller decides the scope.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSelectedEventId } from '@/lib/events/current'

/**
 * Phase 6 Step 2 (docs/event-scoping-and-review-fixes-plan.md §1): the badge
 * should count only the selected event's pending entries, same as every
 * other event-scoped query -- a nav badge showing a stale year's pending
 * count while browsing a different one would be actively misleading. Scoped
 * with the SAME client the caller passed in (session-bound for the nav
 * rail, admin for /export's global count -- see the module doc above), so
 * the active_event_id cookie resolves identically either way.
 */
export async function getPendingExportCount(supabase: SupabaseClient): Promise<number> {
  const eventId = await getSelectedEventId(supabase)

  let query = supabase
    .from('entries')
    .select('id', { count: 'exact', head: true })
    .is('hub_status_exported_at', null)
    .neq('hub_status_id', 1)
    .eq('is_void', false)
  if (eventId !== null) {
    query = query.eq('event_id', eventId)
  }

  const { count, error } = await query

  if (error) {
    throw new Error(`getPendingExportCount: ${error.message}`)
  }
  return count ?? 0
}
