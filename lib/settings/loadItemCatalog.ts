import type { SupabaseClient } from '@supabase/supabase-js'
import { friendlyDataError } from '@/lib/friendly-error'
import {
  sortLinesToAssign,
  toItemCatalogRow,
  toLineToAssignRow,
  type ItemCatalogRow,
  type ItemFamilyOption,
  type LineToAssignRow,
} from '@/lib/settings/item-catalog-shape'

export interface ItemCatalogData {
  items: ItemCatalogRow[]
  families: ItemFamilyOption[]
  linesToAssign: LineToAssignRow[]
  /** Friendly (never raw) message when any of the three reads failed. */
  error: string | null
}

/**
 * /settings/item-catalog loader. Three independent reads in parallel: the
 * per-item review view (counts + samples, 20261006120000), the family list
 * for the move / create pickers, and the to-assign queue view. The catalog
 * is org-wide (no event / department scope), so no eventId parameter.
 */
export async function loadItemCatalog(supabase: SupabaseClient): Promise<ItemCatalogData> {
  const [itemsRes, familiesRes, linesRes] = await Promise.all([
    supabase
      .from('v_item_catalog_review')
      .select(
        'id, item_key, canonical_label, item_family_id, family_label, category, unit_normalized, is_comparable, is_confirmed, confirmed_at, line_count, vendor_count, pretax_value, last_seen, alias_count, unconfirmed_alias_count, sample_descriptions',
      )
      .order('canonical_label')
      .range(0, 4999),
    supabase
      .from('item_family')
      .select('id, family_key, label, category, is_confirmed')
      .order('category')
      .order('label')
      .range(0, 1999),
    supabase
      .from('v_item_lines_to_assign')
      .select(
        'reason, normalized_description, raw_description, alias_id, confidence, item_catalog_id, canonical_label, family_label, line_count, vendor_count, pretax_value, last_seen, unit_normalized',
      )
      .range(0, 4999),
  ])

  const error =
    friendlyDataError(itemsRes.error, 'settings.loadItemCatalog:items') ??
    friendlyDataError(familiesRes.error, 'settings.loadItemCatalog:families') ??
    friendlyDataError(linesRes.error, 'settings.loadItemCatalog:lines')

  const items = (itemsRes.data ?? []).map((row) => toItemCatalogRow(row as Record<string, unknown>))
  const families: ItemFamilyOption[] = (familiesRes.data ?? []).map((row) => ({
    id: row.id as number,
    familyKey: row.family_key as string,
    label: row.label as string,
    category: (row.category as string | null) ?? null,
    isConfirmed: row.is_confirmed === true,
  }))
  const linesToAssign = sortLinesToAssign(
    (linesRes.data ?? []).flatMap((row) => {
      const mapped = toLineToAssignRow(row as Record<string, unknown>)
      return mapped ? [mapped] : []
    }),
  )

  return { items, families, linesToAssign, error }
}

export interface ItemCatalogCounts {
  itemCount: number
  unconfirmedItems: number
}

/** Count-only figures for the Settings landing row (head: true -- no payload). */
export async function getItemCatalogCounts(supabase: SupabaseClient): Promise<ItemCatalogCounts> {
  const [all, unconfirmed] = await Promise.all([
    supabase.from('item_catalog').select('*', { head: true, count: 'exact' }),
    supabase.from('item_catalog').select('*', { head: true, count: 'exact' }).eq('is_confirmed', false),
  ])
  return { itemCount: all.count ?? 0, unconfirmedItems: unconfirmed.count ?? 0 }
}
