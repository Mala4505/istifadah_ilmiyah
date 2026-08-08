import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/reports/empty-state'

export type DataTableColumn<T> = {
  key: string
  header: string
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
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

  return (
    <div className={cn('overflow-x-auto rounded-md border border-border', className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn('whitespace-nowrap px-3 py-2 font-medium', c.align === 'right' && 'text-right')}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)} className="border-b border-border/60 last:border-0 hover:bg-accent/30">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'whitespace-nowrap px-3 py-2 font-mono text-[13px] text-foreground',
                    c.align === 'right' && 'text-right'
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
