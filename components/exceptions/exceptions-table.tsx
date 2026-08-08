import Link from 'next/link'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { exceptionTypeLabel, severityBadgeVariant } from '@/components/exceptions/labels'
import { ResolveExceptionDialog } from '@/components/exceptions/resolve-exception-dialog'

export interface ExceptionRow {
  id: number
  entry_id: number | null
  exception_type: string
  severity: string
  amount_at_risk: number | null
  description: string | null
  status: string
  resolution_note: string | null
  resolved_at: string | null
  created_at: string
}

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

export function ExceptionsTable({ exceptions, canResolve }: { exceptions: ExceptionRow[]; canResolve: boolean }) {
  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Severity</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Entry</TableHead>
            <TableHead className="text-right">Amount at risk</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Raised</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {exceptions.map((exception) => (
            <TableRow key={exception.id}>
              <TableCell>
                <Badge variant={severityBadgeVariant(exception.severity)}>{exception.severity}</Badge>
              </TableCell>
              <TableCell className="text-sm">{exceptionTypeLabel(exception.exception_type)}</TableCell>
              <TableCell>
                {exception.entry_id ? (
                  <Link href={`/entries/${exception.entry_id}`} className="font-mono text-xs text-primary hover:underline">
                    #{exception.entry_id}
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatINR(exception.amount_at_risk)}</TableCell>
              <TableCell className="max-w-[24rem] text-sm text-muted-foreground">
                {exception.description ?? '—'}
              </TableCell>
              <TableCell>
                {exception.status === 'open' ? (
                  <Badge variant="secondary">open</Badge>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <Badge variant={exception.status === 'resolved' ? 'success' : 'outline'}>
                      {exception.status}
                    </Badge>
                    {exception.resolution_note && (
                      <p className="max-w-[16rem] truncate text-xs text-muted-foreground" title={exception.resolution_note}>
                        {exception.resolution_note}
                      </p>
                    )}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{formatDateTime(exception.created_at)}</TableCell>
              <TableCell>
                {exception.status === 'open' && canResolve && (
                  <ResolveExceptionDialog
                    exceptionId={exception.id}
                    amountAtRisk={exception.amount_at_risk}
                    description={exception.description}
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
