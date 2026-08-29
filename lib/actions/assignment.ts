'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'

/**
 * Document-assignment mutation ("dividing the document inbox", 2026-08-29).
 * The read helpers live in lib/assignment/queries.ts.
 *
 * Everything funnels through the `set_source_document_assignees` RPC
 * (20260829000002), which enforces the admin gate, "active admins only"
 * targets, and the anti-overtaking rule in the same transaction as the write.
 * Session-bound client so RLS is the real gate; a 0-updated result is a
 * friendly string, not a thrown error -- same contract as
 * lib/actions/documents.ts.
 */

export type SetAssigneesResult =
  | { ok: true; updatedCount: number; refusedCount: number }
  | { ok: false; error: string }

/**
 * Replace the assignee set for one or more documents. Pass an empty
 * `staffIds` array to send the documents back to the shared pool.
 */
export async function setDocumentAssignees(
  documentIds: number[],
  staffIds: string[]
): Promise<SetAssigneesResult> {
  const cleanIds = documentIds.filter((id) => Number.isInteger(id) && id > 0)
  if (cleanIds.length === 0) {
    return { ok: false, error: 'No documents selected.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('set_source_document_assignees', {
    p_ids: cleanIds,
    p_staff_ids: staffIds,
  })

  if (error) {
    return { ok: false, error: logRawError('assignment.setDocumentAssignees', error.message) }
  }

  const row = Array.isArray(data) ? data[0] : data
  const updatedCount = (row?.updated_count as number | undefined) ?? 0
  const refusedCount = ((row?.refused_ids as number[] | undefined) ?? []).length

  revalidatePath('/documents')
  revalidatePath('/review')

  if (updatedCount === 0) {
    return {
      ok: false,
      error:
        cleanIds.length === 1
          ? 'That document could not be reassigned — it may be assigned to someone else. A superadmin can move it.'
          : 'None of the selected documents could be reassigned — they may be assigned to someone else. A superadmin can move them.',
    }
  }

  return { ok: true, updatedCount, refusedCount }
}
