import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { Card, CardContent } from '@/components/ui/card'
import { ReviewWorkspace } from '@/components/review/review-workspace'
import { QueueScopeToggle } from '@/components/review/queue-scope-toggle'
import type {
  LineItemDetail,
  MatchCandidate,
  OpenExceptionSummary,
  PageStatus,
  QueueEntry,
  ReviewDocumentDetail,
  SiblingBill,
  UncertainField,
} from '@/lib/review/types'
import { friendlyErrorMessage } from '@/lib/friendly-error'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { rankCandidates, type MatchableEntry } from '@/lib/matching'
import { normalizeVendorName } from '@/lib/normalize'
import { loadStaffKeymapPreferences } from '@/lib/shortcuts/load'
import { formatBinding } from '@/lib/shortcuts/config'
import { getSelectedEventId } from '@/lib/events/current'

/**
 * /review -- Screen 7, the throughput screen (MASTER-PLAN §5 row 7, §7,
 * §11.2 Day 4). Single route per §5's route table; "current document" is
 * tracked via `?id=` (§7's "keep it a single route" note explicitly allows
 * this). `J`/`K` push a new `id` and this server component reloads with
 * fresh, RLS-scoped data for the new document -- simpler and more robust
 * than mirroring server state on the client, and at the queue's expected
 * volume the round trip is not the bottleneck (§7's arithmetic is about
 * clicks and tab stops, not network latency).
 */
export const dynamic = 'force-dynamic'

const QUEUE_ROW_CAP = 500

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; page?: string }>
}) {
  const staff = await getStaffContext()
  if (!staff) return <GatedState title="Sign in required" body="You need to sign in to use the review queue." />
  if (!staff.isActive) {
    return (
      <GatedState
        title="Your account is pending activation"
        body="An admin needs to activate your account before you can review documents."
      />
    )
  }
  if (!isAdminOrAbove(staff.role)) {
    return (
      <GatedState
        title="Admins only"
        body="Verifying document extractions requires the admin role."
      />
    )
  }

  const supabase = await createClient()
  const { id: idParam, page: pageParam } = await searchParams
  // review-workspace.tsx's PDF thumbnail rail spans every page of the source
  // PDF, including sibling bills' pages -- clicking one that belongs to a
  // different bill navigates here with `&page=N` so the newly-loaded bill's
  // PdfViewer opens on the exact page the reviewer clicked instead of that
  // bill's own first page (its usual default, `pageNumberStart` below).
  const requestedPage = pageParam ? Number(pageParam) : null
  const initialPageOverride = requestedPage !== null && Number.isFinite(requestedPage) ? requestedPage : null

  // Plan §2.1: per-user keymap + master enable/disable, resolved server-side
  // so ReviewWorkspace's shortcut handler never has to guess at defaults.
  const { keymap, shortcutsEnabled } = await loadStaffKeymapPreferences(supabase, staff.userId)

  // Unverified/All toggle (review-page-layout-redesign-plan.md §1): the
  // position counter and Prev/Next used to silently span the whole document
  // set via v_review_queue -- which is actually already unverified-only
  // (`where de.verified_at is null`, 20260817000004). Default to that
  // pending-only view; the cookie (not a `?scope=` param, see
  // setReviewQueueScope's doc comment) lets a reviewer opt into
  // v_review_queue_all, the superset view with verified_at added, without
  // review-workspace.tsx's Prev/Next needing to carry a scope param through.
  const scope = (await cookies()).get('review_queue_scope')?.value === 'all' ? 'all' : 'pending'

  // Phase 6 Step 2 (event-scoping-and-review-fixes-plan.md §1): the queue is
  // scoped to whichever event is currently selected (cookie-backed, defaults
  // to the is_current event -- lib/events/current.ts) so switching events
  // presents a clean slate rather than mixing years together. Filtered here
  // at the query site rather than inside the view itself -- see
  // 20260822000006_review_queue_event_scoping.sql's doc comment for why.
  const selectedEventId = await getSelectedEventId(supabase)

  let queueQuery = supabase
    .from(scope === 'all' ? 'v_review_queue_all' : 'v_review_queue')
    .select(
      'document_extraction_id, source_document_id, original_filename, extraction_confidence, max_open_severity_rank, open_issue_count, queue_amount, bill_index, page_number_start, page_number_end, bill_count'
    )
  // Item 1.5: the capped query below can silently truncate the queue, so a
  // second, uncapped count-only query runs alongside it on the same
  // view/filters to surface the true pending total in the header.
  let queueCountQuery = supabase
    .from(scope === 'all' ? 'v_review_queue_all' : 'v_review_queue')
    .select('*', { count: 'exact', head: true })
  if (selectedEventId !== null) {
    queueQuery = queueQuery.eq('event_id', selectedEventId)
    queueCountQuery = queueCountQuery.eq('event_id', selectedEventId)
  }
  const [{ data: queueRows, error: queueError }, { count: truePendingTotal }] = await Promise.all([
    queueQuery
      .order('max_open_severity_rank', { ascending: false })
      .order('extraction_confidence', { ascending: true, nullsFirst: true })
      .order('queue_amount', { ascending: false, nullsFirst: false })
      // Item 1.1: without a final tiebreaker, the common case (rank 0, null
      // confidence, null amount) puts every such bill into one tie group
      // Postgres may return in any order -- "Bill N of M" then drifts between
      // navigations and a different 500 rows can come back on each request.
      .order('document_extraction_id', { ascending: true })
      .limit(QUEUE_ROW_CAP),
    queueCountQuery,
  ])

  if (queueError) {
    return (
      <GatedState title="Could not load the review queue" body={friendlyErrorMessage(queueError.message)} />
    )
  }

  const queue: QueueEntry[] = (queueRows ?? []).map((r) => ({
    sourceDocumentId: r.source_document_id as number,
    documentExtractionId: r.document_extraction_id as number,
    originalFilename: r.original_filename as string,
    extractionConfidence: r.extraction_confidence as number | null,
    maxOpenSeverityRank: r.max_open_severity_rank as number,
    openIssueCount: r.open_issue_count as number,
    queueAmount: r.queue_amount as number | null,
    billIndex: r.bill_index as number,
    billCount: r.bill_count as number,
  }))

  if (queue.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader scope={scope} helpHint={formatBinding(keymap.toggleHelp)} />
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <p className="text-sm font-medium">Queue is empty</p>
            <p className="text-sm text-muted-foreground">
              {scope === 'all'
                ? // v_review_queue_all has no verified_at filter, so this can
                  // basically only happen when no document has ever been
                  // extracted at all -- still worth a correct, non-assuming message.
                  'There are no extracted documents yet. A document joins this queue as soon as its extraction finishes.'
                : 'Every extracted document has been verified. A new document joins this queue as soon as its extraction finishes -- nothing to do here right now.'}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const requestedId = idParam ? Number(idParam) : null
  const currentIndex = requestedId !== null ? queue.findIndex((q) => q.documentExtractionId === requestedId) : -1

  if (requestedId === null && currentIndex === -1) {
    // No id at all (or a non-numeric one) -- canonicalize to the top of the
    // queue rather than rendering nothing.
    redirect(`/review?id=${queue[0]!.documentExtractionId}`)
  }

  if (currentIndex === -1) {
    // A real, specific id was requested but it isn't in *this scoped*
    // queue -- e.g. a sibling-bill chip (review-workspace.tsx) linked to a
    // bill that's already verified while this reviewer's scope cookie is
    // 'pending'. Load it directly from the unscoped superset view instead of
    // bouncing the reviewer all the way back to queue[0] (event-scoping-and
    // -review-fixes-plan.md §2.11).
    let outOfScopeQuery = supabase
      .from('v_review_queue_all')
      .select('document_extraction_id, source_document_id')
      .eq('document_extraction_id', requestedId as number)
    if (selectedEventId !== null) {
      outOfScopeQuery = outOfScopeQuery.eq('event_id', selectedEventId)
    }
    const { data: outOfScopeRow } = await outOfScopeQuery.maybeSingle()

    if (!outOfScopeRow) {
      // Id doesn't exist, isn't visible under RLS, or belongs to a
      // different event than the one currently selected -- fall back to the
      // original behavior rather than crashing.
      redirect(`/review?id=${queue[0]!.documentExtractionId}`)
    }

    const detail = await loadDocumentDetail(
      supabase,
      outOfScopeRow.source_document_id as number,
      outOfScopeRow.document_extraction_id as number,
      selectedEventId
    )

    if (!detail) {
      redirect(`/review?id=${queue[0]!.documentExtractionId}`)
    }

    return (
      <div className="flex h-[calc(100vh-3rem)] flex-col gap-3">
        <PageHeader total={queue.length} scope={scope} helpHint={formatBinding(keymap.toggleHelp)} />
        <ReviewWorkspace
          key={`${detail.documentExtractionId}:${detail.currentExtractionRunId ?? 'none'}`}
          detail={detail}
          queue={queue.map((q) => ({ documentExtractionId: q.documentExtractionId, sourceDocumentId: q.sourceDocumentId }))}
          currentIndex={-1}
          prevId={null}
          nextId={null}
          keymap={keymap}
          shortcutsEnabled={shortcutsEnabled}
          initialPageOverride={initialPageOverride}
        />
      </div>
    )
  }

  const current = queue[currentIndex]!
  const detail = await loadDocumentDetail(
    supabase,
    current.sourceDocumentId,
    current.documentExtractionId,
    selectedEventId
  )

  if (!detail) {
    // The document left the queue between the list query and the detail
    // query (verified by someone else in the last few hundred ms) -- redirect
    // rather than render a broken form.
    redirect(`/review?id=${queue[currentIndex + 1]?.documentExtractionId ?? queue[0]!.documentExtractionId}`)
  }

  const prevId = queue[currentIndex - 1]?.documentExtractionId ?? null
  const nextId = queue[currentIndex + 1]?.documentExtractionId ?? null

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col gap-3">
      <PageHeader
        position={currentIndex + 1}
        total={queue.length}
        scope={scope}
        truePendingTotal={truePendingTotal ?? undefined}
        helpHint={formatBinding(keymap.toggleHelp)}
      />
      <ReviewWorkspace
        key={`${detail.documentExtractionId}:${detail.currentExtractionRunId ?? 'none'}`}
        detail={detail}
        queue={queue.map((q) => ({ documentExtractionId: q.documentExtractionId, sourceDocumentId: q.sourceDocumentId }))}
        currentIndex={currentIndex}
        prevId={prevId}
        nextId={nextId}
        keymap={keymap}
        shortcutsEnabled={shortcutsEnabled}
        initialPageOverride={initialPageOverride}
      />
    </div>
  )
}

function PageHeader({
  position,
  total,
  scope,
  truePendingTotal,
  helpHint,
}: {
  position?: number
  total?: number
  scope?: 'pending' | 'all'
  // Item 1.5: the true row count across the whole (uncapped) queue, only
  // passed by the normal render branch. Rendered only when it exceeds
  // `total` -- i.e. only when QUEUE_ROW_CAP actually truncated the queue --
  // so the header never states a number smaller than what's on screen.
  truePendingTotal?: number
  // Hub cert 2.1: the resolved help binding for this reviewer (formatBinding
  // of keymap.toggleHelp), so the hint matches what actually fires and what
  // the shortcuts overlay lists -- not a hardcoded bare "?". The gated
  // states render before the keymap is loaded, so this falls back to the
  // default binding's label.
  helpHint?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold tracking-tight">Review queue</h1>
      {position !== undefined && total !== undefined ? (
        <span className="text-sm text-muted-foreground">
          Bill {position} of {total}
          {truePendingTotal !== undefined && truePendingTotal > total ? ` (${truePendingTotal} pending)` : ''}
        </span>
      ) : null}
      {scope !== undefined ? <QueueScopeToggle current={scope} /> : null}
      <span className="ml-auto text-xs text-muted-foreground">
        Press {helpHint ?? formatBinding({ key: '?', alt: true })} for keyboard shortcuts
      </span>
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

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

async function loadDocumentDetail(
  supabase: SupabaseServerClient,
  sourceDocumentId: number,
  documentExtractionId: number,
  selectedEventId: number | null
): Promise<ReviewDocumentDetail | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const [sourceDocRes, extractionRes, lineItemsRes, pagesRes, siblingBillsRes] = await Promise.all([
    supabase
      .from('source_document')
      .select('id, entry_id, original_filename, match_status, claimed_by, claimed_at')
      .eq('id', sourceDocumentId)
      .maybeSingle(),
    supabase
      .from('document_extraction')
      .select(
        'id, entry_id, current_extraction_run_id, verified_at, bill_index, page_number_start, page_number_end, vendor_name_ocr, vendor_name_verified, vendor_gstin_ocr, vendor_gstin_verified, vendor_phone_ocr, vendor_phone_verified, vendor_email_ocr, vendor_email_verified, vendor_address_ocr, vendor_address_verified, buyer_gstin_ocr, buyer_gstin_verified, buyer_name_ocr, buyer_name_verified, invoice_number_ocr, invoice_number_verified, invoice_date_ocr, invoice_date_verified, subtotal_ocr, subtotal_verified, tax_amount_ocr, tax_amount_verified, total_amount_ocr, total_amount_verified, notes_ocr, notes_verified, uncertain_fields_ocr, instrument_type_ocr, tax_breakdown_ocr'
      )
      .eq('id', documentExtractionId)
      .maybeSingle(),
    supabase
      .from('document_extraction_line_item')
      .select(
        'id, line_order, description_ocr, description_verified, hsn_sac_code_ocr, hsn_sac_code_verified, quantity_ocr, quantity_verified, quantity_raw_text_ocr, quantity_raw_text_verified, unit_ocr, unit_verified, unit_normalized, rate_ocr, rate_verified, discount_ocr, discount_verified, amount_ocr, amount_verified'
      )
      .eq('document_extraction_id', documentExtractionId)
      .order('line_order'),
    supabase
      .from('document_page')
      .select('page_number, is_financial_document, skip_reason, classification_confidence, skip_source')
      .eq('source_document_id', sourceDocumentId)
      .order('page_number'),
    // Bill rail (§7): every bill sharing this source_document_id, so a
    // multi-bill PDF can show each sibling's match state at a glance. Only
    // needs sourceDocumentId, already known from the caller -- no reason to
    // serialize this behind the rest of this document's own data.
    supabase
      .from('document_extraction')
      .select('id, bill_index, entry_id, page_number_start, page_number_end, verified_at')
      .eq('source_document_id', sourceDocumentId)
      .order('bill_index'),
  ])

  const sourceDoc = sourceDocRes.data
  const extraction = extractionRes.data
  if (!sourceDoc || !extraction) return null

  // document_extraction.entry_id is the source of truth for this bill's
  // match (written per-bill by attachExtractionToEntry,
  // lib/actions/review.ts); source_document.entry_id is only the
  // single-bill convenience mirror written by extract.ts, so it's the
  // fallback here, not the primary read (plan.md D1).
  const entryId = (extraction.entry_id as number | null) ?? (sourceDoc.entry_id as number | null)

  // Redesign plan §10: normalize once here (only needed for the "suggested
  // match" path below, entryId === null) so the vendor_alias lookup can ride
  // in the same parallel batch as everything else, rather than serializing
  // an extra round trip after it.
  const normalizedOcrVendorName =
    entryId === null && extraction.vendor_name_ocr
      ? normalizeVendorName(extraction.vendor_name_ocr as string)
      : ''

  const [runRes, entryRes, exceptionsRes, hubStatusRes, matchedRowsRes, candidateEntriesRes, vendorAliasRes] =
    await Promise.all([
    extraction.current_extraction_run_id
      ? supabase
          .from('ocr_extraction_run')
          .select('extraction_confidence, legibility, model')
          .eq('id', extraction.current_extraction_run_id as number)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    entryId
      ? supabase
          .from('entries')
          .select(
            'id, amount, ubbl_number, invoice_number, vendor_id, hub_status_id, department_id, admin_head_id, zone_id, sub_department_id'
          )
          .eq('id', entryId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('reconciliation_exception')
      .select('id, exception_type, severity, description, created_at, document_extraction_id, entry_id')
      .eq('status', 'open')
      .or(
        entryId
          ? `document_extraction_id.eq.${documentExtractionId},entry_id.eq.${entryId}`
          : `document_extraction_id.eq.${documentExtractionId}`
      ),
    entryId
      ? supabase.from('hub_status').select('id, code, label').order('sort_order')
      : Promise.resolve({ data: [] }),
    // Match-strip "suggested" state (§7): only meaningful when this bill has
    // no ledger match yet -- same exclusion-pool pattern as
    // app/(app)/documents/page.tsx's rankCandidates usage. Run alongside the
    // rest of this batch rather than serialized after it.
    entryId === null
      ? supabase.from('source_document').select('entry_id').eq('match_status', 'matched').not('entry_id', 'is', null)
      : Promise.resolve({ data: [] }),
    entryId === null
      ? supabase
          .from('entries')
          .select('id, department_id, vendor_raw, vendor_id, amount, date, invoice_number, ubbl_number, main_number')
          .eq('is_void', false)
          .order('date', { ascending: false, nullsFirst: false })
          .limit(5000)
      : Promise.resolve({ data: [] }),
    // Redesign plan §10: has this document's normalized OCR vendor name been
    // learned as an alias for some vendor before (via a prior attach's
    // learnVendorAliasesFromAttach, lib/actions/review.ts)? If so, the
    // candidate whose own vendor_id matches gets a confident (1.0) vendor
    // sub-score in lib/matching.ts instead of relying on bigram fuzzy
    // similarity alone.
    normalizedOcrVendorName
      ? supabase.from('vendor_alias').select('vendor_id').eq('raw_name', normalizedOcrVendorName).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const run = runRes.data as { extraction_confidence: number | null; legibility: 'clear' | 'partial' | 'poor' | null; model: string | null } | null
  const entry = entryRes.data as {
    id: number
    amount: number | null
    ubbl_number: string
    invoice_number: string | null
    vendor_id: number | null
    hub_status_id: number | null
    department_id: number | null
    admin_head_id: number | null
    zone_id: number | null
    sub_department_id: number | null
  } | null

  let entryHubStatusCode: string | null = null
  let entryDepartmentName: string | null = null
  if (entry?.department_id) {
    const { data: dept } = await supabase.from('department').select('name').eq('id', entry.department_id).maybeSingle()
    entryDepartmentName = (dept?.name as string | undefined) ?? null
  }
  if (entry?.hub_status_id) {
    const { data: hs } = await supabase.from('hub_status').select('code').eq('id', entry.hub_status_id).maybeSingle()
    entryHubStatusCode = (hs?.code as string | undefined) ?? null
  }

  // Stage 3 (Classify, §8) options, scoped to the matched entry's
  // department -- same pattern as app/(app)/entries/[id]/page.tsx. Also
  // scoped to the selected event's membership (event-scoping-and-review-
  // fixes-plan.md §1.1): master admin_head/zone rows are shared across
  // events, only membership (event_admin_head/event_zone) is per-event, so a
  // reviewer viewing 1449 H should only see 1449 H's heads/zones, not every
  // head/zone that ever existed. Two-step lookup (membership ids, then
  // `.in()`) rather than an embedded-resource join, to not depend on
  // PostgREST inferring the right relationship direction.
  let adminHeadOptions: { id: number; head_number: number; name: string }[] = []
  let zoneOptions: { id: number; zone_number: number; name: string }[] = []
  let subDepartmentOptions: { id: number; name: string }[] = []
  if (entry?.department_id) {
    const [activeAdminHeadIdsRes, activeZoneIdsRes, activeSubDepartmentIdsRes] = await Promise.all([
      selectedEventId !== null
        ? supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEventId)
        : Promise.resolve({ data: null }),
      selectedEventId !== null
        ? supabase.from('event_zone').select('zone_id').eq('event_id', selectedEventId)
        : Promise.resolve({ data: null }),
      selectedEventId !== null
        ? supabase.from('event_sub_department').select('sub_department_id').eq('event_id', selectedEventId)
        : Promise.resolve({ data: null }),
    ])
    const activeAdminHeadIds = activeAdminHeadIdsRes.data
      ? (activeAdminHeadIdsRes.data as { admin_head_id: number }[]).map((r) => r.admin_head_id)
      : null
    const activeZoneIds = activeZoneIdsRes.data
      ? (activeZoneIdsRes.data as { zone_id: number }[]).map((r) => r.zone_id)
      : null
    const activeSubDepartmentIds = activeSubDepartmentIdsRes.data
      ? (activeSubDepartmentIdsRes.data as { sub_department_id: number }[]).map((r) => r.sub_department_id)
      : null

    let adminHeadQuery = supabase
      .from('admin_head')
      .select('id, head_number, name')
      .eq('department_id', entry.department_id)
      .eq('is_active', true)
    if (activeAdminHeadIds !== null) adminHeadQuery = adminHeadQuery.in('id', activeAdminHeadIds)

    let zoneQuery = supabase
      .from('zone')
      .select('id, zone_number, name')
      .eq('department_id', entry.department_id)
      .eq('is_active', true)
    if (activeZoneIds !== null) zoneQuery = zoneQuery.in('id', activeZoneIds)

    let subDepartmentQuery = supabase
      .from('sub_department')
      .select('id, name')
      .eq('department_id', entry.department_id)
      .eq('is_active', true)
    if (activeSubDepartmentIds !== null) subDepartmentQuery = subDepartmentQuery.in('id', activeSubDepartmentIds)

    const [adminHeadsRes, zonesRes, subDepartmentsRes] = await Promise.all([
      adminHeadQuery.order('head_number'),
      zoneQuery.order('zone_number'),
      subDepartmentQuery.order('name'),
    ])
    adminHeadOptions = (adminHeadsRes.data ?? []).map((h) => ({
      id: h.id as number,
      head_number: h.head_number as number,
      name: h.name as string,
    }))
    zoneOptions = (zonesRes.data ?? []).map((z) => ({
      id: z.id as number,
      zone_number: z.zone_number as number,
      name: z.name as string,
    }))
    subDepartmentOptions = (subDepartmentsRes.data ?? []).map((s) => ({
      id: s.id as number,
      name: s.name as string,
    }))
  }

  // Match-strip "suggested" state (§7): rank this bill's own OCR'd fields
  // against the same excluded-if-already-matched candidate pool
  // app/(app)/documents/page.tsx builds for the inbox. Reused, not
  // reimplemented -- see lib/matching.ts's rankCandidates.
  let matchCandidates: MatchCandidate[] = []
  if (entryId === null) {
    const matchedEntryIds = new Set((matchedRowsRes.data ?? []).map((r) => r.entry_id as number))
    const candidatePool: MatchableEntry[] = (candidateEntriesRes.data ?? [])
      .filter((e) => !matchedEntryIds.has(e.id as number))
      .map((e) => ({
        id: e.id as number,
        vendorRaw: e.vendor_raw as string | null,
        vendorId: e.vendor_id as number | null,
        amount: e.amount as number | null,
        date: e.date as string | null,
        invoiceNumber: e.invoice_number as string | null,
        departmentId: e.department_id as number | null,
        ubblNumber: e.ubbl_number as string,
        mainNumber: e.main_number as string | null,
      }))

    // Same event-scoped department-name resolution as
    // getInboxMatchCandidates (lib/actions/documents.ts) -- a candidate's
    // department name is cosmetic (helps a reviewer tell apart otherwise
    // similar-looking candidates while picking one), so it's scoped to the
    // selected event's event_department membership rather than the full
    // shared department table; a department with no membership row simply
    // comes back with no name.
    const candidateDepartmentIds = Array.from(
      new Set(candidatePool.map((c) => c.departmentId).filter((id): id is number => id !== null))
    )
    const { data: eventDepartmentRows } =
      selectedEventId !== null && candidateDepartmentIds.length > 0
        ? await supabase.from('event_department').select('department_id').eq('event_id', selectedEventId)
        : { data: [] as { department_id: number }[] }
    const activeDepartmentIds = new Set((eventDepartmentRows ?? []).map((r) => r.department_id as number))
    const departmentIdsToResolve = candidateDepartmentIds.filter((id) => activeDepartmentIds.has(id))
    const { data: departmentsData } =
      departmentIdsToResolve.length > 0
        ? await supabase.from('department').select('id, name').in('id', departmentIdsToResolve)
        : { data: [] as { id: number; name: string }[] }
    const departmentNameById = new Map((departmentsData ?? []).map((d) => [d.id as number, d.name as string]))

    matchCandidates = rankCandidates(
      {
        vendorName: extraction.vendor_name_ocr as string | null,
        totalAmount: extraction.total_amount_ocr as number | null,
        invoiceDate: extraction.invoice_date_ocr as string | null,
        invoiceNumber:
          (extraction.invoice_number_verified as string | null) ?? (extraction.invoice_number_ocr as string | null),
        vendorAliasVendorId: (vendorAliasRes.data?.vendor_id as number | undefined) ?? null,
      },
      candidatePool
    ).map((c) => ({
      entryId: c.id,
      score: c.score,
      vendorRaw: c.vendorRaw,
      amount: c.amount,
      date: c.date,
      ubblNumber: c.ubblNumber,
      mainNumber: c.mainNumber,
      departmentName: c.departmentId !== null ? (departmentNameById.get(c.departmentId) ?? null) : null,
    }))
  }

  const siblingBills: SiblingBill[] = (siblingBillsRes.data ?? [])
    .map((b) => ({
      documentExtractionId: b.id as number,
      billIndex: b.bill_index as number,
      matched: (b.entry_id as number | null) !== null,
      verifiedAt: b.verified_at as string | null,
      pageNumberStart: b.page_number_start as number | null,
      pageNumberEnd: b.page_number_end as number | null,
    }))
    .sort((a, b) => a.billIndex - b.billIndex)

  const lineItems: LineItemDetail[] = (lineItemsRes.data ?? []).map((li) => ({
    id: li.id as number,
    lineOrder: li.line_order as number,
    description: { ocr: li.description_ocr as string | null, verified: li.description_verified as string | null },
    hsnSacCode: { ocr: li.hsn_sac_code_ocr as string | null, verified: li.hsn_sac_code_verified as string | null },
    quantity: { ocr: li.quantity_ocr as number | null, verified: li.quantity_verified as number | null },
    quantityRawText: {
      ocr: li.quantity_raw_text_ocr as string | null,
      verified: li.quantity_raw_text_verified as string | null,
    },
    unit: { ocr: li.unit_ocr as string | null, verified: li.unit_verified as string | null },
    unitNormalized: li.unit_normalized as string | null,
    rate: { ocr: li.rate_ocr as number | null, verified: li.rate_verified as number | null },
    discount: { ocr: li.discount_ocr as string | null, verified: li.discount_verified as string | null },
    amount: { ocr: li.amount_ocr as number | null, verified: li.amount_verified as number | null },
  }))

  // Redesign plan (review page rail): a page is "done" once every bill whose
  // page range covers it has verified_at set. Most pages fall in exactly one
  // bill's range; a page is only left unverified if ANY covering bill isn't
  // (every() vacuously true -- and therefore not verified -- for a page no
  // bill's range covers at all, which matches "nothing to show as done here").
  const billRanges = (siblingBillsRes.data ?? []).map((b) => ({
    start: b.page_number_start as number | null,
    end: b.page_number_end as number | null,
    verified: (b.verified_at as string | null) !== null,
  }))
  function isPageVerified(pageNumber: number): boolean {
    const covering = billRanges.filter(
      (r) => r.start !== null && r.end !== null && r.start <= pageNumber && pageNumber <= r.end
    )
    return covering.length > 0 && covering.every((r) => r.verified)
  }

  const pages: PageStatus[] = (pagesRes.data ?? []).map((p) => ({
    pageNumber: p.page_number as number,
    isFinancialDocument: p.is_financial_document as boolean | null,
    skipReason: p.skip_reason as string | null,
    classificationConfidence: p.classification_confidence as number | null,
    skipSource: (p.skip_source as string | null) === 'manual' ? 'manual' : 'model',
    verified: isPageVerified(p.page_number as number),
  }))

  // uncertain_fields_ocr is jsonb -- shaped by extractionUncertainFieldSchema
  // (lib/extraction-schema.ts) at write time (lib/jobs/handlers/extract.ts),
  // never hand-authored, so a raw cast is fine here the same way the other
  // jsonb columns (tax_breakdown_ocr) are read elsewhere in this codebase.
  const uncertainFields: UncertainField[] = (
    (extraction.uncertain_fields_ocr as
      | { field: string; line_order: number | null; page_number: number; bbox_x0: number; bbox_y0: number; bbox_x1: number; bbox_y1: number }[]
      | null) ?? []
  ).map((f) => ({
    field: f.field,
    lineOrder: f.line_order,
    pageNumber: f.page_number,
    bboxX0: f.bbox_x0,
    bboxY0: f.bbox_y0,
    bboxX1: f.bbox_x1,
    bboxY1: f.bbox_y1,
  }))

  const openExceptions: OpenExceptionSummary[] = (exceptionsRes.data ?? []).map((e) => ({
    id: e.id as number,
    exceptionType: e.exception_type as string,
    severity: e.severity as 'low' | 'medium' | 'high',
    description: e.description as string | null,
    createdAt: e.created_at as string,
  }))

  // Plan §12 trigger condition: GST is "charged" when any tax component is
  // present and non-zero, or the instrument itself is classified as a tax
  // invoice -- mirrors the same check lib/jobs/handlers/extract.ts runs
  // server-side to decide whether to raise the compliance exception at all.
  const taxAmount = (extraction.tax_amount_verified ?? extraction.tax_amount_ocr) as number | null
  const taxBreakdown = extraction.tax_breakdown_ocr as {
    cgst?: { amount: number | null } | null
    sgst?: { amount: number | null } | null
    igst?: { amount: number | null } | null
  } | null
  const gstCharged =
    (taxAmount !== null && taxAmount !== 0) ||
    [taxBreakdown?.cgst, taxBreakdown?.sgst, taxBreakdown?.igst].some(
      (component) => component?.amount !== null && component?.amount !== undefined && component.amount !== 0
    ) ||
    extraction.instrument_type_ocr === 'tax_invoice'

  return {
    sourceDocumentId,
    documentExtractionId,
    billIndex: extraction.bill_index as number,
    // 2.2: sourced from the sibling-bills query above -- every
    // document_extraction row for this source_document_id, unfiltered by
    // verified_at, so the denominator never drops as bills get verified
    // (unlike v_review_queue's bill_count, which excludes verified bills).
    billCount: (siblingBillsRes.data ?? []).length,
    pageNumberStart: extraction.page_number_start as number | null,
    pageNumberEnd: extraction.page_number_end as number | null,
    originalFilename: sourceDoc.original_filename as string,
    matchStatus: sourceDoc.match_status as string,
    entryId,
    entryUbblNumber: entry?.ubbl_number ?? null,
    entryInvoiceNumber: entry?.invoice_number ?? null,
    entryAmount: entry?.amount ?? null,
    entryVendorId: entry?.vendor_id ?? null,
    entryDepartmentId: entry?.department_id ?? null,
    entryDepartmentName,
    entryAdminHeadId: entry?.admin_head_id ?? null,
    entryZoneId: entry?.zone_id ?? null,
    entrySubDepartmentId: entry?.sub_department_id ?? null,
    adminHeadOptions,
    zoneOptions,
    subDepartmentOptions,
    matchCandidates,
    siblingBills,
    claimedBy: sourceDoc.claimed_by as string | null,
    claimedAt: sourceDoc.claimed_at as string | null,
    claimedByIsMe: sourceDoc.claimed_by === user.id,
    currentUserId: user.id,
    currentExtractionRunId: (extraction.current_extraction_run_id as number | null) ?? null,
    extractionConfidence: run?.extraction_confidence ?? null,
    legibility: run?.legibility ?? null,
    model: run?.model ?? null,
    verifiedAt: extraction.verified_at as string | null,
    gstCharged,
    header: {
      vendorName: { ocr: extraction.vendor_name_ocr, verified: extraction.vendor_name_verified },
      vendorGstin: { ocr: extraction.vendor_gstin_ocr, verified: extraction.vendor_gstin_verified },
      vendorPhone: { ocr: extraction.vendor_phone_ocr, verified: extraction.vendor_phone_verified },
      vendorEmail: { ocr: extraction.vendor_email_ocr, verified: extraction.vendor_email_verified },
      vendorAddress: { ocr: extraction.vendor_address_ocr, verified: extraction.vendor_address_verified },
      buyerGstin: { ocr: extraction.buyer_gstin_ocr, verified: extraction.buyer_gstin_verified },
      buyerName: { ocr: extraction.buyer_name_ocr, verified: extraction.buyer_name_verified },
      invoiceNumber: { ocr: extraction.invoice_number_ocr, verified: extraction.invoice_number_verified },
      invoiceDate: { ocr: extraction.invoice_date_ocr, verified: extraction.invoice_date_verified },
      subtotal: { ocr: extraction.subtotal_ocr, verified: extraction.subtotal_verified },
      taxAmount: { ocr: extraction.tax_amount_ocr, verified: extraction.tax_amount_verified },
      totalAmount: { ocr: extraction.total_amount_ocr, verified: extraction.total_amount_verified },
      notes: { ocr: extraction.notes_ocr, verified: extraction.notes_verified },
    },
    lineItems,
    uncertainFields,
    pages,
    openExceptions,
    canSetHubStatus: entryId !== null,
    hubStatusCode: entryHubStatusCode,
    hubStatusOptions: (hubStatusRes.data ?? []).map((h) => ({ id: h.id as number, code: h.code as string, label: h.label as string })),
  }
}
