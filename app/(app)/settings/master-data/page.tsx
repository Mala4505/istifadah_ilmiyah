import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SettingsSubPage, SettingsGatedState } from '@/components/settings/settings-sub-page'
import { MasterDepartmentTable } from '@/components/settings/master-department-table'
import { MasterSubDepartmentTable } from '@/components/settings/master-sub-department-table'
import { MasterZoneTable } from '@/components/settings/master-zone-table'
import { MasterAdminHeadTable } from '@/components/settings/master-admin-head-table'
import { requireSettingsSuperadminPage } from '@/lib/settings/page-gate'
import { loadMasterData } from '@/lib/settings/loadMasterData'

/**
 * /settings/master-data -- the former `<TabsContent value="master-data">`
 * tab from the single Settings page, lifted into its own focused sub-route
 * (Phase 2, Direction A). Superadmin-only, gated server-side regardless of
 * what the landing list showed.
 *
 * 2026-09-13: flipped from read-only to editable (createDepartment/
 * updateDepartment, createSubDepartment/updateSubDepartment, createZone/
 * updateZone, createAdminHead/updateAdminHead in lib/actions/admin.ts) --
 * same inline rename + Save pattern the Budget heads and Sub-department
 * budgets sub-routes already use. Zones and admin heads also stopped being
 * department-scoped in this same change (20260913000001_admin_head_zone_
 * drop_department.sql): they were seeded under department_id=1 ('Venue
 * Setup') from day one, which silently broke every admin-head/zone dropdown
 * for an entry classified into any other department. They're now their own
 * flat tables rather than nested per-department cards; only sub-departments
 * still belong to exactly one department (unchanged), shown with an
 * editable department picker per row.
 */
export const dynamic = 'force-dynamic'

export default async function SettingsMasterDataPage() {
  const gate = await requireSettingsSuperadminPage()
  if (!gate.ok) return <SettingsGatedState reason={gate.reason} title="Master data" />

  const { departments, heads, zones, subDepartments, hubStatuses } = await loadMasterData(
    gate.supabase,
    gate.selectedEventId,
  )

  return (
    <SettingsSubPage title="Master data">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Departments</CardTitle>
            <CardDescription>
              Rename, deactivate, or add a department. Deactivating never deletes -- entries and
              sub-departments already pointing at it keep resolving its name, they just stop
              being offered going forward.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {departments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No departments yet.</p>
            ) : (
              <MasterDepartmentTable
                departments={departments.map((d) => ({ ...d, isActive: d.isActive ?? true }))}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sub-departments</CardTitle>
            <CardDescription>
              Each sub-department belongs to exactly one department -- reassign, rename,
              deactivate, or add one below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {subDepartments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sub-departments yet.</p>
            ) : departments.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a department first.</p>
            ) : (
              <MasterSubDepartmentTable subDepartments={subDepartments} departments={departments} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Zones</CardTitle>
            <CardDescription>
              Org-wide reference data, not tied to any department -- an entry in any department
              can be enriched with any zone. Rename, renumber, deactivate, or add one below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {zones.length === 0 ? (
              <p className="text-sm text-muted-foreground">No zones yet.</p>
            ) : (
              <MasterZoneTable zones={zones} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Admin heads</CardTitle>
            <CardDescription>
              Org-wide reference data, not tied to any department -- an entry in any department
              can be enriched with any admin head. Rename, renumber, deactivate, or add one below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {heads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No admin heads yet.</p>
            ) : (
              <MasterAdminHeadTable heads={heads} />
            )}
          </CardContent>
        </Card>

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
      </div>
    </SettingsSubPage>
  )
}
