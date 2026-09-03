/**
 * Comparison-period resolution for the Reports shell (reporting-blueprint.md
 * Phase 1, "period comparison in the shell"). Every tile/chart on
 * app/(app)/reports/page.tsx needs a second, prior dataset to diff against --
 * this resolves which prior period that is, from a cookie, the same
 * read-a-cookie-server-side shape as lib/events/current.ts's
 * `active_event_id` and lib/actions/review.ts's `review_queue_scope`.
 *
 * Unlike `active_event_id` (which changes which event's rows you query),
 * this is a pure view preference -- it never gates a mutation -- so unlike
 * `setActiveEvent` its server action is not admin-gated.
 */
import { cookies } from 'next/headers'

export const COMPARE_BASIS_COOKIE = 'report_compare_basis'

export type CompareBasis = 'prior_week' | 'prior_event' | 'none'

const VALID_BASES: readonly CompareBasis[] = ['prior_week', 'prior_event', 'none']

export function isCompareBasis(value: string | undefined): value is CompareBasis {
  return VALID_BASES.includes(value as CompareBasis)
}

/** Reads the `report_compare_basis` cookie; defaults to `prior_week` when
 *  unset or unrecognised. */
export async function getCompareBasis(): Promise<CompareBasis> {
  const raw = (await cookies()).get(COMPARE_BASIS_COOKIE)?.value
  return isCompareBasis(raw) ? raw : 'prior_week'
}

export const COMPARE_BASIS_LABELS: Record<CompareBasis, string> = {
  prior_week: 'vs last week',
  prior_event: 'vs prior event',
  none: 'No comparison',
}
