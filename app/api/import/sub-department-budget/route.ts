import { NextResponse, type NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { runSubDepartmentBudgetImport } from '@/lib/import/run-sub-department-budget-import'
import { withApiLogging } from '@/lib/api-log'
import { isAdminOrAbove } from '@/lib/auth/roles'

export const runtime = 'nodejs'
// A sub-department-budget sheet is three columns, one row per sub-department
// (a small, curated list — dozens to a couple hundred rows at most, not the
// thousands an entries import can carry), so this stays well under the
// ingest route's default budget. Matches app/api/import/department-budget/
// route.ts's reasoning at the same scale.
export const maxDuration = 60

/**
 * Sub-department-budget import endpoint (sub-department feature plan,
 * "Budget import pipeline" section). Mirrors
 * app/api/import/department-budget/route.ts's auth/transport shape exactly
 * (admin-only for both dry-run and commit, direct `pg` connection for the
 * real transaction/rollback semantics dry-run needs) but hands off to the
 * three-column lib/import/run-sub-department-budget-import.ts pipeline
 * instead.
 *
 * No real sub-department-budget spreadsheet exists yet — this route is the
 * pipeline's front door, exercised and ready for the day the user hands over
 * the file.
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

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file".' }, { status: 400 })
  }
  if (mode !== 'dry_run' && mode !== 'commit') {
    return NextResponse.json({ error: '"mode" must be "dry_run" or "commit".' }, { status: 400 })
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
    const result = await runSubDepartmentBudgetImport({
      workbook,
      filename: file.name,
      fileHashSha256,
      mode,
      importedBy: user.id,
    })

    return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Import failed: ${message}` }, { status: 500 })
  }
}

export const POST = withApiLogging('/api/import/sub-department-budget', handlePOST)
