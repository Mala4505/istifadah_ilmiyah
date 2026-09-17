import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { withApiLogging } from '@/lib/api-log'
import { getStaffContext } from '@/lib/export/auth'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'
import { createUploadUrl } from '@/lib/storage'

/**
 * Step 1 of the two-step upload (MASTER-PLAN §8, §3.8): hands the browser a
 * one-time signed URL to PUT a PDF's bytes straight to Supabase Storage,
 * bypassing this app's own Vercel function for the file body entirely.
 *
 * Why this exists: `/api/documents/ingest` used to receive the raw PDF as
 * multipart form data. That worked locally but hit Vercel's own platform
 * ceiling in production — a Serverless Function's request body is hard-capped
 * at 4.5MB regardless of any limit this app enforces itself — so a
 * phone-photographed PDF of even a handful of pages (each a full-resolution
 * JPEG) reliably got rejected with a 413 the ingest route's code never even
 * ran to see. A PUT straight to storage isn't a Vercel function invocation at
 * all, so it isn't subject to that cap.
 *
 * This route's own request/response bodies stay tiny (a filename in, a path
 * + signed URL out) — the large part of the exchange happens directly
 * between the browser and Supabase afterward. The browser then calls
 * `/api/documents/ingest` (now a small JSON "finalize" call) once the PUT
 * completes, so that route can download the bytes back out of storage and run
 * its existing hash/page-count/validation logic unchanged.
 */

export const runtime = 'nodejs'

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document.pdf'
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'document.pdf'
}

/** `2026/08/<token12>-<epoch>-<name>.pdf` — unique per upload. A random
 *  token stands in for the old content-hash prefix: the hash isn't knowable
 *  here since the file's bytes never reach this server — only the browser
 *  and Supabase Storage see them until the finalize step downloads them
 *  back for hashing. */
function buildStoragePath(filename: string): string {
  const now = new Date()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const token = randomBytes(6).toString('hex')
  return `${yyyy}/${mm}/${token}-${now.getTime()}-${safeFilename(filename)}`
}

async function handlePOST(request: NextRequest) {
  const staff = await getStaffContext()
  if (!staff) {
    return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })
  }
  if (!staff.isActive) {
    return NextResponse.json({ error: 'Your account is pending activation.' }, { status: 403 })
  }

  // Same event-mutability gate the old single-request ingest route applied
  // before accepting a file (Phase 6 Step 2 §1.6) — checked again in
  // /api/documents/ingest at finalize time too, since the event can change
  // in the window between requesting this URL and the PUT actually landing.
  const selectedEvent = await getSelectedEvent()
  if (!isEventMutable(selectedEvent)) {
    return NextResponse.json(
      { error: 'This event is closed to new uploads. Switch to the current event before uploading.' },
      { status: 409 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }
  const filename =
    body && typeof body === 'object' && 'filename' in body ? String((body as Record<string, unknown>).filename) : ''
  if (!filename.trim() || !filename.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ error: 'Only PDF uploads are supported.' }, { status: 415 })
  }

  const path = buildStoragePath(filename)
  try {
    const signedUrl = await createUploadUrl(path)
    return NextResponse.json({ path, signedUrl })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not prepare upload.' },
      { status: 502 }
    )
  }
}

export const POST = withApiLogging('/api/documents/upload-url', handlePOST)
