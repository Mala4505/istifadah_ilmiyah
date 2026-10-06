'use server'

/**
 * Server actions for /settings/item-catalog -- the human-confirmation step for
 * the auto-mapped item catalog (MASTER-PLAN Phase 2; families back-fill in
 * 20261005084229, RPCs in 20261006120000). Every action checks
 * requireSuperadmin() first so anyone else gets a plain sentence instead of
 * a Postgres exception; the RPCs re-check private.is_superadmin() as the
 * real boundary (20261006130000). Raw errors go to logRawError -- the client routes whatever
 * comes back through toastError, never onto the screen verbatim.
 */

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSuperadmin } from '@/lib/export/auth'
import { logRawError } from '@/lib/friendly-error'

export type ItemCatalogActionResult = { ok: true } | { ok: false; error: string }
export type CreateItemResult = { ok: true; itemId: number } | { ok: false; error: string }

const PATH = '/settings/item-catalog'
const ADMIN_ONLY = 'Changing the item catalog is a superadmin action.'

const id = z.number().int().positive()

async function gate(): Promise<string | null> {
  const result = await requireSuperadmin()
  return result.ok ? null : ADMIN_ONLY
}

function done(): ItemCatalogActionResult {
  revalidatePath(PATH)
  revalidatePath('/settings')
  return { ok: true }
}

const confirmSchema = z.object({
  itemIds: z.array(id).min(1, 'Pick at least one item.').max(1000),
  confirmed: z.boolean(),
})

/** Confirm (or un-confirm) one or many catalog items in one statement. */
export async function setItemCatalogConfirmed(input: {
  itemIds: number[]
  confirmed: boolean
}): Promise<ItemCatalogActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = confirmSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { error } = await supabase.rpc('set_item_catalog_confirmed', {
    p_item_ids: parsed.data.itemIds,
    p_confirmed: parsed.data.confirmed,
  })
  if (error) return { ok: false, error: logRawError('itemCatalog.setConfirmed', error.message) }
  return done()
}

const renameSchema = z.object({
  itemId: id,
  label: z.string().trim().min(1, 'Item name is required.').max(200, 'Item name is too long.'),
})

/**
 * Renames the display label only. item_key stays put: it is the identity the
 * aliases and reports hang off, and renaming a label should never re-key history.
 */
export async function renameItemCatalog(input: { itemId: number; label: string }): Promise<ItemCatalogActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = renameSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('item_catalog')
    .update({ canonical_label: parsed.data.label })
    .eq('id', parsed.data.itemId)
    .select('id')
  if (error) return { ok: false, error: logRawError('itemCatalog.rename', error.message) }
  if (!data || data.length === 0) return { ok: false, error: 'That catalog item no longer exists.' }
  return done()
}

const moveSchema = z.object({ itemId: id, familyId: id })

/** Moves a catalog item, and every bill line already on it, to another family. */
export async function moveItemCatalogFamily(input: {
  itemId: number
  familyId: number
}): Promise<ItemCatalogActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = moveSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Pick a family to move this item to.' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('move_item_catalog_family', {
    p_item_id: parsed.data.itemId,
    p_family_id: parsed.data.familyId,
  })
  if (error) return { ok: false, error: logRawError('itemCatalog.moveFamily', error.message) }
  return done()
}

const mergeSchema = z
  .object({ sourceItemId: id, targetItemId: id })
  .refine((v) => v.sourceItemId !== v.targetItemId, { message: 'An item cannot be merged into itself.' })

/** Folds one catalog item into another; the source row is deleted. */
export async function mergeItemCatalog(input: {
  sourceItemId: number
  targetItemId: number
}): Promise<ItemCatalogActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = mergeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { error } = await supabase.rpc('merge_item_catalog', {
    p_source_id: parsed.data.sourceItemId,
    p_target_id: parsed.data.targetItemId,
  })
  if (error) return { ok: false, error: logRawError('itemCatalog.merge', error.message) }
  return done()
}

const assignSchema = z.object({
  rawDescription: z.string().trim().min(1, 'That description is empty.').max(2000),
  itemId: id,
})

/**
 * Attaches a bill-line description to a catalog item (manual, confirmed alias)
 * and repoints every rate_reference line with the same normalised text.
 */
export async function assignItemDescription(input: {
  rawDescription: string
  itemId: number
}): Promise<ItemCatalogActionResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = assignSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { error } = await supabase.rpc('assign_item_description', {
    p_raw_description: parsed.data.rawDescription,
    p_item_id: parsed.data.itemId,
  })
  if (error) return { ok: false, error: logRawError('itemCatalog.assign', error.message) }
  return done()
}

const createSchema = z.object({
  familyId: id,
  label: z.string().trim().min(1, 'Give the new item a name.').max(200, 'Item name is too long.'),
  rawDescription: z.string().trim().min(1).max(2000).optional(),
})

/**
 * Creates a new confirmed catalog item in an existing family -- for an
 * unmatched line that fits no existing item -- and, when a description is
 * passed, assigns it straight away.
 */
export async function createItemCatalog(input: {
  familyId: number
  label: string
  rawDescription?: string
}): Promise<CreateItemResult> {
  const denied = await gate()
  if (denied) return { ok: false, error: denied }
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_item_catalog', {
    p_family_id: parsed.data.familyId,
    p_label: parsed.data.label,
  })
  const newId = Number(data)
  if (error || !Number.isInteger(newId) || newId <= 0) {
    return { ok: false, error: logRawError('itemCatalog.create', error?.message ?? 'no id returned') }
  }

  if (parsed.data.rawDescription) {
    const { error: assignError } = await supabase.rpc('assign_item_description', {
      p_raw_description: parsed.data.rawDescription,
      p_item_id: newId,
    })
    if (assignError) {
      revalidatePath(PATH)
      return {
        ok: false,
        error: logRawError(
          'itemCatalog.create:assign',
          `The item was created but the line could not be assigned to it. ${assignError.message}`,
        ),
      }
    }
  }

  revalidatePath(PATH)
  revalidatePath('/settings')
  return { ok: true, itemId: newId }
}
