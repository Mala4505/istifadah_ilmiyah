import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/reports/empty-state'

export type DataTableColumn<T> = {
  key: string
  header: string
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
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
 * Plain semantic table shared by Reconciliation and Reports (§5 rows 9-10).
 * Deliberately local rather than a components/ui/table primitive — that
 * primitive doesn't exist in this worktree yet and another agent may be
 * adding one in parallel; this stays self-contained to avoid colliding.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  emptyTitle = 'No rows',
  emptyDescription,
  className,
}: {
  columns: DataTableColumn<T>[]
  rows: T[]
  getRowKey: (row: T) => string | number
  emptyTitle?: string
  emptyDescription?: string
  className?: string
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />
  }

  // Resolve alignment once per column: an explicit `align` always wins;
  // otherwise fall back to sniffing the rendered values so a column carrying
  // money/counts/percentages reads right-aligned even if a caller forgot to
  // say so (financial tables are read down the column — §6 fix 7).
  const resolvedAligns = columns.map((c) => c.align ?? (columnLooksNumeric(c, rows) ? 'right' : 'left'))

  return (
    <div className={cn('overflow-x-auto rounded-md border border-border', className)}>
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            {columns.map((c, i) => (
              <th
                key={c.key}
                className={cn(
                  // bg-card on the cell itself, not just the thead, so the
                  // sticky header stays opaque under border-collapse (same
                  // workaround as components/ui/table.tsx).
                  'whitespace-nowrap bg-card px-3 py-2 font-medium',
                  resolvedAligns[i] === 'right' && 'text-right tabular-nums'
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)} className="border-b border-border/60 last:border-0 hover:bg-accent/30">
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={cn(
                    'whitespace-nowrap px-3 py-2 font-mono text-[13px] text-foreground',
                    resolvedAligns[i] === 'right' && 'text-right tabular-nums'
                  )}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
