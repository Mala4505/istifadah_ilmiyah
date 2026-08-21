import { Card, CardContent } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStaffContext } from '@/lib/export/auth'
import { rankCandidates, type MatchableEntry } from '@/lib/matching'
import { DocumentInbox } from '@/components/documents/document-inbox'
import type { CandidateEntryView, DocumentExtractionSummary, InboxDocumentView } from '@/components/documents/types'
import type { LookupOption } from '@/components/entries/types'
import { isAdminOrAbove } from '@/lib/auth/roles'

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

  const { data: docsData, error: docsError } = await supabase
    .from('source_document')
    .select('id, original_filename, upload_status, match_status, uploaded_at, page_count')
    .in('match_status', ['unmatched', 'suggested'])
    .order('uploaded_at', { ascending: false })

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
  }

  const { data: extractionsData } =
    docIds.length > 0
      ? await supabase
          .from('document_extraction')
          .select(
            'id, source_document_id, bill_index, vendor_name_ocr, invoice_date_ocr, invoice_number_ocr, total_amount_ocr'
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

  // Entries already attached to some document are excluded from the
  // candidate pool — one invoice does not usually belong to two documents,
  // and surfacing an already-matched entry as a "suggestion" would just
  // invite a confusing double-attach.
  const { data: matchedRows } = await supabase
    .from('source_document')
    .select('entry_id')
    .eq('match_status', 'matched')
    .not('entry_id', 'is', null)
  const matchedEntryIds = new Set((matchedRows ?? []).map((r) => r.entry_id as number))

  // Bounded to a recent, generous window rather than every entry ever
  // imported — reasonable at the stated 1,000–10,000 entry volume (§0)
  // without risking an unbounded scan as the event's history grows across
  // future runs. A documented simplification, not a hard requirement.
  const { data: entriesData } = await supabase
    .from('entries')
    .select('id, department_id, vendor_raw, amount, date, ubbl_number, main_number, admin_head_id, zone_id')
    .eq('is_void', false)
    // nullsFirst: false — Postgres's own default for DESC is NULLS FIRST,
    // which would let entries with no date at all crowd out dated ones
    // inside the 5000-row window below.
    .order('date', { ascending: false, nullsFirst: false })
    .limit(5000)

  const candidatePool: MatchableEntry[] = (entriesData ?? [])
    .filter((e) => !matchedEntryIds.has(e.id))
    .map((e) => ({
      id: e.id,
      vendorRaw: e.vendor_raw,
      amount: e.amount,
      date: e.date,
      departmentId: e.department_id,
      ubblNumber: e.ubbl_number,
      mainNumber: e.main_number,
      adminHeadId: e.admin_head_id,
      zoneId: e.zone_id,
    }))

  const { data: departmentsData } = await supabase.from('department').select('id, name')
  const departmentNameById = new Map((departmentsData ?? []).map((d) => [d.id, d.name as string]))

  // Fetched once here rather than per-document: the attach-time zone/admin-
  // head prompt (checklist 5.11/5.12, plan §8 Z2) needs the full option
  // lists in the client to populate its dropdowns (5.11, department-scoped
  // client-side by document-card.tsx) and to feed BulkEnrichmentDialog
  // (5.12, unfiltered — a bulk selection can span departments). Same
  // shape/labeling convention as components/entries/entries-explorer.tsx's
  // filter options.
  const [adminHeadLookupResult, zoneLookupResult, costCenterLookupResult] = await Promise.all([
    supabase.from('admin_head').select('id, department_id, head_number, name').eq('is_active', true).order('head_number'),
    supabase.from('zone').select('id, department_id, zone_number, name').eq('is_active', true).order('zone_number'),
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

    // Ranked once per bill, against that bill's own OCR fields — a 4-bill
    // PDF must not rank every bill against whichever one happened to be
    // extracted last (plan.md D4 / checklist 1.13).
    const bills: DocumentExtractionSummary[] = extractions.map((extraction) => {
      const candidates: CandidateEntryView[] = rankCandidates(
        {
          vendorName: extraction.vendor_name_ocr,
          totalAmount: extraction.total_amount_ocr,
          invoiceDate: extraction.invoice_date_ocr,
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
        departmentName: c.departmentId !== null ? departmentNameById.get(c.departmentId) ?? null : null,
        entryDepartmentId: c.departmentId,
        adminHeadId: c.adminHeadId ?? null,
        zoneId: c.zoneId ?? null,
      }))

      return {
        id: extraction.id,
        billIndex: extraction.bill_index,
        vendorNameOcr: extraction.vendor_name_ocr,
        invoiceDateOcr: extraction.invoice_date_ocr,
        invoiceNumberOcr: extraction.invoice_number_ocr,
        totalAmountOcr: extraction.total_amount_ocr,
        candidates,
      }
    })

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
