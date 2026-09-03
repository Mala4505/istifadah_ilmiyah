'use server'

/**
 * Server actions backing the Reports shell (reporting-blueprint.md Phase 1).
 * Cookie shape mirrors setReviewQueueScope (lib/actions/review.ts:714) --
 * same `path`/`maxAge`, no admin gate, since this is a view preference, not
 * a mutation.
 */

import { cookies } from 'next/headers'
import { COMPARE_BASIS_COOKIE, isCompareBasis, type CompareBasis } from '@/lib/reports/compare-basis'

export async function setCompareBasis(basis: CompareBasis): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isCompareBasis(basis)) return { ok: false, error: 'Unrecognised comparison period.' }
  ;(await cookies()).set(COMPARE_BASIS_COOKIE, basis, { path: '/', maxAge: 60 * 60 * 24 * 365 })
  return { ok: true }
}
