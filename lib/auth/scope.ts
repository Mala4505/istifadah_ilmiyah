import 'server-only'
/**
 * Visibility + writable-event checks to run BEFORE any service-role (admin
 * client) work, and as defence in depth before session-client writes.
 * Security audit 2026-10-15, Phase 3 (docs/security-audit-fix-plan.md).
 *
 * Every export of a 'use server' file is a public POST endpoint, so an action
 * that reaches for `createAdminClient()` must first prove, through the
 * SESSION-bound client (so RLS decides what the caller may see), that the row
 * it is about to touch is one this caller is allowed to touch. A row RLS hides
 * is reported as `not_found`, never `forbidden`.
 *
 * Closed (non-current) events are writable by a superadmin only (owner
 * decision D5). The cookie-based `isEventMutable(getSelectedEvent())` check the
 * actions also run is a UX convenience tied to the user's own cookie; these
 * helpers check the event of the row itself.
 */

import { createClient } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'
import { decideWritable, SCOPE_DENY_MESSAGES, type ScopeDenyReason } from '@/lib/auth/scope-rules'
import type { StaffRole } from '@/lib/auth/roles'

export { SCOPE_DENY_MESSAGES }
export type { ScopeDenyReason }

export type ScopeResult = { ok: true } | { ok: false; reason: ScopeDenyReason; error: string }

function deny(reason: ScopeDenyReason): { ok: false; reason: ScopeDenyReason; error: string } {
  return { ok: false, reason, error: SCOPE_DENY_MESSAGES[reason] }
}

/** PostgREST returns a to-one embed as an object, but tolerate an array too. */
function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * The document is visible to the caller (RLS) and its event is writable by this
 * role. With `refuseVerified`, a document that already has a verified bill is
 * also refused unless the caller is a superadmin.
 */
export async function assertDocumentWritable(
  sourceDocumentId: number,
  role: StaffRole | string | null | undefined,
  opts: { refuseVerified?: boolean } = {}
): Promise<ScopeResult> {
  if (!Number.isInteger(sourceDocumentId) || sourceDocumentId <= 0) return deny('not_found')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('source_document')
    .select('id, event:event_id(is_current)')
    .eq('id', sourceDocumentId)
    .maybeSingle()
  if (error) {
    logRawError('scope.assertDocumentWritable', error.message)
    return deny('error')
  }

  let verified = false
  if (data && opts.refuseVerified) {
    const { data: verifiedRows, error: verifiedError } = await supabase
      .from('document_extraction')
      .select('id')
      .eq('source_document_id', sourceDocumentId)
      .not('verified_at', 'is', null)
      .limit(1)
    if (verifiedError) {
      logRawError('scope.assertDocumentWritable:verified', verifiedError.message)
      return deny('error')
    }
    verified = (verifiedRows ?? []).length > 0
  }

  const event = firstOf<{ is_current: boolean }>(data?.event)
  const decision = decideWritable({
    found: !!data,
    eventIsCurrent: event?.is_current,
    role,
    verified,
    refuseVerified: opts.refuseVerified,
  })
  return decision.ok ? { ok: true } : deny(decision.reason)
}

/**
 * Same checks for one bill (`document_extraction` row): visible through its
 * parent document, the document's event writable by this role, and (opt-in)
 * not already verified unless the caller is a superadmin.
 */
export async function assertExtractionWritable(
  documentExtractionId: number,
  role: StaffRole | string | null | undefined,
  opts: { refuseVerified?: boolean } = {}
): Promise<{ ok: true; sourceDocumentId: number } | Extract<ScopeResult, { ok: false }>> {
  if (!Number.isInteger(documentExtractionId) || documentExtractionId <= 0) return deny('not_found')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('document_extraction')
    .select('id, source_document_id, verified_at, doc:source_document_id(event:event_id(is_current))')
    .eq('id', documentExtractionId)
    .maybeSingle()
  if (error) {
    logRawError('scope.assertExtractionWritable', error.message)
    return deny('error')
  }

  const doc = firstOf<{ event: { is_current: boolean } | { is_current: boolean }[] | null }>(data?.doc)
  const event = firstOf<{ is_current: boolean }>(doc?.event)
  const decision = decideWritable({
    found: !!data,
    eventIsCurrent: event?.is_current,
    role,
    verified: !!data?.verified_at,
    refuseVerified: opts.refuseVerified,
  })
  if (!decision.ok) return deny(decision.reason)
  return { ok: true, sourceDocumentId: data!.source_document_id as number }
}

export interface VisibleEntry {
  id: number
  eventId: number | null
  departmentId: number | null
  type: string | null
  eventIsCurrent: boolean | null
}

export type EntryScopeResult = { ok: true; entry: VisibleEntry } | Extract<ScopeResult, { ok: false }>

/**
 * The entry is visible to the caller (RLS: department-scoped). With
 * `requireWritable`, the entry's event must also be writable by this role.
 * `eventId`, when given, additionally requires the entry to belong to that
 * event (used to stop a document in one event linking to another event's entry).
 */
export async function assertEntryVisible(
  entryId: number,
  opts: { role?: StaffRole | string | null; requireWritable?: boolean; eventId?: number } = {}
): Promise<EntryScopeResult> {
  if (!Number.isInteger(entryId) || entryId <= 0) return deny('not_found')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('entries')
    .select('id, event_id, department_id, type, event:event_id(is_current)')
    .eq('id', entryId)
    .maybeSingle()
  if (error) {
    logRawError('scope.assertEntryVisible', error.message)
    return deny('error')
  }
  if (!data) return deny('not_found')
  if (opts.eventId !== undefined && data.event_id !== opts.eventId) return deny('not_found')

  const event = firstOf<{ is_current: boolean }>(data.event)
  if (opts.requireWritable) {
    const decision = decideWritable({ found: true, eventIsCurrent: event?.is_current, role: opts.role })
    if (!decision.ok) return deny(decision.reason)
  }

  return {
    ok: true,
    entry: {
      id: data.id as number,
      eventId: (data.event_id as number | null) ?? null,
      departmentId: (data.department_id as number | null) ?? null,
      type: (data.type as string | null) ?? null,
      eventIsCurrent: event?.is_current ?? null,
    },
  }
}

/**
 * Of these entry ids, the ones whose event this role may write to: all of them
 * for a superadmin, only current-event entries otherwise. Entries RLS hides from
 * the caller are dropped too (they never come back from the session client).
 * Callers report the difference as "skipped" / "could not be updated".
 */
export async function filterWritableEntryIds(
  entryIds: number[],
  role: StaffRole | string | null | undefined
): Promise<{ ok: true; ids: number[] } | { ok: false; error: string }> {
  if (entryIds.length === 0) return { ok: true, ids: [] }
  const supabase = await createClient()
  const { data, error } = await supabase.from('entries').select('id, event:event_id(is_current)').in('id', entryIds)
  if (error) {
    logRawError('scope.filterWritableEntryIds', error.message)
    return { ok: false, error: SCOPE_DENY_MESSAGES.error }
  }
  const ids = ((data ?? []) as { id: number; event: { is_current: boolean } | { is_current: boolean }[] | null }[])
    .filter((row) => decideWritable({ found: true, eventIsCurrent: firstOf(row.event)?.is_current, role }).ok)
    .map((row) => row.id)
  return { ok: true, ids }
}
