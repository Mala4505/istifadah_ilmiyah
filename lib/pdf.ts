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
 * This single-page split is a per-page FIRST PASS only, not the whole story:
 * a bill whose line items continue onto a following page needs that page's
 * own header context back, which a lone split-out page cannot carry — see
 * `extractPageRange` below and `resolveGroups` in
 * lib/jobs/handlers/extract.ts for the second pass that re-merges exactly
 * those pages (and only those) back into one call.
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
 * `pdf-lib` rather than `pdfjs-dist`, as of the fix for a Vercel-only failure:
 * pdfjs-dist parses fine locally, but its worker plumbing turned out not to
 * survive Vercel's serverless bundling — every deployed call failed with
 * "Cannot find module '.../pdfjs-dist/legacy/build/pdf.worker.mjs'", because
 * pdfjs's own "fake worker" fallback (used when it can't spin up a real
 * `Worker` thread — the normal, expected path in a Node server function)
 * still needs to *import* that worker module to run its message-handling
 * logic inline, and Next.js's build-time file tracing (what decides which
 * files actually ship in the deployed function bundle) never detected that
 * dynamic import as a dependency worth including. Locally, nothing is
 * pruned, so the file is just there — which is exactly why this went
 * unnoticed until it was actually diagnosed against the deployed site rather
 * than a local dev server.
 *
 * `pdf-lib` sidesteps the whole problem rather than working around it: it is
 * pure JavaScript with no worker thread and nothing to trace and fail to
 * include in the first place. It's already a dependency here for
 * `splitPdfPage` below, which does the exact same `PDFDocument.load` this
 * does — a page-count call is what that load already knows for free, before
 * any splitting happens.
 */
export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes)
  return doc.getPageCount()
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

/**
 * Extracts a contiguous run of pages [startPage, endPage] (1-indexed,
 * inclusive) out of `bytes` as its own standalone PDF — the multi-page
 * counterpart to `splitPdfPage` above.
 *
 * Used by lib/jobs/handlers/extract.ts's bill-grouping step
 * (`resolveGroups`): when a bill's line-item table continues across a page
 * break, per-page splitting throws away the header context a continuation
 * page needs (this file's header comment). Rather than reverting to one call
 * per whole document — which is what made truncation/one-bad-page-loses-
 * everything a problem in the first place — only that bill's own pages are
 * re-merged and re-extracted together, in one call bounded to just those
 * few pages.
 */
export async function extractPageRange(bytes: Uint8Array, startPage: number, endPage: number): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const source = await PDFDocument.load(bytes)
  const pageCount = source.getPageCount()
  if (startPage < 1 || endPage < startPage || endPage > pageCount) {
    throw new RangeError(`extractPageRange: range ${startPage}-${endPage} is invalid for a ${pageCount}-page document`)
  }

  const indices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage - 1 + i)
  const out = await PDFDocument.create()
  const copied = await out.copyPages(source, indices)
  for (const page of copied) out.addPage(page)
  return out.save()
}
