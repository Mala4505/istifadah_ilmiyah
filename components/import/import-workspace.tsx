'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { BatchStatusBadge } from '@/components/import/row-log-badge'
import { RowLogTable, type RowLogEntry } from '@/components/import/row-log-table'
import { SummaryBadges } from '@/components/import/summary-badges'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { ImportResult } from '@/lib/import/run-import'

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

async function postImport(file: File, mode: 'dry_run' | 'commit'): Promise<{ ok: boolean; body: ImportResult & { error?: string } }> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('mode', mode)
  formData.append('source_system', 'departmental')

  const res = await fetch('/api/import', { method: 'POST', body: formData })
  const body = await res.json()
  return { ok: res.ok, body }
}

export function ImportWorkspace({ isAdmin }: { isAdmin: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [running, setRunning] = useState<'idle' | 'dry_run' | 'commit'>('idle')
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [committed, setCommitted] = useState<ImportResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
  }, [isAdmin, loadHistory])

  function resetImportState() {
    setFile(null)
    setPreview(null)
    setCommitted(null)
    setFormError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleDryRun() {
    if (!file) return
    setRunning('dry_run')
    setFormError(null)
    setCommitted(null)
    try {
      const { ok, body } = await postImport(file, 'dry_run')
      if (!ok) {
        setFormError(body.error ?? 'Dry run failed.')
        setPreview(null)
        return
      }
      setPreview(body)
      if (body.status === 'failed') {
        toast.error(`Dry run failed: ${body.errorMessage ?? 'unknown error'}`)
      } else {
        toast.success(`Dry run complete — ${body.rowCount} rows parsed.`)
      }
    } catch {
      setFormError('Could not reach the server.')
    } finally {
      setRunning('idle')
    }
  }

  async function handleCommit() {
    if (!file) return
    setRunning('commit')
    setFormError(null)
    try {
      const { ok, body } = await postImport(file, 'commit')
      if (!ok) {
        setFormError(body.error ?? 'Commit failed.')
        return
      }
      setCommitted(body)
      if (body.status === 'failed') {
        toast.error(`Import failed: ${body.errorMessage ?? 'unknown error'}`)
      } else {
        toast.success('Import committed.')
      }
      void loadHistory()
    } catch {
      setFormError('Could not reach the server.')
    } finally {
      setRunning('idle')
    }
  }

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
        toast.error(body.error ?? 'Could not load batch detail.')
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

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm font-medium">You don&apos;t have permission to run imports.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Running an import — dry-run or commit — is restricted to the admin role
            (MASTER-PLAN §4.4c). Ask an admin to run it, or to grant you the role if this is
            wrong.
          </p>
        </CardContent>
      </Card>
    )
  }

  const activeResult = committed ?? preview
  const activeRows: RowLogEntry[] = activeResult?.rowLog ?? []

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>New import</CardTitle>
          <CardDescription>
            Upload a Departmental export, review the dry-run diff below, then commit. The
            preview is the screen — nothing is written until you commit.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setPreview(null)
                setCommitted(null)
                setFormError(null)
              }}
              className="block w-full max-w-sm text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
            />
            <Button onClick={handleDryRun} disabled={!file || running !== 'idle'}>
              {running === 'dry_run' ? 'Running dry run…' : 'Run dry-run preview'}
            </Button>
            {(preview || committed) && (
              <Button variant="ghost" onClick={resetImportState} disabled={running !== 'idle'}>
                Choose another file
              </Button>
            )}
          </div>

          {formError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {formError}
            </div>
          )}

          {running === 'dry_run' && (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {activeResult && (
            <div className="flex flex-col gap-4 border-t border-border pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <BatchStatusBadge status={activeResult.status} />
                  <span className="text-sm text-muted-foreground">
                    {committed ? 'Committed' : 'Dry run (not written)'} · batch #{activeResult.batchId} ·{' '}
                    {activeResult.rowCount} rows
                  </span>
                </div>
                {!committed && activeResult.status !== 'failed' && (
                  <Button onClick={handleCommit} disabled={running !== 'idle'}>
                    {running === 'commit' ? 'Committing…' : 'Commit this import'}
                  </Button>
                )}
              </div>

              <SummaryBadges summary={activeResult.summary} />

              {activeResult.exceptions.length > 0 && (
                <div className="rounded-md border border-amber-300/50 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                  <p className="mb-1 font-medium text-amber-900 dark:text-amber-200">
                    {activeResult.exceptions.length} exception
                    {activeResult.exceptions.length === 1 ? '' : 's'} raised
                  </p>
                  <ul className="list-inside list-disc space-y-0.5 text-amber-800 dark:text-amber-300">
                    {activeResult.exceptions.map((exc, i) => (
                      <li key={i}>
                        <span className="font-medium uppercase">{exc.severity}</span> — {exc.description}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {activeResult.errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {activeResult.errorMessage}
                </div>
              )}

              <RowLogTable rows={activeRows} />
            </div>
          )}

          {!file && !activeResult && (
            <p className="text-sm text-muted-foreground">
              No file selected. Choose the latest Departmental export (.xlsx) to begin.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Batch history</CardTitle>
          <CardDescription>Past import runs. Select a row to see its per-row log.</CardDescription>
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
            <p className="text-sm text-muted-foreground">No imports have been run yet.</p>
          ) : (
            <div className="rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead>Mode</TableHead>
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
                        <TableCell className="capitalize">{b.mode.replace('_', ' ')}</TableCell>
                        <TableCell>
                          <BatchStatusBadge status={b.status} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{b.row_count ?? '—'}</TableCell>
                      </TableRow>
                      {selectedBatch === b.id && (
                        <TableRow>
                          <TableCell colSpan={5} className="bg-muted/30 p-3">
                            {batchDetailLoading ? (
                              <Skeleton className="h-24 w-full" />
                            ) : b.error_message ? (
                              <p className="text-sm text-destructive">{b.error_message}</p>
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
    </div>
  )
}
