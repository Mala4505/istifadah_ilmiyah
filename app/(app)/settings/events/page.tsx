import type { SupabaseClient } from '@supabase/supabase-js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CreateEventForm } from '@/components/events/create-event-form'
import { EventSwitcher } from '@/components/app-shell/event-switcher'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { requireSettingsSuperadminPage } from '@/lib/settings/page-gate'
import { SettingsSubPage, SettingsGatedState } from '@/components/settings/settings-sub-page'
import { loadEvents } from '@/lib/settings/loadEvents'

/**
 * /settings/events -- the focused Past events + Create-the-next-event
 * sub-route (Phase 2, Direction A). Carries the exact card bodies that used
 * to be the `events` tab on the old single Settings page.
 *
 * Gate nuance: the `events` tab was NOT superadmin-only in the old
 * `TAB_DEFS` (no `superadminOnly` flag), and the plan's §2.3 keeps "Past
 * events" reachable by plain admins. So this route runs the shared
 * `requireSettingsSuperadminPage` gate but treats a `not_superadmin`
 * result as "proceed" -- only `signed_out` / `inactive` / `not_admin`
 * block. When the gate stops at `not_superadmin` it never built a client,
 * so this branch makes its own via `createClient()` + `getStaffContext()`.
 */
export const dynamic = 'force-dynamic'

export default async function SettingsEventsPage() {
  const gate = await requireSettingsSuperadminPage()
  if (!gate.ok && gate.reason !== 'not_superadmin') {
    return <SettingsGatedState reason={gate.reason} title="Events" />
  }

  let supabase: SupabaseClient
  let userId: string
  if (gate.ok) {
    supabase = gate.supabase
    userId = gate.userId
  } else {
    // not_superadmin: a plain active admin may still manage events.
    const staff = await getStaffContext()
    if (!staff) return <SettingsGatedState reason="signed_out" title="Events" />
    supabase = await createClient()
    userId = staff.userId
  }

  const {
    events,
    selectedEvent,
    selectedEventId,
    eventDepartmentOptions,
    eventAdminHeadOptions,
    eventZoneOptions,
    eventBudgetHeadOptions,
    eventSubDepartmentOptions,
    selectedMembership,
  } = await loadEvents(supabase, userId)

  return (
    <SettingsSubPage title="Events">
      <Card>
        <CardHeader>
          <CardTitle>Past events</CardTitle>
          <CardDescription>
            Read-only history. Use the switcher below to view a past event — it puts the app in a view-only
            state: no new uploads, no verification, no export.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <EventSwitcher events={events} selectedEventId={selectedEventId} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Hijri year</TableHead>
                <TableHead>Starts</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-medium">{event.name}</TableCell>
                  <TableCell>{event.hijriYear}</TableCell>
                  <TableCell>{event.startsOn ?? '—'}</TableCell>
                  <TableCell>{event.endsOn ?? '—'}</TableCell>
                  <TableCell>
                    {event.isCurrent ? (
                      <span className="text-xs font-medium uppercase tracking-wide text-primary">Current</span>
                    ) : (
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Past
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create the next event</CardTitle>
          <CardDescription>
            Name it, set its dates, then carry forward whichever departments, admin heads, zones, budget
            heads and sub-departments still apply — pre-ticked from{' '}
            {selectedEvent ? selectedEvent.name : 'the currently selected event'}.
            Budgets are never carried forward; they are imported fresh per event.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateEventForm
            departments={eventDepartmentOptions}
            adminHeads={eventAdminHeadOptions}
            zones={eventZoneOptions}
            budgetHeads={eventBudgetHeadOptions}
            subDepartments={eventSubDepartmentOptions}
            initialSelection={selectedMembership}
          />
        </CardContent>
      </Card>
    </SettingsSubPage>
  )
}
