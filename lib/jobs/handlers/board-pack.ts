/**
 * `board_pack` job handler -- reporting-blueprint.md §5 ("The board pack -- the
 * same Brief rendered to a single PDF and a matching workbook, on a schedule").
 *
 * Structurally a copy of lib/jobs/handlers/flags-run.ts: a whole-corpus job
 * with no natural triggering event, so it makes itself recurring -- on every
 * completion (success OR failure) it re-inserts its own next run one week out
 * via `scheduleNextRun`, reusing the exact queue-claim mechanism §3.11 already
 * defines rather than adding a second scheduler. The existing drain loop
 * (lib/jobs/drain.ts, worker/index.ts, app/api/jobs/tick/route.ts) runs it.
 *
 * On each run it:
 *   1. resolves the current event (service-role client -- no cookie in a job),
 *   2. assembles the Brief payload from loadHeroMetrics + loadExecutiveBrief +
 *      loadWeeklyDigest (see lib/reports/board-pack/data.ts for the
 *      session-bound-loader seam),
 *   3. builds the .xlsx workbook (the deliverable of record) and a basic .pdf,
 *   4. uploads both to the private `board-packs` storage bucket,
 *   5. inserts one `public.board_pack` row pointing at them.
 *
 * >>> REGISTRATION (parent): this handler is NOT auto-discovered. Add a
 * >>>   `case 'board_pack'` to the dispatch switch in BOTH:
 * >>>     - lib/jobs/drain.ts  (the `dispatch()` function, next to `flags_run`)
 * >>>     - worker/index.ts    (the `dispatch()` function, next to `flags_run`)
 * >>>   each doing:
 * >>>     case 'board_pack': {
 * >>>       const { default: handler } = (await import('@/lib/jobs/handlers/board-pack')) as { default: JobHandler }
 * >>>       await handler(job)
 * >>>       return 'handled'   // (drain.ts) / return       (worker/index.ts)
 * >>>     }
 * >>>   and add `'board_pack'` to the `JobType` union in lib/jobs/queue.ts and
 * >>>   the local `JobQueueRow['job_type']` union in worker/index.ts.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { completeJob, failJob, type JobQueueRow } from '@/lib/jobs/queue'
import { createAdminClient } from '@/lib/supabase/admin'
import { assembleBoardPackData, resolveCurrentEvent } from '@/lib/reports/board-pack/data'
import { buildBoardPackWorkbook } from '@/lib/reports/board-pack/workbook'
import { buildBoardPackPdf } from '@/lib/reports/board-pack/pdf'

/** One week between scheduled packs (blueprint §5 "on a schedule"). */
const RECURRENCE_MINUTES = 7 * 24 * 60

const BUCKET = 'board-packs'
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type AdminClient = ReturnType<typeof createAdminClient>

export interface BoardPackResult {
  boardPackId: number
  eventId: number | null
  xlsxPath: string
  pdfPath: string | null
  pdfSkippedReason: string | null
}

/**
 * Generates one board pack and records it. Exported separately from the job
 * handler (same split as `runFlagsSweep`) so an admin-triggered "generate now"
 * can call exactly this path without going through the queue.
 *
 * `generatedBy` is the auth.uid() of the triggering admin for a manual run,
 * null for a scheduled run.
 */
export async function generateBoardPack(
  admin: AdminClient,
  generatedBy: string | null
): Promise<BoardPackResult> {
  const event = await resolveCurrentEvent(admin)
  const data = await assembleBoardPackData(admin, event)

  // Build both files BEFORE any DB write / upload, so a render failure never
  // leaves a half-written row (same ordering as generate-status-batch.ts).
  const xlsx = buildBoardPackWorkbook(data)

  let pdf: Uint8Array | null = null
  let pdfSkippedReason: string | null = null
  try {
    pdf = await buildBoardPackPdf(data)
  } catch (err) {
    // The workbook is the deliverable of record; a PDF failure must not fail
    // the whole pack. Recorded on the row (pdf_path stays null) and surfaced.
    pdfSkippedReason = err instanceof Error ? err.message : String(err)
    console.error(`[board-pack] PDF render failed, continuing with workbook only: ${pdfSkippedReason}`)
  }

  // Insert the row first -- its id namespaces the storage paths.
  const kpiSnapshot = {
    generatedAt: data.generatedAt,
    eventName: data.eventName,
    kpis: data.kpis,
    narrative: data.narrative,
    warnings: data.warnings,
  }
  const { data: row, error: insertErr } = await admin
    .from('board_pack')
    .insert({
      event_id: event?.id ?? null,
      xlsx_path: 'pending',
      kpi_snapshot: kpiSnapshot,
      generated_by: generatedBy,
    })
    .select('id')
    .single()
  if (insertErr || !row) {
    throw new Error(`board-pack: could not create the board_pack row: ${insertErr?.message ?? 'no row returned'}`)
  }
  const boardPackId = row.id as number

  const stamp = data.generatedAt.slice(0, 10)
  const xlsxPath = `${boardPackId}/board-pack-${stamp}.xlsx`
  const pdfPath = pdf ? `${boardPackId}/board-pack-${stamp}.pdf` : null

  const xlsxUpload = await admin.storage.from(BUCKET).upload(xlsxPath, xlsx, {
    contentType: XLSX_CONTENT_TYPE,
    upsert: true,
  })
  if (xlsxUpload.error) {
    await admin.from('board_pack').delete().eq('id', boardPackId)
    throw new Error(`board-pack: workbook upload failed: ${xlsxUpload.error.message}`)
  }

  if (pdf && pdfPath) {
    const pdfUpload = await admin.storage.from(BUCKET).upload(pdfPath, pdf, {
      contentType: 'application/pdf',
      upsert: true,
    })
    if (pdfUpload.error) {
      // Keep the pack -- workbook is enough. Note the miss.
      pdfSkippedReason = `upload failed: ${pdfUpload.error.message}`
      pdf = null
      console.error(`[board-pack] ${pdfSkippedReason}`)
    }
  }

  const { error: updateErr } = await admin
    .from('board_pack')
    .update({
      xlsx_path: xlsxPath,
      pdf_path: pdf ? pdfPath : null,
      kpi_snapshot: { ...kpiSnapshot, xlsxSha256: createHash('sha256').update(xlsx).digest('hex') },
    })
    .eq('id', boardPackId)
  if (updateErr) {
    throw new Error(`board-pack: files uploaded but recording their paths failed: ${updateErr.message}`)
  }

  return {
    boardPackId,
    eventId: event?.id ?? null,
    xlsxPath,
    pdfPath: pdf ? pdfPath : null,
    pdfSkippedReason,
  }
}

/** Inserts the next scheduled run. Mirrors flags-run.ts's scheduleNextRun. */
async function scheduleNextRun(admin: AdminClient): Promise<void> {
  const runAfter = new Date(Date.now() + RECURRENCE_MINUTES * 60_000).toISOString()
  const { error } = await admin.from('job_queue').insert({
    job_type: 'board_pack',
    payload: {},
    run_after: runAfter,
  })
  if (error) {
    // Not re-thrown: failing to schedule the NEXT run must not turn THIS run's
    // successful generation into a failed job (same reasoning as flags-run).
    console.error(`[board-pack] failed to schedule next run: ${error.message}`)
  }
}

/** The JobHandler contract from worker/index.ts. */
export async function handleBoardPack(job: JobQueueRow): Promise<void> {
  const admin = createAdminClient()
  // A scheduled run has an empty payload; a manual enqueue may carry the
  // triggering admin's uid.
  const generatedBy =
    typeof job.payload?.generatedBy === 'string' ? (job.payload.generatedBy as string) : null

  try {
    const result = await generateBoardPack(admin, generatedBy)
    console.log(
      `[board-pack] job ${job.id}: pack=${result.boardPackId} event=${result.eventId ?? 'none'} ` +
        `xlsx=${result.xlsxPath} pdf=${result.pdfPath ?? `skipped(${result.pdfSkippedReason ?? 'unknown'})`}`
    )
    await scheduleNextRun(admin)
    await completeJob(job.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[board-pack] job ${job.id} failed:`, message)
    // Even a failed run re-schedules itself -- a single bad run must not end
    // recurrence (same reasoning as flags-run).
    await scheduleNextRun(admin)
    await failJob(job.id, message.slice(0, 2000))
  }
}

export default handleBoardPack
