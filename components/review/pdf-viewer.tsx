'use client'

/**
 * Split-pane's left half (§7: "Page image left -- zoom, rotate, page
 * thumbnails"). Client-side pdf.js over the signed URL from
 * lib/actions/review.ts's getReviewDocumentUrl -- there was no browser-facing
 * signed-URL path before Day 4 (Days 1-2 sent the PDF to Claude as a
 * `document` block server-side, lib/pdf.ts's header comment explains why
 * there is no server-side rasteriser here).
 *
 * CSP note (MASTER-PLAN §4.4b): the worker is self-hosted at
 * /pdf.worker.min.mjs (copied from node_modules/pdfjs-dist/build/ into
 * public/, matching the installed pdfjs-dist version -- loading it from a
 * CDN would force a third-party origin into worker-src/script-src) and
 * `isEvalSupported: false` is set on every `getDocument` call, per that
 * section's "two pdf.js rules that keep the policy strict."
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ZoomIn, ZoomOut, RotateCw, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getReviewDocumentUrl } from '@/lib/actions/review'
import type { PageStatus, UncertainField } from '@/lib/review/types'

/** "bank_cheque" -> "Bank cheque", for the skipped-page tooltip/label. */
function formatSkipReason(reason: string): string {
  const words = reason.split('_')
  return words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1) + (words.length > 1 ? ' ' + words.slice(1).join(' ') : '')
}

/** Imperative page-turn API so the review workspace's global Arrow-key
 * handler (§7 keyboard contract) can drive this pane without lifting its
 * whole pdf.js render loop up a level. */
export interface PdfViewerHandle {
  nextPage: () => void
  prevPage: () => void
  /** Jumps straight to a page — used by the extraction form (§7) when a
   *  reviewer clicks a field flagged in `uncertainFields` below, so they land
   *  on the source page without hunting through the thumbnail rail. */
  goToPage: (pageNumber: number) => void
}

// Minimal shape of what this component actually calls, so it doesn't need to
// import pdfjs-dist's full type surface (imported dynamically below anyway).
interface PdfPageProxy {
  getViewport(params: { scale: number; rotation?: number }): { width: number; height: number }
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> }
}
interface PdfDocumentProxy {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
  destroy(): Promise<void>
}

export const PdfViewer = forwardRef<
  PdfViewerHandle,
  { sourceDocumentId: number; pages?: PageStatus[]; uncertainFields?: UncertainField[] }
>(function PdfViewer({ sourceDocumentId, pages = [], uncertainFields = [] }, ref) {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [numPages, setNumPages] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1.1)
  const [rotation, setRotation] = useState(0)
  // Tracks the canvas's own rendered pixel size so the highlight-box overlay
  // below (a sibling, absolutely positioned) can size itself to match exactly
  // — see the overlay wrapper's comment for why percentages alone aren't enough.
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })

  const docRef = useRef<PdfDocumentProxy | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const thumbCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map())

  const pageStatusByNumber = useMemo(() => {
    const map = new Map<number, PageStatus>()
    for (const p of pages) map.set(p.pageNumber, p)
    return map
  }, [pages])

  // Best-effort highlight boxes for the page currently on screen. Only drawn
  // at rotation 0: a bbox is captured in the page's natural (unrotated)
  // orientation (extractionUncertainFieldSchema's doc comment,
  // lib/extraction-schema.ts), and correctly transforming x0/y0/x1/y1 through
  // a 90/180/270 rotation is real extra complexity for a feature that is
  // already explicitly a best-effort aid, not a precise one — simplest safe
  // cut is to hide the (possibly-misleading) boxes rather than draw wrong ones.
  const currentPageBoxes = useMemo(
    () => (rotation === 0 ? uncertainFields.filter((f) => f.pageNumber === pageNumber) : []),
    [uncertainFields, pageNumber, rotation]
  )

  useImperativeHandle(
    ref,
    () => ({
      nextPage: () => setPageNumber((p) => (docRef.current ? Math.min(docRef.current.numPages, p + 1) : p)),
      prevPage: () => setPageNumber((p) => Math.max(1, p - 1)),
      goToPage: (n: number) =>
        setPageNumber((p) => (docRef.current ? Math.min(Math.max(1, n), docRef.current.numPages) : p)),
    }),
    []
  )

  // Load the document whenever the target document changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPageNumber(1)
    setRotation(0)

    void (async () => {
      const urlResult = await getReviewDocumentUrl(sourceDocumentId)
      if (cancelled) return
      if (!urlResult.ok) {
        setError(urlResult.error)
        setLoading(false)
        return
      }

      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

      try {
        const doc = (await pdfjsLib.getDocument({
          url: urlResult.url,
          isEvalSupported: false,
          useSystemFonts: false,
        }).promise) as unknown as PdfDocumentProxy
        if (cancelled) {
          void doc.destroy()
          return
        }
        docRef.current = doc
        setNumPages(doc.numPages)
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      void docRef.current?.destroy()
      docRef.current = null
    }
  }, [sourceDocumentId])

  // Render the current page whenever page/scale/rotation changes.
  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || pageNumber < 1 || pageNumber > doc.numPages) return

    let cancelled = false
    void (async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale, rotation })
      canvas.width = viewport.width
      canvas.height = viewport.height
      const context = canvas.getContext('2d')
      if (!context) return
      await page.render({ canvasContext: context, viewport }).promise
      if (!cancelled) setCanvasSize({ width: viewport.width, height: viewport.height })
    })()

    return () => {
      cancelled = true
    }
  }, [pageNumber, scale, rotation, numPages])

  // Lazily render a small thumbnail once its canvas mounts.
  async function renderThumbnail(n: number) {
    const doc = docRef.current
    const canvas = thumbCanvasRefs.current.get(n)
    if (!doc || !canvas) return
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: 0.15 })
    canvas.width = viewport.width
    canvas.height = viewport.height
    const context = canvas.getContext('2d')
    if (!context) return
    await page.render({ canvasContext: context, viewport }).promise
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-muted/30">
      <div className="flex items-center gap-1 border-b border-border bg-background px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pageNumber <= 1}
          onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
          aria-label="Previous page"
          title="Previous page (← / ↑)"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-16 text-center text-xs text-muted-foreground">
          {numPages > 0 ? `Page ${pageNumber} / ${numPages}` : '—'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pageNumber >= numPages}
          onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
          aria-label="Next page"
          title="Next page (→ / ↓)"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button type="button" variant="ghost" size="sm" onClick={() => setScale((s) => Math.max(0.4, s - 0.15))} aria-label="Zoom out">
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setScale((s) => Math.min(3, s + 0.15))} aria-label="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Rotate">
          <RotateCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {numPages > 1 ? (
          <div className="flex w-20 flex-shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-background p-2">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
              const status = pageStatusByNumber.get(n)
              const skipped = status?.isFinancialDocument === false
              const skipLabel = status?.skipReason ? formatSkipReason(status.skipReason) : null
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPageNumber(n)}
                  title={skipped ? `Skipped${skipLabel ? `: ${skipLabel}` : ''} -- not extracted as a bill` : undefined}
                  className={`relative rounded border p-1 text-[10px] transition-colors ${
                    n === pageNumber ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent'
                  } ${skipped ? 'opacity-60' : ''}`}
                >
                  {skipped ? (
                    <span className="absolute right-0.5 top-0.5 rounded-sm bg-muted-foreground/80 px-1 text-[8px] font-medium leading-tight text-background">
                      Skipped
                    </span>
                  ) : null}
                  <canvas
                    ref={(el) => {
                      if (el) {
                        thumbCanvasRefs.current.set(n, el)
                        void renderThumbnail(n)
                      }
                    }}
                    className="mx-auto max-w-full"
                  />
                  <div className="mt-0.5 text-center">
                    {n}
                    {skipped && skipLabel ? <div className="truncate text-[8px] text-muted-foreground">{skipLabel}</div> : null}
                  </div>
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="flex-1 overflow-auto p-3">
          {loading ? (
            // Roughly an A4 page's aspect ratio (1:1.414) -- the canvas below
            // renders at whatever the actual page size turns out to be, but
            // this keeps the placeholder from looking like a random box while
            // getReviewDocumentUrl + pdf.js's getDocument() are in flight.
            <Skeleton className="mx-auto h-full max-h-[80vh] w-full max-w-md" style={{ aspectRatio: '1 / 1.414' }} />
          ) : error ? (
            <p className="text-sm text-destructive">Could not load document: {error}</p>
          ) : (
            // Sized in JS pixels (not CSS %) to exactly match the canvas's own
            // rendered size, so the overlay boxes below -- positioned with
            // percentages relative to THIS wrapper -- track the canvas at any
            // zoom level without a separate pixel<->fraction conversion.
            <div className="relative mx-auto" style={{ width: canvasSize.width, height: canvasSize.height }}>
              <canvas ref={canvasRef} className="shadow-sm" />
              {currentPageBoxes.map((box, i) => (
                <div
                  key={i}
                  title={box.field.replace(/_/g, ' ')}
                  className="pointer-events-none absolute rounded-sm border-2 border-orange-500 bg-orange-400/20"
                  style={{
                    left: `${box.bboxX0 * 100}%`,
                    top: `${box.bboxY0 * 100}%`,
                    width: `${(box.bboxX1 - box.bboxX0) * 100}%`,
                    height: `${(box.bboxY1 - box.bboxY0) * 100}%`,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
