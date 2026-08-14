'use client'

import { useState } from 'react'
import { ChevronLeft, ChevronRight, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DocumentCard, DocumentStageTracker } from './document-card'
import { formatDate, formatMoney } from './format'
import type { InboxDocumentView } from './types'

const PAGE_SIZE = 20

/**
 * Table view of the /documents inbox (MASTER-PLAN §11.2 Day 3 item 5): a
 * growing stack of full DocumentCards doesn't scale past a handful of
 * documents, so this renders one row per document with the same per-row
 * state (selection, chosen candidate entry, mutation callback) the card
 * list used — document-inbox.tsx's toggleSelected/chooseEntry/
 * removeDocumentLocally already take a documentId as their first argument,
 * so they're passed straight through here without needing per-row closures
 * built at the call site.
 *
 * The rich per-document detail (candidates, manual search, attach/park
 * actions) stays exactly what DocumentCard already renders — reused
 * unmodified inside a Dialog opened by the row's "Review" button, so only
 * one row's worth of that detail is ever mounted at a time instead of every
 * row rendering all of it up front.
 *
 * Pagination is plain client-side useState — no @tanstack/react-table; a
 * single 20-per-page table doesn't need that API surface, and the
 * dependency sits unused everywhere else in the repo.
 */
export function DocumentTable({
  documents,
  canAct,
  selected,
  onToggleSelected,
  chosenByDocument,
  onChooseEntry,
  onMutated,
}: {
  documents: InboxDocumentView[]
  canAct: boolean
  selected: Set<number>
  onToggleSelected: (documentId: number) => void
  chosenByDocument: Map<number, number | null>
  onChooseEntry: (documentId: number, entryId: number | null) => void
  onMutated: (documentId: number) => void
}) {
  const [pageIndex, setPageIndex] = useState(0)
  const [openDocumentId, setOpenDocumentId] = useState<number | null>(null)

  const pageCount = Math.max(1, Math.ceil(documents.length / PAGE_SIZE))
  const clampedPageIndex = Math.min(pageIndex, pageCount - 1)
  const start = clampedPageIndex * PAGE_SIZE
  const pageDocuments = documents.slice(start, start + PAGE_SIZE)
  const openDocument = documents.find((d) => d.id === openDocumentId) ?? null

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {canAct && <TableHead className="w-10" />}
              <TableHead>Filename</TableHead>
              <TableHead>Vendor / Invoice # / Total</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageDocuments.map((doc) => {
              const chosenEntryId = chosenByDocument.get(doc.id) ?? null
              return (
                <TableRow key={doc.id}>
                  {canAct && (
                    <TableCell>
                      <Checkbox
                        checked={selected.has(doc.id)}
                        onCheckedChange={() => onToggleSelected(doc.id)}
                        disabled={chosenEntryId === null}
                        aria-label={`Select ${doc.originalFilename} for bulk attach`}
                      />
                    </TableCell>
                  )}
                  <TableCell className="max-w-[220px]">
                    <p className="truncate text-sm font-medium" title={doc.originalFilename}>
                      {doc.originalFilename}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {doc.pageCount ? `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}` : '—'}
                    </p>
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    {doc.extraction === null ? (
                      <span className="text-xs text-muted-foreground">Pending extraction</span>
                    ) : (
                      <div className="flex flex-col text-xs">
                        <span className="truncate font-medium" title={doc.extraction.vendorNameOcr ?? '—'}>
                          {doc.extraction.vendorNameOcr ?? '—'}
                        </span>
                        <span className="text-muted-foreground">
                          {doc.extraction.invoiceNumberOcr ?? '—'} &middot; {formatMoney(doc.extraction.totalAmountOcr)}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <DocumentStageTracker uploadStatus={doc.uploadStatus} uploadedAt={doc.uploadedAt} size="sm" />
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">{formatDate(doc.uploadedAt)}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setOpenDocumentId(doc.id)}>
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="ml-1.5">Review</span>
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Page {clampedPageIndex + 1} of {pageCount} &middot; {documents.length} document
          {documents.length === 1 ? '' : 's'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
            disabled={clampedPageIndex === 0}
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
            disabled={clampedPageIndex >= pageCount - 1}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <Dialog open={openDocumentId !== null} onOpenChange={(open) => !open && setOpenDocumentId(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {openDocument && (
            <>
              <DialogHeader>
                <DialogTitle className="break-all">{openDocument.originalFilename}</DialogTitle>
              </DialogHeader>
              <DocumentCard
                document={openDocument}
                canAct={canAct}
                selected={selected.has(openDocument.id)}
                onToggleSelected={() => onToggleSelected(openDocument.id)}
                chosenEntryId={chosenByDocument.get(openDocument.id) ?? null}
                onChooseEntry={(entryId) => onChooseEntry(openDocument.id, entryId)}
                onMutated={() => {
                  onMutated(openDocument.id)
                  setOpenDocumentId(null)
                }}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
