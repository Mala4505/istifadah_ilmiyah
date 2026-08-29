/**
 * Unit tests for components/documents/document-sort.ts
 * (docs/hub-screen-certification.md §3.2). Covers each sort column in both
 * directions, the "no readable total sorts last" rule, and the stable
 * id tiebreaker.
 */
import { describe, it, expect } from 'vitest'
import {
  compareDocuments,
  documentTotal,
  sortDocuments,
  DEFAULT_DOCUMENT_SORT,
  DOCUMENT_DESCENDING_FIRST,
  type DocumentSort,
} from '@/components/documents/document-sort'
import type { InboxDocumentView, DocumentExtractionSummary } from '@/components/documents/types'

function bill(overrides: Partial<DocumentExtractionSummary> = {}): DocumentExtractionSummary {
  return {
    id: 1,
    billIndex: 0,
    vendorNameOcr: null,
    invoiceDateOcr: null,
    invoiceNumberOcr: null,
    totalAmountOcr: null,
    verifiedAt: null,
    candidates: [],
    ...overrides,
  }
}

function doc(overrides: Partial<InboxDocumentView> = {}): InboxDocumentView {
  return {
    id: 1,
    originalFilename: 'a.pdf',
    uploadStatus: 'processed',
    matchStatus: 'unmatched',
    uploadedAt: '2026-08-01T00:00:00Z',
    pageCount: 1,
    extraction: [],
    failureReason: null,
    ...overrides,
  }
}

const ids = (docs: InboxDocumentView[]) => docs.map((d) => d.id)

describe('documentTotal', () => {
  it('sums only the bills with a readable OCR total', () => {
    expect(documentTotal(doc({ extraction: [bill({ totalAmountOcr: 100 }), bill({ totalAmountOcr: 250 })] }))).toBe(350)
    expect(documentTotal(doc({ extraction: [bill({ totalAmountOcr: 100 }), bill({ totalAmountOcr: null })] }))).toBe(100)
  })

  it('is null when no bill has a readable total', () => {
    expect(documentTotal(doc({ extraction: [] }))).toBeNull()
    expect(documentTotal(doc({ extraction: [bill({ totalAmountOcr: null })] }))).toBeNull()
  })
})

describe('sortDocuments — filename', () => {
  const a = doc({ id: 1, originalFilename: 'apple.pdf' })
  const b = doc({ id: 2, originalFilename: 'banana.pdf' })
  const c = doc({ id: 3, originalFilename: 'Cherry.pdf' })

  it('ascending is case-insensitive alphabetical', () => {
    expect(ids(sortDocuments([c, a, b], { column: 'filename', direction: 'asc' }))).toEqual([1, 2, 3])
  })

  it('descending reverses', () => {
    expect(ids(sortDocuments([a, c, b], { column: 'filename', direction: 'desc' }))).toEqual([3, 2, 1])
  })

  it('uses numeric collation (file2 before file10)', () => {
    const f2 = doc({ id: 1, originalFilename: 'file2.pdf' })
    const f10 = doc({ id: 2, originalFilename: 'file10.pdf' })
    expect(ids(sortDocuments([f10, f2], { column: 'filename', direction: 'asc' }))).toEqual([1, 2])
  })
})

describe('sortDocuments — uploaded', () => {
  const older = doc({ id: 1, uploadedAt: '2026-08-01T00:00:00Z' })
  const newer = doc({ id: 2, uploadedAt: '2026-08-10T00:00:00Z' })

  it('descending is newest first', () => {
    expect(ids(sortDocuments([older, newer], { column: 'uploaded', direction: 'desc' }))).toEqual([2, 1])
  })

  it('ascending is oldest first', () => {
    expect(ids(sortDocuments([newer, older], { column: 'uploaded', direction: 'asc' }))).toEqual([1, 2])
  })

  it('default sort is uploaded desc', () => {
    expect(DEFAULT_DOCUMENT_SORT).toEqual({ column: 'uploaded', direction: 'desc' })
    expect(ids(sortDocuments([older, newer], DEFAULT_DOCUMENT_SORT))).toEqual([2, 1])
  })
})

describe('sortDocuments — status', () => {
  it('ascending follows the pipeline progression', () => {
    const docs = [
      doc({ id: 4, uploadStatus: 'failed' }),
      doc({ id: 2, uploadStatus: 'processing' }),
      doc({ id: 1, uploadStatus: 'uploaded' }),
      doc({ id: 3, uploadStatus: 'processed' }),
    ]
    expect(ids(sortDocuments(docs, { column: 'status', direction: 'asc' }))).toEqual([1, 2, 3, 4])
    expect(ids(sortDocuments(docs, { column: 'status', direction: 'desc' }))).toEqual([4, 3, 2, 1])
  })
})

describe('sortDocuments — total', () => {
  const small = doc({ id: 1, extraction: [bill({ totalAmountOcr: 100 })] })
  const big = doc({ id: 2, extraction: [bill({ totalAmountOcr: 900 })] })
  const noTotal = doc({ id: 3, extraction: [] })

  it('descending is biggest first, with no-total documents last', () => {
    expect(ids(sortDocuments([noTotal, small, big], { column: 'total', direction: 'desc' }))).toEqual([2, 1, 3])
  })

  it('ascending is smallest first, with no-total documents STILL last', () => {
    expect(ids(sortDocuments([noTotal, big, small], { column: 'total', direction: 'asc' }))).toEqual([1, 2, 3])
  })
})

describe('stable tiebreaker', () => {
  it('breaks ties on ascending id regardless of direction', () => {
    const docs = [
      doc({ id: 30, uploadedAt: '2026-08-01T00:00:00Z' }),
      doc({ id: 10, uploadedAt: '2026-08-01T00:00:00Z' }),
      doc({ id: 20, uploadedAt: '2026-08-01T00:00:00Z' }),
    ]
    expect(ids(sortDocuments(docs, { column: 'uploaded', direction: 'desc' }))).toEqual([10, 20, 30])
    expect(ids(sortDocuments(docs, { column: 'uploaded', direction: 'asc' }))).toEqual([10, 20, 30])
  })

  it('compareDocuments is antisymmetric on the tie group', () => {
    const a = doc({ id: 1 })
    const b = doc({ id: 2 })
    const sort: DocumentSort = { column: 'status', direction: 'asc' }
    expect(Math.sign(compareDocuments(a, b, sort))).toBe(-Math.sign(compareDocuments(b, a, sort)))
  })

  it('does not mutate the input array', () => {
    const docs = [doc({ id: 2 }), doc({ id: 1 })]
    const snapshot = ids(docs)
    sortDocuments(docs, { column: 'uploaded', direction: 'asc' })
    expect(ids(docs)).toEqual(snapshot)
  })
})

describe('DOCUMENT_DESCENDING_FIRST', () => {
  it('contains exactly the date and amount columns', () => {
    expect([...DOCUMENT_DESCENDING_FIRST].sort()).toEqual(['total', 'uploaded'])
  })
})
