/**
 * Pure decision logic behind lib/auth/scope.ts, split out so it can be unit
 * tested without a database or the 'server-only' guard.
 *
 * Rules (security audit 2026-10-15, owner decision D5):
 *   - A row the caller cannot see (RLS returned nothing) is "not found", never
 *     "forbidden", so ids cannot be probed.
 *   - A closed (non-current) event is writable by a superadmin only.
 *   - A bill that has already been verified can be re-run / removed by a
 *     superadmin only (when the caller asks for that rule).
 */
import { isSuperadmin } from '@/lib/auth/roles'

export type ScopeDenyReason = 'not_found' | 'closed_event' | 'verified' | 'error'

export type ScopeDecision = { ok: true } | { ok: false; reason: ScopeDenyReason }

export const SCOPE_DENY_MESSAGES: Record<ScopeDenyReason, string> = {
  not_found: 'That document could not be found, or you do not have access to it.',
  closed_event: 'This event is closed. Only a superadmin can make changes to it.',
  verified: 'This bill has already been reviewed and saved. Only a superadmin can redo it.',
  error: 'Something went wrong while checking your access. Please try again.',
}

export function decideWritable(input: {
  /** Did the session-bound (RLS) read return the row at all? */
  found: boolean
  /** `event.is_current` of the row's event; null/undefined when it could not be resolved. */
  eventIsCurrent: boolean | null | undefined
  role: string | null | undefined
  /** Is the extraction (or any extraction of the document) already verified? */
  verified?: boolean
  /** Opt in to the "verified rows are superadmin-only" rule. */
  refuseVerified?: boolean
}): ScopeDecision {
  if (!input.found) return { ok: false, reason: 'not_found' }
  const superadmin = isSuperadmin(input.role)
  if (input.eventIsCurrent !== true && !superadmin) return { ok: false, reason: 'closed_event' }
  if (input.refuseVerified && input.verified && !superadmin) return { ok: false, reason: 'verified' }
  return { ok: true }
}
