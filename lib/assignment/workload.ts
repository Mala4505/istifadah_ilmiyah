/**
 * Read helper for the superadmin workload board (document assignment,
 * "dividing the document inbox", 2026-08-29 -- design §06 "Direction C").
 * Plain module (no 'use server') that takes a caller-supplied, RLS-scoped
 * Supabase client -- same shape as lib/assignment/queries.ts -- so the
 * superadmin-only RSC page can call it directly.
 *
 * Answers one question: how much of the selected event's review work has
 * each admin been given, and how far through it are they?
 *
 * Redesigned 2026-10-05 (user request): counted in BILLS (document_extraction
 * rows), not PDFs, and over the WHOLE selected event -- every bill on every
 * document ever assigned to the admin, including ones that have since left
 * the inbox -- rather than a snapshot of what is still sitting in the inbox.
 * Each admin's bills fall into exactly one of four stages, which always sum
 * to `assignedCount`:
 *
 *   pending    not verified, and the admin isn't holding the claim on it
 *              (includes a document not yet extracted -- one pending bill)
 *   reviewing  not verified, and the admin currently holds the claim
 *   reviewed   verified (Review stage 1), but still in `v_review_queue` --
 *              not yet connected to an entry and/or classified
 *   completed  cleared every Review stage (no longer in `v_review_queue`)
 *
 * `reviewed` / `completed` use the same `v_review_queue` test as the
 * /documents KPI bar (lib/documents/bill-kpis.ts), so the two screens agree.
 *
 * Best-effort and defensively coded: a failed sub-query degrades a number to
 * 0 / null rather than failing the page.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSelectedEventId } from '@/lib/events/current'
import { listAssignableStaff } from '@/lib/assignment/queries'
import { logRawError } from '@/lib/friendly-error'

/** The unassigned "pool" -- documents still in the inbox with no assignee rows. */
export interface WorkloadPool {
  /** Bills on in-inbox, unassigned documents. A document with no extraction
   *  yet counts as one pending bill. */
  count: number
  /** Age in whole days of the oldest such document. Null when the pool is empty. */
  oldestDays: number | null
}

/** One admin row on the board, counted in bills for the selected event. */
export interface StaffWorkload {
  staffId: string
  displayName: string
  /** Every bill on every document assigned to this admin, for the event. */
  assignedCount: number
  pendingCount: number
  reviewingCount: number
  reviewedCount: number
  completedCount: number
  /** Most recent bill this staff verified, for the selected event. Null if never. */
  lastReviewedAt: string | null
}

export interface AssignmentWorkload {
  pool: WorkloadPool
  perStaff: StaffWorkload[]
}

const DAY_MS = 86_400_000
/** PostgREST caps a response at 1,000 rows by default -- page past it. */
const PAGE = 1000

type PagedQuery<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

/** Reads every row of a query, 1,000 at a time. Stops (and logs) on error. */
async function fetchAllRows<T>(label: string, build: () => PagedQuery<T>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) {
      logRawError(`assignment.getAssignmentWorkload:${label}`, error.message)
      break
    }
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

/**
 * Workload totals for the selected event: the unassigned pool plus one row
 * per active admin/superadmin. Every failure path returns zeros rather than
 * throwing -- the board is a monitoring view, not a critical path.
 */
export async function getAssignmentWorkload(supabase: SupabaseClient): Promise<AssignmentWorkload> {
  const empty: AssignmentWorkload = { pool: { count: 0, oldestDays: null }, perStaff: [] }

  try {
    const selectedEventId = await getSelectedEventId()

    type DocRow = { id: number; uploaded_at: string | null; claimed_by: string | null; match_status: string }
    type BillRow = { id: number; source_document_id: number; verified_at: string | null; verified_by: string | null }
    type QueueRow = { document_extraction_id: number }
    type AssigneeRow = { staff_id: string; source_document_id: number }

    const [staff, assigneeRows, docs, bills, queueRows] = await Promise.all([
      listAssignableStaff(supabase),
      fetchAllRows<AssigneeRow>('assignees', () =>
        supabase.from('source_document_assignee').select('staff_id, source_document_id').order('source_document_id') as unknown as PagedQuery<AssigneeRow>
      ),
      fetchAllRows<DocRow>('documents', () => {
        let q = supabase.from('source_document').select('id, uploaded_at, claimed_by, match_status').order('id')
        if (selectedEventId !== null) q = q.eq('event_id', selectedEventId)
        return q as unknown as PagedQuery<DocRow>
      }),
      fetchAllRows<BillRow>('bills', () => {
        let q = supabase
          .from('document_extraction')
          .select('id, source_document_id, verified_at, verified_by, source_document!inner(event_id)')
          .order('id')
        if (selectedEventId !== null) q = q.eq('source_document.event_id', selectedEventId)
        return q as unknown as PagedQuery<BillRow>
      }),
      fetchAllRows<QueueRow>('queue', () => {
        let q = supabase.from('v_review_queue').select('document_extraction_id').order('document_extraction_id')
        if (selectedEventId !== null) q = q.eq('event_id', selectedEventId)
        return q as unknown as PagedQuery<QueueRow>
      }),
    ])

    const perStaff = new Map<string, StaffWorkload>(
      staff.map((s) => [
        s.id,
        {
          staffId: s.id,
          displayName: s.displayName,
          assignedCount: 0,
          pendingCount: 0,
          reviewingCount: 0,
          reviewedCount: 0,
          completedCount: 0,
          lastReviewedAt: null,
        },
      ])
    )

    const docById = new Map(docs.map((d) => [d.id, d]))
    const inQueue = new Set(queueRows.map((r) => r.document_extraction_id))

    type Bill = { verifiedAt: string | null; inQueue: boolean; isPlaceholder: boolean }
    const billsByDoc = new Map<number, Bill[]>()
    for (const b of bills) {
      const list = billsByDoc.get(b.source_document_id) ?? []
      list.push({ verifiedAt: b.verified_at, inQueue: inQueue.has(b.id), isPlaceholder: false })
      billsByDoc.set(b.source_document_id, list)

      // "Last reviewed" -- this admin's most recent verification in the event.
      if (b.verified_by && b.verified_at) {
        const entry = perStaff.get(b.verified_by)
        if (entry && (entry.lastReviewedAt === null || b.verified_at > entry.lastReviewedAt)) {
          entry.lastReviewedAt = b.verified_at
        }
      }
    }
    /** Bills on a document, or one placeholder pending bill if it hasn't been extracted yet. */
    const billsFor = (docId: number): Bill[] =>
      billsByDoc.get(docId) ?? [{ verifiedAt: null, inQueue: true, isPlaceholder: true }]

    const assignedDocIds = new Set<number>()
    for (const row of assigneeRows) {
      const doc = docById.get(row.source_document_id)
      if (!doc) continue // a different event's document
      assignedDocIds.add(doc.id)

      const entry = perStaff.get(row.staff_id)
      if (!entry) continue

      const isClaimedByThem = doc.claimed_by === row.staff_id
      for (const bill of billsFor(doc.id)) {
        entry.assignedCount += 1
        if (bill.isPlaceholder || bill.verifiedAt === null) {
          if (!bill.isPlaceholder && isClaimedByThem) entry.reviewingCount += 1
          else entry.pendingCount += 1
        } else if (bill.inQueue) {
          entry.reviewedCount += 1
        } else {
          entry.completedCount += 1
        }
      }
    }

    const now = Date.now()
    let oldestPoolDays: number | null = null
    let poolCount = 0
    for (const doc of docs) {
      if (assignedDocIds.has(doc.id)) continue
      if (doc.match_status !== 'unmatched' && doc.match_status !== 'suggested') continue
      poolCount += billsFor(doc.id).length
      const ms = doc.uploaded_at ? new Date(doc.uploaded_at).getTime() : NaN
      if (!Number.isNaN(ms)) {
        const age = Math.max(0, Math.floor((now - ms) / DAY_MS))
        if (oldestPoolDays === null || age > oldestPoolDays) oldestPoolDays = age
      }
    }

    return {
      pool: { count: poolCount, oldestDays: oldestPoolDays },
      perStaff: Array.from(perStaff.values()),
    }
  } catch (err) {
    logRawError('assignment.getAssignmentWorkload', err instanceof Error ? err.message : String(err))
    return empty
  }
}
