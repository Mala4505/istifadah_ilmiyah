import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { UsersTable } from '@/components/admin/users-table'
import { CreateUserDialog } from '@/components/admin/create-user-dialog'
import { requireSettingsSuperadminPage } from '@/lib/settings/page-gate'
import { SettingsSubPage, SettingsGatedState } from '@/components/settings/settings-sub-page'
import { loadUsers } from '@/lib/settings/loadUsers'

/**
 * /settings/users -- the focused Users & Roles sub-route (Phase 2, Direction
 * A). Carries the exact card body that used to be the `users` tab on the old
 * single Settings page. Its own server-side superadmin gate runs regardless
 * of what the landing list showed -- a hidden link is not a permission check.
 */
export const dynamic = 'force-dynamic'

export default async function SettingsUsersPage() {
  const gate = await requireSettingsSuperadminPage()
  if (!gate.ok) return <SettingsGatedState reason={gate.reason} title="Users & roles" />

  const { departments, staff } = await loadUsers(gate.supabase, gate.selectedEventId)

  return (
    <SettingsSubPage title="Users & roles">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Users &amp; roles</CardTitle>
            <CardDescription>
              Staff log in with an ITS number and password. Nobody self-serves into access —
              accounts only exist once an admin creates one here, active immediately with the
              role and department set below.
            </CardDescription>
          </div>
          <CreateUserDialog departments={departments} />
        </CardHeader>
        <CardContent>
          {staff.length === 0 ? (
            <p className="text-sm text-muted-foreground">No staff accounts yet.</p>
          ) : (
            <UsersTable
              staff={staff}
              departments={departments}
              currentUserId={gate.userId}
              canEdit
            />
          )}
        </CardContent>
      </Card>
    </SettingsSubPage>
  )
}
