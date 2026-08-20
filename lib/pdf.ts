/**
 * Server-side PDF helpers (MASTER-PLAN §8 point 1-2).
 *
 * ── Why there is no rasteriser in here ──────────────────────────────────────
 * §2/§3.8 describe pdf.js rasterising to PNG *in the browser*, which is right
 * for the review UI: the viewer already has the PDF, so re-rendering a page is
 * free and `document_page.image_storage_path` can stay null (§6.2 — storing
 * every page image triples storage).
 *
 * Server-side rasterisation was attempted and abandoned. pdfjs-dist parses a
 * PDF fine under Node (`getDocument`, `numPages`, `getPage` all work), but
 * `page.render` needs a canvas backend, and @napi-rs/canvas aborts the Node
 * process natively (exit code 5, no catchable error) both with and without an
 * explicit `canvasFactory`. node-canvas needs a native toolchain that neither
 * Vercel's build image nor a Windows service box has by default.
 *
 * So the extraction handler sends the PDF to Claude as a base64 `document`
 * block instead (see lib/claude-client.ts → DocumentPdfInput). Claude renders
 * the page itself and additionally reads the embedded text layer, which on
 * these vendor invoices is strictly more information than a 200-DPI PNG would
 * carry.
 *
 * The one §8 detail this trades away is point 7's "Sonnet uses higher-
 * resolution rasterisation (2,576 px vs 1,568 px)": with a PDF block the API
 * owns rendering resolution, so escalation changes the model only. That is the
 * substantive half of the escalation rule.
 *
 * ── One call per PAGE, not one call per document ────────────────────────────
 * §8 originally specified one Claude call per whole document, every page in
 * that one request. That produced three real problems on multi-page scanned
 * documents in practice: a dense document truncates the tool call and has to
 * be re-sent in full a second time; one failing page (a corrupt page image, a
 * rate limit) loses the whole document instead of just that page; and — the
 * one that actually mattered most — the model can see every page's text at
 * once, so it sometimes back-fills a page's vendor/amount from a DIFFERENT
 * page's summary table instead of only reading what's actually printed on the
 * page it's classifying.
 *
 * `splitPdfPage` below is what makes one-call-per-page possible: it extracts
 * a single page out of the source PDF as its own tiny one-page PDF, which
 * `lib/jobs/handlers/extract.ts` then sends to Claude individually (pages
 * dispatched concurrently, in a capped batch — see PAGE_EXTRACTION_CONCURRENCY
 * there — so an N-page document doesn't take N times as long as a one-page
 * one). Each page's own classification (§8 point 3) decides whether it's a
 * real bill or something to skip — see that file for what "skip" means for a
 * page that never becomes a bill.
 *
 * TODO (Day 3/4): when the inbox screen renders pages with pdf.js in the
 * browser, it can POST per-page PNGs and the handler can switch to
 * `documentImages` — lib/claude-client.ts already accepts both.
 */

import 'server-only'
import { createHash } from 'node:crypto'

/** SHA-256 of the raw file bytes → `source_document.file_hash_sha256` (§8 point 2). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Base64 with no newlines — the Claude `document` block rejects wrapped base64. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

const PDF_MAGIC = '%PDF-'

/** Cheap sniff so a mislabelled upload fails at ingest instead of mid-extraction. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString('latin1') === PDF_MAGIC
}

/**
 * Reads the page count without rendering anything.
 *
 * pdfjs-dist is imported dynamically so that merely importing this module
 * never drags its ESM build (and its worker plumbing) into a bundle that
 * doesn't need it.
 */
export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    // pdf.js transfers ownership of the buffer it is given, so hand it a copy —
    // otherwise the caller's bytes are detached and every later read sees zero
    // length (this bit us on the hash-then-parse ordering).
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise
  try {
    return doc.numPages
  } finally {
    await doc.destroy()
  }
}

/**
 * Extracts ONE page out of `bytes` as its own standalone one-page PDF, so it
 * can be sent to Claude as an independent `document` block (see the header
 * comment above for why extraction now runs one call per page).
 *
 * `pdf-lib` rather than `pdfjs-dist` for this: pdfjs-dist can only read a
 * PDF, never write one — it's what `getPdfPageCount` above uses, and what
 * hit the canvas-backend wall this file's header comment describes when
 * asked to rasterise. pdf-lib is a pure-JS PDF *writer* with no native
 * dependency, so it does not carry that same risk.
 *
 * `pageNumber` is 1-indexed, matching every other page number in this
 * codebase (document_page.page_number, the extraction tool's pages[]);
 * pdf-lib's own `copyPages`/`getPage` are 0-indexed internally, so the
 * conversion happens right here rather than leaking a second numbering
 * convention out to callers.
 */
export async function splitPdfPage(bytes: Uint8Array, pageNumber: number): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const source = await PDFDocument.load(bytes)
  const pageIndex = pageNumber - 1
  if (pageIndex < 0 || pageIndex >= source.getPageCount()) {
    throw new RangeError(
      `splitPdfPage: page ${pageNumber} is out of range for a ${source.getPageCount()}-page document`
    )
  }

  const out = await PDFDocument.create()
  const [copied] = await out.copyPages(source, [pageIndex])
  out.addPage(copied)
  return out.save()
}
