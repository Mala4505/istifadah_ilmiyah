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
    case 'tenant_amount':
      return row.tenant_amount == null ? '' : String(row.tenant_amount)
    case 'main_amount':
      return row.main_amount == null ? '' : String(row.main_amount)
    case 'amount_variance':
      return row.amount_variance == null ? '' : String(row.amount_variance)
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
export async function exportEntriesToCsv(supabase: SupabaseClient, filters: EntriesFilters): Promise<{ rowCount: number }> {
  const columns = ALL_COLUMNS
  let cursor: number | null = null
  let rowCount = 0
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

    if (rows.length < EXPORT_BATCH_SIZE || rowCount >= MAX_EXPORT_ROWS) break
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  a.href = url
  a.download = `entries-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  return { rowCount }
}
