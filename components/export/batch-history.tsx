'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ExportBatchSummary, ExportBatchRow } from '@/lib/export/queries'

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

function statusVariant(status: string): 'secondary' | 'warning' | 'success' | 'destructive' {
  switch (status) {
    case 'delivered':
      return 'warning'
    case 'acknowledged':
      return 'success'
    case 'failed':
      return 'destructive'
    default:
      return 'secondary'
  }
}

/**
 * Batch history — immutable once generated (§3.7: "a delivered export is
 * never rewritten"). Each row supports download, the manual
 * generated -> delivered -> acknowledged status walk, and drilling into
 * `status_export_row` on demand (fetched lazily, not preloaded for every
 * batch on every page load).
 */
export function BatchHistory({ batches }: { batches: ExportBatchSummary[] }) {
  if (batches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border py-10 text-center">
        <p className="text-sm font-medium">No batches generated yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Generated batches appear here, permanently — nothing here is ever rewritten, only appended to.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {batches.map((batch) => (
        <BatchHistoryRow key={batch.id} batch={batch} />
      ))}
    </div>
  )
}

function BatchHistoryRow({ batch }: { batch: ExportBatchSummary }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  const [rows, setRows] = React.useState<ExportBatchRow[] | null>(null)
  const [rowsLoading, setRowsLoading] = React.useState(false)

  async function handleDownload() {
    setBusy(true)
    try {
      const response = await fetch(`/api/export-status?batchId=${batch.id}&download=1`)
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        toast.error('Could not get a download link', { description: body.error ?? `HTTP ${response.status}` })
        return
      }
      const body = await response.json()
      window.open(body.url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.error('Could not get a download link', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  async function handleStatusChange(status: 'delivered' | 'acknowledged') {
    setBusy(true)
    try {
      const response = await fetch('/api/export-status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: batch.id, status }),
      })
      const body = await response.json()
      if (!response.ok) {
        toast.error(`Could not mark batch ${status}`, { description: body.error ?? `HTTP ${response.status}` })
        return
      }
      toast.success(`Batch #${batch.id} marked ${status}`)
      router.refresh()
    } catch (err) {
      toast.error(`Could not mark batch ${status}`, { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  async function toggleExpanded() {
    const next = !expanded
    setExpanded(next)
    if (next && rows === null) {
      setRowsLoading(true)
      try {
        const response = await fetch(`/api/export-status?batchId=${batch.id}`)
        const body = await response.json()
        if (!response.ok) {
          toast.error('Could not load row detail', { description: body.error ?? `HTTP ${response.status}` })
          setRows([])
        } else {
          setRows(body.rows as ExportBatchRow[])
        }
      } catch (err) {
        toast.error('Could not load row detail', { description: err instanceof Error ? err.message : String(err) })
        setRows([])
      } finally {
        setRowsLoading(false)
      }
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm font-medium">Batch #{batch.id}</span>
          <Badge variant={statusVariant(batch.status)}>{batch.status}</Badge>
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{batch.target_system}</span>
          <span className="text-xs text-muted-foreground">
            {batch.row_count} {batch.row_count === 1 ? 'row' : 'rows'}
          </span>
          <span className="text-xs text-muted-foreground">{formatDateTime(batch.created_at)}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={toggleExpanded}>
              {expanded ? 'Hide rows' : 'View rows'}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !batch.storage_path} onClick={handleDownload}>
              Download .xlsx
            </Button>
            {batch.status === 'generated' && (
              <Button size="sm" disabled={busy} onClick={() => handleStatusChange('delivered')}>
                Mark delivered
              </Button>
            )}
            {batch.status === 'delivered' && (
              <Button size="sm" disabled={busy} onClick={() => handleStatusChange('acknowledged')}>
                Mark acknowledged
              </Button>
            )}
          </div>
        </div>

        {batch.status === 'failed' && batch.error_message && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{batch.error_message}</p>
        )}
        {batch.delivered_at && (
          <p className="text-xs text-muted-foreground">Delivered {formatDateTime(batch.delivered_at)}</p>
        )}
        {batch.acknowledged_at && (
          <p className="text-xs text-muted-foreground">
            Acknowledged {formatDateTime(batch.acknowledged_at)}
            {batch.acknowledged_note ? ` — ${batch.acknowledged_note}` : ''}
          </p>
        )}

        {expanded && (
          <div className="rounded-md border border-border">
            {rowsLoading ? (
              <p className="p-3 text-xs text-muted-foreground">Loading rows…</p>
            ) : rows && rows.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>UBBL Number</TableHead>
                    <TableHead>Main Entry Number</TableHead>
                    <TableHead>Hub status</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Changed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">{row.ubbl_number}</TableCell>
                      <TableCell className="font-mono text-xs">{row.main_number ?? '—'}</TableCell>
                      <TableCell className="text-xs">{row.hub_status_code}</TableCell>
                      <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                        {row.hub_status_note ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.changed_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="p-3 text-xs text-muted-foreground">No rows recorded for this batch.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
