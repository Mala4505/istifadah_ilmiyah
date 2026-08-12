/**
 * Bidirectional raw-row <-> entry-fields transform (MASTER-PLAN §10, §3.6).
 *
 * Pure row-shape transformation only — no database connection, no Supabase
 * client. Whoever wires `/api/import` calls `parseDepartmentalRow` per row
 * and does the DB upsert; whoever wires the status-export job calls
 * `hubStatusToExportRow` per entry and writes the output file.
 *
 * Today this covers the Departmental import direction plus the Hub-status
 * export direction, per §3.6's parsing rules verified against the real
 * file. The Main import direction is a config change once a populated Main
 * export arrives (§3.6: "a config change, not new architecture") and is
 * deliberately not guessed at here.
 */

// ---------------------------------------------------------------------------
// hubStatusToExportRow — Hub -> Departmental/Main export row (§3.7)
// ---------------------------------------------------------------------------

/** The two Hub-owned status fields that flow outward (§3.6, §3.7). */
export interface HubStatusEntry {
  ubblNumber: string
  mainNumber: string | null
  hubStatusCode: string
  hubStatusNote: string | null
  hubStatusChangedAt: string | Date | null
}

export interface HubStatusExportRow {
  ubbl_number: string
  main_number: string | null
  hub_status_code: string
  hub_status_note: string | null
  /** ISO 8601 timestamp string, or null if the status was never set. */
  changed_at: string | null
}

/** Pure transform: Hub entry shape -> the row shape written to the status export file. */
export function hubStatusToExportRow(entry: HubStatusEntry): HubStatusExportRow {
  return {
    ubbl_number: entry.ubblNumber,
    main_number: entry.mainNumber,
    hub_status_code: entry.hubStatusCode,
    hub_status_note: entry.hubStatusNote,
    changed_at:
      entry.hubStatusChangedAt instanceof Date
        ? entry.hubStatusChangedAt.toISOString()
        : entry.hubStatusChangedAt,
  }
}

// ---------------------------------------------------------------------------
// parseDepartmentalRow — Departmental export row -> entry-fields (§3.6)
// ---------------------------------------------------------------------------

import { normalizeId } from '@/lib/normalize'

/** Exact column headers from the real Departmental export (§3.6). */
export const DEPARTMENTAL_COLUMNS = [
  'Srno',
  'Budget Head',
  'Department',
  'Request Amount',
  'Approved Amount',
  'Utilised Amount',
  'Balance',
  'Vendor Name',
  'Invoice Number',
  'Invoice Amount',
  'Invoice Date',
  'User name',
  'UBBL Number',
  'Main Entry Number',
  'Status',
  'Main Status',
] as const

/** Forward-fill state carried from one row to the next (§3.6 point 1). */
export interface DepartmentalRowContext {
  budgetHead: string | null
  department: string | null
}

export const INITIAL_DEPARTMENTAL_CONTEXT: DepartmentalRowContext = {
  budgetHead: null,
  department: null,
}

export interface ParsedAllocationRow {
  requestAmount: number | null
  approvedAmount: number | null
  utilisedAmount: number | null
  balanceAmount: number | null
}

export interface ParsedEntryRow {
  type: 'advance_payment' | 'reimbursement' | 'invoice'
  ubblNumber: string
  mainNumber: string | null
  vendorRaw: string | null
  invoiceNumber: string | null
  invoiceAmount: number | null
  invoiceDate: string | null
  userName: string | null
  statusRaw: string | null
  auditStatusRaw: string | null
}

export type DepartmentalRowType = 'allocation' | 'entry' | 'both' | 'skip'
export type DepartmentalSkipReason = 'grand_total' | 'no_ubbl_and_no_srno'

export interface ParsedDepartmentalRow {
  rowType: DepartmentalRowType
  skipReason?: DepartmentalSkipReason
  /** Forward-filled Budget Head in effect for this row (§3.6 point 1). */
  budgetHead: string | null
  /** Forward-filled Department in effect for this row (§3.6 point 1). */
  department: string | null
  allocation: ParsedAllocationRow | null
  entry: ParsedEntryRow | null
}

export interface ParseDepartmentalRowResult {
  row: ParsedDepartmentalRow
  /** Pass this back in as `context` for the next row, to keep the forward-fill going. */
  nextContext: DepartmentalRowContext
}

function toTrimmedStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const str = String(value).trim()
  if (str === '' || str.toUpperCase() === 'NA') return null
  return str
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

/**
 * Parses one raw Departmental export row (already read into an object keyed
 * by header name — see `DEPARTMENTAL_COLUMNS`) into entry/allocation shape,
 * per §3.6's parsing rules:
 *
 * 1. Forward-fills Budget Head / Department from `context` onto sub-rows.
 * 2. Allocation row = has Srno AND Budget Head (may also carry an entry —
 *    `rowType: 'both'`, row 3 in the sample does exactly this).
 * 3. Entry row = UBBL Number is non-empty. No UBBL -> not an entry.
 * 4. Grand Total row is skipped, detected via `Department === 'Grand Total'`
 *    (column C), never via column A.
 * 5. Invoice Number is trimmed; `'NA'` and blank become null. `' quotation'`
 *    is left as-is — it is a real value (an advance against a quotation).
 * 6. `type` is derived from the normalized UBBL number's prefix (RESOLVED
 *    2026-08-12, MASTER-PLAN §18 Phase 3): `ADP_` -> `'advance_payment'`,
 *    `RB` -> `'reimbursement'`, no matching prefix -> `'invoice'`. Checked in
 *    that order so `ADP_`-prefixed values never fall through to the `RB`
 *    branch. This replaces the earlier "prefix isn't reliable, wait for
 *    Sheet 2's own Type column" placeholder — you supplied this rule
 *    directly instead, so the isolation into one branch just paid off as
 *    "swap is a one-line change" without needing Sheet 2 at all.
 *
 * Status-code mapping (Status/Main Status -> `entry_status`) and the
 * tally-vs-allocation assertion are caller concerns (they need the
 * `entry_status` lookup table and cross-row aggregation respectively) —
 * this function only produces the raw/trimmed shape.
 */
export function parseDepartmentalRow(
  rawRow: Record<string, unknown>,
  context: DepartmentalRowContext = INITIAL_DEPARTMENTAL_CONTEXT
): ParseDepartmentalRowResult {
  const departmentRaw = toTrimmedStringOrNull(rawRow['Department'])

  // Rule 4: Grand Total is detected by column C (Department), not column A (Srno).
  if (departmentRaw === 'Grand Total') {
    return {
      row: {
        rowType: 'skip',
        skipReason: 'grand_total',
        budgetHead: context.budgetHead,
        department: context.department,
        allocation: null,
        entry: null,
      },
      nextContext: context,
    }
  }

  // Rule 1: forward-fill.
  const budgetHeadRaw = toTrimmedStringOrNull(rawRow['Budget Head'])
  const budgetHead = budgetHeadRaw ?? context.budgetHead
  const department = departmentRaw ?? context.department
  const nextContext: DepartmentalRowContext = { budgetHead, department }

  // Rule 2: allocation row = Srno present AND (this row's own) Budget Head present.
  const isAllocationRow = hasValue(rawRow['Srno']) && budgetHeadRaw !== null
  const allocation: ParsedAllocationRow | null = isAllocationRow
    ? {
        requestAmount: toNumberOrNull(rawRow['Request Amount']),
        approvedAmount: toNumberOrNull(rawRow['Approved Amount']),
        utilisedAmount: toNumberOrNull(rawRow['Utilised Amount']),
        balanceAmount: toNumberOrNull(rawRow['Balance']),
      }
    : null

  // Rule 3: entry row = UBBL Number non-empty.
  const ubblRaw = rawRow['UBBL Number']
  let entry: ParsedEntryRow | null = null
  if (hasValue(ubblRaw)) {
    const ubblNumber = normalizeId(ubblRaw)
    const mainNumberRaw = toTrimmedStringOrNull(rawRow['Main Entry Number'])

    entry = {
      // Rule 6: prefix rule, isolated here per §3.6.
      type: ubblNumber.startsWith('ADP_')
        ? 'advance_payment'
        : ubblNumber.startsWith('RB')
          ? 'reimbursement'
          : 'invoice',
      ubblNumber,
      mainNumber: mainNumberRaw === null ? null : normalizeId(mainNumberRaw),
      vendorRaw: toTrimmedStringOrNull(rawRow['Vendor Name']),
      // Rule 5: trim; null out 'NA'/blank. Note ' quotation' (a real value,
      // not noise) survives toTrimmedStringOrNull unchanged.
      invoiceNumber: toTrimmedStringOrNull(rawRow['Invoice Number']),
      invoiceAmount: toNumberOrNull(rawRow['Invoice Amount']),
      invoiceDate: toTrimmedStringOrNull(rawRow['Invoice Date']),
      userName: toTrimmedStringOrNull(rawRow['User name']),
      statusRaw: toTrimmedStringOrNull(rawRow['Status']),
      auditStatusRaw: toTrimmedStringOrNull(rawRow['Main Status']),
    }
  }

  let rowType: DepartmentalRowType
  if (allocation && entry) rowType = 'both'
  else if (allocation) rowType = 'allocation'
  else if (entry) rowType = 'entry'
  else rowType = 'skip'

  return {
    row: {
      rowType,
      skipReason: rowType === 'skip' ? 'no_ubbl_and_no_srno' : undefined,
      budgetHead,
      department,
      allocation,
      entry,
    },
    nextContext,
  }
}
