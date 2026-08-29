import type { SupabaseClient } from '@supabase/supabase-js'
import { ALL_COLUMNS, type ColumnKey, type EntriesFilters, type EntryEnriched } from './types'
import { applyEntriesFilters } from './query'
import { formatDate } from './format'

const EXPORT_BATCH_SIZE = 1000
// Hard cap so a runaway filter (or "no filters at all" on a much bigger
// future dataset) can't hang the browser tab building a giant CSV client-side.
// Comfortably above the §0 volume decision (1,000-10,000 entries total).
const MAX_EXPORT_ROWS = 20000

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function cellValue(row: EntryEnriched, key: ColumnKey): string {
  switch (key) {
    case 'date':
      return formatDate(row.date)
    case 'amount':
      return row.amount == null ? '' : String(row.amount)
    case 'export_pending':
      return row.hub_status_exported_at === null && row.hub_status_code !== 'not_set' ? 'yes' : 'no'
    default:
      return String((row as unknown as Record<string, unknown>)[key] ?? '')
  }
}

/**
 * CSV export of "the current filtered view" (§5 row 3) — not just the
 * loaded page. Client-side is acceptable at this row count (§0: 1,000-10,000
 * entries for the whole event); re-fetches the full filtered set in batches
 * via keyset pagination rather than trusting whatever happens to be in
 * client-side state, so the export always matches the filters exactly.
 */
export async function exportEntriesToCsv(
  supabase: SupabaseClient,
  filters: EntriesFilters,
  visibleColumns?: ReadonlySet<ColumnKey>,
): Promise<{ rowCount: number; truncated: boolean }> {
  // §4.10: the CSV mirrors the column chooser rather than always dumping
  // every column. Falls back to all columns when no set is passed (or an
  // empty one somehow arrives) so a caller can't produce a header-only file.
  const columns =
    visibleColumns && visibleColumns.size > 0
      ? ALL_COLUMNS.filter((c) => visibleColumns.has(c.key))
      : ALL_COLUMNS
  let cursor: number | null = null
  let rowCount = 0
  let truncated = false
  const lines: string[] = [columns.map((c) => csvEscape(c.label)).join(',')]

  for (;;) {
    let query = supabase
      .from('v_entry_enriched')
      .select('*')
      .order('id', { ascending: false })
      .limit(EXPORT_BATCH_SIZE)
    query = applyEntriesFilters(query, filters)
    if (cursor !== null) query = query.lt('id', cursor)

    const { data, error } = await query
    if (error) throw error
    const rows = (data ?? []) as EntryEnriched[]
    if (rows.length === 0) break

    for (const row of rows) {
      lines.push(columns.map((c) => csvEscape(cellValue(row, c.key))).join(','))
    }
    rowCount += rows.length
    cursor = rows[rows.length - 1]!.id

    if (rows.length < EXPORT_BATCH_SIZE) break
    if (rowCount >= MAX_EXPORT_ROWS) {
      // §4.10: there are more matching rows than we're willing to build
      // client-side. Flag it so the caller can warn rather than reporting a
      // clean success on a silently clipped file.
      truncated = true
      break
    }
  }

  // §4.10: lead with a UTF-8 BOM so Excel on Windows reads non-ASCII vendor
  // names as UTF-8 instead of the system code page (mojibake otherwise).
  const UTF8_BOM = '﻿'
  const blob = new Blob([UTF8_BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  a.href = url
  a.download = `entries-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  return { rowCount, truncated }
}
