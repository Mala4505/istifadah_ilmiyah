/**
 * `extract_document` job handler (MASTER-PLAN §3.11, §8, §9.4).
 *
 * Claimed by either caller of the one worker loop (§3.11) —
 * app/api/jobs/tick/route.ts on Vercel, worker/index.ts as a Windows service —
 * and, per the JobHandler contract documented in worker/index.ts, this module
 * owns its own completion bookkeeping.
 *
 * What it does, in §8 order:
 *   3. one Claude call per document, Haiku first, all pages in that one call
 *      (classification-before-extraction is enforced in code by
 *      `filterNonFinancialLineItems`, not by asking the model nicely)
 *      → escalates to Sonnet on low confidence or non-Latin script
 *   4. writes `_ocr` columns only — `_verified` is the Day 4 review queue's
 *      job and is never touched here
 *   5. tally checks on write, raising `reconciliation_exception` rows
 */

import 'server-only'
import { completeJob, failJob, type JobQueueRow } from '@/lib/jobs/queue'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSignedUrl } from '@/lib/storage'
import { tallyWithinTolerance } from '@/lib/normalize'
import {
  escalationReason,
  lineItemTotal,
  runExtractionPipeline,
  type ExtractionAttempt,
} from '@/lib/extraction'
import { buildTaxBreakdown } from '@/lib/extraction-schema'
import { MODELS, type ModelId } from '@/lib/claude-client'
import { serverEnv } from '@/lib/env.server'
import { isSameGstin } from '@/lib/analytics/gstin'

export interface ExtractDocumentPayload {
  source_document_id: number
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
  documentExtractionId: number
  runIds: number[]
  currentRunId: number
  modelUsed: ModelId
  escalated: boolean
  /** Why the run escalated to Sonnet, or null when it did not (§8 escalation rule). */
  escalatedBecause: string | null
  totalCostUsd: number
  lineItemCount: number
  pageCount: number
  exceptionsRaised: string[]
}

/**
 * Runs the pipeline for one `source_document` and writes every row it implies.
 * Exported separately from the job handler so the manual re-escalation route
 * (§8 point 7) reuses exactly this path instead of a parallel copy of it.
 */
export async function extractAndPersist(
  options: ExtractAndPersistOptions
): Promise<ExtractAndPersistResult> {
  const { sourceDocumentId, runReason } = options
  const admin = createAdminClient()

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

  await admin
    .from('source_document')
    .update({ upload_status: 'processing' })
    .eq('id', sourceDocumentId)

  try {
    // §4.3: the app never handles a raw storage path in the open — it reads
    // through a short-lived signed URL, same as the browser would.
    const signedUrl = await getSignedUrl(doc.storage_path as string, 300)
    const response = await fetch(signedUrl)
    if (!response.ok) {
      throw new Error(`downloading ${doc.storage_path} failed: HTTP ${response.status}`)
    }
    const pdfBytes = new Uint8Array(await response.arrayBuffer())

    const pipeline = await runExtractionPipeline(pdfBytes, {
      model: options.model,
      runReason,
      allowEscalation: (options.model ?? MODELS.haiku) === MODELS.haiku,
    })

    // ---- ocr_extraction_run: one row per attempt, prior runs never deleted (§8 point 7)
    const runIds: number[] = []
    for (const attempt of pipeline.attempts) {
      const runId = await insertRun(admin, sourceDocumentId, attempt, options.triggeredBy ?? null)
      runIds.push(runId)
    }
    const currentRunId = runIds[runIds.length - 1]!
    const final = pipeline.final
    const extraction = final.extraction

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
      serverEnv.COMMUNITY_GSTIN !== '' && isSameGstin(extraction.vendor_gstin, serverEnv.COMMUNITY_GSTIN)

    // ---- document_extraction: _ocr columns only. _verified stays null (§8 point 4).
    const { data: extractionRow, error: extractionError } = await admin
      .from('document_extraction')
      .upsert(
        {
          source_document_id: sourceDocumentId,
          current_extraction_run_id: currentRunId,
          vendor_name_ocr: extraction.vendor_name,
          vendor_gstin_ocr: isOwnOrgGstin ? null : extraction.vendor_gstin,
          vendor_phone_ocr: extraction.vendor_phone,
          vendor_email_ocr: extraction.vendor_email,
          vendor_address_ocr: extraction.vendor_address,
          invoice_number_ocr: extraction.invoice_number,
          invoice_date_ocr: extraction.invoice_date,
          instrument_type_ocr: extraction.instrument_type,
          // Raw text as Claude read it — resolving to a GST state code is
          // done downstream by lib/analytics/fetch.ts (stateCodeFromName),
          // not at write time.
          place_of_supply_ocr: extraction.place_of_supply,
          subtotal_ocr: extraction.subtotal,
          tax_amount_ocr: extraction.tax_amount,
          // See buildTaxBreakdown (lib/extraction-schema.ts) for how the
          // three flat cgst/sgst/igst_amount wire fields become this shape.
          tax_breakdown_ocr: buildTaxBreakdown(extraction),
          round_off_ocr: extraction.round_off,
          total_amount_ocr: extraction.total_amount,
          notes_ocr: extraction.notes,
        },
        { onConflict: 'source_document_id' }
      )
      .select('id')
      .single()

    if (extractionError || !extractionRow) {
      throw new Error(
        `document_extraction upsert failed: ${extractionError?.message ?? 'no row returned'}`
      )
    }
    const documentExtractionId = extractionRow.id as number

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
          dedup_key: `vendor_gstin_is_own_org:${documentExtractionId}:${currentRunId}`,
        },
        { onConflict: 'dedup_key' }
      )
    }

    // Re-extraction replaces this document's line items. Scoped to a single
    // document_extraction_id — never a broad delete.
    const { error: clearError } = await admin
      .from('document_extraction_line_item')
      .delete()
      .eq('document_extraction_id', documentExtractionId)
    if (clearError) throw new Error(`clearing prior line items failed: ${clearError.message}`)

    if (extraction.line_items.length > 0) {
      const itemRows = extraction.line_items.map((item, index) => ({
        document_extraction_id: documentExtractionId,
        document_page_id: pageIdByNumber.get(item.page_number) ?? null,
        line_order: item.line_order ?? index,
        description_ocr: item.description,
        hsn_sac_code_ocr: item.hsn_sac_code,
        quantity_ocr: item.quantity,
        quantity_raw_text_ocr: item.quantity_raw_text,
        unit_ocr: item.unit,
        list_rate_ocr: item.list_rate,
        discount_pct_ocr: item.discount_pct,
        discount_note_ocr: item.discount_note,
        net_rate_ocr: item.net_rate,
        line_amount_ocr: item.line_amount,
      }))
      const { error: itemError } = await admin
        .from('document_extraction_line_item')
        .insert(itemRows)
      if (itemError) throw new Error(`line item insert failed: ${itemError.message}`)
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

    // ---- §8 point 5: tally checks, immediately on write.
    const exceptionsRaised = await runTallyChecks(admin, {
      documentExtractionId,
      currentRunId,
      entryId: (doc.entry_id as number | null) ?? null,
      totalAmount: extraction.total_amount,
      subtotal: extraction.subtotal,
      taxAmount: extraction.tax_amount,
      lineTotal: lineItemTotal(extraction),
      legibility: extraction.legibility,
      containsNonLatinScript: extraction.contains_non_latin_script,
    })

    await admin
      .from('source_document')
      .update({
        upload_status: 'processed',
        page_count: (doc.page_count as number | null) ?? extraction.pages.length,
      })
      .eq('id', sourceDocumentId)

    return {
      sourceDocumentId,
      documentExtractionId,
      runIds,
      currentRunId,
      modelUsed: final.model,
      escalated: pipeline.escalated,
      escalatedBecause: pipeline.escalated
        ? escalationReason(pipeline.attempts[0]!.extraction)
        : null,
      totalCostUsd: pipeline.totalCostUsd,
      lineItemCount: extraction.line_items.length,
      pageCount: extraction.pages.length,
      exceptionsRaised,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await admin
      .from('source_document')
      .update({ upload_status: 'failed' })
      .eq('id', sourceDocumentId)
    await admin.from('ocr_extraction_run').insert({
      source_document_id: sourceDocumentId,
      model: options.model ?? MODELS.haiku,
      run_reason: runReason,
      triggered_by: options.triggeredBy ?? null,
      status: 'failed',
      error_message: message.slice(0, 2000),
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    throw err
  }
}

type AdminClient = ReturnType<typeof createAdminClient>

async function insertRun(
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
    const result = await extractAndPersist({ sourceDocumentId, runReason: 'initial' })
    console.log(
      `[extract] document ${result.sourceDocumentId}: model=${result.modelUsed} ` +
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
