/**
 * Data loader for reporting-blueprint.md Phase 5, Family B: B-07 Related-party
 * cluster map + B-08 GSTIN validity & tax exposure. New surface file (not
 * merged into vendors.ts by this pass -- see INTEGRATION NOTES in the
 * hand-off report for where the parent wires it in).
 *
 * B-07 has no event scoping (vendor identity -- shared GSTIN/phone/address --
 * is a whole-corpus property, same reasoning v_vendor_concentration documents
 * for vendor.is_confirmed), so there is no prior-period delta for it; the
 * cluster-count KpiTile's `delta` slot is repurposed to carry "N vendors
 * involved" instead of a period comparison (see the section component).
 * B-08 IS event-scoped (tax charged per event), so it gets the usual
 * resolvePreviousEvent prior-event delta on ₹ at risk.
 *
 * v_vendor_shared_identity_edges gives pairwise edges only (vendor_id_a,
 * vendor_id_b, shared_on, shared_value) -- turning those into clusters
 * (connected components) is a graph problem Postgres has no clean built-in
 * for, so it happens here with a small Union-Find over the (small, tens-of-
 * vendors) edge set.
 */
import { createClient } from '@/lib/supabase/server'
import type { Event } from '@/lib/events/types'
import { friendlyDataError } from '@/lib/friendly-error'
import type { CompareBasis } from '@/lib/reports/compare-basis'
import {
  ROW_CAP,
  resolvePreviousEvent,
  type VendorSharedIdentityEdgeRow,
  type TaxCreditExposureRow,
  type VendorCluster,
} from '@/lib/reports/sections/shared'

// VendorSharedIdentityEdgeRow / TaxCreditExposureRow / VendorCluster now live
// in lib/reports/sections/shared.tsx (hoisted during Phase Five integration);
// re-exported here so existing imports from this loader file keep working.
export type { VendorSharedIdentityEdgeRow, TaxCreditExposureRow, VendorCluster }

const EDGE_SELECT = 'vendor_id_a, vendor_name_a, vendor_id_b, vendor_name_b, shared_on, shared_value'
const TAX_EXPOSURE_SELECT =
  'vendor_id, vendor_display_name, department_id, department_name, event_id, bill_count, total_tax_amount, at_risk_tax_amount, claimable_tax_amount'

/** Union-Find over the edge list, then group vendors by root and attach the
 *  edges internal to each group. Clusters are returned sorted by combined
 *  spend descending (largest first) so callers can cap/lead with the biggest
 *  without re-sorting. */
export function buildVendorClusters(
  edges: VendorSharedIdentityEdgeRow[],
  spendByVendorId: Map<number, number>
): VendorCluster[] {
  const parent = new Map<number, number>()
  const names = new Map<number, string>()

  function find(x: number): number {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // Path compression.
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  function ensure(id: number, name: string) {
    if (!parent.has(id)) parent.set(id, id)
    if (!names.has(id)) names.set(id, name)
  }
  function union(a: number, b: number) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const e of edges) {
    ensure(e.vendor_id_a, e.vendor_name_a)
    ensure(e.vendor_id_b, e.vendor_name_b)
    union(e.vendor_id_a, e.vendor_id_b)
  }

  const vendorIdsByRoot = new Map<number, Set<number>>()
  for (const id of parent.keys()) {
    const root = find(id)
    const set = vendorIdsByRoot.get(root) ?? new Set<number>()
    set.add(id)
    vendorIdsByRoot.set(root, set)
  }

  const clusters: VendorCluster[] = []
  let clusterId = 0
  for (const [root, vendorIds] of vendorIdsByRoot) {
    if (vendorIds.size < 2) continue // a lone vendor with no live edge isn't a cluster
    clusterId += 1
    const vendors = [...vendorIds].map((id) => ({
      id,
      name: names.get(id) ?? `#${id}`,
      spend: spendByVendorId.get(id) ?? 0,
    }))
    const clusterEdges = edges
      .filter((e) => find(e.vendor_id_a) === root && find(e.vendor_id_b) === root)
      .map((e) => ({
        vendorIdA: e.vendor_id_a,
        vendorIdB: e.vendor_id_b,
        sharedOn: e.shared_on,
        sharedValue: e.shared_value,
      }))
    clusters.push({
      clusterId,
      vendors: vendors.sort((a, b) => b.spend - a.spend),
      edges: clusterEdges,
      combinedSpend: vendors.reduce((s, v) => s + v.spend, 0),
    })
  }

  return clusters.sort((a, b) => b.combinedSpend - a.combinedSpend)
}

export type RelatedPartyGstinData = {
  eventName: string | null
  previousEventName: string | null
  relatedPartyClusters: {
    edges: VendorSharedIdentityEdgeRow[]
    clusters: VendorCluster[]
    error: string | null
  }
  taxCreditExposure: {
    rows: TaxCreditExposureRow[]
    error: string | null
    previousAtRiskTotal: number | null
  }
}

/**
 * Perf remediation Phase 2.2 (docs/performance-remediation-plan.md):
 * `selectedEvent` is resolved once by the caller (the page already
 * called getSelectedEvent()) and passed in, rather than this loader
 * re-resolving it itself -- same reasoning as loadHeroMetrics/
 * loadExecutiveBrief taking `eventId` as a parameter.
 */
export async function loadRelatedPartyGstin(compareBasis: CompareBasis, selectedEvent: Event | null): Promise<RelatedPartyGstinData> {
  const supabase = await createClient()
  const eventId = selectedEvent?.id ?? null

  const [edgesRes, taxRes] = await Promise.all([
    // Perf remediation 4.4: the only view query in this directory that ran
    // with no cap at all -- deliberately not event-scoped (see header
    // comment), so it grows with the whole vendor corpus rather than the
    // active event. ROW_CAP matches every other surface's cap for
    // consistency, not because 1000 edges has special meaning here.
    //
    // Judgment call: ordering by shared_on/shared_value has no bearing on
    // which edges matter most, because "which edges matter" is a property of
    // the connected components buildVendorClusters() derives AFTER all edges
    // are in hand -- no per-row column can be sorted on to guarantee a cap
    // doesn't cut the one edge bridging two dense subgraphs, which would
    // silently present one real cluster as two smaller ones. Ordering by
    // (vendor_id_a, vendor_id_b) at least makes the cap deterministic across
    // requests rather than picking an arbitrary 1000 out of an unordered set.
    // At today's volumes (view header: "tens of vendors, not thousands") this
    // is far from biting; flagged here so a future re-audit at 10x the vendor
    // count knows the cap is a size bound, not a correctness guarantee.
    supabase
      .from('v_vendor_shared_identity_edges')
      .select(EDGE_SELECT)
      .order('vendor_id_a', { ascending: true })
      .order('vendor_id_b', { ascending: true })
      .limit(ROW_CAP)
      .returns<VendorSharedIdentityEdgeRow[]>(),
    supabase
      .from('v_tax_credit_exposure')
      .select(TAX_EXPOSURE_SELECT)
      .eq('event_id', eventId)
      .order('at_risk_tax_amount', { ascending: false })
      .limit(ROW_CAP)
      .returns<TaxCreditExposureRow[]>(),
  ])

  const edges = edgesRes.data ?? []
  const vendorIds = [...new Set(edges.flatMap((e) => [e.vendor_id_a, e.vendor_id_b]))]

  // B-07 has no event scoping of its own, but a vendor's "spend" (for node
  // sizing / "largest cluster by combined spend") is still read for the
  // active event, same as every other spend figure on this screen.
  let spendByVendorId = new Map<number, number>()
  if (vendorIds.length > 0) {
    const spendRes = await supabase
      .from('v_vendor_spend')
      .select('vendor_id, total_amount')
      .eq('event_id', eventId)
      .in('vendor_id', vendorIds)
      .returns<{ vendor_id: number; total_amount: number | null }[]>()
    spendByVendorId = new Map((spendRes.data ?? []).map((r) => [r.vendor_id, r.total_amount ?? 0]))
  }

  const clusters = buildVendorClusters(edges, spendByVendorId)

  const previousEvent = await resolvePreviousEvent(supabase, compareBasis, eventId)
  let previousAtRiskTotal: number | null = null
  if (previousEvent) {
    const pTax = await supabase
      .from('v_tax_credit_exposure')
      .select('at_risk_tax_amount')
      .eq('event_id', previousEvent.id)
      .returns<{ at_risk_tax_amount: number }[]>()
    previousAtRiskTotal = (pTax.data ?? []).reduce((s, r) => s + (r.at_risk_tax_amount ?? 0), 0)
  }

  return {
    eventName: selectedEvent?.name ?? null,
    previousEventName: previousEvent?.name ?? null,
    relatedPartyClusters: {
      edges,
      clusters,
      error: friendlyDataError(edgesRes.error, 'reports:related-party:edges'),
    },
    taxCreditExposure: {
      rows: taxRes.data ?? [],
      error: friendlyDataError(taxRes.error, 'reports:tax-exposure'),
      previousAtRiskTotal,
    },
  }
}
