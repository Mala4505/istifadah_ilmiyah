import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BudgetHeadTable } from '@/components/admin/budget-head-table'
import { requireSettingsSuperadminPage } from '@/lib/settings/page-gate'
import { SettingsSubPage, SettingsGatedState } from '@/components/settings/settings-sub-page'
import { loadBudgetHeads } from '@/lib/settings/loadBudgetHeads'

/**
 * /settings/budget-heads -- the former `<TabsContent value="budget-heads">`
 * tab, lifted to its own focused sub-route (Phase 2 Settings redesign,
 * Direction A). Card body is moved verbatim from app/(app)/settings/page.tsx;
 * the superadmin gate and event-scoped `heads` loader preserve the old
 * per-tab behaviour exactly.
 */
export const dynamic = 'force-dynamic'

export default async function BudgetHeadsSettingsPage() {
  const gate = await requireSettingsSuperadminPage()
  if (!gate.ok) {
    return <SettingsGatedState reason={gate.reason} title="Budget heads" />
  }

  const { budgetHeads, heads } = await loadBudgetHeads(gate.supabase, gate.selectedEventId)

  return (
    <SettingsSubPage title="Budget heads">
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
    </SettingsSubPage>
  )
}
