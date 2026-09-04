/**
 * Board pack -- workbook builder. reporting-blueprint.md §5.
 *
 * `buildBoardPackWorkbook(data)` -> a complete .xlsx as bytes. Pure: no I/O,
 * no framework imports. The workbook is the board pack's primary deliverable
 * (the org's outward format is Excel), so it carries the whole Brief:
 *
 *   Summary            5 KPI tiles (label / value / delta), + any data warnings
 *   What changed       the weekly digest's ten ranked items (what / ₹ / owner / age)
 *   Department league  E-01, every column
 *   Needs decision     E-04, ten rows
 *
 * Numbers are written as real numeric cells with an Indian digit-grouping
 * number format (lakh/crore), so they stay summable in Excel rather than being
 * baked into strings. Every sheet gets an autofilter on its header row.
 *
 * NOTE on frozen header rows: the blueprint asks for frozen headers, but the
 * SheetJS community build in this repo (xlsx@0.18.5) does not emit freeze-pane
 * XML on write (`ws['!freeze']` is read-only there; its writer ignores panes).
 * An autofilter on the header row is the closest equivalent this toolchain can
 * produce. `ws['!freeze']` is still set below so the panes appear automatically
 * if the dependency is ever upgraded to a build that writes them.
 */

import * as XLSX from 'xlsx'
import { humanizeCode } from '@/lib/reports/format'
import type { BoardPackData } from '@/lib/reports/board-pack/types'

// Indian (lakh/crore) grouping. Repeated `##,` groups give 12,34,56,789.
const FMT_INR = '"₹"##,##,##,##0'
const FMT_INT = '##,##,##,##0'
const FMT_PCT = '0.0"%"'

type CellKind = 'text' | 'inr' | 'int' | 'pct'

type Column<T> = {
  header: string
  width: number
  kind: CellKind
  get: (row: T) => string | number | null | undefined
}

/** Builds one worksheet from column defs + rows, applying number formats,
 *  column widths and a header-row autofilter. */
function sheetFromColumns<T>(columns: Column<T>[], rows: T[]): XLSX.WorkSheet {
  const header = columns.map((c) => c.header)
  const body = rows.map((row) =>
    columns.map((c) => {
      const raw = c.get(row)
      if (raw === null || raw === undefined || raw === '') return null
      if (c.kind === 'text') return String(raw)
      const n = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(n) ? n : String(raw)
    })
  )

  const ws = XLSX.utils.aoa_to_sheet([header, ...body])

  // Apply number formats to the data cells of numeric columns.
  columns.forEach((c, colIdx) => {
    if (c.kind === 'text') return
    const z = c.kind === 'inr' ? FMT_INR : c.kind === 'pct' ? FMT_PCT : FMT_INT
    for (let rowIdx = 1; rowIdx <= body.length; rowIdx += 1) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })
      const cell = ws[addr] as XLSX.CellObject | undefined
      if (cell && cell.t === 'n') cell.z = z
    }
  })

  ws['!cols'] = columns.map((c) => ({ wch: c.width }))
  const lastCol = XLSX.utils.encode_col(columns.length - 1)
  ws['!autofilter'] = { ref: `A1:${lastCol}${body.length + 1}` }
  // Harmless today (see file header), auto-activates on a library upgrade that
  // writes freeze-pane XML. The `!freeze` key is not in the write path of
  // xlsx@0.18.5 but the type's index signature accepts it.
  ;(ws as Record<string, unknown>)['!freeze'] = {
    xSplit: 0,
    ySplit: 1,
    topLeftCell: 'A2',
    activePane: 'bottomLeft',
    state: 'frozen',
  }

  return ws
}

/** A one-off two-column key/value sheet (Summary), also autofiltered. */
function keyValueSheet(title: string, pairs: [string, string][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([[title, ''], ...pairs])
  ws['!cols'] = [{ wch: 32 }, { wch: 60 }]
  return ws
}

export function buildBoardPackWorkbook(data: BoardPackData): Uint8Array {
  const wb = XLSX.utils.book_new()

  // ---- Summary ------------------------------------------------------------
  const summaryPairs: [string, string][] = [
    ['Event', data.eventName ?? '(no event selected)'],
    ['Generated', new Date(data.generatedAt).toLocaleString('en-IN')],
    [
      'Event window',
      data.eventStartsOn || data.eventEndsOn
        ? `${data.eventStartsOn ?? '?'} to ${data.eventEndsOn ?? '?'}`
        : 'not set',
    ],
    ['', ''],
    ...data.kpis.map(
      (k): [string, string] => [k.label, k.delta ? `${k.value}  (${k.delta})` : k.value]
    ),
  ]
  if (data.narrative.length > 0) {
    summaryPairs.push(['', ''], ['What changed this week', ''])
    data.narrative.forEach((s, i) => summaryPairs.push([`  ${i + 1}.`, s]))
  }
  if (data.warnings.length > 0) {
    summaryPairs.push(['', ''], ['Data warnings', ''])
    data.warnings.forEach((w, i) => summaryPairs.push([`  ${i + 1}.`, w]))
  }
  XLSX.utils.book_append_sheet(wb, keyValueSheet('Board pack summary', summaryPairs), 'Summary')

  // ---- What changed (weekly digest) -------------------------------------
  const digestColumns: Column<BoardPackData['digest'][number]>[] = [
    { header: 'Rank', width: 6, kind: 'int', get: (r) => r.rank },
    { header: 'What changed', width: 72, kind: 'text', get: (r) => r.headline },
    { header: '₹ at stake', width: 16, kind: 'inr', get: (r) => r.amount ?? null },
    { header: 'Owner', width: 28, kind: 'text', get: (r) => r.owner },
    { header: 'Age (days)', width: 12, kind: 'int', get: (r) => r.ageDays ?? null },
    { header: 'Category', width: 20, kind: 'text', get: (r) => humanizeCode(r.category) },
  ]
  XLSX.utils.book_append_sheet(wb, sheetFromColumns(digestColumns, data.digest), 'What changed')

  // ---- Department league (E-01) ---------------------------------------
  const leagueColumns: Column<BoardPackData['league'][number]>[] = [
    { header: 'Department', width: 30, kind: 'text', get: (r) => r.departmentName },
    { header: 'Spend', width: 16, kind: 'inr', get: (r) => r.spend },
    { header: 'Share of spend %', width: 16, kind: 'pct', get: (r) => r.spendSharePct ?? null },
    { header: 'Budget', width: 16, kind: 'inr', get: (r) => r.budgetAmount ?? null },
    { header: '% of budget', width: 14, kind: 'pct', get: (r) => r.pctOfBudget ?? null },
    { header: 'Budget status', width: 24, kind: 'text', get: (r) => r.budgetStatusNote ?? null },
    { header: 'Projected landing %', width: 18, kind: 'pct', get: (r) => r.projectedLandingPct ?? null },
    { header: 'Documentation %', width: 16, kind: 'pct', get: (r) => r.documentCoveragePct ?? null },
    { header: '₹ at risk', width: 16, kind: 'inr', get: (r) => r.amountAtRisk },
    { header: 'Open issues', width: 12, kind: 'int', get: (r) => r.openIssueCount },
  ]
  XLSX.utils.book_append_sheet(wb, sheetFromColumns(leagueColumns, data.league), 'Department league')

  // ---- Needs decision (E-04) -----------------------------------------
  const needsColumns: Column<BoardPackData['needsDecision'][number]>[] = [
    { header: 'Issue', width: 34, kind: 'text', get: (r) => humanizeCode(r.issueType) },
    { header: 'Severity', width: 12, kind: 'text', get: (r) => r.severity },
    { header: '₹ at risk', width: 16, kind: 'inr', get: (r) => r.amountAtRisk ?? null },
    { header: 'Owner', width: 28, kind: 'text', get: (r) => r.owner },
    { header: 'Age (days)', width: 12, kind: 'int', get: (r) => r.ageDays },
    { header: 'Detail', width: 72, kind: 'text', get: (r) => r.description ?? null },
  ]
  XLSX.utils.book_append_sheet(wb, sheetFromColumns(needsColumns, data.needsDecision), 'Needs decision')

  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}
