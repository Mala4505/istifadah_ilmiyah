/**
 * Data loader for C-02 Purchase tree (flagship) -- reporting-blueprint.md §3
 * Family C / §4: "Item family → catalogue item → vendor → the specific
 * bills, drillable at every level. The exploration surface for 'where did
 * ₹X actually go'."
 *
 * Single-view surface over v_purchase_tree
 * (20260903000003_purchase_tree_view.sql) -- one row per rate_reference
 * observation carrying every level's id + label, so the chart builds the
 * whole family → catalog → vendor → bill tree client-side from one flat
 * array (no per-level query). `event_id` is a plain output column on the
 * view; filtered here at the query site (blueprint §5.2 convention).
 *
 * Prior-period comparison (§6 fix #1): the headline is total tree spend
 * (sum of line_amount) for the active event. 'prior_event' re-runs a
 * line_amount-only query against the previous event for the delta;
 * 'prior_week' has no effect -- the view carries no as-of dimension a
 * week-old snapshot could be re-derived from (same reasoning
 * lib/reports/surfaces/vendors.ts documents for its own aggregates).
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import { ROW_CAP, resolvePreviousEvent, round2Local, type PurchaseTreeRow } from '@/lib/reports/sections/shared'

// PurchaseTreeRow now lives in lib/reports/sections/shared.tsx (hoisted during
// Phase Five integration, alongside every other Phase Four/Five row type);
// re-exported here so existing `import { type PurchaseTreeRow } from
// '@/lib/reports/surfaces/purchase-tree'` sites keep working unchanged.
export type { PurchaseTreeRow }

export type PurchaseTreeSurfaceData = {
  eventName: string | null
  previousEventName: string | null
  purchaseTree: {
    rows: PurchaseTreeRow[]
    error: string | null
    previousTotal: number | null
  }
}

const PURCHASE_TREE_SELECT =
  'item_family_id, family_key, family_label, item_catalog_id, catalog_label, vendor_id, vendor_display_name, entry_id, invoice_number, net_rate, quantity, line_amount, observed_date, department_id, department_name, event_id'

export async function loadPurchaseTree(compareBasis: CompareBasis): Promise<PurchaseTreeSurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent(supabase)
  const eventId = selectedEvent?.id ?? null

  const treeRes = await supabase
    .from('v_purchase_tree')
    .select(PURCHASE_TREE_SELECT)
    .eq('event_id', eventId)
    .order('line_amount', { ascending: false })
    .limit(ROW_CAP)
    .returns<PurchaseTreeRow[]>()

  const rows = treeRes.data ?? []

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousTotal: number | null = null
  if (previousEvent) {
    const priorRes = await supabase
      .from('v_purchase_tree')
      .select('line_amount')
      .eq('event_id', previousEvent.id)
      .limit(ROW_CAP)
      .returns<{ line_amount: number }[]>()
    previousTotal = round2Local((priorRes.data ?? []).reduce((s, r) => s + (r.line_amount ?? 0), 0))
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    purchaseTree: {
      rows,
      error: friendlyDataError(treeRes.error, 'reports:vendors:purchase-tree'),
      previousTotal,
    },
  }
}
