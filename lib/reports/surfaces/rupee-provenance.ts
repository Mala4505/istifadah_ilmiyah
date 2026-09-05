/**
 * Data loader for E-05 -- Rupee provenance trace (reporting-blueprint.md §8
 * Phase Six / §3 E-05): "Pick any rupee and follow it live: budget head ->
 * allocation -> entry -> the bill image -> the line item -> the item family
 * -> the benchmark."
 *
 * Server-rendered drill keyed on a URL search param (`?trace_entry_id=<id>`),
 * NOT a client SPA -- matches the app's "every figure is a link" pattern
 * (§6 fix #4) and keeps the section a Server Component. The small
 * `<RupeeProvenancePicker>` client child only writes the search param; the
 * chain is resolved here, server-side, from the selected id.
 *
 * Two backing views (20260903000012_rupee_provenance_views.sql):
 *   v_rupee_provenance_entry -- one row per non-void entry; the candidate
 *     index for the picker AND the resolved chain head.
 *   v_rupee_provenance_line  -- one row per line item of the entry's bill,
 *     with item-family + rate-benchmark attached where they resolve (null on
 *     most of the corpus -- backfilled separately, handled gracefully).
 *
 * The "allocation" step is pulled from the existing v_budget_vs_actual
 * (20260822000007) by (budget_head_id, event_id) rather than re-deriving the
 * latest-snapshot logic here.
 *
 * `compareBasis` is accepted for signature parity with the other surface
 * loaders but unused: a provenance trace of a single rupee has no
 * prior-period delta to show.
 */
import { createClient } from '@/lib/supabase/server'
import { getSelectedEvent } from '@/lib/events/current'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'

/** Number of candidate entries offered in the picker when nothing is selected
 *  yet -- the largest by amount, "pick any rupee" starts from the big ones. */
const CANDIDATE_LIMIT = 50

/** One row of v_rupee_provenance_entry -- a non-void entry with every
 *  dimension id + label the trace renders as a step, plus the bill scalars.
 *  Field names match the view's select list verbatim. */
export type RupeeProvenanceEntryRow = {
  entry_id: number
  ubbl_number: string
  entry_amount: number | null
  entry_date: string | null
  entry_type: string
  invoice_number: string | null
  department_id: number | null
  department_name: string | null
  sub_department_id: number | null
  sub_department_name: string | null
  admin_head_id: number | null
  admin_head_name: string | null
  vendor_id: number | null
  vendor_display_name: string | null
  budget_head_id: number | null
  budget_head_label: string | null
  budget_head_short_label: string | null
  /** The blueprint's "budget category" == the table renamed budget_category ->
   *  cost_center (20260813000004). Resolved via entries.cost_center_id; often
   *  null (a hub-enrichment field, not import-owned). */
  budget_category_id: number | null
  budget_category_label: string | null
  zone_id: number | null
  zone_name: string | null
  source_document_id: number | null
  document_extraction_id: number | null
  instrument_type: string | null
  bill_total_verified: number | null
  bill_total_ocr: number | null
  bill_verified_at: string | null
  has_bill_image: boolean
  line_item_count: number
  event_id: number | null
}

/** One row of v_rupee_provenance_line -- one line item of the entry's bill.
 *  item_family_* / benchmark_* are null until the line is classified against
 *  the catalogue (backfilled separately). */
export type RupeeProvenanceLineRow = {
  entry_id: number | null
  document_extraction_id: number
  line_item_id: number
  line_number: number
  description: string | null
  hsn_sac: string | null
  quantity: number | null
  unit: string | null
  unit_normalized: string | null
  net_rate: number | null
  line_amount: number | null
  /** Free-text discount note off the line ("10%+5%") -- NOT a number. */
  discount_note: string | null
  rate_reference_id: number | null
  /** Numeric discount %, from rate_reference -- populated only by the
   *  pre-20260820000003 verify bodies, so usually null. */
  discount_pct: number | null
  item_family_id: number | null
  item_family_label: string | null
  item_catalog_id: number | null
  item_catalog_label: string | null
  benchmark_median_rate: number | null
  benchmark_observation_count: number | null
  benchmark_vendor_count: number | null
  rate_vs_benchmark_pct: number | null
  department_id: number | null
  event_id: number | null
}

/** The approved-allocation figure for the traced entry's budget head, pulled
 *  from v_budget_vs_actual (latest snapshot per (budget_head_id, event_id)). */
export type RupeeProvenanceAllocation = {
  approvedAmount: number | null
  asOf: string | null
  actualAmount: number | null
  pctOfApproved: number | null
  budgetStatusNote: string | null
}

export type RupeeProvenanceChain = {
  entry: RupeeProvenanceEntryRow
  lines: RupeeProvenanceLineRow[]
  linesError: string | null
  allocation: RupeeProvenanceAllocation | null
  allocationError: string | null
}

export type RupeeProvenanceSurfaceData = {
  eventName: string | null
  traceEntryId: number | null
  /** Top CANDIDATE_LIMIT non-void entries by amount for the active event --
   *  what the picker lists before an id is chosen. */
  candidates: RupeeProvenanceEntryRow[]
  candidatesError: string | null
  /** Resolved chain for `traceEntryId`, or null when no id is selected or the
   *  id matched no visible entry. */
  chain: RupeeProvenanceChain | null
}

const ENTRY_SELECT =
  'entry_id, ubbl_number, entry_amount, entry_date, entry_type, invoice_number, department_id, department_name, sub_department_id, sub_department_name, admin_head_id, admin_head_name, vendor_id, vendor_display_name, budget_head_id, budget_head_label, budget_head_short_label, budget_category_id, budget_category_label, zone_id, zone_name, source_document_id, document_extraction_id, instrument_type, bill_total_verified, bill_total_ocr, bill_verified_at, has_bill_image, line_item_count, event_id'

const LINE_SELECT =
  'entry_id, document_extraction_id, line_item_id, line_number, description, hsn_sac, quantity, unit, unit_normalized, net_rate, line_amount, discount_note, rate_reference_id, discount_pct, item_family_id, item_family_label, item_catalog_id, item_catalog_label, benchmark_median_rate, benchmark_observation_count, benchmark_vendor_count, rate_vs_benchmark_pct, department_id, event_id'

const ALLOCATION_SELECT = 'approved_amount, as_of, actual_amount, pct_of_approved, budget_status_note'

export async function loadRupeeProvenance(
  compareBasis: CompareBasis,
  traceEntryId: number | null
): Promise<RupeeProvenanceSurfaceData> {
  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent()
  const eventId = selectedEvent?.id ?? null

  const candidatesRes = await supabase
    .from('v_rupee_provenance_entry')
    .select(ENTRY_SELECT)
    .eq('event_id', eventId)
    .order('entry_amount', { ascending: false, nullsFirst: false })
    .limit(CANDIDATE_LIMIT)
    .returns<RupeeProvenanceEntryRow[]>()

  const candidates = candidatesRes.data ?? []
  const candidatesError = friendlyDataError(candidatesRes.error, 'reports:explore:rupee-provenance:candidates')

  let chain: RupeeProvenanceChain | null = null

  if (traceEntryId !== null && Number.isInteger(traceEntryId) && traceEntryId > 0) {
    const entryRes = await supabase
      .from('v_rupee_provenance_entry')
      .select(ENTRY_SELECT)
      .eq('entry_id', traceEntryId)
      .maybeSingle()

    const entry = (entryRes.data as unknown as RupeeProvenanceEntryRow | null) ?? null

    if (entry) {
      const linesRes = await supabase
        .from('v_rupee_provenance_line')
        .select(LINE_SELECT)
        .eq('entry_id', traceEntryId)
        .order('line_number', { ascending: true })
        .returns<RupeeProvenanceLineRow[]>()

      let allocation: RupeeProvenanceAllocation | null = null
      let allocationError: string | null = null

      if (entry.budget_head_id !== null) {
        const allocationQuery = supabase
          .from('v_budget_vs_actual')
          .select(ALLOCATION_SELECT)
          .eq('budget_head_id', entry.budget_head_id)
        const allocationRes = await (entry.event_id === null
          ? allocationQuery.is('event_id', null)
          : allocationQuery.eq('event_id', entry.event_id)
        ).maybeSingle()

        allocationError = friendlyDataError(allocationRes.error, 'reports:explore:rupee-provenance:allocation')

        const allocationData = allocationRes.data as unknown as {
          approved_amount: number | null
          as_of: string | null
          actual_amount: number | null
          pct_of_approved: number | null
          budget_status_note: string | null
        } | null

        if (allocationData) {
          allocation = {
            approvedAmount: allocationData.approved_amount,
            asOf: allocationData.as_of,
            actualAmount: allocationData.actual_amount,
            pctOfApproved: allocationData.pct_of_approved,
            budgetStatusNote: allocationData.budget_status_note,
          }
        }
      }

      chain = {
        entry,
        lines: linesRes.data ?? [],
        linesError: friendlyDataError(linesRes.error, 'reports:explore:rupee-provenance:lines'),
        allocation,
        allocationError,
      }
    }
  }

  return {
    eventName: selectedEvent?.name ?? null,
    traceEntryId,
    candidates,
    candidatesError,
    chain,
  }
}
