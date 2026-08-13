import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { Card, CardContent } from '@/components/ui/card'
import { ReviewWorkspace } from '@/components/review/review-workspace'
import type { LineItemDetail, OpenExceptionSummary, QueueEntry, ReviewDocumentDetail } from '@/lib/review/types'
import { friendlyErrorMessage } from '@/lib/friendly-error'

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
  if (staff.role === 'viewer') {
    return (
      <GatedState
        title="Reviewers and admins only"
        body="Verifying document extractions requires the reviewer or admin role."
      />
    )
  }

  const supabase = await createClient()
  const { id: idParam } = await searchParams

  const { data: queueRows, error: queueError } = await supabase
    .from('v_review_queue')
    .select(
      'document_extraction_id, source_document_id, original_filename, extraction_confidence, max_open_severity_rank, open_issue_count, queue_amount'
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
  }))

  if (queue.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader />
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <p className="text-sm font-medium">Queue is empty</p>
            <p className="text-sm text-muted-foreground">
              Every extracted document has been verified. New documents enter this queue as soon as
              extraction finishes (§8) -- nothing to do here right now.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const requestedId = idParam ? Number(idParam) : null
  const currentIndex = requestedId !== null ? queue.findIndex((q) => q.sourceDocumentId === requestedId) : -1

  if (currentIndex === -1) {
    // No id, or a stale/invalid one (e.g. just-verified, or another
    // reviewer's bookmark) -- canonicalize to the top of the queue rather
    // than rendering nothing.
    redirect(`/review?id=${queue[0]!.sourceDocumentId}`)
  }

  const current = queue[currentIndex]!
  const detail = await loadDocumentDetail(supabase, current.sourceDocumentId, current.documentExtractionId)

  if (!detail) {
    // The document left the queue between the list query and the detail
    // query (verified by someone else in the last few hundred ms) -- redirect
    // rather than render a broken form.
    redirect(`/review?id=${queue[currentIndex + 1]?.sourceDocumentId ?? queue[0]!.sourceDocumentId}`)
  }

  const prevId = queue[currentIndex - 1]?.sourceDocumentId ?? null
  const nextId = queue[currentIndex + 1]?.sourceDocumentId ?? null

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col gap-3">
      <PageHeader position={currentIndex + 1} total={queue.length} />
      <ReviewWorkspace
        key={`${detail.sourceDocumentId}:${detail.currentExtractionRunId ?? 'none'}`}
        detail={detail}
        queue={queue.map((q) => ({ sourceDocumentId: q.sourceDocumentId }))}
        currentIndex={currentIndex}
        prevId={prevId}
        nextId={nextId}
      />
    </div>
  )
}

function PageHeader({ position, total }: { position?: number; total?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold tracking-tight">Review queue</h1>
      <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
        Phase 1B · Day 4
      </span>
      {position !== undefined && total !== undefined ? (
        <span className="text-sm text-muted-foreground">
          Document {position} of {total}
        </span>
      ) : null}
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
  documentExtractionId: number
): Promise<ReviewDocumentDetail | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const [sourceDocRes, extractionRes, lineItemsRes] = await Promise.all([
    supabase
      .from('source_document')
      .select('id, entry_id, original_filename, match_status, claimed_by, claimed_at')
      .eq('id', sourceDocumentId)
      .maybeSingle(),
    supabase
      .from('document_extraction')
      .select(
        'id, current_extraction_run_id, verified_at, vendor_name_ocr, vendor_name_verified, vendor_gstin_ocr, vendor_gstin_verified, vendor_phone_ocr, vendor_phone_verified, vendor_address_ocr, vendor_address_verified, invoice_number_ocr, invoice_number_verified, invoice_date_ocr, invoice_date_verified, subtotal_ocr, subtotal_verified, tax_amount_ocr, tax_amount_verified, total_amount_ocr, total_amount_verified, notes_ocr, notes_verified'
      )
      .eq('id', documentExtractionId)
      .maybeSingle(),
    supabase
      .from('document_extraction_line_item')
      .select(
        'id, line_order, description_ocr, description_verified, hsn_sac_code_ocr, hsn_sac_code_verified, quantity_ocr, quantity_verified, quantity_raw_text_ocr, quantity_raw_text_verified, unit_ocr, unit_verified, unit_normalized, list_rate_ocr, list_rate_verified, discount_pct_ocr, discount_pct_verified, discount_note_ocr, discount_note_verified, net_rate_ocr, net_rate_verified, line_amount_ocr, line_amount_verified'
      )
      .eq('document_extraction_id', documentExtractionId)
      .order('line_order'),
  ])

  const sourceDoc = sourceDocRes.data
  const extraction = extractionRes.data
  if (!sourceDoc || !extraction) return null

  const entryId = sourceDoc.entry_id as number | null

  const [runRes, entryRes, exceptionsRes, hubStatusRes] = await Promise.all([
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
          .select('id, amount, ubbl_number, invoice_number, vendor_id, hub_status_id')
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
  ])

  const run = runRes.data as { extraction_confidence: number | null; legibility: 'clear' | 'partial' | 'poor' | null; model: string | null } | null
  const entry = entryRes.data as {
    id: number
    amount: number | null
    ubbl_number: string
    invoice_number: string | null
    vendor_id: number | null
    hub_status_id: number | null
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
    listRate: { ocr: li.list_rate_ocr as number | null, verified: li.list_rate_verified as number | null },
    discountPct: { ocr: li.discount_pct_ocr as number | null, verified: li.discount_pct_verified as number | null },
    discountNote: {
      ocr: li.discount_note_ocr as string | null,
      verified: li.discount_note_verified as string | null,
    },
    netRate: { ocr: li.net_rate_ocr as number | null, verified: li.net_rate_verified as number | null },
    lineAmount: { ocr: li.line_amount_ocr as number | null, verified: li.line_amount_verified as number | null },
  }))

  const openExceptions: OpenExceptionSummary[] = (exceptionsRes.data ?? []).map((e) => ({
    id: e.id as number,
    exceptionType: e.exception_type as string,
    severity: e.severity as 'low' | 'medium' | 'high',
    description: e.description as string | null,
    createdAt: e.created_at as string,
  }))

  return {
    sourceDocumentId,
    documentExtractionId,
    originalFilename: sourceDoc.original_filename as string,
    matchStatus: sourceDoc.match_status as string,
    entryId,
    entryUbblNumber: entry?.ubbl_number ?? null,
    entryInvoiceNumber: entry?.invoice_number ?? null,
    entryAmount: entry?.amount ?? null,
    entryVendorId: entry?.vendor_id ?? null,
    entryVendorDisplayName,
    claimedBy: sourceDoc.claimed_by as string | null,
    claimedAt: sourceDoc.claimed_at as string | null,
    claimedByIsMe: sourceDoc.claimed_by === user.id,
    currentUserId: user.id,
    currentExtractionRunId: (extraction.current_extraction_run_id as number | null) ?? null,
    extractionConfidence: run?.extraction_confidence ?? null,
    legibility: run?.legibility ?? null,
    model: run?.model ?? null,
    verifiedAt: extraction.verified_at as string | null,
    header: {
      vendorName: { ocr: extraction.vendor_name_ocr, verified: extraction.vendor_name_verified },
      vendorGstin: { ocr: extraction.vendor_gstin_ocr, verified: extraction.vendor_gstin_verified },
      vendorPhone: { ocr: extraction.vendor_phone_ocr, verified: extraction.vendor_phone_verified },
      vendorAddress: { ocr: extraction.vendor_address_ocr, verified: extraction.vendor_address_verified },
      invoiceNumber: { ocr: extraction.invoice_number_ocr, verified: extraction.invoice_number_verified },
      invoiceDate: { ocr: extraction.invoice_date_ocr, verified: extraction.invoice_date_verified },
      subtotal: { ocr: extraction.subtotal_ocr, verified: extraction.subtotal_verified },
      taxAmount: { ocr: extraction.tax_amount_ocr, verified: extraction.tax_amount_verified },
      totalAmount: { ocr: extraction.total_amount_ocr, verified: extraction.total_amount_verified },
      notes: { ocr: extraction.notes_ocr, verified: extraction.notes_verified },
    },
    lineItems,
    openExceptions,
    canSetHubStatus: entryId !== null,
    hubStatusCode: entryHubStatusCode,
    hubStatusOptions: (hubStatusRes.data ?? []).map((h) => ({ id: h.id as number, code: h.code as string, label: h.label as string })),
  }
}
