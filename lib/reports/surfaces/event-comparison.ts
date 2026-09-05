/**
 * Data loader for reporting-blueprint.md §4 A-12 -- Event-over-event
 * comparison. "Same department, same category, 1448 vs 1449, indexed to a
 * common base. Every table already carries the event, so this costs nothing to
 * build -- it only waits on a second year."
 *
 * Resolves the two most recent events (getAllEvents is ordered newest Hijri
 * year first). When fewer than two exist -- the state today -- returns
 * `hasComparison: false` and the section renders an EmptyState. When two
 * exist, pulls each department's actual spend for BOTH events from
 * v_department_budget_vs_actual (one row per (department, event); event_id is a
 * plain output column filtered here) and computes, per department:
 *   - absChange  = current - base
 *   - pctChange  = absChange / base * 100          (null when base is 0)
 *   - indexed    = current / base * 100  (base = 100) (null when base is 0)
 *
 * The "base" is the OLDER of the two events, so index > 100 means spend grew.
 *
 * v_department_budget_vs_actual is built from entries + department_budget_
 * allocation, both event-scoped; `entries` is department-scoped by RLS, so a
 * department-scoped reviewer's comparison covers only their departments.
 *
 * cost_center-level comparison is a future extension (the same shape over
 * entries.cost_center_id) -- kept out here to keep the first cut lean, per the
 * blueprint's "it only waits on a second year".
 *
 * Row types live here for now; the parent hoists them into shared.tsx.
 */
import { createClient } from '@/lib/supabase/server'
import { getAllEvents } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import { ROW_CAP, round2Local } from '@/lib/reports/sections/shared'

/** One department's spend in both events plus the derived comparison. */
export type EventComparisonRow = {
  department_id: number | null
  department_name: string | null
  baseAmount: number
  currentAmount: number
  absChange: number
  /** null when baseAmount is 0 (no prior-event spend to index against). */
  pctChange: number | null
  /** current / base * 100, base = 100. null when baseAmount is 0. */
  indexed: number | null
}

type DeptActualRow = {
  department_id: number | null
  department_name: string | null
  event_id: number | null
  actual_amount: number | null
}

export type EventComparisonSurfaceData = {
  hasComparison: boolean
  /** The newer event -- the one being measured. */
  currentEventName: string | null
  /** The older event -- the index base. */
  baseEventName: string | null
  rows: EventComparisonRow[]
  error: string | null
  currentTotal: number
  baseTotal: number
}

const EMPTY: EventComparisonSurfaceData = {
  hasComparison: false,
  currentEventName: null,
  baseEventName: null,
  rows: [],
  error: null,
  currentTotal: 0,
  baseTotal: 0,
}

const SELECT = 'department_id, department_name, event_id, actual_amount'

export async function loadEventComparison(): Promise<EventComparisonSurfaceData> {
  const supabase = await createClient()
  const events = await getAllEvents() // newest Hijri year first

  if (events.length < 2) {
    return { ...EMPTY, currentEventName: events[0]?.name ?? null }
  }

  const current = events[0]!
  const base = events[1]!

  const res = await supabase
    .from('v_department_budget_vs_actual')
    .select(SELECT)
    .in('event_id', [current.id, base.id])
    .limit(ROW_CAP)
    .returns<DeptActualRow[]>()

  const error = friendlyDataError(res.error, 'reports:event-comparison')
  const data = res.data ?? []

  // key by department; keep the display name from whichever row carries it.
  const byDept = new Map<string, { id: number | null; name: string | null; base: number; current: number }>()
  for (const r of data) {
    const key = r.department_id != null ? `d${r.department_id}` : 'none'
    const entry = byDept.get(key) ?? { id: r.department_id, name: r.department_name, base: 0, current: 0 }
    if (r.department_name && !entry.name) entry.name = r.department_name
    const amount = r.actual_amount ?? 0
    if (r.event_id === base.id) entry.base = round2Local(entry.base + amount)
    else if (r.event_id === current.id) entry.current = round2Local(entry.current + amount)
    byDept.set(key, entry)
  }

  const rows: EventComparisonRow[] = [...byDept.values()]
    .filter((e) => e.base > 0 || e.current > 0)
    .map((e) => {
      const absChange = round2Local(e.current - e.base)
      return {
        department_id: e.id,
        department_name: e.name,
        baseAmount: e.base,
        currentAmount: e.current,
        absChange,
        pctChange: e.base > 0 ? round2Local((absChange / e.base) * 100) : null,
        indexed: e.base > 0 ? round2Local((e.current / e.base) * 100) : null,
      }
    })
    .sort((a, b) => b.currentAmount - a.currentAmount)

  return {
    hasComparison: true,
    currentEventName: current.name,
    baseEventName: base.name,
    rows,
    error,
    currentTotal: round2Local(rows.reduce((s, r) => s + r.currentAmount, 0)),
    baseTotal: round2Local(rows.reduce((s, r) => s + r.baseAmount, 0)),
  }
}
