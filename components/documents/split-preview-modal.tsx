'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Scissors } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FriendlyError } from '@/components/ui/friendly-error'
import { logRawError } from '@/lib/friendly-error'

/**
 * "Choose split points" modal for an oversized staged PDF (plan
 * "recursive-finding-yao" + 2026-09-10 follow-up: "can the user view the pdf
 * when splitting it so they know that from this to this page").
 *
 * Renders every page as a thumbnail with pdf.js — same browser-side setup as
 * components/review/pdf-viewer.tsx (self-hosted worker at
 * `/pdf.worker.min.mjs`, `isEvalSupported: false` for the strict CSP), but
 * straight off the staged `File`'s bytes since nothing is uploaded yet, so
 * there's no signed URL. The reader clicks the gap after a page to drop a
 * cut; the page ranges are derived from the cuts and handed back to the
 * dropzone's existing split handler (`splitPdfByRanges` → N staged uploads),
 * exactly as if they'd been typed into the panel's text box.
 *
 * pdfjs-dist is a dynamic import so it only downloads when someone actually
 * opens this modal — it's never in the inbox's initial bundle.
 */

interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number }
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> }
}
interface PdfDocLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  destroy(): Promise<void>
}

const THUMB_SCALE = 0.4

function rangesFromCuts(cuts: Set<number>, pageCount: number): Array<{ start: number; end: number }> {
  const sorted = [...cuts].sort((a, b) => a - b)
  const ranges: Array<{ start: number; end: number }> = []
  let start = 1
  for (const cut of sorted) {
    ranges.push({ start, end: cut })
    start = cut + 1
  }
  ranges.push({ start, end: pageCount })
  return ranges
}

export function SplitPreviewModal({
  open,
  onOpenChange,
  file,
  pageCount,
  maxUploadPages,
  initialRanges,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: File
  /** Page count from `getPdfPageCountClient` — the grid falls back to this if pdf.js hasn't loaded yet. */
  pageCount: number
  maxUploadPages: number
  /** Seed the cuts from ranges already typed into the panel's text box, if any parse cleanly. */
  initialRanges?: Array<{ start: number; end: number }>
  onConfirm: (ranges: Array<{ start: number; end: number }>) => void
}) {
  const [numPages, setNumPages] = useState(pageCount)
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map())
  const [renderedCount, setRenderedCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cuts, setCuts] = useState<Set<number>>(new Set())

  // Seed cuts from any ranges the panel already parsed (a cut sits after each
  // range's last page, except the final one). Re-seeded every time the modal
  // opens so reopening it reflects the panel's current text.
  useEffect(() => {
    if (!open) return
    const seeded = new Set<number>()
    if (initialRanges && initialRanges.length > 1) {
      for (const r of initialRanges.slice(0, -1)) seeded.add(r.end)
    }
    setCuts(seeded)
  }, [open, initialRanges])

  // Load the PDF and render every page to a thumbnail, progressively, so the
  // reader can start placing cuts before the whole document has painted.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setThumbs(new Map())
    setRenderedCount(0)
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
        const doc = (await pdfjs.getDocument({
          data,
          isEvalSupported: false,
          useSystemFonts: false,
        }).promise) as unknown as PdfDocLike
        if (cancelled) {
          void doc.destroy()
          return
        }
        setNumPages(doc.numPages)
        setLoading(false)

        for (let n = 1; n <= doc.numPages; n += 1) {
          if (cancelled) break
          const page = await doc.getPage(n)
          const viewport = page.getViewport({ scale: THUMB_SCALE })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          await page.render({ canvasContext: ctx, viewport }).promise
          if (cancelled) break
          const url = canvas.toDataURL('image/png')
          setThumbs((current) => {
            const next = new Map(current)
            next.set(n, url)
            return next
          })
          setRenderedCount(n)
        }
        void doc.destroy()
      } catch (err) {
        if (cancelled) return
        logRawError('split-preview-modal', err)
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, file])

  const toggleCut = useCallback((afterPage: number) => {
    setCuts((current) => {
      const next = new Set(current)
      if (next.has(afterPage)) next.delete(afterPage)
      else next.add(afterPage)
      return next
    })
  }, [])

  const ranges = useMemo(() => rangesFromCuts(cuts, numPages), [cuts, numPages])
  const overLimit = ranges.filter((r) => r.end - r.start + 1 > maxUploadPages)
  const canSplit = cuts.size > 0 && overLimit.length === 0

  // Part index (1-based) for each page, so the grid can tint each part
  // differently and show where one ends and the next begins.
  const partOfPage = useMemo(() => {
    const map = new Map<number, number>()
    let part = 1
    for (let n = 1; n <= numPages; n += 1) {
      map.set(n, part)
      if (cuts.has(n)) part += 1
    }
    return map
  }, [cuts, numPages])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Choose where to split &ldquo;{file.name}&rdquo;</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          {numPages} pages — over the {maxUploadPages}-page limit. Click <Scissors className="inline h-3 w-3" aria-hidden="true" />{' '}
          <span className="font-medium">Split here</span> under a page to end one part and start the next. Each part
          becomes its own upload.
        </p>

        {error ? (
          <FriendlyError message={error} />
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-muted/20 p-2">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Opening PDF&hellip;
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-x-2 gap-y-1 sm:grid-cols-4 md:grid-cols-5">
                  {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
                    const isLast = n === numPages
                    const part = partOfPage.get(n) ?? 1
                    const cutHere = cuts.has(n)
                    return (
                      <div key={n} className="flex flex-col">
                        <div
                          className={`relative overflow-hidden rounded border bg-background ${
                            part % 2 === 0 ? 'border-primary/40' : 'border-border'
                          }`}
                        >
                          <span className="absolute left-1 top-1 rounded bg-background/85 px-1 text-[10px] font-medium text-muted-foreground">
                            p{n} · part {part}
                          </span>
                          {thumbs.has(n) ? (
                            // eslint-disable-next-line @next/next/no-img-element -- client-side data: URL from a canvas, not a remote asset
                            <img src={thumbs.get(n)} alt={`Page ${n}`} className="mx-auto block w-full" />
                          ) : (
                            <div
                              className="flex items-center justify-center bg-muted/40"
                              style={{ aspectRatio: '1 / 1.414' }}
                            >
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" aria-hidden="true" />
                            </div>
                          )}
                        </div>
                        {isLast ? (
                          <div className="h-7" />
                        ) : (
                          <button
                            type="button"
                            onClick={() => toggleCut(n)}
                            className={`mt-1 flex items-center justify-center gap-1 rounded px-1 py-1 text-[10px] font-medium transition-colors ${
                              cutHere
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                            }`}
                            aria-pressed={cutHere}
                          >
                            <Scissors className="h-3 w-3" aria-hidden="true" />
                            {cutHere ? `Split after p${n}` : 'Split here'}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {!loading && renderedCount < numPages && (
                <p className="pt-1 text-center text-[11px] text-muted-foreground">
                  Rendering pages… {renderedCount}/{numPages}
                </p>
              )}
            </div>

            <div className="text-xs">
              {cuts.size === 0 ? (
                <span className="text-muted-foreground">No split points yet — the file is one part of {numPages} pages.</span>
              ) : (
                <span className={overLimit.length > 0 ? 'text-destructive' : 'text-muted-foreground'}>
                  {ranges.length} parts: {ranges.map((r) => `${r.start}-${r.end}`).join(', ')}
                  {overLimit.length > 0 &&
                    ` — ${overLimit
                      .map((r) => `part ${r.start}-${r.end} is ${r.end - r.start + 1} pages`)
                      .join(', ')}, over the ${maxUploadPages}-page limit`}
                </span>
              )}
            </div>
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSplit}
            onClick={() => {
              onConfirm(ranges)
              onOpenChange(false)
            }}
          >
            {canSplit ? `Split into ${ranges.length} files` : 'Add a split point'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
