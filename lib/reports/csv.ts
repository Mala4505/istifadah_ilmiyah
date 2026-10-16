// CSV export utility shared by every "CSV export on every one" table in
// MASTER-PLAN §5 row 10 (Reports) and reused by Reconciliation and the
// Dashboard's linked lists. One implementation so escaping rules land in one
// place — the same reasoning §10.2 gives for the reporting views themselves.

import { csvCell } from '@/lib/csv-safe'

export type CsvColumn<T> = {
  header: string
  /** Cell value for a row. Receives the whole row so it can combine fields. */
  value: (row: T) => string | number | null | undefined
}

// Escaping + spreadsheet formula-injection guard (M8) live in lib/csv-safe.ts.
const escapeCsvCell = csvCell

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCsvCell(c.header)).join(',')
  const lines = rows.map((row) => columns.map((c) => escapeCsvCell(c.value(row))).join(','))
  return [header, ...lines].join('\r\n')
}

/**
 * Triggers a browser download of a CSV string. Client-side only (uses `document`
 * and `URL.createObjectURL`) — call from a client component's event handler.
 * A UTF-8 BOM is prepended so Excel renders ₹ and non-Latin vendor names
 * correctly instead of guessing the wrong codepage.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
