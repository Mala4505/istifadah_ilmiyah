/**
 * Read helpers for document assignment ("dividing the document inbox",
 * 2026-08-29). Plain functions that take a caller-supplied Supabase client --
 * same shape as lib/events/current.ts -- so a Server Component can call them
 * on its own RLS-scoped session without an extra 'use server' hop. The
 * mutation path lives in lib/actions/assignment.ts.
 *
 * Schema: public.source_document_assignee (source_document_id, staff_id,
 * assigned_by, assigned_at), 20260829000002_document_assignment.sql.
 * `staff_id` is the same uuid as auth.users.id and staff_profile.id.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSelectedEventId } from '@/lib/events/current'
import { logRawError } from '@/lib/friendly-error'

export interface AssignableStaff {
  id: string
  displayName: string
  /** Documents currently assigned to this person that are still in the inbox
   *  (match_status unmatched/suggested) for the selected event -- a load hint
   *  for the assign pickers, not a hard limit. Best-effort: 0 on any failure. */
  openCount: number
}

/** One assignee chip's worth of data. */
export interface DocumentAssignee {
  staffId: string
  displayName: string
}

/**
 * Active admins + superadmins, ordered by name, each with an open-document
 * count. Used by the upload picker and the inbox bulk-assign menu.
 */
export async function listAssignableStaff(supabase: SupabaseClient): Promise<AssignableStaff[]> {
  const { data: staff, error } = await supabase
    .from('staff_profile')
    .select('id, display_name')
    .in('role', ['admin', 'superadmin'])
    .eq('is_active', true)
    .order('display_name')

  if (error || !staff) {
    logRawError('assignment.listAssignableStaff', error?.message ?? 'no rows')
    return []
  }

  const byId = new Map<string, AssignableStaff>(
    staff.map((s) => [s.id as string, { id: s.id as string, displayName: s.display_name as string, openCount: 0 }])
  )

  // Open-count is a best-effort hint. Two small queries rather than a
  // PostgREST embed so the shape is unambiguous: assignee rows, then which of
  // their documents are still in the inbox for the selected event.
  const { data: assigneeRows } = await supabase
    .from('source_document_assignee')
    .select('staff_id, source_document_id')

  const docIds = Array.from(new Set((assigneeRows ?? []).map((r) => r.source_document_id as number)))
  if (docIds.length > 0) {
    const selectedEventId = await getSelectedEventId()
    let q = supabase
      .from('source_document')
      .select('id')
      .in('id', docIds)
      .in('match_status', ['unmatched', 'suggested'])
    if (selectedEventId !== null) q = q.eq('event_id', selectedEventId)
    const { data: openDocs } = await q
    const openDocIds = new Set((openDocs ?? []).map((d) => d.id as number))

    for (const row of assigneeRows ?? []) {
      if (!openDocIds.has(row.source_document_id as number)) continue
      const entry = byId.get(row.staff_id as string)
      if (entry) entry.openCount += 1
    }
  }

  return Array.from(byId.values())
}

/**
 * Assignee chips for a set of documents, as Map<documentId, DocumentAssignee[]>.
 * Documents with no assignees simply don't appear in the map (caller renders
 * an "unassigned" pill). RLS on source_document_assignee already limits this
 * to what the caller may see (their own rows, or everything for an admin).
 */
export async function getDocumentAssignees(
  supabase: SupabaseClient,
  documentIds: number[]
): Promise<Map<number, DocumentAssignee[]>> {
  const result = new Map<number, DocumentAssignee[]>()
  const ids = documentIds.filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) return result

  const { data: rows, error } = await supabase
    .from('source_document_assignee')
    .select('source_document_id, staff_id')
    .in('source_document_id', ids)

  if (error || !rows || rows.length === 0) {
    if (error) logRawError('assignment.getDocumentAssignees', error.message)
    return result
  }

  const staffIds = Array.from(new Set(rows.map((r) => r.staff_id as string)))
  const { data: profiles } = await supabase
    .from('staff_profile')
    .select('id, display_name')
    .in('id', staffIds)
  const nameById = new Map((profiles ?? []).map((p) => [p.id as string, p.display_name as string]))

  for (const row of rows) {
    const docId = row.source_document_id as number
    const list = result.get(docId) ?? []
    list.push({
      staffId: row.staff_id as string,
      displayName: nameById.get(row.staff_id as string) ?? 'Unknown',
    })
    result.set(docId, list)
  }
  return result
}

/** Initials for an avatar chip: "Fatima Iqbal" -> "FI", "Rehan" -> "RE". */
export function staffInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '??'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}
