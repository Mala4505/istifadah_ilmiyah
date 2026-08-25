import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RowLogBadge } from '@/components/import/row-log-badge'
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
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">Row</TableHead>
            <TableHead className="w-40">Action</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>Sub-department</TableHead>
            <TableHead className="text-right">Budget amount</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.rowNumber} className={r.action === 'error' ? 'bg-destructive/5' : undefined}>
              <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
              <TableCell>
                <RowLogBadge action={r.action} />
              </TableCell>
              <TableCell className="max-w-[14rem] truncate">{pickCell(r.rawRow, DEPARTMENT_KEYS)}</TableCell>
              <TableCell className="max-w-[14rem] truncate">{pickCell(r.rawRow, SUB_DEPARTMENT_KEYS)}</TableCell>
              <TableCell className="text-right tabular-nums">{pickCell(r.rawRow, AMOUNT_KEYS)}</TableCell>
              <TableCell className="max-w-[22rem] text-xs text-muted-foreground">
                {r.note ? <FriendlyError message={r.note} /> : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
