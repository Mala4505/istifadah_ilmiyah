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
 *                Writes the shared status_id / status_raw plus audit_synced_at
 *                and nothing else. Never inserts an entry: an Audit row with
 *                no Hub counterpart is a reconciliation finding, not a licence
 *                to invent a half-populated entry with no budget head, no
 *                department and no allocation to tally against.
 *
 *   departmental Upserts entries on ubbl_number, keeping identity, money,
 *                dates, vendor and departmental status current between .xlsx
 *                imports. It ALSO resolves department_id and budget_head_id
 *                from the tab's own DEPARTMENT and BUDGET HEAD columns, via
 *                the same resolvers the .xlsx path uses — see the
 *                classification block in importDepartmentalRow for why this
 *                portal (unlike the Audit one) renders a budget head that
 *                can be trusted. It still does NOT write budget_allocation:
 *                per §3.5 allocations only ever arrive as a snapshot from
 *                the export, so the .xlsx import remains the source of truth
 *                there and the scrape keeps the rest fresh daily.
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  getPool,
  newCaches,
  resolveBudgetHead,
  resolveDepartment,
  resolveMutableEventId,
  resolveStatus,
  resolveVendor,
  writeRowLogBatch,
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
  status_id: number | null
  status_raw: string | null
  invoice_number: string | null
  vendor_id: number | null
  vendor_raw: string | null
  date: string | null
  type: string
}

const ENTRY_COLUMNS = `id, ubbl_number, main_number, amount,
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

interface PendingException {
  type: string
  severity: 'low' | 'medium' | 'high'
  description: string
  dedupKey: string
  entryId?: number | null
  amountAtRisk?: number | null
}

/**
 * Records a finding. Buffered, not written — `flushExceptions` below does the
 * single INSERT once the row loop is done.
 *
 * Every caller already treats raising an exception as fire-and-forget: none
 * reads back the inserted row, and none branches on whether the insert
 * conflicted. So the only thing the per-call `await` bought was a round trip
 * per finding — 67 of them on the 64-row scrape measured 2026-08-28. Kept
 * synchronous (no promise) so a forgotten `await` can't silently drop a
 * finding.
 */
function raiseException(
  pending: PendingException[],
  exceptionsOut: ImportExceptionSummary[],
  input: PendingException
): void {
  pending.push(input)
  exceptionsOut.push({
    exceptionType: input.type,
    severity: input.severity,
    description: input.description,
  })
}

/**
 * Writes every buffered finding in one statement.
 *
 * Deduped by `dedupKey` FIRST, keeping the last occurrence: Postgres refuses
 * an `ON CONFLICT DO UPDATE` that would touch the same row twice in one
 * statement ("cannot affect row a second time"), and a single scrape can
 * genuinely raise the same key twice — e.g. two rows sharing a vendor that
 * trips the same finding. The per-call version never hit this because each
 * insert was its own statement; batching makes it reachable, so it is handled
 * here rather than left as a latent crash.
 *
 * Dedup discipline is otherwise unchanged from the original (2026-08-13 fix):
 * batchId is deliberately NOT part of the key, so re-importing the same
 * unresolved finding refreshes the existing open row instead of spawning a
 * duplicate on every scrape — and never reopens one a human has resolved.
 */
async function flushExceptions(
  client: PoolClient,
  batchId: number,
  pending: readonly PendingException[]
): Promise<void> {
  if (pending.length === 0) return

  const byKey = new Map<string, PendingException>()
  for (const e of pending) byKey.set(e.dedupKey, e)
  const unique = [...byKey.values()]

  const CHUNK = 500
  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK)
    const values: unknown[] = []
    const tuples = chunk.map((e, i) => {
      const b = i * 7
      values.push(
        batchId,
        e.entryId ?? null,
        e.type,
        e.severity,
        e.amountAtRisk ?? null,
        e.description,
        e.dedupKey
      )
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`
    })
    await client.query(
      `insert into public.reconciliation_exception
         (import_batch_id, entry_id, exception_type, severity, amount_at_risk, description, dedup_key)
       values ${tuples.join(', ')}
       on conflict (dedup_key) do update
         set import_batch_id = excluded.import_batch_id,
             description = excluded.description
         where public.reconciliation_exception.status = 'open'`,
      values
    )
  }
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
  // The SLUG is the code, so "Paid", "paid" and " Paid " are one status
  // rather than three rows. The portal's own rendered text rides along as the
  // display label, so a status added by an import arrives already readable and
  // needs no follow-up edit by hand (see resolveStatus's displayLabel).
  return resolveStatus(
    client,
    caches,
    status.code,
    sourceSystem,
    batchId,
    exceptionsOut,
    status.raw
  )
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
  // Findings and row-log entries are buffered here and written once, after the
  // row loop, instead of a round trip each — see raiseException/logRow.
  const pendingExceptions: PendingException[] = []
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

    /**
     * Every entry this batch could touch, fetched in ONE query instead of a
     * SELECT per row.
     *
     * The row loop needs each entry's prior state to compute the
     * inserted/updated/unchanged diff. Asking for them one at a time was a
     * round trip per row — 64 of them on the invoice tab, against a pooler
     * measured at 6.1ms, so ~0.4s of an import spent re-asking questions one
     * key at a time.
     *
     * A row is REMOVED from this map once processed, so a scrape that somehow
     * lists the same UBBL twice falls back to a live read for the second
     * occurrence rather than diffing against a snapshot the first pass has
     * already invalidated. That keeps the batched path exactly as correct as
     * the per-row one, including in the pathological case.
     */
    const prefetchedEntries = new Map<string, MatchedEntry>()
    if (sourceSystem === 'departmental') {
      const ubblNumbers = parsed.rows
        .filter((r) => !r.skipReason && r.ubblNumber)
        .map((r) => r.ubblNumber as string)
      if (ubblNumbers.length > 0) {
        const existingRows = await client.query<MatchedEntry>(
          `select ${ENTRY_COLUMNS} from public.entries where ubbl_number = any($1::text[])`,
          [ubblNumbers]
        )
        for (const found of existingRows.rows) prefetchedEntries.set(found.ubbl_number, found)
      }
    }

    for (const row of parsed.rows) {
      try {
        if (row.skipReason) {
          const action: ImportRowAction =
            row.skipReason === 'total_row' ? 'skipped_total' : 'skipped_no_identifier'
          logRow(rowLog, {
            rowNumber: row.rowNumber,
            rawRow: row.rawRow,
            action,
            entryId: null,
            fieldsChanged: null,
          })
          continue
        }

        if (sourceSystem === 'audit') {
          await importAuditRow(client, caches, batchId, row, rowLog, exceptions, pendingExceptions)
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
            pendingExceptions,
            tableKind!,
            prefetchedEntries
          )
        }
      } catch (rowError) {
        const message = rowError instanceof Error ? rowError.message : String(rowError)
        logRow(rowLog, {
          rowNumber: row.rowNumber,
          rawRow: row.rawRow,
          action: 'error',
          entryId: null,
          fieldsChanged: null,
          note: message,
        })
      }
    }

    // One INSERT each for the row log and the findings, rather than one per
    // row. Inside the same transaction as the row writes, so a dry run still
    // rolls both back and a commit still lands them atomically.
    await writeRowLogBatch(client, batchId, rowLog)
    await flushExceptions(client, batchId, pendingExceptions)

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

/**
 * Records one row's outcome. Buffered, not written — `writeRowLogBatch`
 * flushes the whole log in one INSERT once the loop is done. Synchronous for
 * the same reason as `raiseException`: nothing downstream reads the log back,
 * so an `await` here only ever bought a round trip per row.
 */
function logRow(rowLog: ImportRowLogEntry[], entry: ImportRowLogEntry): void {
  rowLog.push(entry)
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
  exceptions: ImportExceptionSummary[],
  pendingExceptions: PendingException[]
): Promise<AuditRowMatchOutcome> {
  const { entry, ambiguous } = await findEntry(client, row)
  if (ambiguous) return { kind: 'ambiguous' }
  if (!entry) return { kind: 'unmatched' }

  // The Audit portal's status chip, whichever column it came from: on that
  // portal the plain "Status" column IS the state. A dedicated "Audit Status"
  // column, if one ever appears, still wins.
  //
  // This now writes THE status (20260828000001), not a second one parallel to
  // the Departmental one. The Audit portal is downstream of the Departmental
  // one, so when it reports on a row the Hub already has, its word is the
  // later one and simply replaces what is there.
  const auditChip = row.auditStatus ?? row.status
  const verificationChip = row.verificationStatus

  const statusId = await resolvePortalStatus(
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
    status_id: entry.status_id,
    status_raw: entry.status_raw,
  }
  const after = {
    // Fill main_number in if the Hub has never seen it; never overwrite a
    // value the Departmental export already established.
    main_number: entry.main_number ?? row.mainNumber,
    status_id: statusId ?? entry.status_id,
    status_raw: auditChip?.raw ?? entry.status_raw,
  }

  const fieldsChanged: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(after) as (keyof typeof after)[]) {
    if (before[key] !== after[key]) fieldsChanged[key] = { from: before[key], to: after[key] }
  }

  // audit_synced_at / audit_sync_batch_id survive the status merge: they
  // answer "when did the Audit side last confirm this row, and in which
  // batch", which stays meaningful even though the status itself is now
  // shared. status_changed_at is only bumped on an actual change, same
  // conditional the audit-specific column used to carry.
  await client.query(
    `update public.entries
        set main_number      = $1,
            status_id        = coalesce($2, status_id),
            status_raw       = coalesce($3, status_raw),
            audit_synced_at  = now(),
            audit_sync_batch_id = $4,
            updated_at       = now()
      where id = $5`,
    [after.main_number, after.status_id, after.status_raw, batchId, entry.id]
  )

  // Amount disagreement between the two sides is exactly what
  // 'tenant_vs_main_variance' exists for (§3.4) — the Audit portal is the
  // "main" side. Reported, never auto-corrected: which side is right is a
  // human judgment, and silently overwriting entries.amount from a scrape
  // would destroy the evidence that they ever disagreed.
  const hubAmount = entry.amount === null ? null : Number(entry.amount)
  if (moneyDiffers(hubAmount, row.amount)) {
    raiseException(pendingExceptions, exceptions, {
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
  exceptions: ImportExceptionSummary[],
  pendingExceptions: PendingException[]
): Promise<void> {
  const outcome = await attemptAuditRowMatch(client, caches, batchId, row, exceptions, pendingExceptions)

  if (outcome.kind === 'ambiguous') {
    const identifier = row.mainNumber ?? row.ubblNumber ?? '(none)'
    raiseException(pendingExceptions, exceptions, {
      type: 'audit_ambiguous_match',
      severity: 'high',
      description: `Audit row "${identifier}" matched more than one Hub entry; no audit status was written. Resolve the duplicate entries first.`,
      dedupKey: `audit_ambiguous_match:${identifier}`,
      amountAtRisk: row.amount,
    })
    logRow(rowLog, {
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
    raiseException(pendingExceptions, exceptions, {
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
    logRow(rowLog, {
      rowNumber: row.rowNumber,
      rawRow: row.rawRow,
      action: 'audit_unmatched',
      entryId: null,
      fieldsChanged: null,
    })
    return
  }

  logRow(rowLog, {
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
  // Owns its own findings buffer and flushes before returning, so the
  // .xlsx caller's signature is unchanged by the batching work. The only
  // findings reachable from here are the tenant_vs_main_variance ones
  // attemptAuditRowMatch may raise on a now-matched row.
  const pendingExceptions: PendingException[] = []

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

    const outcome = await attemptAuditRowMatch(client, caches, batchId, row, exceptions, pendingExceptions)
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

  await flushExceptions(client, batchId, pendingExceptions)
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
  pendingExceptions: PendingException[],
  tableKind: 'invoice' | 'reimbursement' | 'advance_payment' | 'invoice_against_uplaq',
  /** Batch-wide snapshot of pre-existing entries; see runPortalImport. */
  prefetchedEntries: Map<string, MatchedEntry>
): Promise<void> {
  if (!row.ubblNumber) {
    // parsePortalTable only reaches here with an identifier, and on the
    // departmental side that identifier is the UBBL number by construction.
    logRow(rowLog, {
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

  /**
   * THE status for this row — one column, one value (20260828000001).
   *
   * The Departmental portal's own STATUS column already carries the
   * audit-side state: confirmed 2026-08-28 against a real scrape of all
   * three tabs, whose STATUS values include "Paid", "Received" and "Tax
   * Invoice Upload Pending (Paid)" — audit workflow states, rendered on the
   * Departmental screen. The Dept module is fed the Audit module's status
   * directly, so a Departmental scrape alone keeps the status current and
   * scraping the Audit portal is a cross-check rather than a prerequisite.
   *
   * A dedicated Audit Status column still wins if a portal ever renders one
   * alongside the plain Status column — it would be the more specific
   * signal — but neither is written to a second column any more.
   */
  const statusChip = row.auditStatus ?? row.status
  const statusId = await resolvePortalStatus(
    client,
    caches,
    statusChip,
    'departmental',
    batchId,
    exceptions
  )

  /**
   * Classification, resolved from the two columns the Departmental portal
   * actually renders.
   *
   * This file's header used to say the scrape never writes department_id or
   * budget_head_id. That was right for the AUDIT portal and wrong for this
   * one, and the blanket rule cost every scraped row its classification:
   * each new entry landed with no budget head and a `new_budget_head`
   * finding attached (25 of them on the advance-payment tab alone,
   * 2026-08-28) that a human then had to read and ignore.
   *
   * The two portals genuinely differ, which is what the original note
   * conflated:
   *   - Audit portal:        "Budget Head" reads "Venue Setup" — just the
   *                          department name again, nothing to extract.
   *   - Departmental portal: "Budget Head" reads "Venue setup (Power)" —
   *                          the exact "<department> (<short label>)" shape
   *                          the .xlsx export uses and that
   *                          parseBudgetHeadShortLabel already parses, and
   *                          the row carries its own DEPARTMENT column
   *                          ("Venue Setup") alongside it.
   *
   * So on THIS side the data needed is present and in a known shape, and it
   * goes through the very same resolveDepartment/resolveBudgetHead the
   * .xlsx path uses — one definition of "resolve a budget head", matching
   * on (department_id, short_label) so the portal's inconsistent department
   * casing can't fork a duplicate (see resolveBudgetHead).
   *
   * Department comes from the DEPARTMENT column, never from splitting the
   * budget-head string: that mirrors the .xlsx path, where department is
   * likewise its own column. budget_allocation is still untouched — that
   * only ever arrives as a snapshot from the export (§3.5).
   */
  let departmentId: number | null = null
  let budgetHeadId: number | null = null
  if (row.departmentRaw) {
    departmentId = await resolveDepartment(client, caches, row.departmentRaw, eventId)
  }
  if (row.budgetHeadRaw) {
    const resolvedHead = await resolveBudgetHead(
      client,
      caches,
      row.budgetHeadRaw,
      departmentId,
      batchId,
      eventId
    )
    budgetHeadId = resolvedHead.id
  }

  // Consume the batch snapshot; a repeated UBBL inside one scrape misses it
  // (deleted below) and falls back to a live read, so the diff is never taken
  // against state this same batch has already changed.
  let existing = prefetchedEntries.get(row.ubblNumber) ?? null
  if (!existing && !prefetchedEntries.has(row.ubblNumber)) {
    const before = await client.query<MatchedEntry>(
      `select ${ENTRY_COLUMNS} from public.entries where ubbl_number = $1`,
      [row.ubblNumber]
    )
    existing = before.rows[0] ?? null
  }
  prefetchedEntries.delete(row.ubblNumber)

  // On the Advance Payment tab, entries.amount holds the tab's Uplaq Amount
  // figure (per the user's decision, see the migration's comment on
  // advance_payment_detail.invoice_amount) — the tab's own Invoice Amount
  // column lands separately, in advance_payment_detail below, from the RAW
  // row.amount rather than this effective value.
  // advance_payment is the one tab whose entries.amount is NOT its Invoice
  // Amount column (it holds Uplaq Amount, per the user's decision -- see
  // advance_payment_detail.invoice_amount). Every other tab, IAU included,
  // stores its own Invoice Amount here; IAU's extra BALANCE PAYABLE figure
  // lands in invoice_against_uplaq_detail below.
  const effectiveAmount = tableKind === 'advance_payment' ? row.uplaqAmount : row.amount

  const upserted = await client.query<{ id: number }>(
    `insert into public.entries (
       type, ubbl_number, main_number, invoice_number, vendor_id, vendor_raw,
       date, amount, status_id, status_raw,
       department_id, budget_head_id,
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
       status_raw       = coalesce(excluded.status_raw, entries.status_raw),
       department_id    = coalesce(excluded.department_id, entries.department_id),
       budget_head_id   = coalesce(excluded.budget_head_id, entries.budget_head_id),
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
      statusChip?.raw ?? null,
      departmentId,
      budgetHeadId,
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
    raiseException(pendingExceptions, exceptions, {
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
    // Only worth a finding when the row genuinely ended up unclassified.
    // This used to fire on EVERY newly-scraped entry, because the scrape
    // never resolved a budget head at all — 25 identical low-severity rows
    // on one advance-payment tab, none of them actionable, which is exactly
    // the noise that trains an operator to skim past findings that matter.
    // Now that classification is resolved above, an entry reaching here
    // without one means the portal really did render no Budget Head cell
    // (the reimbursement tab has no such column) or no Department to scope
    // it to — a real gap, and rare.
    if (budgetHeadId === null) {
      raiseException(pendingExceptions, exceptions, {
        type: 'new_budget_head',
        severity: 'low',
        entryId,
        description:
          `Entry ${row.ubblNumber} was created from a portal scrape with no budget head. ` +
          `The portal showed "${row.budgetHeadRaw ?? 'nothing'}" as its Budget Head and ` +
          `"${row.departmentRaw ?? 'nothing'}" as its Department. ` +
          `The next Departmental .xlsx import will classify it.`,
        dedupKey: `new_budget_head:scrape:${row.ubblNumber}`,
      })
    }
  } else {
    const after = {
      main_number: row.mainNumber ?? existing.main_number,
      invoice_number: row.invoiceNumber ?? existing.invoice_number,
      vendor_id: vendorId ?? existing.vendor_id,
      vendor_raw: row.vendorRaw ?? existing.vendor_raw,
      date: row.date ?? existing.date,
      amount: effectiveAmount ?? (existing.amount === null ? null : Number(existing.amount)),
      status_id: statusId ?? existing.status_id,
      status_raw: statusChip?.raw ?? existing.status_raw,
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

  logRow(rowLog, {
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
  tableKind: 'reimbursement' | 'advance_payment' | 'invoice_against_uplaq',
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

  if (tableKind === 'invoice_against_uplaq') {
    await client.query(
      `insert into public.invoice_against_uplaq_detail
         (entry_id, balance_payable, import_batch_id, updated_at)
       values ($1, $2, $3, now())
       on conflict (entry_id) do update set
         balance_payable = coalesce(excluded.balance_payable, invoice_against_uplaq_detail.balance_payable),
         import_batch_id = excluded.import_batch_id,
         updated_at      = now()`,
      [entryId, row.balancePayable, batchId]
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
