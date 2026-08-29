/**
 * Client-side comparator for the /documents inbox table
 * (docs/hub-screen-certification.md §3.2). The table sorts the already-
 * filtered in-memory array with this before slicing a page — there is no
 * server round trip for sort on this screen (see document-table.tsx's
 * docstring on why client-side is correct here).
 *
 * Extracted as a pure module so it can be unit-tested without mounting the
 * table (test/unit/document-sort.test.ts).
 */
import type { InboxDocumentView } from './types'

export type DocumentSortColumn = 'filename' | 'total' | 'status' | 'uploaded'
export type SortDirection = 'asc' | 'desc'

export interface DocumentSort {
  column: DocumentSortColumn
  direction: SortDirection
}

/** Columns whose first click should open descending (newest / biggest first). */
export const DOCUMENT_DESCENDING_FIRST: ReadonlySet<DocumentSortColumn> = new Set<DocumentSortColumn>([
  'uploaded',
  'total',
])

/** Newest-first by upload time — matches the order the RSC query already returns. */
export const DEFAULT_DOCUMENT_SORT: DocumentSort = { column: 'uploaded', direction: 'desc' }

/** Pipeline progression, used as the sort rank for the Status column. */
const STATUS_RANK: Record<InboxDocumentView['uploadStatus'], number> = {
  uploaded: 0,
  processing: 1,
  processed: 2,
  failed: 3,
}

/**
 * Total OCR'd value of a document: the sum of the readable bill totals, or
 * null when no bill has a readable total. Mirrors document-table.tsx's
 * "exclude, don't zero-fill a missing read" convention so the sort key and
 * the displayed total agree.
 */
export function documentTotal(doc: InboxDocumentView): number | null {
  const withTotal = doc.extraction.filter((b) => b.totalAmountOcr !== null)
  if (withTotal.length === 0) return null
  return withTotal.reduce((sum, b) => sum + (b.totalAmountOcr ?? 0), 0)
}

function toTime(value: string): number {
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

function rawCompare(a: InboxDocumentView, b: InboxDocumentView, column: DocumentSortColumn, direction: SortDirection): number {
  const dir = direction === 'asc' ? 1 : -1

  switch (column) {
    case 'filename':
      return (
        a.originalFilename.localeCompare(b.originalFilename, undefined, { numeric: true, sensitivity: 'base' }) * dir
      )
    case 'status':
      return (STATUS_RANK[a.uploadStatus] - STATUS_RANK[b.uploadStatus]) * dir
    case 'uploaded':
      return (toTime(a.uploadedAt) - toTime(b.uploadedAt)) * dir
    case 'total': {
      const va = documentTotal(a)
      const vb = documentTotal(b)
      // A document with no readable total always sorts last, regardless of
      // direction — it carries no information to rank on.
      if (va === null && vb === null) return 0
      if (va === null) return 1
      if (vb === null) return -1
      return (va - vb) * dir
    }
  }
}

/**
 * Full comparator with a stable tiebreaker on document id (always ascending,
 * so the order is deterministic across renders even when the primary key
 * ties — e.g. two documents uploaded in the same second).
 */
export function compareDocuments(a: InboxDocumentView, b: InboxDocumentView, sort: DocumentSort): number {
  const primary = rawCompare(a, b, sort.column, sort.direction)
  if (primary !== 0) return primary
  return a.id - b.id
}

/** Returns a new sorted array; does not mutate the input. */
export function sortDocuments(documents: InboxDocumentView[], sort: DocumentSort): InboxDocumentView[] {
  return [...documents].sort((a, b) => compareDocuments(a, b, sort))
}
