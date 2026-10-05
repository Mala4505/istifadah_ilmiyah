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

export type QueueSortColumn = 'severity' | 'detected_at' | 'type' | 'amount' | 'status' | 'entry'
export type QueueSortDirection = 'asc' | 'desc'

export const QUEUE_SORT_COLUMNS: readonly QueueSortColumn[] = ['severity', 'detected_at', 'type', 'amount', 'status', 'entry']
export const DEFAULT_QUEUE_SORT: { column: QueueSortColumn; direction: QueueSortDirection } = {
  column: 'severity',
  direction: 'desc',
}

/** Columns whose first click should open descending. */
export const QUEUE_DESCENDING_FIRST = new Set<QueueSortColumn>(['severity', 'detected_at', 'amount'])

export interface QueueSortRow {
  id: number
  severity: string
  exception_type: string
  amount_at_risk: number | null
  created_at: string
  status?: string
  entry_id?: number | null
  description?: string | null
}

/** Nulls last regardless of direction. */
function nullableCompare(a: number | string | null | undefined, b: number | string | null | undefined, dir: number): number {
  const an = a === null || a === undefined
  const bn = b === null || b === undefined
  if (an && bn) return 0
  if (an) return 1
  if (bn) return -1
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir
  return String(a).localeCompare(String(b)) * dir
}

/**
 * Free-text search over the queue (2026-10-05: every table gets search).
 * Matches the description, the exception type (code and label), the status,
 * and the entry / exception id. Applied in memory like the sort.
 */
export function searchQueue<T extends QueueSortRow>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const bare = q.replace(/^#/, '')
  return rows.filter((r) =>
    [r.description, r.exception_type, exceptionTypeLabel(r.exception_type), r.status, r.severity]
      .some((v) => typeof v === 'string' && v.toLowerCase().includes(q)) ||
    String(r.entry_id ?? '') === bare ||
    String(r.id) === bare
  )
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
    if (column === 'amount') {
      const cmp = nullableCompare(a.amount_at_risk, b.amount_at_risk, dir)
      return cmp !== 0 ? cmp : byId(a, b)
    }
    if (column === 'status') {
      const cmp = nullableCompare(a.status, b.status, dir)
      return cmp !== 0 ? cmp : byId(a, b)
    }
    if (column === 'entry') {
      const cmp = nullableCompare(a.entry_id, b.entry_id, dir)
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
