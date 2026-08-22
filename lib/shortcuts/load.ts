import type { SupabaseClient } from '@supabase/supabase-js'
import { type Keymap, type ShortcutBinding, resolveKeymap } from '@/lib/shortcuts/config'

export interface StaffKeymapPreferences {
  keymap: Keymap
  shortcutsEnabled: boolean
}

/** Loads and resolves a staff member's shortcut preferences. Falls back to
 *  all-defaults/enabled if the row or columns can't be read, since shortcuts
 *  are a convenience feature, not something a page should fail to render over. */
export async function loadStaffKeymapPreferences(
  supabase: SupabaseClient,
  staffId: string
): Promise<StaffKeymapPreferences> {
  const { data } = await supabase
    .from('staff_profile')
    .select('keymap_overrides, shortcuts_enabled')
    .eq('id', staffId)
    .maybeSingle()

  const overrides = (data?.keymap_overrides ?? {}) as Partial<Record<string, ShortcutBinding>>
  return {
    keymap: resolveKeymap(overrides),
    shortcutsEnabled: data?.shortcuts_enabled ?? true,
  }
}
