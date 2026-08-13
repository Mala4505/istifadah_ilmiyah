import { Card, CardContent } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { rankCandidates, type MatchableEntry } from '@/lib/matching'
import { DocumentInbox } from '@/components/documents/document-inbox'
import type { CandidateEntryView, InboxDocumentView } from '@/components/documents/types'

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
 * / no-entry-expected stay reviewer/admin — enforced by RLS
 * (private.is_reviewer_or_admin()) in lib/actions/documents.ts, and hidden
 * here for a viewer as a courtesy, not as the actual gate.
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

  const canAct = staff.role === 'admin' || staff.role === 'reviewer'
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
  // a one-to-one embed as an object or a one-row array for a given
  // supabase-js version — a plain second query + Map is unambiguous either way.
  const { data: extractionsData } =
    docIds.length > 0
      ? await supabase
          .from('document_extraction')
          .select('source_document_id, vendor_name_ocr, invoice_date_ocr, invoice_number_ocr, total_amount_ocr')
          .in('source_document_id', docIds)
      : { data: [] as never[] }

  const extractionByDocId = new Map((extractionsData ?? []).map((e) => [e.source_document_id, e]))

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
    .select('id, department_id, vendor_raw, amount, date, ubbl_number, main_number')
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
    }))

  const { data: departmentsData } = await supabase.from('department').select('id, name')
  const departmentNameById = new Map((departmentsData ?? []).map((d) => [d.id, d.name as string]))

  const inboxDocuments: InboxDocumentView[] = docs.map((doc) => {
    const extraction = extractionByDocId.get(doc.id) ?? null

    const candidates: CandidateEntryView[] = extraction
      ? rankCandidates(
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
        }))
      : []

    return {
      id: doc.id,
      originalFilename: doc.original_filename,
      uploadStatus: doc.upload_status,
      matchStatus: doc.match_status,
      uploadedAt: doc.uploaded_at,
      pageCount: doc.page_count,
      extraction: extraction
        ? {
            vendorNameOcr: extraction.vendor_name_ocr,
            invoiceDateOcr: extraction.invoice_date_ocr,
            invoiceNumberOcr: extraction.invoice_number_ocr,
            totalAmountOcr: extraction.total_amount_ocr,
          }
        : null,
      candidates,
    }
  })

  return (
    <PageShell count={inboxDocuments.length}>
      <DocumentInbox initialDocuments={inboxDocuments} canAct={canAct} />
    </PageShell>
  )
}

function PageShell({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Document inbox</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          Phase 1B · Day 3
        </span>
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
