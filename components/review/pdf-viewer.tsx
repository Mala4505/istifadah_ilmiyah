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
import { useRouter } from 'next/navigation'
import { ZoomIn, ZoomOut, RotateCw, ChevronLeft, ChevronRight, Eye, EyeOff, CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { FriendlyError } from '@/components/ui/friendly-error'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { logRawError } from '@/lib/friendly-error'
import { toastError } from '@/components/ui/error-toast'
import { getReviewDocumentUrl, reExtractPage, setPageSkipOverride } from '@/lib/actions/review'
import type { PageStatus, UncertainField } from '@/lib/review/types'

/** "bank_cheque" -> "Bank cheque", for the skipped-page tooltip/label. */
function formatSkipReason(reason: string): string {
  // 'id_document' title-cases to "Id document", which reads wrong -- "ID" is
  // an acronym, not a capitalized word.
  if (reason === 'id_document') return 'ID document'
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
  {
    sourceDocumentId: number
    // 2.1: identifies the bill currently being reviewed, distinct from
    // sourceDocumentId -- several bills of one multi-bill PDF share the same
    // sourceDocumentId, so this is what the page-reset effect below keys off
    // to notice "the bill changed" even when the underlying PDF didn't.
    documentExtractionId: number
    // 2.1: this bill's own first page (document_extraction.page_number_start)
    // -- seeds/resets pageNumber below instead of always opening on page 1.
    pageNumberStart?: number | null
    // review/page.tsx's `&page=N` -- set when this bill was reached by
    // clicking a sibling bill's page in the thumbnail rail below (see
    // billPageRanges/onRequestBillSwitch), so this opens on the exact page
    // clicked rather than this bill's own first page.
    initialPageOverride?: number | null
    pages?: PageStatus[]
    uncertainFields?: UncertainField[]
    collapsed?: boolean
    // Plan §2: lets the workspace's new nav cluster show/drive page position
    // without lifting the whole pdf.js render loop up a level -- pageNumber
    // and numPages otherwise live only in this component's own state.
    onPageInfoChange?: (pageNumber: number, numPages: number) => void
    // review-workspace.tsx: every sibling bill's own page range within this
    // shared source PDF, so a thumbnail click can be resolved to whichever
    // bill actually owns that page -- see handleThumbnailClick below.
    billPageRanges?: { documentExtractionId: number; pageNumberStart: number | null; pageNumberEnd: number | null }[]
    // Fires instead of a local page change when a clicked thumbnail belongs
    // to a different bill than the one currently open -- review-workspace.tsx
    // navigates the whole workspace there (OCR form included) rather than
    // just scrolling this canvas to a page whose data isn't on screen.
    onRequestBillSwitch?: (documentExtractionId: number, pageNumber: number) => void
  }
>(function PdfViewer(
  {
    sourceDocumentId,
    documentExtractionId,
    pageNumberStart,
    initialPageOverride,
    pages = [],
    uncertainFields = [],
    collapsed = false,
    onPageInfoChange,
    billPageRanges = [],
    onRequestBillSwitch,
  },
  ref
) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Phase 4 (§2.5/§2.6): the one page whose skip-toggle or "OCR this page"
  // action is currently in flight -- deliberately a single page number, not a
  // whole-rail spinner, so working one page never disables the rest of the
  // thumbnail rail (spec: "don't block the whole rail").
  const [busyPageNumber, setBusyPageNumber] = useState<number | null>(null)
  // Redesign (review pane rail): the skip/unskip toggle now goes through a
  // confirmation dialog rather than firing straight from a click, since both
  // directions are destructive-ish (skip discards extracted data, unskip
  // re-triggers OCR) -- see the action bar and Dialog JSX below.
  const [skipDialogOpen, setSkipDialogOpen] = useState(false)
  // 5.20 (checklist Phase 5, plan §13): bumped by the Retry button below to
  // re-run the URL-fetch/pdf.js-load effect without needing a full remount --
  // it's a dependency of that effect purely to force it to re-fire, its
  // actual value is never read.
  const [retryNonce, setRetryNonce] = useState(0)
  const [numPages, setNumPages] = useState(0)
  // 2.1: seeded from this bill's own first page rather than hard-coded to 1
  // -- the effect below re-seeds this on every bill change (see its comment).
  // initialPageOverride takes priority when set (a sibling-bill thumbnail
  // click landed here wanting a specific page, not this bill's default).
  const [pageNumber, setPageNumber] = useState(initialPageOverride ?? pageNumberStart ?? 1)
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
  // UX fix: which page number the <canvas> currently has *painted* -- distinct
  // from `pageNumber` (the target), so a page-to-page transition can be
  // detected as "pageNumber !== paintedPageNumber" without a separately
  // tracked boolean that could drift out of sync with the render effect below
  // (e.g. across a cancelled render during rapid clicking). Only updated once
  // the render effect's task.promise actually resolves for `pageNumber` --
  // see that effect. Starts at null so the very first page's initial paint
  // (already covered by the whole-document `loading` skeleton above) doesn't
  // spuriously read as a transition before anything has painted yet.
  const [paintedPageNumber, setPaintedPageNumber] = useState<number | null>(null)
  // True only while the target page differs from what's actually painted --
  // i.e. a genuine page-content change is in flight. Deliberately NOT keyed
  // on zoom/rotation/containerWidth (those re-render the *same* page and are
  // near-instant re-paints of already-fetched page data), so dragging the
  // zoom slider or resizing the pane never flips this on.
  const pageTransitioning = paintedPageNumber !== null && pageNumber !== paintedPageNumber

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

  // Which bill (documentExtractionId) a given page belongs to, resolved from
  // billPageRanges -- used by the thumbnail click handler below to decide
  // whether clicking a page should switch bills. Falls back to the current
  // bill when no range covers the page (e.g. billPageRanges empty on a
  // single-bill document), which keeps the click a plain local page change.
  function resolveBillForPage(n: number): number {
    const owner = billPageRanges.find(
      (r) => r.pageNumberStart !== null && r.pageNumberEnd !== null && n >= r.pageNumberStart && n <= r.pageNumberEnd
    )
    return owner?.documentExtractionId ?? documentExtractionId
  }

  function handleThumbnailClick(n: number) {
    const owner = resolveBillForPage(n)
    if (owner !== documentExtractionId && onRequestBillSwitch) {
      onRequestBillSwitch(owner, n)
      return
    }
    setPageNumber(n)
  }

  // Plan §2: the workspace's nav cluster has no other way to know current
  // position -- pageNumber/numPages were previously internal-only.
  useEffect(() => {
    onPageInfoChange?.(pageNumber, numPages)
  }, [pageNumber, numPages, onPageInfoChange])

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

  // 2.1: seed/reset pageNumber to this bill's own first page whenever the
  // bill changes. Keyed on documentExtractionId -- not sourceDocumentId
  // (shared by every bill of one multi-bill PDF, so it wouldn't fire when
  // stepping between them) and not pageNumberStart alone (two different
  // bills could coincidentally start on the same page number, which
  // wouldn't register as a dependency change and so wouldn't re-fire this
  // effect). A separate effect from the document-load one below so a fresh
  // pdf.js load isn't required just to move between bills of the same PDF.
  useEffect(() => {
    setPageNumber(initialPageOverride ?? pageNumberStart ?? 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentExtractionId, pageNumberStart])

  // Load the document whenever the target document changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setRotation(0)
    // A new document means nothing painted for it yet -- without this, a
    // coincidental page-number match with whatever was last painted for the
    // *previous* document would make pageTransitioning read false even
    // though the canvas hasn't rendered anything for this document.
    setPaintedPageNumber(null)

    void (async () => {
      const urlResult = await getReviewDocumentUrl(sourceDocumentId)
      if (cancelled) return
      if (!urlResult.ok) {
        // 5.20: the raw text is what a developer needs (a storage path, a
        // signed-URL failure) -- log it here rather than only ever putting it
        // in component state, matching this codebase's plain-English-error
        // convention (lib/friendly-error.ts's header comment).
        logRawError('pdf-viewer', urlResult.error)
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
          const message = err instanceof Error ? err.message : String(err)
          logRawError('pdf-viewer', message)
          setError(message)
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      void docRef.current?.destroy()
      docRef.current = null
    }
    // retryNonce is a dependency purely so the Retry button (rendered in the
    // error branch below) can force this effect to re-run without a full
    // remount -- its value is never read.
  }, [sourceDocumentId, retryNonce])

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
      if (!cancelled) {
        setCanvasSize({ width: viewport.width, height: viewport.height })
        // The canvas now genuinely shows `pageNumber`'s content -- clears
        // pageTransitioning (derived from this vs. pageNumber above) whether
        // this render was a real page change or just a zoom/rotation/resize
        // re-paint of the same page (a no-op in the latter case, since
        // paintedPageNumber already equalled pageNumber).
        setPaintedPageNumber(pageNumber)
      }
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

  // Phase 4 §2.5: reviewer override of the model's per-page classification --
  // skip a page the model kept, or unskip one it dismissed. On success the
  // page's classification (and, for an unskip, any newly-discovered bill)
  // only shows up after a fresh server read, so this refreshes rather than
  // patching local state -- unlike reExtractField (review-workspace.tsx),
  // there is no in-progress form state on this component to protect.
  async function handleToggleSkip(n: number, currentlySkipped: boolean): Promise<boolean> {
    setBusyPageNumber(n)
    try {
      const result = await setPageSkipOverride({ sourceDocumentId, pageNumber: n, skip: !currentlySkipped })
      if (!result.ok) {
        toastError(result.error, { context: 'pdf-viewer' })
        return false
      }
      router.refresh()
      return true
    } finally {
      setBusyPageNumber(null)
    }
  }

  // Un-skipping alone only flips document_page.is_financial_document back to
  // true (setPageSkipOverride) -- a page the model skipped was never OCR'd in
  // the first place, so it needs the separate reExtractPage call below to
  // actually produce a bill. The action-bar's single "Include this page"
  // control (and its confirm dialog's "this runs OCR again" copy) promises
  // both steps as one reviewer-facing action, so this does them in sequence
  // rather than leaving a second click required.
  async function handleIncludeAndReExtract(n: number) {
    const included = await handleToggleSkip(n, true)
    if (!included) return
    await handleReExtractPage(n)
  }

  // Phase 4 §2.5/§2.6: OCR a single page the model skipped (or re-run a
  // single-page bill's own OCR). Same refresh-on-success reasoning as
  // handleToggleSkip above -- a newly-discovered bill has no prior local
  // state here to patch.
  async function handleReExtractPage(n: number) {
    setBusyPageNumber(n)
    try {
      const result = await reExtractPage({ sourceDocumentId, pageNumber: n })
      if (!result.ok) {
        toastError(result.error, { context: 'pdf-viewer' })
        return
      }
      router.refresh()
    } finally {
      setBusyPageNumber(null)
    }
  }

  // Redesign (review pane rail): the action bar above the page canvas needs
  // the current page's own status (not just its rail entry) to render the
  // status line and pick which confirmation copy the skip dialog shows.
  const currentPageStatus = pageStatusByNumber.get(pageNumber)
  const currentSkipped = currentPageStatus?.isFinancialDocument === false
  const currentVerified = !currentSkipped && currentPageStatus?.verified === true
  const currentSkipLabel = currentPageStatus?.skipReason ? formatSkipReason(currentPageStatus.skipReason) : null
  const currentStatusText = currentSkipped
    ? `Skipped${currentSkipLabel ? ` · ${currentSkipLabel}` : ''} — not extracted as a bill`
    : currentVerified
      ? 'Completed — bill saved and cleared'
      : 'Included in extraction'

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
          {/* Plan §2: page position + Prev/Next moved to the workspace's nav
              cluster (sourced via onPageInfoChange / pdfViewerRef) -- this
              toolbar keeps only zoom/rotate/uncertain-count now. */}
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
              const done = !skipped && status?.verified === true
              const skipLabel = status?.skipReason ? formatSkipReason(status.skipReason) : null
              // Phase 4 (§2.5): 'manual' once a reviewer has overridden this
              // page's classification via setPageSkipOverride -- distinguishes
              // "the model skipped this" from "a reviewer skipped this" in the
              // tooltip, without a separate badge (nice-to-have per the plan).
              const manualOverride = status?.skipSource === 'manual'
              // Redesign (review pane rail): thumbnails are pure navigation now
              // -- the skip/unskip control lives in the action bar above the
              // page canvas (below), gated behind a confirmation dialog. Only
              // the visual state (pending/skipped/done) is shown here.
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => handleThumbnailClick(n)}
                  title={
                    skipped
                      ? `Skipped${skipLabel ? `: ${skipLabel}` : ''}${manualOverride ? ' (set by a reviewer)' : ''} -- not extracted as a bill`
                      : done
                        ? 'Done -- bill saved and cleared'
                        : undefined
                  }
                  className={`relative w-full rounded border p-1 text-[10px] transition-colors ${
                    n === pageNumber ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent'
                  } ${skipped ? 'opacity-60' : ''}`}
                >
                  {skipped ? (
                    <span className="absolute right-0.5 top-0.5 rounded-sm bg-muted-foreground/80 px-1 text-[8px] font-medium leading-tight text-background">
                      Skipped
                    </span>
                  ) : done ? (
                    <CheckCircle2
                      className="absolute right-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-background text-emerald-600"
                      aria-hidden="true"
                    />
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
                    {skipped && skipLabel ? (
                      <div className="truncate text-[8px] text-muted-foreground">{skipLabel}</div>
                    ) : done ? (
                      <div className="truncate text-[8px] font-medium text-emerald-600">Done</div>
                    ) : null}
                  </div>
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Redesign (review pane rail): skip/unskip moved out of the
              thumbnail rail and into this compact bar -- one icon-only
              button, gated behind the confirmation Dialog below, instead of
              the old pair of ~16px overlay icons that fired immediately. */}
          {!collapsed && numPages > 0 ? (
            <div
              className={`flex items-center gap-2 border-b px-3 py-1.5 ${
                currentSkipped
                  ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'
                  : 'border-border bg-background'
              }`}
            >
              <span className="flex-shrink-0 text-xs font-medium text-foreground">Page {pageNumber}</span>
              <span
                className={`truncate text-xs ${
                  currentSkipped
                    ? 'font-semibold text-amber-900 dark:text-amber-200'
                    : 'text-muted-foreground'
                }`}
              >
                {currentStatusText}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setSkipDialogOpen(true)}
                disabled={busyPageNumber === pageNumber}
                title={currentSkipped ? 'Include this page' : 'Skip this page'}
                aria-label={currentSkipped ? 'Include this page' : 'Skip this page'}
                className="ml-auto h-[30px] w-[30px] flex-shrink-0"
              >
                {currentSkipped ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
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
              // 5.20 (checklist Phase 5, plan §13): this used to print
              // err.message raw on screen -- the one place in this component
              // that violated the project's plain-English-error rule (every
              // other screen routes through FriendlyError/toastError). Retry
              // just bumps retryNonce, which re-runs the load effect above
              // without remounting the whole component (pdf.js's document and
              // this pane's layout state stay put).
              collapsed ? null : (
                <div className="mx-auto max-w-md">
                  <FriendlyError message={error} />
                  <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setRetryNonce((n) => n + 1)}>
                    Retry
                  </Button>
                </div>
              )
            ) : (
              // Sized in JS pixels (not CSS %) to exactly match the canvas's own
              // rendered size, so the overlay boxes below -- positioned with
              // percentages relative to THIS wrapper -- track the canvas at any
              // zoom level without a separate pixel<->fraction conversion.
              <div className="relative mx-auto" style={{ width: canvasSize.width, height: canvasSize.height }}>
                <canvas ref={canvasRef} className="shadow-sm" />
                {/* UX fix: page-to-page transitions (thumbnail click, next/prev,
                    a sibling-bill switch landing on a new page) are async --
                    doc.getPage()+page.render() in the effect above can take a
                    noticeable moment, during which the canvas above still shows
                    the *previous* page with no feedback otherwise. This dims
                    that stale image and shows a spinner until the new page has
                    actually painted (pageTransitioning, derived above from
                    paintedPageNumber vs. pageNumber). Deliberately excludes
                    zoom/rotation/resize-only re-renders of the same page --
                    those stay instant and flicker-free. */}
                {pageTransitioning ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/50">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
                  </div>
                ) : null}
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
                {/* Redesign: the thin status bar above already says "Skipped"
                    in text, but that's easy to miss while scrolling pages --
                    this watermark makes it unmistakable directly on the page
                    image itself, at whatever zoom/rotation it's rendered. */}
                {!collapsed && currentSkipped ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                    <span className="-rotate-[30deg] select-none whitespace-nowrap rounded border-4 border-amber-500/70 px-6 py-2 text-3xl font-bold uppercase tracking-widest text-amber-500/70">
                      Skipped page
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation for the action bar's skip/unskip toggle above -- both
          directions have real consequences (skip discards extracted data,
          unskip re-runs OCR and may surface a new bill), so neither fires
          straight from the icon button's onClick. Skip reuses
          handleToggleSkip as-is; include runs handleIncludeAndReExtract so
          the dialog's "this runs OCR again" copy is actually true (see that
          function's comment -- unskipping alone doesn't invoke OCR). */}
      <Dialog open={skipDialogOpen} onOpenChange={setSkipDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{currentSkipped ? 'Include this page?' : 'Skip this page?'}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {currentSkipped
              ? 'This re-runs OCR on the page and may surface it as a new bill to review.'
              : "This page won't be extracted as a bill, and any data already pulled from it will be discarded."}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSkipDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={currentSkipped ? 'default' : 'destructive'}
              onClick={() => {
                setSkipDialogOpen(false)
                if (currentSkipped) {
                  void handleIncludeAndReExtract(pageNumber)
                } else {
                  void handleToggleSkip(pageNumber, currentSkipped)
                }
              }}
            >
              {currentSkipped ? 'Run OCR' : 'Skip page'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
