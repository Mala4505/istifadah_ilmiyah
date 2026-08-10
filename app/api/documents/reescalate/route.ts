import { NextRequest, NextResponse } from 'next/server'
import { withApiLogging } from '@/lib/api-log'
import { getStaffContext } from '@/lib/export/auth'
import { extractAndPersist } from '@/lib/jobs/handlers/extract'
import { MODELS } from '@/lib/claude-client'

/**
 * `documents-reescalate` — the manual "re-run with Sonnet" button
 * (MASTER-PLAN §8 point 7).
 *
 * POST { documentId: number }
 *
 * Staff press this when Haiku clearly struggled. It always creates a NEW
 * `ocr_extraction_run` with `run_reason = 'manual_reescalation'`; prior runs
 * are never deleted, so the correction log and the cost-per-document view keep
 * the whole history.
 *
 * Runs synchronously rather than via the queue: a reviewer is sitting in front
 * of the review screen waiting for the result, and one Sonnet call on a
 * ~2-page invoice is a couple of seconds. Deliberately no auto-escalation —
 * this already *is* the escalation (§8 point 4: "Do not automatically
 * re-escalate").
 */

export const runtime = 'nodejs'
export const maxDuration = 60

async function handlePOST(request: NextRequest) {
  // Session-bound role check before anything reaches the service-role client (§4.5).
  const staff = await getStaffContext()
  if (!staff) {
    return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })
  }
  if (!staff.isActive) {
    return NextResponse.json({ error: 'Your account is pending activation.' }, { status: 403 })
  }
  if (staff.role === 'viewer') {
    return NextResponse.json(
      { error: 'Re-running extraction is a reviewer or admin action.' },
      { status: 403 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const documentId = (body as { documentId?: unknown })?.documentId
  if (typeof documentId !== 'number' || !Number.isInteger(documentId) || documentId <= 0) {
    return NextResponse.json({ error: 'documentId must be a positive integer.' }, { status: 400 })
  }

  try {
    const result = await extractAndPersist({
      sourceDocumentId: documentId,
      runReason: 'manual_reescalation',
      model: MODELS.sonnet,
      triggeredBy: staff.userId,
    })

    return NextResponse.json({
      ok: true,
      documentId: result.sourceDocumentId,
      runId: result.currentRunId,
      model: result.modelUsed,
      lineItemCount: result.lineItemCount,
      pageCount: result.pageCount,
      costUsd: result.totalCostUsd,
      exceptionsRaised: result.exceptionsRaised,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const notFound = message.includes('not found')
    return NextResponse.json({ error: message }, { status: notFound ? 404 : 500 })
  }
}

export const POST = withApiLogging('/api/documents/reescalate', handlePOST)
