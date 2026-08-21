import { NextRequest, NextResponse } from 'next/server'
import { withApiLogging } from '@/lib/api-log'
import { getStaffContext } from '@/lib/export/auth'
import { createClient } from '@/lib/supabase/server'

/**
 * `documents-status` (checklist 2.5 / plan §5, D6).
 *
 * GET ?ids=1,2,3
 *
 * A narrow, cheap, read-only poll target for the document inbox. Exists so
 * `document-inbox.tsx` no longer has to call `router.refresh()` on a timer
 * to find out whether a pending document has moved stage — that re-runs the
 * whole `/documents` RSC tree (six queries, including a 5,000-row `entries`
 * fetch, plus `rankCandidates` per bill) every tick, whether or not anything
 * changed. This route answers the one question the poll actually needs
 * ("did anything change for these ids?") with two indexed `.in()` lookups
 * and nothing else — no entries join, no candidate ranking, no department
 * names.
 *
 * Auth: same staff-session gate as the rest of `/documents` — any active
 * staff can view (`source_document` is visible to all active staff by
 * design; see the header comment on `app/(app)/documents/page.tsx`). No
 * further role gate: this endpoint only reads two narrow columns per row.
 *
 * Deliberately uses the session-bound client (`@/lib/supabase/server`), not
 * the admin client — RLS already allows staff to read these rows, and this
 * is exactly the kind of narrow read that should stay inside RLS rather
 * than reach for the service-role bypass.
 */

async function handleGET(request: NextRequest) {
  const staff = await getStaffContext()
  if (!staff) {
    return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })
  }

  const idsParam = request.nextUrl.searchParams.get('ids') ?? ''
  const ids = idsParam
    .split(',')
    .map((raw) => Number(raw.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)

  if (ids.length === 0) {
    return NextResponse.json({ documents: [] })
  }

  const supabase = await createClient()

  const [{ data: docsData, error: docsError }, { data: extractionsData, error: extractionsError }] =
    await Promise.all([
      supabase.from('source_document').select('id, upload_status').in('id', ids),
      supabase.from('document_extraction').select('source_document_id').in('source_document_id', ids),
    ])

  if (docsError) {
    return NextResponse.json({ error: docsError.message }, { status: 500 })
  }
  if (extractionsError) {
    return NextResponse.json({ error: extractionsError.message }, { status: 500 })
  }

  const hasExtractionIds = new Set((extractionsData ?? []).map((row) => row.source_document_id as number))

  const documents = (docsData ?? []).map((doc) => ({
    id: doc.id as number,
    uploadStatus: doc.upload_status as 'uploaded' | 'processing' | 'processed' | 'failed',
    hasExtraction: hasExtractionIds.has(doc.id as number),
  }))

  return NextResponse.json({ documents })
}

export const GET = withApiLogging('/api/documents/status', handleGET)
