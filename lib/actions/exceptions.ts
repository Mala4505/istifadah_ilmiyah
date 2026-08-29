'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'
import { shapeBatchResolveResult } from '@/components/exceptions/bulk-selection'

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
 */
export type ResolveExceptionOutcome = 'resolved' | 'dismissed'

export async function resolveException(input: {
  exceptionId: number
  outcome: ResolveExceptionOutcome
  note: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { exceptionId, outcome, note } = input
  const trimmedNote = note.trim()

  if (trimmedNote === '') {
    return { ok: false, error: 'A resolution note is required.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }

  const { data, error } = await supabase
    .from('reconciliation_exception')
    .update({
      status: outcome,
      resolution_note: trimmedNote,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
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
 */
export async function resolveExceptions(input: {
  exceptionIds: number[]
  outcome: ResolveExceptionOutcome
  note: string
}): Promise<{ ok: true; updated: number; skipped: number } | { ok: false; error: string }> {
  const { outcome } = input
  const trimmedNote = input.note.trim()
  const ids = Array.from(new Set(input.exceptionIds)).filter((id) => Number.isInteger(id) && id > 0)

  if (trimmedNote === '') {
    return { ok: false, error: 'A resolution note is required.' }
  }
  if (ids.length === 0) {
    return { ok: false, error: 'No exceptions were selected.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }

  const { data, error } = await supabase
    .from('reconciliation_exception')
    .update({
      status: outcome,
      resolution_note: trimmedNote,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .in('id', ids)
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
