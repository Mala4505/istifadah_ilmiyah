'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

// Shared server action for setting the Hub-owned status (MASTER-PLAN §3.3,
// §3.9, §5 rows 3 & 4). Used by the bulk toolbar on the entries list
// (components/entries/bulk-status-dialog.tsx) AND by the single-entry
// control on the entry detail screen (app/(app)/entries/[id]/page.tsx,
// owned by another agent) — this is the ONE place hub_status_id is ever
// written from the app, so both screens share identical behaviour.
//
// What this does NOT do, deliberately:
//   - Does not set hub_status_changed_at / hub_status_changed_by. The
//     `entries_before_update` trigger (20260808000017) stamps those
//     server-side whenever hub_status_id changes, and also writes the
//     entry_change_log row. Setting them here would just be overwritten/
//     duplicated by the trigger's own now()/auth.uid() — the trigger is the
//     single source of truth for "when" and "who".
//   - Does not check role client-side. RLS's `entries_update` policy
//     (viewer cannot update; department must match) is the actual
//     enforcement — this action lets a denied update come back as "0 of N
//     updated" rather than trying to duplicate the authorization logic here.
export type SetHubStatusInput = {
  entryIds: number[]
  hubStatusCode: string
  note: string
}

export type SetHubStatusResult =
  | { success: true; updatedCount: number; requestedCount: number }
  | { success: false; error: string }

export async function setHubStatus({
  entryIds,
  hubStatusCode,
  note,
}: SetHubStatusInput): Promise<SetHubStatusResult> {
  const ids = Array.from(new Set(entryIds)).filter((id) => Number.isFinite(id))
  const trimmedNote = note?.trim() ?? ''

  if (ids.length === 0) {
    return { success: false, error: 'No entries selected.' }
  }
  if (!hubStatusCode) {
    return { success: false, error: 'A Hub status is required.' }
  }
  if (!trimmedNote) {
    return { success: false, error: 'A note is required for every Hub-status change.' }
  }

  const supabase = await createClient()

  const { data: hubStatus, error: hubStatusError } = await supabase
    .from('hub_status')
    .select('id')
    .eq('code', hubStatusCode)
    .maybeSingle()

  if (hubStatusError) {
    return { success: false, error: `Could not resolve Hub status "${hubStatusCode}": ${hubStatusError.message}` }
  }
  if (!hubStatus) {
    return { success: false, error: `Unknown Hub status code "${hubStatusCode}".` }
  }

  // `hub_status_exported_at` resets to null so a re-status after a prior
  // export puts the entry back in the /export pending queue (§3.7 "Re-export
  // is explicit, not automatic").
  const { data, error: updateError } = await supabase
    .from('entries')
    .update({
      hub_status_id: hubStatus.id,
      hub_status_note: trimmedNote,
      hub_status_exported_at: null,
    })
    .in('id', ids)
    .select('id')

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  const updatedCount = data?.length ?? 0

  revalidatePath('/entries')
  if (updatedCount === 1 && ids.length === 1) {
    revalidatePath(`/entries/${ids[0]}`)
  }

  return { success: true, updatedCount, requestedCount: ids.length }
}
