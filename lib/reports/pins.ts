/**
 * `★ My reports` pin storage for the Reports workspace (redesign plan Phase
 * 3.1d). A pin is just a section id the viewer wants floated to the top of
 * the left rail. Per-browser only — a comma-separated `reports_pins` cookie,
 * no table, no revalidation, the same read-a-cookie-server-side shape as
 * `report_compare_basis` (lib/reports/compare-basis.ts) and
 * `nav_rail_collapsed` (components/app-shell/nav-rail.tsx).
 *
 * This module imports `next/headers` at module scope, so — like
 * compare-basis.ts — never import its value exports into a Client Component;
 * the client `<ReportIndex>` receives the resolved pin list as a prop from
 * app/(app)/reports/layout.tsx and calls `toggleReportPin` (a `'use server'`
 * action in lib/actions/reports.ts) to change it.
 */
import { cookies } from 'next/headers'
import { ALL_SECTION_IDS } from '@/lib/reports/surface-sections'

export const REPORTS_PINS_COOKIE = 'reports_pins'

/** Hard cap so a runaway cookie can't grow without bound. */
export const MAX_PINS = 12

/** Parse a raw cookie value into a clean, deduped, valid, capped id list. */
export function parsePins(raw: string | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (id && ALL_SECTION_IDS.has(id) && !seen.has(id)) seen.add(id)
    if (seen.size >= MAX_PINS) break
  }
  return [...seen]
}

/** Reads the `reports_pins` cookie into a validated id list. */
export async function getReportPins(): Promise<string[]> {
  return parsePins((await cookies()).get(REPORTS_PINS_COOKIE)?.value)
}

/** Add or remove `id` from a pin list, returning the new list (order: newest pin last). */
export function togglePin(pins: string[], id: string): string[] {
  if (pins.includes(id)) return pins.filter((p) => p !== id)
  return [...pins, id].slice(-MAX_PINS)
}
