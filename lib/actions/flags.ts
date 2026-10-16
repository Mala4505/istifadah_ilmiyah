'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient, getAuthUser } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { assertEntryVisible } from '@/lib/auth/scope'

/**
 * Resolve a `flags` row (§3.3, docs/pre-deploy-findings-and-plan.md — the
 * entry page's new "Issues" card). Mirrors `lib/actions/exceptions.ts`'s
 * `resolveException` auth/RLS-error-handling pattern: runs through the
 * session-bound client, not the admin client, so `flags_update` RLS
 * (20260808000026 — reviewer/admin only) is the real gate and a disallowed
 * write surfaces as an explicit "0 rows updated" error rather than a
 * silently swallowed no-op.
 *
 * Unlike `reconciliation_exception`, `flags` has no `resolution_note`
 * column (20260808000025/20260814000003) and its status values are
 * `'confirmed' | 'dismissed'`, not `'resolved' | 'dismissed'` — so this is a
 * deliberately smaller action, not a copy-paste of resolveException with the
 * table name swapped.
 */
export type ResolveFlagOutcome = 'confirmed' | 'dismissed'

// Security audit 2026-10-15 (3.7): runtime validation, since this is a public POST endpoint.
const resolveFlagSchema = z.object({
  flagId: z.number().int().positive(),
  entryId: z.number().int().positive(),
  outcome: z.enum(['confirmed', 'dismissed']),
})

export async function resolveFlag(input: {
  flagId: number
  entryId: number
  outcome: ResolveFlagOutcome
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = resolveFlagSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'That flag could not be updated.' }
  }
  const { flagId, outcome } = parsed.data

  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
  }
  const staff = await getStaffContext()
  if (!staff || !staff.isActive || !isAdminOrAbove(staff.role)) {
    return { ok: false, error: 'Resolving flags is an admin action.' }
  }

  // Trust the flag's own entry, not the client-sent entryId: the flag must be
  // visible to the caller, and its entry must be one they may see and, unless
  // they are a superadmin, one that sits in the current (open) event.
  const { data: flagRow, error: flagError } = await supabase
    .from('flags')
    .select('id, entry_id')
    .eq('id', flagId)
    .maybeSingle()
  if (flagError) {
    return { ok: false, error: logRawError('flags.resolveFlag:lookup', flagError.message) }
  }
  if (!flagRow) {
    return { ok: false, error: 'That flag could not be found.' }
  }
  const entryId = (flagRow.entry_id as number | null) ?? null
  if (entryId !== null) {
    const scope = await assertEntryVisible(entryId, { role: staff.role, requireWritable: true })
    if (!scope.ok) {
      return {
        ok: false,
        error:
          scope.reason === 'closed_event'
            ? 'This event is closed. Only a superadmin can change its flags.'
            : 'That flag could not be found.',
      }
    }
  }

  const { data, error } = await supabase
    .from('flags')
    .update({
      status: outcome,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', flagId)
    .eq('status', 'open')
    .select('id')

  if (error) {
    return { ok: false, error: logRawError('flags.resolveFlag', error.message) }
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        'Could not update this flag. Either it was already resolved by someone else, or your role does not permit resolving flags — admin is required.',
    }
  }

  // The entry page (app/(app)/entries/[id]/page.tsx) is the only current
  // caller and is `force-dynamic`, so router.refresh() alone reflects this
  // client-side — revalidatePath here is defense in depth for any other
  // navigation path back to the same entry, and is harmless for any future
  // caller since it only touches this one entry's route.
  if (entryId !== null) revalidatePath(`/entries/${entryId}`)
  return { ok: true }
}
