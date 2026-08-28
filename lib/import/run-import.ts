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
import { cookies } from 'next/headers'
import { serverEnv } from '@/lib/env.server'
import { ACTIVE_EVENT_COOKIE } from '@/lib/events/current'
import { normalizeVendorName } from '@/lib/normalize'
import {
  INITIAL_DEPARTMENTAL_CONTEXT,
  parseDepartmentalRow,
  type DepartmentalRowContext,
} from '@/lib/module-mapping'
import { checkAllocationSumMismatches, checkNamespaceCollisions, parseBudgetHeadShortLabel } from '@/lib/import/assertions'
// Circular by module graph (run-portal-import.ts imports getPool/newCaches/
// resolveStatus/resolveVendor/writeRowLog back from THIS file) but safe: both
// sides only call each other's exports from inside function bodies invoked
// later at request time, never at module top-level, and every export
// crossing the boundary is a hoisted function declaration. See
// retryUnmatchedAuditRows's own header comment (run-portal-import.ts) for why
// the retry orchestration lives there instead of here — it needs
// parsePortalTable and the ParsedPortalRow shape that module already owns.
import { retryUnmatchedAuditRows } from '@/lib/import/run-portal-import'

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

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: serverEnv.DATABASE_URL, max: 5 })
  }
  return pool
}

// ---------------------------------------------------------------------------
// Event scoping (Phase 6 Step 2 §1) -- every import writer resolves the
// selected event through THIS function, not lib/events/current.ts's
// getSelectedEventId, because that helper needs a supabase-js SupabaseClient
// and every caller in this file (and run-portal-import.ts /
// run-department-budget-import.ts, which share this module's `pg` pool) only
// ever holds a raw `pg` connection. The resolution POLICY is kept byte-for-
// byte identical to getSelectedEventId's: read the active_event_id cookie,
// fall back to the row where is_current = true when the cookie is unset,
// unparsable, or points at a deleted event.
// ---------------------------------------------------------------------------

interface SelectedEventRow {
  id: number
  is_current: boolean
}

/** Thrown by resolveMutableEventId specifically for "the selected event
 *  exists but isn't the current one" -- distinguished from a generic Error
 *  (e.g. "no event configured", a genuine misconfiguration) so a caller that
 *  wants to answer with a specific HTTP status (409, not 500) can do so
 *  without string-matching a message. See app/api/import/route.ts. */
export class EventNotMutableError extends Error {}

/**
 * Resolves the selected event against the given `pg` client/pool and asserts
 * it is mutable (doc §1.6: "switching to a past event puts the app in a
 * view-only state -- no new uploads, no verification, no export"). Every
 * import entry point (runImport, runPortalImport,
 * runDepartmentBudgetImport) calls this BEFORE opening its transaction or
 * writing any row, so a blocked import leaves no trace -- same early-exit
 * shape as this file's own "sheet not found" check. Throws a plain,
 * already-human-readable Error (not a raw DB error) on failure, since
 * nothing here needs lib/friendly-error.ts's classifier -- the message is
 * already prose.
 */
export async function resolveMutableEventId(client: PoolClient | Pool): Promise<number> {
  const cookieStore = await cookies()
  const raw = cookieStore.get(ACTIVE_EVENT_COOKIE)?.value
  const parsedCookie = raw ? Number(raw) : NaN

  let row: SelectedEventRow | undefined
  if (Number.isFinite(parsedCookie)) {
    const byCookie = await client.query<SelectedEventRow>(
      'select id, is_current from public.event where id = $1',
      [parsedCookie]
    )
    row = byCookie.rows[0]
  }
  if (!row) {
    const current = await client.query<SelectedEventRow>(
      'select id, is_current from public.event where is_current = true limit 1'
    )
    row = current.rows[0]
  }
  if (!row) {
    throw new Error('No event is configured yet. Contact an admin before running an import.')
  }
  if (!row.is_current) {
    throw new EventNotMutableError(
      'The selected event is closed to new imports -- switch to the current event before importing.'
    )
  }
  return row.id
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Must stay in lockstep with import_row_log's action check constraint
 * (20260808000011, widened by 20260814000005). The first block is the .xlsx
 * path; the second is the portal-scrape path in lib/import/run-portal-import.ts,
 * whose outcomes annotate entries rather than create them.
 */
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
  | 'audit_status_updated'
  | 'audit_status_unchanged'
  | 'audit_unmatched'
  | 'audit_ambiguous'
  | 'skipped_no_identifier'

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

export interface ResolverCaches {
  departmentByName: Map<string, number>
  budgetHeadByRawLabel: Map<string, { id: number; departmentId: number | null }>
  vendorByNormalizedName: Map<string, number>
  statusByCode: Map<string, number>
}

export function newCaches(): ResolverCaches {
  return {
    departmentByName: new Map(),
    budgetHeadByRawLabel: new Map(),
    vendorByNormalizedName: new Map(),
    statusByCode: new Map(),
  }
}

/**
 * Registers a department as active in the current import's event. Mirrors
 * registerEventBudgetHead below exactly, for the same reason: resolveDepartment
 * (immediately below) get-or-creates department rows during import, which
 * the Phase 6 plan's own framing missed (it assumed department/admin_head/
 * zone were "pre-curated, never auto-created during import" -- true for
 * admin_head/zone, but not for department, per this function's pre-existing
 * get-or-create behavior). Without this, a department resolved or created
 * during import would silently fail to appear in this event's
 * event-scoped dropdowns even though its entries/budget_allocation rows
 * were correctly stamped with this event's id.
 */
async function registerEventDepartment(
  client: PoolClient,
  eventId: number,
  departmentId: number
): Promise<void> {
  await client.query(
    `insert into public.event_department (event_id, department_id)
     values ($1, $2)
     on conflict do nothing`,
    [eventId, departmentId]
  )
}

export async function resolveDepartment(
  client: PoolClient,
  caches: ResolverCaches,
  name: string,
  eventId: number
): Promise<number> {
  const cached = caches.departmentByName.get(name)
  if (cached !== undefined) return cached

  const existing = await client.query<{ id: number }>(
    'select id from public.department where name = $1',
    [name]
  )
  if (existing.rows[0]) {
    caches.departmentByName.set(name, existing.rows[0].id)
    // Resolved an EXISTING row -- may be from a prior year and new to this
    // one, so membership is asserted every time, not only on first-ever
    // creation. See registerEventDepartment's header comment.
    await registerEventDepartment(client, eventId, existing.rows[0].id)
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
  // Brand-new row -- obviously active in the event that just created it.
  await registerEventDepartment(client, eventId, id)
  return id
}

/**
 * Registers a budget_head as active in the current import's event (doc §1.2
 * refinement, resolved with the user 2026-08-22 -- see this file's own
 * header note and 20260822000005_event_scoping.sql's comment). Unlike
 * department/admin_head/zone, which are pre-curated and get their
 * event_<master> membership seeded at event-creation time
 * (lib/actions/events.ts's createEvent), budget_head rows are discovered
 * DURING this very import -- matched on exact raw_label, so the same label
 * naturally resolves to the same shared row year over year. That means
 * event_budget_head membership can't rely on manual carry-forward alone: a
 * budget head that already existed from a prior year but is new to THIS
 * year's import still needs to be marked active in THIS event, and a
 * brand-new head obviously does too. Called from both branches of
 * resolveBudgetHead below. `on conflict do nothing` because the same head
 * resolved twice in one run (cache miss on a second raw_label that happens
 * to collide, or a re-import of an already-registered head) is the same
 * fact repeated, not a new one.
 */
async function registerEventBudgetHead(
  client: PoolClient,
  eventId: number,
  budgetHeadId: number
): Promise<void> {
  await client.query(
    `insert into public.event_budget_head (event_id, budget_head_id)
     values ($1, $2)
     on conflict do nothing`,
    [eventId, budgetHeadId]
  )
}

export async function resolveBudgetHead(
  client: PoolClient,
  caches: ResolverCaches,
  rawLabel: string,
  departmentId: number | null,
  batchId: number,
  eventId: number
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
    // Resolved an EXISTING row -- may be from a prior year and new to this
    // one, so membership is asserted every time, not only on first-ever
    // creation. See registerEventBudgetHead's header comment.
    await registerEventBudgetHead(client, eventId, existing.rows[0].id)
    return { id: existing.rows[0].id, created: false }
  }

  const shortLabel = parseBudgetHeadShortLabel(rawLabel)

  /**
   * Second lookup, on (department_id, short_label) case-insensitively,
   * before giving up and creating a row.
   *
   * `raw_label` is the whole rendered string, and the SAME budget head is
   * not spelled identically everywhere it appears. Confirmed 2026-08-28
   * against live data: every stored row reads "Venue setup (X)" with a
   * lowercase s, while the Departmental portal renders BOTH "Venue setup
   * (Power)" and "Venue Setup (Electricals)" -- the department half's
   * casing varies row to row within one scrape. Matching on raw_label
   * alone therefore forks a second budget_head row for what is, to a
   * human, the head they already have, and entries then split across two
   * ids that no report re-joins.
   *
   * The identity that actually matters is the pair the schema already
   * stores as its own columns: which department, and which short label
   * (the bracketed half). That is what this matches on, so a casing or
   * spacing difference in the department prefix can no longer create a
   * duplicate. Verified safe before shipping: the live table has zero
   * (department_id, lower(short_label)) collisions, so this can only
   * collapse would-be duplicates, never merge two heads a human meant to
   * keep apart.
   *
   * Deliberately a code-level lookup rather than a unique constraint on
   * the pair. A constraint would turn a future genuine collision into a
   * hard import failure mid-batch; this degrades to the existing
   * create-a-row behaviour instead, which is the same posture the rest of
   * this file takes toward unseen master data.
   */
  if (departmentId !== null && shortLabel !== null) {
    const byParts = await client.query<{ id: number; department_id: number | null }>(
      `select id, department_id from public.budget_head
        where department_id = $1 and lower(short_label) = lower($2)
        order by id limit 1`,
      [departmentId, shortLabel]
    )
    if (byParts.rows[0]) {
      caches.budgetHeadByRawLabel.set(rawLabel, {
        id: byParts.rows[0].id,
        departmentId: byParts.rows[0].department_id,
      })
      await registerEventBudgetHead(client, eventId, byParts.rows[0].id)
      return { id: byParts.rows[0].id, created: false }
    }
  }
  const created = await client.query<{ id: number }>(
    `insert into public.budget_head (department_id, raw_label, short_label, first_seen_batch_id)
     values ($1, $2, $3, $4)
     returning id`,
    [departmentId, rawLabel, shortLabel, batchId]
  )
  const id = created.rows[0]!.id
  caches.budgetHeadByRawLabel.set(rawLabel, { id, departmentId })
  // Brand-new row -- obviously active in the event that just created it.
  await registerEventBudgetHead(client, eventId, id)
  return { id, created: true }
}

export async function resolveVendor(
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
export async function resolveStatus(
  client: PoolClient,
  caches: ResolverCaches,
  rawText: string,
  sourceSystem: 'departmental' | 'audit',
  batchId: number,
  exceptionsOut: ImportExceptionSummary[]
): Promise<number> {
  // ONE vocabulary, keyed on code alone (20260828000001).
  //
  // This used to look up (code, source_system), which meant "Paid" from the
  // Audit portal and "Paid" from the Departmental one resolved to two
  // different entry_status rows — and entries then carried two independent
  // status pointers that no screen reconciled. The status a row is in is one
  // fact about that row, so there is now one vocabulary and one pointer.
  //
  // `sourceSystem` is still taken, but only to say WHICH import first met an
  // unseen code in the exception text below. It no longer partitions the
  // lookup, so the same code resolves to the same row whichever side reports
  // it — which is the whole point.
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
    `insert into public.entry_status (code, label, sort_order, is_terminal)
     values ($1, $1, 999, false)
     on conflict (code) do update set code = excluded.code
     returning id`,
    [rawText]
  )
  const id = created.rows[0]!.id
  caches.statusByCode.set(rawText, id)

  const description = `Unseen status code "${rawText}" (first seen from ${sourceSystem}) auto-inserted with sort_order = 999.`
  // dedup_key deliberately excludes batchId: the same unseen code hit by a
  // later import is the same finding, not a new one. ON CONFLICT refreshes
  // the pointer to the latest batch that saw it while it's still open, but
  // never reopens one a human already resolved/dismissed (2026-08-13 fix —
  // batchId used to be baked into the key, which meant the `unique`
  // constraint on dedup_key never actually deduped anything; see the
  // matching fix on allocation_sum_mismatch and id_namespace_collision below).
  await client.query(
    `insert into public.reconciliation_exception
       (import_batch_id, exception_type, severity, description, dedup_key)
     values ($1, 'unknown_status_code', 'low', $2, $3)
     on conflict (dedup_key) do update
       set import_batch_id = excluded.import_batch_id,
           description = excluded.description
       where public.reconciliation_exception.status = 'open'`,
    // Keyed on the code alone, matching the unified vocabulary: the same
    // unseen code met from both portals is one finding to act on, not two.
    [batchId, description, `unknown_status_code:${rawText}`]
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

  // Resolved -- and its mutability asserted -- BEFORE the transaction opens
  // and before any row is written, so a blocked import (viewing a past
  // event) leaves no trace at all, same early-exit shape as the sheet-not-
  // found check above. If this throws, the client must still be released:
  // it hasn't entered the try/finally below yet.
  let eventId: number
  try {
    eventId = await resolveMutableEventId(client)
  } catch (err) {
    client.release()
    throw err
  }

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
         (source_system, source_filename, file_hash_sha256, sheet_name, mode, imported_by, event_id, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'processing')
       returning id`,
      [
        params.sourceSystem,
        params.filename,
        params.fileHashSha256,
        sheetName,
        params.mode,
        params.importedBy,
        eventId,
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
          departmentId = row.department ? await resolveDepartment(client, caches, row.department, eventId) : null
          const resolved = await resolveBudgetHead(client, caches, row.budgetHead, departmentId, batchId, eventId)
          budgetHeadId = resolved.id
          budgetHeadCreated = resolved.created
        }

        // ---- allocation write (§3.5) ----
        if (row.allocation && budgetHeadId !== null) {
          await client.query(
            `insert into public.budget_allocation
               (budget_head_id, import_batch_id, event_id, as_of, request_amount, approved_amount, utilised_amount, balance_amount)
             values ($1, $2, $3, current_date, $4, $5, $6, $7)`,
            [
              budgetHeadId,
              batchId,
              eventId,
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
          // The export's "Main Status" column is the audit-side state. It is
          // no longer a SECOND status: with one unified vocabulary and one
          // status column (20260828000001), whichever side reports last wins,
          // and the audit side is downstream so its word is the later one.
          if (entry.auditStatusRaw) {
            statusId = await resolveStatus(
              client,
              caches,
              entry.auditStatusRaw,
              'audit',
              batchId,
              exceptions
            )
          }
          const effectiveStatusRaw = entry.auditStatusRaw ?? entry.statusRaw

          const invoiceDate = parseDdMmYyyy(entry.invoiceDate)

          const before = await client.query<Record<string, unknown>>(
            `select main_number, department_id, budget_head_id, invoice_number, vendor_id, vendor_raw,
                    date, amount, status_id, status_raw, type
             from public.entries where ubbl_number = $1`,
            [entry.ubblNumber]
          )
          const existing = before.rows[0] ?? null

          const upserted = await client.query<{ id: number }>(
            `insert into public.entries (
               type, ubbl_number, main_number, department_id, budget_head_id, invoice_number,
               vendor_id, vendor_raw, date, amount,
               status_id, status_raw,
               source, import_batch_id, event_id, updated_at
             ) values (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'import', $13, $14, now()
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
               status_id         = excluded.status_id,
               status_raw        = excluded.status_raw,
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
              statusId,
              effectiveStatusRaw,
              batchId,
              eventId,
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
              status_raw: effectiveStatusRaw,
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
        // dedup_key excludes batchId (2026-08-13 fix, see unknown_status_code
        // above for the full rationale). Unlike that one, this key still
        // depends on the diff amount itself: an unchanged mismatch across
        // batches refreshes in place, but a genuinely different diff on the
        // same head is a new fact worth its own open exception rather than
        // silently overwriting a still-open one with a new amount_at_risk.
        await client.query(
          `insert into public.reconciliation_exception
             (import_batch_id, exception_type, severity, amount_at_risk, description, dedup_key)
           values ($1, 'allocation_sum_mismatch', 'high', $2, $3, $4)
           on conflict (dedup_key) do update
             set import_batch_id = excluded.import_batch_id,
                 description = excluded.description
             where public.reconciliation_exception.status = 'open'`,
          [batchId, Math.abs(m.diff), description, `allocation_sum_mismatch:${m.budgetHeadId}:${m.diff}`]
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
      // dedup_key excludes batchId (2026-08-13 fix, see unknown_status_code
      // above) -- the collision is a property of the value itself, present
      // again on every re-import until a human resolves it.
      await client.query(
        `insert into public.reconciliation_exception
           (import_batch_id, exception_type, severity, description, dedup_key)
         values ($1, 'id_namespace_collision', 'high', $2, $3)
         on conflict (dedup_key) do update
           set import_batch_id = excluded.import_batch_id,
               description = excluded.description
           where public.reconciliation_exception.status = 'open'`,
        [batchId, description, `id_namespace_collision:${value}`]
      )
      exceptions.push({ exceptionType: 'id_namespace_collision', severity: 'high', description })
    }

    const summary: Record<string, number> = {}
    for (const entry of rowLog) {
      summary[entry.action] = (summary[entry.action] ?? 0) + 1
    }

    if (params.mode === 'commit') {
      // Auto-retry unmatched Audit-portal rows (docs/hub-refinements-plan.md
      // §4). This Departmental import may just have created/updated the
      // entry an Audit row was waiting on (main_number only ever arrives via
      // this path — see run-portal-import.ts's file header), so a commit is
      // exactly the moment a stale audit_row_unmatched exception is most
      // likely to resolve itself. Runs INSIDE this same transaction/client,
      // atomically with the rest of the batch: either the whole commit lands
      // with the retried match applied, or none of it does. Deliberately
      // placed AFTER the row loop (so it sees this batch's own writes) and
      // BEFORE `status` is computed (so a variance the retry surfaces, e.g.
      // tenant_vs_main_variance, counts toward this batch's own status/
      // exceptions like any other finding). Never runs for a dry_run: a dry
      // run rolls back every write below, so retrying against a transaction
      // about to be discarded would just be wasted queries with nothing to
      // show for it — the mode check on the outer `if` already excludes it.
      const retry = await retryUnmatchedAuditRows(client, caches, batchId, exceptions)
      if (retry.resolvedCount > 0) {
        summary.audit_retry_resolved = retry.resolvedCount
      }
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
          event_id, status, row_count, summary_jsonb, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       returning id`,
      [
        params.sourceSystem,
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
      exceptions,
    }
  } catch (fatalError) {
    await client.query('ROLLBACK').catch(() => {
      // The transaction may already be aborted; nothing more to do.
    })
    const message = fatalError instanceof Error ? fatalError.message : String(fatalError)

    const failedBatch = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, mode, imported_by, event_id, status, error_message, completed_at)
       values ($1, $2, $3, $4, $5, $6, 'failed', $7, now())
       returning id`,
      [params.sourceSystem, params.filename, params.fileHashSha256, params.mode, params.importedBy, eventId, message]
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

/**
 * Multi-row form of writeRowLog: one INSERT for the whole batch instead of
 * one per row.
 *
 * The row log is pure append -- no ON CONFLICT, no read-back, and nothing
 * later in the import reads what it wrote -- so the individual writes were
 * never ordering-sensitive, only numerous. On a 64-row scrape that was 64
 * sequential round trips of the ~320 the import spent (measured 2026-08-28:
 * 6.1ms per round trip against the ap-south-1 pooler, which is most of a
 * multi-second import). Collapsing them costs nothing in behaviour: the
 * rows land inside the same transaction, in the same order, and a dry run
 * still rolls every one of them back.
 *
 * Chunked because Postgres caps a statement at 65535 bound parameters; at 6
 * columns per row that is ~10900 rows, and MAX_ROWS on the scrape endpoint
 * is 20000. Callers pass whatever they have and this stays correct.
 */
export async function writeRowLogBatch(
  client: PoolClient,
  batchId: number,
  entries: readonly ImportRowLogEntry[]
): Promise<void> {
  const CHUNK = 500
  for (let start = 0; start < entries.length; start += CHUNK) {
    const chunk = entries.slice(start, start + CHUNK)
    const values: unknown[] = []
    const tuples = chunk.map((entry, i) => {
      const b = i * 6
      values.push(
        batchId,
        entry.entryId,
        entry.rowNumber,
        JSON.stringify(entry.rawRow),
        entry.action,
        entry.fieldsChanged ? JSON.stringify(entry.fieldsChanged) : null
      )
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`
    })
    await client.query(
      `insert into public.import_row_log
         (import_batch_id, entry_id, row_number, raw_row_jsonb, action, fields_changed)
       values ${tuples.join(', ')}`,
      values
    )
  }
}

export async function writeRowLog(client: PoolClient, batchId: number, entry: ImportRowLogEntry): Promise<void> {
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
