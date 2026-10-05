import { InteractiveTable } from '@/components/ui/interactive-table'
import { RowLogBadge, actionDisplay } from '@/components/import/row-log-badge'
import { FriendlyError } from '@/components/ui/friendly-error'
import type { RowLogEntry } from '@/components/import/row-log-table'
import {
  AMOUNT_KEYS,
  DEPARTMENT_KEYS,
  SUB_DEPARTMENT_KEYS,
  pickField,
} from '@/lib/import/sub-department-budget-parsing'

/** Falls back to an em dash for display — pickField itself returns null for
 *  "no candidate header had a value," which reads better as '—' in a table
 *  cell than as an empty string. */
function pickCell(row: Record<string, unknown>, candidates: readonly string[]): string {
  return pickField(row, candidates) ?? '—'
}

/**
 * The sub-department-budget sheet's own per-row diff preview — a
 * three-column source (department name, sub-department name, budget amount)
 * mirrors components/import/department-budget-row-log-table.tsx with one
 * extra column, since sub-department names are only unique within a
 * department. Same "the preview is the screen" shape and same underlying
 * ImportRowLogEntry/RowLogEntry data.
 */
export function SubDepartmentBudgetRowLogTable({ rows }: { rows: RowLogEntry[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No rows to show.
      </div>
    )
  }

  return (
    <InteractiveTable
      noun="row"
      searchPlaceholder="Search rows…"
      columns={[
        { key: 'row', header: 'Row', filterable: false },
        { key: 'action', header: 'Action' },
        { key: 'department', header: 'Department' },
        { key: 'sub', header: 'Sub-department', filterable: false },
        { key: 'amount', header: 'Budget amount', align: 'right', descendingFirst: true },
        { key: 'note', header: 'Note', filterable: false, wrap: true, className: 'max-w-[22rem] text-xs text-muted-foreground' },
      ]}
      rows={rows.map((r) => {
        const department = pickCell(r.rawRow, DEPARTMENT_KEYS)
        const sub = pickCell(r.rawRow, SUB_DEPARTMENT_KEYS)
        const amount = pickCell(r.rawRow, AMOUNT_KEYS)
        return {
          key: r.rowNumber,
          className: r.action === 'error' ? 'bg-destructive/5' : undefined,
          cells: [
            <span key="n" className="text-muted-foreground">
              {r.rowNumber}
            </span>,
            <RowLogBadge key="a" action={r.action} />,
            department,
            sub,
            amount,
            r.note ? <FriendlyError key="e" message={r.note} /> : '—',
          ],
          texts: [String(r.rowNumber), actionDisplay(r.action).label, department, sub, amount, r.note ?? ''],
        }
      })}
    />
  )
}
