'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

/**
 * Sets the Hub-owned status (§3.3, §3.7) on one or more entries. Shared by
 * the entries list bulk action and the entry detail single-entry control —
 * one code path so both stay consistent with the same rules:
 *
 * - A note is required. "Resolved with no reason is not an audit trail"
 *   (§5) applies just as much to a status change as to an exception.
 * - `hub_status_exported_at` resets to null on every status change, so a
 *   re-changed entry re-enters the export queue automatically (§3.7 —
 *   "re-export is explicit, the reset that puts it back in the queue is
 *   not").
 * - RLS (entries_update, §4.2) already restricts this to admin/reviewer
 *   roles and the caller's department; this action does not duplicate that
 *   check, it relies on the database to enforce it and surfaces the error
 *   if RLS rejects the write.
 * - `entries_before_update` (§3.9) stamps hub_status_changed_at/_by and
 *   writes entry_change_log automatically — this action never sets those
 *   columns directly.
 */
export async function setHubStatus(input: {
  entryIds: number[]
  hubStatusCode: string
  note: string
}): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  const { entryIds, hubStatusCode, note } = input

  if (entryIds.length === 0) {
    return { ok: false, error: 'No entries selected.' }
  }
  if (note.trim() === '') {
    return { ok: false, error: 'A note is required when changing Hub status.' }
  }

  const supabase = await createClient()

  const { data: statusRow, error: statusError } = await supabase
    .from('hub_status')
    .select('id')
    .eq('code', hubStatusCode)
    .single()

  if (statusError || !statusRow) {
    return { ok: false, error: `Unknown Hub status code: ${hubStatusCode}` }
  }

  const { data, error } = await supabase
    .from('entries')
    .update({
      hub_status_id: statusRow.id,
      hub_status_note: note.trim(),
      hub_status_exported_at: null,
    })
    .in('id', entryIds)
    .select('id')

  if (error) {
    return { ok: false, error: error.message }
  }

  revalidatePath('/entries')
  revalidatePath('/export')
  for (const id of entryIds) {
    revalidatePath(`/entries/${id}`)
  }

  return { ok: true, updated: data?.length ?? 0 }
}
