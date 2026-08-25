import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove, isSuperadmin } from '@/lib/auth/roles'
import { getAllEvents, getSelectedEvent } from '@/lib/events/current'
import { getMaxUploadPages } from '@/lib/upload-limits'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CreateEventForm, type MasterOption } from '@/components/events/create-event-form'
import { EventSwitcher } from '@/components/app-shell/event-switcher'
import { UploadLimitSettings } from '@/components/settings/upload-limit-settings'
import { UsersTable, type StaffRow } from '@/components/admin/users-table'
import { CreateUserDialog } from '@/components/admin/create-user-dialog'
import { BudgetHeadTable, type BudgetHeadRow, type HeadOption } from '@/components/admin/budget-head-table'
import { VendorMergePanel, type VendorRow } from '@/components/admin/vendor-merge-panel'
import {
  SubDepartmentBudgetTable,
  type SubDepartmentBudgetRow,
} from '@/components/settings/sub-department-budget-table'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * /settings -- folds the former /admin (superadmin-only: Users & Roles,
 * Budget Heads, Vendors, Master Data) and /events (admin-only: past events +
 * create-event form) screens into one tabbed page, alongside the Upload
 * limits card that already lived here. The keymap card that used to live
 * here has moved to /shortcuts.
 *
 * Gate sequence mirrors /export's getStaffContext() pattern: signed-in,
 * then active, then admin-or-above -- a plain `dept` role never reaches this
 * page (nav-rail already hides the link), but the page still enforces it
 * server-side since a hidden link is not a permission check.
 */
export const dynamic = 'force-dynamic'

/** A department name embedded via a to-one FK select can come back as an
 * object or a one-element array depending on supabase-js's relationship
 * inference -- normalise both shapes here. */
function extractDepartmentName(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value[0] as { name?: string } | undefined
    return first?.name ?? null
  }
  return (value as { name?: string } | null)?.name ?? null
}

/** A to-many junction embed (staff_department(department_id)) comes back from
 * supabase-js as an array of rows shaped like the selected columns -- here
 * `{ department_id: number }[]` -- one entry per membership row. Defensive
 * against a null/undefined embed the same way extractDepartmentName is. */
function extractDepartmentIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (entry as { department_id?: number | null } | null)?.department_id)
    .filter((id): id is number => typeof id === 'number')
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

type DepartmentOption = { id: number; name: string }
type ZoneRow = { id: number; departmentId: number; zoneNumber: number; name: string }
type SubDepartmentRow = {
  id: number
  departmentId: number
  name: string
  isActive: boolean
  budgetAmount: number | null
}
type HubStatusRow = {
  id: number
  code: string
  label: string
  sortOrder: number
  isExportable: boolean
  isTerminal: boolean
}

interface SuperadminData {
  departments: DepartmentOption[]
  staff: StaffRow[]
  budgetHeads: BudgetHeadRow[]
  heads: HeadOption[]
  zones: ZoneRow[]
  subDepartments: SubDepartmentRow[]
  vendors: VendorRow[]
  hubStatuses: HubStatusRow[]
  inactiveStaffCount: number
  unmappedBudgetHeadCount: number
  unconfirmedVendorCount: number
}

/** Users & Roles / Budget Heads / Vendors / Master Data all read from the
 * same set of superadmin-only queries -- kept behind this loader so a plain
 * admin's page load never pays for their cost (see the `superadmin ?
 * loadSuperadminData(...) : null` call site below). Unchanged from the
 * former app/(app)/admin/page.tsx. */
async function loadSuperadminData(
  supabase: SupabaseClient,
  selectedEventId: number | null,
): Promise<SuperadminData> {
  const [
    { data: departmentsData },
    { data: staffData },
    { data: budgetHeadsData },
    { data: headsData },
    { data: zonesData },
    { data: subDepartmentsData },
    { data: vendorsData },
    { data: hubStatusesData },
    { data: departmentMembershipData },
    { data: headMembershipData },
    { data: zoneMembershipData },
    { data: subDepartmentMembershipData },
    { data: subDepartmentBudgetData },
  ] = await Promise.all([
    supabase.from('department').select('id, name').order('name'),
    supabase
      .from('staff_profile')
      .select('id, display_name, role, is_active, its_number, contact_email, staff_department(department_id)')
      .order('display_name'),
    supabase
      .from('budget_head')
      .select('id, raw_label, short_label, department_id, head_id, department:department_id(name)')
      .order('raw_label'),
    supabase
      .from('admin_head')
      .select('id, department_id, head_number, name')
      .order('department_id')
      .order('head_number'),
    supabase.from('zone').select('id, department_id, zone_number, name').order('department_id').order('zone_number'),
    supabase.from('sub_department').select('id, department_id, name, is_active').order('name'),
    supabase
      .from('vendor')
      .select('id, display_name, normalized_name, gstin, cluster_group_id, is_confirmed')
      .order('display_name'),
    supabase
      .from('hub_status')
      .select('id, code, label, sort_order, is_exportable, is_terminal')
      .order('sort_order'),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { department_id: number }[] })
      : supabase.from('event_department').select('department_id').eq('event_id', selectedEventId),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { admin_head_id: number }[] })
      : supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEventId),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { zone_id: number }[] })
      : supabase.from('event_zone').select('zone_id').eq('event_id', selectedEventId),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { sub_department_id: number }[] })
      : supabase.from('event_sub_department').select('sub_department_id').eq('event_id', selectedEventId),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { sub_department_id: number; budget_amount: number | null }[] })
      : supabase
          .from('v_sub_department_budget_vs_actual')
          .select('sub_department_id, budget_amount')
          .eq('event_id', selectedEventId),
  ])

  // Falls back to "no filtering" when there's no resolvable event (should
  // not happen once the Phase 6 backfill has run) rather than emptying
  // every master-data table and the budget-head mapping dropdown.
  const departmentMemberIds = new Set((departmentMembershipData ?? []).map((r) => r.department_id))
  const headMemberIds = new Set((headMembershipData ?? []).map((r) => r.admin_head_id))
  const zoneMemberIds = new Set((zoneMembershipData ?? []).map((r) => r.zone_id))
  const subDepartmentMemberIds = new Set((subDepartmentMembershipData ?? []).map((r) => r.sub_department_id))

  const departments: DepartmentOption[] = (departmentsData ?? [])
    .filter((department) => selectedEventId === null || departmentMemberIds.has(department.id as number))
    .map((department) => ({
      id: department.id as number,
      name: department.name as string,
    }))

  const staff: StaffRow[] = (staffData ?? []).map((row) => ({
    id: row.id as string,
    displayName: row.display_name as string,
    itsNumber: row.its_number as string | null,
    contactEmail: row.contact_email as string | null,
    role: row.role as StaffRow['role'],
    departmentIds: extractDepartmentIds(row.staff_department),
    isActive: row.is_active as boolean,
  }))

  const budgetHeads: BudgetHeadRow[] = (budgetHeadsData ?? []).map((row) => ({
    id: row.id as number,
    rawLabel: row.raw_label as string,
    shortLabel: row.short_label as string | null,
    departmentId: row.department_id as number | null,
    departmentName: extractDepartmentName(row.department),
    headId: row.head_id as number | null,
  }))

  const heads: HeadOption[] = (headsData ?? [])
    .filter((row) => selectedEventId === null || headMemberIds.has(row.id as number))
    .map((row) => ({
      id: row.id as number,
      departmentId: row.department_id as number,
      headNumber: row.head_number as number,
      name: row.name as string,
    }))

  const zones: ZoneRow[] = (zonesData ?? [])
    .filter((row) => selectedEventId === null || zoneMemberIds.has(row.id as number))
    .map((row) => ({
      id: row.id as number,
      departmentId: row.department_id as number,
      zoneNumber: row.zone_number as number,
      name: row.name as string,
    }))

  const subDepartmentBudgetById = new Map<number, number | null>()
  for (const row of subDepartmentBudgetData ?? []) {
    subDepartmentBudgetById.set(row.sub_department_id as number, row.budget_amount as number | null)
  }

  const subDepartments: SubDepartmentRow[] = (subDepartmentsData ?? [])
    .filter((row) => selectedEventId === null || subDepartmentMemberIds.has(row.id as number))
    .map((row) => ({
      id: row.id as number,
      departmentId: row.department_id as number,
      name: row.name as string,
      isActive: row.is_active as boolean,
      budgetAmount: subDepartmentBudgetById.get(row.id as number) ?? null,
    }))

  const vendors: VendorRow[] = (vendorsData ?? []).map((row) => ({
    id: row.id as number,
    displayName: row.display_name as string,
    normalizedName: row.normalized_name as string,
    gstin: row.gstin as string | null,
    clusterGroupId: row.cluster_group_id as number | null,
    isConfirmed: row.is_confirmed as boolean,
  }))

  const hubStatuses: HubStatusRow[] = (hubStatusesData ?? []).map((row) => ({
    id: row.id as number,
    code: row.code as string,
    label: row.label as string,
    sortOrder: row.sort_order as number,
    isExportable: row.is_exportable as boolean,
    isTerminal: row.is_terminal as boolean,
  }))

  return {
    departments,
    staff,
    budgetHeads,
    heads,
    zones,
    subDepartments,
    vendors,
    hubStatuses,
    inactiveStaffCount: staff.filter((row) => !row.isActive).length,
    unmappedBudgetHeadCount: budgetHeads.filter((row) => row.headId === null).length,
    unconfirmedVendorCount: vendors.filter((row) => !row.isConfirmed).length,
  }
}

type TabDef = { value: string; superadminOnly?: boolean }
const TAB_DEFS: TabDef[] = [
  { value: 'users', superadminOnly: true },
  { value: 'budget-heads', superadminOnly: true },
  { value: 'budgets', superadminOnly: true },
  { value: 'vendors', superadminOnly: true },
  { value: 'master-data', superadminOnly: true },
  { value: 'events' },
  { value: 'upload-limits' },
]

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
  if (!isAdminOrAbove(staff.role)) {
    return (
      <GatedState
        title="Admins only"
        body="Settings, event management, and admin tools are restricted to active admins -- your account does not currently have that role."
      />
    )
  }

  const superadmin = isSuperadmin(staff.role)
  const tabs = TAB_DEFS.filter((tab) => !tab.superadminOnly || superadmin)

  const supabase = await createClient()

  // Phase 6 Step 2 (docs/event-scoping-and-review-fixes-plan.md §1): the
  // department/admin-head/zone master-data tables, and the Events tab's
  // option lists, are filtered through this event's membership tables.
  const [events, selectedEvent, maxUploadPages] = await Promise.all([
    getAllEvents(supabase),
    getSelectedEvent(supabase),
    getMaxUploadPages(supabase),
  ])
  const selectedEventId = selectedEvent?.id ?? null

  const [departmentRes, adminHeadRes, zoneRes, budgetHeadRes, subDepartmentRes, superadminData] = await Promise.all([
    supabase.from('department').select('id, name').eq('is_active', true).order('name'),
    supabase.from('admin_head').select('id, name, head_number').eq('is_active', true).order('head_number'),
    supabase.from('zone').select('id, name, zone_number').eq('is_active', true).order('zone_number'),
    supabase.from('budget_head').select('id, raw_label, short_label').order('raw_label'),
    supabase.from('sub_department').select('id, name').eq('is_active', true).order('name'),
    superadmin ? loadSuperadminData(supabase, selectedEventId) : Promise.resolve(null),
  ])

  const eventDepartmentOptions: MasterOption[] = (departmentRes.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
  }))
  const eventAdminHeadOptions: MasterOption[] = (adminHeadRes.data ?? []).map((row) => ({
    id: row.id,
    label: `${row.head_number}. ${row.name}`,
  }))
  const eventZoneOptions: MasterOption[] = (zoneRes.data ?? []).map((row) => ({
    id: row.id,
    label: `${row.zone_number}. ${row.name}`,
  }))
  const eventBudgetHeadOptions: MasterOption[] = (budgetHeadRes.data ?? []).map((row) => ({
    id: row.id,
    label: row.short_label ?? row.raw_label,
  }))
  const eventSubDepartmentOptions: MasterOption[] = (subDepartmentRes.data ?? []).map((row) => ({
    id: row.id,
    label: row.name,
  }))

  let selectedMembership = {
    departmentIds: [] as number[],
    adminHeadIds: [] as number[],
    zoneIds: [] as number[],
    budgetHeadIds: [] as number[],
    subDepartmentIds: [] as number[],
  }
  if (selectedEvent) {
    const [depMem, headMem, zoneMem, budgetMem, subDepartmentMem] = await Promise.all([
      supabase.from('event_department').select('department_id').eq('event_id', selectedEvent.id),
      supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEvent.id),
      supabase.from('event_zone').select('zone_id').eq('event_id', selectedEvent.id),
      supabase.from('event_budget_head').select('budget_head_id').eq('event_id', selectedEvent.id),
      supabase.from('event_sub_department').select('sub_department_id').eq('event_id', selectedEvent.id),
    ])
    selectedMembership = {
      departmentIds: (depMem.data ?? []).map((r) => r.department_id),
      adminHeadIds: (headMem.data ?? []).map((r) => r.admin_head_id),
      zoneIds: (zoneMem.data ?? []).map((r) => r.zone_id),
      budgetHeadIds: (budgetMem.data ?? []).map((r) => r.budget_head_id),
      subDepartmentIds: (subDepartmentMem.data ?? []).map((r) => r.sub_department_id),
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader />
      <Tabs defaultValue={tabs[0]!.value}>
        <TabsList>
          {superadminData && (
            <>
              <TabsTrigger value="users" className="gap-2">
                Users &amp; Roles
                {superadminData.inactiveStaffCount > 0 && (
                  <Badge variant="warning">{superadminData.inactiveStaffCount}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="budget-heads" className="gap-2">
                Budget Heads
                {superadminData.unmappedBudgetHeadCount > 0 && (
                  <Badge variant="secondary">{superadminData.unmappedBudgetHeadCount}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="budgets">Budgets</TabsTrigger>
              <TabsTrigger value="vendors" className="gap-2">
                Vendors
                {superadminData.unconfirmedVendorCount > 0 && (
                  <Badge variant="secondary">{superadminData.unconfirmedVendorCount}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="master-data">Master Data</TabsTrigger>
            </>
          )}
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="upload-limits">Upload limits</TabsTrigger>
        </TabsList>

        <TabsContent value="events" className="flex flex-col gap-4">
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
        </TabsContent>

        <TabsContent value="upload-limits">
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
        </TabsContent>

        {superadminData && (
          <>
            <TabsContent value="users">
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
                  <CreateUserDialog departments={superadminData.departments} />
                </CardHeader>
                <CardContent>
                  {superadminData.staff.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No staff accounts yet.</p>
                  ) : (
                    <UsersTable
                      staff={superadminData.staff}
                      departments={superadminData.departments}
                      currentUserId={staff.userId}
                      canEdit
                    />
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="budget-heads">
              <Card>
                <CardHeader>
                  <CardTitle>Budget heads</CardTitle>
                  <CardDescription>
                    Budget heads are auto-created on import, straight from the source system&apos;s own
                    labels. Mapping one onto an admin head is optional and fully reversible — an unmapped
                    budget head still imports and reconciles fine, the mapping only adds the Hub&apos;s
                    own head grouping on top.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {superadminData.budgetHeads.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No budget heads imported yet.</p>
                  ) : (
                    <BudgetHeadTable budgetHeads={superadminData.budgetHeads} heads={superadminData.heads} />
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="budgets">
              <Card>
                <CardHeader>
                  <CardTitle>Sub-department budgets</CardTitle>
                  <CardDescription>
                    Sets the budget for the currently selected event directly, without waiting for the next
                    sub-department-budget import. Saving writes a fresh snapshot dated today — the same
                    append-only history the import pipeline builds — so nothing already imported is
                    overwritten, only superseded. Only available on the current event; switch off a past
                    event first if editing is disabled.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {superadminData.subDepartments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No sub-departments in this event yet.</p>
                  ) : (
                    <SubDepartmentBudgetTable
                      rows={[...superadminData.subDepartments]
                        .map(
                          (subDepartment): SubDepartmentBudgetRow => ({
                            id: subDepartment.id,
                            departmentName:
                              superadminData.departments.find((d) => d.id === subDepartment.departmentId)?.name ??
                              '—',
                            name: subDepartment.name,
                            budgetAmount: subDepartment.budgetAmount,
                          })
                        )
                        .sort(
                          (a, b) =>
                            a.departmentName.localeCompare(b.departmentName) || a.name.localeCompare(b.name)
                        )}
                    />
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="vendors">
              <Card>
                <CardHeader>
                  <CardTitle>Vendors</CardTitle>
                  <CardDescription>
                    Vendor identity merges affect payment routing, so they are always a human decision
                    here — never an automatic fuzzy match. Merging folds one vendor&apos;s history under
                    another; unmerging restores it as independent at any time.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {superadminData.vendors.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No vendors yet.</p>
                  ) : (
                    <VendorMergePanel vendors={superadminData.vendors} />
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="master-data" className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Hub status lifecycle</CardTitle>
                  <CardDescription>
                    This is the Hub-owned status set that staff apply to entries — kept deliberately
                    separate from the status imported from the source system, so a later import can
                    never silently overwrite a human decision.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {superadminData.hubStatuses.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No Hub statuses configured yet.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Order</TableHead>
                          <TableHead>Code</TableHead>
                          <TableHead>Label</TableHead>
                          <TableHead>Exported?</TableHead>
                          <TableHead>Terminal?</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {superadminData.hubStatuses.map((status) => (
                          <TableRow key={status.id}>
                            <TableCell>{status.sortOrder}</TableCell>
                            <TableCell>{status.code}</TableCell>
                            <TableCell>{status.label}</TableCell>
                            <TableCell>{status.isExportable ? 'Yes' : 'No'}</TableCell>
                            <TableCell>{status.isTerminal ? 'Yes' : 'No'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Sub-department / zone / admin head master</CardTitle>
                  <CardDescription>
                    Reference dimensions seeded from master data, shown here read-only by design —
                    editing them is a migration, not an admin action. There is deliberately no write
                    policy on these tables for authenticated users.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  {superadminData.departments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No departments seeded yet.</p>
                  ) : (
                    superadminData.departments.map((department) => {
                      const departmentHeads = superadminData.heads.filter(
                        (head) => head.departmentId === department.id,
                      )
                      const departmentZones = superadminData.zones.filter(
                        (zone) => zone.departmentId === department.id,
                      )
                      const departmentSubDepartments = superadminData.subDepartments.filter(
                        (subDepartment) => subDepartment.departmentId === department.id,
                      )
                      return (
                        <div key={department.id} className="flex flex-col gap-2">
                          <h3 className="text-sm font-semibold">{department.name}</h3>
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                            <div className="flex flex-col gap-1">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Sub-departments
                              </p>
                              {departmentSubDepartments.length === 0 ? (
                                <p className="text-sm text-muted-foreground">None.</p>
                              ) : (
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Name</TableHead>
                                      <TableHead>Active</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {departmentSubDepartments.map((subDepartment) => (
                                      <TableRow key={subDepartment.id}>
                                        <TableCell>{subDepartment.name}</TableCell>
                                        <TableCell>{subDepartment.isActive ? 'Yes' : 'No'}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Zones
                              </p>
                              {departmentZones.length === 0 ? (
                                <p className="text-sm text-muted-foreground">None.</p>
                              ) : (
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>No.</TableHead>
                                      <TableHead>Name</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {departmentZones.map((zone) => (
                                      <TableRow key={zone.id}>
                                        <TableCell>{zone.zoneNumber}</TableCell>
                                        <TableCell>{zone.name}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Admin heads
                              </p>
                              {departmentHeads.length === 0 ? (
                                <p className="text-sm text-muted-foreground">None.</p>
                              ) : (
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>No.</TableHead>
                                      <TableHead>Name</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {departmentHeads.map((head) => (
                                      <TableRow key={head.id}>
                                        <TableCell>{head.headNumber}</TableCell>
                                        <TableCell>{head.name}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  )
}
