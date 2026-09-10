import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { VendorMergePanel } from '@/components/admin/vendor-merge-panel'
import { requireSettingsSuperadminPage } from '@/lib/settings/page-gate'
import { SettingsSubPage, SettingsGatedState } from '@/components/settings/settings-sub-page'
import { loadVendors } from '@/lib/settings/loadVendors'

/**
 * /settings/vendors -- the former `<TabsContent value="vendors">` of the
 * single Settings page, lifted into its own focused sub-route (Phase 2,
 * Direction A -- docs/reports-settings-workload-redesign-plan.md §2.2).
 * Card body moved verbatim; the gate and loader are the shared Phase 2
 * primitives.
 */
export const dynamic = 'force-dynamic'

export default async function SettingsVendorsPage() {
  const gate = await requireSettingsSuperadminPage()
  if (!gate.ok) {
    return <SettingsGatedState reason={gate.reason} title="Vendors" />
  }

  const { vendors } = await loadVendors(gate.supabase)

  return (
    <SettingsSubPage title="Vendors">
      <Card>
        <CardHeader>
          <CardTitle>Vendors</CardTitle>
          <CardDescription>
            Hover a vendor to rename it — this updates both the label and the identity key future
            imports and bills match on, so the old spelling is kept as an alias and still resolves.
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
    </SettingsSubPage>
  )
}
