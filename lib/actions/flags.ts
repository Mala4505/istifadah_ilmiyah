'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'

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

export async function resolveFlag(input: {
  flagId: number
  entryId: number
  outcome: ResolveFlagOutcome
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { flagId, entryId, outcome } = input

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, error: 'You must be signed in.' }
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
  revalidatePath(`/entries/${entryId}`)
  return { ok: true }
}
