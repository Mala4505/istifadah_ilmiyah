'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, CheckCircle2, Circle, FileText, Loader2, UploadCloud, WifiOff, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { friendlyErrorMessage, logRawError } from '@/lib/friendly-error'
import { stagesFor, type StageState } from './document-card'
import { formatElapsed } from './format'
import type { InboxDocumentView } from './types'

/**
 * Upload UI for the document inbox (MASTER-PLAN §5 row 6, §5 "upload and
 * the document inbox are explicitly designed for phone use — staff
 * photograph bills on site", §11.2 Day 3). Posts straight to the existing
 * `app/api/documents/ingest/route.ts` — no client-side pdf.js rasterization
 * here, per that route's own header comment: it reads the raw PDF
 * server-side, so this component's only job is picking files and reporting
 * per-file progress while they upload.
 *
 * "Staff photograph bills on site" in practice means a phone scan-to-PDF
 * app (Camera apps that output a raw JPEG are not handled — the ingest
 * route only accepts PDF, §8), which is why file selection is restricted to
 * `application/pdf` rather than opening a camera capture flow.
 *
 * Picking a file only stages it — nothing is sent until the file is
 * explicitly confirmed (per-file "Upload & extract", or "Upload all" for a
 * multi-file drop), since `/api/documents/ingest` now awaits this
 * document's own extraction before responding (it no longer also drains the
 * rest of the backlog — see that route's header comment). A staged or
 * in-flight file can also be pulled back at any point: staged files are just
 * removed from the list before anything is sent, and an in-flight upload is
 * aborted via the same XMLHttpRequest the progress bar reads from (stored in
 * `xhrsRef`, keyed by item — nothing else in this component needs it).
 *
 * Once the ingest request resolves with a `documentId`, the item stops
 * showing a percentage (there is nothing left to measure — extraction is a
 * one-shot, non-streaming call) and switches to polling
 * `GET /api/documents/status?ids=<documentId>` every 4s, feeding the result
 * into `stagesFor` (components/documents/document-card.tsx) — the same
 * Uploaded → Queued → Extracting → Extracted/Failed stage mapping the inbox
 * cards use below, so this no longer freezes on a static "Queued for
 * extraction" label once the row actually exists. Polling stops once the
 * document reaches `processed`/`failed`, or when the item is
 * removed/dismissed.
 */

type UploadItemStatus = 'staged' | 'uploading' | 'tracking' | 'error' | 'connection-lost'

type DocStatus = InboxDocumentView['uploadStatus']

interface UploadItem {
  key: string
  filename: string
  status: UploadItemStatus
  progress: number
  error?: string
  documentId?: number
  docStatus?: DocStatus
  trackingStartedAt?: string
  /** Set only when the ingest response that produced this item's documentId
   *  was itself a non-2xx ("inconclusive" — see uploadOne below). Cleared as
   *  soon as the first status poll actually confirms the document exists. */
  unconfirmed?: boolean
}

/** Distinguishes a true network-level failure (no response body was ever
 *  received, so there is genuinely no documentId available) from a clean
 *  HTTP error response (400/415/413 etc. — the request completed and really
 *  was rejected). Only the former should avoid saying "failed", since after
 *  the ingest route's own-job-only change, the server may already have
 *  created the row and started extraction even though this HTTP round-trip
 *  never completed. */
class UploadNetworkError extends Error {}

function uploadOne(
  file: File,
  onProgress: (pct: number) => void,
  onXhr: (xhr: XMLHttpRequest) => void
): Promise<{ documentId: number; inconclusive?: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/documents/ingest')
    onXhr(xhr)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // Non-JSON error body (e.g. a platform 502) — status check below still fires.
      }
      const hasDocumentId = !!body && typeof body === 'object' && 'documentId' in (body as Record<string, unknown>)
      if (hasDocumentId) {
        const documentId = (body as { documentId: number }).documentId
        const ok = xhr.status >= 200 && xhr.status < 300
        // Even on a non-2xx response, the `source_document` row (and its
        // extraction job) can already exist server-side — the ingest route's
        // job_queue-insert-failure path returns `{ error, documentId }` with
        // a 500. That document is genuinely still possibly in flight, so
        // this resolves (not rejects) and lets the caller track it through
        // the same stage poller as a clean upload, instead of reporting a
        // hard error for a document that may well be extracting right now.
        resolve({ documentId, inconclusive: !ok })
        return
      }
      const message =
        body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
          ? String((body as { error: unknown }).error)
          : `Upload failed (HTTP ${xhr.status}).`
      reject(new Error(message))
    }

    // True network failures: the request never got far enough to learn
    // anything, so there is no documentId to fall back on — different from
    // xhr.onload's non-2xx-with-a-body case above, and handled distinctly by
    // the caller (UploadNetworkError vs. a plain validation Error).
    xhr.onerror = () => reject(new UploadNetworkError('Network error during upload.'))
    xhr.ontimeout = () => reject(new UploadNetworkError('Upload timed out.'))
    xhr.onabort = () => reject(new Error('Canceled.'))

    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

const STATUS_POLL_INTERVAL_MS = 4_000

function StageDot({ state }: { state: StageState }) {
  if (state === 'done') return <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden="true" />
  if (state === 'active') return <Loader2 className="h-3 w-3 animate-spin text-amber-600" aria-hidden="true" />
  if (state === 'failed') return <XCircle className="h-3 w-3 text-destructive" aria-hidden="true" />
  return <Circle className="h-3 w-3 text-muted-foreground/40" aria-hidden="true" />
}

/** Mirrors document-card.tsx's private `elapsedLabelFor` — kept as a small
 *  local copy rather than exporting that one too, since the task on this
 *  file only calls for exporting `stagesFor`/`StageState`. */
function trackingCaption(docStatus: DocStatus, startedAt: string): string {
  const elapsed = formatElapsed(startedAt)
  switch (docStatus) {
    case 'uploaded':
      return `queued ${elapsed}`
    case 'processing':
      return `extracting, started ${elapsed}`
    case 'failed':
      return `failed ${elapsed}`
    case 'processed':
      return `extracted ${elapsed}`
  }
}

function StageTracker({
  docStatus,
  startedAt,
  unconfirmed,
}: {
  docStatus: DocStatus
  startedAt: string
  unconfirmed?: boolean
}) {
  const stages = stagesFor(docStatus)
  return (
    <div className="flex flex-shrink-0 flex-col items-end gap-0.5">
      <div className="flex items-center gap-1">
        {stages.map((stage, i) => (
          <span key={stage.label} className="flex items-center gap-1">
            {i > 0 && <span className="text-[10px] text-muted-foreground/40">&rarr;</span>}
            <StageDot state={stage.state} />
          </span>
        ))}
      </div>
      <span className="text-[10px] text-muted-foreground">
        {/* The upload response itself was inconclusive (non-2xx but still
            carried a documentId — see uploadOne) — say so until the first
            status poll actually confirms the row exists. */}
        {unconfirmed ? 'confirming…' : trackingCaption(docStatus, startedAt)}
      </span>
    </div>
  )
}

export function UploadDropzone({
  onUploaded,
  compact = false,
}: {
  onUploaded: () => void
  /** Renders a slim, single-row drop target instead of the full ~230px
   *  invitation panel (MASTER-PLAN §7.8f). Passed by document-inbox.tsx once
   *  the inbox already holds documents — at that point the panel's job is
   *  "let me add one more file", not "convince a first-time user to try
   *  this", so it shouldn't push the list below the fold. Drag-and-drop and
   *  click-to-browse both keep working identically; only the layout/size of
   *  the target itself changes. */
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<UploadItem[]>([])
  const [isDragging, setIsDragging] = useState(false)

  // None of these belong in React state — the File object isn't
  // serializable/comparable in a way that should trigger re-renders, the
  // XMLHttpRequest and poll timers are only ever reached from event handlers
  // or interval callbacks (never rendered directly).
  const filesRef = useRef<Map<string, File>>(new Map())
  const xhrsRef = useRef<Map<string, XMLHttpRequest>>(new Map())
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())

  // Poll timers are tied to the component's lifetime, not any single item's
  // — this only fires on unmount, as a backstop alongside the per-item
  // cleanup in stopTracking/removeItem below.
  useEffect(() => {
    const timers = pollTimersRef.current
    return () => {
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
    }
  }, [])

  const handleFiles = useCallback((fileList: FileList | File[]) => {
    const all = Array.from(fileList)
    const pdfFiles = all.filter(isPdf)
    const rejectedCount = all.length - pdfFiles.length
    if (rejectedCount > 0) {
      toast.error(`${rejectedCount} file${rejectedCount === 1 ? '' : 's'} skipped — only PDF is supported.`)
    }
    if (pdfFiles.length === 0) return

    const newItems: UploadItem[] = pdfFiles.map((f) => {
      const key = `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      filesRef.current.set(key, f)
      return { key, filename: f.name, status: 'staged', progress: 0 }
    })
    setItems((current) => [...newItems, ...current])
  }, [])

  const stopTracking = useCallback((key: string) => {
    const timer = pollTimersRef.current.get(key)
    if (timer) {
      clearInterval(timer)
      pollTimersRef.current.delete(key)
    }
  }, [])

  const pollStatus = useCallback(
    (key: string, documentId: number) => {
      void (async () => {
        try {
          const res = await fetch(`/api/documents/status?ids=${documentId}`)
          if (!res.ok) return // transient — the next tick retries
          const body = (await res.json()) as {
            documents: Array<{ id: number; uploadStatus: DocStatus; hasExtraction: boolean }>
          }
          const doc = body.documents.find((d) => d.id === documentId)
          if (!doc) return // not (yet) visible — the next tick retries
          setItems((current) =>
            current.map((c) => (c.key === key ? { ...c, docStatus: doc.uploadStatus, unconfirmed: false } : c))
          )
          if (doc.uploadStatus === 'processed' || doc.uploadStatus === 'failed') {
            stopTracking(key)
          }
        } catch (err) {
          logRawError('upload-dropzone-status-poll', err)
          // Transient — the next interval tick retries; no item state change.
        }
      })()
    },
    [stopTracking]
  )

  const beginTracking = useCallback(
    (key: string, documentId: number, inconclusive: boolean) => {
      const startedAt = new Date().toISOString()
      setItems((current) =>
        current.map((c) =>
          c.key === key
            ? {
                ...c,
                status: 'tracking',
                documentId,
                docStatus: 'uploaded',
                trackingStartedAt: startedAt,
                unconfirmed: inconclusive,
              }
            : c
        )
      )
      pollStatus(key, documentId)
      const timer = setInterval(() => pollStatus(key, documentId), STATUS_POLL_INTERVAL_MS)
      pollTimersRef.current.set(key, timer)
    },
    [pollStatus]
  )

  const startUpload = useCallback(
    (item: UploadItem) => {
      const file = filesRef.current.get(item.key)
      if (!file) return

      setItems((current) => current.map((c) => (c.key === item.key ? { ...c, status: 'uploading', progress: 0 } : c)))

      uploadOne(
        file,
        (pct) => {
          setItems((current) => current.map((c) => (c.key === item.key ? { ...c, progress: pct } : c)))
        },
        (xhr) => {
          xhrsRef.current.set(item.key, xhr)
        }
      )
        .then(({ documentId, inconclusive }) => {
          filesRef.current.delete(item.key)
          xhrsRef.current.delete(item.key)
          beginTracking(item.key, documentId, !!inconclusive)
          onUploaded()
        })
        .catch((err: unknown) => {
          xhrsRef.current.delete(item.key)
          // Aborted via the Cancel button — removeItem already dropped it
          // from the list, so there's nothing left to mark as errored.
          if (err instanceof Error && err.message === 'Canceled.' && !filesRef.current.has(item.key)) {
            return
          }
          filesRef.current.delete(item.key)
          logRawError('upload-dropzone', err)
          if (err instanceof UploadNetworkError) {
            // No response body ever arrived, so there's no documentId to
            // track — but after the ingest route's own-job-only change, the
            // server may well have already created the row and started
            // extraction before this HTTP round-trip fell over. Saying
            // "Upload failed" here would be a guess this component can't
            // back up, so it says the honest, neutral thing instead.
            setItems((current) =>
              current.map((c) => (c.key === item.key ? { ...c, status: 'connection-lost' } : c))
            )
            return
          }
          setItems((current) =>
            current.map((c) =>
              c.key === item.key
                ? { ...c, status: 'error', error: err instanceof Error ? err.message : 'Upload failed.' }
                : c
            )
          )
        })
    },
    [beginTracking, onUploaded]
  )

  function uploadAllStaged() {
    for (const item of items) {
      if (item.status === 'staged') startUpload(item)
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)
    if (event.dataTransfer.files.length > 0) handleFiles(event.dataTransfer.files)
  }

  function removeItem(key: string) {
    const xhr = xhrsRef.current.get(key)
    if (xhr) xhr.abort()
    xhrsRef.current.delete(key)
    filesRef.current.delete(key)
    stopTracking(key)
    setItems((current) => current.filter((c) => c.key !== key))
  }

  const stagedCount = items.filter((i) => i.status === 'staged').length
  const isFinishedItem = (i: UploadItem) =>
    i.status === 'error' ||
    i.status === 'connection-lost' ||
    (i.status === 'tracking' && (i.docStatus === 'processed' || i.docStatus === 'failed'))
  const hasFinished = items.some(isFinishedItem)

  return (
    <div className="flex flex-col gap-3">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={cn(
          'flex cursor-pointer rounded-lg border-2 border-dashed text-center transition-colors',
          compact
            ? 'flex-row items-center justify-center gap-2 px-3 py-2.5'
            : 'flex-col items-center justify-center gap-2 px-4 py-8 sm:py-10',
          isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/40'
        )}
      >
        <UploadCloud
          className={cn('flex-shrink-0 text-muted-foreground', compact ? 'h-4 w-4' : 'h-8 w-8')}
          aria-hidden="true"
        />
        <p className={cn('font-medium', compact ? 'text-xs' : 'text-sm')}>Drop PDFs here, or tap to browse</p>
        {!compact && (
          <p className="max-w-xs text-xs text-muted-foreground">
            One PDF per document. Nothing uploads or starts extracting until you confirm it below.
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={compact ? 'flex-shrink-0' : 'mt-1'}
          onClick={(e) => e.stopPropagation()}
        >
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {items.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {stagedCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
              <p className="text-xs font-medium">
                Is this the {stagedCount === 1 ? 'file' : `${stagedCount} files`} you want to upload and extract?
              </p>
              <Button type="button" size="sm" onClick={uploadAllStaged}>
                {stagedCount === 1 ? 'Yes, upload & extract' : `Yes, upload all ${stagedCount}`}
              </Button>
            </div>
          )}
          {items.map((item) => (
            <div
              key={item.key}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{item.filename}</span>
              {item.status === 'staged' && (
                <Button type="button" size="sm" variant="outline" onClick={() => startUpload(item)}>
                  Upload &amp; extract
                </Button>
              )}
              {item.status === 'uploading' && (
                <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {item.progress}%
                </span>
              )}
              {item.status === 'tracking' && item.trackingStartedAt && (
                <StageTracker
                  docStatus={item.docStatus ?? 'uploaded'}
                  startedAt={item.trackingStartedAt}
                  unconfirmed={item.unconfirmed}
                />
              )}
              {item.status === 'error' && (
                <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  {friendlyErrorMessage(item.error)}
                </span>
              )}
              {item.status === 'connection-lost' && (
                <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
                  Connection lost — check the inbox below to see if this document arrived.
                </span>
              )}
              <button
                type="button"
                onClick={() => removeItem(item.key)}
                className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={
                  item.status === 'staged' || item.status === 'uploading'
                    ? `Cancel ${item.filename}`
                    : `Dismiss ${item.filename}`
                }
                title={item.status === 'staged' || item.status === 'uploading' ? 'Cancel' : 'Dismiss'}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
          {hasFinished && (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setItems((current) => current.filter((i) => !isFinishedItem(i)))}
              >
                Clear list
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
