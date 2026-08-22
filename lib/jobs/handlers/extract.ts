/**
 * `extract_document` job handler (MASTER-PLAN §3.11, §8, §9.4).
 *
 * Claimed by either caller of the one worker loop (§3.11) —
 * app/api/jobs/tick/route.ts on Vercel, worker/index.ts as a Windows service —
 * and, per the JobHandler contract documented in worker/index.ts, this module
 * owns its own completion bookkeeping.
 *
 * What it does, in §8 order (updated from the original one-call-per-document
 * design — see `extractAndPersist`'s doc comment for why extraction now runs
 * one Claude call per PAGE instead):
 *   3. one Claude call per page, Haiku first, pages dispatched concurrently
 *      (classification-before-extraction is enforced in code by
 *      `filterNonFinancialLineItems`, not by asking the model nicely)
 *      → escalates to Sonnet on low confidence or non-Latin script
 *   4. writes `_ocr` columns only — `_verified` is the Day 4 review queue's
 *      job and is never touched here
 *   5. tally checks on write, raising `reconciliation_exception` rows
 */

import 'server-only'
import { completeJob, failJob, type JobQueueRow } from '@/lib/jobs/queue'
import { POLL_BACKOFF_BASE_MS } from '@/lib/jobs/poll-backoff'
import { buildExtractionBatchCustomId } from '@/lib/jobs/batch-custom-id'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSignedUrl } from '@/lib/storage'
import { extractPageRange, getPdfPageCount, splitPdfPage, toBase64 } from '@/lib/pdf'
import { tallyWithinTolerance } from '@/lib/normalize'
import {
  escalationReason,
  lineItemTotal,
  runExtractionPipeline,
  type ExtractionAttempt,
  type ExtractionPipelineResult,
} from '@/lib/extraction'
import {
  buildTaxBreakdown,
  remapExtractionPageNumbers,
  remapExtractionToActualPage,
  sanitizeExtractionResponse,
  type ExtractionPage,
} from '@/lib/extraction-schema'
import { EXTRACTION_MAX_TOKENS, MODELS, submitExtractionBatch, type ModelId } from '@/lib/claude-client'
import { serverEnv } from '@/lib/env.server'
import { isSameGstin, validateGstin } from '@/lib/analytics/gstin'
import {
  checkGstRecipientCompliance,
  type GstComplianceMissingItem,
} from '@/lib/gst-recipient-compliance'

export interface ExtractDocumentPayload {
  source_document_id: number
}

/**
 * `job_queue.payload` shape for the `poll_batch` job a batch submission
 * enqueues (plan.md Phase 3 I16). A plain jsonb payload is enough to carry
 * the batch_id -> source_document_id mapping between submission and poll —
 * no new table or migration needed (job_queue.payload is already jsonb, and
 * `poll_batch` was already a valid job_type before this pass, per §3.11's
 * original job_queue definition).
 */
export interface PollBatchPayload {
  batch_id: string
  source_document_id: number
  model: ModelId
  max_tokens: number
}

export interface ExtractAndPersistOptions {
  sourceDocumentId: number
  /** `initial` for the queue path, `manual_reescalation` for the button (§8 point 7). */
  runReason: 'initial' | 'manual_reescalation'
  /** Defaults to Haiku; the re-escalation route forces Sonnet. */
  model?: ModelId
  /** The reviewer who pressed the button, when there is one. */
  triggeredBy?: string | null
}

export interface ExtractAndPersistResult {
  sourceDocumentId: number
  /** One id per bill Claude found (Phase 2) — ordered by bill_index. */
  documentExtractionIds: number[]
  /** extraction.bills.length — 1 for the overwhelming majority of documents. */
  billCount: number
  runIds: number[]
  currentRunId: number
  modelUsed: ModelId
  escalated: boolean
  /** Why the run escalated to Sonnet, or null when it did not (§8 escalation rule). */
  escalatedBecause: string | null
  totalCostUsd: number
  /** Sum of every bill's line item count. */
  lineItemCount: number
  pageCount: number
  /** Union across all bills' exceptions, in bill order. */
  exceptionsRaised: string[]
}

type AdminClient = ReturnType<typeof createAdminClient>

/** What persistExtractionPipelineResult needs about the source_document row. */
export interface SourceDocumentForExtraction {
  storagePath: string
  entryId: number | null
  pageCount: number | null
}

/**
 * Fetches the `source_document` columns the extraction pipeline needs.
 * Shared by the synchronous path (`extractAndPersist` below) and the Batch
 * API submission/poll paths (`submitExtractionBatchAndEnqueuePoll` below,
 * and `handlePollBatch` in lib/jobs/handlers/batch-poll.ts) — all three need
 * the same row, at different points in the flow.
 */
export async function fetchSourceDocumentForExtraction(
  admin: AdminClient,
  sourceDocumentId: number
): Promise<SourceDocumentForExtraction> {
  const { data: doc, error: docError } = await admin
    .from('source_document')
    .select('id, storage_path, entry_id, page_count')
    .eq('id', sourceDocumentId)
    .single()

  if (docError || !doc) {
    throw new Error(
      `extract: source_document ${sourceDocumentId} not found (${docError?.message ?? 'no row'})`
    )
  }

  return {
    storagePath: doc.storage_path as string,
    entryId: (doc.entry_id as number | null) ?? null,
    pageCount: (doc.page_count as number | null) ?? null,
  }
}

/**
 * Downloads one document's PDF bytes through a short-lived signed URL (§4.3:
 * the app never handles a raw storage path in the open — it reads through a
 * signed URL, same as the browser would). Shared by the synchronous path,
 * the batch submission step, and the batch poll's truncation-retry fallback
 * (lib/jobs/handlers/batch-poll.ts) — all three need the same bytes.
 */
export async function downloadDocumentPdf(storagePath: string): Promise<Uint8Array> {
  const signedUrl = await getSignedUrl(storagePath, 300)
  const response = await fetch(signedUrl)
  if (!response.ok) {
    throw new Error(`downloading ${storagePath} failed: HTTP ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Records a failed extraction attempt: marks `source_document.upload_status`
 * `'failed'` and inserts a `status: 'failed'` `ocr_extraction_run` row.
 * Extracted out of `extractAndPersist`'s catch block so
 * `submitExtractionBatchAndEnqueuePoll` and `handlePollBatch`
 * (lib/jobs/handlers/batch-poll.ts) record failures identically instead of a
 * second hand-written copy of this bookkeeping.
 */
export async function recordExtractionFailure(
  admin: AdminClient,
  sourceDocumentId: number,
  model: ModelId,
  runReason: ExtractAndPersistOptions['runReason'],
  triggeredBy: string | null,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  await admin
    .from('source_document')
    .update({ upload_status: 'failed' })
    .eq('id', sourceDocumentId)
  await admin.from('ocr_extraction_run').insert({
    source_document_id: sourceDocumentId,
    model,
    run_reason: runReason,
    triggered_by: triggeredBy,
    status: 'failed',
    error_message: message.slice(0, 2000),
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  })
}

export interface PersistExtractionPipelineResultParams {
  sourceDocumentId: number
  doc: SourceDocumentForExtraction
  pipeline: ExtractionPipelineResult
  triggeredBy: string | null
  /**
   * `document_extraction.bill_index` numbering starts here rather than at 0.
   * Needed because per-page extraction (extractAndPersist below) calls this
   * function once per page, sequentially, for the same document — without an
   * offset, every page's own bills[0] would collide on bill_index 0 and each
   * page would silently overwrite the previous one's document_extraction row
   * (the upsert's `onConflict: 'source_document_id,bill_index'` is exactly
   * what makes that collision destructive rather than a duplicate-row error).
   * Defaults to 0, which reproduces the original single-call-per-document
   * behavior exactly — batch-poll.ts's one call per document never needs to
   * pass this.
   */
  billIndexOffset?: number
  /**
   * Whether this call should also run the whole-document completion step —
   * marking `source_document.upload_status = 'processed'`, writing its final
   * `page_count`, and raising `page_count_mismatch` if the model classified
   * fewer pages than ingest found. Defaults to true, matching every existing
   * caller (batch-poll.ts, and the old single-call shape). Per-page extraction
   * passes false on every page and calls `finalizeSourceDocumentExtraction`
   * itself exactly once after the whole loop — calling it per page would let
   * the LAST page processed silently overwrite page_count with "1" instead of
   * the real total, and would fire a false page_count_mismatch exception on
   * every page but the last.
   */
  finalizeDocument?: boolean
}

/**
 * Writes every row one extraction pipeline result implies:
 * `ocr_extraction_run` (one per attempt), `document_page`, one
 * `document_extraction` row per bill plus its exceptions/line items/tally
 * checks, and the `source_document` completion update. This is the shared
 * persistence core the task brief asks for: both `extractAndPersist` (the
 * synchronous path, below) and `handlePollBatch`
 * (lib/jobs/handlers/batch-poll.ts, once a Batch API result has been parsed
 * into the same `ExtractionPipelineResult` shape via
 * `interpretBatchResult`/`parseExtractionMessage` in lib/claude-client.ts)
 * call this ONE function rather than each re-implementing the
 * document_extraction/document_page/line-item/tally-check block.
 *
 * Takes an already-built `ExtractionPipelineResult` rather than PDF bytes —
 * how that result was obtained (one synchronous Claude call plus an optional
 * in-process Sonnet escalation, vs. an async Batch API round trip) is
 * deliberately invisible to this function; it only needs the attempts array
 * and the model's own output.
 */
export async function persistExtractionPipelineResult(
  admin: AdminClient,
  params: PersistExtractionPipelineResultParams
): Promise<ExtractAndPersistResult> {
  const { sourceDocumentId, doc, pipeline, triggeredBy } = params
  const billIndexOffset = params.billIndexOffset ?? 0
  const finalizeDocument = params.finalizeDocument ?? true

  // ---- ocr_extraction_run: one row per attempt, prior runs never deleted (§8 point 7)
  const runIds: number[] = []
  for (const attempt of pipeline.attempts) {
    const runId = await insertRun(admin, sourceDocumentId, attempt, triggeredBy)
    runIds.push(runId)
  }
  const currentRunId = runIds[runIds.length - 1]!
  const final = pipeline.final
  // Leaked tool-call tag syntax backstop (§3b, hub-refinements-plan.md): the
  // system prompt (buildSystemPrompt in lib/claude-client.ts) already asks
  // the model not to do this, but nothing constrains what text ends up
  // *inside* a string field (Zod validates structure, not content) — same
  // "never trust the model alone" posture as filterNonFinancialLineItems and
  // the own-org GSTIN exclusion below.
  // Every downstream use of `extraction` (document_extraction upsert, line
  // item insert, tally checks) reads the sanitized copy from here on.
  const { cleaned: extraction, blankedFields: leakedTagFields } = sanitizeExtractionResponse(final.extraction)

  // ---- document_page: the classification gate's per-page verdict (§8 point 3)
  const pageRows = extraction.pages.map((page) => ({
    source_document_id: sourceDocumentId,
    page_number: page.page_number,
    is_financial_document: page.is_financial_document,
    classification_confidence: page.classification_confidence,
    skip_reason: page.skip_reason,
  }))
  if (pageRows.length > 0) {
    const { error: pageError } = await admin
      .from('document_page')
      .upsert(pageRows, { onConflict: 'source_document_id,page_number' })
    if (pageError) throw new Error(`document_page upsert failed: ${pageError.message}`)
  }

  const { data: pages } = await admin
    .from('document_page')
    .select('id, page_number')
    .eq('source_document_id', sourceDocumentId)
  const pageIdByNumber = new Map<number, number>(
    (pages ?? []).map((p) => [p.page_number as number, p.id as number])
  )

  // ---- document_extraction: one row per bill (Phase 2 — a batch scan may
  // contain several distinct bills, each independently reviewable and
  // tally-checked). _ocr columns only; _verified stays null (§8 point 4).
  const documentExtractionIds: number[] = []
  let totalLineItems = 0
  const allExceptionsRaised: string[] = []

  for (let billIndex = 0; billIndex < extraction.bills.length; billIndex++) {
    const bill = extraction.bills[billIndex]!

    // Own-org GSTIN exclusion: when COMMUNITY_GSTIN is configured and the
    // model read it back as vendor_gstin, it almost certainly picked up the
    // recipient's GSTIN off the page rather than the seller's (buildSystemPrompt
    // in lib/claude-client.ts already asks it not to, but this is the
    // code-level backstop — same "never trust the model alone" posture as
    // filterNonFinancialLineItems). The write below nulls vendor_gstin_ocr in
    // that case; the reconciliation_exception raised further down is what
    // tells a reviewer *why* it's blank instead of leaving them to assume OCR
    // simply missed it.
    const isOwnOrgGstin =
      serverEnv.COMMUNITY_GSTIN !== '' && isSameGstin(bill.vendor_gstin, serverEnv.COMMUNITY_GSTIN)

    // Checksum guard: a GSTIN's own last character is a check digit computed
    // over the other fourteen (validateGstin, lib/analytics/gstin.ts — already
    // written and unit-tested, previously wired only into the compliance
    // analytics pass, never into what gets written here). Unlike the own-org
    // exclusion above, this isn't a judgment call about which party a GSTIN
    // belongs to — a failed checksum means the GSTIN is definitionally wrong,
    // mis-typed on the document or mis-read by OCR, so there is no scenario
    // where writing it as-is is the right move. Skipped when it's already
    // null (nothing extracted — not this guard's concern) or already caught
    // by the own-org check above (one wrong-value reason per bill, not two
    // exceptions saying similar things).
    const gstinChecksum =
      !isOwnOrgGstin && bill.vendor_gstin !== null ? validateGstin(bill.vendor_gstin) : null
    const isInvalidGstinChecksum = gstinChecksum !== null && !gstinChecksum.valid

    // Buyer-GSTIN checksum guard (redesign plan §12): same backstop as
    // vendor_gstin above — a failed checksum means the GSTIN is
    // definitionally wrong, so it is never written as-is. Unlike
    // vendor_gstin, there is no own-org exclusion here: buyer_gstin is
    // SUPPOSED to equal COMMUNITY_GSTIN, so isOwnOrgGstin (which exists to
    // catch the recipient's GSTIN leaking into the *vendor* field) does not
    // apply. A checksum failure is not raised as its own exception — it
    // simply flows into the combined gst_recipient_compliance_missing
    // exception below as "buyer GSTIN missing," since a checksum-failed
    // value can't be trusted either way.
    const buyerGstinChecksum = bill.buyer_gstin !== null ? validateGstin(bill.buyer_gstin) : null
    const isInvalidBuyerGstinChecksum = buyerGstinChecksum !== null && !buyerGstinChecksum.valid
    const buyerGstinOcr = isInvalidBuyerGstinChecksum ? null : bill.buyer_gstin

    const upsertPayload: Record<string, unknown> = {
      source_document_id: sourceDocumentId,
      bill_index: billIndexOffset + billIndex,
      current_extraction_run_id: currentRunId,
      page_number_start: bill.page_number_start,
      page_number_end: bill.page_number_end,
      vendor_name_ocr: bill.vendor_name,
      vendor_gstin_ocr: isOwnOrgGstin || isInvalidGstinChecksum ? null : bill.vendor_gstin,
      // Recipient/"Bill To" block (redesign plan §12) — read separately from
      // the vendor block above (buildSystemPrompt, lib/claude-client.ts).
      // buyer_gstin_ocr already reflects the checksum guard above.
      buyer_gstin_ocr: buyerGstinOcr,
      buyer_name_ocr: bill.buyer_name,
      vendor_phone_ocr: bill.vendor_phone,
      vendor_email_ocr: bill.vendor_email,
      vendor_address_ocr: bill.vendor_address,
      invoice_number_ocr: bill.invoice_number,
      invoice_date_ocr: bill.invoice_date,
      instrument_type_ocr: bill.instrument_type,
      // Raw text as Claude read it — resolving to a GST state code is
      // done downstream by lib/analytics/fetch.ts (stateCodeFromName),
      // not at write time.
      place_of_supply_ocr: bill.place_of_supply,
      subtotal_ocr: bill.subtotal,
      tax_amount_ocr: bill.tax_amount,
      // See buildTaxBreakdown (lib/extraction-schema.ts) for how the
      // three flat cgst/sgst/igst_amount wire fields become this shape.
      tax_breakdown_ocr: buildTaxBreakdown(bill),
      round_off_ocr: bill.round_off,
      total_amount_ocr: bill.total_amount,
      notes_ocr: bill.notes,
      // Field-level confidence for the review UI (per-field highlight + the
      // PDF viewer's best-effort on-page box) — see extractionUncertainFieldSchema's
      // doc comment (lib/extraction-schema.ts) for the shape and why there is
      // no _verified twin. `sanitizeExtractionResponse` above only scans free-text
      // fields for leaked tag syntax; `field` here is enum-constrained on the
      // wire already, so there is nothing for that pass to catch in this array.
      uncertain_fields_ocr: bill.uncertain_fields,
    }
    // entry_id is only written here for the dominant single-bill case — a
    // read-only mirror of source_document.entry_id, preserving today's
    // behavior exactly. For a real multi-bill document (bills.length > 1),
    // entry_id is intentionally omitted from the payload so it is never
    // part of the upsert's ON CONFLICT SET clause — it stays whatever it
    // already is on that row (null on first insert, or whatever a reviewer
    // attached via attachExtractionToEntry), never overwritten by a
    // re-extraction run.
    if (extraction.bills.length === 1) {
      upsertPayload.entry_id = doc.entryId
    }

    const { data: extractionRow, error: extractionError } = await admin
      .from('document_extraction')
      .upsert(upsertPayload, { onConflict: 'source_document_id,bill_index' })
      .select('id, entry_id')
      .single()

    if (extractionError || !extractionRow) {
      throw new Error(
        `document_extraction upsert failed (bill ${billIndex}): ${extractionError?.message ?? 'no row returned'}`
      )
    }
    const documentExtractionId = extractionRow.id as number
    documentExtractionIds.push(documentExtractionId)

    if (isOwnOrgGstin) {
      await admin.from('reconciliation_exception').upsert(
        {
          document_extraction_id: documentExtractionId,
          exception_type: 'vendor_gstin_is_own_org',
          severity: 'low',
          description:
            'Extracted vendor_gstin matched the community\'s own GSTIN (COMMUNITY_GSTIN) — almost ' +
            'certainly the recipient\'s GSTIN on the page, not the seller\'s. vendor_gstin_ocr was left ' +
            'blank rather than written with the wrong value; enter the real vendor GSTIN on review if legible.',
          dedup_key: `vendor_gstin_is_own_org:${documentExtractionId}:${currentRunId}:${billIndex}`,
        },
        { onConflict: 'dedup_key' }
      )
    }

    if (isInvalidGstinChecksum) {
      await admin.from('reconciliation_exception').upsert(
        {
          document_extraction_id: documentExtractionId,
          exception_type: 'vendor_gstin_invalid_checksum',
          severity: 'low',
          description:
            `Extracted vendor_gstin "${gstinChecksum!.gstin}" fails its own checksum ` +
            `(${gstinChecksum!.message}) — mis-typed on the document or mis-read by OCR, never a valid ` +
            'GSTIN. vendor_gstin_ocr was left blank rather than written with a value known to be wrong; ' +
            'enter the correct GSTIN on review if legible.',
          dedup_key: `vendor_gstin_invalid_checksum:${documentExtractionId}:${currentRunId}:${billIndex}`,
        },
        { onConflict: 'dedup_key' }
      )
    }

    // GST recipient-compliance check (redesign plan §12): only runs when GST
    // is actually charged on this bill; when it does, all three of buyer
    // GSTIN / buyer name / invoice number are required for the community to
    // claim input tax credit. One combined exception per bill (not one per
    // missing item) — high severity, unlike the low-severity GSTIN checks
    // above, since a missing item here has real ITC-claim consequences
    // rather than just being an OCR-quality signal.
    const compliance = checkGstRecipientCompliance({
      buyerGstin: buyerGstinOcr,
      buyerName: bill.buyer_name,
      invoiceNumber: bill.invoice_number,
      communityGstin: serverEnv.COMMUNITY_GSTIN || null,
      communityName: serverEnv.COMMUNITY_NAME || null,
      cgstAmount: bill.cgst_amount,
      sgstAmount: bill.sgst_amount,
      igstAmount: bill.igst_amount,
      taxAmount: bill.tax_amount,
      instrumentType: bill.instrument_type,
    })

    if (compliance.triggered && compliance.missing.length > 0) {
      const missingLabels: Record<GstComplianceMissingItem, string> = {
        buyer_gstin: 'buyer GSTIN',
        buyer_name: 'buyer name',
        invoice_number: 'invoice number',
      }
      const missingText = compliance.missing.map((item) => missingLabels[item]).join(', ')
      await admin.from('reconciliation_exception').upsert(
        {
          document_extraction_id: documentExtractionId,
          exception_type: 'gst_recipient_compliance_missing',
          severity: 'high',
          description:
            `This bill has GST charged but is missing: ${missingText} — required for the community ` +
            'to claim input tax credit.',
          dedup_key: `gst_recipient_compliance_missing:${documentExtractionId}:${currentRunId}:${billIndex}`,
        },
        { onConflict: 'dedup_key' }
      )
    }

    // Leaked tool-call tag syntax (§3b): one exception per document_extraction
    // naming every field on THIS bill that was blanked, rather than one per
    // field — a reviewer gets a single actionable row instead of a flood of
    // duplicates when several fields on the same bill leaked syntax.
    // `leakedTagFields` is flat across the whole response (from
    // sanitizeExtractionResponse), prefixed `bills[i].` per field — filter
    // down to this bill's own entries.
    const billLeakedTagFields = leakedTagFields.filter((field) => field.startsWith(`bills[${billIndex}].`))
    if (billLeakedTagFields.length > 0) {
      await admin.from('reconciliation_exception').upsert(
        {
          document_extraction_id: documentExtractionId,
          exception_type: 'ocr_leaked_tag_syntax',
          severity: 'low',
          description:
            `Extracted text for ${billLeakedTagFields.join(', ')} looked like leaked internal tool-call ` +
            'formatting (e.g. "</antml.parameter>...") rather than real document content, so the ' +
            'affected field(s) were left blank instead of written with corrupted text. Enter the ' +
            'correct value manually on review.',
          dedup_key: `ocr_leaked_tag_syntax:${documentExtractionId}:${currentRunId}:${billIndex}`,
        },
        { onConflict: 'dedup_key' }
      )
    }

    // Re-extraction replaces this bill's line items. Scoped to a single
    // document_extraction_id — never a broad delete.
    const { error: clearError } = await admin
      .from('document_extraction_line_item')
      .delete()
      .eq('document_extraction_id', documentExtractionId)
    if (clearError) {
      throw new Error(`clearing prior line items failed (bill ${billIndex}): ${clearError.message}`)
    }

    if (bill.line_items.length > 0) {
      const itemRows = bill.line_items.map((item, index) => ({
        document_extraction_id: documentExtractionId,
        document_page_id: pageIdByNumber.get(item.page_number) ?? null,
        line_order: item.line_order ?? index,
        description_ocr: item.description,
        hsn_sac_code_ocr: item.hsn_sac_code,
        quantity_ocr: item.quantity,
        quantity_raw_text_ocr: item.quantity_raw_text,
        unit_ocr: item.unit,
        rate_ocr: item.rate,
        discount_ocr: item.discount,
        amount_ocr: item.amount,
      }))
      const { error: itemError } = await admin
        .from('document_extraction_line_item')
        .insert(itemRows)
      if (itemError) throw new Error(`line item insert failed (bill ${billIndex}): ${itemError.message}`)
    }

    // A re-run supersedes the previous one's findings. Prior *runs* are never
    // deleted (§8 point 7), but leaving their exceptions open would fill the
    // Day 4 review queue with contradictory rows about the same document —
    // here, three tally mismatches from a Haiku read that a Sonnet re-run has
    // already corrected. Dismissed (not deleted), with a note pointing at the
    // run that replaced them, and scoped to this one document_extraction.
    await admin
      .from('reconciliation_exception')
      .update({
        status: 'dismissed',
        resolved_at: new Date().toISOString(),
        resolution_note: `Superseded by extraction run ${currentRunId}.`,
      })
      .eq('document_extraction_id', documentExtractionId)
      .eq('status', 'open')
      .in('exception_type', ['line_item_tally_mismatch', 'ocr_total_vs_amount', 'other'])

    // ---- §8 point 5: tally checks, immediately on write, scoped to this bill.
    const billExceptions = await runTallyChecks(admin, {
      documentExtractionId,
      currentRunId,
      // Reflects what's actually stored on the row right now, whether
      // written this run (single-bill case above) or pre-existing (multi-bill
      // case, set later via attachExtractionToEntry).
      entryId: (extractionRow.entry_id as number | null) ?? null,
      totalAmount: bill.total_amount,
      subtotal: bill.subtotal,
      taxAmount: bill.tax_amount,
      lineTotal: lineItemTotal(bill),
      legibility: extraction.legibility,
      containsNonLatinScript: extraction.contains_non_latin_script,
    })

    totalLineItems += bill.line_items.length
    allExceptionsRaised.push(...billExceptions)
  }

  if (finalizeDocument) {
    await finalizeSourceDocumentExtraction(admin, {
      sourceDocumentId,
      doc,
      classifiedPageCount: extraction.pages.length,
      currentRunId,
    })
  }

  return {
    sourceDocumentId,
    documentExtractionIds,
    billCount: extraction.bills.length,
    runIds,
    currentRunId,
    modelUsed: final.model,
    escalated: pipeline.escalated,
    escalatedBecause: pipeline.escalated
      ? escalationReason(pipeline.attempts[0]!.extraction)
      : null,
    totalCostUsd: pipeline.totalCostUsd,
    lineItemCount: totalLineItems,
    pageCount: extraction.pages.length,
    exceptionsRaised: allExceptionsRaised,
  }
}

export interface FinalizeSourceDocumentExtractionParams {
  sourceDocumentId: number
  doc: SourceDocumentForExtraction
  /**
   * How many pages actually got a classification verdict. For the old
   * single-call shape this is `extraction.pages.length` from that one
   * response; for per-page extraction (extractAndPersist below) it's the
   * count of pages that were successfully classified across the whole loop —
   * a page whose own Claude call failed contributes 0 here, which is exactly
   * what should make it show up as a mismatch below.
   */
  classifiedPageCount: number
  /** Attributed to whichever run is "current" when this is called — the last one, for both callers. */
  currentRunId: number
}

/**
 * The whole-document completion step, pulled out of
 * `persistExtractionPipelineResult` so it can be called exactly once per
 * document regardless of how many Claude calls that document took —
 * `persistExtractionPipelineResult` itself now runs once per PAGE under
 * per-page extraction (see `PersistExtractionPipelineResultParams.finalizeDocument`'s
 * doc comment for why calling this once per page instead of once per document
 * would corrupt `page_count` and spam false `page_count_mismatch` rows).
 */
export async function finalizeSourceDocumentExtraction(
  admin: AdminClient,
  params: FinalizeSourceDocumentExtractionParams
): Promise<void> {
  const { sourceDocumentId, doc, classifiedPageCount, currentRunId } = params

  await admin
    .from('source_document')
    .update({
      upload_status: 'processed',
      page_count: doc.pageCount ?? classifiedPageCount,
    })
    .eq('id', sourceDocumentId)

  // I14: the ingest-time page count (ground truth once known — it comes from
  // a server-side PDF parse, not the model) silently wins over
  // classifiedPageCount above. When they disagree, pages that were never
  // classified (never in pages[], or a page whose own call failed under
  // per-page extraction) keep a null classification with no warning — flag
  // it so a human notices instead of assuming every page was handled.
  const ingestPageCount = doc.pageCount
  if (ingestPageCount !== null && ingestPageCount !== classifiedPageCount) {
    await admin.from('reconciliation_exception').upsert(
      {
        exception_type: 'page_count_mismatch',
        severity: 'low',
        description:
          `source_document ${sourceDocumentId} has ${ingestPageCount} page(s) at ingest, but only ` +
          `${classifiedPageCount} were classified by extraction run ${currentRunId}. The unclassified ` +
          'page(s) have no is_financial_document verdict and were not considered for line items — ' +
          'confirm nothing was skipped.',
        dedup_key: `page_count_mismatch:${sourceDocumentId}:${currentRunId}`,
      },
      { onConflict: 'dedup_key' }
    )
  }
}

/**
 * How many pages' Claude calls run at once for one document.
 *
 * The two phases of per-page extraction are deliberately split: EXTRACTION
 * (the Claude calls) runs concurrently, capped at this number; PERSISTENCE
 * (the database writes) runs strictly afterward, sequentially, in page order
 * — see `persistPagesInOrder` below for why that second phase cannot be
 * concurrent (bill_index numbering has to stay deterministic).
 *
 * The cap exists for two reasons, not one: it bounds how many requests this
 * process sends to Anthropic at once (a burst of concurrent calls risks a 429
 * from Anthropic's own rate limits, which costs more time to recover from
 * than sequencing would have saved), and it bounds wall-clock time on a route
 * with a hard `maxDuration` — a 20-page document at 4 pages/batch is 5
 * sequential batches of ~10-15s each (roughly a minute) rather than 20 pages
 * fully sequential (several minutes, guaranteed to exceed every route's
 * timeout). Tune this against Anthropic's actual per-minute rate limit for
 * the account in use if extraction starts hitting 429s in practice.
 */
const PAGE_EXTRACTION_CONCURRENCY = 4

/** One page's outcome from the concurrent extraction phase. */
type PageExtractionOutcome =
  | { pageNumber: number; status: 'ok'; pipeline: ExtractionPipelineResult }
  | { pageNumber: number; status: 'error'; error: unknown }

/**
 * Splits `pdfBytes` into `totalPages` single-page PDFs and runs the extraction
 * pipeline (`runExtractionPipeline`, lib/extraction.ts — unchanged; it has
 * always been page-count-agnostic, since a "document" was always just
 * whatever bytes it was handed) on each one, `PAGE_EXTRACTION_CONCURRENCY` at
 * a time. One page's failure — a split error, a timeout, an API error — is
 * caught right here and reported as that page's own outcome rather than
 * thrown, so it can never abort the pages around it; the caller
 * (`persistPagesInOrder`) is what turns a failed outcome into a
 * `page_extraction_failed` exception instead of silently losing the page.
 *
 * Returns outcomes in page order regardless of which page's call happened to
 * finish first — persistence needs that order for deterministic bill_index
 * numbering, so it's guaranteed here rather than left for the caller to sort.
 */
async function extractAllPagesConcurrently(
  pdfBytes: Uint8Array,
  totalPages: number,
  pipelineOptions: { model?: ModelId; runReason: 'initial' | 'manual_reescalation'; allowEscalation: boolean }
): Promise<PageExtractionOutcome[]> {
  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1)
  const outcomes: PageExtractionOutcome[] = []

  for (let i = 0; i < pageNumbers.length; i += PAGE_EXTRACTION_CONCURRENCY) {
    const batch = pageNumbers.slice(i, i + PAGE_EXTRACTION_CONCURRENCY)
    const batchOutcomes = await Promise.all(
      batch.map(async (pageNumber): Promise<PageExtractionOutcome> => {
        try {
          const pageBytes = await splitPdfPage(pdfBytes, pageNumber)
          const raw = await runExtractionPipeline(pageBytes, pipelineOptions)
          // The model saw a standalone one-page PDF and reports page_number
          // as 1 accordingly, on every attempt — remapExtractionToActualPage's
          // doc comment (lib/extraction-schema.ts) has the full story. Every
          // attempt is remapped, not just the final one, so nothing downstream
          // that ever inspects an individual attempt's own extraction sees the
          // wrong page number either.
          const attempts = raw.attempts.map((attempt) => ({
            ...attempt,
            extraction: remapExtractionToActualPage(attempt.extraction, pageNumber),
          }))
          const pipeline: ExtractionPipelineResult = {
            attempts,
            final: attempts[attempts.length - 1]!,
            escalated: raw.escalated,
            totalCostUsd: raw.totalCostUsd,
          }
          return { pageNumber, status: 'ok', pipeline }
        } catch (error) {
          return { pageNumber, status: 'error', error }
        }
      })
    )
    outcomes.push(...batchOutcomes)
  }

  return outcomes
}

/**
 * Records one page's failed extraction attempt without touching
 * `source_document.upload_status` — the whole-document `recordExtractionFailure`
 * above would mark the ENTIRE document failed, which is wrong here: the other
 * pages in this same loop may well have succeeded. This is the per-page
 * equivalent, scoped to a single page: an `ocr_extraction_run` row so the
 * failed attempt isn't silently absent from the audit trail (§8 point 7,
 * "prior runs never deleted" — a failed attempt is still an attempt), and a
 * `page_extraction_failed` reconciliation_exception a reviewer will actually
 * see, naming the page and the reason. No automatic retry is built for this —
 * re-running extraction on the whole document (the existing "Re-extract with
 * Sonnet" button, or simply re-uploading) will attempt the failed page again
 * along with every other page, since bill_index restarts at 0 each run.
 */
async function recordPageExtractionFailure(
  admin: AdminClient,
  sourceDocumentId: number,
  pageNumber: number,
  model: ModelId,
  runReason: ExtractAndPersistOptions['runReason'],
  triggeredBy: string | null,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  // Both writes check `.error` explicitly and throw rather than continue
  // silently — Supabase's client returns failures as data (`{ error }`), it
  // does not throw, so skipping this check is how a failure here goes
  // completely unnoticed (this is written the way it is because that
  // happened once already while building this: the `page_extraction_failed`
  // insert was silently rejected by a check constraint that hadn't been
  // migrated yet, and nothing surfaced it until the database was queried by
  // hand). This function exists specifically to make a failure visible; it
  // must not itself have a way to fail invisibly.
  const { error: runError } = await admin.from('ocr_extraction_run').insert({
    source_document_id: sourceDocumentId,
    model,
    run_reason: runReason,
    triggered_by: triggeredBy,
    status: 'failed',
    error_message: message.slice(0, 2000),
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  })
  if (runError) {
    throw new Error(`recordPageExtractionFailure: ocr_extraction_run insert failed: ${runError.message}`)
  }

  const { error: exceptionError } = await admin.from('reconciliation_exception').upsert(
    {
      exception_type: 'page_extraction_failed',
      severity: 'medium',
      description:
        `Page ${pageNumber} of source_document ${sourceDocumentId} failed to extract: ` +
        `${message.slice(0, 500)}. The rest of the document was processed independently and is not ` +
        'affected. Re-running extraction on this document will retry every page, including this one.',
      dedup_key: `page_extraction_failed:${sourceDocumentId}:${pageNumber}`,
    },
    { onConflict: 'dedup_key' }
  )
  if (exceptionError) {
    throw new Error(
      `recordPageExtractionFailure: reconciliation_exception upsert failed: ${exceptionError.message}`
    )
  }
}

/**
 * A run of pages, as decided from phase 1's own per-page classification —
 * `continues_previous_bill` (extraction-schema.ts) chains adjacent financial
 * pages into one group when a later page has no header of its own. Not yet
 * re-extracted: a `merged` group still holds each page's independent phase-1
 * pipeline until `resolveGroups` below re-runs it as one call.
 */
type PendingGroup =
  | { kind: 'single'; outcome: Extract<PageExtractionOutcome, { status: 'ok' }> }
  | { kind: 'merged'; outcomes: Extract<PageExtractionOutcome, { status: 'ok' }>[] }
  | { kind: 'failed'; outcome: Extract<PageExtractionOutcome, { status: 'error' }> }

/**
 * Chains phase 1's per-page outcomes into bill-scoped groups using each
 * page's own `continues_previous_bill` verdict (extraction-schema.ts's doc
 * comment on that field has the full reasoning). Outcomes are already in
 * page order (`extractAllPagesConcurrently`'s guarantee), so a run of
 * continuation pages is always the contiguous page range it needs to be for
 * `extractPageRange` (lib/pdf.ts) to merge back into one PDF.
 *
 * A failed page always breaks a run — its own extraction never happened, so
 * there is no classification to chain from or into. A non-financial page
 * never chains either: `continues_previous_bill` is only meaningful for a
 * page that itself is part of a bill.
 */
function groupPageOutcomes(outcomes: PageExtractionOutcome[]): PendingGroup[] {
  const groups: PendingGroup[] = []
  let current: Extract<PageExtractionOutcome, { status: 'ok' }>[] = []

  const flush = () => {
    if (current.length === 0) return
    groups.push(current.length === 1 ? { kind: 'single', outcome: current[0]! } : { kind: 'merged', outcomes: current })
    current = []
  }

  for (const outcome of outcomes) {
    if (outcome.status === 'error') {
      flush()
      groups.push({ kind: 'failed', outcome })
      continue
    }

    const page = outcome.pipeline.final.extraction.pages[0]
    const chainsToPrevious =
      current.length > 0 && (page?.is_financial_document ?? false) && (page?.continues_previous_bill ?? false)

    if (chainsToPrevious) {
      current.push(outcome)
    } else {
      flush()
      current.push(outcome)
    }
  }
  flush()

  return groups
}

/** One group after phase 2 — always has a single `ExtractionPipelineResult` ready to persist, or a failure to record. */
type ResolvedGroup =
  | { kind: 'ok'; pageCount: number; pipeline: ExtractionPipelineResult }
  | { kind: 'failed'; pageNumber: number; error: unknown }

/**
 * Turns `PendingGroup[]` into `ResolvedGroup[]`: a `single` or `failed` group
 * passes through untouched (phase 1 already has everything needed for it), a
 * `merged` group gets re-extracted from scratch as one call over its whole
 * page range — restoring the header context per-page splitting threw away,
 * which is the entire point of this second pass (lib/pdf.ts's header
 * comment, extraction-schema.ts's `continues_previous_bill` doc comment).
 *
 * Sequential rather than concurrent: merged groups are rare (the overwhelming
 * majority of bills are one page — same reasoning as PAGE_EXTRACTION_CONCURRENCY's
 * doc comment), so there is little wall-clock time to save, and it keeps this
 * pass simple.
 */
async function resolveGroups(
  pdfBytes: Uint8Array,
  groups: PendingGroup[],
  pipelineOptions: { model?: ModelId; runReason: ExtractAndPersistOptions['runReason']; allowEscalation: boolean }
): Promise<ResolvedGroup[]> {
  const resolved: ResolvedGroup[] = []

  for (const group of groups) {
    if (group.kind === 'failed') {
      resolved.push({ kind: 'failed', pageNumber: group.outcome.pageNumber, error: group.outcome.error })
      continue
    }
    if (group.kind === 'single') {
      resolved.push({ kind: 'ok', pageCount: 1, pipeline: group.outcome.pipeline })
      continue
    }

    const startPage = group.outcomes[0]!.pageNumber
    const endPage = group.outcomes[group.outcomes.length - 1]!.pageNumber

    try {
      const rangeBytes = await extractPageRange(pdfBytes, startPage, endPage)
      const raw = await runExtractionPipeline(rangeBytes, pipelineOptions)
      const offset = startPage - 1

      // Phase 1 already classified every page in this range on its own
      // merits — that verdict is what grouped them together in the first
      // place, so it stays authoritative rather than whatever this merged
      // call's own pages[] reports for the same pages (already remapped to
      // real page numbers by extractAllPagesConcurrently).
      const phase1Pages: ExtractionPage[] = group.outcomes.map((o) => o.pipeline.final.extraction.pages[0]!)

      const attempts = raw.attempts.map((attempt) => ({
        ...attempt,
        extraction: {
          ...remapExtractionPageNumbers(attempt.extraction, (n) => n + offset),
          pages: phase1Pages,
        },
      }))
      const pipeline: ExtractionPipelineResult = {
        attempts,
        final: attempts[attempts.length - 1]!,
        escalated: raw.escalated,
        totalCostUsd: raw.totalCostUsd,
      }
      resolved.push({ kind: 'ok', pageCount: group.outcomes.length, pipeline })
    } catch (error) {
      // The merged re-extraction failed outright (timeout, API error) — every
      // page in the range fails together rather than silently falling back to
      // phase 1's own incomplete per-page reads, which is exactly the
      // broken-header/duplicate-bill outcome this whole pass exists to avoid.
      for (const outcome of group.outcomes) {
        resolved.push({ kind: 'failed', pageNumber: outcome.pageNumber, error })
      }
    }
  }

  return resolved
}

/**
 * Persists every group's outcome, strictly in page order — the final,
 * sequential phase (see `PAGE_EXTRACTION_CONCURRENCY`'s doc comment for why
 * the phase-1 extraction runs concurrently but this one does not).
 *
 * Sequential is not a performance compromise here, it is a correctness
 * requirement: `document_extraction.bill_index` has to be assigned without
 * collisions across however many bills each group turned out to have, and
 * `persistExtractionPipelineResult`'s upsert is keyed on
 * `(source_document_id, bill_index)` — two groups persisted concurrently
 * could both read the same "next" index and the second writer would silently
 * overwrite the first's row instead of erroring. Database writes are fast
 * relative to a Claude call, so doing this part sequentially costs very
 * little wall-clock time in exchange for that guarantee.
 *
 * A page classified as non-financial (`is_financial_document: false` — a
 * cheque photo, a permission letter, blank paper) is not special-cased here
 * at all: it arrives as its own `single` group, `persistExtractionPipelineResult`
 * writes its `document_page` classification row regardless of whether any
 * bills came with it, and an empty `bills[]` array simply means the loop
 * inside it does zero `document_extraction` inserts.
 */
async function persistGroupsInOrder(
  admin: AdminClient,
  params: {
    sourceDocumentId: number
    doc: SourceDocumentForExtraction
    totalPages: number
    groups: ResolvedGroup[]
    model: ModelId
    runReason: ExtractAndPersistOptions['runReason']
    triggeredBy: string | null
  }
): Promise<ExtractAndPersistResult> {
  const { sourceDocumentId, doc, totalPages, groups, model, runReason, triggeredBy } = params

  let nextBillIndex = 0
  let classifiedPageCount = 0
  let lastRunId: number | null = null
  const documentExtractionIds: number[] = []
  const runIds: number[] = []
  const exceptionsRaised: string[] = []
  let billCount = 0
  let lineItemCount = 0
  let totalCostUsd = 0
  let escalated = false
  let escalatedBecause: string | null = null
  let modelUsed: ModelId = model

  for (const group of groups) {
    if (group.kind === 'failed') {
      await recordPageExtractionFailure(admin, sourceDocumentId, group.pageNumber, model, runReason, triggeredBy, group.error)
      continue
    }

    const groupResult = await persistExtractionPipelineResult(admin, {
      sourceDocumentId,
      doc,
      pipeline: group.pipeline,
      triggeredBy,
      billIndexOffset: nextBillIndex,
      finalizeDocument: false,
    })

    nextBillIndex += groupResult.billCount
    classifiedPageCount += group.pageCount
    lastRunId = groupResult.currentRunId
    documentExtractionIds.push(...groupResult.documentExtractionIds)
    runIds.push(...groupResult.runIds)
    exceptionsRaised.push(...groupResult.exceptionsRaised)
    billCount += groupResult.billCount
    lineItemCount += groupResult.lineItemCount
    totalCostUsd += groupResult.totalCostUsd
    if (groupResult.escalated) {
      escalated = true
      escalatedBecause ??= groupResult.escalatedBecause
      modelUsed = groupResult.modelUsed
    }
  }

  // Every single page failed — this is a whole-document failure, not a
  // partial one. Thrown so extractAndPersist's own catch records it as such
  // (recordExtractionFailure, marking upload_status 'failed') instead of
  // silently "succeeding" with zero bills and upload_status 'processed'.
  if (lastRunId === null) {
    const firstFailure = groups.find((g): g is Extract<ResolvedGroup, { kind: 'failed' }> => g.kind === 'failed')
    const reason = firstFailure ? String((firstFailure.error as Error)?.message ?? firstFailure.error) : 'unknown'
    throw new Error(
      `extractAndPersist: every page of source_document ${sourceDocumentId} failed (first failure: ${reason})`
    )
  }

  await finalizeSourceDocumentExtraction(admin, {
    sourceDocumentId,
    doc,
    classifiedPageCount,
    currentRunId: lastRunId,
  })

  return {
    sourceDocumentId,
    documentExtractionIds,
    billCount,
    runIds,
    currentRunId: lastRunId,
    modelUsed,
    escalated,
    escalatedBecause,
    totalCostUsd,
    lineItemCount,
    pageCount: totalPages,
    exceptionsRaised,
  }
}

/**
 * Runs the pipeline for one `source_document` and writes every row it
 * implies. Exported separately from the job handler so the manual
 * re-escalation route (§8 point 7) reuses exactly this path instead of a
 * parallel copy of it.
 *
 * One Claude call per PAGE as the first pass, not one call per document —
 * see lib/pdf.ts's `splitPdfPage` and this file's header comment. The
 * original design sent every page of a document in a single request;
 * splitting fixes three things that design ran into on real multi-page
 * scans: a dense document truncating the tool call (and, worse, being
 * re-sent whole a second time to retry it); one bad page losing the entire
 * document instead of just that page; and the model occasionally reading a
 * page's vendor/amount off a DIFFERENT page's summary table because it could
 * see the whole document at once. Splitting means each page's own call can
 * only read what's actually printed on that page.
 *
 * That first pass alone broke a fourth case, though: a bill whose line items
 * continue onto a following page. A lone split-out continuation page has no
 * header to read at all, so it either got misread as its own phantom bill or
 * silently lost from the bill it belonged to. `groupPageOutcomes` +
 * `resolveGroups` below are the second pass that fixes this: they chain
 * continuation pages (via each page's own `continues_previous_bill`
 * verdict — extraction-schema.ts) back into the contiguous range they came
 * from and re-extract exactly that range as one call, restoring full context
 * for the one bill that needs it while every single-page bill (the large
 * majority) never pays for a second call at all.
 *
 * Always synchronous, regardless of `OCR_USE_BATCH_API` (lib/env.server.ts) —
 * that flag only changes what `handleExtractDocument` does for the
 * queue-driven *initial* extraction (see its branch below); this function is
 * also the manual re-escalation route's only path, and a reviewer pressing
 * "Re-extract with Sonnet" wants an answer in seconds, not up to 24h.
 */
export async function extractAndPersist(
  options: ExtractAndPersistOptions
): Promise<ExtractAndPersistResult> {
  const { sourceDocumentId, runReason } = options
  const admin = createAdminClient()
  const doc = await fetchSourceDocumentForExtraction(admin, sourceDocumentId)

  await admin
    .from('source_document')
    .update({ upload_status: 'processing' })
    .eq('id', sourceDocumentId)

  try {
    const pdfBytes = await downloadDocumentPdf(doc.storagePath)

    // Prefer the ingest-time page count (a real server-side PDF parse) but
    // fall back to parsing these same bytes here when it's null. This is
    // deliberately a second, independent attempt at the same parse ingest
    // already tried — cheap insurance if that first attempt failed for an
    // environment-specific reason (app/api/documents/ingest/route.ts logs
    // that failure now instead of swallowing it, precisely so a pattern here
    // becomes diagnosable rather than a silent permanent gap).
    const totalPages = doc.pageCount ?? (await getPdfPageCount(pdfBytes))

    const model = options.model ?? MODELS.haiku
    const pipelineOptions = {
      model: options.model,
      runReason,
      allowEscalation: model === MODELS.haiku,
    }
    const outcomes = await extractAllPagesConcurrently(pdfBytes, totalPages, pipelineOptions)
    const pendingGroups = groupPageOutcomes(outcomes)
    const resolvedGroups = await resolveGroups(pdfBytes, pendingGroups, pipelineOptions)

    return await persistGroupsInOrder(admin, {
      sourceDocumentId,
      doc,
      totalPages,
      groups: resolvedGroups,
      model,
      runReason,
      triggeredBy: options.triggeredBy ?? null,
    })
  } catch (err) {
    await recordExtractionFailure(
      admin,
      sourceDocumentId,
      options.model ?? MODELS.haiku,
      runReason,
      options.triggeredBy ?? null,
      err
    )
    throw err
  }
}

/**
 * Batch API submission (plan.md Phase 3 I16). Called only from
 * `handleExtractDocument`'s `OCR_USE_BATCH_API` branch below — never from
 * `extractAndPersist`, so the manual re-escalation route and test/score.ts's
 * accuracy harness always stay on the synchronous path regardless of this
 * flag.
 *
 * Design decision — one Anthropic batch per document (a "batch" of exactly
 * one request), not a pooled multi-document batch: Anthropic's 50% discount
 * applies per request regardless of how many requests share a batch, so this
 * gets I16's actual goal (halving per-page cost) without inventing a
 * document-pooling window on top of a job queue that was built to process
 * one document per job. A future iteration could pool several queued
 * `extract_document` jobs into one multi-request batch for fewer round trips
 * to the Batches API, at the cost of a batching-window scheduler this pass
 * deliberately does not build.
 *
 * Design decision — no auto-escalation in the batch path (v1): the sync
 * pipeline's escalation (lib/extraction.ts, gated by `OCR_AUTO_ESCALATION`,
 * itself off by default per Phase 1) re-runs the whole document on Sonnet
 * in-process when Haiku comes back low-confidence. Doing the same thing here
 * would mean chaining a second batch submission plus a second `poll_batch`
 * job after this one completes — untestable end-to-end in this environment
 * (no live API key) and it would roughly double the worst-case latency (up
 * to 48h) for the minority of documents that need it. Instead, a
 * low-confidence batch result is persisted as-is — the existing `'other'`
 * tally-check exception in `runTallyChecks` already flags it for a human —
 * and a reviewer can press "Re-extract with Sonnet", which is unaffected by
 * this flag and answers in seconds. If `OCR_AUTO_ESCALATION` and
 * `OCR_USE_BATCH_API` are both on, this is the one combination where
 * behavior genuinely diverges from the sync path; treat that combination as
 * unverified until a human exercises it against a live batch.
 */
async function submitExtractionBatchAndEnqueuePoll(sourceDocumentId: number): Promise<void> {
  const admin = createAdminClient()
  const doc = await fetchSourceDocumentForExtraction(admin, sourceDocumentId)

  await admin
    .from('source_document')
    .update({ upload_status: 'processing' })
    .eq('id', sourceDocumentId)

  const pdfBytes = await downloadDocumentPdf(doc.storagePath)
  // Batch submission always starts on Haiku, same as the sync path's first
  // attempt (§8 point 3) — there is no batch-path equivalent of the manual
  // "Re-extract with Sonnet" button (that stays on extractAndPersist).
  const model = MODELS.haiku
  const maxTokens = EXTRACTION_MAX_TOKENS

  const batch = await submitExtractionBatch([
    {
      customId: buildExtractionBatchCustomId(sourceDocumentId),
      documentPdf: { data: toBase64(pdfBytes) },
      model,
      maxTokens,
    },
  ])

  const pollPayload: PollBatchPayload = {
    batch_id: batch.batchId,
    source_document_id: sourceDocumentId,
    model,
    max_tokens: maxTokens,
  }

  const { error } = await admin.from('job_queue').insert({
    job_type: 'poll_batch',
    payload: pollPayload,
    // First poll shortly after submission -- a single small request often
    // finishes well under a minute; nextPollBackoffMs (lib/jobs/queue.ts)
    // takes over from the second poll onward, keyed off the poll_batch job's
    // own `attempts`.
    run_after: new Date(Date.now() + POLL_BACKOFF_BASE_MS).toISOString(),
  })
  if (error) {
    throw new Error(
      `poll_batch job_queue insert failed for source_document ${sourceDocumentId} (batch ${batch.batchId}): ${error.message}`
    )
  }
}

export async function insertRun(
  admin: AdminClient,
  sourceDocumentId: number,
  attempt: ExtractionAttempt,
  triggeredBy: string | null
): Promise<number> {
  const { data, error } = await admin
    .from('ocr_extraction_run')
    .insert({
      source_document_id: sourceDocumentId,
      model: attempt.model,
      run_reason: attempt.runReason,
      triggered_by: triggeredBy,
      status: 'succeeded',
      raw_response_jsonb: attempt.rawResponse,
      legibility: attempt.extraction.legibility,
      extraction_confidence: attempt.extraction.extraction_confidence,
      contains_non_latin_script: attempt.extraction.contains_non_latin_script,
      input_tokens: attempt.usage.inputTokens,
      output_tokens: attempt.usage.outputTokens,
      cost_usd: attempt.costUsd,
      started_at: attempt.startedAt,
      completed_at: attempt.completedAt,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`ocr_extraction_run insert failed: ${error?.message ?? 'no row returned'}`)
  }
  return data.id as number
}

interface TallyCheckInput {
  documentExtractionId: number
  currentRunId: number
  entryId: number | null
  totalAmount: number | null
  subtotal: number | null
  taxAmount: number | null
  lineTotal: number | null
  legibility: 'clear' | 'partial' | 'poor'
  containsNonLatinScript: boolean
}

/**
 * §8 point 5 / §9.4. Three checks, each writing a `reconciliation_exception`
 * row rather than throwing — a mismatch is a thing a human resolves, not a
 * pipeline failure.
 */
async function runTallyChecks(admin: AdminClient, input: TallyCheckInput): Promise<string[]> {
  const raised: string[] = []
  const exceptions: Array<Record<string, unknown>> = []

  // 1. Line-item sum vs the figure the lines are actually supposed to add up
  // to. On a GST invoice that is the SUBTOTAL, not the total — comparing the
  // lines against a tax-inclusive total would flag every taxed invoice in the
  // set, which would make the exception queue worthless. Where no subtotal was
  // extracted, the total is the only thing to compare against, which is §8
  // point 5's literal reading.
  const linesShouldSumTo = input.subtotal ?? input.totalAmount
  const comparandLabel = input.subtotal !== null ? 'subtotal' : 'total'
  if (linesShouldSumTo !== null && input.lineTotal !== null) {
    if (!tallyWithinTolerance(input.lineTotal, linesShouldSumTo)) {
      raised.push('line_item_tally_mismatch')
      exceptions.push({
        document_extraction_id: input.documentExtractionId,
        exception_type: 'line_item_tally_mismatch',
        severity: 'high',
        amount_at_risk: Math.abs(input.lineTotal - linesShouldSumTo),
        description:
          `Line items sum to ${input.lineTotal.toFixed(2)} but the extracted ${comparandLabel} is ` +
          `${linesShouldSumTo.toFixed(2)} (difference ${Math.abs(input.lineTotal - linesShouldSumTo).toFixed(2)}).`,
        dedup_key: `line_item_tally_mismatch:${input.documentExtractionId}:${input.currentRunId}`,
      })
    }
  }

  // 1b. subtotal + tax vs total — the other half of the same arithmetic, and
  // the check that actually catches a misread tax or grand total.
  if (input.subtotal !== null && input.totalAmount !== null) {
    const expected = input.subtotal + (input.taxAmount ?? 0)
    if (!tallyWithinTolerance(expected, input.totalAmount)) {
      raised.push('line_item_tally_mismatch')
      exceptions.push({
        document_extraction_id: input.documentExtractionId,
        exception_type: 'line_item_tally_mismatch',
        severity: 'high',
        amount_at_risk: Math.abs(expected - input.totalAmount),
        description:
          `Subtotal ${input.subtotal.toFixed(2)} plus tax ${(input.taxAmount ?? 0).toFixed(2)} is ` +
          `${expected.toFixed(2)}, but the extracted total is ${input.totalAmount.toFixed(2)} ` +
          `(difference ${Math.abs(expected - input.totalAmount).toFixed(2)}).`,
        dedup_key: `subtotal_plus_tax_vs_total:${input.documentExtractionId}:${input.currentRunId}`,
      })
    }
  }

  // 2. total_amount_ocr vs entries.amount, when the document is matched
  if (input.entryId !== null && input.totalAmount !== null) {
    const { data: entry } = await admin
      .from('entries')
      .select('id, amount')
      .eq('id', input.entryId)
      .single()
    const entryAmount = entry?.amount === null || entry?.amount === undefined ? null : Number(entry.amount)
    if (entryAmount !== null && !tallyWithinTolerance(input.totalAmount, entryAmount)) {
      raised.push('ocr_total_vs_amount')
      exceptions.push({
        entry_id: input.entryId,
        document_extraction_id: input.documentExtractionId,
        exception_type: 'ocr_total_vs_amount',
        severity: 'high',
        amount_at_risk: Math.abs(input.totalAmount - entryAmount),
        description:
          `Extracted document total ${input.totalAmount.toFixed(2)} does not match entry ` +
          `${input.entryId} amount ${entryAmount.toFixed(2)}.`,
        dedup_key: `ocr_total_vs_amount:${input.documentExtractionId}:${input.currentRunId}`,
      })
    }
  }

  // 3. legibility / script flag — "alerting staff to potential re-run" (§8 point 5)
  const legibilityPoor = input.legibility === 'partial' || input.legibility === 'poor'
  if (legibilityPoor || input.containsNonLatinScript) {
    const reasons = [
      legibilityPoor ? `legibility is '${input.legibility}'` : null,
      input.containsNonLatinScript ? 'non-Latin (Gujarati/Devanagari) script present' : null,
    ].filter((r): r is string => r !== null)
    raised.push('other')
    exceptions.push({
      document_extraction_id: input.documentExtractionId,
      exception_type: 'other',
      severity: 'low',
      description:
        `Extraction quality warning: ${reasons.join(' and ')}. ` +
        'Consider a manual re-escalation to Sonnet before verifying (§8 points 5-7).',
      dedup_key: `extraction_quality:${input.documentExtractionId}:${input.currentRunId}`,
    })
  }

  for (const row of exceptions) {
    // Ignore duplicate-key collisions on dedup_key: the same warning for the
    // same run is the same warning.
    await admin.from('reconciliation_exception').upsert(row, { onConflict: 'dedup_key' })
  }

  return raised
}

/**
 * The JobHandler contract from worker/index.ts: take the claimed row, do the
 * work, and mark the job succeeded/failed against the queue.
 */
export async function handleExtractDocument(job: JobQueueRow): Promise<void> {
  const payload = job.payload as Partial<ExtractDocumentPayload>
  const sourceDocumentId = Number(payload?.source_document_id)

  if (!Number.isInteger(sourceDocumentId) || sourceDocumentId <= 0) {
    await failJob(job.id, `extract_document payload missing a valid source_document_id`)
    return
  }

  try {
    if (serverEnv.OCR_USE_BATCH_API) {
      // Phase 3 I16 (plan.md §4): opt-in Batch API path. Reuses the
      // extract_document job_type and poll_batch's existing dispatch wiring
      // (worker/index.ts, app/api/jobs/tick/route.ts) rather than adding a
      // new job_type -- see submitExtractionBatchAndEnqueuePoll's doc
      // comment above for the full design reasoning. extractAndPersist
      // itself is completely untouched by this branch, so
      // OCR_USE_BATCH_API=false (the default) reproduces today's behavior
      // exactly; only the queue-driven initial-extraction path (this
      // function) checks the flag. This job's own work ends at submission —
      // the poll_batch job just enqueued owns finishing the document
      // (lib/jobs/handlers/batch-poll.ts).
      await submitExtractionBatchAndEnqueuePoll(sourceDocumentId)
      console.log(`[extract] document ${sourceDocumentId}: submitted to Batch API, poll_batch job enqueued`)
      await completeJob(job.id)
      return
    }

    const result = await extractAndPersist({ sourceDocumentId, runReason: 'initial' })
    console.log(
      `[extract] document ${result.sourceDocumentId}: model=${result.modelUsed} bills=${result.billCount} ` +
        `escalated=${result.escalated}${result.escalatedBecause ? ` (${result.escalatedBecause})` : ''} ` +
        `lines=${result.lineItemCount} cost=$${result.totalCostUsd.toFixed(6)} ` +
        `exceptions=[${result.exceptionsRaised.join(',')}]`
    )
    await completeJob(job.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[extract] job ${job.id} failed:`, message)
    await failJob(job.id, message.slice(0, 2000))
  }
}

export default handleExtractDocument
