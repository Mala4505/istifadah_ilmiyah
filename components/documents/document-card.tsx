'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Search, ExternalLink, FileX2 } from 'lucide-react'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  attachDocumentToEntry,
  getDocumentPreviewUrl,
  markNoEntryExpected,
  searchEntriesForAttach,
  type EntrySearchResult,
} from '@/lib/actions/documents'
import { formatDate, formatDateTime, formatMoney, formatScore } from './format'
import type { CandidateEntryView, InboxDocumentView } from './types'

const UPLOAD_STATUS_LABEL: Record<InboxDocumentView['uploadStatus'], string> = {
  uploaded: 'Uploaded',
  processing: 'Extracting…',
  processed: 'Extracted',
  failed: 'Extraction failed',
}

const UPLOAD_STATUS_VARIANT: Record<InboxDocumentView['uploadStatus'], BadgeProps['variant']> = {
  uploaded: 'outline',
  processing: 'warning',
  processed: 'success',
  failed: 'destructive',
}

export function DocumentCard({
  document,
  canAct,
  selected,
  onToggleSelected,
  chosenEntryId,
  onChooseEntry,
  onMutated,
}: {
  document: InboxDocumentView
  canAct: boolean
  selected: boolean
  onToggleSelected: () => void
  chosenEntryId: number | null
  onChooseEntry: (entryId: number | null, display?: EntrySearchResult) => void
  onMutated: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [confirmParkOpen, setConfirmParkOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<EntrySearchResult[] | null>(null)
  const [searchPending, setSearchPending] = useState(false)
  const [manualSelection, setManualSelection] = useState<EntrySearchResult | null>(null)
  const [previewPending, setPreviewPending] = useState(false)

  const hasExtraction = document.extraction !== null

  function handleAttach() {
    if (chosenEntryId === null) {
      toast.error('Choose a candidate entry first.')
      return
    }
    startTransition(async () => {
      const result = await attachDocumentToEntry({ documentId: document.id, entryId: chosenEntryId })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`Attached "${document.originalFilename}".`)
      onMutated()
      router.refresh()
    })
  }

  function handleParkConfirm() {
    startTransition(async () => {
      const result = await markNoEntryExpected(document.id)
      setConfirmParkOpen(false)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`Marked "${document.originalFilename}" as no entry expected.`)
      onMutated()
      router.refresh()
    })
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
        toast.error(result.error)
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
        toast.error(result.error)
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

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          {canAct && (
            <Checkbox
              checked={selected}
              onCheckedChange={onToggleSelected}
              disabled={chosenEntryId === null}
              aria-label={`Select ${document.originalFilename} for bulk attach`}
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
        <div className="flex flex-shrink-0 items-center gap-2">
          <Badge variant={UPLOAD_STATUS_VARIANT[document.uploadStatus]}>
            {UPLOAD_STATUS_LABEL[document.uploadStatus]}
          </Badge>
          <Button variant="ghost" size="sm" onClick={handlePreview} disabled={previewPending}>
            {previewPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
            <span className="ml-1.5 hidden sm:inline">View PDF</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {!hasExtraction ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            {document.uploadStatus === 'failed'
              ? 'Extraction failed — no vendor, amount, or date to match on yet. This document can still be parked, or attached once a manual look confirms which entry it belongs to.'
              : 'Extraction pending — vendor, invoice date, and total amount will appear here once the OCR pipeline finishes.'}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Field label="Vendor" value={document.extraction!.vendorNameOcr ?? '—'} />
            <Field label="Invoice date" value={formatDate(document.extraction!.invoiceDateOcr)} />
            <Field label="Invoice #" value={document.extraction!.invoiceNumberOcr ?? '—'} />
            <Field label="Total" value={formatMoney(document.extraction!.totalAmountOcr)} />
          </div>
        )}

        {hasExtraction && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested matches</p>
            {document.candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No close matches found — this may genuinely have no entry. Search manually or park it below.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {document.candidates.map((candidate) => (
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

        {canAct && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" onClick={handleAttach} disabled={isPending || chosenEntryId === null}>
              {isPending ? 'Attaching…' : 'Attach to selected entry'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmParkOpen(true)}
              disabled={isPending}
            >
              <FileX2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              No entry expected
            </Button>
            {chosenEntryId !== null && (
              <span className="text-xs text-muted-foreground">
                Will attach to entry #{chosenEntryId}
                {showingManualSelection ? ' (manual selection)' : ''}
              </span>
            )}
          </div>
        )}
      </CardContent>

      <Dialog open={confirmParkOpen} onOpenChange={setConfirmParkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as &ldquo;no entry expected&rdquo;?</DialogTitle>
            <DialogDescription>
              &ldquo;{document.originalFilename}&rdquo; will move out of the unmatched inbox as a document with
              genuinely no matching entry. You can still find it later and re-attach it if one turns up.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmParkOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleParkConfirm} disabled={isPending}>
              {isPending ? 'Parking…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
      onClick={onSelect}
      disabled={disabled}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
      }`}
    >
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
      onClick={onSelect}
      disabled={disabled}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
      }`}
    >
      <span className="font-medium">{result.vendorRaw ?? '(no vendor on entry)'}</span>
      <span className="text-muted-foreground">{formatMoney(result.amount)}</span>
      <span className="text-muted-foreground">{formatDate(result.date)}</span>
      <span className="text-muted-foreground">UBBL {result.ubblNumber}</span>
      {result.mainNumber && <span className="text-muted-foreground">Main {result.mainNumber}</span>}
    </button>
  )
}
