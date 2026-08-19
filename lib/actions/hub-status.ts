'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'

export interface SetHubStatusInput {
  entryIds: number[]
  hubStatusCode: string
  note: string
}

export interface SetHubStatusResult {
  success: boolean
  updatedCount: number
  requestedCount: number
  error?: string
}

/**
 * Single source of truth for changing `entries.hub_status_id` (MASTER-PLAN
 * §3.3, §3.7, §4.4c). Shared by the entries-list bulk action
 * (components/entries/bulk-status-dialog.tsx) AND the entry-detail
 * single-entry control (components/entries/detail/hub-status-section.tsx) —
 * one code path, so a status-change rule only ever needs to change in one
 * place. Call with a one-element `entryIds` array for a single entry.
 *
 * - A note is required. "Resolved with no reason is not an audit trail"
 *   (§5) applies just as much to a status change as to an exception.
 * - Runs on the session-bound client (`lib/supabase/server.ts`), so RLS
 *   (`entries_update`: private.is_admin_or_above(), department-scoped via
 *   can_see_department()) is the actual gate — not this function. A `dept`
 *   role has no UPDATE access at all now, regardless of department (admin
 *   and superadmin always satisfy can_see_department(), since that helper
 *   treats admin-or-above as seeing every department): Postgres RLS silently
 *   excludes rows that fail the policy's USING clause rather than raising
 *   an error. This function turns that silent exclusion into an explicit
 *   `error` string for the caller to toast, and reports partial success
 *   (`updatedCount < requestedCount`) via `error` even when `success` is
 *   true, so a bulk change across departments doesn't read as a silent
 *   full success.
 * - `hub_status_exported_at` resets to null on every status change, so a
 *   re-changed entry re-enters the export queue automatically (§3.7 —
 *   "re-export is explicit, the reset that puts it back in the queue is
 *   not").
 * - `entries_before_update` (§3.9) stamps hub_status_changed_at/_by and
 *   writes entry_change_log automatically — this action never sets those
 *   columns directly.
 */
export async function setHubStatus({
  entryIds,
  hubStatusCode,
  note,
}: SetHubStatusInput): Promise<SetHubStatusResult> {
  const cleanIds = Array.from(new Set(entryIds)).filter((id) => Number.isInteger(id) && id > 0)
  const cleanNote = note.trim()
  const requestedCount = cleanIds.length

  if (requestedCount === 0) {
    return { success: false, updatedCount: 0, requestedCount, error: 'No entries selected.' }
  }
  if (!hubStatusCode) {
    return { success: false, updatedCount: 0, requestedCount, error: 'A Hub status must be selected.' }
  }
  if (!cleanNote) {
    return { success: false, updatedCount: 0, requestedCount, error: 'A note is required to change Hub status.' }
  }

  const supabase = await createClient()

  const { data: statusRow, error: statusError } = await supabase
    .from('hub_status')
    .select('id')
    .eq('code', hubStatusCode)
    .maybeSingle()

  if (statusError) {
    return {
      success: false,
      updatedCount: 0,
      requestedCount,
      error: `Could not resolve Hub status: ${statusError.message}`,
    }
  }
  if (!statusRow) {
    return {
      success: false,
      updatedCount: 0,
      requestedCount,
      error: `Unknown Hub status code "${hubStatusCode}".`,
    }
  }

  const { data, error } = await supabase
    .from('entries')
    .update({
      hub_status_id: statusRow.id,
      hub_status_note: cleanNote,
      hub_status_exported_at: null,
    })
    .in('id', cleanIds)
    .select('id')

  if (error) {
    return { success: false, updatedCount: 0, requestedCount, error: logRawError('hub-status.setHubStatus', error.message) }
  }

  const updatedCount = data?.length ?? 0

  if (updatedCount === 0) {
    return {
      success: false,
      updatedCount: 0,
      requestedCount,
      error:
        'No entries were updated. This usually means a dept role (admin or above is required to set Hub status), or the entry is outside your assigned department.',
    }
  }

  for (const id of cleanIds) {
    revalidatePath(`/entries/${id}`)
  }
  revalidatePath('/entries')
  revalidatePath('/export')

  if (updatedCount < requestedCount) {
    return {
      success: true,
      updatedCount,
      requestedCount,
      error: `${requestedCount - updatedCount} of ${requestedCount} selected entries could not be updated (permission or department scope).`,
    }
  }

  return { success: true, updatedCount, requestedCount }
}
