import type { SupabaseClient } from '@supabase/supabase-js'
import { friendlyDataError } from '@/lib/friendly-error'
import {
  buildClusterProposals,
  type CandidateEdgeRow,
  type ProposalVendor,
  type VendorClusterProposal,
} from '@/lib/vendor-clusters/group'

export interface VendorClusterProposalsData {
  proposals: VendorClusterProposal[]
  error: string | null
}

/** Size bound, not a correctness guarantee -- see B-07's loader note. */
const EDGE_CAP = 2000

/**
 * Settings -> Vendors: automatic vendor-cluster proposals. Reads
 * v_vendor_cluster_candidate_edges (already excludes same-cluster and
 * dismissed pairs), then loads the member vendors' identity fields and groups
 * edges into connected components.
 */
export async function loadVendorClusterProposals(supabase: SupabaseClient): Promise<VendorClusterProposalsData> {
  const edgesRes = await supabase
    .from('v_vendor_cluster_candidate_edges')
    .select('vendor_id_a, vendor_id_b, reason, detail, score')
    .order('vendor_id_a', { ascending: true })
    .order('vendor_id_b', { ascending: true })
    .limit(EDGE_CAP)
    .returns<CandidateEdgeRow[]>()

  if (edgesRes.error) {
    return { proposals: [], error: friendlyDataError(edgesRes.error, 'settings:vendor-cluster-proposals:edges') }
  }

  const edges = edgesRes.data ?? []
  if (edges.length === 0) return { proposals: [], error: null }

  const ids = [...new Set(edges.flatMap((e) => [e.vendor_id_a, e.vendor_id_b]))]
  const vendorsRes = await supabase
    .from('vendor')
    .select('id, display_name, gstin, phone, address, is_confirmed')
    .in('id', ids)
    .returns<
      { id: number; display_name: string; gstin: string | null; phone: string | null; address: string | null; is_confirmed: boolean }[]
    >()

  if (vendorsRes.error) {
    return { proposals: [], error: friendlyDataError(vendorsRes.error, 'settings:vendor-cluster-proposals:vendors') }
  }

  const vendorsById = new Map<number, ProposalVendor>()
  for (const row of vendorsRes.data ?? []) {
    vendorsById.set(row.id, {
      id: row.id,
      displayName: row.display_name,
      gstin: row.gstin,
      phone: row.phone,
      address: row.address,
      isConfirmed: row.is_confirmed,
    })
  }

  return { proposals: buildClusterProposals(edges, vendorsById), error: null }
}
