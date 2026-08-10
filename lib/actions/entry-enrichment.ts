'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export interface SaveEntryEnrichmentInput {
  entryId: number
  adminHeadId: number | null
  zoneId: number | null
  budgetCategoryId: number | null
  remark: string | null
}

export interface EntryActionResult {
  success: boolean
  error?: string
}

/**
 * Saves the Hub-owned enrichment fields on `entries` (MASTER-PLAN §3.4,
 * screen inventory row 4 in §5): `admin_head_id`, `zone_id`,
 * `budget_category_id`, `remark`. Never touched by import (§3.6's upsert
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
      budget_category_id: input.budgetCategoryId,
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
