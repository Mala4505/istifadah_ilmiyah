import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { getAllEvents, getSelectedEvent } from '@/lib/events/current'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table'
import { CreateEventForm, type MasterOption } from '@/components/events/create-event-form'

/**
 * /events -- Phase 6 Step 1 (docs/event-scoping-and-review-fixes-plan.md
 * §1.5). Admin-only, structured the same way /settings gates on active
 * staff (app/(app)/settings/page.tsx): a signed-in + active check first,
 * then (unlike /settings, which any active staff member can use) an
 * isAdminOrAbove check, since creating an event is an admin-only action
 * (mirrored server-side in lib/actions/events.ts's createEvent).
 */
export const dynamic = 'force-dynamic'

function PageHeader() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold tracking-tight">Events</h1>
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

export default async function EventsPage() {
  const staff = await getStaffContext()
  if (!staff) {
    return <GatedState title="Sign in required" body="You need to sign in to view events." />
  }
  if (!staff.isActive) {
    return (
      <GatedState
        title="Your account is pending activation"
        body="An admin needs to activate your account before you can view events."
      />
    )
  }
  if (!isAdminOrAbove(staff.role)) {
    return (
      <GatedState
        title="Admins only"
        body="Creating and reviewing events is an admin-only action."
      />
    )
  }

  const supabase = await createClient()
  const [events, selectedEvent] = await Promise.all([getAllEvents(supabase), getSelectedEvent(supabase)])

  const [departmentRes, adminHeadRes, zoneRes, budgetHeadRes] = await Promise.all([
    supabase.from('department').select('id, name').eq('is_active', true).order('name'),
    supabase.from('admin_head').select('id, name, head_number').eq('is_active', true).order('head_number'),
    supabase.from('zone').select('id, name, zone_number').eq('is_active', true).order('zone_number'),
    supabase.from('budget_head').select('id, raw_label, short_label').order('raw_label'),
  ])

  const departments: MasterOption[] = (departmentRes.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
  }))
  const adminHeads: MasterOption[] = (adminHeadRes.data ?? []).map((row) => ({
    id: row.id,
    label: `${row.head_number}. ${row.name}`,
  }))
  const zones: MasterOption[] = (zoneRes.data ?? []).map((row) => ({
    id: row.id,
    label: `${row.zone_number}. ${row.name}`,
  }))
  const budgetHeads: MasterOption[] = (budgetHeadRes.data ?? []).map((row) => ({
    id: row.id,
    label: row.short_label ? `${row.raw_label} (${row.short_label})` : row.raw_label,
  }))

  let selectedMembership = { departmentIds: [] as number[], adminHeadIds: [] as number[], zoneIds: [] as number[], budgetHeadIds: [] as number[] }
  if (selectedEvent) {
    const [depMem, headMem, zoneMem, budgetMem] = await Promise.all([
      supabase.from('event_department').select('department_id').eq('event_id', selectedEvent.id),
      supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEvent.id),
      supabase.from('event_zone').select('zone_id').eq('event_id', selectedEvent.id),
      supabase.from('event_budget_head').select('budget_head_id').eq('event_id', selectedEvent.id),
    ])
    selectedMembership = {
      departmentIds: (depMem.data ?? []).map((r) => r.department_id),
      adminHeadIds: (headMem.data ?? []).map((r) => r.admin_head_id),
      zoneIds: (zoneMem.data ?? []).map((r) => r.zone_id),
      budgetHeadIds: (budgetMem.data ?? []).map((r) => r.budget_head_id),
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader />

      <Card>
        <CardHeader>
          <CardTitle>Past events</CardTitle>
          <CardDescription>
            Read-only history. Switching to a past event (via the rail&apos;s event switcher) puts the app in a
            view-only state — no new uploads, no verification, no export.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Past</span>
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
            Name it, set its dates, then carry forward whichever departments, admin heads, zones and budget
            heads still apply — pre-ticked from {selectedEvent ? selectedEvent.name : 'the currently selected event'}.
            Budgets are never carried forward; they are imported fresh per event.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateEventForm
            departments={departments}
            adminHeads={adminHeads}
            zones={zones}
            budgetHeads={budgetHeads}
            initialSelection={selectedMembership}
          />
        </CardContent>
      </Card>
    </div>
  )
}
