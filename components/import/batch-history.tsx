'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { FriendlyError } from '@/components/ui/friendly-error'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { BatchStatusBadge } from '@/components/import/row-log-badge'
import { RowLogTable, type RowLogEntry } from '@/components/import/row-log-table'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface ImportBatchRow {
  id: number
  source_filename: string
  mode: string
  status: string
  row_count: number | null
  summary_jsonb: Record<string, number> | null
  started_at: string
  completed_at: string | null
  error_message: string | null
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/**
 * What actually happened: committed batches only (both the .xlsx upload and
 * the Portal Reader write here). Dry runs never keep row-level detail (see
 * app/api/import/route.ts), so they are excluded server-side rather than
 * shown as an entry that always opens to "No rows to show."
 */
export function BatchHistory({ isAdmin, refreshSignal }: { isAdmin: boolean; refreshSignal?: number }) {
  const [batches, setBatches] = useState<ImportBatchRow[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedBatch, setSelectedBatch] = useState<number | null>(null)
  const [selectedBatchRows, setSelectedBatchRows] = useState<RowLogEntry[] | null>(null)
  const [batchDetailLoading, setBatchDetailLoading] = useState(false)

  const loadHistory = useCallback(async () => {
    setHistoryError(null)
    try {
      const res = await fetch('/api/import')
      const body = await res.json()
      if (!res.ok) {
        setHistoryError(body.error ?? 'Could not load import history.')
        setBatches([])
        return
      }
      setBatches(body.batches ?? [])
    } catch {
      setHistoryError('Could not reach the server.')
      setBatches([])
    }
  }, [])

  useEffect(() => {
    if (isAdmin) void loadHistory()
    // refreshSignal is bumped by a host page after a commit elsewhere on the
    // screen (e.g. the Portal Reader), which this component has no other way
    // to observe.
  }, [isAdmin, loadHistory, refreshSignal])

  async function toggleBatchDetail(batchId: number) {
    if (selectedBatch === batchId) {
      setSelectedBatch(null)
      setSelectedBatchRows(null)
      return
    }
    setSelectedBatch(batchId)
    setSelectedBatchRows(null)
    setBatchDetailLoading(true)
    try {
      const res = await fetch(`/api/import?batchId=${batchId}`)
      const body = await res.json()
      if (!res.ok) {
        toastError(body.error, { title: 'Could not load batch detail.', context: 'batch-history' })
        setSelectedBatchRows([])
        return
      }
      setSelectedBatchRows(
        (body.rows ?? []).map((r: Record<string, unknown>) => ({
          rowNumber: r.row_number,
          rawRow: r.raw_row_jsonb,
          action: r.action,
          entryId: r.entry_id,
          fieldsChanged: r.fields_changed,
        }))
      )
    } catch {
      toast.error('Could not reach the server.')
      setSelectedBatchRows([])
    } finally {
      setBatchDetailLoading(false)
    }
  }

  if (!isAdmin) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>What&rsquo;s been imported</CardTitle>
        <CardDescription>Every committed import — file upload and Portal Reader alike. Select a row to see its per-row detail.</CardDescription>
      </CardHeader>
      <CardContent>
        {historyError && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {historyError}
          </div>
        )}

        {batches === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No imports have been committed yet.</p>
        ) : (
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((b) => (
                  <Fragment key={b.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => toggleBatchDetail(b.id)}
                      aria-expanded={selectedBatch === b.id}
                    >
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(b.started_at)}
                      </TableCell>
                      <TableCell className="max-w-[20rem] truncate">{b.source_filename}</TableCell>
                      <TableCell>
                        <BatchStatusBadge status={b.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{b.row_count ?? '—'}</TableCell>
                    </TableRow>
                    {selectedBatch === b.id && (
                      <TableRow>
                        <TableCell colSpan={4} className="bg-muted/30 p-3">
                          {batchDetailLoading ? (
                            <Skeleton className="h-24 w-full" />
                          ) : b.error_message ? (
                            <FriendlyError message={b.error_message} />
                          ) : (
                            <RowLogTable rows={selectedBatchRows ?? []} />
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
