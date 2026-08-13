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

  const client = await getPool().connect()
  const caches = newCaches()
  const rowLog: ImportRowLogEntry[] = []
  const exceptions: ImportExceptionSummary[] = []
  const warnings = [...parsed.warnings]

  const batchColumns = `(source_system, source_filename, file_hash_sha256, mode, imported_by,
                         ingest_method, scrape_payload_jsonb, source_url, status)`

  try {
    await client.query('BEGIN')

    const batchInsert = await client.query<{ id: number }>(
      `insert into public.import_batch ${batchColumns}
       values ($1, $2, $3, $4, $5, 'scrape', $6, $7, 'processing')
       returning id`,
      [
        sourceSystem,
        params.filename,
        params.fileHashSha256,
        params.mode,
        params.importedBy,
        JSON.stringify(payload),
        payload.sourceUrl ?? null,
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
          await importDepartmentalRow(client, caches, batchId, row, rowLog, exceptions)
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
          ingest_method, scrape_payload_jsonb, source_url, status, row_count, summary_jsonb, completed_at)
       values ($1, $2, $3, $4, $5, 'scrape', $6, $7, $8, $9, $10, now())
       returning id`,
      [
        sourceSystem,
        params.filename,
        params.fileHashSha256,
        params.mode,
        params.importedBy,
        JSON.stringify(payload),
        payload.sourceUrl ?? null,
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
          ingest_method, source_url, status, error_message, completed_at)
       values ($1, $2, $3, $4, $5, 'scrape', $6, 'failed', $7, now())
       returning id`,
      [
        sourceSystem,
        params.filename,
        params.fileHashSha256,
        params.mode,
        params.importedBy,
        payload.sourceUrl ?? null,
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
  const { entry, ambiguous } = await findEntry(client, row)

  if (ambiguous) {
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

  if (!entry) {
    const identifier = row.mainNumber ?? row.ubblNumber ?? '(none)'
    await raiseException(client, batchId, exceptions, {
      type: 'audit_row_unmatched',
      severity: 'medium',
      description:
        `Audit entry "${identifier}"${row.vendorRaw ? ` (${row.vendorRaw})` : ''} has no corresponding Hub entry. ` +
        `The usual cause is ordering: the Audit portal was scraped before today's Departmental export was imported, ` +
        `so no entry carries this number in main_number yet. Import the export, then scrape again. ` +
        `If it persists after that, the two sides genuinely disagree about this entry and it needs a human.`,
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

  await logRow(client, batchId, rowLog, {
    rowNumber: row.rowNumber,
    rawRow: row.rawRow,
    action: Object.keys(fieldsChanged).length > 0 ? 'audit_status_updated' : 'audit_status_unchanged',
    entryId: entry.id,
    fieldsChanged: Object.keys(fieldsChanged).length > 0 ? fieldsChanged : null,
  })
}

/**
 * One Departmental-portal row. Upserts on ubbl_number, keeping the fields the
 * portal actually shows current between .xlsx imports.
 *
 * Deliberately does not touch budget_head_id, department_id, budget_allocation
 * or any Hub-owned enrichment column (zone_id, admin_head_id, cost_center_id,
 * remark, hub_status_*) — see this file's header.
 */
async function importDepartmentalRow(
  client: PoolClient,
  caches: ResolverCaches,
  batchId: number,
  row: ParsedPortalRow,
  rowLog: ImportRowLogEntry[],
  exceptions: ImportExceptionSummary[]
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

  const upserted = await client.query<{ id: number }>(
    `insert into public.entries (
       type, ubbl_number, main_number, invoice_number, vendor_id, vendor_raw,
       date, amount, status_id, audit_status_id, status_raw, audit_status_raw,
       source, import_batch_id, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'import', $13, now())
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
      deriveEntryType(row.ubblNumber),
      row.ubblNumber,
      row.mainNumber,
      row.invoiceNumber,
      vendorId,
      row.vendorRaw,
      row.date,
      row.amount,
      statusId,
      auditStatusId,
      row.status?.raw ?? null,
      row.auditStatus?.raw ?? null,
      batchId,
    ]
  )
  const entryId = upserted.rows[0]!.id

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
      amount: row.amount ?? (existing.amount === null ? null : Number(existing.amount)),
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

  await logRow(client, batchId, rowLog, {
    rowNumber: row.rowNumber,
    rawRow: row.rawRow,
    action,
    entryId,
    fieldsChanged,
  })
}
