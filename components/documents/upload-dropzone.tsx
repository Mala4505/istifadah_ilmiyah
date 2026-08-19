'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, CheckCircle2, FileText, Loader2, UploadCloud, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { friendlyErrorMessage, logRawError } from '@/lib/friendly-error'

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
 * multi-file drop), since `/api/documents/ingest` starts OCR extraction as
 * part of the same request (it drains `job_queue` before responding). A
 * staged or in-flight file can also be pulled back at any point: staged
 * files are just removed from the list before anything is sent, and an
 * in-flight upload is aborted via the same XMLHttpRequest the progress bar
 * reads from (stored in `xhrsRef`, keyed by item — nothing else in this
 * component needs it). Once an item reaches 'queued' the underlying
 * `source_document` row exists in the inbox below, where "Cancel tracking"
 * (components/documents/document-inbox.tsx) takes over.
 */

type UploadItemStatus = 'staged' | 'uploading' | 'queued' | 'error'

interface UploadItem {
  key: string
  filename: string
  status: UploadItemStatus
  progress: number
  error?: string
}

function uploadOne(
  file: File,
  onProgress: (pct: number) => void,
  onXhr: (xhr: XMLHttpRequest) => void
): Promise<{ documentId: number }> {
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
      if (xhr.status >= 200 && xhr.status < 300 && hasDocumentId) {
        resolve({ documentId: (body as { documentId: number }).documentId })
        return
      }
      const message =
        body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
          ? String((body as { error: unknown }).error)
          : `Upload failed (HTTP ${xhr.status}).`
      reject(new Error(message))
    }

    xhr.onerror = () => reject(new Error('Network error during upload.'))
    xhr.ontimeout = () => reject(new Error('Upload timed out.'))
    xhr.onabort = () => reject(new Error('Canceled.'))

    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

export function UploadDropzone({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<UploadItem[]>([])
  const [isDragging, setIsDragging] = useState(false)

  // Neither of these belongs in React state — the File object isn't
  // serializable/comparable in a way that should trigger re-renders, and the
  // XMLHttpRequest is only ever reached from an event handler (the Cancel
  // button), never rendered.
  const filesRef = useRef<Map<string, File>>(new Map())
  const xhrsRef = useRef<Map<string, XMLHttpRequest>>(new Map())

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
        .then(() => {
          setItems((current) =>
            current.map((c) => (c.key === item.key ? { ...c, status: 'queued', progress: 100 } : c))
          )
          filesRef.current.delete(item.key)
          xhrsRef.current.delete(item.key)
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
          setItems((current) =>
            current.map((c) =>
              c.key === item.key
                ? { ...c, status: 'error', error: err instanceof Error ? err.message : 'Upload failed.' }
                : c
            )
          )
        })
    },
    [onUploaded]
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
    setItems((current) => current.filter((c) => c.key !== key))
  }

  const stagedCount = items.filter((i) => i.status === 'staged').length
  const hasFinished = items.some((i) => i.status === 'queued' || i.status === 'error')

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
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors sm:py-10',
          isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/40'
        )}
      >
        <UploadCloud className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">Drop PDFs here, or tap to browse</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          One PDF per document. Nothing uploads or starts extracting until you confirm it below.
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-1" onClick={(e) => e.stopPropagation()}>
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
              {item.status === 'queued' && (
                <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Queued for extraction
                </span>
              )}
              {item.status === 'error' && (
                <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  {friendlyErrorMessage(item.error)}
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
                onClick={() => setItems((current) => current.filter((i) => i.status !== 'queued' && i.status !== 'error'))}
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
