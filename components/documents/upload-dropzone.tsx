'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, CheckCircle2, FileText, Loader2, UploadCloud, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

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
 */

type UploadItemStatus = 'uploading' | 'queued' | 'error'

interface UploadItem {
  key: string
  filename: string
  status: UploadItemStatus
  progress: number
  error?: string
}

function uploadOne(file: File, onProgress: (pct: number) => void): Promise<{ documentId: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/documents/ingest')

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

  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const all = Array.from(fileList)
      const pdfFiles = all.filter(isPdf)
      const rejectedCount = all.length - pdfFiles.length
      if (rejectedCount > 0) {
        toast.error(`${rejectedCount} file${rejectedCount === 1 ? '' : 's'} skipped — only PDF is supported.`)
      }
      if (pdfFiles.length === 0) return

      const newItems: UploadItem[] = pdfFiles.map((f) => ({
        key: `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filename: f.name,
        status: 'uploading',
        progress: 0,
      }))
      setItems((current) => [...newItems, ...current])

      let settledCount = 0
      const markSettled = () => {
        settledCount++
        if (settledCount === newItems.length) {
          onUploaded()
        }
      }

      newItems.forEach((item, i) => {
        const file = pdfFiles[i]!
        uploadOne(file, (pct) => {
          setItems((current) => current.map((c) => (c.key === item.key ? { ...c, progress: pct } : c)))
        })
          .then(() => {
            setItems((current) =>
              current.map((c) => (c.key === item.key ? { ...c, status: 'queued', progress: 100 } : c))
            )
            markSettled()
          })
          .catch((err: unknown) => {
            setItems((current) =>
              current.map((c) =>
                c.key === item.key
                  ? { ...c, status: 'error', error: err instanceof Error ? err.message : 'Upload failed.' }
                  : c
              )
            )
            markSettled()
          })
      })
    },
    [onUploaded]
  )

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)
    if (event.dataTransfer.files.length > 0) handleFiles(event.dataTransfer.files)
  }

  function removeItem(key: string) {
    setItems((current) => current.filter((c) => c.key !== key))
  }

  const hasFinished = items.some((i) => i.status !== 'uploading')

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
          One PDF per document. Scanned bills, chits, and receipts all land in the inbox below once uploaded.
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
          {items.map((item) => (
            <div
              key={item.key}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{item.filename}</span>
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
                <span
                  className="flex flex-shrink-0 items-center gap-1.5 text-xs text-destructive"
                  title={item.error}
                >
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  {item.error ?? 'Upload failed'}
                </span>
              )}
              <button
                type="button"
                onClick={() => removeItem(item.key)}
                className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Dismiss ${item.filename}`}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
          {hasFinished && (
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setItems([])}>
                Clear list
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
