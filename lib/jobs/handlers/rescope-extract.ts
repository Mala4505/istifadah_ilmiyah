/**
 * Phase 4 (docs/event-scoping-and-review-fixes-plan.md §2.6): field- and
 * page-scoped re-OCR. Both entry points below are thin, purpose-built
 * siblings of `extractAndPersist` (./extract.ts) -- they reuse its exported
 * helpers (`downloadDocumentPdf`, `fetchSourceDocumentForExtraction`,
 * `persistExtractionPipelineResult`, `insertRun`) rather than duplicating
 * the pipeline, but neither one re-runs the WHOLE document. That's what
 * makes them cheap enough to stay on Haiku -- see each function's own doc
 * comment for the exact scope it touches and does not touch.
 *
 * Only called from lib/actions/review.ts's `reExtractPage` / `reExtractField`
 * wrappers, which already gate on `isAdminOrAbove` before either of these
 * ever runs (same admin-only gate as the existing whole-document
 * `/api/documents/reescalate` route) -- neither function re-checks auth.
 */

import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  downloadDocumentPdf,
  fetchSourceDocumentForExtraction,
  insertRun,
  persistExtractionPipelineResult,
} from './extract'
import { extractPageRange, splitPdfPage } from '@/lib/pdf'
import { remapExtractionPageNumbers, remapExtractionToActualPage } from '@/lib/extraction-schema'
import { runExtractionPipeline, type ExtractionPipelineResult } from '@/lib/extraction'
import { MODELS } from '@/lib/claude-client'
import { isSameGstin, validateGstin } from '@/lib/analytics/gstin'
import { serverEnv } from '@/lib/env.server'
import type { ReExtractableHeaderField } from '@/lib/actions/review'

type AdminClient = ReturnType<typeof createAdminClient>

export interface ReExtractPageScopedParams {
  sourceDocumentId: number
  pageNumber: number
  triggeredBy: string | null
}

export interface ReExtractPageScopedResult {
  /** True when this page had no existing bill and one was newly discovered. */
  created: boolean
  /** Null only when the fresh read confirms the page is genuinely non-financial. */
  documentExtractionId: number | null
  /** 0 or 1 -- a single page can produce at most one bill. */
  billCount: number
  lineItemCount: number
}

/**
 * Re-runs OCR for exactly one page and persists the result, without
 * touching any other page or bill in the document. Two cases, both real:
 *
 * 1. The page has no existing bill (it was skipped, or never classified as
 *    financial) -- "OCR a page the model skipped" (§2.5's second half).
 *    A bill may or may not be discovered; either way only this page's own
 *    `document_page` row and (if a bill was found) one new
 *    `document_extraction` row are written.
 * 2. The page IS an existing bill, and that bill is exactly one page
 *    (`page_number_start === page_number_end === pageNumber`) -- "re-OCR
 *    this one page" for a bill that's already been reviewed once. The
 *    existing document_extraction row is overwritten wholesale (every
 *    `_ocr` column + its line items), same as the whole-document
 *    "Re-extract with Sonnet" button does for a single-page document today
 *    -- callers should treat this like that button (full `router.refresh()`,
 *    not a local-state patch: see `reExtractField`'s doc comment in
 *    lib/actions/review.ts for why the two functions differ on this point).
 *
 * A page that belongs to an EXISTING MULTI-page bill (page_number_end >
 * page_number_start) is out of scope for this function -- re-running just
 * one of that bill's pages would lose the header context the bill's
 * original multi-page extraction restored (see extract.ts's `resolveGroups`
 * doc comment for why that context matters). Reject with a clear error
 * telling the caller to use the whole-document re-extract instead; do not
 * attempt a partial read.
 *
 * Implementation outline (mirrors `extractAndPersist` in ./extract.ts,
 * scoped to one page):
 *
 * 1. `fetchSourceDocumentForExtraction` for the source_document row.
 * 2. Query `document_extraction` for this source_document_id, to find
 *    whether `pageNumber` falls inside any existing bill's
 *    [page_number_start, page_number_end] range (select id, bill_index,
 *    page_number_start, page_number_end). If it falls inside a range wider
 *    than one page, throw the multi-page rejection above. If it falls
 *    inside a single-page bill, remember that bill's `id`/`bill_index` --
 *    this is the "update in place" case. If it falls inside no bill at all,
 *    this is the "discovery" case: compute the next bill_index as
 *    `(max(bill_index) over every existing row for this source_document) + 1`,
 *    or 0 if there are no existing rows.
 * 3. `downloadDocumentPdf(doc.storagePath)`, then `splitPdfPage(pdfBytes, pageNumber)`.
 * 4. `runExtractionPipeline(pageBytes, { model: MODELS.haiku, runReason: 'manual_reescalation', allowEscalation: false })`
 *    -- always Haiku, never escalates; the scoping is what makes this cheap,
 *    not the model (plan §2.6, verbatim).
 * 5. Remap every attempt's extraction with `remapExtractionToActualPage(extraction, pageNumber)`
 *    -- same reasoning as `extractAllPagesConcurrently` in ./extract.ts: the
 *    model saw a standalone one-page PDF and reports page_number 1.
 * 6. Build an `ExtractionPipelineResult` the same shape
 *    `extractAllPagesConcurrently` builds (attempts + final + escalated +
 *    totalCostUsd).
 * 7. Call `persistExtractionPipelineResult(admin, { sourceDocumentId, doc,
 *    pipeline, triggeredBy, billIndexOffset: <from step 2>, finalizeDocument: false })`.
 *    This alone writes the document_page row, the document_extraction
 *    upsert (0 or 1 bills), line items, and tally checks -- do not
 *    reimplement any of that here. `finalizeDocument: false` is required:
 *    this must never touch `source_document.upload_status`/`page_count` or
 *    raise `page_count_mismatch` (those are whole-document concerns).
 * 8. Explicitly reset this page's provenance after persisting: `update
 *    document_page set skip_source = 'model', manually_set_by = null,
 *    manually_set_at = null where source_document_id = ... and page_number =
 *    ...`. Required because `persistExtractionPipelineResult`'s own
 *    document_page upsert payload does not include `skip_source` (Supabase's
 *    upsert only touches columns present in the payload), so without this
 *    explicit reset a page a reviewer had manually unskipped would still
 *    read `skip_source: 'manual'` after a fresh model read that may have
 *    reclassified it right back to non-financial -- misleading provenance,
 *    even though `is_financial_document` itself is correct either way.
 * 9. Return `{ created: <was discovery>, documentExtractionId: <from the
 *    persisted result, or the pre-existing single-page bill's id, or null
 *    if the fresh read still found no bill>, billCount, lineItemCount }`
 *    from `persistExtractionPipelineResult`'s own return value.
 */
export async function reExtractPageScoped(
  admin: AdminClient,
  params: ReExtractPageScopedParams
): Promise<ReExtractPageScopedResult> {
  const { sourceDocumentId, pageNumber, triggeredBy } = params

  const doc = await fetchSourceDocumentForExtraction(admin, sourceDocumentId)

  // Step 2: does this page already belong to a bill?
  const { data: existingBills, error: existingBillsError } = await admin
    .from('document_extraction')
    .select('id, bill_index, page_number_start, page_number_end')
    .eq('source_document_id', sourceDocumentId)

  if (existingBillsError) {
    throw new Error(`reExtractPageScoped: loading existing bills failed: ${existingBillsError.message}`)
  }

  const bills = existingBills ?? []
  const containingBill = bills.find(
    (b) => (b.page_number_start as number) <= pageNumber && pageNumber <= (b.page_number_end as number)
  )

  let billIndexOffset: number
  let existingSinglePageBillId: number | null = null
  const isDiscovery = containingBill === undefined

  if (containingBill !== undefined) {
    const start = containingBill.page_number_start as number
    const end = containingBill.page_number_end as number
    if (end > start) {
      throw new Error(
        `reExtractPageScoped: page ${pageNumber} of source_document ${sourceDocumentId} belongs to a ` +
          `multi-page bill (pages ${start}-${end}). Re-running just one of that bill's pages would lose ` +
          'the header context the original multi-page extraction restored -- use the whole-document ' +
          're-extract instead.'
      )
    }
    billIndexOffset = containingBill.bill_index as number
    existingSinglePageBillId = containingBill.id as number
  } else {
    const maxBillIndex = bills.reduce((max, b) => Math.max(max, b.bill_index as number), -1)
    billIndexOffset = maxBillIndex + 1
  }

  // Step 3-4: scoped Haiku-only re-read of exactly this page.
  const pdfBytes = await downloadDocumentPdf(doc.storagePath)
  const pageBytes = await splitPdfPage(pdfBytes, pageNumber)
  const raw = await runExtractionPipeline(pageBytes, {
    model: MODELS.haiku,
    runReason: 'manual_reescalation',
    allowEscalation: false,
  })

  // Step 5: the model saw a standalone one-page PDF and reported page_number 1.
  const attempts = raw.attempts.map((attempt) => ({
    ...attempt,
    extraction: remapExtractionToActualPage(attempt.extraction, pageNumber),
  }))

  // Step 6.
  const pipeline: ExtractionPipelineResult = {
    attempts,
    final: attempts[attempts.length - 1]!,
    escalated: raw.escalated,
    totalCostUsd: raw.totalCostUsd,
  }

  // Step 7.
  const persisted = await persistExtractionPipelineResult(admin, {
    sourceDocumentId,
    doc,
    pipeline,
    triggeredBy,
    billIndexOffset,
    finalizeDocument: false,
  })

  // Step 8: reset this page's provenance -- persistExtractionPipelineResult's
  // own document_page upsert payload does not include skip_source, so without
  // this a manually-unskipped page would keep reading skip_source: 'manual'
  // after a fresh model read.
  const { error: pageResetError } = await admin
    .from('document_page')
    .update({ skip_source: 'model', manually_set_by: null, manually_set_at: null })
    .eq('source_document_id', sourceDocumentId)
    .eq('page_number', pageNumber)

  if (pageResetError) {
    throw new Error(`reExtractPageScoped: resetting document_page provenance failed: ${pageResetError.message}`)
  }

  const created = isDiscovery && persisted.documentExtractionIds.length > 0
  const documentExtractionId = persisted.documentExtractionIds[0] ?? existingSinglePageBillId ?? null

  return {
    created,
    documentExtractionId,
    billCount: persisted.billCount,
    lineItemCount: persisted.lineItemCount,
  }
}

export interface ReExtractFieldScopedParams {
  documentExtractionId: number
  field: ReExtractableHeaderField
  triggeredBy: string | null
}

export interface ReExtractFieldScopedResult {
  newValue: string | number | null
}

/**
 * Re-runs OCR over one bill's existing page range and writes back ONLY the
 * named field's `_ocr` column -- nothing else on the row changes, and
 * `current_extraction_run_id` is deliberately NOT updated (see
 * `reExtractField`'s doc comment in lib/actions/review.ts for why: this
 * function's entire purpose is to be invisible to the "did the extraction
 * run change" check the workspace uses to decide whether to remount).
 *
 * Implementation outline:
 *
 * 1. Load the `document_extraction` row: `select source_document_id,
 *    page_number_start, page_number_end from document_extraction where id =
 *    documentExtractionId`. Throw if not found.
 * 2. `fetchSourceDocumentForExtraction` + `downloadDocumentPdf` for that
 *    source_document_id, same as `reExtractPageScoped`.
 * 3. Get this bill's own page bytes: `page_number_start === page_number_end`
 *    -> `splitPdfPage(pdfBytes, page_number_start)`; otherwise ->
 *    `extractPageRange(pdfBytes, page_number_start, page_number_end)`.
 * 4. `runExtractionPipeline(bytes, { model: MODELS.haiku, runReason:
 *    'manual_reescalation', allowEscalation: false })` -- Haiku only, same
 *    as `reExtractPageScoped`.
 * 5. Remap page numbers back to the document's real numbering: single page
 *    -> `remapExtractionToActualPage(extraction, page_number_start)`; range
 *    -> `remapExtractionPageNumbers(extraction, (n) => n + (page_number_start - 1))`
 *    (identical offset math to `resolveGroups`'s merged-group branch in
 *    ./extract.ts).
 * 6. Take `pipeline.final.extraction.bills[0]` (if `bills.length === 0`,
 *    throw "the re-read did not find a bill on this page range" -- if
 *    `bills.length > 1`, still take `bills[0]` and ignore the rest; a single
 *    bill's own page range should never re-split into two bills, but this
 *    function does not need to handle it as anything other than "use the
 *    first one").
 * 7. Map `field` to the bill's raw value and the document_extraction column
 *    to write, applying the SAME guards `persistExtractionPipelineResult`
 *    applies when this field is `vendor_gstin` (nowhere else):
 *      - own-org exclusion: if `serverEnv.COMMUNITY_GSTIN !== ''` and
 *        `isSameGstin(bill.vendor_gstin, serverEnv.COMMUNITY_GSTIN)`, write
 *        `null` instead of the read value (it's almost certainly the
 *        recipient's GSTIN, not the vendor's).
 *      - checksum guard: if not the own-org case and `bill.vendor_gstin !==
 *        null`, run `validateGstin(bill.vendor_gstin)`; if invalid, write
 *        `null` instead (a failed checksum is definitionally wrong, never
 *        written as-is). Import `isSameGstin`/`validateGstin` from
 *        '@/lib/analytics/gstin', exactly as ./extract.ts does.
 *    Every other field writes the read value straight through, no guard:
 *      vendor_name -> vendor_name_ocr, vendor_phone -> vendor_phone_ocr,
 *      vendor_email -> vendor_email_ocr, vendor_address -> vendor_address_ocr,
 *      invoice_number -> invoice_number_ocr, invoice_date -> invoice_date_ocr,
 *      subtotal -> subtotal_ocr, tax_amount -> tax_amount_ocr,
 *      total_amount -> total_amount_ocr.
 * 8. `admin.from('document_extraction').update({ <that one column>: <value> }).eq('id', documentExtractionId)`
 *    -- the payload must contain exactly one column (plus nothing else).
 *    Throw on `.error`.
 * 9. Insert an audit row for this attempt the same shape `insertRun` in
 *    ./extract.ts already builds (source_document_id, model, run_reason,
 *    triggered_by, status, raw_response_jsonb, legibility,
 *    extraction_confidence, contains_non_latin_script, input_tokens,
 *    output_tokens, cost_usd, started_at, completed_at, from
 *    `pipeline.final`). `insertRun` itself is not exported from ./extract.ts
 *    -- either add `export` to its declaration there (a same-signature,
 *    zero-risk change, since nothing else in that file changes) and import
 *    it here, or write the equivalent insert directly; either is fine, but
 *    do not skip the audit row -- §8 point 7's "prior runs never deleted"
 *    applies to a scoped re-read exactly as much as a full one.
 * 10. Return `{ newValue: <the value actually written, i.e. after the
 *     vendor_gstin guard if applicable, not the raw model output> }`.
 */
export async function reExtractFieldScoped(
  admin: AdminClient,
  params: ReExtractFieldScopedParams
): Promise<ReExtractFieldScopedResult> {
  const { documentExtractionId, field, triggeredBy } = params

  // Step 1.
  const { data: extractionRow, error: extractionRowError } = await admin
    .from('document_extraction')
    .select('source_document_id, page_number_start, page_number_end')
    .eq('id', documentExtractionId)
    .maybeSingle()

  if (extractionRowError) {
    throw new Error(`reExtractFieldScoped: loading document_extraction failed: ${extractionRowError.message}`)
  }
  if (!extractionRow) {
    throw new Error(`reExtractFieldScoped: document_extraction ${documentExtractionId} not found`)
  }

  const sourceDocumentId = extractionRow.source_document_id as number
  const pageNumberStart = extractionRow.page_number_start as number
  const pageNumberEnd = extractionRow.page_number_end as number

  // Step 2.
  const doc = await fetchSourceDocumentForExtraction(admin, sourceDocumentId)
  const pdfBytes = await downloadDocumentPdf(doc.storagePath)

  // Step 3.
  const scopedBytes =
    pageNumberStart === pageNumberEnd
      ? await splitPdfPage(pdfBytes, pageNumberStart)
      : await extractPageRange(pdfBytes, pageNumberStart, pageNumberEnd)

  // Step 4.
  const raw = await runExtractionPipeline(scopedBytes, {
    model: MODELS.haiku,
    runReason: 'manual_reescalation',
    allowEscalation: false,
  })

  // Step 5.
  const attempts = raw.attempts.map((attempt) => ({
    ...attempt,
    extraction:
      pageNumberStart === pageNumberEnd
        ? remapExtractionToActualPage(attempt.extraction, pageNumberStart)
        : remapExtractionPageNumbers(attempt.extraction, (n) => n + (pageNumberStart - 1)),
  }))
  const pipeline: ExtractionPipelineResult = {
    attempts,
    final: attempts[attempts.length - 1]!,
    escalated: raw.escalated,
    totalCostUsd: raw.totalCostUsd,
  }

  // Step 6.
  const bill = pipeline.final.extraction.bills[0]
  if (!bill) {
    throw new Error(
      `reExtractFieldScoped: the re-read of document_extraction ${documentExtractionId}'s page range ` +
        `(${pageNumberStart}-${pageNumberEnd}) did not find a bill on this page range`
    )
  }

  // Step 7.
  let newValue: string | number | null
  if (field === 'vendor_gstin') {
    const isOwnOrgGstin =
      serverEnv.COMMUNITY_GSTIN !== '' && isSameGstin(bill.vendor_gstin, serverEnv.COMMUNITY_GSTIN)
    if (isOwnOrgGstin) {
      newValue = null
    } else if (bill.vendor_gstin !== null) {
      const checksum = validateGstin(bill.vendor_gstin)
      newValue = checksum.valid ? bill.vendor_gstin : null
    } else {
      newValue = null
    }
  } else {
    newValue = bill[field]
  }

  const column = REEXTRACT_FIELD_TO_COLUMN[field]

  // Step 8.
  const { error: updateError } = await admin
    .from('document_extraction')
    .update({ [column]: newValue })
    .eq('id', documentExtractionId)

  if (updateError) {
    throw new Error(`reExtractFieldScoped: document_extraction update failed: ${updateError.message}`)
  }

  // Step 9: audit row, same shape as a whole-document re-extract's.
  await insertRun(admin, sourceDocumentId, pipeline.final, triggeredBy)

  // Step 10.
  return { newValue }
}

const REEXTRACT_FIELD_TO_COLUMN: Record<ReExtractableHeaderField, string> = {
  vendor_name: 'vendor_name_ocr',
  vendor_gstin: 'vendor_gstin_ocr',
  vendor_phone: 'vendor_phone_ocr',
  vendor_email: 'vendor_email_ocr',
  vendor_address: 'vendor_address_ocr',
  invoice_number: 'invoice_number_ocr',
  invoice_date: 'invoice_date_ocr',
  subtotal: 'subtotal_ocr',
  tax_amount: 'tax_amount_ocr',
  total_amount: 'total_amount_ocr',
}
