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
  searchParams: Promise<{ id?: string }>
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
  const { id: idParam } = await searchParams

  // Unverified/All toggle (review-page-layout-redesign-plan.md §1): the
  // position counter and Prev/Next used to silently span the whole document
  // set via v_review_queue -- which is actually already unverified-only
  // (`where de.verified_at is null`, 20260817000004). Default to that
  // pending-only view; the cookie (not a `?scope=` param, see
  // setReviewQueueScope's doc comment) lets a reviewer opt into
  // v_review_queue_all, the superset view with verified_at added, without
  // review-workspace.tsx's Prev/Next needing to carry a scope param through.
  const scope = (await cookies()).get('review_queue_scope')?.value === 'all' ? 'all' : 'pending'

  const { data: queueRows, error: queueError } = await supabase
    .from(scope === 'all' ? 'v_review_queue_all' : 'v_review_queue')
    .select(
      'document_extraction_id, source_document_id, original_filename, extraction_confidence, max_open_severity_rank, open_issue_count, queue_amount, bill_index, page_number_start, page_number_end, bill_count'
    )
    .order('max_open_severity_rank', { ascending: false })
    .order('extraction_confidence', { ascending: true, nullsFirst: true })
    .order('queue_amount', { ascending: false, nullsFirst: false })
    .limit(QUEUE_ROW_CAP)

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
        <PageHeader scope={scope} />
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <p className="text-sm font-medium">Queue is empty</p>
            <p className="text-sm text-muted-foreground">
              {scope === 'all'
                ? // v_review_queue_all has no verified_at filter, so this can
                  // basically only happen when no document has ever been
                  // extracted at all -- still worth a correct, non-assuming message.
                  'There are no extracted documents yet. New documents enter this queue as soon as extraction finishes (§8).'
                : 'Every extracted document has been verified. New documents enter this queue as soon as extraction finishes (§8) -- nothing to do here right now.'}
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
    const { data: outOfScopeRow } = await supabase
      .from('v_review_queue_all')
      .select('document_extraction_id, source_document_id, bill_count')
      .eq('document_extraction_id', requestedId as number)
      .maybeSingle()

    if (!outOfScopeRow) {
      // Id doesn't exist, or isn't visible under RLS -- fall back to the
      // original behavior rather than crashing.
      redirect(`/review?id=${queue[0]!.documentExtractionId}`)
    }

    const detail = await loadDocumentDetail(
      supabase,
      outOfScopeRow.source_document_id as number,
      outOfScopeRow.document_extraction_id as number,
      outOfScopeRow.bill_count as number
    )

    if (!detail) {
      redirect(`/review?id=${queue[0]!.documentExtractionId}`)
    }

    return (
      <div className="flex h-[calc(100vh-3rem)] flex-col gap-3">
        <PageHeader total={queue.length} scope={scope} />
        <ReviewWorkspace
          key={`${detail.documentExtractionId}:${detail.currentExtractionRunId ?? 'none'}`}
          detail={detail}
          queue={queue.map((q) => ({ documentExtractionId: q.documentExtractionId }))}
          currentIndex={-1}
          prevId={null}
          nextId={null}
        />
      </div>
    )
  }

  const current = queue[currentIndex]!
  const detail = await loadDocumentDetail(supabase, current.sourceDocumentId, current.documentExtractionId, current.billCount)

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
      <PageHeader position={currentIndex + 1} total={queue.length} scope={scope} />
      <ReviewWorkspace
        key={`${detail.documentExtractionId}:${detail.currentExtractionRunId ?? 'none'}`}
        detail={detail}
        queue={queue.map((q) => ({ documentExtractionId: q.documentExtractionId }))}
        currentIndex={currentIndex}
        prevId={prevId}
        nextId={nextId}
      />
    </div>
  )
}

function PageHeader({
  position,
  total,
  scope,
}: {
  position?: number
  total?: number
  scope?: 'pending' | 'all'
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold tracking-tight">Review queue</h1>
      {position !== undefined && total !== undefined ? (
        <span className="text-sm text-muted-foreground">
          Document {position} of {total}
        </span>
      ) : null}
      {scope !== undefined ? <QueueScopeToggle current={scope} /> : null}
      <span className="ml-auto text-xs text-muted-foreground">Press ? for keyboard shortcuts</span>
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
  billCount: number
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
      .select('page_number, is_financial_document, skip_reason, classification_confidence')
      .eq('source_document_id', sourceDocumentId)
      .order('page_number'),
    // Bill rail (§7): every bill sharing this source_document_id, so a
    // multi-bill PDF can show each sibling's match state at a glance. Only
    // needs sourceDocumentId, already known from the caller -- no reason to
    // serialize this behind the rest of this document's own data.
    supabase
      .from('document_extraction')
      .select('id, bill_index, entry_id')
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
          .select('id, amount, ubbl_number, invoice_number, vendor_id, hub_status_id, department_id, admin_head_id, zone_id')
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
  } | null

  let entryVendorDisplayName: string | null = null
  let entryHubStatusCode: string | null = null
  if (entry?.vendor_id) {
    const { data: vendor } = await supabase.from('vendor').select('display_name').eq('id', entry.vendor_id).maybeSingle()
    entryVendorDisplayName = (vendor?.display_name as string | undefined) ?? null
  }
  if (entry?.hub_status_id) {
    const { data: hs } = await supabase.from('hub_status').select('code').eq('id', entry.hub_status_id).maybeSingle()
    entryHubStatusCode = (hs?.code as string | undefined) ?? null
  }

  // Stage 3 (Classify, §8) options, scoped to the matched entry's
  // department -- same pattern as app/(app)/entries/[id]/page.tsx.
  let adminHeadOptions: { id: number; head_number: number; name: string }[] = []
  let zoneOptions: { id: number; zone_number: number; name: string }[] = []
  if (entry?.department_id) {
    const [adminHeadsRes, zonesRes] = await Promise.all([
      supabase
        .from('admin_head')
        .select('id, head_number, name')
        .eq('department_id', entry.department_id)
        .eq('is_active', true)
        .order('head_number'),
      supabase
        .from('zone')
        .select('id, zone_number, name')
        .eq('department_id', entry.department_id)
        .eq('is_active', true)
        .order('zone_number'),
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
    }))
  }

  const siblingBills: SiblingBill[] = (siblingBillsRes.data ?? [])
    .map((b) => ({
      documentExtractionId: b.id as number,
      billIndex: b.bill_index as number,
      matched: (b.entry_id as number | null) !== null,
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

  const pages: PageStatus[] = (pagesRes.data ?? []).map((p) => ({
    pageNumber: p.page_number as number,
    isFinancialDocument: p.is_financial_document as boolean | null,
    skipReason: p.skip_reason as string | null,
    classificationConfidence: p.classification_confidence as number | null,
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
    billCount,
    pageNumberStart: extraction.page_number_start as number | null,
    pageNumberEnd: extraction.page_number_end as number | null,
    originalFilename: sourceDoc.original_filename as string,
    matchStatus: sourceDoc.match_status as string,
    entryId,
    entryUbblNumber: entry?.ubbl_number ?? null,
    entryInvoiceNumber: entry?.invoice_number ?? null,
    entryAmount: entry?.amount ?? null,
    entryVendorId: entry?.vendor_id ?? null,
    entryVendorDisplayName,
    entryDepartmentId: entry?.department_id ?? null,
    entryAdminHeadId: entry?.admin_head_id ?? null,
    entryZoneId: entry?.zone_id ?? null,
    adminHeadOptions,
    zoneOptions,
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
