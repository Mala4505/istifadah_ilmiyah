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
 * So the extraction handler sends the PDF to Claude as a single base64
 * `document` block instead (see lib/claude-client.ts → DocumentPdfInput).
 * Claude renders the pages itself and additionally reads the embedded text
 * layer, which on these vendor invoices is strictly more information than a
 * 200-DPI PNG would carry. The §8 contract is otherwise unchanged: still one
 * call per document, still all pages in one request, still per-page
 * classification via the tool schema's `pages[]`.
 *
 * The one §8 detail this trades away is point 7's "Sonnet uses higher-
 * resolution rasterisation (2,576 px vs 1,568 px)": with a PDF block the API
 * owns rendering resolution, so escalation changes the model only. That is the
 * substantive half of the escalation rule.
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
