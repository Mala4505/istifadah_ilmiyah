'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { UploadCloud } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { BatchStatusBadge } from '@/components/import/row-log-badge'
import { RowLogTable, type RowLogEntry } from '@/components/import/row-log-table'
import { SummaryBadges } from '@/components/import/summary-badges'
import { FriendlyError } from '@/components/ui/friendly-error'
import type { ImportResult } from '@/lib/import/run-import'

type AnyImportResult = ImportResult & { warnings?: string[] }
type ImportResponseBody = Partial<AnyImportResult> & { error?: string }

type FileKind = 'xlsx' | 'portal_json'

interface PickedFile {
  file: File
  kind: FileKind
}

function detectFileKind(file: File): FileKind | null {
  if (/\.xlsx?$/i.test(file.name)) return 'xlsx'
  if (/\.json$/i.test(file.name)) return 'portal_json'
  return null
}

/**
 * Portal-scrape rows-per-request cap for the JSON-fallback upload.
 *
 * lib/import/run-portal-import.ts pays several DB round trips per row
 * (resolver lookups on a cache miss, the entries upsert, and — since
 * 2026-09-26 — a SAVEPOINT/RELEASE pair per row so one bad row can't poison
 * the whole transaction). Measured against a real 834-row scrape that added
 * up to roughly 15 minutes end to end — far past any serverless
 * request-timeout ceiling (app/api/import/portal/route.ts's own maxDuration
 * is 180s), which is what turned a real answer into a generic "Could not
 * reach the server" the operator had no way to act on.
 *
 * 75 rows keeps one chunk's worst-case wall time comfortably under that 180s
 * ceiling even at the measured per-row rate (roughly 1s/row -> ~75s/chunk),
 * leaving headroom for a chunk that happens to contain more brand-new
 * vendors/departments/budget heads than usual (each one is an extra round
 * trip on top of the baseline). Revisit downward if per-row cost goes up;
 * revisit upward once the per-row round-trip count itself comes down.
 */
const PORTAL_CHUNK_SIZE = 75

export interface PortalUploadProgress {
  chunk: number
  totalChunks: number
  rowsDone: number
  rowsTotal: number
}

/**
 * `.json` here is the fallback file public/bookmarklet/read-portal.js downloads
 * when a portal's own `connect-src` CSP blocks its fetch straight to the Hub
 * (see that file's `download()`/`onPostFailure`). Posting it through this same
 * dropzone, signed in as an admin, hits the same importer the bookmarklet
 * itself does — app/api/import/portal/route.ts accepts either a bearer scrape
 * token or a plain Hub session, exactly so this path exists.
 *
 * A scrape past PORTAL_CHUNK_SIZE is split into several sequential requests
 * (never parallel — each writes against the same event/entries, and staying
 * sequential also means a failed chunk's own error message can say exactly
 * how much of the file already committed). Every chunk carries the same
 * scrapeSessionId so the server can defer its "what's missing from the
 * portal" auto-void check to the request tagged as the last chunk, and ask
 * it against every chunk's rows combined — see
 * supabase/migrations/20260927000001's header for why that check breaks if
 * it runs against a partial row set.
 */
async function postImport(
  picked: PickedFile,
  mode: 'dry_run' | 'commit',
  onProgress?: (progress: PortalUploadProgress) => void
): Promise<{ ok: boolean; body: ImportResponseBody }> {
  if (picked.kind === 'xlsx') {
    const formData = new FormData()
    formData.append('file', picked.file)
    formData.append('mode', mode)
    formData.append('source_system', 'departmental')

    const res = await fetch('/api/import', { method: 'POST', body: formData })
    const body = await res.json()
    return { ok: res.ok, body }
  }

  let payload: unknown
  try {
    payload = JSON.parse(await picked.file.text())
  } catch {
    return { ok: false, body: { error: 'That file is not valid JSON.' } }
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Array.isArray((payload as { headers?: unknown }).headers) ||
    !Array.isArray((payload as { rows?: unknown }).rows)
  ) {
    return {
      ok: false,
      body: { error: "That JSON file doesn't look like a Portal Reader scrape (missing headers/rows)." },
    }
  }

  const { rows, ...scrapeFields } = payload as Record<string, unknown> & { rows: unknown[] }

  if (rows.length <= PORTAL_CHUNK_SIZE) {
    const res = await fetch('/api/import/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scrapeFields, rows, mode }),
    })
    const body = await res.json()
    return { ok: res.ok, body }
  }

  const scrapeSessionId = crypto.randomUUID()
  const chunks: unknown[][] = []
  for (let i = 0; i < rows.length; i += PORTAL_CHUNK_SIZE) {
    chunks.push(rows.slice(i, i + PORTAL_CHUNK_SIZE))
  }

  const combined: AnyImportResult = {
    batchId: 0,
    mode,
    status: 'completed',
    rowCount: 0,
    summary: {},
    rowLog: [],
    exceptions: [],
    warnings: [],
  }
  let rowsDone = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const isFinalChunk = i === chunks.length - 1
    onProgress?.({ chunk: i + 1, totalChunks: chunks.length, rowsDone, rowsTotal: rows.length })

    let res: Response
    let body: ImportResponseBody
    try {
      res = await fetch('/api/import/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...scrapeFields, rows: chunk, mode, scrapeSessionId, isFinalChunk }),
      })
      body = await res.json()
    } catch {
      // Sequential and awaited, so every EARLIER chunk's request already
      // resolved before this one started — "rowsDone" rows are the ones a
      // commit has actually landed by now, not a guess.
      return {
        ok: false,
        body: {
          error:
            mode === 'commit'
              ? `Could not reach the server on chunk ${i + 1} of ${chunks.length} (rows ${rowsDone + 1}-${rowsDone + chunk.length}). Rows 1-${rowsDone} were already committed successfully — re-uploading the same file is safe once the connection issue is fixed (imports upsert by UBBL number, so already-committed rows just update harmlessly).`
              : `Could not reach the server on chunk ${i + 1} of ${chunks.length}. Nothing was written — a dry run never commits.`,
        },
      }
    }

    if (!res.ok) {
      const baseError = (body as { error?: string }).error ?? 'Import failed.'
      return {
        ok: false,
        body: {
          ...body,
          error:
            mode === 'commit'
              ? `${baseError} (chunk ${i + 1} of ${chunks.length}, rows ${rowsDone + 1}-${rowsDone + chunk.length}). Rows 1-${rowsDone} were already committed successfully — re-uploading the same file is safe once this is fixed (imports upsert by UBBL number).`
              : `${baseError} (chunk ${i + 1} of ${chunks.length}). Nothing was written — a dry run never commits.`,
        },
      }
    }

    const chunkResult = body as Partial<AnyImportResult>
    combined.batchId = chunkResult.batchId ?? combined.batchId
    combined.rowCount += chunkResult.rowCount ?? 0
    combined.rowLog = [
      ...combined.rowLog,
      ...(chunkResult.rowLog ?? []).map((entry) => ({ ...entry, rowNumber: entry.rowNumber + rowsDone })),
    ]
    combined.exceptions = [...combined.exceptions, ...(chunkResult.exceptions ?? [])]
    combined.warnings = [...(combined.warnings ?? []), ...(chunkResult.warnings ?? [])]
    for (const [action, count] of Object.entries(chunkResult.summary ?? {})) {
      combined.summary[action] = (combined.summary[action] ?? 0) + count
    }
    // Each chunk's own status already accounts for its row-level errors
    // (lib/import/run-portal-import.ts) -- 'failed' beats
    // 'completed_with_exceptions' beats 'completed', and once any chunk
    // fails the rest is no longer a clean success even if later chunks are.
    if (chunkResult.status === 'failed') combined.status = 'failed'
    else if (combined.status !== 'failed' && chunkResult.status === 'completed_with_exceptions') {
      combined.status = 'completed_with_exceptions'
    }

    rowsDone += chunk.length
  }

  onProgress?.({ chunk: chunks.length, totalChunks: chunks.length, rowsDone, rowsTotal: rows.length })
  return { ok: true, body: combined }
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
  const [file, setFile] = useState<PickedFile | null>(null)
  const [running, setRunning] = useState<'idle' | 'dry_run' | 'commit'>('idle')
  const [preview, setPreview] = useState<AnyImportResult | null>(null)
  const [committed, setCommitted] = useState<AnyImportResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [chunkProgress, setChunkProgress] = useState<PortalUploadProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const chooseFile = useCallback((next: PickedFile | null) => {
    setFile(next)
    setPreview(null)
    setCommitted(null)
    setFormError(null)
    setChunkProgress(null)
  }, [])

  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const picked = Array.from(fileList)[0]
      if (!picked) return
      const kind = detectFileKind(picked)
      if (!kind) {
        toast.error('Only .xlsx, .xls, or a Portal Reader .json fallback file are supported.')
        return
      }
      chooseFile({ file: picked, kind })
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
    setChunkProgress(null)
    try {
      const { ok, body } = await postImport(file, 'dry_run', setChunkProgress)
      if (!ok) {
        setFormError(body.error ?? 'Dry run failed.')
        setPreview(null)
        return
      }
      setPreview(body as AnyImportResult)
      if (body.status === 'failed') {
        toastError(body.errorMessage, { title: 'Dry run failed', context: 'import-workspace' })
      } else {
        toast.success(`Dry run complete — ${body.rowCount} rows parsed.`)
      }
    } catch {
      setFormError('Could not reach the server.')
    } finally {
      setRunning('idle')
      setChunkProgress(null)
    }
  }

  async function handleCommit() {
    if (!file) return
    setRunning('commit')
    setFormError(null)
    setChunkProgress(null)
    try {
      const { ok, body } = await postImport(file, 'commit', setChunkProgress)
      if (!ok) {
        setFormError(body.error ?? 'Commit failed.')
        return
      }
      setCommitted(body as AnyImportResult)
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
      setChunkProgress(null)
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
          commit. The preview is the screen — nothing is written until you commit. If the Portal
          Reader bookmarklet couldn&apos;t reach the Hub directly, drop the .json file it downloaded
          here instead — it goes through the same preview-then-commit flow.
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
              Choose the latest Departmental export, or a Portal Reader fallback .json file, to
              begin.
            </p>
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={(e) => e.stopPropagation()}>
              Choose file
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.json"
              className="sr-only"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="truncate text-sm font-medium">{file.file.name}</span>
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
            {chunkProgress ? (
              <div className="flex flex-col gap-1.5">
                <Progress value={(chunkProgress.rowsDone / chunkProgress.rowsTotal) * 100} />
                <p className="text-sm text-muted-foreground">
                  {running === 'commit' ? 'Committing' : 'Previewing'} in batches — chunk{' '}
                  {chunkProgress.chunk} of {chunkProgress.totalChunks} ({chunkProgress.rowsDone.toLocaleString()} of{' '}
                  {chunkProgress.rowsTotal.toLocaleString()} rows sent so far)
                </p>
              </div>
            ) : (
              <Skeleton className="h-4 w-64" />
            )}
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

            {activeResult.warnings && activeResult.warnings.length > 0 && (
              <div className="rounded-md border border-amber-300/50 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                <ul className="list-inside list-disc space-y-0.5 text-amber-800 dark:text-amber-300">
                  {activeResult.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

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
