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

/** Maps a point given as (x, y) fractions (0-1, top-left origin) of the
 * page's natural (unrotated) orientation to the equivalent fractions in the
 * viewport as rendered after a clockwise `rotation` of 0/90/180/270 degrees
 * -- reconciling extractionUncertainFieldSchema's natural-page bbox space
 * (lib/extraction-schema.ts) with the rotated canvas pdf.js actually draws
 * (see `currentPageBoxes` below). */
function rotateFractionPoint(x: number, y: number, rotation: number): [number, number] {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [1 - y, x]
    case 180:
      return [1 - x, 1 - y]
    case 270:
      return [y, 1 - x]
    default:
      return [x, y]
  }
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

// L1 (checklist 3.5): the render effect fits the page to whatever width the
// pane is currently given, rather than a fixed pixel scale -- this is what
// makes Collapsed mode show a small legible page instead of an
// overflowing/underflowing one, and keeps the page fitted while the reviewer
// drags the pane divider. `p-3` on the content wrapper below is 12px/side.
const CONTENT_PADDING_PX = 24

// Minimal shape of what this component actually calls, so it doesn't need to
// import pdfjs-dist's full type surface (imported dynamically below anyway).
interface PdfPageProxy {
  getViewport(params: { scale: number; rotation?: number }): { width: number; height: number }
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel: () => void }
}
interface PdfDocumentProxy {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
  destroy(): Promise<void>
}

export const PdfViewer = forwardRef<
  PdfViewerHandle,
  { sourceDocumentId: number; pages?: PageStatus[]; uncertainFields?: UncertainField[]; collapsed?: boolean }
>(function PdfViewer({ sourceDocumentId, pages = [], uncertainFields = [], collapsed = false }, ref) {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [numPages, setNumPages] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  // Manual zoom multiplier on top of the fit-width base scale computed below
  // -- 1 means "exactly fit the pane," not "no zoom applied at a fixed pixel
  // size" like the old fixed-scale render did.
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  // Tracks the canvas's own rendered pixel size so the highlight-box overlay
  // below (a sibling, absolutely positioned) can size itself to match exactly
  // — see the overlay wrapper's comment for why percentages alone aren't enough.
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  // Width of the content wrapper below, kept in sync by the ResizeObserver
  // effect further down -- the render effect fits the page to this on every
  // change, which is what re-renders the canvas across drag-resize and pane
  // mode cycling (L1, checklist 3.8).
  const [containerWidth, setContainerWidth] = useState(0)

  const docRef = useRef<PdfDocumentProxy | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const thumbCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map())
  // The in-flight pdf.js render task on the main canvas, if any -- pdf.js
  // throws "Cannot use the same canvas during multiple render() operations"
  // if a second render() starts on the same canvas before the first
  // finishes, which the fit-width ResizeObserver below makes easy to hit
  // (several containerWidth ticks can land in quick succession while the
  // pane layout settles). Cancelling whatever's running before starting a
  // new one avoids that.
  const renderTaskRef = useRef<{ promise: Promise<void>; cancel: () => void } | null>(null)

  const pageStatusByNumber = useMemo(() => {
    const map = new Map<number, PageStatus>()
    for (const p of pages) map.set(p.pageNumber, p)
    return map
  }, [pages])

  // Highlight boxes for the page currently on screen, resolved into the
  // rotated viewport's own fraction space. Each field's bbox is captured in
  // the page's natural (unrotated) orientation (extractionUncertainFieldSchema's
  // doc comment, lib/extraction-schema.ts; UncertainField, lib/review/types.ts),
  // while the overlay wrapper below is sized to the current (possibly
  // rotated) rendered viewport -- rotateFractionPoint reconciles the two by
  // mapping both corners through the current rotation, then taking the
  // min/max of the transformed corners to get the new axis-aligned rectangle
  // (a 90-degree-multiple rotation keeps an axis-aligned rectangle
  // axis-aligned, so the two given diagonal corners remain diagonal corners
  // of the transformed rectangle -- no need for all four).
  const currentPageBoxes = useMemo(() => {
    return uncertainFields
      .filter((f) => f.pageNumber === pageNumber)
      .map((f) => {
        const [ax, ay] = rotateFractionPoint(f.bboxX0, f.bboxY0, rotation)
        const [bx, by] = rotateFractionPoint(f.bboxX1, f.bboxY1, rotation)
        const left = Math.min(ax, bx)
        const top = Math.min(ay, by)
        const right = Math.max(ax, bx)
        const bottom = Math.max(ay, by)
        return { field: f.field, left, top, width: right - left, height: bottom - top }
      })
  }, [uncertainFields, pageNumber, rotation])

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

  // Measure the content wrapper's own width and re-measure on resize -- the
  // wrapper stays mounted at every pane mode/width (never conditionally
  // rendered, so pdf.js's document never tears down -- checklist 3.7), only
  // its CSS width changes as the review workspace's divider moves or the
  // pane mode cycles. requestAnimationFrame coalesces bursts of resize
  // notifications during an active drag into one measurement per frame.
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    let frame: number | null = null
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined) return
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setContainerWidth(width))
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  // Render the current page whenever page/zoom/rotation/container width
  // changes. The render scale fits the page to the container's own width
  // (containerWidth, from the ResizeObserver above) rather than a fixed
  // pixel scale, then applies `zoom` as a multiplier on top -- this is what
  // makes the Collapsed spine show a small legible page instead of an
  // overflowing one, and what re-renders the canvas as the divider is
  // dragged (L1, checklist 3.8).
  useEffect(() => {
    const doc = docRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas || pageNumber < 1 || pageNumber > doc.numPages || containerWidth <= 0) return

    let cancelled = false
    void (async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const naturalViewport = page.getViewport({ scale: 1, rotation })
      const availableWidth = Math.max(containerWidth - CONTENT_PADDING_PX, 40)
      const fitWidthScale = availableWidth / naturalViewport.width
      const viewport = page.getViewport({ scale: fitWidthScale * zoom, rotation })
      const context = canvas.getContext('2d')
      if (!context) return
      // cancel() doesn't synchronously free pdf.js's internal lock on this
      // canvas -- it schedules cancellation, which the previous task's own
      // promise only reflects once its in-progress paint operation next
      // checks the cancel flag. Calling render() again before that promise
      // settles hits pdf.js's "same canvas" guard even though cancel() was
      // already called, which is what a burst of ResizeObserver ticks kept
      // doing here. Awaiting the rejection first guarantees only one
      // render() is ever active on the canvas.
      if (renderTaskRef.current) {
        const prevTask = renderTaskRef.current
        prevTask.cancel()
        await prevTask.promise.catch(() => {})
      }
      if (cancelled) return
      canvas.width = viewport.width
      canvas.height = viewport.height
      const task = page.render({ canvasContext: context, viewport })
      renderTaskRef.current = task
      try {
        await task.promise
      } catch (err) {
        // A cancelled render rejects by design (RenderingCancelledException) --
        // only a genuine render failure should propagate.
        if (cancelled || (err instanceof Error && err.name === 'RenderingCancelledException')) return
        throw err
      }
      if (renderTaskRef.current === task) renderTaskRef.current = null
      if (!cancelled) setCanvasSize({ width: viewport.width, height: viewport.height })
    })()

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
    }
  }, [pageNumber, zoom, rotation, numPages, containerWidth])

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

  // L1 (checklist 3.7): one JSX tree for both toolbar states, not two
  // early-returned branches -- the content wrapper (contentRef, observed by
  // the ResizeObserver above) and the <canvas> itself (canvasRef, painted by
  // the render effect above) have to stay the *same* DOM nodes across a
  // Collapsed toggle. Two separate branches would give each mode its own
  // copy of both elements: React would unmount/remount them on every toggle,
  // orphaning the ResizeObserver (its effect only runs once, on the node it
  // saw at mount) and leaving the fresh canvas unpainted until some other
  // dependency happened to change. Only the toolbar and thumbnail rail --
  // genuinely different content, not the same element resized -- switch on
  // `collapsed`.
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-muted/30">
      {collapsed ? (
        <div className="flex flex-col items-center gap-1.5 border-b border-border bg-background px-1 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
            aria-label="Previous page"
            title="Previous page (← / ↑)"
          >
            <ChevronLeft className="h-4 w-4 rotate-90" />
          </Button>
          <span className="text-center text-[10px] leading-tight text-muted-foreground">
            {numPages > 0 ? `${pageNumber}/${numPages}` : '—'}
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
            <ChevronRight className="h-4 w-4 rotate-90" />
          </Button>
          {uncertainFields.length > 0 ? (
            <span
              className="rounded-full bg-orange-500 px-1.5 py-0.5 text-[9px] font-medium leading-none text-white"
              title={`${uncertainFields.length} field(s) flagged for review`}
            >
              {uncertainFields.length}
            </span>
          ) : null}
        </div>
      ) : (
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setZoom((z) => Math.max(0.4, z - 0.15))}
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setZoom((z) => Math.min(3, z + 0.15))}
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Rotate">
            <RotateCw className="h-4 w-4" />
          </Button>
          {uncertainFields.length > 0 ? (
            <span
              className="ml-1 rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
              title={`${uncertainFields.length} field(s) flagged for review`}
            >
              {uncertainFields.length} flagged
            </span>
          ) : null}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {numPages > 1 && !collapsed ? (
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
                      // This inline arrow function is a new reference every render, so
                      // React detaches/reattaches it (calling this callback again with
                      // the same `el`) on every re-render, not just on real mount --
                      // L1's ResizeObserver-driven re-renders (checklist 3.8) made that
                      // frequent enough to stack up concurrent render() calls on the
                      // same thumbnail canvas, which pdf.js forbids. Only (re-)render
                      // when the element genuinely changed.
                      if (el && thumbCanvasRefs.current.get(n) !== el) {
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

        <div ref={contentRef} className="flex-1 overflow-auto p-3">
          {loading ? (
            // Roughly an A4 page's aspect ratio (1:1.414) -- the canvas below
            // renders at whatever the actual page size turns out to be, but
            // this keeps the placeholder from looking like a random box while
            // getReviewDocumentUrl + pdf.js's getDocument() are in flight.
            <Skeleton className="mx-auto h-full max-h-[80vh] w-full max-w-md" style={{ aspectRatio: '1 / 1.414' }} />
          ) : error ? (
            collapsed ? null : <p className="text-sm text-destructive">Could not load document: {error}</p>
          ) : (
            // Sized in JS pixels (not CSS %) to exactly match the canvas's own
            // rendered size, so the overlay boxes below -- positioned with
            // percentages relative to THIS wrapper -- track the canvas at any
            // zoom level without a separate pixel<->fraction conversion.
            <div className="relative mx-auto" style={{ width: canvasSize.width, height: canvasSize.height }}>
              <canvas ref={canvasRef} className="shadow-sm" />
              {!collapsed &&
                currentPageBoxes.map((box, i) => (
                  <div
                    key={i}
                    title={box.field.replace(/_/g, ' ')}
                    className="pointer-events-none absolute rounded-sm border-2 border-orange-500 bg-orange-400/20"
                    style={{
                      left: `${box.left * 100}%`,
                      top: `${box.top * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
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
