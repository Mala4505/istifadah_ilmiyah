/**
 * Read helper for the superadmin workload board (document assignment,
 * "dividing the document inbox", 2026-08-29 -- design §06 "Direction C").
 * Plain module (no 'use server') that takes a caller-supplied, RLS-scoped
 * Supabase client -- same shape as lib/assignment/queries.ts -- so the
 * superadmin-only RSC page can call it directly.
 *
 * Answers one question: is the review work spread sensibly across the admins,
 * and is anyone's stack going stale? Best-effort and defensively coded: a
 * failed sub-query degrades a number to 0 / null rather than failing the page.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSelectedEventId } from '@/lib/events/current'
import { listAssignableStaff } from '@/lib/assignment/queries'
import { logRawError } from '@/lib/friendly-error'

/** The unassigned "pool" -- documents still in the inbox with no assignee rows. */
export interface WorkloadPool {
  /** In-inbox, unassigned documents for the selected event. */
  count: number
  /** Age in whole days of the oldest such document. Null when the pool is empty. */
  oldestDays: number | null
}

/** One admin column on the board. */
export interface StaffWorkload {
  staffId: string
  displayName: string
  /** Assignee rows for still-in-inbox documents (match_status unmatched/suggested). */
  assignedCount: number
  /** Of those, ones this staff currently holds the claim lock on and that still
   *  have an unverified bill. */
  inProgressCount: number
  /** document_extraction rows this staff verified today. */
  verifiedTodayCount: number
  /** Age in whole days of their oldest assigned in-inbox document that still has
   *  an unverified bill. Null when they have nothing outstanding. */
  oldestUnactionedDays: number | null
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

    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)

    const [staff, assigneeResult, docsResult, verifiedResult] = await Promise.all([
      listAssignableStaff(supabase),
      supabase.from('source_document_assignee').select('staff_id, source_document_id'),
      docsQuery,
      supabase
        .from('document_extraction')
        .select('verified_by, verified_at')
        .gte('verified_at', startOfToday.toISOString()),
    ])

    const perStaff = new Map<string, StaffWorkload>(
      staff.map((s) => [
        s.id,
        {
          staffId: s.id,
          displayName: s.displayName,
          assignedCount: 0,
          inProgressCount: 0,
          verifiedTodayCount: 0,
          oldestUnactionedDays: null,
        },
      ])
    )

    const inboxDocs = docsResult.data ?? []
    const inboxDocIds = inboxDocs.map((d) => d.id as number)
    const inboxDocIdSet = new Set(inboxDocIds)
    const uploadedAtById = new Map<number, string>(inboxDocs.map((d) => [d.id as number, d.uploaded_at as string]))
    const claimedByById = new Map<number, string | null>(
      inboxDocs.map((d) => [d.id as number, (d.claimed_by as string | null) ?? null])
    )

    // Which in-inbox documents still carry at least one unverified bill.
    const unverifiedDocIds = new Set<number>()
    if (inboxDocIds.length > 0) {
      const { data: extractions } = await supabase
        .from('document_extraction')
        .select('source_document_id, verified_at')
        .in('source_document_id', inboxDocIds)
      for (const row of extractions ?? []) {
        if (row.verified_at === null) unverifiedDocIds.add(row.source_document_id as number)
      }
    }

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

      entry.assignedCount += 1
      const hasUnverifiedBill = unverifiedDocIds.has(docId)
      if (hasUnverifiedBill && claimedByById.get(docId) === staffId) {
        entry.inProgressCount += 1
      }
      if (hasUnverifiedBill) {
        const age = ageDays(uploadedAtById.get(docId))
        if (age !== null && (entry.oldestUnactionedDays === null || age > entry.oldestUnactionedDays)) {
          entry.oldestUnactionedDays = age
        }
      }
    }

    for (const row of verifiedResult.data ?? []) {
      const staffId = row.verified_by as string | null
      if (!staffId) continue
      const entry = perStaff.get(staffId)
      if (entry) entry.verifiedTodayCount += 1
    }

    let oldestPoolDays: number | null = null
    let poolCount = 0
    for (const doc of inboxDocs) {
      if (assignedDocIds.has(doc.id as number)) continue
      poolCount += 1
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
