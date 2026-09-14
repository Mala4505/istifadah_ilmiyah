/**
 * Read helper for the superadmin workload board (document assignment,
 * "dividing the document inbox", 2026-08-29 -- design §06 "Direction C").
 * Plain module (no 'use server') that takes a caller-supplied, RLS-scoped
 * Supabase client -- same shape as lib/assignment/queries.ts -- so the
 * superadmin-only RSC page can call it directly.
 *
 * Answers one question: is the review work spread sensibly across the admins?
 * Best-effort and defensively coded: a failed sub-query degrades a number to
 * 0 / null rather than failing the page.
 *
 * Kept deliberately simple (redesigned 2026-09-14 after the original
 * in-progress/verified-today/oldest-unactioned trio proved confusing): each
 * admin's assigned pile is split into three statuses that always sum to
 * assignedCount, plus a single "last reviewed" timestamp for recency.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSelectedEventId } from '@/lib/events/current'
import { listAssignableStaff } from '@/lib/assignment/queries'
import { logRawError } from '@/lib/friendly-error'

/** The unassigned "pool" -- documents still in the inbox with no assignee rows. */
export interface WorkloadPool {
  /** Bills (document_extraction rows) on in-inbox, unassigned documents. A
   *  document with no extraction yet counts as one pending bill. */
  count: number
  /** Age in whole days of the oldest such document. Null when the pool is empty. */
  oldestDays: number | null
}

/** One admin column on the board. Counted in bills, not PDFs -- a multi-bill
 *  document (a batch scan) contributes one unit per bill, not one per file. */
export interface StaffWorkload {
  staffId: string
  displayName: string
  /** Total bills across this staff's still-in-inbox assigned documents. A
   *  document with no extraction yet counts as one pending bill. */
  assignedCount: number
  /** Of assignedCount: not yet extracted, or extracted but nobody's claimed it. */
  notStartedCount: number
  /** Of assignedCount: this staff holds the claim lock and the bill is unverified. */
  inProgressCount: number
  /** Of assignedCount: the bill has been verified. */
  verifiedCount: number
  /** Most recent bill this staff verified, for the selected event. Null if never. */
  lastReviewedAt: string | null
}

export interface AssignmentWorkload {
  pool: WorkloadPool
  perStaff: StaffWorkload[]
}

const DAY_MS = 86_400_000

/**
 * Workload snapshot for the selected event: the unassigned pool plus one row
 * per active admin/superadmin. Every failure path returns zeros rather than
 * throwing -- the board is a monitoring view, not a critical path.
 */
export async function getAssignmentWorkload(supabase: SupabaseClient): Promise<AssignmentWorkload> {
  const empty: AssignmentWorkload = { pool: { count: 0, oldestDays: null }, perStaff: [] }

  try {
    const selectedEventId = await getSelectedEventId()

    let docsQuery = supabase
      .from('source_document')
      .select('id, uploaded_at, claimed_by')
      .in('match_status', ['unmatched', 'suggested'])
    if (selectedEventId !== null) docsQuery = docsQuery.eq('event_id', selectedEventId)

    let lastReviewedQuery = supabase
      .from('document_extraction')
      .select('verified_by, verified_at, source_document!inner(event_id)')
      .not('verified_by', 'is', null)
      .order('verified_at', { ascending: false })
    if (selectedEventId !== null) {
      lastReviewedQuery = lastReviewedQuery.eq('source_document.event_id', selectedEventId)
    }

    const [staff, assigneeResult, docsResult, lastReviewedResult] = await Promise.all([
      listAssignableStaff(supabase),
      supabase.from('source_document_assignee').select('staff_id, source_document_id'),
      docsQuery,
      lastReviewedQuery,
    ])

    const perStaff = new Map<string, StaffWorkload>(
      staff.map((s) => [
        s.id,
        {
          staffId: s.id,
          displayName: s.displayName,
          assignedCount: 0,
          notStartedCount: 0,
          inProgressCount: 0,
          verifiedCount: 0,
          lastReviewedAt: null,
        },
      ])
    )

    // Sorted verified_at desc, so the first row seen per staff is their latest.
    for (const row of lastReviewedResult.data ?? []) {
      const staffId = row.verified_by as string | null
      if (!staffId) continue
      const entry = perStaff.get(staffId)
      if (entry && entry.lastReviewedAt === null) entry.lastReviewedAt = row.verified_at as string
    }

    const inboxDocs = docsResult.data ?? []
    const inboxDocIds = inboxDocs.map((d) => d.id as number)
    const inboxDocIdSet = new Set(inboxDocIds)
    const claimedByById = new Map<number, string | null>(
      inboxDocs.map((d) => [d.id as number, (d.claimed_by as string | null) ?? null])
    )

    // A bill is "not started" if it's only a placeholder (document not yet
    // extracted) or extracted-but-unclaimed; claim status only matters once a
    // real, unverified extraction exists.
    type Bill = { verifiedAt: string | null; isPlaceholder: boolean }

    // Bills (document_extraction rows) per in-inbox document -- a batch scan
    // can produce more than one, and each is counted as its own unit below.
    const billsByDoc = new Map<number, Bill[]>()
    if (inboxDocIds.length > 0) {
      const { data: extractions } = await supabase
        .from('document_extraction')
        .select('source_document_id, verified_at')
        .in('source_document_id', inboxDocIds)
      for (const row of extractions ?? []) {
        const docId = row.source_document_id as number
        const bills = billsByDoc.get(docId) ?? []
        bills.push({ verifiedAt: row.verified_at as string | null, isPlaceholder: false })
        billsByDoc.set(docId, bills)
      }
    }
    /** Bills on a document, or one placeholder pending bill if it hasn't been extracted yet. */
    const billsFor = (docId: number): Bill[] => billsByDoc.get(docId) ?? [{ verifiedAt: null, isPlaceholder: true }]

    const now = Date.now()
    const ageDays = (iso: string | undefined | null): number | null => {
      if (!iso) return null
      const ms = new Date(iso).getTime()
      if (Number.isNaN(ms)) return null
      return Math.max(0, Math.floor((now - ms) / DAY_MS))
    }

    const assigneeRows = assigneeResult.data ?? []
    const assignedDocIds = new Set<number>()
    for (const row of assigneeRows) {
      const staffId = row.staff_id as string
      const docId = row.source_document_id as number
      assignedDocIds.add(docId)

      const entry = perStaff.get(staffId)
      if (!entry || !inboxDocIdSet.has(docId)) continue

      const isClaimedByThem = claimedByById.get(docId) === staffId
      for (const bill of billsFor(docId)) {
        entry.assignedCount += 1
        if (!bill.isPlaceholder && bill.verifiedAt !== null) {
          entry.verifiedCount += 1
        } else if (!bill.isPlaceholder && isClaimedByThem) {
          entry.inProgressCount += 1
        } else {
          entry.notStartedCount += 1
        }
      }
    }

    let oldestPoolDays: number | null = null
    let poolCount = 0
    for (const doc of inboxDocs) {
      const docId = doc.id as number
      if (assignedDocIds.has(docId)) continue
      poolCount += billsFor(docId).length
      const age = ageDays(doc.uploaded_at as string)
      if (age !== null && (oldestPoolDays === null || age > oldestPoolDays)) oldestPoolDays = age
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
