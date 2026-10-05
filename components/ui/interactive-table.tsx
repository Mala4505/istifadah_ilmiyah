'use client'

import { useMemo, type MouseEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { cellValueOf, nodeText, type CellValue } from '@/lib/table-values'
import { SortIcon, useTableControls, type ControlColumn, type SortState } from '@/components/ui/table-controls'

export type InteractiveColumn = {
  key: string
  header: ReactNode
  align?: 'left' | 'right'
  /** Force the column's filter dropdown on/off. Default: on for text columns
   *  with 2–60 distinct values. */
  filterable?: boolean
  /** Natural first-click direction (dates/amounts/counts read best descending). */
  descendingFirst?: boolean
  /** Let long cell content wrap instead of the default single line. */
  wrap?: boolean
  className?: string
}

export type InteractiveRow = {
  key: string | number
  /** Rendered cells, one per column. */
  cells: ReactNode[]
  /** Sort value per cell (numbers/dates as numbers, blanks as null).
   *  Omit to derive from each cell's rendered text. */
  values?: CellValue[]
  /** Display text per cell — what search and the filter dropdowns match on.
   *  Omit to derive from each cell's rendered text. */
  texts?: string[]
  /** Where clicking the row goes. Omit to fall back to the first link in the row. */
  href?: string
  className?: string
}

type ResolvedRow = InteractiveRow & { texts: string[]; values: CellValue[] }

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, label, [role="checkbox"], [role="button"], [data-no-row-click]'

/**
 * Read-only table with search, per-column filters, click-to-sort on every
 * header, pagination and whole-row click-through (2026-10-05: "every table
 * has pagination, search, filter and sorting … each row is clickable"). A
 * row goes to its `href`, else to the first link inside it.
 *
 * Tables backed by server-side paging (Entries, Documents, Exceptions) keep
 * their own server-driven controls — this is for tables whose rows are
 * already all on the page. Editable tables use `useTableControls` directly.
 */
export function InteractiveTable({
  columns,
  rows: inputRows,
  initialPageSize = 25,
  initialSort = null,
  searchPlaceholder = 'Search…',
  noun = 'row',
  dense = false,
  className,
  tableClassName,
  footer,
  toolbar,
}: {
  columns: InteractiveColumn[]
  rows: InteractiveRow[]
  initialPageSize?: number
  /** Column index + direction to start sorted by. */
  initialSort?: { index: number; direction: 'asc' | 'desc' } | null
  searchPlaceholder?: string
  noun?: string
  /** Reports style: 13px mono cells. */
  dense?: boolean
  className?: string
  tableClassName?: string
  /** Optional `<tfoot>` content (e.g. a totals row), rendered under every page. */
  footer?: ReactNode
  /** Extra controls rendered at the right of the search bar. */
  toolbar?: ReactNode
}) {
  const router = useRouter()
  const plural = noun === 'entry' ? 'entries' : `${noun}s`

  // Fill in any search text / sort values the caller didn't supply.
  const rows = useMemo<ResolvedRow[]>(
    () =>
      inputRows.map((r) => ({
        ...r,
        texts: r.texts ?? r.cells.map((c) => nodeText(c)),
        values: r.values ?? r.cells.map((c) => cellValueOf(c)),
      })),
    [inputRows]
  )

  const controlColumns = useMemo<ControlColumn<ResolvedRow>[]>(
    () =>
      columns.map((col, i) => ({
        key: col.key,
        label: col.header,
        value: (r) => r.texts[i] ?? '',
        sortValue: (r) => r.values[i] ?? null,
        filter: col.filterable,
        descendingFirst: col.descendingFirst,
      })),
    [columns]
  )

  const initial: SortState = initialSort
    ? { key: columns[initialSort.index]?.key ?? '', direction: initialSort.direction }
    : null

  const controls = useTableControls(rows, {
    columns: controlColumns,
    initialPageSize,
    initialSort: initial,
    searchPlaceholder,
    noun,
    toolbarExtra: toolbar,
  })

  function handleRowClick(row: ResolvedRow, e: MouseEvent<HTMLTableRowElement>) {
    const target = e.target as HTMLElement
    if (target.closest(INTERACTIVE_SELECTOR)) return // the control handles its own click
    if (window.getSelection()?.toString()) return // the user is selecting text
    const href = row.href ?? e.currentTarget.querySelector<HTMLAnchorElement>('a[href]')?.getAttribute('href') ?? null
    if (!href) return
    if (e.metaKey || e.ctrlKey) window.open(href, '_blank', 'noopener')
    else router.push(href)
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {controls.toolbar}

      <div className={cn('overflow-x-auto rounded-md border border-border', tableClassName)}>
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              {columns.map((col) => {
                const active = controls.sort?.key === col.key
                const direction = controls.sort?.direction ?? 'asc'
                return (
                  <th
                    key={col.key}
                    aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={cn('whitespace-nowrap bg-card px-3 py-2 font-medium', col.align === 'right' && 'text-right')}
                  >
                    <button
                      type="button"
                      onClick={() => controls.toggleSort(col.key)}
                      className={cn(
                        '-m-1 inline-flex select-none items-center gap-1 rounded-sm p-1 uppercase hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        col.align === 'right' && 'flex-row-reverse'
                      )}
                    >
                      {col.header}
                      <SortIcon active={active} direction={direction} />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {controls.pageItems.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {rows.length === 0 ? `No ${plural}.` : `No ${plural} match your search or filters.`}
                </td>
              </tr>
            ) : (
              controls.pageItems.map((row) => (
                <tr
                  key={row.key}
                  onClick={(e) => handleRowClick(row, e)}
                  className={cn(
                    'border-b border-border/60 last:border-0 hover:bg-accent/30',
                    row.href ? 'cursor-pointer' : 'has-[a]:cursor-pointer',
                    row.className
                  )}
                >
                  {row.cells.map((cell, i) => (
                    <td
                      key={columns[i]?.key ?? i}
                      className={cn(
                        'px-3 py-2 text-foreground',
                        columns[i]?.wrap ? 'align-top' : 'whitespace-nowrap',
                        dense && 'font-mono text-[13px]',
                        columns[i]?.align === 'right' && 'text-right tabular-nums',
                        columns[i]?.className
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {footer && <tfoot className="border-t border-border bg-muted/40 font-medium">{footer}</tfoot>}
        </table>
      </div>

      {controls.pagination}
    </div>
  )
}
