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
 *
 * The client-safe pieces (the `CompareBasis` type, the cookie name,
 * `isCompareBasis`, and `COMPARE_BASIS_LABELS`) live in
 * ./compare-basis-labels and are re-exported here so every existing import
 * from '@/lib/reports/compare-basis' keeps resolving unchanged. Only
 * `getCompareBasis()` -- the one thing that actually needs `cookies()` --
 * stays defined in this file.
 */
import { cookies } from 'next/headers'
import { COMPARE_BASIS_COOKIE, isCompareBasis, type CompareBasis } from './compare-basis-labels'

export * from './compare-basis-labels'

/** Reads the `report_compare_basis` cookie; defaults to `prior_week` when
 *  unset or unrecognised. */
export async function getCompareBasis(): Promise<CompareBasis> {
  const raw = (await cookies()).get(COMPARE_BASIS_COOKIE)?.value
  return isCompareBasis(raw) ? raw : 'prior_week'
}
