'use client'

import * as React from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { TableHead } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export type SortDirection = 'asc' | 'desc'

/**
 * Click-to-sort column header, shared across every list screen
 * (docs/hub-screen-certification.md §3.2). Lifted from the bespoke header
 * button that only Entries had, so Documents and Exceptions get the same
 * `aria-sort`, the same direction affordance, and the same keyboard
 * reachability (it renders a real `<button>`).
 *
 * `<K>` is the caller's own column-key union — `onSort` hands it straight
 * back, so no translation table is needed between "which header was clicked"
 * and "what to sort by".
 *
 * Descending-first defaults (date / amount / count columns) are the caller's
 * concern — pass `defaultDirection` and the caller's toggle logic decides
 * the first click's direction. This component only renders state.
 */
export function SortableTableHead<K extends string>({
  columnKey,
  label,
  activeColumn,
  direction,
  onSort,
  align = 'left',
  className,
}: {
  columnKey: K
  label: React.ReactNode
  activeColumn: K | null | undefined
  direction: SortDirection
  onSort: (column: K) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const isActive = activeColumn === columnKey

  return (
    <TableHead
      className={cn(align === 'right' && 'text-right', className)}
      aria-sort={isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={cn(
          '-m-2 inline-flex select-none items-center gap-1 rounded-sm p-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          align === 'right' && 'flex-row-reverse'
        )}
        onClick={() => onSort(columnKey)}
      >
        {label}
        {isActive ? (
          direction === 'asc' ? (
            <ArrowUp className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 text-muted-foreground/50" aria-hidden="true" />
        )}
      </button>
    </TableHead>
  )
}

/**
 * Toggle helper for the common "click a column: same column flips direction,
 * new column starts at its natural default" behaviour. `descendingFirst` is
 * the set of columns that should open descending (dates, amounts, counts).
 */
export function nextSort<K extends string>(
  current: { column: K; direction: SortDirection },
  clicked: K,
  descendingFirst?: ReadonlySet<K>
): { column: K; direction: SortDirection } {
  if (current.column === clicked) {
    return { column: clicked, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }
  return { column: clicked, direction: descendingFirst?.has(clicked) ? 'desc' : 'asc' }
}
