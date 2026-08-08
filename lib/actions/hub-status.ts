'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export interface SetHubStatusInput {
  entryIds: number[]
  hubStatusCode: string
  note: string
}

export interface SetHubStatusResult {
  success: boolean
  updatedCount: number
  error?: string
}

/**
 * Single source of truth for changing `entries.hub_status_id` (MASTER-PLAN
 * §3.3, §3.7, §4.4c). Used by the entry-detail single-entry status control
 * AND the entries-list bulk status action — one code path, so a status-
 * change rule only ever needs to change in one place. Call with a
 * one-element `entryIds` array for a single entry.
 *
 * Runs on the session-bound client (`lib/supabase/server.ts`), so RLS
 * (`entries_update`: role in ('admin','reviewer'), department-scoped,
 * 20260808000026_rls_policies.sql) is the actual gate — not this function.
 * A `viewer`, or a reviewer outside the entry's department, simply updates
 * 0 rows: Postgres RLS silently excludes rows that fail the policy's USING
 * clause rather than raising an error. This function turns that silent
 * exclusion into an explicit `error` string for the caller to toast.
 *
 * Also resets `hub_status_exported_at` to null on every call so a re-set
 * status re-enters the export queue (§3.7: "If someone changes a status
 * again after export, hub_status_exported_at resets to null and the entry
 * re-enters the queue"). The `entries_before_update` trigger
 * (20260808000017_entry_change_log_and_triggers.sql) independently stamps
 * `hub_status_changed_at` / `hub_status_changed_by` and writes the general
 * `entry_change_log` diff whenever `hub_status_id` changes — this function
 * does not duplicate that logic, only supplies the new values.
 */
export async function setHubStatus({
  entryIds,
  hubStatusCode,
  note,
}: SetHubStatusInput): Promise<SetHubStatusResult> {
  const cleanIds = Array.from(new Set(entryIds)).filter(
    (id) => Number.isInteger(id) && id > 0
  )
  const cleanNote = note.trim()

  if (cleanIds.length === 0) {
    return { success: false, updatedCount: 0, error: 'No entries selected.' }
  }
  if (!hubStatusCode) {
    return { success: false, updatedCount: 0, error: 'A Hub status must be selected.' }
  }
  if (!cleanNote) {
    return { success: false, updatedCount: 0, error: 'A note is required to change Hub status.' }
  }

  const supabase = await createClient()

  const { data: statusRow, error: statusError } = await supabase
    .from('hub_status')
    .select('id, code')
    .eq('code', hubStatusCode)
    .maybeSingle()

  if (statusError) {
    return {
      success: false,
      updatedCount: 0,
      error: `Could not resolve Hub status: ${statusError.message}`,
    }
  }
  if (!statusRow) {
    return { success: false, updatedCount: 0, error: `Unknown Hub status code "${hubStatusCode}".` }
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
    return { success: false, updatedCount: 0, error: error.message }
  }

  const updatedCount = data?.length ?? 0

  if (updatedCount === 0) {
    return {
      success: false,
      updatedCount: 0,
      error:
        'No entries were updated. This usually means a viewer role (reviewer/admin required to set Hub status), or the entry is outside your assigned department.',
    }
  }

  for (const id of cleanIds) {
    revalidatePath(`/entries/${id}`)
  }
  revalidatePath('/entries')
  revalidatePath('/export')

  if (updatedCount < cleanIds.length) {
    return {
      success: true,
      updatedCount,
      error: `${cleanIds.length - updatedCount} of ${cleanIds.length} selected entries could not be updated (permission or department scope).`,
    }
  }

  return { success: true, updatedCount }
}
