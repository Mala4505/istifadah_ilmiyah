import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RowLogBadge } from '@/components/import/row-log-badge'

export interface RowLogEntry {
  rowNumber: number
  rawRow: Record<string, unknown>
  action: string
  entryId: number | null
  fieldsChanged: Record<string, { from: unknown; to: unknown }> | null
  note?: string | null
}

function cell(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

/**
 * The per-row diff table (MASTER-PLAN §5: "the preview is the screen, not
 * a modal"). Reused for both the dry-run/commit preview and for inspecting
 * a past batch's import_row_log from history.
 */
export function RowLogTable({ rows }: { rows: RowLogEntry[] }) {
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
            <TableHead>Budget head</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>UBBL / Main #</TableHead>
            <TableHead className="text-right">Invoice amount</TableHead>
            <TableHead>Status (tenant / main)</TableHead>
            <TableHead>Changed fields</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.rowNumber} className={r.action === 'error' ? 'bg-destructive/5' : undefined}>
              <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
              <TableCell>
                <RowLogBadge action={r.action} />
              </TableCell>
              <TableCell className="max-w-[16rem] truncate">{cell(r.rawRow, 'Budget Head')}</TableCell>
              <TableCell className="max-w-[14rem] truncate">{cell(r.rawRow, 'Vendor Name')}</TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {cell(r.rawRow, 'UBBL Number')}
                {r.rawRow['Main Entry Number'] ? (
                  <span className="text-muted-foreground"> / {cell(r.rawRow, 'Main Entry Number')}</span>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">{cell(r.rawRow, 'Invoice Amount')}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {cell(r.rawRow, 'Status')} / {cell(r.rawRow, 'Main Status')}
              </TableCell>
              <TableCell className="max-w-[18rem] text-xs text-muted-foreground">
                {r.action === 'error' && r.note ? (
                  <span className="text-destructive">{r.note}</span>
                ) : r.fieldsChanged && Object.keys(r.fieldsChanged).length > 0 ? (
                  <ul className="space-y-0.5">
                    {Object.entries(r.fieldsChanged).map(([field, change]) => (
                      <li key={field}>
                        <span className="font-medium text-foreground">{field}</span>: {String(change.from ?? '—')}{' '}
                        → {String(change.to ?? '—')}
                      </li>
                    ))}
                  </ul>
                ) : (
                  '—'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
