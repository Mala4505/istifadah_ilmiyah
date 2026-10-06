/**
 * "Bill N of M in this PDF" (pre-deploy findings §2.2).
 *
 * `document_extraction.bill_index` is NOT a safe numerator on its own: it is
 * the bill's absolute slot in the document and can have gaps -- marking a
 * single-page bill's page as skipped deletes that row (lib/actions/review.ts),
 * and rescope discovery appends at max(bill_index)+1. Pairing a gappy absolute
 * index with a row count is exactly how "Bill 4 of 3" happened.
 *
 * So both numbers come from the same list: every document_extraction row for
 * the source document (verified or not -- never a filtered queue), ordered by
 * bill_index, and the numerator is this bill's rank in that list.
 */
export interface BillPositionSibling {
  id: number
  billIndex: number
}

export interface BillPosition {
  /** 0-based, contiguous rank among `siblings` (display as `index + 1`). */
  index: number
  /** Total bills in the document; always >= index + 1. */
  count: number
}

export function computeBillPosition(siblings: readonly BillPositionSibling[], currentId: number): BillPosition {
  const ordered = [...siblings].sort((a, b) => a.billIndex - b.billIndex || a.id - b.id)
  const rank = ordered.findIndex((s) => s.id === currentId)
  if (rank === -1) {
    // Current bill not visible in the sibling list (e.g. RLS race or the row
    // was deleted mid-request): count it so the label can never read N of M<N.
    return { index: ordered.length, count: ordered.length + 1 }
  }
  return { index: rank, count: ordered.length }
}
