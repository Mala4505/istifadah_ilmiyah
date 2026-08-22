import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { loadStaffKeymapPreferences } from '@/lib/shortcuts/load'
import { SHORTCUT_DEFINITIONS, type ShortcutActionId, type ShortcutBinding } from '@/lib/shortcuts/config'
import { getMaxUploadPages, DEFAULT_MAX_UPLOAD_PAGES } from '@/lib/upload-limits'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { KeymapSettings } from '@/components/settings/keymap-settings'
import { UploadLimitSettings } from '@/components/settings/upload-limit-settings'

/**
 * /settings -- Phase 3 (plan §2.1). Every signed-in, active staff member
 * lands here regardless of role (unlike /review, which is admin-only) since
 * the keymap it configures is a per-user preference, not a privileged
 * action.
 */
export const dynamic = 'force-dynamic'

function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    a.key === b.key &&
    !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift &&
    !!a.ctrl === !!b.ctrl &&
    !!a.meta === !!b.meta
  )
}

function PageHeader() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
    </div>
  )
}

function GatedState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader />
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div>
  )
}

export default async function SettingsPage() {
  const staff = await getStaffContext()
  if (!staff) {
    return <GatedState title="Sign in required" body="You need to sign in to change your settings." />
  }
  if (!staff.isActive) {
    return (
      <GatedState
        title="Your account is pending activation"
        body="An admin needs to activate your account before you can change settings."
      />
    )
  }

  const supabase = await createClient()
  const { keymap, shortcutsEnabled } = await loadStaffKeymapPreferences(supabase, staff.userId)
  // Admin-only card below reads this regardless of role -- app_settings_select
  // (20260822000007_app_settings.sql) allows any signed-in staff member to
  // read it, and getMaxUploadPages already fails open to
  // DEFAULT_MAX_UPLOAD_PAGES on any error -- cheap enough to just always
  // fetch rather than branch the query on role first.
  const maxUploadPages = isAdminOrAbove(staff.role) ? await getMaxUploadPages(supabase) : DEFAULT_MAX_UPLOAD_PAGES

  // lib/shortcuts/load.ts only hands back the merged keymap, not the raw
  // overrides row -- reconstruct which configurable actions are actually
  // overridden by diffing the resolved binding against each action's
  // default, so the client can seed its pending-edit state without a second,
  // raw-overrides-shaped export.
  const initialOverrides: Partial<Record<ShortcutActionId, ShortcutBinding>> = {}
  for (const def of SHORTCUT_DEFINITIONS) {
    if (!def.configurable) continue
    const resolved = keymap[def.id]
    if (!bindingsEqual(resolved, def.default)) {
      initialOverrides[def.id] = resolved
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader />
      <Card>
        <CardHeader>
          <CardTitle>Keyboard shortcuts</CardTitle>
          <CardDescription>
            Configure the shortcuts used on the review screen. Every configurable shortcut needs at
            least one modifier key (Alt, Ctrl, or Shift) so it never fires while you&apos;re typing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <KeymapSettings initialOverrides={initialOverrides} initialShortcutsEnabled={shortcutsEnabled} />
        </CardContent>
      </Card>
      {isAdminOrAbove(staff.role) ? (
        <Card>
          <CardHeader>
            <CardTitle>Upload limits</CardTitle>
            <CardDescription>
              PDFs with more pages than this are rejected at upload, before any storage or OCR spend.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UploadLimitSettings initialMaxUploadPages={maxUploadPages} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
