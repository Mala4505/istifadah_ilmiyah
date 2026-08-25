'use server'

/**
 * Server actions backing the /settings screen: the per-user keymap editor
 * (plan §2.1) and the admin-only "Upload limits" card
 * (docs/ocr-execution-decision.md follow-up). Two different privilege
 * levels in one file because they share a page, not because they share a
 * table -- the keymap mutation only ever touches the caller's own
 * `staff_profile` row (self-writable, no role check needed beyond "signed
 * in"); `saveMaxUploadPages` below writes the single global `app_settings`
 * row and is gated to admin-or-above, checked explicitly here since RLS
 * enforces it too but a friendly pre-check avoids a raw Postgres error
 * reaching the toast.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { SHORTCUT_DEFINITIONS, type ShortcutActionId, type ShortcutBinding } from '@/lib/shortcuts/config'

export type SimpleActionResult = { ok: true } | { ok: false; error: string }

export interface SaveKeymapPreferencesInput {
  overrides: Partial<Record<ShortcutActionId, ShortcutBinding>>
  shortcutsEnabled: boolean
}

const CONFIGURABLE_ACTION_IDS = new Set<ShortcutActionId>(
  SHORTCUT_DEFINITIONS.filter((def) => def.configurable).map((def) => def.id)
)

/**
 * Anti-regression rule (plan §2.1, tightened): the whole reason this screen
 * exists is a previous bug where bare letter keys fired review-screen
 * shortcuts while a reviewer was simply typing. Requiring "any modifier"
 * wasn't enough on its own -- Shift+letter is just typing a capital letter,
 * and Ctrl+letter collides with common text-editing shortcuts (select-all,
 * copy, undo) -- both still fired accidentally. Alt+letter is a combination
 * normal typing and editing never produces, so it's the one modifier every
 * override must include, on top of whatever else the user layers on. This
 * covers `jumpToLineDigit` too, whose `key` is always `''` (the digit itself
 * isn't configurable, see lib/shortcuts/config.ts) -- a bare or Ctrl/Shift-only
 * 1-9 press is exactly the failure mode being guarded against.
 */
function hasRequiredModifier(binding: ShortcutBinding): boolean {
  return !!binding.alt
}

export async function saveKeymapPreferences(input: SaveKeymapPreferencesInput): Promise<SimpleActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You need to sign in again to save this.' }

  const overrides: Partial<Record<ShortcutActionId, ShortcutBinding>> = {}
  for (const [rawActionId, binding] of Object.entries(input.overrides)) {
    if (!binding) continue
    const actionId = rawActionId as ShortcutActionId
    if (!CONFIGURABLE_ACTION_IDS.has(actionId)) {
      return { ok: false, error: `"${rawActionId}" cannot be rebound.` }
    }
    if (!hasRequiredModifier(binding)) {
      return {
        ok: false,
        error: 'Shortcuts must include the Alt key (e.g. Alt+E) so they never fire while typing.',
      }
    }
    overrides[actionId] = {
      key: binding.key,
      alt: !!binding.alt,
      shift: !!binding.shift,
      ctrl: !!binding.ctrl,
      meta: !!binding.meta,
    }
  }

  const { error } = await supabase
    .from('staff_profile')
    .update({ keymap_overrides: overrides, shortcuts_enabled: input.shortcutsEnabled })
    .eq('id', user.id)

  if (error) {
    return { ok: false, error: logRawError('settings.saveKeymapPreferences', error.message) }
  }

  revalidatePath('/settings')
  revalidatePath('/review')
  return { ok: true }
}

/**
 * Admin-only: the page-count ceiling app/api/documents/ingest/route.ts
 * enforces before accepting an upload. Bounded to a sane range (1-500) --
 * not because the schema needs it (app_settings.max_upload_pages only
 * checks `> 0`), but because a value of 0 or a typo'd huge number would
 * silently brick every upload or silently disable the guardrail entirely,
 * and there is no legitimate reason to set it outside this range given the
 * platform's own hard limits (docs/ocr-execution-decision.md).
 */
export async function saveMaxUploadPages(value: number): Promise<SimpleActionResult> {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    return { ok: false, error: 'Enter a whole number of pages between 1 and 500.' }
  }

  const staff = await getStaffContext()
  if (!staff) return { ok: false, error: 'You need to sign in again to save this.' }
  if (!isAdminOrAbove(staff.role)) {
    return { ok: false, error: 'Changing the upload limit is an admin action.' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('app_settings')
    .update({ max_upload_pages: value, updated_at: new Date().toISOString(), updated_by: staff.userId })
    .eq('id', 1)

  if (error) {
    return { ok: false, error: logRawError('settings.saveMaxUploadPages', error.message) }
  }

  revalidatePath('/settings')
  return { ok: true }
}
