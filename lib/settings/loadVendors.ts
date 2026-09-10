import type { SupabaseClient } from '@supabase/supabase-js'
import type { VendorRow } from '@/components/admin/vendor-merge-panel'

export interface VendorsData {
  vendors: VendorRow[]
}

/**
 * Vendors area loader (Phase 2 Settings redesign). Vendors are not
 * event-scoped -- the `eventId` parameter is accepted only so every
 * per-area loader shares one `(supabase, eventId?)` signature.
 */
export async function loadVendors(
  supabase: SupabaseClient,
  _eventId?: number | null,
): Promise<VendorsData> {
  void _eventId

  const { data: vendorsData } = await supabase
    .from('vendor')
    .select('id, display_name, normalized_name, gstin, cluster_group_id, is_confirmed')
    .order('display_name')

  const vendors: VendorRow[] = (vendorsData ?? []).map((row) => ({
    id: row.id as number,
    displayName: row.display_name as string,
    normalizedName: row.normalized_name as string,
    gstin: row.gstin as string | null,
    clusterGroupId: row.cluster_group_id as number | null,
    isConfirmed: row.is_confirmed as boolean,
  }))

  return { vendors }
}
