/**
 * Department-budget import (review-page-redesign plan §11, 2026-08-22).
 *
 * A separate, much smaller sibling of lib/import/run-import.ts's Departmental
 * entries import — same discipline (xlsx, one real `pg` transaction, a
 * `dry_run` mode that computes a summary then ROLLBACKs, one `import_batch`
 * row per run, one `import_row_log` row per source row), but for a two-column
 * sheet (department name, budget amount) instead of the full entries export.
 *
 * This is NOT a rollup of the existing per-budget_head allocation system
 * (budget_head / budget_allocation / v_budget_vs_actual) — it feeds a
 * separate table, public.department_budget_allocation, scored per department
 * instead of per budget_head. See the plan doc §11 and the migration's own
 * header comment for why the two systems are kept apart.
 *
 * Department resolution is deliberately NOT auto-create, unlike budget_head/
 * vendor in run-import.ts: departments are a small, known, curated list
 * (public.department, seeded + occasionally hand-maintained), so an unmatched
 * name is a row-level error surfaced in the dry-run preview, never a silent
 * insert of a new department row.
 *
 * No real department-budget spreadsheet has been provided yet (as of
 * 2026-08-22) — this module builds and exercises the pipeline; running it for
 * real happens once the user hands over the file. Column header names below
 * are therefore best-effort guesses (a handful of common synonyms), matched
 * case/whitespace-insensitively — same idiom as
 * components/import/row-log-table.tsx's `pickCell` for the entries importer,
 * which faced the same "don't know the exact source headers yet" problem.
 */

import * as XLSX from 'xlsx'
import { getPool, resolveMutableEventId, writeRowLog, type ImportRowLogEntry } from '@/lib/import/run-import'
import {
  AMOUNT_KEYS,
  DEPARTMENT_KEYS,
  isTotalRowMarker,
  normalizeDepartmentName,
  parseAmount,
  pickField,
} from '@/lib/import/department-budget-parsing'

export interface DepartmentBudgetImportParams {
  /** Already-parsed workbook, e.g. `XLSX.read(buffer)`. */
  workbook: XLSX.WorkBook
  /** Sheet to read rows from. Defaults to the workbook's first sheet — no
   *  fixed sheet name is established yet since no real file exists. */
  sheetName?: string
  filename: string
  fileHashSha256: string
  mode: 'dry_run' | 'commit'
  /** staff_profile.id of the admin running the import, or null. */
  importedBy: string | null
}

export interface DepartmentBudgetImportResult {
  batchId: number
  mode: 'dry_run' | 'commit'
  status: 'completed' | 'completed_with_exceptions' | 'failed'
  rowCount: number
  summary: Record<string, number>
  rowLog: ImportRowLogEntry[]
  errorMessage?: string
}

export async function runDepartmentBudgetImport(
  params: DepartmentBudgetImportParams
): Promise<DepartmentBudgetImportResult> {
  const sheetName = params.sheetName ?? params.workbook.SheetNames[0]
  const sheet = sheetName ? params.workbook.Sheets[sheetName] : undefined
  if (!sheet) {
    throw new Error(`runDepartmentBudgetImport: sheet "${sheetName ?? '(none)'}" not found in workbook.`)
  }
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: '',
  })

  const client = await getPool().connect()

  // Same early-exit-before-any-write shape as run-import.ts's runImport --
  // see resolveMutableEventId's own header comment.
  let eventId: number
  try {
    eventId = await resolveMutableEventId(client)
  } catch (err) {
    client.release()
    throw err
  }

  const rowLog: ImportRowLogEntry[] = []
  const departmentIdsSeenThisBatch = new Map<number, string>() // id -> the raw name that resolved to it, for a friendlier duplicate message

  try {
    await client.query('BEGIN')

    const batchInsert = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, sheet_name, mode, imported_by, event_id, status)
       values ('department_budget', $1, $2, $3, $4, $5, $6, 'processing')
       returning id`,
      [params.filename, params.fileHashSha256, sheetName, params.mode, params.importedBy, eventId]
    )
    const batchId = batchInsert.rows[0]!.id

    // Departments are a small, curated list (§11) — load them all once rather
    // than one query per row. Keyed by the same normalized form department
    // names are matched against, so a collision here would mean two
    // department rows are indistinguishable under case/whitespace alone
    // (shouldn't happen given department.name's own unique constraint, but if
    // it ever does, the later one simply wins the lookup — documented, not
    // silently wrong).
    const deptRows = await client.query<{ id: number; name: string }>(
      'select id, name from public.department'
    )
    const departmentByNormalizedName = new Map<string, { id: number; name: string }>()
    for (const d of deptRows.rows) {
      departmentByNormalizedName.set(normalizeDepartmentName(d.name), d)
    }

    for (let i = 0; i < rawRows.length; i++) {
      const rowNumber = i + 1
      const rawRow = rawRows[i]!

      try {
        const departmentRaw = pickField(rawRow, DEPARTMENT_KEYS)
        const amountRaw = pickField(rawRow, AMOUNT_KEYS)

        // Blank row (no department name at all) — a stray separator or a
        // repeated header row partway through the sheet. Reusing
        // 'skipped_header' rather than inventing a new action value, per
        // §11's "reuse action values ... where they fit".
        if (!departmentRaw) {
          const logEntry: ImportRowLogEntry = {
            rowNumber,
            rawRow,
            action: 'skipped_header',
            entryId: null,
            fieldsChanged: null,
          }
          rowLog.push(logEntry)
          await writeRowLog(client, batchId, logEntry)
          continue
        }

        if (isTotalRowMarker(departmentRaw)) {
          const logEntry: ImportRowLogEntry = {
            rowNumber,
            rawRow,
            action: 'skipped_total',
            entryId: null,
            fieldsChanged: null,
          }
          rowLog.push(logEntry)
          await writeRowLog(client, batchId, logEntry)
          continue
        }

        const matched = departmentByNormalizedName.get(normalizeDepartmentName(departmentRaw))
        if (!matched) {
          const logEntry: ImportRowLogEntry = {
            rowNumber,
            rawRow,
            action: 'error',
            entryId: null,
            fieldsChanged: null,
            note: `"${departmentRaw}" does not match any known department. Departments are not auto-created — add it to public.department first, or fix the spelling in the sheet.`,
          }
          rowLog.push(logEntry)
          await writeRowLog(client, batchId, logEntry)
          continue
        }

        if (departmentIdsSeenThisBatch.has(matched.id)) {
          const logEntry: ImportRowLogEntry = {
            rowNumber,
            rawRow,
            action: 'error',
            entryId: null,
            fieldsChanged: null,
            note: `"${matched.name}" appears more than once in this sheet — only the first row was recorded (one row per department per import).`,
          }
          rowLog.push(logEntry)
          await writeRowLog(client, batchId, logEntry)
          continue
        }

        const budgetAmount = amountRaw ? parseAmount(amountRaw) : null
        if (budgetAmount !== null && Number.isNaN(budgetAmount)) {
          const logEntry: ImportRowLogEntry = {
            rowNumber,
            rawRow,
            action: 'error',
            entryId: null,
            fieldsChanged: null,
            note: `"${amountRaw}" is not a valid budget amount for "${matched.name}".`,
          }
          rowLog.push(logEntry)
          await writeRowLog(client, batchId, logEntry)
          continue
        }

        await client.query(
          `insert into public.department_budget_allocation
             (department_id, import_batch_id, event_id, as_of, budget_amount)
           values ($1, $2, $3, current_date, $4)`,
          [matched.id, batchId, eventId, budgetAmount]
        )
        departmentIdsSeenThisBatch.set(matched.id, matched.name)

        // Always 'inserted': department_budget_allocation is an append-only
        // snapshot table (same as budget_allocation) — every row written this
        // batch is by definition new, never an update to a prior row.
        const logEntry: ImportRowLogEntry = {
          rowNumber,
          rawRow,
          action: 'inserted',
          entryId: null,
          fieldsChanged: null,
        }
        rowLog.push(logEntry)
        await writeRowLog(client, batchId, logEntry)
      } catch (rowError) {
        const message = rowError instanceof Error ? rowError.message : String(rowError)
        const logEntry: ImportRowLogEntry = {
          rowNumber,
          rawRow,
          action: 'error',
          entryId: null,
          fieldsChanged: null,
          note: message,
        }
        rowLog.push(logEntry)
        await writeRowLog(client, batchId, logEntry)
      }
    }

    const summary: Record<string, number> = {}
    for (const entry of rowLog) {
      summary[entry.action] = (summary[entry.action] ?? 0) + 1
    }
    const status: DepartmentBudgetImportResult['status'] =
      (summary.error ?? 0) > 0 ? 'completed_with_exceptions' : 'completed'

    if (params.mode === 'commit') {
      await client.query(
        `update public.import_batch
            set status = $1, row_count = $2, summary_jsonb = $3, completed_at = now()
          where id = $4`,
        [status, rawRows.length, JSON.stringify(summary), batchId]
      )
      await client.query('COMMIT')

      return { batchId, mode: params.mode, status, rowCount: rawRows.length, summary, rowLog }
    }

    // dry_run: roll back every row-level write (including the batch row and
    // its row log written above), then write ONE fresh batch row outside any
    // transaction with the final computed status/summary — same "leaving
    // only the batch row and its summary" contract as run-import.ts.
    await client.query('ROLLBACK')

    const finalBatch = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, sheet_name, mode, imported_by,
          event_id, status, row_count, summary_jsonb, completed_at)
       values ('department_budget', $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       returning id`,
      [
        params.filename,
        params.fileHashSha256,
        sheetName,
        params.mode,
        params.importedBy,
        eventId,
        status,
        rawRows.length,
        JSON.stringify(summary),
      ]
    )

    return {
      batchId: finalBatch.rows[0]!.id,
      mode: params.mode,
      status,
      rowCount: rawRows.length,
      summary,
      rowLog,
    }
  } catch (fatalError) {
    await client.query('ROLLBACK').catch(() => {
      // The transaction may already be aborted; nothing more to do.
    })
    const message = fatalError instanceof Error ? fatalError.message : String(fatalError)

    const failedBatch = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, mode, imported_by, event_id, status, error_message, completed_at)
       values ('department_budget', $1, $2, $3, $4, $5, 'failed', $6, now())
       returning id`,
      [params.filename, params.fileHashSha256, params.mode, params.importedBy, eventId, message]
    )

    return {
      batchId: failedBatch.rows[0]!.id,
      mode: params.mode,
      status: 'failed',
      rowCount: 0,
      summary: {},
      rowLog,
      errorMessage: message,
    }
  } finally {
    client.release()
  }
}
