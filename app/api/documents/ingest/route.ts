import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { withApiLogging } from '@/lib/api-log'
import { getStaffContext } from '@/lib/export/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { putDocument } from '@/lib/storage'
import { getPdfPageCount, looksLikePdf, sha256Hex } from '@/lib/pdf'
import { runJobById } from '@/lib/jobs/drain'
import { serverEnv } from '@/lib/env.server'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'
import { getMaxUploadPages } from '@/lib/upload-limits'

/**
 * `documents-ingest` (MASTER-PLAN §8 point 2, §3.8, §11.2 Day 1).
 *
 * POST multipart/form-data:
 *   file        (required)  the PDF itself
 *   pageCount   (optional)  client-declared page count — used only as a
 *                           fallback when the server can't parse the PDF
 *   entryId     (optional)  attach straight to an entry; normally null,
 *                           because ~18 of the 21 real samples have no
 *                           matching entry (§11.2 Day 3)
 *
 * Creates `source_document` + one `document_page` per page, stores the
 * original in the private `invoice-documents` bucket, and queues an
 * `extract_document` job. Before responding, this route also runs THIS
 * document's own job to completion itself (see the awaited runJobById call
 * below), so extraction is attempted on upload rather than waiting for the
 * next Vercel Cron tick (app/api/jobs/tick/route.ts, a once/day safety net on
 * Hobby). It does NOT also drain anyone else's backlog — that used to happen
 * here too, but spending a user's own upload request on other users' queued
 * jobs was cut (see the comment above the runJobById call): the backlog is
 * covered by the cron tick, and by every other user's own upload draining
 * their own job the same way. Deliberately awaited rather than fired via
 * next/server's after(): after() did not reliably run to completion on this
 * project's Vercel deployment in practice, so the response now simply waits
 * instead of trusting it. Returns the new document id.
 *
 * ── Contract note for the Day 3 inbox agent ────────────────────────────────
 * This route takes the **raw PDF**, not pre-rendered page images. §8 point 1
 * has pdf.js rasterising client-side, but that exists for the review viewer,
 * not for ingest: the extraction handler sends the PDF straight to Claude
 * (see lib/pdf.ts for why nothing rasterises server-side). So the upload UI
 * only needs to POST the file — it does not have to render anything first,
 * and `pageCount` is optional because the server derives it.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024 // Claude's document-block ceiling (§8).

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document.pdf'
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'document.pdf'
}

/** `2026/08/<hash12>-<epoch>-<name>.pdf` — unique per upload, so re-scanning the
 *  same bill never collides on `source_document.storage_path`'s unique index. */
function buildStoragePath(hash: string, filename: string): string {
  const now = new Date()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${yyyy}/${mm}/${hash.slice(0, 12)}-${now.getTime()}-${safeFilename(filename)}`
}

async function handlePOST(request: NextRequest) {
  // Session-bound role check FIRST — everything below runs through the
  // service-role client, which has no RLS backstop (§4.5, and the pattern in
  // app/api/export-status/route.ts).
  const staff = await getStaffContext()
  if (!staff) {
    return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })
  }
  if (!staff.isActive) {
    return NextResponse.json({ error: 'Your account is pending activation.' }, { status: 403 })
  }

  // Everything below writes source_document/document_page rows stamped with
  // the selected event's id -- so the event is resolved and its mutability
  // asserted FIRST (Phase 6 Step 2 §1.6: "switching to a past event puts the
  // app in a view-only state -- no new uploads"), before any storage upload
  // or DB write is attempted. `admin` is created here (rather than at its
  // former spot further down) so this same client serves both this check
  // and every write later in the route.
  const admin = createAdminClient()
  const selectedEvent = await getSelectedEvent(admin)
  if (!isEventMutable(selectedEvent)) {
    return NextResponse.json(
      { error: 'This event is closed to new uploads. Switch to the current event before uploading.' },
      { status: 409 }
    )
  }
  const eventId = selectedEvent!.id

  // Kicked off now, awaited later (right before it's needed, after pageCount
  // is known) -- a single indexed-row read, cheap enough that running it
  // concurrently with the formData parse / hash / page-count work below
  // hides its latency entirely rather than adding a network round trip to
  // the request's critical path.
  const maxUploadPagesPromise = getMaxUploadPages(admin)

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Request must be multipart/form-data.' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'A "file" part is required.' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'The uploaded file is empty.' }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error:
          `File is ${file.size} bytes, which exceeds the file size limit of ${MAX_UPLOAD_BYTES} bytes.`,
      },
      { status: 413 }
    )
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!looksLikePdf(bytes)) {
    return NextResponse.json({ error: 'Only PDF uploads are supported.' }, { status: 415 })
  }

  const fileHash = sha256Hex(bytes)

  // Server-derived page count wins; the client-declared value is only a
  // fallback for a PDF pdf.js refuses to parse.
  let pageCount: number | null = null
  let pageCountUnresolved = false
  try {
    pageCount = await getPdfPageCount(bytes)
  } catch (err) {
    // Do NOT swallow this. A bare `catch {}` here hid a parse failure that
    // reproduces on every single upload in the deployed environment while
    // working fine locally (verified against the same bytes through the same
    // multipart path), which made it invisible for as long as it existed: the
    // only trace was a low-severity page_count_unresolved row whose wording
    // implies a bad PDF rather than a broken dependency. Since page_count
    // drives whether any document_page rows get created at all, a silent
    // failure here silently disables page classification. The reconciliation
    // exception below stays user-facing and plain-English; the technical
    // cause goes to the logs and Sentry, where it can actually be acted on.
    console.error(
      `[ingest] getPdfPageCount failed for "${file.name}" (${bytes.byteLength} bytes):`,
      err
    )
    Sentry.captureException(err, {
      tags: { route: 'documents-ingest', phase: 'get_pdf_page_count' },
      extra: { filename: file.name, byteLength: bytes.byteLength, fileHash },
    })
    const declared = Number(form.get('pageCount'))
    pageCount = Number.isInteger(declared) && declared > 0 ? declared : null
    // Neither the server-side parse nor a client-declared count worked. No
    // document_page rows get created below, and page_count stays null until
    // (if ever) extraction succeeds and backfills it from the model's own
    // pages[] count (lib/jobs/handlers/extract.ts) — silently, unless this is
    // flagged now (I1).
    pageCountUnresolved = pageCount === null
  }

  // Page-limit validation (docs/ocr-execution-decision.md follow-up): reject
  // a PDF too large to finish extraction within the platform's request time
  // limit BEFORE any storage write or document_page row exists — the
  // opposite of today's silent failure mode, where an oversized upload
  // times out after already being stored, gets stuck at upload_status
  // 'processing', and (per that doc's trace) never completes even after
  // three auto-retries, since each retry restarts from page 1 rather than
  // resuming. Skipped when pageCount is null (server-side parse AND the
  // client-declared fallback both failed) — there is nothing to compare
  // against, and pageCountUnresolved's own exception already flags that
  // case; this must not invent a second, contradictory failure mode for it.
  if (pageCount !== null) {
    const maxUploadPages = await maxUploadPagesPromise
    if (pageCount > maxUploadPages) {
      return NextResponse.json(
        {
          error:
            `This PDF has ${pageCount} pages. Uploads over ${maxUploadPages} pages currently can't ` +
            'complete in one pass — please split it into smaller files.',
        },
        { status: 422 }
      )
    }
  }

  const entryIdRaw = form.get('entryId')
  const entryId =
    typeof entryIdRaw === 'string' && entryIdRaw.trim() !== '' && Number.isInteger(Number(entryIdRaw))
      ? Number(entryIdRaw)
      : null

  // §8 point 2: a hash collision is a SOFT warning. The same bill legitimately
  // gets re-scanned, so the upload proceeds and an exception row is raised for
  // a human to look at.
  const { data: priorDocs } = await admin
    .from('source_document')
    .select('id')
    .eq('file_hash_sha256', fileHash)
    .order('id', { ascending: true })

  const duplicateOf: number | null = priorDocs?.[0]?.id ?? null

  const storagePath = buildStoragePath(fileHash, file.name)
  try {
    await putDocument(storagePath, bytes, 'application/pdf')
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload to storage failed.' },
      { status: 502 }
    )
  }

  const { data: inserted, error: insertError } = await admin
    .from('source_document')
    .insert({
      entry_id: entryId,
      storage_path: storagePath,
      original_filename: safeFilename(file.name),
      file_hash_sha256: fileHash,
      mime_type: 'application/pdf',
      page_count: pageCount,
      upload_status: 'uploaded',
      match_status: entryId === null ? 'unmatched' : 'matched',
      uploaded_by: staff.userId,
      event_id: eventId,
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    return NextResponse.json(
      { error: `source_document insert failed: ${insertError?.message ?? 'no row returned'}` },
      { status: 500 }
    )
  }

  const documentId = inserted.id as number

  // One document_page per page. `image_storage_path` stays null — the page
  // image is a derived artifact (§3.8) and nothing rasterises it today.
  // Classification columns are filled in by the extraction handler.
  if (pageCount !== null && pageCount > 0) {
    const pageRows = Array.from({ length: pageCount }, (_, i) => ({
      source_document_id: documentId,
      page_number: i + 1,
    }))
    const { error: pageError } = await admin.from('document_page').insert(pageRows)
    if (pageError) {
      return NextResponse.json(
        { error: `document_page insert failed: ${pageError.message}` },
        { status: 500 }
      )
    }
  }

  if (duplicateOf !== null) {
    await admin.from('reconciliation_exception').insert({
      source_document_id: documentId,
      exception_type: 'duplicate_document_hash',
      severity: 'low',
      description:
        `Uploaded file has the same SHA-256 as source_document ${duplicateOf}. ` +
        'Re-scans of the same bill are legitimate — confirm before discarding either copy.',
      dedup_key: `duplicate_document_hash:${fileHash}:${documentId}`,
    })
  }

  // I1: page count could not be derived from the PDF or a client-declared
  // fallback. document_page rows are not created below, so page classification
  // for this document is absent until (if ever) extraction backfills it — flag
  // that now instead of leaving it silent.
  if (pageCountUnresolved) {
    await admin.from('reconciliation_exception').insert({
      source_document_id: documentId,
      exception_type: 'page_count_unresolved',
      severity: 'low',
      description:
        `Could not determine the page count for source_document ${documentId} at ingest ` +
        '(server-side PDF parse failed and no client-declared count was supplied). No document_page ' +
        'rows were created; this backfills automatically once extraction succeeds, or needs manual review ' +
        'if extraction keeps failing.',
      dedup_key: `page_count_unresolved:${documentId}`,
    })
  }

  const { data: insertedJob, error: jobError } = await admin
    .from('job_queue')
    .insert({
      job_type: 'extract_document',
      payload: { source_document_id: documentId },
    })
    .select('id')
    .single()
  if (jobError || !insertedJob) {
    return NextResponse.json(
      { error: `job_queue insert failed: ${jobError?.message ?? 'no row returned'}`, documentId },
      { status: 500 }
    )
  }

  // Awaited, not fired via after(): after() turned out not to reliably run
  // to completion on this Vercel deployment (confirmed by hand — a document
  // stayed 'uploaded' indefinitely until /api/jobs/tick was hit manually,
  // even though that route runs the same claim/dispatch logic via
  // drainJobQueue). Rather than keep chasing an unverified background-task
  // platform behavior, the response simply waits for it: if this HTTP call
  // succeeds, extraction of THIS document has been attempted, no exceptions.
  // Same claim_next_job family of RPCs as the cron tick (lib/jobs/drain.ts),
  // so a burst of concurrent uploads can't double-claim a row. maxDuration=60
  // above leaves headroom beyond runJobById for the DB writes already done.
  //
  // Only this document's own job runs here, claimed by id — never anyone
  // else's backlog. That used to also run here (drainJobQueue after
  // runJobById, oldest-job-first), but it meant an upload could spend its own
  // request budget finishing other users' stale queued jobs, with no benefit
  // to the user who is waiting on THIS document. That backlog is already
  // covered without borrowing this request's time: the Vercel Cron tick
  // (app/api/jobs/tick/route.ts) sweeps it on a schedule, and — as long as
  // INGEST_INLINE_EXTRACTION is on — every other user's own upload drains
  // their own job the same way this one does, so the backlog rarely
  // accumulates in the first place.
  // ...but only when nothing better is available. With INGEST_INLINE_EXTRACTION
  // off (set it off as soon as a worker or cron is running, see
  // lib/env.server.ts), the job is left for that worker and the upload returns
  // immediately — which is the whole point of having one, since the worker is
  // not bounded by this route's maxDuration.
  let extractionOutcome: 'handled' | 'skipped' | 'unavailable' | 'failed' | 'deferred' = 'deferred'
  if (serverEnv.INGEST_INLINE_EXTRACTION) {
    const workerId = `${serverEnv.WORKER_ID}-upload`
    extractionOutcome = await runJobById(workerId, insertedJob.id as number)
    console.log(`[ingest] document ${documentId}: own extract job ${insertedJob.id} -> ${extractionOutcome}`)
  } else {
    console.log(
      `[ingest] document ${documentId}: extract job ${insertedJob.id} left for the worker ` +
        '(INGEST_INLINE_EXTRACTION=false)'
    )
  }

  return NextResponse.json({
    ok: true,
    documentId,
    pageCount,
    storagePath,
    fileHashSha256: fileHash,
    duplicateOf,
    queued: true,
    extractionOutcome,
  })
}

export const POST = withApiLogging('/api/documents/ingest', handlePOST)
