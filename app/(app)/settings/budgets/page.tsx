import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SettingsSubPage, SettingsGatedState } from '@/components/settings/settings-sub-page'
import { SubDepartmentBudgetTable } from '@/components/settings/sub-department-budget-table'
import { requireSettingsSuperadminPage } from '@/lib/settings/page-gate'
import { loadSubDeptBudgets } from '@/lib/settings/loadSubDeptBudgets'

/**
 * /settings/budgets -- the former `<TabsContent value="budgets">` tab from
 * the single Settings page, lifted into its own focused sub-route (Phase 2,
 * Direction A). Superadmin-only, gated server-side regardless of what the
 * landing list showed. The card body is moved verbatim; the row array is
 * now shaped and pre-sorted inside `loadSubDeptBudgets`.
 */
export const dynamic = 'force-dynamic'

export default async function SettingsBudgetsPage() {
  const gate = await requireSettingsSuperadminPage()
  if (!gate.ok) {
    return <SettingsGatedState reason={gate.reason} title="Sub-department budgets" />
  }

  const { rows } = await loadSubDeptBudgets(gate.supabase, gate.selectedEventId)

  return (
    <SettingsSubPage title="Sub-department budgets">
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
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sub-departments in this event yet.</p>
          ) : (
            <SubDepartmentBudgetTable rows={rows} />
          )}
        </CardContent>
      </Card>
    </SettingsSubPage>
  )
}
