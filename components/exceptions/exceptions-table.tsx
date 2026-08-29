'use client'

import * as React from 'react'
import { Fragment } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SortableTableHead, nextSort, type SortDirection } from '@/components/ui/sortable-table-head'
import { exceptionTypeLabel, severityBadgeVariant, severityGroupLabel } from '@/components/exceptions/labels'
import { ResolveExceptionDialog } from '@/components/exceptions/resolve-exception-dialog'
import { BulkResolveExceptionsDialog } from '@/components/exceptions/bulk-resolve-exceptions-dialog'
import { getExceptionAction } from '@/components/exceptions/what-to-do'
import {
  QUEUE_DESCENDING_FIRST,
  type QueueSortColumn,
} from '@/components/exceptions/queue-sort'
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
 * have to notice cell-by-cell. Only used for the default severity sort; any
 * other sort renders a flat list in the order the server produced.
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

export function ExceptionsTable({
  exceptions,
  canResolve,
  sortColumn,
  sortDirection,
}: {
  exceptions: ExceptionRow[]
  canResolve: boolean
  sortColumn: QueueSortColumn
  sortDirection: SortDirection
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [selected, setSelected] = React.useState<Set<number>>(new Set())
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [bulkOutcome, setBulkOutcome] = React.useState<'resolved' | 'dismissed'>('resolved')

  const selectableIds = React.useMemo(
    () => (canResolve ? exceptions.filter((e) => e.status === 'open').map((e) => e.id) : []),
    [canResolve, exceptions]
  )
  const selectableIdSet = React.useMemo(() => new Set(selectableIds), [selectableIds])

  // Drop any selection that's no longer on the page (filter change, refresh).
  React.useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => selectableIdSet.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [selectableIdSet])

  const selectionEnabled = canResolve && selectableIds.length > 0
  const columnCount = 8 + (selectionEnabled ? 1 : 0)
  const grouped = sortColumn === 'severity'
  const groups = grouped
    ? groupBySeverity(exceptions)
    : [{ severity: '__all__', rows: exceptions }]

  const allOnPageSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
  const someOnPageSelected = selectableIds.some((id) => selected.has(id))

  function toggleAll() {
    setSelected(allOnPageSelected ? new Set<number>() : new Set(selectableIds))
  }

  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleSort(column: QueueSortColumn) {
    const nextState = nextSort<QueueSortColumn>(
      { column: sortColumn, direction: sortDirection },
      column,
      QUEUE_DESCENDING_FIRST
    )
    const params = new URLSearchParams(searchParams.toString())
    if (nextState.column === 'severity' && nextState.direction === 'desc') {
      params.delete('sort')
      params.delete('dir')
    } else {
      params.set('sort', nextState.column)
      params.set('dir', nextState.direction)
    }
    params.delete('page')
    const query = params.toString()
    router.push(query ? `${pathname}?${query}` : pathname)
  }

  const selectedRows = exceptions.filter((e) => selected.has(e.id))

  return (
    <div className="flex flex-col gap-2">
      {selectionEnabled && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">
            {selected.size} selected
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBulkOutcome('resolved')
                setBulkOpen(true)
              }}
            >
              Resolve {selected.size} selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBulkOutcome('dismissed')
                setBulkOpen(true)
              }}
            >
              Dismiss {selected.size} selected
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-md border border-border [&>div]:max-h-[calc(100vh-16rem)]">
        <Table>
          <TableHeader>
            <TableRow>
              {selectionEnabled && (
                <TableHead className="w-9">
                  <Checkbox
                    aria-label="Select all open exceptions on this page"
                    checked={allOnPageSelected ? true : someOnPageSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
              )}
              <SortableTableHead<QueueSortColumn>
                columnKey="severity"
                label="Severity"
                activeColumn={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
              <SortableTableHead<QueueSortColumn>
                columnKey="type"
                label="Type"
                activeColumn={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
              <TableHead>Entry</TableHead>
              <TableHead className="text-right">Amount at risk</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Status</TableHead>
              <SortableTableHead<QueueSortColumn>
                columnKey="detected_at"
                label="Raised"
                activeColumn={sortColumn}
                direction={sortDirection}
                onSort={handleSort}
              />
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group, groupIndex) => (
              <Fragment key={group.severity}>
                {grouped && (
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
                )}
                {group.rows.map((exception) => {
                  const isSelectable = selectionEnabled && exception.status === 'open'
                  const whatToDo = getExceptionAction({
                    exception_type: exception.exception_type,
                    entry_id: exception.entry_id,
                    document_extraction_id: exception.document_extraction_id,
                    source_document_id: exception.source_document_id,
                  }).whatToDo
                  return (
                    <TableRow key={exception.id} data-state={selected.has(exception.id) ? 'selected' : undefined}>
                      {selectionEnabled && (
                        <TableCell>
                          {isSelectable ? (
                            <Checkbox
                              aria-label={`Select exception ${exception.id}`}
                              checked={selected.has(exception.id)}
                              onCheckedChange={() => toggleRow(exception.id)}
                            />
                          ) : null}
                        </TableCell>
                      )}
                      <TableCell>
                        <Badge
                          variant={severityBadgeVariant(exception.severity)}
                          aria-label={`${severityGroupLabel(exception.severity)}: ${exceptionTypeLabel(exception.exception_type)}`}
                        >
                          {exception.severity}
                        </Badge>
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
                      <TableCell className="max-w-[24rem] text-sm">
                        <span
                          className="block truncate text-muted-foreground"
                          title={exception.description ?? undefined}
                        >
                          {exception.description ?? '—'}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground/80" title={whatToDo}>
                          What to do: {whatToDo}
                        </span>
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
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(exception.created_at)}
                      </TableCell>
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
                  )
                })}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      {selectionEnabled && (
        <BulkResolveExceptionsDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          initialOutcome={bulkOutcome}
          rows={selectedRows.map((r) => ({
            id: r.id,
            exception_type: r.exception_type,
            severity: r.severity,
          }))}
          onResolved={() => setSelected(new Set())}
        />
      )}
    </div>
  )
}
