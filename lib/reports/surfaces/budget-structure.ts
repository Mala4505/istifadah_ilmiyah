/**
 * Data loader for the "budget structure" cluster of the Budget & Spend surface
 * (reporting-blueprint.md §8 Phase Six, Family A): A-02 budget revision
 * history, A-06 zone x category matrix, A-07 budget category mix.
 *
 * Backing views (20260903000013_budget_structure_views.sql):
 *   v_budget_revision_history -- one row per budget_allocation snapshot, with
 *     the running revision sequence + per-step deltas.
 *   v_zone_category_matrix    -- one row per (zone, cost_center, event).
 *   v_budget_category_mix     -- one row per (cost_center, event).
 *
 * Each view exposes `event_id` as a plain column; filtered here at the query
 * site against the active event (20260822000007 convention).
 *
 * A-02 is a server-rendered drill keyed on `?revision_head_id=<id>` (the same
 * shape E-05's `?trace_entry_id=` uses): the small
 * `<BudgetRevisionHistoryPicker>` client child only writes the param, the
 * selected head's waterfall is resolved from the already-fetched rows here /
 * in the section. No separate query per head -- the whole revision table for
 * the event is small (a handful of snapshots per head).
 *
 * `compareBasis` is accepted for signature parity with the other surface
 * loaders but unused: none of these three reports has a prior-period delta in
 * its blueprint spec (a revision trail is already a time series; a spend-mix
 * share is read against the current whole, not last event).
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { ROW_CAP } from '@/lib/reports/sections/shared'

/** One row of v_budget_revision_history -- a single dated budget_allocation
 *  snapshot for a head, plus its place in that head's revision run. Field
 *  names match the view's select list verbatim.
 *
 *  `effective_amount` = coalesce(nullif(approved_amount, 0), request_amount, 0)
 *  -- "the figure under revision" (approved once real, requested until then),
 *  so the report works on the sample data shape where approved_amount = 0 on
 *  every head. `approved_delta` is the strict approved-only movement.
 *  `*_delta` are null on the first row of a head's run. */
export type BudgetRevisionHistoryRow = {
  allocation_id: number
  budget_head_id: number
  budget_head_label: string
  department_id: number | null
  department_name: string | null
  event_id: number | null
  import_batch_id: number | null
  as_of: string
  request_amount: number | null
  approved_amount: number | null
  utilised_amount: number | null
  balance_amount: number | null
  effective_amount: number
  revision_seq: number
  approved_delta: number | null
  effective_delta: number | null
  is_first: boolean
  is_latest: boolean
}

/** One row of v_zone_category_matrix -- one (zone, cost_center) cell for an
 *  event. Null zone -> 'Unassigned zone', null cost_center -> 'Uncategorised'
 *  (kept, not dropped, so enrichment gaps stay visible). */
export type ZoneCategoryMatrixRow = {
  zone_id: number | null
  zone_name: string
  zone_number: number | null
  cost_center_id: number | null
  cost_center_name: string
  event_id: number | null
  entry_count: number
  total_amount: number
}

/** One row of v_budget_category_mix -- a cost_center's entry count + total
 *  spend for an event. */
export type BudgetCategoryMixRow = {
  cost_center_id: number | null
  cost_center_name: string
  cost_center_is_confirmed: boolean | null
  event_id: number | null
  entry_count: number
  total_amount: number
}

export type BudgetStructureSurfaceData = {
  eventName: string | null
  /** Echoed back from the URL param, validated to a positive integer or null. */
  revisionHeadId: number | null
  revisionHistory: { rows: BudgetRevisionHistoryRow[]; error: string | null }
  zoneCategoryMatrix: { rows: ZoneCategoryMatrixRow[]; error: string | null }
  budgetCategoryMix: { rows: BudgetCategoryMixRow[]; error: string | null }
}

const REVISION_SELECT =
  'allocation_id, budget_head_id, budget_head_label, department_id, department_name, event_id, import_batch_id, as_of, request_amount, approved_amount, utilised_amount, balance_amount, effective_amount, revision_seq, approved_delta, effective_delta, is_first, is_latest'

const MATRIX_SELECT =
  'zone_id, zone_name, zone_number, cost_center_id, cost_center_name, event_id, entry_count, total_amount'

const MIX_SELECT =
  'cost_center_id, cost_center_name, cost_center_is_confirmed, event_id, entry_count, total_amount'

export async function loadBudgetStructure(
  compareBasis: CompareBasis,
  revisionHeadId: number | null
): Promise<BudgetStructureSurfaceData> {
  void compareBasis

  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  const eventId = selectedEvent?.id ?? null

  const safeHeadId =
    revisionHeadId !== null && Number.isInteger(revisionHeadId) && revisionHeadId > 0 ? revisionHeadId : null

  const [revisionRes, matrixRes, mixRes] = await Promise.all([
    supabase
      .from('v_budget_revision_history')
      .select(REVISION_SELECT)
      .eq('event_id', eventId)
      .order('budget_head_id', { ascending: true })
      .order('revision_seq', { ascending: true })
      .limit(ROW_CAP)
      .returns<BudgetRevisionHistoryRow[]>(),
    supabase
      .from('v_zone_category_matrix')
      .select(MATRIX_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<ZoneCategoryMatrixRow[]>(),
    supabase
      .from('v_budget_category_mix')
      .select(MIX_SELECT)
      .eq('event_id', eventId)
      .order('total_amount', { ascending: false, nullsFirst: false })
      .limit(ROW_CAP)
      .returns<BudgetCategoryMixRow[]>(),
  ])

  return {
    eventName: selectedEvent?.name ?? null,
    revisionHeadId: safeHeadId,
    revisionHistory: {
      rows: revisionRes.data ?? [],
      error: friendlyDataError(revisionRes.error, 'reports:budget-structure:revision-history'),
    },
    zoneCategoryMatrix: {
      rows: matrixRes.data ?? [],
      error: friendlyDataError(matrixRes.error, 'reports:budget-structure:zone-category-matrix'),
    },
    budgetCategoryMix: {
      rows: mixRes.data ?? [],
      error: friendlyDataError(mixRes.error, 'reports:budget-structure:budget-category-mix'),
    },
  }
}
