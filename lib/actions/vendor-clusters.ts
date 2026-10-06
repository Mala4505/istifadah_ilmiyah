'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAdminOrAbove } from '@/lib/export/auth'
import { logRawError } from '@/lib/friendly-error'
import { dismissalPairs, MAX_CLUSTER_SIZE } from '@/lib/vendor-clusters/group'

type ActionResult = { ok: true } | { ok: false; error: string }

const memberIdsSchema = z
  .array(z.number().int().positive())
  .min(2, 'Pick at least two vendors.')
  .max(MAX_CLUSTER_SIZE, 'That group is too large to handle in one step.')
  .refine((ids) => new Set(ids).size === ids.length, 'A vendor is listed twice.')

const acceptSchema = z
  .object({ rootVendorId: z.number().int().positive(), memberVendorIds: memberIdsSchema })
  .refine((v) => v.memberVendorIds.includes(v.rootVendorId), 'The main vendor must be one of the group.')

function revalidateVendorSettings() {
  revalidatePath('/settings/vendors')
  revalidatePath('/settings')
}

/**
 * Accepts an automatic vendor-cluster proposal: every member except the
 * chosen root gets `cluster_group_id = root` (same write as admin.ts's
 * mergeVendor, applied to the whole group). Vendors already merged INTO a
 * member are re-pointed at the root first so the shape stays flat
 * (root + aliases, never a chain). Admin-or-above, matching the
 * vendor_update_admin RLS floor; writes go through the session client so RLS
 * still applies.
 */
export async function acceptVendorCluster(input: {
  rootVendorId: number
  memberVendorIds: number[]
}): Promise<ActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) return { ok: false, error: 'Merging vendors is an admin-only action.' }

  const parsed = acceptSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }
  const { rootVendorId, memberVendorIds } = parsed.data

  const supabase = await createClient()

  const { data: rows, error: readError } = await supabase
    .from('vendor')
    .select('id, display_name, cluster_group_id')
    .in('id', memberVendorIds)
    .returns<{ id: number; display_name: string; cluster_group_id: number | null }[]>()

  if (readError) return { ok: false, error: logRawError('vendorClusters.accept:read', readError.message) }
  if (!rows || rows.length !== memberVendorIds.length) {
    return { ok: false, error: 'One of these vendors no longer exists. Refresh the page and try again.' }
  }

  const root = rows.find((r) => r.id === rootVendorId)!
  if (root.cluster_group_id !== null) {
    return { ok: false, error: `"${root.display_name}" has since been merged elsewhere. Refresh the page and try again.` }
  }

  const toMerge: number[] = []
  for (const row of rows) {
    if (row.id === rootVendorId || row.cluster_group_id === rootVendorId) continue
    if (row.cluster_group_id !== null) {
      return { ok: false, error: `"${row.display_name}" has since been merged elsewhere. Refresh the page and try again.` }
    }
    toMerge.push(row.id)
  }
  if (toMerge.length === 0) return { ok: true }

  // Flatten: anything merged into a member now points straight at the root.
  const { error: repointError } = await supabase
    .from('vendor')
    .update({ cluster_group_id: rootVendorId })
    .in('cluster_group_id', toMerge)
  if (repointError) return { ok: false, error: logRawError('vendorClusters.accept:repoint', repointError.message) }

  const { data: merged, error: mergeError } = await supabase
    .from('vendor')
    .update({ cluster_group_id: rootVendorId, is_confirmed: true })
    .in('id', toMerge)
    .select('id')
  if (mergeError) return { ok: false, error: logRawError('vendorClusters.accept:merge', mergeError.message) }
  if ((merged ?? []).length !== toMerge.length) {
    // RLS silently filtered the update -- treat as a permissions problem.
    return { ok: false, error: 'Merging vendors is an admin-only action.' }
  }

  revalidateVendorSettings()
  return { ok: true }
}

/**
 * Dismisses a proposal: records every pair in the group as "not the same
 * entity" (vendor_cluster_dismissal), so the group stops being proposed.
 * A genuinely new link to an outside vendor can still surface later.
 */
export async function dismissVendorCluster(input: { vendorIds: number[] }): Promise<ActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) return { ok: false, error: 'Dismissing vendor suggestions is an admin-only action.' }

  const parsed = z.object({ vendorIds: memberIdsSchema }).safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { error } = await supabase
    .from('vendor_cluster_dismissal')
    .upsert(dismissalPairs(parsed.data.vendorIds), {
      onConflict: 'vendor_id_a,vendor_id_b',
      ignoreDuplicates: true,
    })

  if (error) return { ok: false, error: logRawError('vendorClusters.dismiss', error.message) }

  revalidateVendorSettings()
  return { ok: true }
}
