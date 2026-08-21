'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import {
  Loader2,
  Search,
  ExternalLink,
  FileX2,
  CheckCircle2,
  XCircle,
  Circle,
  RefreshCw,
  AlertTriangle,
  Flag,
  PenLine,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  attachDocumentToEntry,
  getDocumentPreviewUrl,
  manualExtractNow,
  markNoEntryExpected,
  searchEntriesForAttach,
  type EntrySearchResult,
} from '@/lib/actions/documents'
import { getRecentClassificationDefaults } from '@/lib/actions/entry-classification-defaults'
import { setEntryClassification } from '@/lib/actions/entry-enrichment'
import { flagReviewException } from '@/lib/actions/review'
import { extractionFailureGuidance } from '@/lib/friendly-error'
import type { LookupOption } from '@/components/entries/types'
import { formatDate, formatDateTime, formatElapsed, formatMoney, formatScore } from './format'
import type { CandidateEntryView, InboxDocumentView } from './types'

/** Sentinel for "no selection" in the zone/admin-head Selects below — same convention as components/entries/detail/enrichment-form.tsx's NONE. */
const NONE = '__none__'

export type StageState = 'done' | 'active' | 'pending' | 'failed'

/**
 * Honest progress for a one-shot, non-streaming extraction call: there is no
 * partial percentage to report, so "how much is left" is answered as stages
 * instead — Uploaded (the HTTP upload already finished) → Queued (sitting in
 * `job_queue`, or about to be) → Extracting (the Claude call is in flight) →
 * Extracted / Failed. Shared between the card (full labels) and the table's
 * compact row rendering (icons only) so the mapping from `uploadStatus` to
 * stage lives in exactly one place.
 */
export function stagesFor(uploadStatus: InboxDocumentView['uploadStatus']): Array<{ label: string; state: StageState }> {
  const queuedState: StageState = uploadStatus === 'uploaded' ? 'active' : 'done'
  const extractingState: StageState =
    uploadStatus === 'processing'
      ? 'active'
      : uploadStatus === 'processed' || uploadStatus === 'failed'
        ? 'done'
        : 'pending'
  const finalStage: { label: string; state: StageState } =
    uploadStatus === 'processed'
      ? { label: 'Extracted', state: 'done' }
      : uploadStatus === 'failed'
        ? { label: 'Failed', state: 'failed' }
        : { label: 'Extracted', state: 'pending' }

  return [
    { label: 'Uploaded', state: 'done' },
    { label: 'Queued', state: queuedState },
    { label: 'Extracting', state: extractingState },
    finalStage,
  ]
}

/** "queued 6m ago" / "extracting, started 2h ago" / "failed just now" — so a document stuck for hours is visually obvious next to the stage row. */
function elapsedLabelFor(uploadStatus: InboxDocumentView['uploadStatus'], uploadedAt: string): string {
  const elapsed = formatElapsed(uploadedAt)
  switch (uploadStatus) {
    case 'uploaded':
      return `queued ${elapsed}`
    case 'processing':
      return `extracting, started ${elapsed}`
    case 'failed':
      return `failed ${elapsed}`
    case 'processed':
      return `extracted ${elapsed}`
  }
}

function StageIcon({ state, className }: { state: StageState; className: string }) {
  if (state === 'done') return <CheckCircle2 className={`${className} text-emerald-600`} aria-hidden="true" />
  if (state === 'active') return <Loader2 className={`${className} animate-spin text-amber-600`} aria-hidden="true" />
  if (state === 'failed') return <XCircle className={`${className} text-destructive`} aria-hidden="true" />
  return <Circle className={`${className} text-muted-foreground/40`} aria-hidden="true" />
}

/** Reused by document-table.tsx (`size="sm"`) so the stage-to-icon mapping isn't duplicated. */
export function DocumentStageTracker({
  uploadStatus,
  uploadedAt,
  size = 'default',
}: {
  uploadStatus: InboxDocumentView['uploadStatus']
  uploadedAt: string
  size?: 'default' | 'sm'
}) {
  const stages = stagesFor(uploadStatus)
  const iconClass = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        {stages.map((stage, i) => (
          <span key={stage.label} className="flex items-center gap-1">
            {i > 0 && <span className="text-[10px] text-muted-foreground/40">&rarr;</span>}
            <StageIcon state={stage.state} className={iconClass} />
            {size === 'default' && (
              <span
                className={`text-xs ${
                  stage.state === 'pending'
                    ? 'text-muted-foreground/60'
                    : stage.state === 'failed'
                      ? 'font-medium text-destructive'
                      : 'font-medium'
                }`}
              >
                {stage.label}
              </span>
            )}
          </span>
        ))}
      </div>
      <span className="text-[10px] text-muted-foreground">{elapsedLabelFor(uploadStatus, uploadedAt)}</span>
    </div>
  )
}

export function DocumentCard({
  document,
  canAct,
  selected,
  onToggleSelected,
  chosenEntryId,
  onChooseEntry,
  onMutated,
  adminHeadOptions,
  zoneOptions,
}: {
  document: InboxDocumentView
  canAct: boolean
  selected: boolean
  onToggleSelected: () => void
  chosenEntryId: number | null
  onChooseEntry: (entryId: number | null, display?: EntrySearchResult) => void
  onMutated: () => void
  /** Department-scoped client-side below, against the chosen entry's own department (checklist 5.11, plan §8 Z2). */
  adminHeadOptions: LookupOption[]
  zoneOptions: LookupOption[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [parkConfirming, setParkConfirming] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<EntrySearchResult[] | null>(null)
  const [searchPending, setSearchPending] = useState(false)
  const [manualSelection, setManualSelection] = useState<EntrySearchResult | null>(null)
  const [previewPending, setPreviewPending] = useState(false)
  const [extractPending, setExtractPending] = useState(false)
  // Keyed by bill (document_extraction.id) — a multi-bill document flags and
  // corrects each bill independently, so one shared flagOpen/flagNote pair
  // would mix notes across bills.
  const [flagStateByBillId, setFlagStateByBillId] = useState<
    Record<number, { open: boolean; note: string; pending: boolean }>
  >({})
  // Attach-time zone/admin-head prompt (checklist 5.11, plan §8 Z2). Draft
  // values are the Select's own NONE-sentinel strings, same convention as
  // components/entries/detail/enrichment-form.tsx, so the dropdowns can be
  // rendered exactly like that form's without a parallel number|null state.
  const [draftAdminHeadId, setDraftAdminHeadId] = useState(NONE)
  const [draftZoneId, setDraftZoneId] = useState(NONE)
  const [classificationPrefillPending, setClassificationPrefillPending] = useState(false)

  function flagStateFor(billId: number) {
    return flagStateByBillId[billId] ?? { open: false, note: '', pending: false }
  }

  function patchFlagState(billId: number, patch: Partial<{ open: boolean; note: string; pending: boolean }>) {
    setFlagStateByBillId((current) => ({
      ...current,
      [billId]: { ...(current[billId] ?? { open: false, note: '', pending: false }), ...patch },
    }))
  }

  const hasExtraction = document.extraction.length > 0
  // 'processing' is included alongside 'uploaded'/'failed' because nothing in
  // this codebase reclaims a job whose worker died mid-run (the sweeper
  // described in MASTER-PLAN §3.11 was never implemented) — without this, a
  // document that crashed mid-extraction is stuck in "Extracting" forever
  // with no way for a reviewer to retry it.
  const canExtractNow =
    document.uploadStatus === 'uploaded' ||
    document.uploadStatus === 'failed' ||
    document.uploadStatus === 'processing'

  function handleExtractNow() {
    setExtractPending(true)
    void (async () => {
      const result = await manualExtractNow(document.id)
      setExtractPending(false)
      if (!result.ok) {
        toastError(result.error, { context: 'document-card' })
        return
      }
      toast.success(`Extraction finished for "${document.originalFilename}".`)
      router.refresh()
    })()
  }

  function handleAttach() {
    if (chosenEntryId === null) {
      toast.error('Choose a candidate entry first.')
      return
    }
    const entryId = chosenEntryId
    // Captured before the attach itself, since a successful attach clears
    // the candidate/manual-search state this reads from.
    const adminHeadIdToWrite = needsClassification && draftAdminHeadId !== NONE ? Number(draftAdminHeadId) : null
    const zoneIdToWrite = needsClassification && draftZoneId !== NONE ? Number(draftZoneId) : null
    // Only fire the classification write when there's actually something to
    // set — an entry with no prior classification and nothing picked here
    // (both dropdowns still "Not set") has nothing worth a second write for
    // (checklist 5.11: "skipping is free").
    const shouldWriteClassification = adminHeadIdToWrite !== null || zoneIdToWrite !== null

    startTransition(async () => {
      const result = await attachDocumentToEntry({ documentId: document.id, entryId })
      if (!result.ok) {
        toastError(result.error, { context: 'document-card' })
        return
      }

      if (shouldWriteClassification) {
        const classificationResult = await setEntryClassification({
          entryId,
          adminHeadId: adminHeadIdToWrite,
          zoneId: zoneIdToWrite,
        })
        if (!classificationResult.success) {
          // The attach itself succeeded — this is a secondary, best-effort
          // write, so its failure is surfaced but does not undo the attach
          // or block the success toast/refresh below.
          toastError(classificationResult.error, {
            title: 'Attached, but the zone/admin head could not be saved.',
            context: 'document-card',
          })
        }
      }

      toast.success(`Attached "${document.originalFilename}".`)
      onMutated()
      router.refresh()
    })
  }

  function handleParkConfirm() {
    startTransition(async () => {
      const result = await markNoEntryExpected(document.id)
      setParkConfirming(false)
      if (!result.ok) {
        toastError(result.error, { context: 'document-card' })
        return
      }
      toast.success(`Marked "${document.originalFilename}" as no entry expected.`)
      onMutated()
      router.refresh()
    })
  }

  function handleFlagSubmit(billId: number) {
    const note = flagStateFor(billId).note.trim()
    if (!note) {
      toast.error('Describe what looks wrong before flagging.')
      return
    }
    patchFlagState(billId, { pending: true })
    void (async () => {
      const result = await flagReviewException({
        sourceDocumentId: document.id,
        documentExtractionId: billId,
        entryId: chosenEntryId,
        note,
      })
      if (!result.ok) {
        patchFlagState(billId, { pending: false })
        toastError(result.error, { context: 'document-card' })
        return
      }
      toast.success('Flagged for a closer look.')
      patchFlagState(billId, { pending: false, note: '', open: false })
    })()
  }

  function handleSearch() {
    const trimmed = searchQuery.trim()
    if (trimmed.length < 2) {
      toast.error('Type at least 2 characters to search.')
      return
    }
    setSearchPending(true)
    void (async () => {
      const result = await searchEntriesForAttach(trimmed)
      setSearchPending(false)
      if (!result.ok) {
        toastError(result.error, { context: 'document-card' })
        return
      }
      setSearchResults(result.results)
    })()
  }

  function handlePreview() {
    setPreviewPending(true)
    void (async () => {
      const result = await getDocumentPreviewUrl(document.id)
      setPreviewPending(false)
      if (!result.ok) {
        toastError(result.error, { context: 'document-card' })
        return
      }
      window.open(result.url, '_blank', 'noopener,noreferrer')
    })()
  }

  function selectCandidate(candidate: CandidateEntryView) {
    setManualSelection(null)
    onChooseEntry(candidate.entryId)
  }

  function selectSearchResult(result: EntrySearchResult) {
    setManualSelection(result)
    onChooseEntry(result.id, result)
  }

  const showingManualSelection = manualSelection !== null && manualSelection.id === chosenEntryId

  /**
   * Locates the chosen entry's own department/classification, whichever
   * path it was picked from — a ranked candidate (any bill) or the manual
   * search result. Both CandidateEntryView and EntrySearchResult carry the
   * same three fields (components/documents/types.ts, lib/actions/documents.ts)
   * for exactly this reason.
   */
  function findChosenEntryInfo(): {
    vendorRaw: string | null
    entryDepartmentId: number | null
    adminHeadId: number | null
    zoneId: number | null
  } | null {
    if (chosenEntryId === null) return null
    if (showingManualSelection && manualSelection) {
      return {
        vendorRaw: manualSelection.vendorRaw,
        entryDepartmentId: manualSelection.entryDepartmentId,
        adminHeadId: manualSelection.adminHeadId,
        zoneId: manualSelection.zoneId,
      }
    }
    for (const bill of document.extraction) {
      const found = bill.candidates.find((c) => c.entryId === chosenEntryId)
      if (found) {
        return {
          vendorRaw: found.vendorRaw,
          entryDepartmentId: found.entryDepartmentId,
          adminHeadId: found.adminHeadId,
          zoneId: found.zoneId,
        }
      }
    }
    return null
  }

  const chosenEntryInfo = findChosenEntryInfo()
  // "no zone or head set" (checklist 5.11) — neither field, not just one,
  // so an entry that already has one of the two classified doesn't get a
  // dropdown pair implying it's still fully unclassified.
  const needsClassification =
    chosenEntryInfo !== null && chosenEntryInfo.adminHeadId === null && chosenEntryInfo.zoneId === null
  const departmentScopedAdminHeadOptions = chosenEntryInfo
    ? adminHeadOptions.filter((o) => o.department_id === chosenEntryInfo.entryDepartmentId)
    : []
  const departmentScopedZoneOptions = chosenEntryInfo
    ? zoneOptions.filter((o) => o.department_id === chosenEntryInfo.entryDepartmentId)
    : []

  // Runs once per chosen-entry change (not debounced — unlike the search
  // input above, this fires on a selection change, not a keystroke).
  // Pre-fills from the most recent OTHER entry sharing vendor + department
  // (lib/actions/entry-classification-defaults.ts); a miss just leaves both
  // dropdowns on "Not set", which is the normal free-to-skip path.
  useEffect(() => {
    if (!needsClassification || !chosenEntryInfo) {
      setDraftAdminHeadId(NONE)
      setDraftZoneId(NONE)
      return
    }
    let cancelled = false
    setClassificationPrefillPending(true)
    void (async () => {
      const defaults = await getRecentClassificationDefaults(
        chosenEntryInfo.vendorRaw,
        chosenEntryInfo.entryDepartmentId
      )
      if (cancelled) return
      setClassificationPrefillPending(false)
      setDraftAdminHeadId(defaults?.adminHeadId != null ? String(defaults.adminHeadId) : NONE)
      setDraftZoneId(defaults?.zoneId != null ? String(defaults.zoneId) : NONE)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenEntryId, needsClassification])

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          {canAct && (
            <Checkbox
              checked={selected}
              onCheckedChange={onToggleSelected}
              aria-label={`Select ${document.originalFilename}`}
              className="mt-1"
            />
          )}
          <div>
            <p className="break-all text-sm font-medium">{document.originalFilename}</p>
            <p className="text-xs text-muted-foreground">
              Uploaded {formatDateTime(document.uploadedAt)}
              {document.pageCount ? ` · ${document.pageCount} page${document.pageCount === 1 ? '' : 's'}` : ''}
            </p>
          </div>
        </div>
        <div className="flex-shrink-0">
          <DocumentStageTracker uploadStatus={document.uploadStatus} uploadedAt={document.uploadedAt} />
        </div>
      </CardHeader>

      {/* Its own row, separate from the identity/status header above — retry
          and preview are actions, not status, and previously fought the
          stage tracker for the same eye-line. */}
      <div className="flex items-center gap-2 border-b border-border px-6 py-2.5">
        {canExtractNow && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleExtractNow}
            disabled={extractPending}
            title="Runs the fast Haiku extraction model again. For a second opinion from a stronger model, use the review screen's re-extract instead."
          >
            {extractPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span className="ml-1.5">Re-run extraction</span>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={handlePreview} disabled={previewPending}>
          {previewPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
          <span className="ml-1.5">View PDF</span>
        </Button>
      </div>

      <CardContent className="flex flex-col gap-4">
        {document.uploadStatus === 'failed' ? (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Extraction failed
            </div>
            {/* Plain English first. The raw failure text is a provider/model
                payload that regularly arrives as a JSON blob, so it never
                leads here — it stays one click away for whoever is actually
                debugging the pipeline. */}
            <p className="text-sm leading-relaxed text-foreground">
              {extractionFailureGuidance(document.failureReason)}
            </p>
            {document.failureReason && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  Technical detail
                </summary>
                <p className="mt-1 break-all rounded bg-background px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {document.failureReason}
                </p>
              </details>
            )}
          </div>
        ) : !hasExtraction ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            Extraction pending — vendor, invoice date, and total amount will appear here once the OCR pipeline
            finishes.
          </p>
        ) : (
          // One block per bill — document_extraction is 1:many per document
          // since 20260817000002 (a scanned PDF can contain several distinct
          // bills). Each bill gets its own fields, its own candidates (ranked
          // against that bill's OCR, not the document's), and its own
          // "Correct in Review" link, so bill 2 of 4 is never invisible.
          <div className="flex flex-col gap-4">
            {document.extraction.map((bill, index) => {
              const flagState = flagStateFor(bill.id)
              return (
                <div
                  key={bill.id}
                  className={
                    document.extraction.length > 1
                      ? 'flex flex-col gap-3 rounded-md border border-border p-3'
                      : 'flex flex-col gap-3'
                  }
                >
                  {document.extraction.length > 1 && (
                    <p className="text-xs font-semibold text-foreground">
                      Bill {index + 1} of {document.extraction.length}
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <Field label="Vendor" value={bill.vendorNameOcr ?? '—'} />
                    <Field label="Invoice date" value={formatDate(bill.invoiceDateOcr)} />
                    <Field label="Invoice #" value={bill.invoiceNumberOcr ?? '—'} />
                    <Field label="Total" value={formatMoney(bill.totalAmountOcr)} />
                  </div>

                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Suggested matches
                    </p>
                    {bill.candidates.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No close matches found — this may genuinely have no entry. Search manually or park it below.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {bill.candidates.map((candidate) => (
                          <CandidateRow
                            key={candidate.entryId}
                            candidate={candidate}
                            selected={chosenEntryId === candidate.entryId && !showingManualSelection}
                            onSelect={() => selectCandidate(candidate)}
                            disabled={!canAct}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => patchFlagState(bill.id, { open: !flagState.open })}
                      className="flex items-center gap-1.5 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      <Flag className="h-3.5 w-3.5" aria-hidden="true" />
                      {flagState.open ? 'Hide' : 'A field looks wrong?'}
                    </button>
                    {flagState.open && (
                      <div className="flex flex-col gap-2.5 rounded-md border border-border p-3">
                        <a
                          href={`/review?id=${bill.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-primary hover:underline"
                        >
                          <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
                          Correct the extracted fields in Review
                        </a>
                        <p className="text-[11px] text-muted-foreground">
                          Opens the field-by-field review screen in a new tab, where the corrected value is saved as
                          the record of truth (your place here in the inbox is kept).
                        </p>
                        <div className="h-px bg-border" />
                        <p className="text-[11px] text-muted-foreground">
                          Not sure of the right value, or want someone else to check first? Leave a note instead:
                        </p>
                        <Textarea
                          value={flagState.note}
                          onChange={(e) => patchFlagState(bill.id, { note: e.target.value })}
                          placeholder="e.g. Total doesn't match the PDF — looks like tax was double-counted."
                          className="min-h-16 text-sm"
                        />
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleFlagSubmit(bill.id)}
                          disabled={flagState.pending}
                          className="self-start"
                        >
                          {flagState.pending ? 'Flagging…' : 'Flag for a closer look'}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className="flex items-center gap-1.5 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            {searchOpen ? 'Hide manual search' : 'Search for an entry manually'}
          </button>
          {searchOpen && (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex gap-2">
                <Input
                  placeholder="UBBL number, Main number, vendor, or invoice number…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearch()
                  }}
                  className="h-8 text-sm"
                />
                <Button type="button" size="sm" onClick={handleSearch} disabled={searchPending}>
                  {searchPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Search'}
                </Button>
              </div>
              {searchResults !== null && (
                <div className="flex flex-col gap-1">
                  {searchResults.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No entries match that search.</p>
                  ) : (
                    searchResults.map((result) => (
                      <SearchResultRow
                        key={result.id}
                        result={result}
                        selected={chosenEntryId === result.id && showingManualSelection}
                        onSelect={() => selectSearchResult(result)}
                        disabled={!canAct}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {canAct && chosenEntryId !== null && (
          <div className="flex flex-col gap-2 rounded bg-muted/50 px-2.5 py-1.5">
            <p className="text-xs text-muted-foreground">
              Attach will use <span className="font-medium text-foreground">entry #{chosenEntryId}</span>
              {showingManualSelection ? ' (your manual selection)' : ''}.
            </p>

            {needsClassification && (
              <div className="flex flex-col gap-2 border-t border-border pt-2">
                <p className="text-[11px] text-muted-foreground">
                  This entry has no zone or admin head set yet. Set them now, or leave on &quot;Not set&quot; and
                  skip — attaching never requires it.
                  {classificationPrefillPending && ' Checking for a recent match…'}
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`inline-admin-head-${document.id}`} className="text-[11px]">
                      Admin head
                    </Label>
                    <Select value={draftAdminHeadId} onValueChange={setDraftAdminHeadId}>
                      <SelectTrigger id={`inline-admin-head-${document.id}`} className="h-8 text-xs">
                        <SelectValue placeholder="Not set" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not set</SelectItem>
                        {departmentScopedAdminHeadOptions.map((o) => (
                          <SelectItem key={o.id} value={String(o.id)}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`inline-zone-${document.id}`} className="text-[11px]">
                      Zone
                    </Label>
                    <Select value={draftZoneId} onValueChange={setDraftZoneId}>
                      <SelectTrigger id={`inline-zone-${document.id}`} className="h-8 text-xs">
                        <SelectValue placeholder="Not set" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not set</SelectItem>
                        {departmentScopedZoneOptions.map((o) => (
                          <SelectItem key={o.id} value={String(o.id)}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {canAct && parkConfirming ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground">
              Move &ldquo;{document.originalFilename}&rdquo; out of the inbox with no entry attached? You can
              re-attach it later if one turns up.
            </p>
            <div className="flex flex-shrink-0 gap-2">
              <Button size="sm" variant="outline" onClick={() => setParkConfirming(false)} disabled={isPending}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleParkConfirm} disabled={isPending}>
                {isPending ? 'Marking…' : 'Confirm — no entry'}
              </Button>
            </div>
          </div>
        ) : (
          canAct && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <Button size="sm" onClick={handleAttach} disabled={isPending || chosenEntryId === null}>
                {isPending ? 'Attaching…' : 'Attach to selected entry'}
              </Button>
              <button
                type="button"
                onClick={() => setParkConfirming(true)}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-60"
              >
                <FileX2 className="h-3.5 w-3.5" aria-hidden="true" />
                No matching entry
              </button>
            </div>
          )
        )}
      </CardContent>
    </Card>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="truncate font-medium" title={value}>
        {value}
      </span>
    </div>
  )
}

function CandidateRow({
  candidate,
  selected,
  onSelect,
  disabled,
}: {
  candidate: CandidateEntryView
  selected: boolean
  onSelect: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
      }`}
    >
      <RadioDot selected={selected} />
      <Badge variant={selected ? 'default' : 'secondary'} className="text-[10px]">
        {formatScore(candidate.score)} match
      </Badge>
      <span className="font-medium">{candidate.vendorRaw ?? '(no vendor on entry)'}</span>
      <span className="text-muted-foreground">{formatMoney(candidate.amount)}</span>
      <span className="text-muted-foreground">{formatDate(candidate.date)}</span>
      <span className="text-muted-foreground">UBBL {candidate.ubblNumber}</span>
      {candidate.departmentName && <span className="text-muted-foreground">{candidate.departmentName}</span>}
    </button>
  )
}

function SearchResultRow({
  result,
  selected,
  onSelect,
  disabled,
}: {
  result: EntrySearchResult
  selected: boolean
  onSelect: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
      }`}
    >
      <RadioDot selected={selected} />
      <span className="font-medium">{result.vendorRaw ?? '(no vendor on entry)'}</span>
      <span className="text-muted-foreground">{formatMoney(result.amount)}</span>
      <span className="text-muted-foreground">{formatDate(result.date)}</span>
      <span className="text-muted-foreground">UBBL {result.ubblNumber}</span>
      {result.mainNumber && <span className="text-muted-foreground">Main {result.mainNumber}</span>}
    </button>
  )
}

/** Single-select affordance for candidate/search rows — states in the UI, not just a color tint, which entry "Attach" will use. */
function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border-2 ${
        selected ? 'border-primary bg-primary' : 'border-muted-foreground/40'
      }`}
    >
      {selected && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
    </span>
  )
}
