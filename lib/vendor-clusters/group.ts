/**
 * Pure grouping for vendor-cluster PROPOSALS (Settings -> Vendors). Plain
 * module (no 'use client', no server-only imports) so the Server Component
 * loader, the client panel and the server actions can all import it.
 *
 * Input is the pairwise edge list from v_vendor_cluster_candidate_edges
 * (20261006110000_vendor_cluster_proposals.sql) -- one row per (root pair,
 * reason). Output is connected components (A~B, B~C => {A,B,C}) via
 * Union-Find, same approach as B-07's buildVendorClusters.
 */

export const CLUSTER_REASONS = ['gstin', 'gstin_pan', 'phone', 'address', 'similar_name'] as const
export type ClusterReason = (typeof CLUSTER_REASONS)[number]

/** Shown in the UI; also the strength ordering (strongest first). */
export const CLUSTER_REASON_LABEL: Record<ClusterReason, string> = {
  gstin: 'Same GSTIN',
  gstin_pan: 'Same PAN in GSTIN',
  phone: 'Same phone',
  address: 'Same / similar address',
  similar_name: 'Similar name',
}

export type CandidateEdgeRow = {
  vendor_id_a: number
  vendor_id_b: number
  reason: string
  detail: string | null
  score: number | null
}

export type ProposalVendor = {
  id: number
  displayName: string
  gstin: string | null
  phone: string | null
  address: string | null
  isConfirmed: boolean
}

export type ProposalEdge = {
  vendorIdA: number
  vendorIdB: number
  reason: ClusterReason
  detail: string | null
  score: number | null
}

export type VendorClusterProposal = {
  /** Sorted member ids joined by '-' -- stable React key. */
  key: string
  vendors: ProposalVendor[]
  edges: ProposalEdge[]
  /** Distinct reasons present, strongest first. */
  reasons: ClusterReason[]
  suggestedRootId: number
}

/** Hard cap on cluster size accepted/dismissed in one action. */
export const MAX_CLUSTER_SIZE = 50

function isReason(value: string): value is ClusterReason {
  return (CLUSTER_REASONS as readonly string[]).includes(value)
}

function reasonRank(reason: ClusterReason): number {
  return CLUSTER_REASONS.indexOf(reason)
}

/** Confirmed first, then one carrying a GSTIN, then the oldest (lowest id). */
export function pickSuggestedRoot(vendors: ProposalVendor[]): number {
  const compare = (a: ProposalVendor, b: ProposalVendor) =>
    Number(b.isConfirmed) - Number(a.isConfirmed) || Number(Boolean(b.gstin)) - Number(Boolean(a.gstin)) || a.id - b.id
  let best = vendors[0]!
  for (const v of vendors) if (compare(v, best) < 0) best = v
  return best.id
}

export function buildClusterProposals(
  edges: CandidateEdgeRow[],
  vendorsById: Map<number, ProposalVendor>,
): VendorClusterProposal[] {
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  const usable: ProposalEdge[] = []
  for (const e of edges) {
    if (!isReason(e.reason)) continue
    // An endpoint we couldn't load (deleted between queries) can't be acted on.
    if (!vendorsById.has(e.vendor_id_a) || !vendorsById.has(e.vendor_id_b)) continue
    if (e.vendor_id_a === e.vendor_id_b) continue
    usable.push({
      vendorIdA: e.vendor_id_a,
      vendorIdB: e.vendor_id_b,
      reason: e.reason,
      detail: e.detail,
      score: e.score,
    })
    for (const id of [e.vendor_id_a, e.vendor_id_b]) if (!parent.has(id)) parent.set(id, id)
    const ra = find(e.vendor_id_a)
    const rb = find(e.vendor_id_b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const byRoot = new Map<number, { ids: Set<number>; edges: ProposalEdge[] }>()
  for (const edge of usable) {
    const root = find(edge.vendorIdA)
    const group = byRoot.get(root) ?? { ids: new Set<number>(), edges: [] }
    group.ids.add(edge.vendorIdA)
    group.ids.add(edge.vendorIdB)
    group.edges.push(edge)
    byRoot.set(root, group)
  }

  const proposals: VendorClusterProposal[] = []
  for (const { ids, edges: groupEdges } of byRoot.values()) {
    const sortedIds = [...ids].sort((a, b) => a - b)
    const vendors = sortedIds.map((id) => vendorsById.get(id)!)
    const reasons = [...new Set(groupEdges.map((e) => e.reason))].sort((a, b) => reasonRank(a) - reasonRank(b))
    proposals.push({
      key: sortedIds.join('-'),
      vendors: vendors.toSorted((a, b) => a.displayName.localeCompare(b.displayName)),
      edges: groupEdges.toSorted((a, b) => reasonRank(a.reason) - reasonRank(b.reason)),
      reasons,
      suggestedRootId: pickSuggestedRoot(vendors),
    })
  }

  // Strongest evidence first, then bigger clusters, then stable by key.
  return proposals.sort(
    (a, b) =>
      reasonRank(a.reasons[0]!) - reasonRank(b.reasons[0]!) ||
      b.vendors.length - a.vendors.length ||
      a.key.localeCompare(b.key),
  )
}

/** Every unordered pair (a < b) among `ids` -- the dismissal rows for a cluster. */
export function dismissalPairs(ids: number[]): Array<{ vendor_id_a: number; vendor_id_b: number }> {
  const unique = [...new Set(ids)].sort((a, b) => a - b)
  const pairs: Array<{ vendor_id_a: number; vendor_id_b: number }> = []
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      pairs.push({ vendor_id_a: unique[i]!, vendor_id_b: unique[j]! })
    }
  }
  return pairs
}
