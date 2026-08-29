/**
 * Queue-tab sort for the Exceptions screen
 * (docs/hub-screen-certification.md §3.2).
 *
 * The queue is fetched as severity-ranked buckets and event-scoped in
 * application code (see app/(app)/exceptions/page.tsx), so the user-chosen
 * sort is applied here, in memory, over the already-assembled list rather
 * than in the PostgREST query. Severity rank stays the default; every branch
 * ends on a stable `id` tiebreaker so repeated loads land identically — the
 * same discipline Wave 1 item 1.1 added to the review queue.
 */
import { exceptionTypeLabel, severityRank } from '@/components/exceptions/labels'

export type QueueSortColumn = 'severity' | 'detected_at' | 'type'
export type QueueSortDirection = 'asc' | 'desc'

export const QUEUE_SORT_COLUMNS: readonly QueueSortColumn[] = ['severity', 'detected_at', 'type']
export const DEFAULT_QUEUE_SORT: { column: QueueSortColumn; direction: QueueSortDirection } = {
  column: 'severity',
  direction: 'desc',
}

/** Columns whose first click should open descending. */
export const QUEUE_DESCENDING_FIRST = new Set<QueueSortColumn>(['severity', 'detected_at'])

export interface QueueSortRow {
  id: number
  severity: string
  exception_type: string
  amount_at_risk: number | null
  created_at: string
}

function byId(a: QueueSortRow, b: QueueSortRow): number {
  return b.id - a.id
}

function amountDescNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

export function sortQueue<T extends QueueSortRow>(
  rows: T[],
  column: QueueSortColumn,
  direction: QueueSortDirection
): T[] {
  const dir = direction === 'asc' ? 1 : -1
  const copy = [...rows]

  copy.sort((a, b) => {
    if (column === 'detected_at') {
      const cmp = a.created_at.localeCompare(b.created_at) * dir
      return cmp !== 0 ? cmp : byId(a, b)
    }
    if (column === 'type') {
      const cmp = exceptionTypeLabel(a.exception_type).localeCompare(exceptionTypeLabel(b.exception_type)) * dir
      if (cmp !== 0) return cmp
      const rank = severityRank(b.severity) - severityRank(a.severity)
      return rank !== 0 ? rank : byId(a, b)
    }
    // severity (default): rank, then ₹ at risk, then recency, then id
    const rank = (severityRank(a.severity) - severityRank(b.severity)) * dir
    if (rank !== 0) return rank
    const amount = amountDescNullsLast(a.amount_at_risk, b.amount_at_risk)
    if (amount !== 0) return amount
    const recency = b.created_at.localeCompare(a.created_at)
    return recency !== 0 ? recency : byId(a, b)
  })

  return copy
}

export function parseQueueSort(
  sort: string | undefined,
  dir: string | undefined
): { column: QueueSortColumn; direction: QueueSortDirection } {
  const column = (QUEUE_SORT_COLUMNS as readonly string[]).includes(sort ?? '')
    ? (sort as QueueSortColumn)
    : DEFAULT_QUEUE_SORT.column
  const direction: QueueSortDirection = dir === 'asc' || dir === 'desc' ? dir : DEFAULT_QUEUE_SORT.direction
  return { column, direction }
}
