'use server'

/**
 * Server actions backing the Reports shell (reporting-blueprint.md Phase 1).
 * Cookie shape mirrors setReviewQueueScope (lib/actions/review.ts:714) --
 * same `path`/`maxAge`, no admin gate, since this is a view preference, not
 * a mutation.
 */

import { cookies } from 'next/headers'
import { COMPARE_BASIS_COOKIE, isCompareBasis, type CompareBasis } from '@/lib/reports/compare-basis'
import { REPORTS_PINS_COOKIE, parsePins, togglePin } from '@/lib/reports/pins'
import { ALL_SECTION_IDS } from '@/lib/reports/surface-sections'

const COOKIE_OPTS = { path: '/', maxAge: 60 * 60 * 24 * 365 } as const

export async function setCompareBasis(basis: CompareBasis): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isCompareBasis(basis)) return { ok: false, error: 'Unrecognised comparison period.' }
  ;(await cookies()).set(COMPARE_BASIS_COOKIE, basis, COOKIE_OPTS)
  return { ok: true }
}

/**
 * Pin or unpin a report section for the `★ My reports` rail group. Writes
 * the `reports_pins` cookie only — per-browser, no revalidation (redesign
 * plan Phase 3.1d). Returns the new pin list so the client can update
 * without a round trip.
 */
export async function toggleReportPin(
  sectionId: string,
): Promise<{ ok: true; pins: string[] } | { ok: false; error: string }> {
  if (!ALL_SECTION_IDS.has(sectionId)) return { ok: false, error: 'Unknown report.' }
  const store = await cookies()
  const next = togglePin(parsePins(store.get(REPORTS_PINS_COOKIE)?.value), sectionId)
  store.set(REPORTS_PINS_COOKIE, next.join(','), COOKIE_OPTS)
  return { ok: true, pins: next }
}
