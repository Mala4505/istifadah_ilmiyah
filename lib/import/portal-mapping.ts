/**
 * Scraped-portal table row -> entry-fields transform (MASTER-PLAN §3.6, §17.23,
 * Phase 3 item 1).
 *
 * Pure row-shape transformation only — no database connection, no DOM, no
 * Supabase client. The bookmarklet (public/bookmarklet/read-portal.js) reads a
 * portal's on-screen table and POSTs `{ headers, rows }` to
 * /api/import/portal; this module turns that generic shape into the same
 * parsed-entry vocabulary `lib/module-mapping.ts` produces for the .xlsx
 * export, so `runImport` can drive either source through one code path.
 *
 * ---------------------------------------------------------------------------
 * WHY HEADER SYNONYMS RATHER THAN FIXED COLUMN INDICES
 *
 * The bookmarklet reads whatever columns the portal happens to render. Column
 * ORDER is a UI detail that changes when someone reorders a grid, and column
 * PRESENCE changes when a portal adds a field (the Audit portal is expected to
 * grow verification-stage statuses — confirmed 2026-08-12). Binding to index
 * would break silently on both. Binding to normalized header TEXT breaks
 * loudly instead: an unrecognised header is reported back in
 * `unmappedHeaders`, and a row with no usable identifier is skipped with a
 * reason, so a portal change surfaces as a visible import warning rather than
 * a column of nulls.
 *
 * WHY THE TWO PORTALS SHARE ONE MAPPER
 *
 * Confirmed 2026-08-13: both the Departmental and Audit portals render the
 * same table structure; only the row set and the status vocabulary differ. The
 * single genuinely ambiguous header is "Entry Number", which is the UBBL
 * number on the Departmental portal and the Main/Audit number on the Audit
 * portal — so it is resolved against `sourceSystem` rather than guessed at.
 *
 * THE AUDIT PORTAL DOES NOT SHOW THE UBBL NUMBER (confirmed 2026-08-13, after
 * an earlier answer that it did). It shows only its own Entry Number. That is
 * survivable, and verified rather than assumed: every one of the eight Entry
 * Numbers in the 2026-08-13 screenshot appears verbatim in the real
 * Departmental export's "Main Entry Number" column, so `entries.main_number`
 * links all of them (see test/unit/portal-linkage.test.ts, which pins that
 * against both real sources). The consequence is an ORDERING REQUIREMENT, not
 * a matching problem: main_number only exists on an entry once the
 * Departmental export has been imported, so the export must be imported before
 * the Audit portal is scraped. That is also the operator workflow you
 * described, so the two agree.
 *
 * The UBBL synonyms below are kept anyway. They cost nothing, and if either
 * portal ever grows a UBBL column the explicit header will simply start
 * winning over the ambiguous generic one with no code change.
 * ---------------------------------------------------------------------------
 */

import { normalizeId } from '@/lib/normalize'

export type SourceSystem = 'departmental' | 'audit'

/** Every field this mapper knows how to pull out of a portal table. */
export type PortalField =
  | 'entryNumber'
  | 'ubblNumber'
  | 'mainNumber'
  | 'invoiceNumber'
  | 'budgetHead'
  | 'department'
  | 'vendor'
  | 'amount'
  | 'status'
  | 'auditStatus'
  | 'verificationStatus'
  | 'date'
  | 'userName'
  | 'remark'

/**
 * Header text -> field. Keys are compared after `normalizeHeader`, so case,
 * spacing, punctuation and trailing sort-arrow glyphs do not matter.
 *
 * The Audit portal's observed header set (screenshot, 2026-08-12) is:
 * Entry Number, Invoice, Budget Head, Vendor, Amount, Status, Date,
 * Department, Action Button. "Action Button" is deliberately absent from this
 * table — it is a control column, and IGNORED_HEADERS below keeps it out of
 * `unmappedHeaders` so a clean import does not report noise.
 */
const HEADER_SYNONYMS: Record<PortalField, readonly string[]> = {
  entryNumber: ['entry number', 'entry no', 'entryno', 'entry', 'srno', 'sr no', 'number'],
  ubblNumber: [
    'ubbl number',
    'ubbl no',
    'ubbl',
    'ubbl entry number',
    'tenant entry number',
    'departmental entry number',
  ],
  mainNumber: [
    'main entry number',
    'main number',
    'main no',
    'main',
    'audit entry number',
    'audit number',
  ],
  invoiceNumber: ['invoice', 'invoice number', 'invoice no', 'inv no', 'bill number', 'bill no'],
  budgetHead: ['budget head', 'budgethead', 'head', 'budget'],
  department: ['department', 'dept', 'anjuman', 'organisation', 'organization'],
  vendor: ['vendor', 'vendor name', 'party', 'party name', 'supplier', 'supplier name'],
  amount: ['amount', 'invoice amount', 'total amount', 'total', 'value'],
  status: ['status', 'entry status', 'departmental status', 'tenant status'],
  auditStatus: ['main status', 'audit status', 'approval status'],
  verificationStatus: [
    'verification status',
    'verification stage',
    'verification',
    'stage',
    'review status',
  ],
  date: ['date', 'invoice date', 'entry date', 'bill date', 'transaction date'],
  userName: ['user name', 'username', 'user', 'created by', 'submitted by'],
  remark: ['remark', 'remarks', 'note', 'notes', 'comment', 'comments', 'reason'],
}

/**
 * Control/presentation columns that carry no data. Matched after
 * `normalizeHeader`, and excluded from `unmappedHeaders` so the import report
 * only ever flags headers a human should actually look at.
 */
const IGNORED_HEADERS: readonly string[] = [
  'action',
  'action button',
  'actions',
  'view',
  'edit',
  'delete',
  'select',
  'checkbox',
  '',
  '#',
]

/**
 * Collapses a rendered header cell to a comparable key: lowercased, with
 * every run of non-alphanumeric characters (including the non-breaking spaces
 * and sort-arrow glyphs a grid injects into its header cells) folded to one
 * space.
 */
export function normalizeHeader(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface HeaderMapping {
  /** field -> the index of the column it reads from. */
  byField: Partial<Record<PortalField, number>>
  /** Headers that matched neither a synonym nor an ignored control column. */
  unmappedHeaders: string[]
  /** Fields whose synonym matched more than one column, with all indices. */
  ambiguousFields: Partial<Record<PortalField, number[]>>
}

/**
 * Resolves a scraped header row to column indices.
 *
 * A field claimed by two columns is NOT silently resolved to the first — it is
 * reported in `ambiguousFields` and the first is used, so the import report
 * can show it. Silently picking one is how "Amount" and "Invoice Amount"
 * quietly become the same column and a variance report goes to zero.
 */
export function mapPortalHeaders(headers: readonly unknown[]): HeaderMapping {
  const byField: Partial<Record<PortalField, number>> = {}
  const hits: Partial<Record<PortalField, number[]>> = {}
  const unmappedHeaders: string[] = []

  headers.forEach((rawHeader, index) => {
    const key = normalizeHeader(rawHeader)
    if (IGNORED_HEADERS.includes(key)) return

    // Longest synonym wins, so "invoice number" beats "invoice" and
    // "audit status" beats "status" regardless of object key order.
    let matched: PortalField | null = null
    let bestLength = -1
    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as [
      PortalField,
      readonly string[],
    ][]) {
      for (const synonym of synonyms) {
        if (synonym === key && synonym.length > bestLength) {
          matched = field
          bestLength = synonym.length
        }
      }
    }

    if (matched === null) {
      unmappedHeaders.push(String(rawHeader ?? '').trim())
      return
    }

    hits[matched] = [...(hits[matched] ?? []), index]
    if (byField[matched] === undefined) byField[matched] = index
  })

  const ambiguousFields: Partial<Record<PortalField, number[]>> = {}
  for (const [field, indices] of Object.entries(hits) as [PortalField, number[]][]) {
    if (indices.length > 1) ambiguousFields[field] = indices
  }

  return { byField, unmappedHeaders, ambiguousFields }
}

// ---------------------------------------------------------------------------
// Cell value parsers
// ---------------------------------------------------------------------------

/** Trim; treat blank, a dash, 'NA' and 'N/A' as absent. */
export function toPortalStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  // Grids routinely render an empty cell as a non-breaking space, which
  // .trim() alone does not remove.
  const str = String(value).replace(/[   ]/g, ' ').trim()
  if (str === '' || str === '-' || str === '—') return null
  const upper = str.toUpperCase()
  if (upper === 'NA' || upper === 'N/A' || upper === 'NULL') return null
  return str
}

/**
 * Parses a rendered money cell to a number.
 *
 * Portals render Indian digit grouping — "14,49,393.00" is fourteen lakh
 * forty-nine thousand three hundred ninety-three, NOT 14.49. Group separators
 * are therefore stripped wholesale rather than interpreted, which is correct
 * for both Indian (2,2,3) and Western (3,3,3) grouping and is why this does
 * not attempt a locale-aware parse.
 *
 * Also handles a leading currency symbol or code, a leading or trailing minus,
 * and accounting-style parenthesised negatives.
 */
export function parsePortalAmount(value: unknown): number | null {
  const raw = toPortalStringOrNull(value)
  if (raw === null) return null

  let text = raw.replace(/^(₹|rs\.?|inr)\s*/i, '').trim()

  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1).trim()
  }
  if (text.startsWith('-')) {
    negative = true
    text = text.slice(1).trim()
  } else if (text.endsWith('-')) {
    negative = true
    text = text.slice(0, -1).trim()
  }

  text = text.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(text)) return null

  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return null
  return negative ? -parsed : parsed
}

/**
 * Parses a rendered date cell to an ISO "YYYY-MM-DD" string.
 *
 * DD/MM/YYYY is assumed — the observed Audit portal renders "05/08/2026" and
 * the Departmental .xlsx export renders DD-MM-YYYY, both Indian convention. An
 * ISO-shaped "YYYY-MM-DD" input is passed through, since that ordering is
 * unambiguous. Anything else returns null rather than guessing: a silently
 * transposed day and month is a far more expensive bug than a null that
 * raises an exception on import.
 *
 * The result is validated as a real calendar date (31/02 returns null) and is
 * built by string arithmetic, never through `new Date(...)`, so no time zone
 * is ever introduced — the same class of bug already fixed once in
 * lib/import/run-import.ts's `types.setTypeParser(1082)` note.
 */
export function parsePortalDate(value: unknown): string | null {
  const raw = toPortalStringOrNull(value)
  if (raw === null) return null

  // Drop a trailing clock time, which some grids append to a date cell.
  const dateOnly = raw.split(/[\sT]/)[0] ?? raw

  const iso = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return isRealDate(+iso[1]!, +iso[2]!, +iso[3]!) ? dateOnly : null

  const dmy = dateOnly.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/)
  if (!dmy) return null

  const day = Number(dmy[1])
  const month = Number(dmy[2])
  const year = Number(dmy[3])
  if (!isRealDate(year, month, day)) return null

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]!
}

export interface ParsedPortalStatus {
  /** The cell exactly as rendered, always preserved for the audit trail. */
  raw: string
  /** Slugified full label, e.g. "tax_invoice_upload_pending_paid". */
  code: string
  /** Slugified label with any trailing parenthetical removed. */
  baseCode: string
  /** Slugified contents of a trailing parenthetical, e.g. "paid", or null. */
  qualifier: string | null
}

/**
 * Parses a rendered status chip.
 *
 * The Audit portal renders compound statuses as "Tax Invoice Upload Pending
 * (Paid)" — a stage plus, in parentheses, the payment state it qualifies.
 * Both halves are kept: `baseCode` is what a status lookup should key on,
 * `qualifier` is the secondary state, and `code` is the whole label slugified
 * so an exact-match seed row can be written for the compound form if that
 * turns out to be how the portal really means it. `raw` is always preserved
 * verbatim, so nothing here is lossy even if the slugging rule later changes.
 */
export function parsePortalStatus(value: unknown): ParsedPortalStatus | null {
  const raw = toPortalStringOrNull(value)
  if (raw === null) return null

  const parenthetical = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/)
  const basePart = parenthetical ? parenthetical[1]!.trim() : raw
  const qualifierPart = parenthetical ? parenthetical[2]!.trim() : null

  return {
    raw,
    code: slugifyStatus(raw),
    baseCode: slugifyStatus(basePart),
    qualifier: qualifierPart ? slugifyStatus(qualifierPart) : null,
  }
}

export function slugifyStatus(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

export interface ParsedPortalRow {
  /** 1-based position in the scraped table, for the import row log. */
  rowNumber: number
  /** The row exactly as scraped, keyed by original header. Never mutated. */
  rawRow: Record<string, string>

  ubblNumber: string | null
  mainNumber: string | null
  invoiceNumber: string | null
  vendorRaw: string | null
  amount: number | null
  date: string | null
  userName: string | null
  remark: string | null

  /**
   * The portal's own Budget Head text. ADVISORY ONLY — see the note on
   * `parsePortalTable`. Never written to `entries.budget_head_id`.
   */
  budgetHeadRaw: string | null
  departmentRaw: string | null

  status: ParsedPortalStatus | null
  auditStatus: ParsedPortalStatus | null
  verificationStatus: ParsedPortalStatus | null

  /** Populated when the row cannot be used; `runImport` logs and skips it. */
  skipReason: 'no_identifier' | 'total_row' | null
}

/** Rows a grid renders as a footer summary rather than data. */
function isTotalRow(cells: readonly string[]): boolean {
  const values = cells.map((c) => normalizeHeader(c)).filter(Boolean)
  if (values.length === 0) return true
  return values.some((c) => c === 'grand total' || c === 'total' || c === 'sum')
}

export interface ParsePortalTableParams {
  headers: readonly string[]
  rows: readonly (readonly string[])[]
  sourceSystem: SourceSystem
}

export interface ParsePortalTableResult {
  mapping: HeaderMapping
  rows: ParsedPortalRow[]
  /** Human-readable problems worth surfacing on the import preview screen. */
  warnings: string[]
}

/**
 * Turns a scraped `{ headers, rows }` payload into parsed rows.
 *
 * DELIBERATE OMISSION — budget head is not resolved here. On the Departmental
 * .xlsx export, "Budget Head" reads "Venue setup (AVIT)" while "Department"
 * reads "Venue Setup"; on the Audit portal, "Budget Head" reads "Venue Setup"
 * and "Department" reads the anjuman name ("Istifada Ilmiyah"). The two
 * portals use the same two words for different levels of the hierarchy, so
 * mapping the portal's Budget Head onto `entries.budget_head_id` would
 * re-classify entries against the wrong dimension. It is captured as
 * `budgetHeadRaw` for the row log and for a reviewer to eyeball, and the
 * caller never writes it to the FK. Resolve this properly once the Audit
 * portal's own budget-head list can be compared against `budget_head`.
 */
export function parsePortalTable(params: ParsePortalTableParams): ParsePortalTableResult {
  const { headers, rows, sourceSystem } = params
  const mapping = mapPortalHeaders(headers)
  const warnings: string[] = []

  if (mapping.unmappedHeaders.length > 0) {
    warnings.push(
      `Unrecognised portal column(s), ignored: ${mapping.unmappedHeaders.join(', ')}. ` +
        `Add a synonym in lib/import/portal-mapping.ts if one of these carries data you need.`
    )
  }
  for (const [field, indices] of Object.entries(mapping.ambiguousFields) as [
    PortalField,
    number[],
  ][]) {
    warnings.push(
      `Portal column "${field}" matched ${indices.length} columns (${indices
        .map((i) => headers[i])
        .join(', ')}); the first was used.`
    )
  }

  const cell = (cells: readonly string[], field: PortalField): string | null => {
    const index = mapping.byField[field]
    if (index === undefined) return null
    return toPortalStringOrNull(cells[index])
  }

  const parsedRows = rows.map((cells, i): ParsedPortalRow => {
    const rawRow: Record<string, string> = {}
    headers.forEach((header, index) => {
      rawRow[String(header)] = String(cells[index] ?? '')
    })

    const base = {
      rowNumber: i + 1,
      rawRow,
      invoiceNumber: cell(cells, 'invoiceNumber'),
      vendorRaw: cell(cells, 'vendor'),
      amount: parsePortalAmount(cell(cells, 'amount')),
      date: parsePortalDate(cell(cells, 'date')),
      userName: cell(cells, 'userName'),
      remark: cell(cells, 'remark'),
      budgetHeadRaw: cell(cells, 'budgetHead'),
      departmentRaw: cell(cells, 'department'),
      status: parsePortalStatus(cell(cells, 'status')),
      auditStatus: parsePortalStatus(cell(cells, 'auditStatus')),
      verificationStatus: parsePortalStatus(cell(cells, 'verificationStatus')),
    }

    if (isTotalRow(cells)) {
      return { ...base, ubblNumber: null, mainNumber: null, skipReason: 'total_row' }
    }

    // Explicit columns win; the ambiguous generic "Entry Number" is resolved
    // against the portal it came from (see this module's header comment).
    const explicitUbbl = cell(cells, 'ubblNumber')
    const explicitMain = cell(cells, 'mainNumber')
    const generic = cell(cells, 'entryNumber')

    const ubblNumber = safeNormalizeId(explicitUbbl ?? (sourceSystem === 'departmental' ? generic : null))
    const mainNumber = safeNormalizeId(explicitMain ?? (sourceSystem === 'audit' ? generic : null))

    return {
      ...base,
      ubblNumber,
      mainNumber,
      skipReason: ubblNumber === null && mainNumber === null ? 'no_identifier' : null,
    }
  })

  return { mapping, rows: parsedRows, warnings }
}

// ---------------------------------------------------------------------------
// Retry correlation (docs/hub-refinements-plan.md §4: "Auto-retry unmatched
// Audit-portal rows on later imports")
//
// Kept in this file, not lib/import/run-portal-import.ts, for the same
// reason checkAllocationSumMismatches/checkNamespaceCollisions live in
// lib/import/assertions.ts rather than run-import.ts: this file has no `pg`
// or `@/lib/env.server` dependency, so it can be imported by a unit test
// with no DATABASE_URL/SUPABASE_SECRET_KEY present. run-portal-import.ts
// pulls in lib/import/run-import.ts, which evaluates `serverEnv` at module
// load (lib/env.server.ts) and throws without real secrets — exactly why
// test/unit/run-import.test.ts already avoids importing run-import.ts
// directly. Putting the actually-testable part of the retry (recovering an
// identifier from a dedup_key, then re-finding its row in a re-parsed
// payload) here, rather than in the DB-coupled orchestrator, is what makes
// it possible to pin this logic down in test/unit/portal-linkage.test.ts
// against the same real fixtures that file already trusts.
// ---------------------------------------------------------------------------

/**
 * Recovers the identifier an `audit_row_unmatched` reconciliation_exception
 * encodes in its `dedup_key` (`audit_row_unmatched:${identifier}`, set by
 * `raiseException` in lib/import/run-portal-import.ts). Returns null when
 * `dedupKey` is not that exception type, or when the identifier is the
 * defensive `'(none)'` placeholder (only ever written when neither
 * mainNumber nor ubblNumber existed — a case parsePortalTable already
 * prevents from reaching importAuditRow at all, via the `no_identifier`
 * skip, so it should not occur in practice; guarded anyway since it is not a
 * real identifier there is anything to retry against).
 *
 * A prefix STRIP, deliberately not a generic split on ':'. `dedup_key`'s
 * shape is entirely under this codebase's own control (built here, in this
 * module's caller), so the fixed prefix is a safe anchor even if a future
 * identifier itself happened to contain a colon — normalizeId
 * (lib/normalize.ts) only trims a string id, it does not forbid one.
 *
 * A real schema column carrying the identifier was the alternative
 * considered (per the task brief) and rejected: `dedup_key` already carries
 * a `unique` constraint and is the one field every exception-raising path in
 * this codebase already treats as the durable "what is this row about"
 * handle (see the `ON CONFLICT (dedup_key)` pattern reused across
 * unknown_status_code, allocation_sum_mismatch and id_namespace_collision in
 * run-import.ts, and audit_row_unmatched itself below). A second column
 * would duplicate that fact, need its own backfill plan for exceptions
 * raised before this feature shipped, and still need to agree with
 * dedup_key or risk drifting from it — for no correctness gain over parsing
 * a format this codebase generates end to end.
 */
export function parseAuditRowUnmatchedIdentifier(dedupKey: string): string | null {
  const prefix = 'audit_row_unmatched:'
  if (!dedupKey.startsWith(prefix)) return null
  const identifier = dedupKey.slice(prefix.length)
  return identifier && identifier !== '(none)' ? identifier : null
}

/**
 * Re-parses a stored scrape payload (`import_batch.scrape_payload_jsonb`)
 * and finds the one row an `audit_row_unmatched` exception was raised for, by
 * its identifier. `parsePortalTable` is deterministic — the same
 * headers+rows always reproduces the identical `ParsedPortalRow[]` (this
 * file's header comment) — so the row found here is exactly the row the
 * original scrape produced, not a fuzzy re-guess.
 *
 * Same precedence as `findEntry` in run-portal-import.ts: mainNumber first,
 * falling back to ubblNumber. Skipped rows (total rows, rows with no
 * identifier at all) are never candidates.
 */
export function findPortalRowByIdentifier(
  params: ParsePortalTableParams,
  identifier: string
): ParsedPortalRow | null {
  const { rows } = parsePortalTable(params)
  return rows.find((row) => !row.skipReason && (row.mainNumber ?? row.ubblNumber) === identifier) ?? null
}

/**
 * `normalizeId` throws on anything that is not a usable id, which is right for
 * the .xlsx path where a bad id means a corrupt file. On the scrape path a
 * single unusable cell must not abort the whole table, so it degrades to null
 * and the row is skipped with `no_identifier` instead.
 */
function safeNormalizeId(value: string | null): string | null {
  if (value === null) return null
  try {
    return normalizeId(value)
  } catch {
    return null
  }
}

/**
 * Derives `entries.type` from an entry number, per the rule confirmed
 * 2026-08-12 (MASTER-PLAN §18 Phase 3) and already implemented for the .xlsx
 * path in lib/module-mapping.ts. Expressed here in portal vocabulary so the
 * scrape path applies the identical rule.
 */
export function deriveEntryType(
  entryNumber: string
): 'advance_payment' | 'reimbursement' | 'invoice' {
  if (entryNumber.startsWith('ADP_')) return 'advance_payment'
  if (entryNumber.startsWith('RB')) return 'reimbursement'
  return 'invoice'
}
