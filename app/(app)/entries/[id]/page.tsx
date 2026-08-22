import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { ProvisionalNumberBanner } from '@/components/entries/detail/provisional-number-banner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AdvanceSettlementPicker } from '@/components/entries/detail/advance-settlement-picker'
import { ChangeHistoryList } from '@/components/entries/detail/change-history-list'
import { EnrichmentForm } from '@/components/entries/detail/enrichment-form'
import { EntryNotFound } from '@/components/entries/detail/entry-not-found'
import { HubStatusSection } from '@/components/entries/detail/hub-status-section'
import { ImportFieldsPanel } from '@/components/entries/detail/import-fields-panel'
import { LinkedDocuments, type LinkedDocumentView } from '@/components/entries/detail/linked-documents'
import {
  EntryIssues,
  type EntryExceptionIssueRow,
  type EntryFlagIssueRow,
} from '@/components/entries/detail/entry-issues'
import type {
  AdminHeadOption,
  AdvanceEntrySummary,
  CostCenterOption,
  ChangeLogRow,
  EntryEnriched,
  HubStatusOption,
  ZoneOption,
} from '@/components/entries/detail/types'
import { createClient } from '@/lib/supabase/server'
import { getSelectedEventId } from '@/lib/events/current'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'

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

  // Phase 6 Step 2 (docs/event-scoping-and-review-fixes-plan.md §1): the
  // admin-head/zone dropdowns below are filtered through this event's
  // membership tables, same as the entries list explorer.
  const selectedEventId = await getSelectedEventId(supabase)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // §3.3 — resolving an exception/flag from this page's Issues card is
  // gated the same way the /exceptions queue gates it (isAdminOrAbove);
  // the actual enforcement is RLS (reconciliation_exception_update /
  // flags_update, both private.is_reviewer_or_admin()), this only controls
  // whether the resolve UI renders.
  const staff = await getStaffContext()
  const canResolveIssues = staff !== null && isAdminOrAbove(staff.role)

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
            <FriendlyError message={entryError.message} />
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
    costCentersResult,
    hubStatusResult,
    changeLogResult,
    entryCoreResult,
    vendorResult,
    linkedAdvanceResult,
    adminHeadMembershipResult,
    zoneMembershipResult,
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
    supabase.from('cost_center').select('id, name').order('name'),
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
    selectedEventId === null
      ? Promise.resolve({ data: [] as { admin_head_id: number }[], error: null })
      : supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEventId),
    selectedEventId === null
      ? Promise.resolve({ data: [] as { zone_id: number }[], error: null })
      : supabase.from('event_zone').select('zone_id').eq('event_id', selectedEventId),
  ])

  // Membership sets default to "no filtering" when there's no resolvable
  // event (should not happen once the Phase 6 backfill has run) rather than
  // silently emptying every dropdown.
  const adminHeadMemberIds = new Set((adminHeadMembershipResult.data ?? []).map((r) => r.admin_head_id as number))
  const zoneMemberIds = new Set((zoneMembershipResult.data ?? []).map((r) => r.zone_id as number))
  const adminHeadOptions = (adminHeadsResult.data ?? []).filter(
    (h) => selectedEventId === null || adminHeadMemberIds.has(h.id as number)
  ) as AdminHeadOption[]
  const zoneOptions = (zonesResult.data ?? []).filter(
    (z) => selectedEventId === null || zoneMemberIds.has(z.id as number)
  ) as ZoneOption[]
  const costCenterOptions = (costCentersResult.data ?? []) as CostCenterOption[]
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
  const costCenterById = new Map(costCenterOptions.map((c) => [c.id, c]))
  const hubStatusById = new Map(hubStatusOptions.map((h) => [h.id, h]))

  function resolveLookup(field: string, value: number): string | null {
    if (field === 'admin_head_id') return adminHeadById.get(value)?.name ?? null
    if (field === 'zone_id') return zoneById.get(value)?.name ?? null
    if (field === 'cost_center_id') return costCenterById.get(value)?.name ?? null
    if (field === 'hub_status_id') return hubStatusById.get(value)?.label ?? null
    return null
  }

  const hubStatusTimelineRows = changeLogRows.filter((r) => 'hub_status_id' in r.changes)

  // Answers "how does this PDF connect to this entry line": the actual
  // attached documents, plus the OCR'd values the match was made on — not
  // just a bare count (see components/entries/detail/linked-documents.tsx).
  //
  // Checklist 1.4's documented follow-up (plan.md D1): a source_document
  // whose match lives solely on one bill's document_extraction.entry_id
  // (multi-bill PDF, 20260817000002) used to be invisible here, because
  // this query only ever looked at source_document.entry_id — the
  // single-bill convenience mirror written by extract.ts, not the source of
  // truth for a per-bill match. Two lookups, unioned: source_document rows
  // matched directly (the common, single-bill case) plus source_document
  // ids reached only through a per-bill document_extraction.entry_id match.
  const { data: perBillMatches } = await supabase
    .from('document_extraction')
    .select('source_document_id')
    .eq('entry_id', id)
  const { data: directMatches } = await supabase.from('source_document').select('id').eq('entry_id', id)
  const linkedSourceDocIds = Array.from(
    new Set([
      ...(perBillMatches ?? []).map((r) => r.source_document_id as number),
      ...(directMatches ?? []).map((r) => r.id as number),
    ])
  )

  const { data: linkedDocsData } =
    linkedSourceDocIds.length > 0
      ? await supabase
          .from('source_document')
          .select('id, original_filename, uploaded_at, page_count')
          .in('id', linkedSourceDocIds)
          .order('uploaded_at', { ascending: false })
      : { data: [] as { id: number; original_filename: string; uploaded_at: string; page_count: number | null }[] }
  const linkedDocIds = (linkedDocsData ?? []).map((d) => d.id)
  interface LinkedExtractionRow {
    source_document_id: number
    entry_id: number | null
    vendor_name_ocr: string | null
    invoice_number_ocr: string | null
    total_amount_ocr: number | null
    invoice_date_ocr: string | null
  }
  const { data: linkedExtractionsData } =
    linkedDocIds.length > 0
      ? await supabase
          .from('document_extraction')
          .select(
            'source_document_id, entry_id, vendor_name_ocr, invoice_number_ocr, total_amount_ocr, invoice_date_ocr'
          )
          .in('source_document_id', linkedDocIds)
          .order('bill_index')
      : { data: [] as LinkedExtractionRow[] }
  // Prefer the bill whose own entry_id actually matches this entry — on a
  // multi-bill document that's the bill this page is about, not whichever
  // one sorted first. Only a document reached solely through the
  // source_document-level mirror (no per-bill match at all) falls back to
  // its first bill's fields, same as before this fix.
  const linkedExtractionByDocId = new Map<number, LinkedExtractionRow>()
  for (const extraction of linkedExtractionsData ?? []) {
    const existing = linkedExtractionByDocId.get(extraction.source_document_id)
    if (!existing || extraction.entry_id === id) {
      linkedExtractionByDocId.set(extraction.source_document_id, extraction)
    }
  }
  const linkedDocuments: LinkedDocumentView[] = (linkedDocsData ?? []).map((d) => {
    const extraction = linkedExtractionByDocId.get(d.id)
    return {
      id: d.id,
      originalFilename: d.original_filename,
      uploadedAt: d.uploaded_at,
      pageCount: d.page_count,
      vendorNameOcr: extraction?.vendor_name_ocr ?? null,
      invoiceNumberOcr: extraction?.invoice_number_ocr ?? null,
      totalAmountOcr: extraction?.total_amount_ocr ?? null,
      invoiceDateOcr: extraction?.invoice_date_ocr ?? null,
    }
  })

  // §3.3 — this entry's open issues. Two categories, queried separately
  // rather than through v_open_issues: that view's output columns don't
  // include source_document_id, only entry_id, so a document-level
  // exception with a null entry_id (raised at ingest/extraction — Phase 0
  // §0.3) would never surface through a plain entry_id filter on the view.
  // Querying reconciliation_exception directly for both the entry-linked
  // rows and the document-linked rows (via linkedSourceDocIds, the same set
  // LinkedDocuments above is built from) is the only way to actually reach
  // that second category.
  interface RawExceptionRow {
    id: number
    exception_type: string
    severity: string
    description: string | null
    amount_at_risk: number | null
    entry_id: number | null
    document_extraction_id: number | null
    source_document_id: number | null
  }
  const EXCEPTION_ROW_SELECT =
    'id, exception_type, severity, description, amount_at_risk, entry_id, document_extraction_id, source_document_id'
  const [entryExceptionsResult, docExceptionsResult, entryFlagsResult] = await Promise.all([
    supabase
      .from('reconciliation_exception')
      .select(EXCEPTION_ROW_SELECT)
      .eq('entry_id', id)
      .eq('status', 'open')
      .returns<RawExceptionRow[]>(),
    linkedSourceDocIds.length > 0
      ? supabase
          .from('reconciliation_exception')
          .select(EXCEPTION_ROW_SELECT)
          .in('source_document_id', linkedSourceDocIds)
          .eq('status', 'open')
          .returns<RawExceptionRow[]>()
      : Promise.resolve({ data: [] as RawExceptionRow[], error: null }),
    supabase
      .from('flags')
      .select('id, flag_type, severity, description, amount_at_risk')
      .eq('entry_id', id)
      .eq('status', 'open'),
  ])

  const filenameByDocId = new Map((linkedDocsData ?? []).map((d) => [d.id, d.original_filename]))
  const seenExceptionIds = new Set<number>()
  const entryIssueExceptions: EntryExceptionIssueRow[] = []
  for (const row of [...(entryExceptionsResult.data ?? []), ...(docExceptionsResult.data ?? [])]) {
    if (seenExceptionIds.has(row.id)) continue
    seenExceptionIds.add(row.id)
    entryIssueExceptions.push({
      id: row.id,
      exceptionType: row.exception_type,
      severity: row.severity,
      description: row.description,
      amountAtRisk: row.amount_at_risk,
      entryId: row.entry_id,
      documentExtractionId: row.document_extraction_id,
      sourceDocumentId: row.source_document_id,
      sourceDocumentFilename: row.source_document_id !== null ? filenameByDocId.get(row.source_document_id) ?? null : null,
    })
  }
  const entryIssueFlags: EntryFlagIssueRow[] = (entryFlagsResult.data ?? []).map((row) => ({
    id: row.id,
    flagType: row.flag_type,
    severity: row.severity,
    description: row.description,
    amountAtRisk: row.amount_at_risk,
  }))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{entry.ubbl_number}</h1>
        <Badge variant="outline">{entry.type.replace('_', ' ')}</Badge>
        {entry.department_name && <Badge variant="secondary">{entry.department_name}</Badge>}
        {entry.is_void && <Badge variant="destructive">Void</Badge>}
      </div>

      {/* Typed entries hold a provisional M-###### number until the real one
          arrives (20260819000002_manual_entries.sql). The prompt to swap it
          sits above the fields so it is the first thing seen, and disappears
          on its own once the real number is in. */}
      {entry.source === 'manual' && /^M-\d{6}$/.test(entry.ubbl_number) && (
        <ProvisionalNumberBanner entryId={entry.id} provisionalNumber={entry.ubbl_number} />
      )}

      <ImportFieldsPanel entry={entry} vendorConfirmed={vendorConfirmed} budgetHeadRaw={budgetHeadRaw} />

      <LinkedDocuments entryId={entry.id} documents={linkedDocuments} entryAmount={entry.amount} />

      <EntryIssues
        entryId={entry.id}
        exceptions={entryIssueExceptions}
        flags={entryIssueFlags}
        canResolve={canResolveIssues}
      />

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
            costCenterOptions={costCenterOptions}
            initialAdminHeadId={entry.admin_head_id}
            initialZoneId={entry.zone_id}
            initialCostCenterId={entry.cost_center_id}
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
