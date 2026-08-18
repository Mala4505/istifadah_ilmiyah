import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { UsersTable, type StaffRow } from '@/components/admin/users-table'
import { CreateUserDialog } from '@/components/admin/create-user-dialog'
import { BudgetHeadTable, type BudgetHeadRow, type HeadOption } from '@/components/admin/budget-head-table'
import { VendorMergePanel, type VendorRow } from '@/components/admin/vendor-merge-panel'

/** A department name embedded via a to-one FK select can come back as an
 * object or a one-element array depending on supabase-js's relationship
 * inference — normalise both shapes here. */
function extractDepartmentName(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value[0] as { name?: string } | undefined
    return first?.name ?? null
  }
  return (value as { name?: string } | null)?.name ?? null
}

function PageHeader() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
    </div>
  )
}

export default async function AdminPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('staff_profile')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile || profile.role !== 'admin' || !profile.is_active) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader />
        <Card>
          <CardHeader>
            <CardTitle>Admin access required</CardTitle>
            <CardDescription>
              This screen manages staff roles, budget-head mapping, vendor identity merges, and Hub
              master data. It is restricted to active admins — your account does not currently have
              that role, so there is nothing further to show here.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const [
    { data: departmentsData },
    { data: staffData },
    { data: budgetHeadsData },
    { data: headsData },
    { data: zonesData },
    { data: vendorsData },
    { data: hubStatusesData },
  ] = await Promise.all([
    supabase.from('department').select('id, name').order('name'),
    supabase
      .from('staff_profile')
      .select('id, display_name, role, department_id, is_active, its_number, contact_email')
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
    supabase
      .from('vendor')
      .select('id, display_name, normalized_name, gstin, cluster_group_id, is_confirmed')
      .order('display_name'),
    supabase
      .from('hub_status')
      .select('id, code, label, sort_order, is_exportable, is_terminal')
      .order('sort_order'),
  ])

  const departments = (departmentsData ?? []).map((department) => ({
    id: department.id as number,
    name: department.name as string,
  }))

  const staff: StaffRow[] = (staffData ?? []).map((row) => ({
    id: row.id as string,
    displayName: row.display_name as string,
    itsNumber: row.its_number as string | null,
    contactEmail: row.contact_email as string | null,
    role: row.role as StaffRow['role'],
    departmentId: row.department_id as number | null,
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

  const heads: HeadOption[] = (headsData ?? []).map((row) => ({
    id: row.id as number,
    departmentId: row.department_id as number,
    headNumber: row.head_number as number,
    name: row.name as string,
  }))

  const zones = (zonesData ?? []).map((row) => ({
    id: row.id as number,
    departmentId: row.department_id as number,
    zoneNumber: row.zone_number as number,
    name: row.name as string,
  }))

  const vendors: VendorRow[] = (vendorsData ?? []).map((row) => ({
    id: row.id as number,
    displayName: row.display_name as string,
    normalizedName: row.normalized_name as string,
    gstin: row.gstin as string | null,
    clusterGroupId: row.cluster_group_id as number | null,
    isConfirmed: row.is_confirmed as boolean,
  }))

  const hubStatuses = (hubStatusesData ?? []).map((row) => ({
    id: row.id as number,
    code: row.code as string,
    label: row.label as string,
    sortOrder: row.sort_order as number,
    isExportable: row.is_exportable as boolean,
    isTerminal: row.is_terminal as boolean,
  }))

  const inactiveStaffCount = staff.filter((row) => !row.isActive).length
  const unmappedBudgetHeadCount = budgetHeads.filter((row) => row.headId === null).length

  return (
    <div className="flex flex-col gap-4">
      <PageHeader />
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users" className="gap-2">
            Users &amp; Roles
            {inactiveStaffCount > 0 && <Badge variant="warning">{inactiveStaffCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="budget-heads" className="gap-2">
            Budget Heads
            {unmappedBudgetHeadCount > 0 && <Badge variant="secondary">{unmappedBudgetHeadCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="vendors">Vendors</TabsTrigger>
          <TabsTrigger value="master-data">Master Data</TabsTrigger>
        </TabsList>

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
              <CreateUserDialog departments={departments} />
            </CardHeader>
            <CardContent>
              {staff.length === 0 ? (
                <p className="text-sm text-muted-foreground">No staff accounts yet.</p>
              ) : (
                <UsersTable staff={staff} departments={departments} currentUserId={user.id} />
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
              {budgetHeads.length === 0 ? (
                <p className="text-sm text-muted-foreground">No budget heads imported yet.</p>
              ) : (
                <BudgetHeadTable budgetHeads={budgetHeads} heads={heads} />
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
              {vendors.length === 0 ? (
                <p className="text-sm text-muted-foreground">No vendors yet.</p>
              ) : (
                <VendorMergePanel vendors={vendors} />
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
              {hubStatuses.length === 0 ? (
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
                    {hubStatuses.map((status) => (
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
              <CardTitle>Zone / admin head master</CardTitle>
              <CardDescription>
                Reference dimensions seeded from master data, shown here read-only by design —
                editing them is a migration, not an admin action. There is deliberately no write
                policy on these tables for authenticated users.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {departments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No departments seeded yet.</p>
              ) : (
                departments.map((department) => {
                  const departmentHeads = heads.filter((head) => head.departmentId === department.id)
                  const departmentZones = zones.filter((zone) => zone.departmentId === department.id)
                  return (
                    <div key={department.id} className="flex flex-col gap-2">
                      <h3 className="text-sm font-semibold">{department.name}</h3>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                      </div>
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
