'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { UploadCloud } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { BatchStatusBadge } from '@/components/import/row-log-badge'
import { RowLogTable, type RowLogEntry } from '@/components/import/row-log-table'
import { SummaryBadges } from '@/components/import/summary-badges'
import { FriendlyError } from '@/components/ui/friendly-error'
import type { ImportResult } from '@/lib/import/run-import'

function isSpreadsheet(file: File): boolean {
  return /\.xlsx?$/i.test(file.name)
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

/**
 * The Departmental import: pick or drop a .xlsx export, preview the diff,
 * commit. Reused as-is on both the dashboard (the primary landing action)
 * and /import (alongside the fuller batch history table) — see
 * components/import/import-page-client.tsx and app/(app)/page.tsx.
 */
export function ImportWorkspace({
  isAdmin,
  onCommitted,
}: {
  isAdmin: boolean
  /** Called after a successful commit, so a host page can refresh its own batch history list. */
  onCommitted?: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [running, setRunning] = useState<'idle' | 'dry_run' | 'commit'>('idle')
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [committed, setCommitted] = useState<ImportResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const chooseFile = useCallback((next: File | null) => {
    setFile(next)
    setPreview(null)
    setCommitted(null)
    setFormError(null)
  }, [])

  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const picked = Array.from(fileList)[0]
      if (!picked) return
      if (!isSpreadsheet(picked)) {
        toast.error('Only .xlsx or .xls files are supported.')
        return
      }
      chooseFile(picked)
    },
    [chooseFile]
  )

  function resetImportState() {
    chooseFile(null)
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
        toastError(body.errorMessage, { title: 'Dry run failed', context: 'import-workspace' })
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
        toastError(body.errorMessage, { title: 'Import failed', context: 'import-workspace' })
      } else {
        toast.success('Import committed.')
      }
      onCommitted?.()
    } catch {
      // Unlike a dry run (rolled back server-side, always safe to retry), a
      // commit that loses its response mid-flight may have already committed
      // its transaction. Blindly resubmitting risks a duplicate import, so
      // this steers toward checking batch history instead of retrying.
      setFormError('The import may still be running. Check batch history before retrying.')
    } finally {
      setRunning('idle')
    }
  }

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm font-medium">You don&apos;t have permission to run imports.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Running an import — dry-run or commit — is restricted to the admin role. Ask an
            admin to run it, or to grant you the role if this is wrong.
          </p>
        </CardContent>
      </Card>
    )
  }

  const activeResult = committed ?? preview
  const activeRows: RowLogEntry[] = activeResult?.rowLog ?? []
  // The commit button is only reachable once a dry run's preview is on
  // screen (it lives in the `activeResult` block below, gated on
  // `!committed`), so `preview.rowCount` — a real count already returned by
  // the dry run, not a live/incrementing figure — is available whenever a
  // commit can actually be triggered. Fall back to a generic label only for
  // the case that stops being true.
  const commitLabel = preview?.rowCount
    ? `Committing ${preview.rowCount.toLocaleString()} rows…`
    : 'Committing…'

  return (
    <Card>
      <CardHeader>
        <CardTitle>New import</CardTitle>
        <CardDescription>
          Drop the Departmental export (.xlsx) or choose it below, review the dry-run diff, then
          commit. The preview is the screen — nothing is written until you commit.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!file ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setIsDragging(false)
              if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files)
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
              isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/40'
            )}
          >
            <UploadCloud className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Drop the .xlsx export here, or tap to browse</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Choose the latest Departmental export to begin.
            </p>
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={(e) => e.stopPropagation()}>
              Choose file
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="sr-only"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="truncate text-sm font-medium">{file.name}</span>
            <Button onClick={handleDryRun} disabled={running !== 'idle'}>
              {running === 'dry_run' ? 'Running dry run…' : 'Run dry-run preview'}
            </Button>
            <Button variant="ghost" onClick={resetImportState} disabled={running !== 'idle'}>
              Choose another file
            </Button>
          </div>
        )}

        {formError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
            <FriendlyError message={formError} />
          </div>
        )}

        {(running === 'dry_run' || running === 'commit') && (
          <div className="flex flex-col gap-2">
            {running === 'commit' && <p className="text-sm text-muted-foreground">{commitLabel}</p>}
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {activeResult && (
          <div
            className={cn(
              'flex flex-col gap-4 border-t border-border pt-4',
              running === 'commit' && 'pointer-events-none opacity-40'
            )}
          >
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
                  {running === 'commit' ? commitLabel : 'Commit this import'}
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
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                <FriendlyError message={activeResult.errorMessage} />
              </div>
            )}

            <RowLogTable rows={activeRows} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
