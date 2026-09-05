'use server'

/**
 * Server actions for the board pack (reporting-blueprint.md §5):
 *   - getBoardPackDownloadUrl -- mint a short-lived signed URL for a pack's
 *     .xlsx or .pdf, so the browser never sees a raw storage path (§4.3).
 *   - enqueueBoardPack -- admin-only "generate now": drop a `board_pack` job on
 *     the queue with run_after = now, so the existing drain picks it up on the
 *     next tick. The scheduled weekly run is unaffected -- the handler always
 *     re-schedules one week out regardless of how it was triggered.
 *
 * Both gate with the session-bound client FIRST (RLS-scoped role check), then
 * reach for the service-role client -- the same posture as lib/export/auth.ts +
 * lib/export/generate-status-batch.ts. board_pack has no insert policy for
 * `authenticated` and job_queue has no write policy at all, so the actual
 * writes must go through the admin client.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStaffContext, requireAdminOrAbove } from '@/lib/export/auth'
import type { JobStatus } from '@/lib/jobs/queue'

const BUCKET = 'board-packs'
const SIGNED_URL_TTL_SECONDS = 300

export type BoardPackActionResult =
  | { ok: true; url: string }
  | { ok: true; jobId: number }
  | { ok: true }
  | { ok: false; error: string }

export type BoardPackJobStatusResult =
  | { ok: true; status: JobStatus }
  | { ok: false; error: string }

/** A time-limited download URL for one pack's workbook or PDF. Staff-only
 *  (matches the board_pack SELECT policy). */
export async function getBoardPackDownloadUrl(
  boardPackId: number,
  kind: 'xlsx' | 'pdf'
): Promise<BoardPackActionResult> {
  const staff = await getStaffContext()
  if (!staff) return { ok: false, error: 'You must be signed in.' }
  if (!staff.isActive) return { ok: false, error: 'Your account is pending activation.' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('board_pack')
    .select('xlsx_path, pdf_path')
    .eq('id', boardPackId)
    .maybeSingle()
  if (error || !data) return { ok: false, error: 'That board pack could not be found.' }

  const path = kind === 'xlsx' ? (data.xlsx_path as string | null) : (data.pdf_path as string | null)
  if (!path) return { ok: false, error: `No ${kind.toUpperCase()} file is available for this pack.` }

  const signed = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  if (signed.error || !signed.data) {
    return { ok: false, error: 'Could not prepare the download link. Try again in a moment.' }
  }
  return { ok: true, url: signed.data.signedUrl }
}

/** Admin-only: enqueue a board_pack job to run on the next drain tick. */
export async function enqueueBoardPack(): Promise<BoardPackActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) {
    const msg =
      gate.reason === 'signed_out'
        ? 'You must be signed in.'
        : gate.reason === 'inactive'
          ? 'Your account is pending activation.'
          : 'Generating a board pack is an admin-only action.'
    return { ok: false, error: msg }
  }

  const admin = createAdminClient()

  // Don't pile up duplicates: if a board_pack job is already queued and due,
  // leave it. (A future-dated one -- the weekly schedule -- does not count.)
  const { data: pending } = await admin
    .from('job_queue')
    .select('id')
    .eq('job_type', 'board_pack')
    .eq('status', 'queued')
    .lte('run_after', new Date().toISOString())
    .limit(1)
  if (pending && pending.length > 0) {
    return { ok: false, error: 'A board pack is already queued and will run shortly.' }
  }

  const { data: inserted, error } = await admin
    .from('job_queue')
    .insert({
      job_type: 'board_pack',
      payload: { generatedBy: gate.staff.userId },
      run_after: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error || !inserted) return { ok: false, error: 'Could not queue the board pack. Try again.' }

  revalidatePath('/reports/brief')
  return { ok: true, jobId: inserted.id as number }
}

/**
 * Perf remediation Phase 7.9: lets BoardPackGenerateButton poll a single
 * job_queue row after enqueueing it, so it can router.refresh() the instant
 * the drain tick actually runs the job rather than leaving the new pack to
 * turn up only on a manual reload. Staff-gated like getBoardPackDownloadUrl
 * above rather than admin-gated -- this only reads queue metadata, and by the
 * time it's called the caller has already cleared the admin-only enqueue
 * gate once for this job.
 */
export async function getBoardPackJobStatus(jobId: number): Promise<BoardPackJobStatusResult> {
  const staff = await getStaffContext()
  if (!staff) return { ok: false, error: 'You must be signed in.' }
  if (!staff.isActive) return { ok: false, error: 'Your account is pending activation.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('job_queue').select('status').eq('id', jobId).maybeSingle()
  if (error || !data) return { ok: false, error: 'That job could not be found.' }

  return { ok: true, status: data.status as JobStatus }
}
