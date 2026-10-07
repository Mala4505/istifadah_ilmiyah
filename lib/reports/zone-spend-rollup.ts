import type { ZoneSpendRow } from '@/lib/reports/sections/shared'

/**
 * v_zone_spend is (zone, department, event) grain, but the zone-spend section
 * reports one row per zone (donut slice, table row keyed by zone_id, "across N
 * zones"). Roll the department split up so a zone never appears twice.
 * department_id is kept only when every row for the zone shares it.
 *
 * A plain module (no Supabase import) so it stays unit-testable.
 */
export function rollUpZoneSpend(rows: ZoneSpendRow[]): ZoneSpendRow[] {
  const byZone = new Map<string, ZoneSpendRow>()
  for (const r of rows) {
    const key = r.zone_id != null ? String(r.zone_id) : 'unassigned'
    const prev = byZone.get(key)
    if (!prev) {
      byZone.set(key, { ...r })
      continue
    }
    prev.entry_count += r.entry_count
    prev.total_amount = prev.total_amount == null && r.total_amount == null ? null : (prev.total_amount ?? 0) + (r.total_amount ?? 0)
    if (prev.department_id !== r.department_id) prev.department_id = null
  }
  return [...byZone.values()].sort((a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0))
}
