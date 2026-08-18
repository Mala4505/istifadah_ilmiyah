import { NextRequest, NextResponse } from 'next/server'
import { withApiLogging } from '@/lib/api-log'
import { getStaffContext } from '@/lib/export/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { putDocument } from '@/lib/storage'
import { getPdfPageCount, looksLikePdf, sha256Hex } from '@/lib/pdf'

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
 * `extract_document` job. Returns the new document id.
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
      { error: `File is ${file.size} bytes; the limit is ${MAX_UPLOAD_BYTES}.` },
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
  } catch {
    const declared = Number(form.get('pageCount'))
    pageCount = Number.isInteger(declared) && declared > 0 ? declared : null
    // Neither the server-side parse nor a client-declared count worked. No
    // document_page rows get created below, and page_count stays null until
    // (if ever) extraction succeeds and backfills it from the model's own
    // pages[] count (lib/jobs/handlers/extract.ts) — silently, unless this is
    // flagged now (I1).
    pageCountUnresolved = pageCount === null
  }

  const entryIdRaw = form.get('entryId')
  const entryId =
    typeof entryIdRaw === 'string' && entryIdRaw.trim() !== '' && Number.isInteger(Number(entryIdRaw))
      ? Number(entryIdRaw)
      : null

  const admin = createAdminClient()

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

  const { error: jobError } = await admin.from('job_queue').insert({
    job_type: 'extract_document',
    payload: { source_document_id: documentId },
  })
  if (jobError) {
    return NextResponse.json(
      { error: `job_queue insert failed: ${jobError.message}`, documentId },
      { status: 500 }
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
  })
}

export const POST = withApiLogging('/api/documents/ingest', handlePOST)
