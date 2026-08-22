'use server'

import { createClient } from '@/lib/supabase/server'
import { getSelectedEventId } from '@/lib/events/current'

/**
 * Attach-time zone/admin-head pre-fill (import-review-ux-checklist.md 5.11,
 * import-review-ux-plan.md §8 Z2): when a reviewer is about to attach a
 * document to an entry that has neither `admin_head_id` nor `zone_id` set,
 * this looks up the most recent OTHER entry for the same vendor and
 * department that already carries one of those two fields, so the two
 * dropdowns in the attach confirmation can open pre-filled instead of blank.
 *
 * Read-only and best-effort: kept separate from lib/actions/documents.ts so
 * that file doesn't keep growing with concerns beyond the inbox's own
 * attach/park/search actions. Any active staff can call it — like
 * searchEntriesForAttach, this only reads; the actual write goes through
 * setEntryClassification (lib/actions/entry-enrichment.ts), which is gated.
 *
 * Returns null on a miss (no vendor/department to match on, or no matching
 * entry carries a classification yet) rather than an error — a missed
 * pre-fill just means the dropdowns open blank, which is the normal
 * "skipping is free" path, not a failure.
 */
export async function getRecentClassificationDefaults(
  vendorRaw: string | null,
  departmentId: number | null
): Promise<{ adminHeadId: number | null; zoneId: number | null } | null> {
  const trimmedVendor = vendorRaw?.trim()
  if (!trimmedVendor || departmentId === null) {
    return null
  }

  const supabase = await createClient()

  // Phase 6 Step 2 (docs/event-scoping-and-review-fixes-plan.md §1): scoped
  // to the currently-selected event so a pre-fill never reaches back into a
  // previous year's classification -- the whole point of "clean slate" per
  // event (§1.1). Falls back to unscoped only if no event can be resolved
  // at all, which should never happen once the Phase 6 backfill has run.
  const selectedEventId = await getSelectedEventId(supabase)

  let query = supabase
    .from('entries')
    .select('admin_head_id, zone_id')
    .eq('vendor_raw', trimmedVendor)
    .eq('department_id', departmentId)
    .eq('is_void', false)
    .or('admin_head_id.not.is.null,zone_id.not.is.null')
    .order('date', { ascending: false })
    .limit(1)

  if (selectedEventId !== null) {
    query = query.eq('event_id', selectedEventId)
  }

  const { data, error } = await query.maybeSingle()

  if (error || !data) {
    return null
  }

  return { adminHeadId: data.admin_head_id, zoneId: data.zone_id }
}
