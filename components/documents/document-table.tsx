'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, Eye, PenLine, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectNative } from '@/components/ui/select-native'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PaginationBar, PAGE_SIZE_OPTIONS } from '@/components/ui/pagination-bar'
import { SortableTableHead, nextSort } from '@/components/ui/sortable-table-head'
import { DocumentCard, DocumentStageTracker, ReviewProgressBadge } from './document-card'
import {
  sortDocuments,
  DEFAULT_DOCUMENT_SORT,
  DOCUMENT_DESCENDING_FIRST,
  type DocumentSort,
  type DocumentSortColumn,
} from './document-sort'
import { formatDateTime, formatMoney } from './format'
import type { InboxDocumentView } from './types'
import type { LookupOption } from '@/components/entries/types'

const DEFAULT_PAGE_SIZE = 25

type StatusFilter = '' | InboxDocumentView['uploadStatus']
type ReviewFilter = '' | 'reviewed' | 'unreviewed'

interface DocumentFilters {
  search: string
  status: StatusFilter
  review: ReviewFilter
  dateFrom: string
  dateTo: string
}

const DEFAULT_FILTERS: DocumentFilters = { search: '', status: '', review: '', dateFrom: '', dateTo: '' }

/** Matches elapsedLabelFor's wording in document-card.tsx, capitalized for a dropdown label. */
const STATUS_OPTIONS: Array<{ value: InboxDocumentView['uploadStatus']; label: string }> = [
  { value: 'uploaded', label: 'Queued' },
  { value: 'processing', label: 'Extracting' },
  { value: 'processed', label: 'Extracted' },
  { value: 'failed', label: 'Failed' },
]

function matchesFilters(doc: InboxDocumentView, filters: DocumentFilters): boolean {
  if (filters.search.trim() && !doc.originalFilename.toLowerCase().includes(filters.search.trim().toLowerCase())) {
    return false
  }
  if (filters.status && doc.uploadStatus !== filters.status) return false
  if (filters.review) {
    if (doc.extraction.length === 0) return false
    const allReviewed = doc.extraction.every((b) => b.verifiedAt !== null)
    if (filters.review === 'reviewed' && !allReviewed) return false
    if (filters.review === 'unreviewed' && allReviewed) return false
  }
  const uploadedAt = new Date(doc.uploadedAt)
  if (filters.dateFrom && uploadedAt < new Date(filters.dateFrom)) return false
  if (filters.dateTo) {
    const end = new Date(filters.dateTo)
    end.setHours(23, 59, 59, 999)
    if (uploadedAt > end) return false
  }
  return true
}

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
  onTogglePage,
  chosenByDocument,
  onChooseEntry,
  onMutated,
  adminHeadOptions,
  zoneOptions,
}: {
  documents: InboxDocumentView[]
  canAct: boolean
  selected: Set<number>
  onToggleSelected: (documentId: number) => void
  /** Tri-state select-all for the current page (hub certification §3.5): the
   *  table passes the ids currently on screen; document-inbox.tsx decides
   *  whether that's an add-all or a remove-all. */
  onTogglePage: (documentIds: number[]) => void
  chosenByDocument: Map<number, number | null>
  onChooseEntry: (documentId: number, entryId: number | null) => void
  onMutated: (documentId: number) => void
  /** Threaded through to DocumentCard for the attach-time zone/admin-head prompt (checklist 5.11). */
  adminHeadOptions: LookupOption[]
  zoneOptions: LookupOption[]
}) {
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [sort, setSort] = useState<DocumentSort>(DEFAULT_DOCUMENT_SORT)
  const [openDocumentId, setOpenDocumentId] = useState<number | null>(null)
  // Multi-bill documents (document_extraction is 1:many per source_document
  // since 20260817000002) expand in place to a per-bill list rather than
  // collapsing to whichever bill happened to sort last.
  const [expandedDocumentIds, setExpandedDocumentIds] = useState<Set<number>>(new Set())
  // Filter/search (pre-deploy-findings-and-plan.md §7.6: "fine at 2
  // documents; a problem at 200"). Purely client-side over the already-
  // fetched `documents` prop — no server round trip, matching this screen's
  // small-list scale rather than entries-explorer.tsx's URL-synced approach.
  const [filters, setFilters] = useState<DocumentFilters>(DEFAULT_FILTERS)

  function patchFilters(patch: Partial<DocumentFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
  }

  const filteredDocuments = useMemo(
    () => documents.filter((doc) => matchesFilters(doc, filters)),
    [documents, filters]
  )

  // Sort the whole filtered set before slicing a page (hub certification
  // §3.2) — client-side, like the filter above, since the full list is
  // already in memory.
  const sortedDocuments = useMemo(() => sortDocuments(filteredDocuments, sort), [filteredDocuments, sort])

  // A filter or page-size change can strand pageIndex past the new (smaller)
  // page count — jump back to page 1 rather than showing an empty page.
  useEffect(() => {
    setPageIndex(0)
  }, [filters, pageSize])

  function handleSort(column: DocumentSortColumn) {
    setSort((current) => nextSort(current, column, DOCUMENT_DESCENDING_FIRST))
  }

  function toggleExpanded(documentId: number) {
    setExpandedDocumentIds((current) => {
      const next = new Set(current)
      if (next.has(documentId)) next.delete(documentId)
      else next.add(documentId)
      return next
    })
  }

  const activeFilterCount = Object.entries(filters).filter(
    ([key, value]) => value !== DEFAULT_FILTERS[key as keyof DocumentFilters]
  ).length

  const total = filteredDocuments.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const clampedPageIndex = Math.min(pageIndex, pageCount - 1)
  const start = clampedPageIndex * pageSize
  const pageDocuments = sortedDocuments.slice(start, start + pageSize)
  const openDocument = documents.find((d) => d.id === openDocumentId) ?? null

  const pageDocumentIds = pageDocuments.map((d) => d.id)
  const allOnPageSelected = pageDocumentIds.length > 0 && pageDocumentIds.every((id) => selected.has(id))
  const someOnPageSelected = pageDocumentIds.some((id) => selected.has(id))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Filename
            </Label>
            <Input
              placeholder="Search filename…"
              value={filters.search}
              onChange={(e) => patchFilters({ search: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Status</Label>
            <SelectNative
              value={filters.status}
              onChange={(e) => patchFilters({ status: e.target.value as StatusFilter })}
            >
              <option value="">Any status</option>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Review</Label>
            <SelectNative
              value={filters.review}
              onChange={(e) => patchFilters({ review: e.target.value as ReviewFilter })}
            >
              <option value="">Any review state</option>
              <option value="unreviewed">Not fully reviewed</option>
              <option value="reviewed">Fully reviewed</option>
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Uploaded from
            </Label>
            <Input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => patchFilters({ dateFrom: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Uploaded to
            </Label>
            <Input
              type="date"
              value={filters.dateTo}
              onChange={(e) => patchFilters({ dateTo: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
        {activeFilterCount > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
            <span className="text-xs text-muted-foreground">
              {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active
            </span>
            <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setFilters(DEFAULT_FILTERS)}>
              <X className="h-3.5 w-3.5" />
              Clear filters
            </Button>
          </div>
        )}
      </div>

      {/* §7.7: the table's six nowrap columns are wider than a phone
          viewport (430px) — without this, the whole page body was forced
          wider than the viewport instead of scrolling just the table.
          Matches components/reports/data-table.tsx's existing convention. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {canAct && (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select all documents on this page"
                    checked={allOnPageSelected ? true : someOnPageSelected ? 'indeterminate' : false}
                    onCheckedChange={() => onTogglePage(pageDocumentIds)}
                  />
                </TableHead>
              )}
              <SortableTableHead
                columnKey="filename"
                label="Filename"
                activeColumn={sort.column}
                direction={sort.direction}
                onSort={handleSort}
              />
              <SortableTableHead
                columnKey="total"
                label="Vendor / Invoice # / Total"
                activeColumn={sort.column}
                direction={sort.direction}
                onSort={handleSort}
              />
              <SortableTableHead
                columnKey="status"
                label="Status"
                activeColumn={sort.column}
                direction={sort.direction}
                onSort={handleSort}
              />
              <SortableTableHead
                columnKey="uploaded"
                label="Uploaded"
                activeColumn={sort.column}
                direction={sort.direction}
                onSort={handleSort}
              />
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageDocuments.length === 0 && (
              <TableRow>
                <TableCell colSpan={5 + (canAct ? 1 : 0)} className="py-8 text-center text-sm text-muted-foreground">
                  No documents match these filters.
                </TableCell>
              </TableRow>
            )}
            {pageDocuments.map((doc) => {
              const bills = doc.extraction
              const isMultiBill = bills.length > 1
              const isExpanded = expandedDocumentIds.has(doc.id)
              const colSpan = 5 + (canAct ? 1 : 0)

              return (
                <Fragment key={doc.id}>
                  <TableRow>
                    {canAct && (
                      <TableCell>
                        <Checkbox
                          checked={selected.has(doc.id)}
                          onCheckedChange={() => onToggleSelected(doc.id)}
                          aria-label={`Select ${doc.originalFilename}`}
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
                      {bills.length === 0 ? (
                        <span className="text-xs text-muted-foreground">Pending extraction</span>
                      ) : isMultiBill ? (
                        (() => {
                          // §7.6: a collapsed "4 bills" expander had no total
                          // for the PDF — you couldn't see what the document
                          // was worth without expanding. Sums whichever bills
                          // have an OCR'd total (same "exclude, don't zero-
                          // fill, a missing read" convention as
                          // components/entries/detail/linked-documents.tsx's
                          // sumOfTotals), and says so when the sum is partial.
                          const billsWithTotal = bills.filter((b) => b.totalAmountOcr !== null)
                          const billsTotal = billsWithTotal.reduce((sum, b) => sum + (b.totalAmountOcr ?? 0), 0)
                          return (
                            <div className="flex flex-col gap-0.5">
                              <button
                                type="button"
                                onClick={() => toggleExpanded(doc.id)}
                                className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                              >
                                {isExpanded ? (
                                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                                )}
                                {bills.length} bills
                              </button>
                              <span className="text-xs text-muted-foreground">
                                Total {formatMoney(billsTotal)}
                                {billsWithTotal.length !== bills.length &&
                                  ` (${billsWithTotal.length} of ${bills.length} read)`}
                              </span>
                            </div>
                          )
                        })()
                      ) : (
                        (() => {
                          const bill = bills[0]!
                          return (
                            <div className="flex flex-col text-xs">
                              <span className="truncate font-medium" title={bill.vendorNameOcr ?? '—'}>
                                {bill.vendorNameOcr ?? '—'}
                              </span>
                              <span className="text-muted-foreground">
                                {bill.invoiceNumberOcr ?? '—'} &middot; {formatMoney(bill.totalAmountOcr)}
                              </span>
                            </div>
                          )
                        })()
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <DocumentStageTracker uploadStatus={doc.uploadStatus} uploadedAt={doc.uploadedAt} size="sm" />
                        <ReviewProgressBadge bills={bills} size="sm" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">{formatDateTime(doc.uploadedAt)}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => setOpenDocumentId(doc.id)}>
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="ml-1.5">Review</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                  {isMultiBill && isExpanded && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={colSpan} className="py-2">
                        <div className="flex flex-col gap-1.5 pl-1">
                          {bills.map((bill, index) => (
                            <div
                              key={bill.id}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs"
                            >
                              <span className="font-semibold text-muted-foreground">Bill {index + 1}</span>
                              <span className="font-medium">{bill.vendorNameOcr ?? '(no vendor)'}</span>
                              <span className="text-muted-foreground">{bill.invoiceNumberOcr ?? '—'}</span>
                              <span className="text-muted-foreground">{formatMoney(bill.totalAmountOcr)}</span>
                              {bill.verifiedAt !== null && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700">
                                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                  Reviewed
                                </span>
                              )}
                              <a
                                href={`/review?id=${bill.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-auto inline-flex items-center gap-1 font-medium text-primary hover:underline"
                              >
                                <PenLine className="h-3 w-3" aria-hidden="true" />
                                Correct in Review
                              </a>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <PaginationBar
        noun="document"
        rangeStart={start + 1}
        rangeEnd={Math.min(start + pageSize, total)}
        total={total}
        pageSize={pageSize}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPageIndex(0)
        }}
        pageSizeOptions={PAGE_SIZE_OPTIONS as unknown as number[]}
        canPrev={clampedPageIndex > 0}
        canNext={clampedPageIndex < pageCount - 1}
        onPrev={() => setPageIndex((p) => Math.max(0, p - 1))}
        onNext={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
      />

      <Dialog open={openDocumentId !== null} onOpenChange={(open) => !open && setOpenDocumentId(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {openDocument && (
            <>
              {/* Visually hidden: Radix requires a DialogTitle for a11y, but
                  DocumentCard's own header already shows the filename as the
                  one visible title — showing it here too just repeats it. */}
              <DialogTitle className="sr-only">{openDocument.originalFilename}</DialogTitle>
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
                adminHeadOptions={adminHeadOptions}
                zoneOptions={zoneOptions}
              />
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setOpenDocumentId(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
