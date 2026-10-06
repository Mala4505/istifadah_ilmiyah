import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { SettingsGatedState, SettingsSubPage } from '@/components/settings/settings-sub-page'
import { ItemCatalogTable } from '@/components/settings/item-catalog-table'
import { ItemLinesToAssign } from '@/components/settings/item-lines-to-assign'
import { requireSettingsSuperadminPage } from '@/lib/settings/page-gate'
import { loadItemCatalog } from '@/lib/settings/loadItemCatalog'
import { formatNumber } from '@/lib/reports/format'

/**
 * /settings/item-catalog -- the human-confirmation step for the item catalog
 * (MASTER-PLAN Phase 2). Bill lines are auto-mapped onto item_catalog /
 * item_family by exact alias match (20261005084229); nothing is confirmed
 * until a person looks at it here. Two tables: the catalog items themselves
 * (confirm, rename, move family, merge) and the bill-line descriptions that
 * still need a decision (no match, size not read, low confidence).
 *
 * Superadmin-only, like the other structural settings sub-routes (decision
 * 2026-10-06); the RPCs re-check private.is_superadmin() (20261006130000).
 */
export const dynamic = 'force-dynamic'

export default async function SettingsItemCatalogPage() {
  const gate = await requireSettingsSuperadminPage()
  if (!gate.ok) {
    return <SettingsGatedState reason={gate.reason} title="Item catalog" />
  }

  const { items, families, linesToAssign, error } = await loadItemCatalog(gate.supabase)
  const unconfirmed = items.filter((i) => !i.isConfirmed).length
  const unmatched = linesToAssign.filter((l) => l.reason === 'unmatched').length

  return (
    <SettingsSubPage title="Item catalog">
      {error ? (
        <Card>
          <CardContent className="pt-6">
            <FriendlyError message={error} />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Catalog items</CardTitle>
          <CardDescription>
            {formatNumber(items.length)} items · {formatNumber(unconfirmed)} need confirmation. Each item is one
            thing at one size (e.g. &quot;CPVC elbow · 1in&quot;), grouped into a family that rate comparisons run
            across. The mapping was proposed by rules from the bill text -- confirm it when it is right, rename an
            item, move it to the correct family, or merge it into a duplicate. Merging cannot be undone in one
            click, so it asks first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ItemCatalogTable items={items} families={families} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bill lines to assign</CardTitle>
          <CardDescription>
            {formatNumber(linesToAssign.length)} descriptions · {formatNumber(unmatched)} with no catalog match.
            The rest landed on an item without a size the rules could read, or on a low-confidence suggestion.
            Assigning a description moves every bill line with that wording and teaches future bills the same
            match; &quot;Keep&quot; confirms the current item.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ItemLinesToAssign lines={linesToAssign} items={items} families={families} />
        </CardContent>
      </Card>
    </SettingsSubPage>
  )
}
