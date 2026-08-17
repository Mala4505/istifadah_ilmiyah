'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export interface SaveEntryEnrichmentInput {
  entryId: number
  adminHeadId: number | null
  zoneId: number | null
  costCenterId: number | null
  remark: string | null
}

export interface EntryActionResult {
  success: boolean
  error?: string
}

/**
 * Saves the Hub-owned enrichment fields on `entries` (MASTER-PLAN §3.4,
 * screen inventory row 4 in §5): `admin_head_id`, `zone_id`,
 * `cost_center_id`, `remark`. Never touched by import (§3.6's upsert
 * excludes these columns by construction) — this is the only writer.
 *
 * Uses the session-bound client (`lib/supabase/server.ts`), so
 * `entries_update` RLS (role in ('admin','reviewer'), department-scoped,
 * 20260808000026_rls_policies.sql) is the actual gate. A `viewer` role's
 * write matches 0 rows under RLS rather than erroring — that is turned into
 * an explicit `error` here for the caller to toast, per the task brief:
 * "surface that as a toast error rather than hiding the fields."
 */
export async function saveEntryEnrichment(
  input: SaveEntryEnrichmentInput
): Promise<EntryActionResult> {
  const { entryId } = input

  if (!Number.isInteger(entryId) || entryId <= 0) {
    return { success: false, error: 'Invalid entry.' }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('entries')
    .update({
      admin_head_id: input.adminHeadId,
      zone_id: input.zoneId,
      cost_center_id: input.costCenterId,
      remark: input.remark?.trim() || null,
    })
    .eq('id', entryId)
    .select('id')

  if (error) {
    return { success: false, error: error.message }
  }

  if (!data || data.length === 0) {
    return {
      success: false,
      error:
        'Nothing was saved. This usually means a viewer role (reviewer/admin required to edit enrichment fields), or the entry is outside your assigned department.',
    }
  }

  revalidatePath(`/entries/${entryId}`)
  revalidatePath('/entries')
  return { success: true }
}

export interface BulkSaveEntryEnrichmentInput {
  entryIds: number[]
  // `undefined` (the field simply absent/omitted) = "don't touch this column
  // for the batch". `null` = "clear this column for every selected entry."
  // A specific id = "set this column to that value for every selected entry."
  adminHeadId?: number | null
  zoneId?: number | null
  costCenterId?: number | null
}

export interface BulkEntryActionResult {
  success: boolean
  updatedCount: number
  requestedCount: number
  error?: string
}

/**
 * Bulk-sets the Hub-owned enrichment fields (`admin_head_id`, `zone_id`,
 * `cost_center_id`) across many entries in one action (hub-refinements-plan.md
 * §5/§6: bulk assignment "in addition to" the single-entry form above, which
 * keeps working unchanged). Mirrors `setHubStatus`'s (lib/actions/hub-status.ts)
 * bulk-update-with-count pattern: this runs on the session-bound client, so
 * `entries_update` RLS (role in ('admin','reviewer'), department-scoped) is the
 * actual gate, and a row outside the caller's access silently isn't updated
 * rather than erroring. This turns that into a countable partial-success
 * result (`updatedCount < requestedCount`) for the caller to toast, exactly
 * like the bulk Hub-status action.
 *
 * Field semantics deliberately differ from `saveEntryEnrichment` above: that
 * single-entry form always writes all three columns, because "leave this
 * dropdown at Not set" there is one human's explicit choice for one specific
 * row. Here, a field the caller doesn't include in the input at all means
 * "don't touch this column" for the whole batch — opt-in per field, not
 * all-or-nothing. Forcing every one of N selected entries (which may span
 * several departments/zones already) to the same cost center just because the
 * caller also wanted to bulk-set zone would be a much stronger, more
 * destructive claim than the plan asked for. An explicit `null` is still
 * honoured as "clear this field for all of them" — a deliberate batch clear,
 * distinct from "don't touch it."
 */
export async function bulkSaveEntryEnrichment(
  input: BulkSaveEntryEnrichmentInput
): Promise<BulkEntryActionResult> {
  const cleanIds = Array.from(new Set(input.entryIds)).filter((id) => Number.isInteger(id) && id > 0)
  const requestedCount = cleanIds.length

  if (requestedCount === 0) {
    return { success: false, updatedCount: 0, requestedCount, error: 'No entries selected.' }
  }

  // Only include a column in the patch if the caller actually set it (opt-in
  // per field, see header comment) — `undefined` means "omit", `null` means
  // "clear."
  const patch: Record<string, number | null> = {}
  if (input.adminHeadId !== undefined) patch.admin_head_id = input.adminHeadId
  if (input.zoneId !== undefined) patch.zone_id = input.zoneId
  if (input.costCenterId !== undefined) patch.cost_center_id = input.costCenterId

  if (Object.keys(patch).length === 0) {
    return { success: false, updatedCount: 0, requestedCount, error: 'Choose at least one field to set or clear.' }
  }

  const supabase = await createClient()

  const { data, error } = await supabase.from('entries').update(patch).in('id', cleanIds).select('id')

  if (error) {
    return { success: false, updatedCount: 0, requestedCount, error: error.message }
  }

  const updatedCount = data?.length ?? 0

  if (updatedCount === 0) {
    return {
      success: false,
      updatedCount: 0,
      requestedCount,
      error:
        'No entries were updated. This usually means a viewer role (reviewer/admin required to edit enrichment fields), or the entries are outside your assigned department.',
    }
  }

  for (const id of cleanIds) {
    revalidatePath(`/entries/${id}`)
  }
  revalidatePath('/entries')

  if (updatedCount < requestedCount) {
    return {
      success: true,
      updatedCount,
      requestedCount,
      error: `${requestedCount - updatedCount} of ${requestedCount} selected entries could not be updated (permission or department scope).`,
    }
  }

  return { success: true, updatedCount, requestedCount }
}

/**
 * Sets or clears `entries.settles_entry_id` — the advance-settlement link
 * (§3.4: "this invoice settles that advance"; §5 row 4: "the
 * advance-settlement picker lives here"). Same RLS gate as
 * `saveEntryEnrichment` above; kept as a separate action because the
 * picker (components/entries/detail/advance-settlement-picker.tsx) saves
 * independently of the rest of the enrichment form.
 */
export async function setSettlesEntry(
  entryId: number,
  settlesEntryId: number | null
): Promise<EntryActionResult> {
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return { success: false, error: 'Invalid entry.' }
  }
  if (settlesEntryId !== null && (!Number.isInteger(settlesEntryId) || settlesEntryId <= 0)) {
    return { success: false, error: 'Invalid advance entry.' }
  }
  if (settlesEntryId === entryId) {
    return { success: false, error: 'An entry cannot settle itself.' }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('entries')
    .update({ settles_entry_id: settlesEntryId })
    .eq('id', entryId)
    .select('id')

  if (error) {
    return { success: false, error: error.message }
  }
  if (!data || data.length === 0) {
    return {
      success: false,
      error:
        'Nothing was saved. This usually means a viewer role (reviewer/admin required), or the entry is outside your assigned department.',
    }
  }

  revalidatePath(`/entries/${entryId}`)
  return { success: true }
}

export interface AdvancePaymentSearchResult {
  id: number
  ubbl_number: string
  main_number: string | null
  vendor_display_name: string | null
  vendor_raw: string | null
  amount: number | null
  date: string | null
}

/**
 * Search among `type = 'advance_payment'` entries by UBBL number or vendor,
 * for the advance-settlement picker (§5 row 4). Reads `v_entry_enriched`
 * (§10.2) — a `security_invoker` view, so RLS on the underlying `entries`
 * table still scopes results to departments the caller can see (§4.4).
 */
export async function searchAdvancePaymentEntries(
  query: string,
  departmentId: number | null
): Promise<AdvancePaymentSearchResult[]> {
  const supabase = await createClient()
  const term = query.trim()

  let request = supabase
    .from('v_entry_enriched')
    .select('id, ubbl_number, main_number, vendor_display_name, vendor_raw, amount, date')
    .eq('type', 'advance_payment')
    .eq('is_void', false)
    .order('date', { ascending: false })
    .limit(20)

  if (departmentId !== null) {
    request = request.eq('department_id', departmentId)
  }

  if (term) {
    const escaped = term.replace(/[%_]/g, (m) => `\\${m}`)
    request = request.or(
      `ubbl_number.ilike.%${escaped}%,vendor_display_name.ilike.%${escaped}%,vendor_raw.ilike.%${escaped}%`
    )
  }

  const { data, error } = await request

  if (error || !data) {
    return []
  }
  return data as AdvancePaymentSearchResult[]
}
