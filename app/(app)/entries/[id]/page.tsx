import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AdvanceSettlementPicker } from '@/components/entries/detail/advance-settlement-picker'
import { ChangeHistoryList } from '@/components/entries/detail/change-history-list'
import { DocumentsNote } from '@/components/entries/detail/documents-note'
import { EnrichmentForm } from '@/components/entries/detail/enrichment-form'
import { EntryNotFound } from '@/components/entries/detail/entry-not-found'
import { HubStatusSection } from '@/components/entries/detail/hub-status-section'
import { ImportFieldsPanel } from '@/components/entries/detail/import-fields-panel'
import type {
  AdminHeadOption,
  AdvanceEntrySummary,
  BudgetCategoryOption,
  ChangeLogRow,
  EntryEnriched,
  HubStatusOption,
  ZoneOption,
} from '@/components/entries/detail/types'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function EntryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: rawId } = await params
  const id = Number(rawId)

  if (!Number.isInteger(id) || id <= 0) {
    return <EntryNotFound id={rawId} />
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: entryData, error: entryError } = await supabase
    .from('v_entry_enriched')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (entryError) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Entry {rawId}</h1>
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <p className="text-sm font-medium">Could not load this entry</p>
            <p className="text-sm text-muted-foreground">{entryError.message}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!entryData) {
    return <EntryNotFound id={rawId} />
  }

  const entry = entryData as EntryEnriched

  // §3.4/§3.9 supporting data — fetched in parallel. Every read below is
  // still subject to RLS on the underlying tables (20260808000026), so a
  // department-scoped reviewer only ever sees what they're allowed to.
  const [
    adminHeadsResult,
    zonesResult,
    budgetCategoriesResult,
    hubStatusResult,
    changeLogResult,
    entryCoreResult,
    vendorResult,
    linkedAdvanceResult,
  ] = await Promise.all([
    entry.department_id
      ? supabase
          .from('admin_head')
          .select('id, head_number, name')
          .eq('department_id', entry.department_id)
          .eq('is_active', true)
          .order('head_number')
      : Promise.resolve({ data: [], error: null }),
    entry.department_id
      ? supabase
          .from('zone')
          .select('id, zone_number, name')
          .eq('department_id', entry.department_id)
          .eq('is_active', true)
          .order('zone_number')
      : Promise.resolve({ data: [], error: null }),
    supabase.from('budget_category').select('id, name').order('name'),
    supabase.from('hub_status').select('id, code, label, sort_order, is_exportable').order('sort_order'),
    supabase
      .from('entry_change_log')
      .select('id, entry_id, changed_by, changed_at, source, changes')
      .eq('entry_id', id)
      .order('changed_at', { ascending: false })
      .limit(200),
    supabase.from('entries').select('budget_head_raw').eq('id', id).maybeSingle(),
    entry.vendor_id
      ? supabase.from('vendor').select('is_confirmed').eq('id', entry.vendor_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    entry.settles_entry_id
      ? supabase
          .from('v_entry_enriched')
          .select('id, ubbl_number, vendor_display_name, vendor_raw, amount, date')
          .eq('id', entry.settles_entry_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  const adminHeadOptions = (adminHeadsResult.data ?? []) as AdminHeadOption[]
  const zoneOptions = (zonesResult.data ?? []) as ZoneOption[]
  const budgetCategoryOptions = (budgetCategoriesResult.data ?? []) as BudgetCategoryOption[]
  const hubStatusOptions = (hubStatusResult.data ?? []) as HubStatusOption[]
  const changeLogRows = (changeLogResult.data ?? []) as ChangeLogRow[]
  const budgetHeadRaw = (entryCoreResult.data as { budget_head_raw: string | null } | null)
    ?.budget_head_raw ?? null
  const vendorConfirmed = (vendorResult.data as { is_confirmed: boolean } | null)?.is_confirmed ?? null
  const linkedAdvance = linkedAdvanceResult.data as AdvanceEntrySummary | null

  // Best-effort display names for `changed_by`. staff_profile RLS
  // (20260808000026) only returns the caller's own row unless they're an
  // admin, so this resolves what it can and falls back to a short id.
  const changedByIds = Array.from(
    new Set(changeLogRows.map((r) => r.changed_by).filter((v): v is string => Boolean(v)))
  )
  let staffNames = new Map<string, string>()
  if (changedByIds.length > 0) {
    const { data: staffRows } = await supabase
      .from('staff_profile')
      .select('id, display_name')
      .in('id', changedByIds)
    staffNames = new Map(
      ((staffRows ?? []) as { id: string; display_name: string }[]).map((s) => [s.id, s.display_name])
    )
  }

  function resolveChangedBy(userId: string | null): string {
    if (!userId) return 'Import (system)'
    if (user && userId === user.id) return 'You'
    return staffNames.get(userId) ?? `Staff ${userId.slice(0, 8)}`
  }

  const adminHeadById = new Map(adminHeadOptions.map((h) => [h.id, h]))
  const zoneById = new Map(zoneOptions.map((z) => [z.id, z]))
  const budgetCategoryById = new Map(budgetCategoryOptions.map((c) => [c.id, c]))
  const hubStatusById = new Map(hubStatusOptions.map((h) => [h.id, h]))

  function resolveLookup(field: string, value: number): string | null {
    if (field === 'admin_head_id') return adminHeadById.get(value)?.name ?? null
    if (field === 'zone_id') return zoneById.get(value)?.name ?? null
    if (field === 'budget_category_id') return budgetCategoryById.get(value)?.name ?? null
    if (field === 'hub_status_id') return hubStatusById.get(value)?.label ?? null
    return null
  }

  const hubStatusTimelineRows = changeLogRows.filter((r) => 'hub_status_id' in r.changes)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{entry.ubbl_number}</h1>
        <Badge variant="outline">{entry.type.replace('_', ' ')}</Badge>
        {entry.department_name && <Badge variant="secondary">{entry.department_name}</Badge>}
        {entry.is_void && <Badge variant="destructive">Void</Badge>}
      </div>

      <ImportFieldsPanel entry={entry} vendorConfirmed={vendorConfirmed} budgetHeadRaw={budgetHeadRaw} />

      <DocumentsNote count={entry.document_count} />

      <HubStatusSection
        entryId={entry.id}
        hubStatusCode={entry.hub_status_code}
        hubStatusLabel={entry.hub_status_label}
        hubStatusExportedAt={entry.hub_status_exported_at}
        hubStatusOptions={hubStatusOptions}
        timelineRows={hubStatusTimelineRows}
        resolveChangedBy={resolveChangedBy}
      />

      <Tabs defaultValue="enrichment">
        <TabsList>
          <TabsTrigger value="enrichment">Enrichment</TabsTrigger>
          <TabsTrigger value="history">Change history</TabsTrigger>
        </TabsList>

        <TabsContent value="enrichment" className="flex flex-col gap-4">
          <EnrichmentForm
            entryId={entry.id}
            adminHeadOptions={adminHeadOptions}
            zoneOptions={zoneOptions}
            budgetCategoryOptions={budgetCategoryOptions}
            initialAdminHeadId={entry.admin_head_id}
            initialZoneId={entry.zone_id}
            initialBudgetCategoryId={entry.budget_category_id}
            initialRemark={entry.remark}
            hasDepartment={entry.department_id !== null}
          />
          {entry.type === 'invoice' && (
            <AdvanceSettlementPicker
              entryId={entry.id}
              departmentId={entry.department_id}
              initialLinked={linkedAdvance}
            />
          )}
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardContent className="pt-6">
              <ChangeHistoryList
                rows={changeLogRows}
                resolveChangedBy={resolveChangedBy}
                resolveLookup={resolveLookup}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
