import { NextResponse, type NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { runImport } from '@/lib/import/run-import'
import { withApiLogging } from '@/lib/api-log'
import { isAdminOrAbove } from '@/lib/auth/roles'

export const runtime = 'nodejs'

/**
 * Import endpoint (MASTER-PLAN §10, §3.6, §4.4c). Accepts a multipart file
 * upload, parses it with `xlsx`, and hands it to lib/import/run-import.ts.
 *
 * Auth: MASTER-PLAN §4.4c's roles table lists "Run an import (dry-run OR
 * commit)" as admin-only — not just commit. The task brief left dry-run
 * looser as a judgment call; this route follows §4.4c's stricter, spec-
 * written rule instead, since nothing about a dry run needs to be more
 * permissive here (it still touches the live database inside a
 * transaction, even though it rolls back) and consistency with the rest of
 * the app's role model is worth more than the extra convenience.
 *
 * The role check itself is read through the request's SESSION-bound client
 * (@/lib/supabase/server — cookie-scoped, subject to RLS) so an
 * unauthenticated or non-admin caller can never reach the write path. Only
 * once that check passes does the actual import run, which needs to cross
 * department boundaries and therefore uses a direct, secret-keyed Postgres
 * connection (see the transaction-control comment at the top of
 * lib/import/run-import.ts) rather than the session client.
 */
async function handlePOST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const { data: profile, error: profileError } = await supabase
    .from('staff_profile')
    .select('role, is_active')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    return NextResponse.json({ error: 'Could not verify staff role.' }, { status: 500 })
  }
  if (!profile || !profile.is_active || !isAdminOrAbove(profile.role)) {
    return NextResponse.json(
      { error: 'Only an active admin may run an import.' },
      { status: 403 }
    )
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data.' }, { status: 400 })
  }

  const file = formData.get('file')
  const mode = formData.get('mode')
  const sourceSystemField = formData.get('source_system')

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file".' }, { status: 400 })
  }
  if (mode !== 'dry_run' && mode !== 'commit') {
    return NextResponse.json({ error: '"mode" must be "dry_run" or "commit".' }, { status: 400 })
  }
  // Param exists per MASTER-PLAN §3.6 for the day Audit-side import is wired;
  // hardcoded to 'departmental' today — Audit parsing is cut (§12).
  const sourceSystem = sourceSystemField === 'audit' ? 'audit' : 'departmental'
  if (sourceSystem !== 'departmental') {
    return NextResponse.json(
      { error: 'Importing the Audit side by file isn’t available yet — use the Portal Reader instead.' },
      { status: 400 }
    )
  }

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const fileHashSha256 = createHash('sha256').update(buffer).digest('hex')

  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    return NextResponse.json(
      { error: 'Could not parse the uploaded file as an Excel workbook.' },
      { status: 400 }
    )
  }

  try {
    const result = await runImport({
      workbook,
      filename: file.name,
      fileHashSha256,
      mode,
      sourceSystem,
      importedBy: user.id,
    })

    return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Import failed: ${message}` }, { status: 500 })
  }
}

/**
 * GET /api/import — batch history, or one batch's row log via ?batchId=.
 * Read-only, so this stays on the session-bound client and relies on
 * import_batch/import_row_log's staff-wide RLS select policies rather than
 * reaching for the admin client at all.
 */
async function handleGET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const batchIdParam = request.nextUrl.searchParams.get('batchId')

  if (batchIdParam) {
    const batchId = Number(batchIdParam)
    if (!Number.isFinite(batchId)) {
      return NextResponse.json({ error: 'Invalid batchId.' }, { status: 400 })
    }

    const [{ data: batch, error: batchError }, { data: rows, error: rowsError }] = await Promise.all([
      supabase.from('import_batch').select('*').eq('id', batchId).maybeSingle(),
      supabase
        .from('import_row_log')
        .select('*')
        .eq('import_batch_id', batchId)
        .order('row_number', { ascending: true }),
    ])

    if (batchError || rowsError) {
      return NextResponse.json({ error: 'Could not load batch detail.' }, { status: 500 })
    }
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found.' }, { status: 404 })
    }

    return NextResponse.json({ batch, rows: rows ?? [] })
  }

  // Dry runs never keep their per-row detail (see lib/import/run-import.ts's
  // rollback comment) — showing them here would just be an entry that always
  // opens to "No rows to show." History is for what actually happened.
  const { data: batches, error } = await supabase
    .from('import_batch')
    .select('*')
    .eq('mode', 'commit')
    .order('started_at', { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ error: 'Could not load import batch history.' }, { status: 500 })
  }

  return NextResponse.json({ batches: batches ?? [] })
}

export const POST = withApiLogging('/api/import', handlePOST)
export const GET = withApiLogging('/api/import', handleGET)
