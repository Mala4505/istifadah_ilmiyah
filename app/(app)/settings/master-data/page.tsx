import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SettingsSubPage, SettingsGatedState } from '@/components/settings/settings-sub-page'
import { requireSettingsSuperadminPage } from '@/lib/settings/page-gate'
import { loadMasterData } from '@/lib/settings/loadMasterData'

/**
 * /settings/master-data -- the former `<TabsContent value="master-data">` tab
 * from the single Settings page, lifted into its own focused sub-route
 * (Phase 2, Direction A). Superadmin-only, gated server-side regardless of
 * what the landing list showed.
 *
 * §2.2F compaction: the "Sub-department / zone / admin head master" card now
 * renders one row per department (`name · N sub-departments · N zones · N
 * admin heads`), each a native `<details>` that expands to the same three
 * per-department tables the tab showed inline. Still read-only. The
 * Hub-status lifecycle table sits below it, unchanged.
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
            <CardTitle>Sub-department / zone / admin head master</CardTitle>
            <CardDescription>
              Reference dimensions seeded from master data, shown here read-only by design —
              editing them is a migration, not an admin action. There is deliberately no write
              policy on these tables for authenticated users.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {departments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No departments seeded yet.</p>
            ) : (
              departments.map((department) => {
                const departmentHeads = heads.filter((head) => head.departmentId === department.id)
                const departmentZones = zones.filter((zone) => zone.departmentId === department.id)
                const departmentSubDepartments = subDepartments.filter(
                  (subDepartment) => subDepartment.departmentId === department.id,
                )
                return (
                  <details
                    key={department.id}
                    className="rounded-md border border-border px-3 py-2"
                  >
                    <summary className="cursor-pointer marker:text-muted-foreground">
                      <span className="ml-1 inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold">{department.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {departmentSubDepartments.length} sub-departments ·{' '}
                          {departmentZones.length} zones · {departmentHeads.length} admin heads
                        </span>
                      </span>
                    </summary>
                    <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
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
                  </details>
                )
              })
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
