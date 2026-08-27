/**
 * Portal-scrape import orchestration (MASTER-PLAN §14 Phase 3 item 1, §17.23).
 *
 * Drives one scraped portal table end to end — batch bookkeeping, entry
 * resolution, the writes, and the same dry-run/commit transaction semantics as
 * the .xlsx path.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND NOT A BRANCH INSIDE runImport
 *
 * lib/import/run-import.ts is the .xlsx path, live-verified against production
 * on 2026-08-13 (§15.1). Its row loop is built around a shape the scrape path
 * does not have — forward-filled Budget Head/Department context, allocation
 * sub-rows, and the allocation-sum assertion that depends on them. Threading a
 * second row shape through that loop would mean touching verified code on
 * every line of it to serve a path with different invariants.
 *
 * The two files share the parts that genuinely ARE the same: the connection
 * pool, the vendor and status resolvers, and the row-log writer are imported
 * from run-import.ts rather than reimplemented, so there is exactly one
 * definition of "resolve a vendor" and one of "auto-insert an unseen status".
 *
 * WHAT EACH SOURCE SYSTEM WRITES
 *
 *   audit        Annotates entries the Departmental import already created.
 *                Writes audit_status_id / audit_status_raw / audit_synced_at
 *                and nothing else. Never inserts an entry: an Audit row with
 *                no Hub counterpart is a reconciliation finding, not a licence
 *                to invent a half-populated entry with no budget head, no
 *                department and no allocation to tally against.
 *
 *   departmental Upserts entries on ubbl_number, keeping identity, money,
 *                dates, vendor and departmental status current between .xlsx
 *                imports. It does NOT write budget_head_id, department_id or
 *                budget_allocation — see the budget-head note in
 *                lib/import/portal-mapping.ts for why the portal's "Budget
 *                Head" column cannot be trusted to mean the same thing as the
 *                export's, and §3.5 for why allocations only ever arrive as a
 *                snapshot from the export. The .xlsx import remains the source
 *                of truth for classification and allocation; the scrape keeps
 *                the rest fresh daily.
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  getPool,
  newCaches,
  resolveMutableEventId,
  resolveStatus,
  resolveVendor,
  writeRowLog,
  type ImportExceptionSummary,
  type ImportResult,
  type ImportRowAction,
  type ImportRowLogEntry,
  type ResolverCaches,
} from '@/lib/import/run-import'
import {
  deriveEntryType,
  detectDepartmentalTableKind,
  findPortalRowByIdentifier,
  parseAuditRowUnmatchedIdentifier,
  parsePortalTable,
  type ParsedPortalRow,
  type ParsedPortalStatus,
  type SourceSystem,
} from '@/lib/import/portal-mapping'

/** The payload shape the bookmarklet POSTs. Validated in the route handler. */
export interface ScrapePayload {
  sourceSystem: SourceSystem
  headers: string[]
  rows: string[][]
  /** The portal page the rows were read from. */
  sourceUrl?: string | null
  /** Bookmarklet build stamp, for diagnosing a stale saved bookmark. */
  scraperVersion?: string | null
  scrapedAt?: string | null
}

/**
 * sha256 over the rows a scrape actually carries, in a canonical form.
 *
 * import_batch.file_hash_sha256 is NOT NULL and exists so an identical
 * resubmission is recognisable. A scrape has no file, so the hash is taken
 * over the table content instead — deliberately EXCLUDING sourceUrl,
 * scrapedAt and scraperVersion, so re-reading the same unchanged table an hour
 * later, or after the bookmarklet is updated, still hashes identically. What
 * is being fingerprinted is the data, not the act of scraping it.
 */
export function canonicalPayloadHash(payload: ScrapePayload): string {
  const canonical = JSON.stringify({
    sourceSystem: payload.sourceSystem,
    headers: payload.headers,
    rows: payload.rows,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export interface RunPortalImportParams {
  payload: ScrapePayload
  /** sha256 over the canonicalised payload — see canonicalPayloadHash. */
  fileHashSha256: string
  filename: string
  mode: 'dry_run' | 'commit'
  /** staff_profile.id of the operator whose token submitted this. */
  importedBy: string | null
}

export interface PortalImportResult extends ImportResult {
  /** Header/column problems worth showing above the row diff. */
  warnings: string[]
}

/**
 * Rounds to paise before comparing two money figures. `entries.amount` is
 * numeric(14,2) and comes back from `pg` as a string; the scraped figure is a
 * JS float. Comparing them directly makes 8400 !== 8400.000000001 a variance.
 */
function moneyDiffers(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false
  return Math.round(a * 100) !== Math.round(b * 100)
}

interface MatchedEntry {
  id: number
  ubbl_number: string
  main_number: string | null
  amount: string | null
  audit_status_id: number | null
  audit_status_raw: string | null
  status_id: number | null
  status_raw: string | null
  invoice_number: string | null
  vendor_id: number | null
  vendor_raw: string | null
  date: string | null
  type: string
}

const ENTRY_COLUMNS = `id, ubbl_number, main_number, amount, audit_status_id, audit_status_raw,
                       status_id, status_raw, invoice_number, vendor_id, vendor_raw, date, type`

/**
 * Finds the Hub entry a scraped row refers to.
 *
 * Exact identifiers only, and no fuzzy fallback. A fuzzy vendor/amount/date
 * match that guesses WRONG here silently writes one entry's audit status onto
 * another's — worse than not linking at all, because it produces a confident
 * wrong answer instead of a visible gap. Rows that match nothing become an
 * `audit_row_unmatched` exception a human reads.
 *
 * The Audit portal shows only its OWN entry number, not the originating UBBL
 * (confirmed 2026-08-13). Exact matching still works because that number is
 * verbatim the Departmental export's "Main Entry Number" — checked against the
 * real export and the real portal screenshot in
 * test/unit/portal-linkage.test.ts, which matched 8 of 8 rows.
 *
 * ubbl_number is nonetheless tried FIRST. Not because the Audit portal
 * supplies one — it does not — but because a Departmental scrape comes through
 * the same function, and because ubbl_number is the stronger key when it is
 * present: it is `not null unique` and Hub-owned, whereas main_number is
 * nullable and exists on an entry only once the Departmental export has
 * carried it across. Hence the ordering requirement documented in
 * lib/import/portal-mapping.ts: import the export before scraping Audit.
 */
async function findEntry(
  client: PoolClient,
  row: ParsedPortalRow
): Promise<{ entry: MatchedEntry | null; ambiguous: boolean }> {
  if (row.ubblNumber) {
    const byUbbl = await client.query<MatchedEntry>(
      `select ${ENTRY_COLUMNS} from public.entries where ubbl_number = $1 and is_void = false`,
      [row.ubblNumber]
    )
    if (byUbbl.rows[0]) return { entry: byUbbl.rows[0], ambiguous: false }
  }

  if (row.mainNumber) {
    const byMain = await client.query<MatchedEntry>(
      `select ${ENTRY_COLUMNS} from public.entries where main_number = $1 and is_void = false`,
      [row.mainNumber]
    )
    // main_number carries a unique constraint, so >1 should be impossible —
    // but is_void rows and a future relaxation both make it worth reporting
    // rather than silently taking the first.
    if (byMain.rows.length > 1) return { entry: null, ambiguous: true }
    if (byMain.rows[0]) return { entry: byMain.rows[0], ambiguous: false }
  }

  return { entry: null, ambiguous: false }
}

async function raiseException(
  client: PoolClient,
  batchId: number,
  exceptionsOut: ImportExceptionSummary[],
  input: {
    type: string
    severity: 'low' | 'medium' | 'high'
    description: string
    dedupKey: string
    entryId?: number | null
    amountAtRisk?: number | null
  }
): Promise<void> {
  // Same dedup discipline as run-import.ts's exceptions (2026-08-13 fix):
  // batchId is deliberately NOT part of the key, so re-importing the same
  // unresolved finding refreshes the existing open row instead of spawning a
  // duplicate on every scrape — and never reopens one a human has resolved.
  await client.query(
    `insert into public.reconciliation_exception
       (import_batch_id, entry_id, exception_type, severity, amount_at_risk, description, dedup_key)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (dedup_key) do update
       set import_batch_id = excluded.import_batch_id,
           description = excluded.description
       where public.reconciliation_exception.status = 'open'`,
    [
      batchId,
      input.entryId ?? null,
      input.type,
      input.severity,
      input.amountAtRisk ?? null,
      input.description,
      input.dedupKey,
    ]
  )
  exceptionsOut.push({
    exceptionType: input.type,
    severity: input.severity,
    description: input.description,
  })
}

/** Resolves a parsed status chip to an entry_status id, or null if absent. */
async function resolvePortalStatus(
  client: PoolClient,
  caches: ResolverCaches,
  status: ParsedPortalStatus | null,
  sourceSystem: SourceSystem,
  batchId: number,
  exceptionsOut: ImportExceptionSummary[]
): Promise<number | null> {
  if (!status) return null
  // The SLUG is the code, and the verbatim label is kept separately on
  // entries.*_status_raw. Keying on the slug means "Paid", "paid" and " Paid "
  // are one status rather than three rows in entry_status with sort_order 999.
  return resolveStatus(client, caches, status.code, sourceSystem, batchId, exceptionsOut)
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export async function runPortalImport(
  params: RunPortalImportParams
): Promise<PortalImportResult> {
  const { payload } = params
  const sourceSystem = payload.sourceSystem

  const parsed = parsePortalTable({
    headers: payload.headers,
    rows: payload.rows,
    sourceSystem,
  })

  // Which Dept-module tab this batch was scraped from — meaningful only for
  // the departmental source (see detectDepartmentalTableKind's header). The
  // audit path never reads this.
  const tableKind =
    sourceSystem === 'departmental' ? detectDepartmentalTableKind(payload.headers) : null

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

  const caches = newCaches()
  const rowLog: ImportRowLogEntry[] = []
  const exceptions: ImportExceptionSummary[] = []
  const warnings = [...parsed.warnings]

  const batchColumns = `(source_system, source_filename, file_hash_sha256, mode, imported_by,
                         ingest_method, scrape_payload_jsonb, source_url, event_id, status)`

  try {
    await client.query('BEGIN')

    const batchInsert = await client.query<{ id: number }>(
      `insert into public.import_batch ${batchColumns}
       values ($1, $2, $3, $4, $5, 'scrape', $6, $7, $8, 'processing')
       returning id`,
      [
        sourceSystem,
        params.filename,
        params.fileHashSha256,
        params.mode,
        params.importedBy,
        JSON.stringify(payload),
        payload.sourceUrl ?? null,
        eventId,
      ]
    )
    const batchId = batchInsert.rows[0]!.id

    for (const row of parsed.rows) {
      try {
        if (row.skipReason) {
          const action: ImportRowAction =
            row.skipReason === 'total_row' ? 'skipped_total' : 'skipped_no_identifier'
          await logRow(client, batchId, rowLog, {
            rowNumber: row.rowNumber,
            rawRow: row.rawRow,
            action,
            entryId: null,
            fieldsChanged: null,
          })
          continue
        }

        if (sourceSystem === 'audit') {
          await importAuditRow(client, caches, batchId, row, rowLog, exceptions)
        } else {
          // tableKind is non-null whenever sourceSystem === 'departmental' —
          // see its computation above.
          await importDepartmentalRow(
            client,
            caches,
            batchId,
            eventId,
            row,
            rowLog,
            exceptions,
            tableKind!
          )
        }
      } catch (rowError) {
        const message = rowError instanceof Error ? rowError.message : String(rowError)
        await logRow(client, batchId, rowLog, {
          rowNumber: row.rowNumber,
          rawRow: row.rawRow,
          action: 'error',
          entryId: null,
          fieldsChanged: null,
          note: message,
        })
      }
    }

    const summary: Record<string, number> = {}
    for (const entry of rowLog) {
      summary[entry.action] = (summary[entry.action] ?? 0) + 1
    }
    const status: ImportResult['status'] =
      exceptions.length > 0 ? 'completed_with_exceptions' : 'completed'

    if (params.mode === 'commit') {
      await client.query(
        `update public.import_batch
            set status = $1, row_count = $2, summary_jsonb = $3, completed_at = now()
          where id = $4`,
        [status, parsed.rows.length, JSON.stringify(summary), batchId]
      )
      await client.query('COMMIT')

      return {
        batchId,
        mode: params.mode,
        status,
        rowCount: parsed.rows.length,
        summary,
        rowLog,
        exceptions,
        warnings,
      }
    }

    // dry_run: roll every row-level write back, then record one batch row
    // outside the transaction carrying the computed summary — the same
    // "leaves only the batch row and its summary" contract as the .xlsx path
    // (§3.6), so the preview screen reads both identically.
    await client.query('ROLLBACK')

    const finalBatch = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, mode, imported_by,
          ingest_method, scrape_payload_jsonb, source_url, event_id, status, row_count, summary_jsonb, completed_at)
       values ($1, $2, $3, $4, $5, 'scrape', $6, $7, $8, $9, $10, $11, now())
       returning id`,
      [
        sourceSystem,
        params.filename,
        params.fileHashSha256,
        params.mode,
        params.importedBy,
        JSON.stringify(payload),
        payload.sourceUrl ?? null,
        eventId,
        status,
        parsed.rows.length,
        JSON.stringify(summary),
      ]
    )

    return {
      batchId: finalBatch.rows[0]!.id,
      mode: params.mode,
      status,
      rowCount: parsed.rows.length,
      summary,
      rowLog,
      exceptions,
      warnings,
    }
  } catch (fatalError) {
    await client.query('ROLLBACK').catch(() => {
      // Already aborted; nothing more to do.
    })
    const message = fatalError instanceof Error ? fatalError.message : String(fatalError)

    const failedBatch = await client.query<{ id: number }>(
      `insert into public.import_batch
         (source_system, source_filename, file_hash_sha256, mode, imported_by,
          ingest_method, source_url, event_id, status, error_message, completed_at)
       values ($1, $2, $3, $4, $5, 'scrape', $6, $7, 'failed', $8, now())
       returning id`,
      [
        sourceSystem,
        params.filename,
        params.fileHashSha256,
        params.mode,
        params.importedBy,
        payload.sourceUrl ?? null,
        eventId,
        message,
      ]
    )

    return {
      batchId: failedBatch.rows[0]!.id,
      mode: params.mode,
      status: 'failed',
      rowCount: 0,
      summary: {},
      rowLog,
      exceptions,
      warnings,
      errorMessage: message,
    }
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Per-row handlers
// ---------------------------------------------------------------------------

async function logRow(
  client: PoolClient,
  batchId: number,
  rowLog: ImportRowLogEntry[],
  entry: ImportRowLogEntry
): Promise<void> {
  rowLog.push(entry)
  await writeRowLog(client, batchId, entry)
}

/** Outcome of attemptAuditRowMatch — see that function for what each case means. */
type AuditRowMatchOutcome =
  | { kind: 'ambiguous' }
  | { kind: 'unmatched' }
  | {
      kind: 'matched'
      entryId: number
      fieldsChanged: Record<string, { from: unknown; to: unknown }> | null
    }

/**
 * Matches one Audit-portal row against the CURRENT state of `entries` and,
 * if matched, applies the same update `importAuditRow` always has: fills
 * main_number if the Hub has never seen it, writes the audit status, and
 * raises tenant_vs_main_variance on an amount disagreement. Never creates an
 * entry (this file's header).
 *
 * Deliberately does NOT decide what "ambiguous" or "unmatched" MEANS for the
 * caller — no exception is raised and no row is logged for those two cases
 * here. That decision is the one place the two callers genuinely disagree:
 *
 *   - importAuditRow (below), the original scrape path, raises a fresh
 *     audit_row_unmatched/audit_ambiguous_match exception on every scrape,
 *     because on that path "no match" is new information worth recording.
 *   - retryUnmatchedAuditRows (docs/hub-refinements-plan.md §4), called from
 *     run-import.ts's commit path, means "still open, leave the existing
 *     exception alone, try again on the next Departmental import" — raising
 *     a second exception, or touching the row log of an import that never
 *     saw this row as one of its own source rows, would be wrong there.
 *
 * Extracted so there is exactly one definition of "how an Audit row matches
 * and updates an entry" — the task brief's explicit ask, to avoid the retry
 * path silently drifting from the original scrape path's matching rules.
 */
async function attemptAuditRowMatch(
  client: PoolClient,
  caches: ResolverCaches,
  batchId: number,
  row: ParsedPortalRow,
  exceptions: ImportExceptionSummary[]
): Promise<AuditRowMatchOutcome> {
  const { entry, ambiguous } = await findEntry(client, row)
  if (ambiguous) return { kind: 'ambiguous' }
  if (!entry) return { kind: 'unmatched' }

  // The Audit portal's status is the AUDIT status, whichever column it came
  // from: on that portal the plain "Status" column IS the audit-side state.
  // A dedicated "Audit Status" column, if one ever appears, still wins.
  const auditChip = row.auditStatus ?? row.status
  const verificationChip = row.verificationStatus

  const auditStatusId = await resolvePortalStatus(
    client,
    caches,
    auditChip,
    'audit',
    batchId,
    exceptions
  )

  // A verification-stage column (confirmed as coming, 2026-08-12) is recorded
  // in entry_status alongside the audit status so the vocabulary is captured
  // from day one, but it is NOT written onto entries: there is no column for
  // it yet, and inventing one before its meaning is confirmed would be
  // guessing. Registering the code makes the unknown_status_code exception
  // surface it, which is the designed way for a new vocabulary to become
  // visible (§3.3).
  if (verificationChip) {
    await resolvePortalStatus(client, caches, verificationChip, 'audit', batchId, exceptions)
  }

  const before = {
    main_number: entry.main_number,
    audit_status_id: entry.audit_status_id,
    audit_status_raw: entry.audit_status_raw,
  }
  const after = {
    // Fill main_number in if the Hub has never seen it; never overwrite a
    // value the Departmental export already established.
    main_number: entry.main_number ?? row.mainNumber,
    audit_status_id: auditStatusId ?? entry.audit_status_id,
    audit_status_raw: auditChip?.raw ?? entry.audit_status_raw,
  }

  const fieldsChanged: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(after) as (keyof typeof after)[]) {
    if (before[key] !== after[key]) fieldsChanged[key] = { from: before[key], to: after[key] }
  }

  await client.query(
    `update public.entries
        set main_number      = $1,
            audit_status_id  = $2,
            audit_status_raw = $3,
            audit_synced_at  = now(),
            audit_sync_batch_id = $4,
            audit_status_changed_at = case when $2::bigint is distinct from audit_status_id
                                           then now() else audit_status_changed_at end,
            updated_at       = now()
      where id = $5`,
    [after.main_number, after.audit_status_id, after.audit_status_raw, batchId, entry.id]
  )

  // Amount disagreement between the two sides is exactly what
  // 'tenant_vs_main_variance' exists for (§3.4) — the Audit portal is the
  // "main" side. Reported, never auto-corrected: which side is right is a
  // human judgment, and silently overwriting entries.amount from a scrape
  // would destroy the evidence that they ever disagreed.
  const hubAmount = entry.amount === null ? null : Number(entry.amount)
  if (moneyDiffers(hubAmount, row.amount)) {
    await raiseException(client, batchId, exceptions, {
      type: 'tenant_vs_main_variance',
      severity: 'high',
      entryId: entry.id,
      amountAtRisk: Math.abs((hubAmount ?? 0) - (row.amount ?? 0)),
      description: `Entry ${entry.ubbl_number}: Hub amount ${hubAmount}, Audit portal amount ${row.amount}.`,
      dedupKey: `tenant_vs_main_variance:${entry.id}:${hubAmount}:${row.amount}`,
    })
  }

  return {
    kind: 'matched',
    entryId: entry.id,
    fieldsChanged: Object.keys(fieldsChanged).length > 0 ? fieldsChanged : null,
  }
}

/**
 * One Audit-portal row. Annotates an existing entry; never creates one.
 */
async function importAuditRow(
  client: PoolClient,
  caches: ResolverCaches,
  batchId: number,
  row: ParsedPortalRow,
  rowLog: ImportRowLogEntry[],
  exceptions: ImportExceptionSummary[]
): Promise<void> {
  const outcome = await attemptAuditRowMatch(client, caches, batchId, row, exceptions)

  if (outcome.kind === 'ambiguous') {
    const identifier = row.mainNumber ?? row.ubblNumber ?? '(none)'
    await raiseException(client, batchId, exceptions, {
      type: 'audit_ambiguous_match',
      severity: 'high',
      description: `Audit row "${identifier}" matched more than one Hub entry; no audit status was written. Resolve the duplicate entries first.`,
      dedupKey: `audit_ambiguous_match:${identifier}`,
      amountAtRisk: row.amount,
    })
    await logRow(client, batchId, rowLog, {
      rowNumber: row.rowNumber,
      rawRow: row.rawRow,
      action: 'audit_ambiguous',
      entryId: null,
      fieldsChanged: null,
    })
    return
  }

  if (outcome.kind === 'unmatched') {
    const identifier = row.mainNumber ?? row.ubblNumber ?? '(none)'
    await raiseException(client, batchId, exceptions, {
      type: 'audit_row_unmatched',
      severity: 'medium',
      description:
        `Audit entry "${identifier}"${row.vendorRaw ? ` (${row.vendorRaw})` : ''} has no corresponding Hub entry. ` +
        `The usual cause is ordering: the Audit portal was scraped before today's Departmental export was imported, ` +
        `so no entry carries this number in main_number yet. Import the export, then scrape again. ` +
        `If it persists after that, the two sides genuinely disagree about this entry and it needs a human. ` +
        `It will also be re-attempted automatically on every later Departmental import (docs/hub-refinements-plan.md §4).`,
      dedupKey: `audit_row_unmatched:${identifier}`,
      amountAtRisk: row.amount,
    })
    await logRow(client, batchId, rowLog, {
      rowNumber: row.rowNumber,
      rawRow: row.rawRow,
      action: 'audit_unmatched',
      entryId: null,
      fieldsChanged: null,
    })
    return
  }

  await logRow(client, batchId, rowLog, {
    rowNumber: row.rowNumber,
    rawRow: row.rawRow,
    action: outcome.fieldsChanged ? 'audit_status_updated' : 'audit_status_unchanged',
    entryId: outcome.entryId,
    fieldsChanged: outcome.fieldsChanged,
  })
}

/**
 * Re-attempts matching for every Audit row still sitting as an open
 * `audit_row_unmatched` exception, against the CURRENT state of `entries`
 * (docs/hub-refinements-plan.md §4).
 *
 * WHY THIS RUNS FROM run-import.ts, NOT HERE
 *
 * An unmatched Audit row is waiting on a `main_number` that only a
 * Departmental import can supply (this file's header: "Departmental import
 * must run before the Audit scrape"). A Departmental commit is therefore
 * exactly the moment a stale Audit exception is most likely to resolve
 * itself — so run-import.ts's commit path calls this, inside its own
 * transaction, after its own row loop has had a chance to create/update the
 * entry the Audit row was waiting for. Called ONLY on commit (never
 * dry_run): a dry run rolls every write back anyway, and driving this
 * against a transaction that is about to be discarded would just be wasted
 * queries against nothing durable.
 *
 * WHY REJOIN THROUGH scrape_payload_jsonb INSTEAD OF RE-SCRAPING
 *
 * The row data an unmatched exception needs was never lost — the scrape
 * that produced it wrote its entire original payload to
 * `import_batch.scrape_payload_jsonb` (see runPortalImport above). Re-parsing
 * that payload with the same `parsePortalTable` the original scrape used
 * reproduces the identical row deterministically, so no re-scrape is needed
 * to retry it.
 *
 * Each exception is resolved independently and left untouched on any
 * failure to correlate it back to a row (older exception predating this
 * feature, a batch inserted through a path that never set
 * scrape_payload_jsonb, or the identifier no longer present in that batch's
 * rows) — one unrecoverable exception must never abort the whole
 * Departmental import.
 */
export async function retryUnmatchedAuditRows(
  client: PoolClient,
  caches: ResolverCaches,
  batchId: number,
  exceptions: ImportExceptionSummary[]
): Promise<{ resolvedCount: number }> {
  const openExceptions = await client.query<{
    id: number
    dedup_key: string
    import_batch_id: number | null
  }>(
    `select id, dedup_key, import_batch_id
       from public.reconciliation_exception
      where status = 'open' and exception_type = 'audit_row_unmatched'`
  )

  let resolvedCount = 0

  for (const exception of openExceptions.rows) {
    const identifier = parseAuditRowUnmatchedIdentifier(exception.dedup_key)
    if (!identifier || exception.import_batch_id === null) continue

    const batchRow = await client.query<{ scrape_payload_jsonb: ScrapePayload | null }>(
      `select scrape_payload_jsonb from public.import_batch where id = $1`,
      [exception.import_batch_id]
    )
    const payload = batchRow.rows[0]?.scrape_payload_jsonb ?? null
    // Older exception, or a batch inserted via a path that never set this
    // column — nothing to re-parse. Skip, don't throw: this must not abort
    // the Departmental import that is currently mid-commit.
    if (!payload) continue

    const row = findPortalRowByIdentifier(
      { headers: payload.headers, rows: payload.rows, sourceSystem: payload.sourceSystem },
      identifier
    )
    if (!row) continue

    const outcome = await attemptAuditRowMatch(client, caches, batchId, row, exceptions)
    // Still ambiguous or still unmatched: per the task's point 5, leave the
    // exception exactly as it is rather than refreshing/re-raising it. The
    // ON CONFLICT ... WHERE status = 'open' pattern in raiseException already
    // handles "still open" naturally for the paths that go through it; this
    // path just does nothing, which is simpler and has the same effect.
    if (outcome.kind !== 'matched') continue

    // 'resolved', not 'dismissed': this codebase's other use of 'dismissed'
    // (lib/jobs/handlers/extract.ts, the re-run-supersedes-prior-findings
    // block) marks a finding as no longer relevant because something ELSE
    // replaced it. Here the exact same finding is now genuinely fixed — the
    // row matched, the update was applied — so 'resolved' is the accurate
    // outcome. resolved_by stays null (nullable per
    // supabase/migrations/20260808000023_reconciliation_exception.sql,
    // `resolved_by uuid references auth.users(id)` with no NOT NULL): no
    // human resolved this.
    await client.query(
      `update public.reconciliation_exception
          set status = 'resolved',
              entry_id = coalesce(entry_id, $2),
              resolved_at = now(),
              resolution_note = $3
        where id = $1`,
      [
        exception.id,
        outcome.entryId,
        `Auto-matched by a later Departmental import (batch ${batchId}) — the entry's main_number ` +
          `now links to it. No human resolved this (docs/hub-refinements-plan.md §4).`,
      ]
    )
    resolvedCount++
  }

  return { resolvedCount }
}

/**
 * One Departmental-portal row. Upserts on ubbl_number, keeping the fields the
 * portal actually shows current between .xlsx imports.
 *
 * Deliberately does not touch budget_head_id, department_id, budget_allocation
 * or any Hub-owned enrichment column (zone_id, admin_head_id, cost_center_id,
 * remark, hub_status_*) — see this file's header.
 *
 * `tableKind` is the Dept-module tab this row's batch was scraped from
 * (detectDepartmentalTableKind, computed once per batch in
 * runPortalImport) — now the authoritative source for `entries.type` and
 * for whether `entries.amount` should read the tab's Uplaq/Advance Amount
 * column instead of its plain Amount column. The UBBL-prefix rule
 * (deriveEntryType) becomes a secondary cross-check only, see
 * `entry_type_kind_mismatch` below.
 */
async function importDepartmentalRow(
  client: PoolClient,
  caches: ResolverCaches,
  batchId: number,
  eventId: number,
  row: ParsedPortalRow,
  rowLog: ImportRowLogEntry[],
  exceptions: ImportExceptionSummary[],
  tableKind: 'invoice' | 'reimbursement' | 'advance_payment'
): Promise<void> {
  if (!row.ubblNumber) {
    // parsePortalTable only reaches here with an identifier, and on the
    // departmental side that identifier is the UBBL number by construction.
    await logRow(client, batchId, rowLog, {
      rowNumber: row.rowNumber,
      rawRow: row.rawRow,
      action: 'skipped_no_identifier',
      entryId: null,
      fieldsChanged: null,
    })
    return
  }

  let vendorId: number | null = null
  let vendorCreated = false
  if (row.vendorRaw) {
    const resolved = await resolveVendor(client, caches, row.vendorRaw)
    vendorId = resolved.id
    vendorCreated = resolved.created
  }

  const statusId = await resolvePortalStatus(
    client,
    caches,
    row.status,
    'departmental',
    batchId,
    exceptions
  )
  const auditStatusId = await resolvePortalStatus(
    client,
    caches,
    row.auditStatus,
    'audit',
    batchId,
    exceptions
  )

  const before = await client.query<MatchedEntry>(
    `select ${ENTRY_COLUMNS} from public.entries where ubbl_number = $1`,
    [row.ubblNumber]
  )
  const existing = before.rows[0] ?? null

  // On the Advance Payment tab, entries.amount holds the tab's Uplaq Amount
  // figure (per the user's decision, see the migration's comment on
  // advance_payment_detail.invoice_amount) — the tab's own Invoice Amount
  // column lands separately, in advance_payment_detail below, from the RAW
  // row.amount rather than this effective value.
  const effectiveAmount = tableKind === 'advance_payment' ? row.uplaqAmount : row.amount

  const upserted = await client.query<{ id: number }>(
    `insert into public.entries (
       type, ubbl_number, main_number, invoice_number, vendor_id, vendor_raw,
       date, amount, status_id, audit_status_id, status_raw, audit_status_raw,
       source, import_batch_id, event_id, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'import', $13, $14, now())
     on conflict (ubbl_number) do update set
       main_number      = coalesce(excluded.main_number, entries.main_number),
       invoice_number   = coalesce(excluded.invoice_number, entries.invoice_number),
       vendor_id        = coalesce(excluded.vendor_id, entries.vendor_id),
       vendor_raw       = coalesce(excluded.vendor_raw, entries.vendor_raw),
       date             = coalesce(excluded.date, entries.date),
       amount           = coalesce(excluded.amount, entries.amount),
       status_id        = coalesce(excluded.status_id, entries.status_id),
       audit_status_id  = coalesce(excluded.audit_status_id, entries.audit_status_id),
       status_raw       = coalesce(excluded.status_raw, entries.status_raw),
       audit_status_raw = coalesce(excluded.audit_status_raw, entries.audit_status_raw),
       import_batch_id  = excluded.import_batch_id,
       updated_at       = now()
     returning id`,
    [
      tableKind,
      row.ubblNumber,
      row.mainNumber,
      row.invoiceNumber,
      vendorId,
      row.vendorRaw,
      row.date,
      effectiveAmount,
      statusId,
      auditStatusId,
      row.status?.raw ?? null,
      row.auditStatus?.raw ?? null,
      batchId,
      eventId,
    ]
  )
  const entryId = upserted.rows[0]!.id

  // Defense-in-depth cross-check: the UBBL-prefix rule and the scraped tab
  // kind should always agree. Flag-only, matching this file's existing
  // unknown_status_code/allocation_sum_mismatch pattern — never blocks the
  // row, which is still processed as `tableKind` (the tab it was actually
  // scraped from, the more trustworthy signal since it reflects which grid
  // the operator was looking at, not a string-prefix heuristic).
  const prefixType = deriveEntryType(row.ubblNumber)
  if (prefixType !== tableKind) {
    await raiseException(client, batchId, exceptions, {
      type: 'entry_type_kind_mismatch',
      severity: 'low',
      entryId,
      description:
        `Entry ${row.ubblNumber} was scraped from the ${tableKind} tab, but its UBBL prefix matches ` +
        `the ${prefixType} pattern. It was still processed as ${tableKind}, the tab it came from.`,
      dedupKey: `entry_type_kind_mismatch:${row.ubblNumber}`,
    })
  }

  // COALESCE on every updated column, unlike the .xlsx path's straight
  // assignment: a scrape reads only what the portal happens to render on that
  // screen, so a column the grid does not show arrives as null. Assigning it
  // would blank a value the export had already established. The .xlsx import
  // sees the full row and is still free to overwrite.

  let action: ImportRowAction
  let fieldsChanged: Record<string, { from: unknown; to: unknown }> | null = null

  if (!existing) {
    action = vendorCreated ? 'new_vendor' : 'inserted'
    // A scraped entry arrives with no budget head, because the portal's own
    // Budget Head column cannot be mapped to `budget_head` with confidence
    // (see portal-mapping.ts). Flagged so it is visibly incomplete until the
    // next .xlsx import classifies it, rather than quietly sitting outside
    // every budget report.
    await raiseException(client, batchId, exceptions, {
      type: 'new_budget_head',
      severity: 'low',
      entryId,
      description:
        `Entry ${row.ubblNumber} was created from a portal scrape and has no budget head. ` +
        `The portal shows "${row.budgetHeadRaw ?? 'nothing'}", which does not map to a budget_head row on its own. ` +
        `The next Departmental .xlsx import will classify it.`,
      dedupKey: `new_budget_head:scrape:${row.ubblNumber}`,
    })
  } else {
    const after = {
      main_number: row.mainNumber ?? existing.main_number,
      invoice_number: row.invoiceNumber ?? existing.invoice_number,
      vendor_id: vendorId ?? existing.vendor_id,
      vendor_raw: row.vendorRaw ?? existing.vendor_raw,
      date: row.date ?? existing.date,
      amount: effectiveAmount ?? (existing.amount === null ? null : Number(existing.amount)),
      status_id: statusId ?? existing.status_id,
      status_raw: row.status?.raw ?? existing.status_raw,
    }
    const existingComparable = {
      main_number: existing.main_number,
      invoice_number: existing.invoice_number,
      vendor_id: existing.vendor_id,
      vendor_raw: existing.vendor_raw,
      date: existing.date,
      amount: existing.amount === null ? null : Number(existing.amount),
      status_id: existing.status_id,
      status_raw: existing.status_raw,
    }
    const diff: Record<string, { from: unknown; to: unknown }> = {}
    for (const key of Object.keys(after) as (keyof typeof after)[]) {
      if (existingComparable[key] !== after[key]) {
        diff[key] = { from: existingComparable[key], to: after[key] }
      }
    }
    fieldsChanged = Object.keys(diff).length > 0 ? diff : null
    if (vendorCreated) action = 'new_vendor'
    else action = fieldsChanged ? 'updated' : 'unchanged'
  }

  // Reimbursement/advance_payment rows carry a few columns invoice-shaped
  // `entries` has no room for — write them to the matching 1:1 extension
  // table. Invoice rows have no extension table (every column their tab has
  // already exists on `entries`), so there is nothing to do for them.
  if (tableKind !== 'invoice') {
    await upsertDetailTable(client, caches, batchId, entryId, tableKind, row)
  }

  await logRow(client, batchId, rowLog, {
    rowNumber: row.rowNumber,
    rawRow: row.rawRow,
    action,
    entryId,
    fieldsChanged,
  })
}

/**
 * Upserts the type-specific extension row for a reimbursement or
 * advance_payment entry (`public.reimbursement_detail` /
 * `public.advance_payment_detail`, entry_id PK, 1:1 with `entries`).
 *
 * Same COALESCE-on-conflict discipline as the `entries` upsert above: a
 * scrape only shows what is on screen for that tab right now, so a column
 * the grid doesn't render for this row arrives null and must not blank a
 * value a previous scrape already established. import_batch_id and
 * updated_at are the exception — those always take the latest scrape's
 * values, same as the `entries` upsert's own import_batch_id/updated_at.
 */
async function upsertDetailTable(
  client: PoolClient,
  caches: ResolverCaches,
  batchId: number,
  entryId: number,
  tableKind: 'reimbursement' | 'advance_payment',
  row: ParsedPortalRow
): Promise<void> {
  if (tableKind === 'reimbursement') {
    let reimburseToVendorId: number | null = null
    if (row.reimburseTo) {
      const resolved = await resolveVendor(client, caches, row.reimburseTo)
      reimburseToVendorId = resolved.id
    }

    await client.query(
      `insert into public.reimbursement_detail
         (entry_id, sr_no, reimbursement_type, reimburse_to_raw, reimburse_to_vendor_id, import_batch_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (entry_id) do update set
         sr_no                  = coalesce(excluded.sr_no, reimbursement_detail.sr_no),
         reimbursement_type     = coalesce(excluded.reimbursement_type, reimbursement_detail.reimbursement_type),
         reimburse_to_raw       = coalesce(excluded.reimburse_to_raw, reimbursement_detail.reimburse_to_raw),
         reimburse_to_vendor_id = coalesce(excluded.reimburse_to_vendor_id, reimbursement_detail.reimburse_to_vendor_id),
         import_batch_id        = excluded.import_batch_id,
         updated_at              = now()`,
      [entryId, row.srNo, row.reimbursementType, row.reimburseTo, reimburseToVendorId, batchId]
    )
    return
  }

  // advance_payment: invoice_amount is the tab's own RAW Invoice Amount
  // column (row.amount), deliberately NOT effectiveAmount — entries.amount
  // already holds the Uplaq Amount for this tab (see the caller's comment on
  // effectiveAmount), and confusing the two here would put the same figure
  // in both places.
  await client.query(
    `insert into public.advance_payment_detail (entry_id, invoice_amount, import_batch_id, updated_at)
     values ($1, $2, $3, now())
     on conflict (entry_id) do update set
       invoice_amount  = coalesce(excluded.invoice_amount, advance_payment_detail.invoice_amount),
       import_batch_id = excluded.import_batch_id,
       updated_at      = now()`,
    [entryId, row.amount, batchId]
  )
}
