import { Fragment } from 'react'
import Link from 'next/link'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { exceptionTypeLabel, severityBadgeVariant, severityGroupLabel } from '@/components/exceptions/labels'
import { ResolveExceptionDialog } from '@/components/exceptions/resolve-exception-dialog'
import { cn } from '@/lib/utils'

export interface ExceptionRow {
  id: number
  entry_id: number | null
  document_extraction_id: number | null
  import_batch_id: number | null
  source_document_id: number | null
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

const SEVERITY_GROUP_ORDER = ['high', 'medium', 'low'] as const

/**
 * High and medium rows used to run directly into each other, told apart only
 * by a small badge colour in the first cell — easy to miss the boundary
 * scrolling down a long list. Grouping under a labeled, visually separated
 * header row makes the boundary itself the thing you see, not something you
 * have to notice cell-by-cell.
 */
function groupBySeverity(exceptions: ExceptionRow[]): { severity: string; rows: ExceptionRow[] }[] {
  const bySeverity = new Map<string, ExceptionRow[]>()
  for (const exception of exceptions) {
    const key = exception.severity
    if (!bySeverity.has(key)) bySeverity.set(key, [])
    bySeverity.get(key)!.push(exception)
  }
  const knownOrder = SEVERITY_GROUP_ORDER.filter((s) => bySeverity.has(s))
  const unknownOrder = [...bySeverity.keys()].filter((s) => !(SEVERITY_GROUP_ORDER as readonly string[]).includes(s))
  return [...knownOrder, ...unknownOrder].map((severity) => ({ severity, rows: bySeverity.get(severity)! }))
}

export function ExceptionsTable({ exceptions, canResolve }: { exceptions: ExceptionRow[]; canResolve: boolean }) {
  const groups = groupBySeverity(exceptions)
  const columnCount = 8

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
          {groups.map((group, groupIndex) => (
            <Fragment key={group.severity}>
              <TableRow className="border-b-0 bg-muted/50 hover:bg-muted/50">
                <TableCell
                  colSpan={columnCount}
                  className={cn(
                    'py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground',
                    groupIndex > 0 && 'border-t-2 border-t-border'
                  )}
                >
                  {severityGroupLabel(group.severity)} · {group.rows.length}
                </TableCell>
              </TableRow>
              {group.rows.map((exception) => (
                <TableRow key={exception.id}>
                  <TableCell>
                    <Badge variant={severityBadgeVariant(exception.severity)}>{exception.severity}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">{exceptionTypeLabel(exception.exception_type)}</TableCell>
                  <TableCell>
                    {exception.entry_id ? (
                      <Link
                        href={`/entries/${exception.entry_id}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        #{exception.entry_id}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(exception.amount_at_risk)}</TableCell>
                  <TableCell
                    className="max-w-[24rem] truncate text-sm text-muted-foreground"
                    title={exception.description ?? undefined}
                  >
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
                          <p
                            className="max-w-[16rem] truncate text-xs text-muted-foreground"
                            title={exception.resolution_note}
                          >
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
                        exceptionType={exception.exception_type}
                        entryId={exception.entry_id}
                        documentExtractionId={exception.document_extraction_id}
                        sourceDocumentId={exception.source_document_id}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
