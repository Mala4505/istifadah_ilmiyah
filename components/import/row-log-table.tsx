import Link from 'next/link'
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

export interface RowLogEntry {
  rowNumber: number
  rawRow: Record<string, unknown>
  action: string
  entryId: number | null
  fieldsChanged: Record<string, { from: unknown; to: unknown }> | null
  note?: string | null
}

/**
 * A .xlsx-sourced row's rawRow is keyed by the export's exact column names
 * ("Budget Head", "Vendor Name", ...). A portal-scraped row's rawRow is keyed
 * by whatever header text that portal happens to render ("Vendor", "Amount",
 * "Entry Number", ...) — see the synonym table in lib/import/portal-mapping.ts.
 * Looking up a single exact key left these columns blank for every
 * portal-sourced row even though the data was right there under a different
 * header. This normalizes both the row's own keys and a list of candidate
 * names, so either source resolves to the same display cell.
 */
function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function pickCell(row: Record<string, unknown>, candidates: readonly string[]): string {
  const normalized = new Map<string, unknown>()
  for (const [key, value] of Object.entries(row)) {
    normalized.set(normalizeKey(key), value)
  }
  for (const candidate of candidates) {
    const value = normalized.get(candidate)
    if (value !== null && value !== undefined && value !== '') return String(value)
  }
  return '—'
}

const BUDGET_HEAD_KEYS = ['budget head', 'budgethead', 'head', 'budget']
const VENDOR_KEYS = ['vendor name', 'vendor', 'party name', 'party', 'supplier name', 'supplier']
const UBBL_KEYS = ['ubbl number', 'ubbl no', 'ubbl', 'entry number', 'entry no']
const MAIN_KEYS = ['main entry number', 'main number', 'main no', 'main']
const INVOICE_AMOUNT_KEYS = ['invoice amount', 'amount', 'total amount', 'total', 'value']
const STATUS_KEYS = ['status', 'entry status', 'departmental status', 'tenant status']
const MAIN_STATUS_KEYS = ['main status', 'audit status', 'approval status']

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
              <TableCell className="max-w-[16rem] truncate">{pickCell(r.rawRow, BUDGET_HEAD_KEYS)}</TableCell>
              <TableCell className="max-w-[14rem] truncate">{pickCell(r.rawRow, VENDOR_KEYS)}</TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {r.entryId !== null ? (
                  <Link href={`/entries/${r.entryId}`} className="text-primary underline-offset-2 hover:underline">
                    {pickCell(r.rawRow, UBBL_KEYS)}
                  </Link>
                ) : (
                  pickCell(r.rawRow, UBBL_KEYS)
                )}
                {pickCell(r.rawRow, MAIN_KEYS) !== '—' ? (
                  <span className="text-muted-foreground"> / {pickCell(r.rawRow, MAIN_KEYS)}</span>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">{pickCell(r.rawRow, INVOICE_AMOUNT_KEYS)}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {pickCell(r.rawRow, STATUS_KEYS)} / {pickCell(r.rawRow, MAIN_STATUS_KEYS)}
              </TableCell>
              <TableCell className="max-w-[18rem] text-xs text-muted-foreground">
                {r.action === 'error' && r.note ? (
                  <FriendlyError message={r.note} />
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
