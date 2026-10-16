import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { withApiLogging } from '@/lib/api-log'
import { getStaffContext } from '@/lib/export/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  checkPendingUpload,
  clearPendingUpload,
  deleteDocument,
  getDocumentBytes,
  getDocumentSize,
} from '@/lib/storage'
import { jsonRequestProblem } from '@/lib/http-guards'
import { publicEnv } from '@/lib/env'
import { logRawError } from '@/lib/friendly-error'
import { getPdfPageCount, looksLikePdf, sha256Hex } from '@/lib/pdf'
import { runJobById } from '@/lib/jobs/drain'
import { triggerRemoteWorker } from '@/lib/jobs/trigger-worker'
import { serverEnv } from '@/lib/env.server'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'
import { getMaxUploadPages } from '@/lib/upload-limits'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { assertEntryVisible } from '@/lib/auth/scope'

/**
 * `documents-ingest` (MASTER-PLAN §8 point 2, §3.8, §11.2 Day 1).
 *
 * Finalize step of a two-step upload — POST JSON:
 *   path        (required)  storage path from /api/documents/upload-url,
 *                           where the browser has already PUT the file's raw
 *                           bytes directly (a Supabase Storage signed upload
 *                           URL, never routed through this or any other
 *                           Vercel function)
 *   filename    (required)  original filename, for `source_document.original_filename`
 *   pageCount   (optional)  ignored: the server derives the page count itself,
 *                           and a PDF it cannot parse is rejected (audit 3.3)
 *   entryId     (optional)  attach straight to an entry; normally null,
 *                           because ~18 of the 21 real samples have no
 *                           matching entry (§11.2 Day 3)
 *   assignedTo  (optional)  comma-separated staff uuids to assign this
 *                           document to (document-assignment feature,
 *                           2026-08-29). Absent/empty = unassigned, which is
 *                           the pre-feature behaviour. Each id is validated as
 *                           an active admin/superadmin before an
 *                           `source_document_assignee` row is written; a
 *                           failure there is logged but never fails the upload
 *                           (the document already exists by that point).
 *
 * This used to receive the raw PDF itself as multipart form data in one
 * request. That hit a platform wall in production: a Vercel Serverless
 * Function's request body is hard-capped at 4.5MB, independent of anything
 * this app enforces — so a phone-photographed PDF of even a handful of
 * full-resolution-JPEG pages reliably got a 413 this route's own code never
 * ran to see, regardless of page count. The upload is now two requests: the
 * browser gets a signed URL from /api/documents/upload-url and PUTs the file
 * straight to storage (bypassing any Vercel function for the large part
 * entirely), then calls this route — whose own request body is now just a
 * path and a few strings — to download those bytes back out and run the same
 * hash/page-count/validation/DB-write logic this route always has.
 *
 * Creates `source_document` + one `document_page` per page and queues an
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
 * only needs to hand this route a storage path — it does not have to render
 * anything first, and `pageCount` is optional because the server derives it.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024 // Claude's document-block ceiling (§8).

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document.pdf'
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'document.pdf'
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

  // Cookie-authenticated JSON route: must be JSON and from our own origin
  // (security-audit-fix-plan.md 4.3 CSRF).
  const guardProblem = jsonRequestProblem(request.headers, {
    siteUrl: publicEnv.NEXT_PUBLIC_SITE_URL,
    checkOrigin: true,
  })
  if (guardProblem) {
    return NextResponse.json({ error: guardProblem.error }, { status: guardProblem.status })
  }

  // Everything below writes source_document/document_page rows stamped with
  // the selected event's id -- so the event is resolved and its mutability
  // asserted FIRST (Phase 6 Step 2 §1.6: "switching to a past event puts the
  // app in a view-only state -- no new uploads"), before any storage upload
  // or DB write is attempted. `admin` is created here (rather than at its
  // former spot further down) so this same client serves both this check
  // and every write later in the route.
  const admin = createAdminClient()
  const selectedEvent = await getSelectedEvent()
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

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const bodyRecord = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const storagePath = typeof bodyRecord.path === 'string' ? bodyRecord.path : ''
  const filename = typeof bodyRecord.filename === 'string' && bodyRecord.filename.trim() ? bodyRecord.filename : 'document.pdf'
  if (!storagePath) {
    return NextResponse.json({ error: 'A "path" is required — call /api/documents/upload-url first.' }, { status: 400 })
  }
  // `path` is client-supplied and everything below reads — and on a failed
  // check, deletes — it through the service-role client. Accept only a fresh
  // path in upload-url's buildStoragePath() shape that no document owns yet,
  // so a caller can never point this route at someone else's stored file.
  if (!/^\d{4}\/\d{2}\/[0-9a-f]{12}-\d+-[A-Za-z0-9._-]{1,120}$/.test(storagePath)) {
    return NextResponse.json({ error: 'Invalid upload path — call /api/documents/upload-url first.' }, { status: 400 })
  }
  const { data: pathOwner, error: pathOwnerError } = await admin
    .from('source_document')
    .select('id')
    .eq('storage_path', storagePath)
    .maybeSingle()
  if (pathOwnerError) {
    return NextResponse.json({ error: 'Could not verify the upload path.' }, { status: 500 })
  }
  if (pathOwner) {
    return NextResponse.json({ error: 'This upload has already been finalized.' }, { status: 409 })
  }

  // Only the user a path was issued to may finalise it (upload-url records each
  // issued path against its user; security-audit-fix-plan.md 4.3). Nothing is
  // deleted on a mismatch -- the file belongs to someone else. If the ledger
  // table is not there yet (migration pending) we log and keep the old behaviour
  // so deploy-before-push does not break uploads.
  const issuedTo = await checkPendingUpload(storagePath, staff.userId)
  if (issuedTo === 'other_user') {
    return NextResponse.json({ error: 'This upload was started by someone else.' }, { status: 403 })
  }
  if (issuedTo === 'unknown') {
    return NextResponse.json(
      { error: 'This upload was not recognised. Please upload the file again.' },
      { status: 403 }
    )
  }
  if (issuedTo === 'table_missing') {
    logRawError('ingest', 'pending_upload table missing; skipping issued-to-user check')
  } else if (issuedTo === 'error') {
    return NextResponse.json(
      { error: 'We couldn’t verify this upload just now. Please try again in a moment.' },
      { status: 502 }
    )
  }

  // Ask storage how big the object is BEFORE pulling it into memory, so an
  // oversize object is rejected (and removed) without being downloaded. When
  // storage can't say, the post-download size check below still applies.
  const declaredSize = await getDocumentSize(storagePath)
  if (declaredSize !== null && declaredSize > MAX_UPLOAD_BYTES) {
    await deleteDocument(storagePath).catch(() => {})
    await clearPendingUpload(storagePath)
    return NextResponse.json(
      { error: 'This file is larger than the 32 MB limit. Please upload a smaller file.' },
      { status: 413 }
    )
  }

  // The browser already PUT the file straight to storage via the signed URL
  // from /api/documents/upload-url — this downloads it back out so the rest
  // of this route's validation (hash, page count, PDF sniff) runs exactly as
  // it always has, just off storage instead of the request body.
  let bytes: Uint8Array
  try {
    bytes = await getDocumentBytes(storagePath)
  } catch (err) {
    logRawError('ingest read-back', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'We couldn’t read the uploaded file back. Please try uploading it again.' },
      { status: 502 }
    )
  }
  if (bytes.byteLength === 0) {
    await deleteDocument(storagePath).catch(() => {})
    return NextResponse.json({ error: 'The uploaded file is empty.' }, { status: 400 })
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    await deleteDocument(storagePath).catch(() => {})
    return NextResponse.json(
      { error: 'This file is larger than the 32 MB limit. Please upload a smaller file.' },
      { status: 413 }
    )
  }
  if (!looksLikePdf(bytes)) {
    await deleteDocument(storagePath).catch(() => {})
    return NextResponse.json({ error: 'Only PDF uploads are supported.' }, { status: 415 })
  }

  const fileHash = sha256Hex(bytes)

  // Server-derived page count wins; the client-declared value is only a
  // fallback for a PDF pdf.js refuses to parse.
  let pageCount: number | null = null
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
      `[ingest] getPdfPageCount failed for "${filename}" (${bytes.byteLength} bytes):`,
      err
    )
    Sentry.captureException(err, {
      tags: { route: 'documents-ingest', phase: 'get_pdf_page_count' },
      extra: { filename, byteLength: bytes.byteLength, fileHash },
    })
    // Security audit 3.3 (M1): the client-declared `pageCount` is no longer
    // trusted as a fallback -- it is attacker-controlled and would let a PDF that
    // cannot be parsed past the page-limit check below. Reject the upload
    // (and remove the stored file) instead.
    await deleteDocument(storagePath).catch(() => {})
    return NextResponse.json(
      { error: 'This PDF could not be read. It may be damaged or password-protected. Try re-saving it and uploading again.' },
      { status: 422 }
    )
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
  // against, and the unparseable-PDF rejection above already handles that
  // case; this must not invent a second, contradictory failure mode for it.
  if (pageCount !== null) {
    const maxUploadPages = await maxUploadPagesPromise
    if (pageCount > maxUploadPages) {
      // Unlike the checks above, the file is already sitting in storage by
      // this point (the browser PUT it directly before this route ever ran)
      // rather than about to be written — clean it up rather than leaving a
      // rejected upload as permanent storage cruft.
      await deleteDocument(storagePath).catch(() => {})
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

  const entryIdRaw = bodyRecord.entryId
  const entryId =
    (typeof entryIdRaw === 'string' && entryIdRaw.trim() !== '' && Number.isInteger(Number(entryIdRaw))) ||
    (typeof entryIdRaw === 'number' && Number.isInteger(entryIdRaw))
      ? Number(entryIdRaw)
      : null

  // Security audit 3.3 (M1): the entry link below is written through the
  // service-role client, which has no RLS backstop, so the caller must prove --
  // through the SESSION client -- that they may link to this entry: admin-or-above
  // (matching private.assert_entry_bill_link_allowed), the entry visible to them
  // under RLS, and in the SAME event as this document. Done before any row is
  // written; the already-uploaded file is removed on refusal.
  if (entryId !== null) {
    const entryScope = isAdminOrAbove(staff.role)
      ? await assertEntryVisible(entryId, { eventId })
      : null
    if (!entryScope || !entryScope.ok) {
      await deleteDocument(storagePath).catch(() => {})
      return NextResponse.json(
        { error: 'You can\'t attach this upload to that entry. Pick an entry from the current event that you have access to.' },
        { status: 403 }
      )
    }
  }

  // Optional multi-assignee list (document-assignment feature, 2026-08-29): a
  // comma-separated list of staff uuids. Parsed here; validated and written
  // only after the source_document row exists (below), so an absent/empty
  // value is a no-op that leaves current behaviour untouched.
  const assignedToRaw = bodyRecord.assignedTo
  // Security audit 3.3 (M1): assignment is an admin action (set_source_document_assignees
  // is admin-gated in the database); for anyone else the field is ignored.
  const assignedToIds =
    typeof assignedToRaw === 'string' && isAdminOrAbove(staff.role)
      ? Array.from(
          new Set(
            assignedToRaw
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '')
          )
        )
      : []

  // §8 point 2: a hash collision is a SOFT warning. The same bill legitimately
  // gets re-scanned, so the upload proceeds and an exception row is raised for
  // a human to look at.
  const { data: priorDocs } = await admin
    .from('source_document')
    .select('id')
    .eq('file_hash_sha256', fileHash)
    .order('id', { ascending: true })

  const duplicateOf: number | null = priorDocs?.[0]?.id ?? null

  // storagePath already points at the bytes just downloaded and validated
  // above — the browser PUT them there directly via the signed URL from
  // /api/documents/upload-url before this route ever ran.
  const { data: inserted, error: insertError } = await admin
    .from('source_document')
    .insert({
      storage_path: storagePath,
      original_filename: safeFilename(filename),
      file_hash_sha256: fileHash,
      mime_type: 'application/pdf',
      page_count: pageCount,
      upload_status: 'uploaded',
      // match_status is derived by private.sync_source_document_match_status
      // (Phase 4): the placeholder entry_bill_link insert below flips it to
      // 'matched' when this upload attaches straight to an entry.
      uploaded_by: staff.userId,
      event_id: eventId,
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    logRawError('ingest source_document insert', insertError?.message ?? 'no row returned')
    return NextResponse.json(
      { error: 'We couldn’t save this upload. Please try again.' },
      { status: 500 }
    )
  }

  const documentId = inserted.id as number
  // The path now belongs to a source_document; the ledger row has done its job.
  await clearPendingUpload(storagePath)

  // entry-bill links (Phase 3): when the upload attaches straight to an entry,
  // extraction has not run yet so there are no bills to link. Write a
  // placeholder entry_bill_link row (document_extraction_id null) that the
  // extract handler promotes to per-bill rows once the bills exist. This insert
  // also fires the match_status trigger, flipping the doc to 'matched'.
  if (entryId !== null) {
    const { error: linkError } = await admin.from('entry_bill_link').insert({
      entry_id: entryId,
      source_document_id: documentId,
      document_extraction_id: null,
    })
    if (linkError) {
      console.error(`[ingest] entry_bill_link placeholder insert failed for document ${documentId}:`, linkError.message)
    }
  }

  // Document-assignment (2026-08-29): if the upload named one or more
  // assignees, validate each is an active admin/superadmin and write the
  // `source_document_assignee` rows. Best-effort by design -- the
  // `source_document` row already exists and its extraction is already
  // queued, so a failure here is logged (console + Sentry, like the
  // page-count path above) but must NOT fail the upload. The service-role
  // `admin` client is deliberate: the same reason the rest of this route
  // uses it (no session, and the assignee table's RLS is a
  // read-visibility gate, not a writer one).
  if (assignedToIds.length > 0) {
    try {
      const { data: validStaff, error: staffError } = await admin
        .from('staff_profile')
        .select('id')
        .in('id', assignedToIds)
        .eq('is_active', true)
        .in('role', ['admin', 'superadmin'])
      if (staffError) throw staffError

      const validIds = (validStaff ?? []).map((s) => s.id as string)
      if (validIds.length > 0) {
        const { error: assigneeError } = await admin.from('source_document_assignee').insert(
          validIds.map((staff_id) => ({
            source_document_id: documentId,
            staff_id,
            assigned_by: staff.userId,
          }))
        )
        if (assigneeError) throw assigneeError
      }
    } catch (err) {
      console.error(
        `[ingest] failed to assign source_document ${documentId} to [${assignedToIds.join(', ')}]:`,
        err
      )
      Sentry.captureException(err, {
        tags: { route: 'documents-ingest', phase: 'write_assignees' },
        extra: { documentId, assignedToIds },
      })
    }
  }

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
      logRawError('ingest document_page insert', pageError.message)
      return NextResponse.json(
        { error: 'We couldn’t save this upload’s pages. Please try again.' },
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

  const { data: insertedJob, error: jobError } = await admin
    .from('job_queue')
    .insert({
      job_type: 'extract_document',
      payload: { source_document_id: documentId },
    })
    .select('id')
    .single()
  if (jobError || !insertedJob) {
    logRawError('ingest job_queue insert', jobError?.message ?? 'no row returned')
    return NextResponse.json(
      { error: 'The upload was saved but couldn’t be queued for reading. Please try again.', documentId },
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
    // Extraction runs out-of-process: worker/index.ts as a GitHub Actions job
    // (.github/workflows/worker.yml), which — unlike this route on Vercel
    // Hobby — has no ~10s wall-clock kill. Nudge that workflow to start now
    // rather than waiting for its scheduled safety-net run. Best-effort: the
    // job is already queued, and a failed/absent dispatch just means the
    // scheduled run picks it up later. See docs/job-worker-github-actions.md.
    const trigger = await triggerRemoteWorker(`extract_document for source_document ${documentId}`)
    console.log(
      `[ingest] document ${documentId}: extract job ${insertedJob.id} left for the worker ` +
        `(INGEST_INLINE_EXTRACTION=false; remote-worker trigger: ${trigger})`
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
