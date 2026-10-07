import { cloneElement, isValidElement, type ReactNode } from 'react'
import { EmptyState } from '@/components/reports/empty-state'
import { InteractiveTable, type InteractiveColumn, type InteractiveRow } from '@/components/ui/interactive-table'
import { cellValueOf, nodeText, toCellValue } from '@/lib/table-values'

export type DataTableColumn<T> = {
  key: string
  header: string
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
  /** Value to sort on when the rendered cell's text isn't enough (a badge
   *  that renders from props, a label whose order isn't alphabetical). */
  sortValue?: (row: T) => string | number | null | undefined
  /** Force the column's filter dropdown on/off (default: automatic). */
  filterable?: boolean
}

/** Matches a rendered cell value that reads as a plain number/money/percent
 *  figure — digits, Indian digit grouping, a leading ₹/$, a trailing %, a
 *  leading minus/en-dash. Used only to pick a sensible default alignment for
 *  columns that don't declare `align` explicitly; an explicit `align` always
 *  wins. */
const NUMERIC_CELL_RE = /^[-−]?[₹$]?[\d,]+(\.\d+)?\s*%?$/

/** A column "looks numeric" if every sampled row renders either a plain
 *  number, a numeric-looking string, or a placeholder dash — and at least
 *  one row is actually numeric (an all-dash column stays left-aligned). Any
 *  JSX (links, badges) or other text disqualifies the column, so this never
 *  fights an intentionally left-aligned column of rich content. */
function columnLooksNumeric<T>(column: DataTableColumn<T>, rows: T[]): boolean {
  let sawNumeric = false
  for (const row of rows.slice(0, 25)) {
    const node = column.render(row)
    if (typeof node === 'number') {
      sawNumeric = true
      continue
    }
    if (typeof node !== 'string') return false
    const trimmed = node.trim()
    if (trimmed === '' || trimmed === '—' || trimmed === '-') continue
    if (NUMERIC_CELL_RE.test(trimmed)) {
      sawNumeric = true
      continue
    }
    return false
  }
  return sawNumeric
}

/**
 * Table shared by every Reports section. It resolves each cell here (so it
 * still works as a Server Component — the `render` functions never cross to
 * the client) and hands the rendered cells plus their search/sort values to
 * the client InteractiveTable, which adds search, per-column filters,
 * click-to-sort on every header, pagination and whole-row click-through
 * (2026-10-05: "every table has pagination, search, filter and sorting").
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  getRowHref,
  emptyTitle = 'No rows',
  emptyDescription,
  className,
  pageSize = 25,
}: {
  columns: DataTableColumn<T>[]
  rows: T[]
  getRowKey: (row: T) => string | number
  /** Where a click anywhere on the row goes. Defaults to the row's first link. */
  getRowHref?: (row: T) => string | null | undefined
  emptyTitle?: string
  emptyDescription?: string
  className?: string
  pageSize?: number
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />
  }

  // Resolve alignment once per column: an explicit `align` always wins;
  // otherwise fall back to sniffing the rendered values so a column carrying
  // money/counts/percentages reads right-aligned even if a caller forgot to
  // say so (financial tables are read down the column — §6 fix 7).
  const resolvedAligns = columns.map((c) => c.align ?? (columnLooksNumeric(c, rows) ? 'right' : 'left'))

  const tableColumns: InteractiveColumn[] = columns.map((c, i) => ({
    key: c.key,
    header: c.header,
    align: resolvedAligns[i],
    filterable: c.filterable,
    descendingFirst: resolvedAligns[i] === 'right',
  }))

  const tableRows: InteractiveRow[] = rows.map((row) => {
    const cells = columns.map((c) => c.render(row))
    const texts = cells.map((cell) => nodeText(cell))
    const values = columns.map((c, i) => (c.sortValue ? toCellValue(c.sortValue(row)) : cellValueOf(cells[i])))
    // `cells` crosses to the client as an array; a Server Component element in
    // it (e.g. <SeverityBadge>) is rendered during RSC serialisation, where an
    // unkeyed element in an array trips React's "unique key" warning. Key each
    // element by its column — after texts/values are read from the raw nodes.
    const keyedCells = cells.map((cell, i) =>
      isValidElement(cell) && cell.key == null ? cloneElement(cell, { key: columns[i]!.key }) : cell
    )
    return { key: getRowKey(row), cells: keyedCells, texts, values, href: getRowHref?.(row) ?? undefined }
  })

  return <InteractiveTable columns={tableColumns} rows={tableRows} initialPageSize={pageSize} dense className={className} />
}
