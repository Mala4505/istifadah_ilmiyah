/**
 * Import orchestration (MASTER-PLAN §3.6, day 2). Given a parsed workbook,
 * this drives one Departmental import end to end: batch bookkeeping,
 * budget_head / vendor / entry_status resolution, the entries upsert with
 * Hub-owned columns excluded, the two post-batch assertions, and the
 * dry-run/commit transaction semantics.
 *
 * ---------------------------------------------------------------------------
 * TRANSACTION-CONTROL CHOICE (documented per the task brief, which flags
 * this as an open decision):
 *
 * supabase-js talks to PostgREST over HTTP — one statement per request, no
 * multi-statement transaction, no ROLLBACK. A dry-run that "parses,
 * resolves, and writes import_row_log inside a transaction that is then
 * rolled back" (§3.6) cannot be built on top of it. The brief offers three
 * options: a plpgsql function that does the whole import in SQL, a plpgsql
 * function called per row inside a transaction opened over `pg`/`postgres.js`,
 * or the whole orchestration in TypeScript against a direct connection. This
 * file takes the third: a single `pg` client, one real `BEGIN` per run, all
 * row-level SQL as plain parameterized statements, `COMMIT` or `ROLLBACK` at
 * the end depending on `mode`. Reasons:
 *   - The row-shape logic (parseDepartmentalRow, normalizeVendorName) is
 *     TypeScript and already correct/tested — reimplementing budget-head
 *     auto-create and vendor resolution in plpgsql would duplicate it in a
 *     second language with its own bugs, on a 7-day deadline.
 *   - `DATABASE_URL` already exists in lib/env.ts (§2 lists it as
 *     migrations/seed/pg_dump-only, but a real client-controlled transaction
 *     is exactly the case dry-run needs and PostgREST cannot give).
 *   - The env's DATABASE_URL point at the *session* pooler (port 5432, not
 *     the 6543 transaction pooler), which supports ordinary multi-statement
 *     transactions and prepared statements — `pg`'s default mode works
 *     unmodified.
 *
 * The `import_batch` row itself is written OUTSIDE the rolled-back
 * transaction on purpose: §3.6 says a dry run should leave "only the batch
 * row and its summary" behind. So a dry run opens a transaction, does all
 * the row-level work (so the two post-batch assertions can query
 * consistent, uncommitted state), computes the summary, rolls everything
 * back, and only then inserts the single surviving `import_batch` row with
 * the final status/summary already known. A commit does the row-level work
 * and the batch insert in the same transaction and commits it all together.
 * ---------------------------------------------------------------------------
 */

import { Pool, types, type PoolClient } from 'pg'
import * as XLSX from 'xlsx'
import { serverEnv } from '@/lib/env.server'
import { normalizeVendorName } from '@/lib/normalize'
import {
  INITIAL_DEPARTMENTAL_CONTEXT,
  parseDepartmentalRow,
  type DepartmentalRowContext,
} from '@/lib/module-mapping'
import { checkAllocationSumMismatches, checkNamespaceCollisions, parseBudgetHeadShortLabel } from '@/lib/import/assertions'

// Re-exported so existing callers/imports of these three functions can keep
// using `@/lib/import/run-import` — the actual implementations and their
// unit tests live in lib/import/assertions.ts (kept dependency-free of
// `pg`/`@/lib/env` on purpose; see that file's header comment).
export { checkAllocationSumMismatches, checkNamespaceCollisions, parseBudgetHeadShortLabel }
export type { AllocationSumMismatch } from '@/lib/import/assertions'

// ---------------------------------------------------------------------------
// pg connection
// ---------------------------------------------------------------------------

// pg's default type parser turns a Postgres `date` (OID 1082, no time zone
// at all) into a JS `Date` constructed in the SERVER PROCESS's local time
// zone. Comparing that against the "YYYY-MM-DD" string this file writes
// (parseDdMmYyyy's output) by round-tripping through `.toISOString()`
// shifts the calendar day on any machine not at UTC+0 — on a UTC+5:30 box
// (India), "2026-07-26" comes back as `Date` -> `.toISOString()` ->
// "2026-07-25T18:30:00.000Z", which silently fails a same-value comparison
// and made every entries.date field report 'updated' on every re-import
// (found and fixed while doing the day-2 idempotency verification — see
// the task report). Fixed at the root: tell `pg` to hand back `date`
// columns as the raw "YYYY-MM-DD" string Postgres already sends over the
// wire, so no time zone is ever introduced. Registered once, globally, on
// module load (types.setTypeParser mutates a process-wide table).
types.setTypeParser(1082 /* date */, (value: string) => value)

let pool: Pool | null = null

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: serverEnv.DATABASE_URL, max: 5 })
  }
  return pool
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImportRowAction =
  | 'inserted'
  | 'updated'
  | 'unchanged'
  | 'skipped_header'
  | 'skipped_total'
  | 'skipped_no_ubbl'
  | 'new_budget_head'
  | 'new_vendor'
  | 'error'

export interface ImportRowLogEntry {
  rowNumber: number
  rawRow: Record<string, unknown>
  action: ImportRowAction
  entryId: number | null
  fieldsChanged: Record<string, { from: unknown; to: unknown }> | null
  note?: string
}

export interface ImportExceptionSummary {
  exceptionType: string
  severity: 'low' | 'medium' | 'high'
  description: string
}

export interface RunImportParams {
  /** Already-parsed workbook, e.g. `XLSX.read(buffer)`. */
  workbook: XLSX.WorkBook
  /** Sheet to read Departmental rows from. */
  sheetName?: string
  filename: string
  fileHashSha256: string
  mode: 'dry_run' | 'commit'
  sourceSystem: 'departmental' | 'audit'
  /** staff_profile.id of the admin running the import, or null (e.g. CLI/manual verification). */
  importedBy: string | null
}

export interface ImportResult {
  batchId: number
  mode: 'dry_run' | 'commit'
  status: 'completed' | 'completed_with_exceptions' | 'failed'
  rowCount: number
  summary: Record<string, number>
  rowLog: ImportRowLogEntry[]
  exceptions: ImportExceptionSummary[]
  errorMessage?: string
}

const DEFAULT_SHEET_NAME = 'All Budget Entries'

/**
 * MASTER-PLAN §3.6's money/quantity columns from DEPARTMENTAL_COLUMNS
 * (lib/module-mapping.ts).
 */
const NUMERIC_COLUMNS = [
  'Request Amount',
  'Approved Amount',
  'Utilised Amount',
  'Balance',
  'Invoice Amount',
] as const

/**
 * `XLSX.utils.sheet_to_json(sheet, { raw: false })` — the mode
 * test/unit/import-fixture.test.ts itself uses to establish the 14/10
 * ground truth, and the only mode that reads Invoice Date as a clean
 * "DD-MM-YYYY" string instead of an Excel serial number — formats numeric
 * cells with thousands separators, e.g. `"12,500.00"`. lib/module-mapping.ts's
 * `toNumberOrNull` calls plain `Number(value)` on that string, which is
 * `NaN` (`Number("12,500.00")` !== a number), so every money field would
 * silently come through as null — invoice amounts, allocation totals, all
 * of it. module-mapping.ts is out of bounds to edit (task boundary), so the
 * fix lives here instead: strip thousands separators from the known
 * numeric columns on a COPY of the row before handing it to
 * parseDepartmentalRow. The row actually written to
 * import_row_log.raw_row_jsonb is still the untouched original, so the
 * audit trail matches the source file byte-for-byte.
 */
function sanitizeNumericColumns(rawRow: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...rawRow }
  for (const col of NUMERIC_COLUMNS) {
    const value = sanitized[col]
    if (typeof value === 'string' && value.includes(',')) {
      sanitized[col] = value.replace(/,/g, '')
    }
  }
  return sanitized
}

// ---------------------------------------------------------------------------
// Row-scoped resolver caches (per run, cleared each call to runImport)
// ---------------------------------------------------------------------------

interface ResolverCaches {
  departmentByName: Map<string, number>
  budgetHeadByRawLabel: Map<string, { id: number; departmentId: number | null }>
  vendorByNormalizedName: Map<string, number>
  statusByCode: Map<string, number>
}

function newCaches(): ResolverCaches {
  return {
    departmentByName: new Map(),
    budgetHeadByRawLabel: new Map(),
    vendorByNormalizedName: new Map(),
    statusByCode: new Map(),
  }
}

async function resolveDepartment(
  client: PoolClient,
  caches: ResolverCaches,
  name: string
): Promise<number> {
  const cached = caches.departmentByName.get(name)
  if (cached !== undefined) return cached

  const existing = await client.query<{ id: number }>(
    'select id from public.department where name = $1',
    [name]
  )
  if (existing.rows[0]) {
    caches.departmentByName.set(name, existing.rows[0].id)
    return existing.rows[0].id
  }

  // Not in §3.6's explicit auto-create list (only budget_head and vendor are
  // named there), but §3.1's own comment says departments "arrive via
  // import with zero schema change" — get-or-create here is what makes that
  // true rather than aspirational. Judgment call, documented per the task's
  // point 4.
  const created = await client.query<{ id: number }>(
    'insert into public.department (name) values ($1) returning id',
    [name]
  )
  const id = created.rows[0]!.id
  caches.departmentByName.set(name, id)
  return id
}

async function resolveBudgetHead(
  client: PoolClient,
  caches: ResolverCaches,
  rawLabel: string,
  departmentId: number | null,
  batchId: number
): Promise<{ id: number; created: boolean }> {
  const cached = caches.budgetHeadByRawLabel.get(rawLabel)
  if (cached !== undefined) return { id: cached.id, created: false }

  const existing = await client.query<{ id: number; department_id: number | null }>(
    'select id, department_id from public.budget_head where raw_label = $1',
    [rawLabel]
  )
  if (existing.rows[0]) {
    caches.budgetHeadByRawLabel.set(rawLabel, {
      id: existing.rows[0].id,
      departmentId: existing.rows[0].department_id,
    })
    return { id: existing.rows[0].id, created: false }
  }

  const shortLabel = parseBudgetHeadShortLabel(rawLabel)
  const created = await client.query<{ id: number }>(
    `insert into public.budget_head (department_id, raw_label, short_label, first_seen_batch_id)
     values ($1, $2, $3, $4)
     returning id`,
    [departmentId, rawLabel, shortLabel, batchId]
  )
  const id = created.rows[0]!.id
  caches.budgetHeadByRawLabel.set(rawLabel, { id, departmentId })
  return { id, created: true }
}

async function resolveVendor(
  client: PoolClient,
  caches: ResolverCaches,
  rawName: string
): Promise<{ id: number; created: boolean }> {
  const normalized = normalizeVendorName(rawName)

  const cached = caches.vendorByNormalizedName.get(normalized)
  if (cached !== undefined) return { id: cached, created: false }

  const byNormalized = await client.query<{ id: number }>(
    'select id from public.vendor where normalized_name = $1',
    [normalized]
  )
  if (byNormalized.rows[0]) {
    caches.vendorByNormalizedName.set(normalized, byNormalized.rows[0].id)
    return { id: byNormalized.rows[0].id, created: false }
  }

  const byAlias = await client.query<{ vendor_id: number }>(
    'select vendor_id from public.vendor_alias where raw_name = $1',
    [rawName]
  )
  if (byAlias.rows[0]) {
    caches.vendorByNormalizedName.set(normalized, byAlias.rows[0].vendor_id)
    return { id: byAlias.rows[0].vendor_id, created: false }
  }

  const createdVendor = await client.query<{ id: number }>(
    `insert into public.vendor (display_name, normalized_name, is_confirmed)
     values ($1, $2, false)
     returning id`,
    [rawName, normalized]
  )
  const id = createdVendor.rows[0]!.id
  await client.query(
    `insert into public.vendor_alias (vendor_id, raw_name, source) values ($1, $2, 'import')`,
    [id, rawName]
  )
  caches.vendorByNormalizedName.set(normalized, id)
  return { id, created: true }
}

/**
 * Resolves Status/Main Status text to an entry_status row, auto-inserting
 * unseen codes with sort_order 999 and raising a low-severity exception
 * (§3.3, §3.6 point 7) — written once per newly-seen code per batch, not
 * once per row.
 */
async function resolveStatus(
  client: PoolClient,
  caches: ResolverCaches,
  rawText: string,
  sourceSystem: 'departmental' | 'audit',
  batchId: number,
  exceptionsOut: ImportExceptionSummary[]
): Promise<number> {
  const cached = caches.statusByCode.get(rawText)
  if (cached !== undefined) return cached

  const existing = await client.query<{ id: number }>(
    'select id from public.entry_status where code = $1',
    [rawText]
  )
  if (existing.rows[0]) {
    caches.statusByCode.set(rawText, existing.rows[0].id)
    return existing.rows[0].id
  }

  const created = await client.query<{ id: number }>(
    `insert into public.entry_status (code, label, source_system, sort_order, is_terminal)
     values ($1, $1, $2, 999, false)
     returning id`,
    [rawText, sourceSystem]
  )
  const id = created.rows[0]!.id
  caches.statusByCode.set(rawText, id)

  const description = `Unseen status code "${rawText}" (${sourceSystem}) auto-inserted with sort_order = 999.`
  await client.query(
    `insert into public.reconciliation_exception
       (import_batch_id, exception_type, severity, description, dedup_key)
     values ($1, 'unknown_status_code', 'low', $2, $3)`,
    [batchId, description, `unknown_status_code:${rawText}:${sourceSystem}:${batchId}`]
  )
  exceptionsOut.push({ exceptionType: 'unknown_status_code', severity: 'low', description })

  return id
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export async function runImport(params: RunImportParams): Promise<ImportResult> {
  if (params.sourceSystem !== 'departmental') {
    // Audit-side import mapping is cut from Phase 1A (MASTER-PLAN §12) — the
    // param exists for the day a populated Audit export arrives, but nothing
    // parses it yet.
    throw new Error(
      `runImport: source_system "${params.sourceSystem}" is not implemented (MASTER-PLAN §12 — Audit-side import wiring lands the day a populated Audit export exists).`
    )
  }

  const sheetName = params.sheetName ?? DEFAULT_SHEET_NAME
  const sheet = params.workbook.Sheets[sheetName]
  if (!sheet) {
    throw new Error(`runImport: sheet "${sheetName}" not found in workbook.`)
  }
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: '',
  })

  const client = await getPool().connect()
  const caches = newCaches()
  const rowLog: ImportRowLogEntry[] = []
  const exceptions: ImportExceptionSummary[] = []
  const headsSeenThisBatch = new Map<number, { budgetHeadLabel: string; utilisedAmount: number | null }>()

  try {
    await client.query('BEGIN')

    // The import_batch row is inserted INSIDE the transaction so child rows
    // (import_row_log, budget_allocation, entries.import_batch_id,
    // reconciliation_exception) can FK to it while still being rollback-able
    // together for a dry run — see the file-header comment.
    const batchInsert = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, sheet_name, mode, imported_by, status)
       values ($1, $2, $3, $4, $5, $6, 'processing')
       returning id`,
      [
        params.sourceSystem,
        params.filename,
        params.fileHashSha256,
        sheetName,
        params.mode,
        params.importedBy,
      ]
    )
    const batchId = batchInsert.rows[0]!.id

    let context: DepartmentalRowContext = INITIAL_DEPARTMENTAL_CONTEXT

    for (let i = 0; i < rawRows.length; i++) {
      const rowNumber = i + 1
      const rawRow = rawRows[i]!
      const { row, nextContext } = parseDepartmentalRow(sanitizeNumericColumns(rawRow), context)
      context = nextContext

      try {
        if (row.rowType === 'skip') {
          const action: ImportRowAction =
            row.skipReason === 'grand_total' ? 'skipped_total' : 'skipped_no_ubbl'
          const logEntry: ImportRowLogEntry = { rowNumber, rawRow, action, entryId: null, fieldsChanged: null }
          rowLog.push(logEntry)
          await writeRowLog(client, batchId, logEntry)
          continue
        }

        let budgetHeadCreated = false
        let budgetHeadId: number | null = null
        let departmentId: number | null = null

        if (row.budgetHead) {
          departmentId = row.department ? await resolveDepartment(client, caches, row.department) : null
          const resolved = await resolveBudgetHead(client, caches, row.budgetHead, departmentId, batchId)
          budgetHeadId = resolved.id
          budgetHeadCreated = resolved.created
        }

        // ---- allocation write (§3.5) ----
        if (row.allocation && budgetHeadId !== null) {
          await client.query(
            `insert into public.budget_allocation
               (budget_head_id, import_batch_id, as_of, request_amount, approved_amount, utilised_amount, balance_amount)
             values ($1, $2, current_date, $3, $4, $5, $6)`,
            [
              budgetHeadId,
              batchId,
              row.allocation.requestAmount,
              row.allocation.approvedAmount,
              row.allocation.utilisedAmount,
              row.allocation.balanceAmount,
            ]
          )
          headsSeenThisBatch.set(budgetHeadId, {
            // Non-null: budgetHeadId is only set inside the `if (row.budgetHead)`
            // block above, so row.budgetHead was truthy when it was computed.
            budgetHeadLabel: row.budgetHead!,
            utilisedAmount: row.allocation.utilisedAmount,
          })
        }

        // ---- entry write (§3.4, §3.6) ----
        let vendorCreated = false
        let entryAction: 'inserted' | 'updated' | 'unchanged' | null = null
        let entryId: number | null = null
        let fieldsChanged: Record<string, { from: unknown; to: unknown }> | null = null

        if (row.entry) {
          const entry = row.entry
          let vendorId: number | null = null
          if (entry.vendorRaw) {
            const resolved = await resolveVendor(client, caches, entry.vendorRaw)
            vendorId = resolved.id
            vendorCreated = resolved.created
          }

          let statusId: number | null = null
          if (entry.statusRaw) {
            statusId = await resolveStatus(
              client,
              caches,
              entry.statusRaw,
              'departmental',
              batchId,
              exceptions
            )
          }
          let auditStatusId: number | null = null
          if (entry.auditStatusRaw) {
            auditStatusId = await resolveStatus(
              client,
              caches,
              entry.auditStatusRaw,
              'audit',
              batchId,
              exceptions
            )
          }

          const invoiceDate = parseDdMmYyyy(entry.invoiceDate)

          const before = await client.query<Record<string, unknown>>(
            `select main_number, department_id, budget_head_id, invoice_number, vendor_id, vendor_raw,
                    date, amount, variance_reason, status_id, audit_status_id,
                    status_raw, audit_status_raw, budget_head_raw, type
             from public.entries where ubbl_number = $1`,
            [entry.ubblNumber]
          )
          const existing = before.rows[0] ?? null

          const upserted = await client.query<{ id: number }>(
            `insert into public.entries (
               type, ubbl_number, main_number, department_id, budget_head_id, invoice_number,
               vendor_id, vendor_raw, date, amount, variance_reason,
               status_id, audit_status_id, status_raw, audit_status_raw,
               budget_head_raw, source, import_batch_id, updated_at
             ) values (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'import', $17, now()
             )
             on conflict (ubbl_number) do update set
               main_number       = coalesce(excluded.main_number, entries.main_number),
               department_id     = excluded.department_id,
               budget_head_id    = excluded.budget_head_id,
               invoice_number    = excluded.invoice_number,
               vendor_id         = excluded.vendor_id,
               vendor_raw        = excluded.vendor_raw,
               date              = excluded.date,
               amount            = excluded.amount,
               variance_reason   = coalesce(excluded.variance_reason, entries.variance_reason),
               status_id         = excluded.status_id,
               audit_status_id   = coalesce(excluded.audit_status_id, entries.audit_status_id),
               status_raw        = excluded.status_raw,
               audit_status_raw  = coalesce(excluded.audit_status_raw, entries.audit_status_raw),
               budget_head_raw   = excluded.budget_head_raw,
               import_batch_id   = excluded.import_batch_id,
               updated_at        = now()
             returning id`,
            [
              entry.type,
              entry.ubblNumber,
              entry.mainNumber,
              departmentId,
              budgetHeadId,
              entry.invoiceNumber,
              vendorId,
              entry.vendorRaw,
              invoiceDate,
              entry.invoiceAmount,
              null, // variance_reason: not present in the Departmental export
              statusId,
              auditStatusId,
              entry.statusRaw,
              entry.auditStatusRaw,
              row.budgetHead,
              batchId,
            ]
          )
          entryId = upserted.rows[0]!.id

          if (!existing) {
            entryAction = 'inserted'
          } else {
            const after = {
              main_number: entry.mainNumber ?? existing.main_number,
              department_id: departmentId,
              budget_head_id: budgetHeadId,
              invoice_number: entry.invoiceNumber,
              vendor_id: vendorId,
              vendor_raw: entry.vendorRaw,
              date: invoiceDate,
              amount: entry.invoiceAmount,
              status_id: statusId,
              audit_status_id: auditStatusId ?? existing.audit_status_id,
              status_raw: entry.statusRaw,
              audit_status_raw: entry.auditStatusRaw ?? existing.audit_status_raw,
              budget_head_raw: row.budgetHead,
              type: entry.type,
            }
            const diff = diffFields(existing, after)
            fieldsChanged = Object.keys(diff).length > 0 ? diff : null
            entryAction = fieldsChanged ? 'updated' : 'unchanged'
          }
        }

        // One import_row_log row per source row (§3.6). Priority: a newly
        // created budget_head or vendor is the headline event for this row
        // (those enum values exist specifically to flag it); otherwise the
        // entry upsert's own outcome; otherwise (allocation-only row against
        // an already-known head) 'inserted', since budget_allocation is an
        // append-only snapshot table and every row written to it this batch
        // is by definition new (§3.5). Documented judgment call — the
        // action enum has no way to express two simultaneous outcomes on
        // one row.
        let action: ImportRowAction
        if (budgetHeadCreated) action = 'new_budget_head'
        else if (vendorCreated) action = 'new_vendor'
        else if (entryAction) action = entryAction
        else action = 'inserted'

        const logEntry: ImportRowLogEntry = { rowNumber, rawRow, action, entryId, fieldsChanged }
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

    // ---- post-batch assertions (§3.6 point 8, §3.4) ----

    // Allocation-sum mismatch: compare against the FULL current sum of
    // entries.amount for each head touched this batch (not just this
    // batch's rows) — entries upsert on ubbl_number, so a head's true
    // position is whatever is currently in the table, which is exactly what
    // "sum(entry amount) == allocation.utilised_amount" means once
    // re-imports are in play.
    const headIds = [...headsSeenThisBatch.keys()]
    if (headIds.length > 0) {
      const sums = await client.query<{ budget_head_id: number; total: string }>(
        `select budget_head_id, coalesce(sum(amount), 0) as total
           from public.entries
          where budget_head_id = any($1::bigint[])
          group by budget_head_id`,
        [headIds]
      )
      const dbSums = new Map(sums.rows.map((r) => [r.budget_head_id, Number(r.total)]))
      const mismatches = checkAllocationSumMismatches(
        headIds.map((id) => ({
          budgetHeadId: id,
          budgetHeadLabel: headsSeenThisBatch.get(id)!.budgetHeadLabel,
          utilisedAmount: headsSeenThisBatch.get(id)!.utilisedAmount,
        })),
        dbSums
      )
      for (const m of mismatches) {
        const description = `Budget head "${m.budgetHeadLabel}" (id ${m.budgetHeadId}): sum(entries.amount) = ${m.actualEntrySum}, allocation.utilised_amount = ${m.expectedUtilised} (diff ${m.diff}).`
        await client.query(
          `insert into public.reconciliation_exception
             (import_batch_id, exception_type, severity, amount_at_risk, description, dedup_key)
           values ($1, 'allocation_sum_mismatch', 'high', $2, $3, $4)`,
          [batchId, Math.abs(m.diff), description, `allocation_sum_mismatch:${m.budgetHeadId}:${batchId}`]
        )
        exceptions.push({ exceptionType: 'allocation_sum_mismatch', severity: 'high', description })
      }
    }

    // Namespace collision: no value may appear in both ubbl_number and
    // main_number across different rows, checked against the whole table
    // (existing rows + this batch's uncommitted writes are both visible
    // inside this transaction).
    const collisionRows = await client.query<{ value: string }>(
      `select distinct e1.ubbl_number as value
         from public.entries e1
         join public.entries e2
           on e2.main_number = e1.ubbl_number
          and e2.id <> e1.id`
    )
    for (const { value } of collisionRows.rows) {
      const description = `"${value}" appears as both a ubbl_number and a main_number on different rows — the two id namespaces overlap (§3.4).`
      await client.query(
        `insert into public.reconciliation_exception
           (import_batch_id, exception_type, severity, description, dedup_key)
         values ($1, 'id_namespace_collision', 'high', $2, $3)`,
        [batchId, description, `id_namespace_collision:${value}:${batchId}`]
      )
      exceptions.push({ exceptionType: 'id_namespace_collision', severity: 'high', description })
    }

    const summary: Record<string, number> = {}
    for (const entry of rowLog) {
      summary[entry.action] = (summary[entry.action] ?? 0) + 1
    }
    const status: ImportResult['status'] = exceptions.length > 0 ? 'completed_with_exceptions' : 'completed'

    if (params.mode === 'commit') {
      await client.query(
        `update public.import_batch
            set status = $1, row_count = $2, summary_jsonb = $3, completed_at = now()
          where id = $4`,
        [status, rawRows.length, JSON.stringify(summary), batchId]
      )
      await client.query('COMMIT')

      return {
        batchId,
        mode: params.mode,
        status,
        rowCount: rawRows.length,
        summary,
        rowLog,
        exceptions,
      }
    }

    // dry_run: roll back every row-level write (including the batch row and
    // its row log written above), then write ONE fresh batch row outside
    // any transaction with the final computed status/summary — "leaving
    // only the batch row and its summary" per §3.6.
    await client.query('ROLLBACK')

    const finalBatch = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, sheet_name, mode, imported_by,
          status, row_count, summary_jsonb, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       returning id`,
      [
        params.sourceSystem,
        params.filename,
        params.fileHashSha256,
        sheetName,
        params.mode,
        params.importedBy,
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
      exceptions,
    }
  } catch (fatalError) {
    await client.query('ROLLBACK').catch(() => {
      // The transaction may already be aborted; nothing more to do.
    })
    const message = fatalError instanceof Error ? fatalError.message : String(fatalError)

    const failedBatch = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, mode, imported_by, status, error_message, completed_at)
       values ($1, $2, $3, $4, $5, 'failed', $6, now())
       returning id`,
      [params.sourceSystem, params.filename, params.fileHashSha256, params.mode, params.importedBy, message]
    )

    return {
      batchId: failedBatch.rows[0]!.id,
      mode: params.mode,
      status: 'failed',
      rowCount: 0,
      summary: {},
      rowLog,
      exceptions,
      errorMessage: message,
    }
  } finally {
    client.release()
  }
}

async function writeRowLog(client: PoolClient, batchId: number, entry: ImportRowLogEntry): Promise<void> {
  await client.query(
    `insert into public.import_row_log (import_batch_id, entry_id, row_number, raw_row_jsonb, action, fields_changed)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      batchId,
      entry.entryId,
      entry.rowNumber,
      JSON.stringify(entry.rawRow),
      entry.action,
      entry.fieldsChanged ? JSON.stringify(entry.fieldsChanged) : null,
    ]
  )
}

/** `"26-07-2026"` (DD-MM-YYYY, as produced by xlsx's `raw:false` cell formatting) -> `"2026-07-26"`. */
function parseDdMmYyyy(value: string | null): string | null {
  if (!value) return null
  const match = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (!match) return null
  const dd = match[1]!
  const mm = match[2]!
  const yyyy = match[3]!
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}

/** Shallow diff of two plain objects, ignoring keys whose values are strictly equal. */
function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(after)) {
    const b = normalizeForCompare(before[key])
    const a = normalizeForCompare(after[key])
    if (b !== a) {
      changed[key] = { from: before[key] ?? null, to: after[key] ?? null }
    }
  }
  return changed
}

/**
 * Postgres `numeric`/`bigint` columns round-trip through `pg` as strings
 * (e.g. `"3000000.00"`, `"1"`), while the freshly-computed "after" side is
 * often a plain JS number (e.g. `3000000`, `1`) — a naive `String()`
 * comparison would report every unchanged numeric field as "updated" on
 * every re-import, which is exactly the idempotency bug §3.6's day-6 test
 * exists to catch. Numeric-looking values on either side are compared as
 * numbers (fixed to 2dp, matching `numeric(14,2)`); everything else is
 * compared as a trimmed string.
 */
function normalizeForCompare(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    // Defensive fallback only — the `date` type parser registered above
    // means this shouldn't be hit in practice. Uses LOCAL date parts, not
    // `.toISOString()` (UTC), for the same reason documented there: a
    // UTC-conversion round-trip can shift the calendar day.
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(2) : ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      return Number(trimmed).toFixed(2)
    }
    return trimmed
  }
  return String(value)
}
