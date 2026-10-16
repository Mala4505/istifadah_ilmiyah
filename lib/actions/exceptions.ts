'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient, getAuthUser } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'
import { shapeBatchResolveResult } from '@/components/exceptions/bulk-selection'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove, isSuperadmin } from '@/lib/auth/roles'

/**
 * Resolve/dismiss a reconciliation_exception (MASTER-PLAN §3.10, §5 row 8).
 *
 * "Resolution note is required — 'resolved' with no reason is not an audit
 * trail" (§5). Runs through the session-bound client, not the admin client:
 * `reconciliation_exception_update` RLS (§4.2) already restricts writes to
 * `reviewer`/`admin` roles, and a `viewer` hitting this action should get
 * exactly what §9.4 describes for that case — zero rows updated, not a
 * bypassed check. This action surfaces that as an explicit error rather
 * than reporting silent success, per that same section's point about the
 * "0 rows updated" case being easy to swallow accidentally.
 *
 * Security audit 2026-10-15 (3.7): every export here is a public POST
 * endpoint, so the outcome is validated at runtime (never 'open'), the caller
 * must be an active admin-or-above, and the target must be visible to the
 * caller and not sit in a closed event (superadmin excepted, owner decision D5).
 */
export type ResolveExceptionOutcome = 'resolved' | 'dismissed'

const outcomeSchema = z.enum(['resolved', 'dismissed'])
const idSchema = z.number().int().positive()
const NOT_PERMITTED_MESSAGE = 'Resolving exceptions is an admin action.'

type EventEmbed = { is_current: boolean } | { is_current: boolean }[] | null | undefined
function isCurrentOf(embed: EventEmbed): boolean {
  const e = Array.isArray(embed) ? embed[0] : embed
  return e?.is_current === true
}

/**
 * Of the requested exception ids, the ones this caller may write: visible to
 * them and (for non-superadmins) not attached to a bill, document or entry in a
 * closed event. Visibility of the linked entry / bill / document comes from RLS
 * on those tables (session client), so an exception tied to another
 * department's entry is treated as not found. Exceptions with no link at all
 * (e.g. import-level ones) are allowed through; the table's own RLS still gates
 * the write.
 */
async function filterWritableExceptionIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: number[],
  role: string
): Promise<{ allowed: number[]; failed: boolean }> {
  const { data: rows, error } = await supabase
    .from('reconciliation_exception')
    .select('id, entry_id, document_extraction_id, source_document_id')
    .in('id', ids)
  if (error) {
    logRawError('exceptions.filterWritable', error.message)
    return { allowed: [], failed: true }
  }

  const links = (rows ?? []) as {
    id: number
    entry_id: number | null
    document_extraction_id: number | null
    source_document_id: number | null
  }[]
  const uniq = (xs: (number | null)[]) => Array.from(new Set(xs.filter((x): x is number => x !== null)))
  const entryIds = uniq(links.map((r) => r.entry_id))
  const extractionIds = uniq(links.map((r) => r.document_extraction_id))
  const documentIds = uniq(links.map((r) => r.source_document_id))

  const [entriesRes, extractionsRes, documentsRes] = await Promise.all([
    entryIds.length
      ? supabase.from('entries').select('id, event:event_id(is_current)').in('id', entryIds)
      : Promise.resolve({ data: [], error: null }),
    extractionIds.length
      ? supabase
          .from('document_extraction')
          .select('id, doc:source_document_id(event:event_id(is_current))')
          .in('id', extractionIds)
      : Promise.resolve({ data: [], error: null }),
    documentIds.length
      ? supabase.from('source_document').select('id, event:event_id(is_current)').in('id', documentIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  const linkError = entriesRes.error ?? extractionsRes.error ?? documentsRes.error
  if (linkError) {
    logRawError('exceptions.filterWritable:links', linkError.message)
    return { allowed: [], failed: true }
  }

  const superadmin = isSuperadmin(role)
  const entryCurrent = new Map<number, boolean>(
    ((entriesRes.data ?? []) as { id: number; event: EventEmbed }[]).map((r) => [r.id, isCurrentOf(r.event)])
  )
  const extractionCurrent = new Map<number, boolean>(
    ((extractionsRes.data ?? []) as { id: number; doc: { event: EventEmbed } | { event: EventEmbed }[] | null }[]).map(
      (r) => {
        const doc = Array.isArray(r.doc) ? r.doc[0] : r.doc
        return [r.id, isCurrentOf(doc?.event)]
      }
    )
  )
  const documentCurrent = new Map<number, boolean>(
    ((documentsRes.data ?? []) as { id: number; event: EventEmbed }[]).map((r) => [r.id, isCurrentOf(r.event)])
  )

  const ok = (map: Map<number, boolean>, id: number | null) => {
    if (id === null) return true
    if (!map.has(id)) return false // RLS hid it from this caller
    return superadmin || map.get(id) === true
  }
  const allowed = links
    .filter(
      (r) =>
        ok(entryCurrent, r.entry_id) &&
        ok(extractionCurrent, r.document_extraction_id) &&
        ok(documentCurrent, r.source_document_id)
    )
    .map((r) => r.id)
  return { allowed, failed: false }
}

export async function resolveException(input: {
  exceptionId: number
  outcome: ResolveExceptionOutcome
  note: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsedOutcome = outcomeSchema.safeParse(input?.outcome)
  const parsedId = idSchema.safeParse(input?.exceptionId)
  if (!parsedOutcome.success || !parsedId.success) {
    return { ok: false, error: 'That exception could not be updated.' }
  }
  const exceptionId = parsedId.data
  const outcome = parsedOutcome.data
  const trimmedNote = (typeof input.note === 'string' ? input.note : '').trim()

  if (trimmedNote === '') {
    return { ok: false, error: 'A resolution note is required.' }
  }

  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }
  const staff = await getStaffContext()
  if (!staff || !staff.isActive || !isAdminOrAbove(staff.role)) {
    return { ok: false, error: NOT_PERMITTED_MESSAGE }
  }

  const writable = await filterWritableExceptionIds(supabase, [exceptionId], staff.role)
  if (writable.failed) return { ok: false, error: 'Could not check this exception. Try again in a moment.' }
  if (writable.allowed.length === 0) {
    return { ok: false, error: 'That exception could not be found, or it belongs to a closed event.' }
  }

  const { data, error } = await supabase
    .from('reconciliation_exception')
    .update({
      status: outcome,
      resolution_note: trimmedNote,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      // Clear the save-time recheck stamp (2026-09-14) -- once resolved/dismissed
      // the row is no longer "open, recheck pending confirmation", and a
      // lingering note would be confusing on a closed audit-trail row.
      auto_recheck_note: null,
      auto_recheck_cleared_at: null,
    })
    .eq('id', exceptionId)
    .eq('status', 'open')
    .select('id')

  if (error) {
    return { ok: false, error: logRawError('exceptions.resolveException', error.message) }
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        'Could not update this exception. Either it was already resolved by someone else, or your role (viewer) does not permit resolving exceptions — reviewer or admin is required.',
    }
  }

  revalidatePath('/exceptions')
  return { ok: true }
}

/**
 * Resolve/dismiss several open exceptions in one write
 * (docs/hub-screen-certification.md §3.5). One import batch raising 40
 * identical exceptions otherwise means 40 dialogs, each with a typed note.
 *
 * Same guarantees as the single-row `resolveException`: the note is required
 * (and re-checked here, not only in the UI); the write runs through the
 * session-bound client so `reconciliation_exception_update` RLS still gates
 * writes to reviewer/admin; and `.eq('status','open')` means a row already
 * closed by someone else is skipped rather than re-stamped. The returning
 * `select('id')` lets us report {updated, skipped} instead of a bare success.
 * Rows that are not visible to the caller, or sit in a closed event (for a
 * non-superadmin), are left out of the write and counted as skipped.
 */
export async function resolveExceptions(input: {
  exceptionIds: number[]
  outcome: ResolveExceptionOutcome
  note: string
}): Promise<{ ok: true; updated: number; skipped: number } | { ok: false; error: string }> {
  const parsedOutcome = outcomeSchema.safeParse(input?.outcome)
  if (!parsedOutcome.success) {
    return { ok: false, error: 'Those exceptions could not be updated.' }
  }
  const outcome = parsedOutcome.data
  const trimmedNote = (typeof input.note === 'string' ? input.note : '').trim()
  const ids = Array.from(new Set(Array.isArray(input.exceptionIds) ? input.exceptionIds : [])).filter(
    (id) => Number.isInteger(id) && id > 0
  )

  if (trimmedNote === '') {
    return { ok: false, error: 'A resolution note is required.' }
  }
  if (ids.length === 0) {
    return { ok: false, error: 'No exceptions were selected.' }
  }
  if (ids.length > 500) {
    return { ok: false, error: 'Too many exceptions selected at once. Select 500 or fewer.' }
  }

  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }
  const staff = await getStaffContext()
  if (!staff || !staff.isActive || !isAdminOrAbove(staff.role)) {
    return { ok: false, error: NOT_PERMITTED_MESSAGE }
  }

  const writable = await filterWritableExceptionIds(supabase, ids, staff.role)
  if (writable.failed) return { ok: false, error: 'Could not check these exceptions. Try again in a moment.' }
  if (writable.allowed.length === 0) {
    return {
      ok: false,
      error: 'None of the selected exceptions could be updated. They may belong to a closed event.',
    }
  }

  const { data, error } = await supabase
    .from('reconciliation_exception')
    .update({
      status: outcome,
      resolution_note: trimmedNote,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      auto_recheck_note: null,
      auto_recheck_cleared_at: null,
    })
    .in('id', writable.allowed)
    .eq('status', 'open')
    .select('id')

  if (error) {
    return { ok: false, error: logRawError('exceptions.resolveExceptions', error.message) }
  }

  const { updated, skipped } = shapeBatchResolveResult(ids, (data ?? []) as { id: number }[])

  if (updated === 0) {
    return {
      ok: false,
      error:
        'None of the selected exceptions could be updated. Either they were already resolved by someone else, or your role (viewer) does not permit resolving exceptions — reviewer or admin is required.',
    }
  }

  revalidatePath('/exceptions')
  return { ok: true, updated, skipped }
}
