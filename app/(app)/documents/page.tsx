import { Card, CardContent } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStaffContext } from '@/lib/export/auth'
import { DocumentInbox } from '@/components/documents/document-inbox'
import type { DocumentExtractionSummary, InboxDocumentView } from '@/components/documents/types'
import type { LookupOption } from '@/components/entries/types'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { getSelectedEventId } from '@/lib/events/current'

/** A stalled queue is "the oldest queued job has been waiting longer than this" (checklist 2.15, D8) — long enough that a normal extraction backlog doesn't false-positive. */
const STALLED_QUEUE_THRESHOLD_MS = 10 * 60 * 1000

/**
 * /documents — the document inbox (MASTER-PLAN §5 row 6, §11.2 Day 3):
 * "Unmatched documents with suggested entry matches; attach, mark 'no entry
 * expected', or bulk-attach. Highest-volume flow — ~18 of 21 sample
 * documents land here."
 *
 * RSC fetches, hands off to a client component (same architecture as
 * /exceptions and the entries list) because the upload dropzone, per-file
 * progress, bulk-selection state, and per-document candidate picking are
 * all interactive. Any active staff can view — unmatched documents
 * (`entry_id is null`) are visible to all staff by design
 * (source_document_select RLS, 20260808000026, comment: "that visibility is
 * exactly what the inbox/matching workflow requires"). Attach / bulk-attach
 * / no-entry-expected stay admin-or-above — enforced by RLS
 * (private.is_admin_or_above(), 20260819000003 — dept lost this along with
 * every other reviewer capability) in lib/actions/documents.ts, and hidden
 * here for a dept account as a courtesy, not as the actual gate.
 */
export default async function DocumentsPage() {
  const staff = await getStaffContext()

  if (!staff) {
    return (
      <PageShell>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Sign in required</p>
            <p className="text-sm text-muted-foreground">You need to sign in to view the document inbox.</p>
          </CardContent>
        </Card>
      </PageShell>
    )
  }
  if (!staff.isActive) {
    return (
      <PageShell>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Your account is pending activation</p>
            <p className="text-sm text-muted-foreground">An admin needs to activate your account first.</p>
          </CardContent>
        </Card>
      </PageShell>
    )
  }

  const canAct = isAdminOrAbove(staff.role)
  const supabase = await createClient()

  // Phase 6 Step 2 §1: the inbox is scoped to whichever event is currently
  // selected (cookie, defaulting to the current event) -- a reviewer parked
  // on a past event must not see the current event's unmatched documents
  // mixed into a supposedly read-only, past-event view, and vice versa.
  const selectedEventId = await getSelectedEventId(supabase)

  let docsQuery = supabase
    .from('source_document')
    .select('id, original_filename, upload_status, match_status, uploaded_at, page_count')
    .in('match_status', ['unmatched', 'suggested'])
  if (selectedEventId !== null) {
    docsQuery = docsQuery.eq('event_id', selectedEventId)
  }
  const { data: docsData, error: docsError } = await docsQuery.order('uploaded_at', { ascending: false })

  if (docsError) {
    return (
      <PageShell>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium">Could not load the document inbox</p>
            <FriendlyError message={docsError.message} />
          </CardContent>
        </Card>
      </PageShell>
    )
  }

  const docs = docsData ?? []
  const docIds = docs.map((d) => d.id)

  // document_extraction is fetched separately (rather than embedded in the
  // select above) so this file never has to guess whether PostgREST returns
  // a one-to-many embed as an array in every supabase-js version — a plain
  // second query + grouped Map is unambiguous either way.
  //
  // 1:many per source_document since 20260817000002 (a scanned PDF can
  // contain several distinct bills) — grouped into a Map<number, Extraction[]>
  // rather than last-row-wins, so a multi-bill document doesn't silently
  // drop every bill but one (plan.md D4 / checklist 1.10).
  interface ExtractionRow {
    id: number
    source_document_id: number
    bill_index: number
    vendor_name_ocr: string | null
    invoice_date_ocr: string | null
    invoice_number_ocr: string | null
    total_amount_ocr: number | null
    verified_at: string | null
  }

  const { data: extractionsData } =
    docIds.length > 0
      ? await supabase
          .from('document_extraction')
          .select(
            'id, source_document_id, bill_index, vendor_name_ocr, invoice_date_ocr, invoice_number_ocr, total_amount_ocr, verified_at'
          )
          .in('source_document_id', docIds)
          .order('bill_index', { ascending: true })
      : { data: [] as ExtractionRow[] }

  const extractionsByDocId = new Map<number, ExtractionRow[]>()
  for (const extraction of extractionsData ?? []) {
    const existing = extractionsByDocId.get(extraction.source_document_id)
    if (existing) {
      existing.push(extraction)
    } else {
      extractionsByDocId.set(extraction.source_document_id, [extraction])
    }
  }

  // Failure reasons are fetched separately, only for documents currently
  // sitting in 'failed' — most documents never fail, so this is a small,
  // targeted query rather than joining ocr_extraction_run for every document.
  // Ordered newest-first so the Map (first-seen-wins) lands on each
  // document's most recent failed run, in case it was retried more than once.
  const failedDocIds = docs.filter((d) => d.upload_status === 'failed').map((d) => d.id)
  const { data: failedRunsData } =
    failedDocIds.length > 0
      ? await supabase
          .from('ocr_extraction_run')
          .select('source_document_id, error_message, created_at')
          .in('source_document_id', failedDocIds)
          .eq('status', 'failed')
          .order('created_at', { ascending: false })
      : { data: [] as never[] }

  const failureReasonByDocId = new Map<number, string | null>()
  for (const run of failedRunsData ?? []) {
    if (!failureReasonByDocId.has(run.source_document_id)) {
      failureReasonByDocId.set(run.source_document_id, run.error_message)
    }
  }

  // Phase 6 Step 2 §1.1: admin_head/zone are shared master rows across
  // events -- only which of them are ACTIVE in the selected event varies
  // (event_admin_head/event_zone membership). Resolved as a separate id
  // lookup rather than a PostgREST embed/join, matching the same
  // two-step shape used for department in lib/actions/documents.ts's
  // getInboxMatchCandidates.
  const [eventAdminHeadResult, eventZoneResult] = await Promise.all([
    selectedEventId !== null
      ? supabase.from('event_admin_head').select('admin_head_id').eq('event_id', selectedEventId)
      : Promise.resolve({ data: [] as { admin_head_id: number }[] }),
    selectedEventId !== null
      ? supabase.from('event_zone').select('zone_id').eq('event_id', selectedEventId)
      : Promise.resolve({ data: [] as { zone_id: number }[] }),
  ])
  const activeAdminHeadIds = (eventAdminHeadResult.data ?? []).map((r) => r.admin_head_id as number)
  const activeZoneIds = (eventZoneResult.data ?? []).map((r) => r.zone_id as number)

  // Fetched once here rather than per-document: the attach-time zone/admin-
  // head prompt (checklist 5.11/5.12, plan §8 Z2) needs the full option
  // lists in the client to populate its dropdowns (5.11, department-scoped
  // client-side by document-card.tsx) and to feed BulkEnrichmentDialog
  // (5.12, unfiltered — a bulk selection can span departments). Same
  // shape/labeling convention as components/entries/entries-explorer.tsx's
  // filter options. Now additionally scoped to the selected event's
  // membership, on top of the pre-existing is_active flag -- a head/zone
  // retired from THIS event's carry-forward shouldn't appear even if its
  // own is_active flag (a separate, master-level concept) is still true.
  const [adminHeadLookupResult, zoneLookupResult, costCenterLookupResult] = await Promise.all([
    supabase
      .from('admin_head')
      .select('id, department_id, head_number, name')
      .eq('is_active', true)
      .in('id', activeAdminHeadIds)
      .order('head_number'),
    supabase
      .from('zone')
      .select('id, department_id, zone_number, name')
      .eq('is_active', true)
      .in('id', activeZoneIds)
      .order('zone_number'),
    supabase.from('cost_center').select('id, name').order('name'),
  ])
  const adminHeadOptions: LookupOption[] = (adminHeadLookupResult.data ?? []).map((h) => ({
    id: h.id,
    label: `${h.head_number}. ${h.name}`,
    department_id: h.department_id,
  }))
  const zoneOptions: LookupOption[] = (zoneLookupResult.data ?? []).map((z) => ({
    id: z.id,
    label: `${z.zone_number}. ${z.name}`,
    department_id: z.department_id,
  }))
  const costCenterOptions: LookupOption[] = (costCenterLookupResult.data ?? []).map((c) => ({
    id: c.id,
    label: c.name,
  }))

  const inboxDocuments: InboxDocumentView[] = docs.map((doc) => {
    const extractions = extractionsByDocId.get(doc.id) ?? []

    // Candidates are NOT ranked here any more (checklist 2.9, D6) — that
    // used to run inline on every render of this page, scoring every
    // unmatched/suggested bill against up to 5,000 entries before the page
    // could even respond. Each bill starts with an empty candidate list;
    // `DocumentInbox` fetches real rankings client-side, off this render
    // path, via `getInboxMatchCandidates` (lib/actions/documents.ts) right
    // after mount.
    const bills: DocumentExtractionSummary[] = extractions.map((extraction) => ({
      id: extraction.id,
      billIndex: extraction.bill_index,
      vendorNameOcr: extraction.vendor_name_ocr,
      invoiceDateOcr: extraction.invoice_date_ocr,
      invoiceNumberOcr: extraction.invoice_number_ocr,
      totalAmountOcr: extraction.total_amount_ocr,
      verifiedAt: extraction.verified_at,
      candidates: [],
    }))

    return {
      id: doc.id,
      originalFilename: doc.original_filename,
      uploadStatus: doc.upload_status,
      matchStatus: doc.match_status,
      uploadedAt: doc.uploaded_at,
      pageCount: doc.page_count,
      extraction: bills,
      failureReason: doc.upload_status === 'failed' ? failureReasonByDocId.get(doc.id) ?? null : null,
    }
  })

  // job_queue's RLS restricts select to admins only (job_queue_select_admin),
  // but the inbox itself is visible to every active staff member — so this
  // one query goes through the admin (service-role) client, same as
  // app/api/documents/ingest/route.ts's own job_queue writes, rather than
  // the session-bound client used everywhere else on this page. Just the
  // oldest queued row's timestamp, nothing else: cheap enough to run on
  // every page load (checklist 2.15, D8).
  const admin = createAdminClient()
  const { data: oldestQueuedJob } = await admin
    .from('job_queue')
    .select('created_at')
    .eq('status', 'queued')
    .eq('job_type', 'extract_document')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  const queueStalled = Boolean(
    oldestQueuedJob && Date.now() - new Date(oldestQueuedJob.created_at).getTime() > STALLED_QUEUE_THRESHOLD_MS
  )

  return (
    <PageShell count={inboxDocuments.length}>
      <DocumentInbox
        initialDocuments={inboxDocuments}
        canAct={canAct}
        queueStalled={queueStalled}
        adminHeadOptions={adminHeadOptions}
        zoneOptions={zoneOptions}
        costCenterOptions={costCenterOptions}
      />
    </PageShell>
  )
}

function PageShell({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Document inbox</h1>
        {count !== undefined && (
          <span className="text-sm text-muted-foreground">
            {count} unmatched {count === 1 ? 'document' : 'documents'}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}
