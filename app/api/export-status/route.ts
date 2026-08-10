import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, getStaffContext } from '@/lib/export/auth'
import { withApiLogging } from '@/lib/api-log'
import {
  generateStatusExportBatch,
  updateExportBatchStatus,
  getExportBatchDownloadUrl,
  type ExportTargetSystem,
} from '@/lib/export/generate-status-batch'
import { getExportBatchRows } from '@/lib/export/queries'

/**
 * The outward path's HTTP surface (MASTER-PLAN §3.7, §11.1 Day 5).
 *
 *   POST  { targetSystem }                    -> generate a batch (admin-only)
 *   PATCH { batchId, status, note? }           -> delivered/acknowledged (admin-only)
 *   GET   ?batchId=<id>                        -> per-row detail (any active staff —
 *                                                  matches status_export_row's RLS
 *                                                  select policy, is_staff())
 *   GET   ?batchId=<id>&download=1             -> a short-lived signed download URL
 *                                                  (§4.3: never a raw storage path)
 *
 * Generation and status transitions both write through the admin (service-role)
 * client inside lib/export/generate-status-batch.ts, which bypasses RLS by
 * design (§4.5) — the admin-role check below is the only gate standing in
 * front of that, so it runs first, unconditionally, before either handler
 * touches anything else.
 */

const VALID_TARGET_SYSTEMS: ExportTargetSystem[] = ['departmental', 'audit', 'both']

async function handlePOST(request: NextRequest) {
  const gate = await requireAdmin()
  if (!gate.ok) {
    return NextResponse.json({ error: adminGateMessage(gate.reason) }, { status: gate.reason === 'signed_out' ? 401 : 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const targetSystem = (body as { targetSystem?: unknown })?.targetSystem
  if (typeof targetSystem !== 'string' || !VALID_TARGET_SYSTEMS.includes(targetSystem as ExportTargetSystem)) {
    return NextResponse.json(
      { error: `targetSystem must be one of: ${VALID_TARGET_SYSTEMS.join(', ')}` },
      { status: 400 }
    )
  }

  const result = await generateStatusExportBatch({
    targetSystem: targetSystem as ExportTargetSystem,
    generatedBy: gate.staff.userId,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }
  if (result.batch === null) {
    return NextResponse.json({ ok: true, batch: null, message: 'Nothing is pending export.' })
  }
  return NextResponse.json({ ok: true, batch: result.batch })
}

async function handlePATCH(request: NextRequest) {
  const gate = await requireAdmin()
  if (!gate.ok) {
    return NextResponse.json({ error: adminGateMessage(gate.reason) }, { status: gate.reason === 'signed_out' ? 401 : 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const { batchId, status, note } = (body as { batchId?: unknown; status?: unknown; note?: unknown }) ?? {}
  if (typeof batchId !== 'number' || !Number.isInteger(batchId)) {
    return NextResponse.json({ error: 'batchId must be an integer.' }, { status: 400 })
  }
  if (status !== 'delivered' && status !== 'acknowledged') {
    return NextResponse.json({ error: 'status must be "delivered" or "acknowledged".' }, { status: 400 })
  }

  const result = await updateExportBatchStatus({
    batchId,
    status,
    note: typeof note === 'string' ? note : undefined,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}

async function handleGET(request: NextRequest) {
  const staff = await getStaffContext()
  if (!staff || !staff.isActive) {
    return NextResponse.json({ error: 'Sign in as an active staff member to view export detail.' }, { status: 401 })
  }

  const batchIdParam = request.nextUrl.searchParams.get('batchId')
  if (!batchIdParam) {
    return NextResponse.json({ error: 'batchId query parameter is required.' }, { status: 400 })
  }
  const batchId = Number(batchIdParam)
  if (!Number.isInteger(batchId)) {
    return NextResponse.json({ error: 'batchId must be an integer.' }, { status: 400 })
  }

  if (request.nextUrl.searchParams.get('download') === '1') {
    const result = await getExportBatchDownloadUrl(batchId)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 404 })
    }
    return NextResponse.json({ url: result.url })
  }

  try {
    const rows = await getExportBatchRows(batchId)
    return NextResponse.json({ rows })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export const POST = withApiLogging('/api/export-status', handlePOST)
export const PATCH = withApiLogging('/api/export-status', handlePATCH)
export const GET = withApiLogging('/api/export-status', handleGET)

function adminGateMessage(reason: 'signed_out' | 'inactive' | 'not_admin'): string {
  switch (reason) {
    case 'signed_out':
      return 'You must be signed in.'
    case 'inactive':
      return 'Your account is pending activation.'
    case 'not_admin':
      return 'Generating and delivering status exports is an admin-only action.'
  }
}
