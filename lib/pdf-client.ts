/**
 * Browser-safe PDF helpers — the client-side counterpart to `lib/pdf.ts`,
 * which is `server-only` and can't be imported from a client component.
 *
 * Both files reach `pdf-lib` through a dynamic `import('pdf-lib')` so it ships
 * as its own lazy chunk (~150KB gzipped) that only downloads the first time
 * someone actually stages a PDF in the upload dropzone — it never lands in the
 * main app bundle, and it never runs for anyone who isn't splitting a file.
 * `pdf-lib` is pure JavaScript with no worker thread and no native dependency,
 * so it behaves identically in the browser and under Node (see `lib/pdf.ts`'s
 * header for why `pdfjs-dist` was abandoned for this).
 *
 * Only what the manual-split upload flow needs lives here: a page count and a
 * by-ranges slice. Anything that has to stay on the server (hashing, the
 * extraction-time per-page split) stays in `lib/pdf.ts`.
 */

/**
 * Mirrors `getPdfPageCount` in `lib/pdf.ts` — reads the page count without
 * rendering anything, via the same `PDFDocument.load` the split path already
 * has to do.
 */
export async function getPdfPageCountClient(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes)
  return doc.getPageCount()
}

/**
 * Slices `bytes` into one standalone PDF per range — the same
 * `PDFDocument.create()` + `copyPages` pattern as `extractPageRange` in
 * `lib/pdf.ts`. `start`/`end` are 1-indexed and inclusive, matching every
 * other page number in this codebase and the free-text ranges the uploader
 * types; pdf-lib's own page indices are 0-based, so the conversion happens
 * here rather than leaking a second numbering convention out to callers.
 *
 * `lib/split-ranges.ts` is responsible for validating the ranges first; the
 * bounds check here is only a backstop and throws a `RangeError` on anything
 * out of range.
 */
export async function splitPdfByRanges(
  bytes: Uint8Array,
  ranges: Array<{ start: number; end: number }>
): Promise<Uint8Array[]> {
  const { PDFDocument } = await import('pdf-lib')
  const source = await PDFDocument.load(bytes)
  const pageCount = source.getPageCount()

  const out: Uint8Array[] = []
  for (const { start, end } of ranges) {
    if (start < 1 || end < start || end > pageCount) {
      throw new RangeError(
        `splitPdfByRanges: range ${start}-${end} is invalid for a ${pageCount}-page document`
      )
    }
    const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i)
    const doc = await PDFDocument.create()
    const copied = await doc.copyPages(source, indices)
    for (const page of copied) doc.addPage(page)
    out.push(await doc.save())
  }
  return out
}
