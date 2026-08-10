import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import type { PendingExportEntry } from '@/lib/export/queries'

function formatINR(amount: number | null): string {
  if (amount === null) return '—'
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(
    amount
  )
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

/** Empty state — the honest one, since Day 1's seed data has no entries yet (per the task brief). */
function EmptyQueue() {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border py-10 text-center">
      <p className="text-sm font-medium">Nothing is pending export</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Entries land here once a reviewer sets an entry&apos;s Hub status to &ldquo;Awaiting Verification&rdquo; or
        &ldquo;Awaiting Validation&rdquo;. If entries are expected but not shown, confirm the import has run and
        status changes have been made in Review or Entries.
      </p>
    </div>
  )
}

export function PendingQueueTable({ entries }: { entries: PendingExportEntry[] }) {
  if (entries.length === 0) {
    return <EmptyQueue />
  }

  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>UBBL Number</TableHead>
            <TableHead>Main Entry Number</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>Hub status</TableHead>
            <TableHead>Changed</TableHead>
            <TableHead>Note</TableHead>
            <TableHead className="text-right">Tenant amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="font-mono text-xs">{entry.ubbl_number}</TableCell>
              <TableCell className="font-mono text-xs">{entry.main_number ?? '—'}</TableCell>
              <TableCell>{entry.department_name ?? '—'}</TableCell>
              <TableCell>
                <Badge variant={entry.hub_status_code === 'awaiting_validation' ? 'warning' : 'secondary'}>
                  {entry.hub_status_label ?? entry.hub_status_code ?? '—'}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatDateTime(entry.hub_status_changed_at)}
              </TableCell>
              <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground" title={entry.hub_status_note ?? undefined}>
                {entry.hub_status_note ?? '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatINR(entry.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
