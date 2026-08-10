/**
 * The extraction pipeline core (MASTER-PLAN §8 points 3-4, 7).
 *
 * Deliberately database-free: this is the part that turns PDF bytes into a
 * validated `ExtractionResponse`, including the escalation rule. Three callers
 * share it — the `extract_document` job handler, the manual re-escalation
 * route, and `test/score.ts` — so the accuracy harness measures exactly the
 * path production runs rather than a re-implementation of it.
 */

import 'server-only'
import {
  extractDocument,
  ExtractionTruncatedError,
  MODELS,
  type ModelId,
} from '@/lib/claude-client'
import { toBase64 } from '@/lib/pdf'
import type { ExtractionResponse } from '@/lib/extraction-schema'

/**
 * Below this `extraction_confidence`, a Haiku run is re-run on Sonnet
 * (§8 point 3 + the §8 escalation rule). Deliberately generous: a Sonnet run
 * on a ~2-page invoice costs well under a cent, and a wrong total that reaches
 * a reviewer costs far more.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7

/**
 * Output budget for the retry after a truncated tool call.
 *
 * §8 caps `max_tokens` at 2,000, which is right for the typical one-page bill
 * — but a densely itemised multi-page invoice (sample 020 is one) runs past it
 * and the tool call gets cut off mid-JSON. Rather than lose the document, the
 * pipeline retries that one call with a larger budget. The 2,000 default still
 * governs every document that fits, so the cost intent behind the cap holds.
 */
export const TRUNCATION_RETRY_MAX_TOKENS = 8000

/** One model call and everything the `ocr_extraction_run` row needs (§3.8). */
export interface ExtractionAttempt {
  model: ModelId
  runReason: 'initial' | 'auto_escalation' | 'manual_reescalation'
  extraction: ExtractionResponse
  usage: { inputTokens: number; outputTokens: number }
  costUsd: number
  rawResponse: unknown
  startedAt: string
  completedAt: string
}

export interface ExtractionPipelineResult {
  /** Every call made, in order. The last one is authoritative. */
  attempts: ExtractionAttempt[]
  /** Convenience alias for `attempts[attempts.length - 1]`. */
  final: ExtractionAttempt
  escalated: boolean
  /** Sum of every attempt's cost — what this document actually cost to extract. */
  totalCostUsd: number
}

/**
 * Why a run escalated, or null when it did not. Returned as text so the
 * reason can go straight into an exception row / log line.
 */
export function escalationReason(extraction: ExtractionResponse): string | null {
  if (extraction.contains_non_latin_script) {
    return 'contains_non_latin_script (Gujarati/Devanagari present — §8 point 5)'
  }
  if (extraction.extraction_confidence < LOW_CONFIDENCE_THRESHOLD) {
    return `extraction_confidence ${extraction.extraction_confidence.toFixed(3)} < ${LOW_CONFIDENCE_THRESHOLD}`
  }
  return null
}

export interface RunPipelineOptions {
  /**
   * Model for the first attempt. Defaults to Haiku (§8 point 3: Haiku first,
   * always). The manual re-escalation route passes Sonnet directly.
   */
  model?: ModelId
  /** `run_reason` recorded for the first attempt. */
  runReason?: 'initial' | 'manual_reescalation'
  /**
   * Whether a low-confidence / non-Latin first attempt may auto-escalate to
   * Sonnet. False when the caller already started on Sonnet — there is
   * nothing to escalate to (§8 point 4: "Do not automatically re-escalate").
   */
  allowEscalation?: boolean
}

/**
 * Runs one document through the pipeline: Haiku first, then Sonnet if the
 * §8 escalation rule fires. One call per document, every page in that one
 * call — never one call per page (§8 point 3).
 */
export async function runExtractionPipeline(
  pdfBytes: Uint8Array,
  options: RunPipelineOptions = {}
): Promise<ExtractionPipelineResult> {
  const firstModel = options.model ?? MODELS.haiku
  const firstReason = options.runReason ?? 'initial'
  const allowEscalation = options.allowEscalation ?? firstModel === MODELS.haiku

  const data = toBase64(pdfBytes)
  const attempts: ExtractionAttempt[] = []

  const first = await callOnce(data, firstModel, firstReason)
  attempts.push(first)

  if (allowEscalation && firstModel !== MODELS.sonnet && escalationReason(first.extraction) !== null) {
    attempts.push(await callOnce(data, MODELS.sonnet, 'auto_escalation'))
  }

  const final = attempts[attempts.length - 1]!
  return {
    attempts,
    final,
    escalated: attempts.length > 1,
    totalCostUsd: attempts.reduce((sum, a) => sum + a.costUsd, 0),
  }
}

async function callOnce(
  data: string,
  model: ModelId,
  runReason: ExtractionAttempt['runReason']
): Promise<ExtractionAttempt> {
  const startedAt = new Date().toISOString()

  let result
  try {
    result = await extractDocument({ documentPdf: { data }, model })
  } catch (err) {
    if (!(err instanceof ExtractionTruncatedError)) throw err
    // The document simply has more line items than §8's 2,000-token cap fits.
    // Same model, same prompt, bigger budget — not an escalation, so it does
    // not become a second ocr_extraction_run row.
    result = await extractDocument({
      documentPdf: { data },
      model,
      maxTokens: TRUNCATION_RETRY_MAX_TOKENS,
    })
  }

  return {
    model,
    runReason,
    extraction: result.extraction,
    usage: result.usage,
    costUsd: result.costUsd,
    rawResponse: result.rawResponse,
    startedAt,
    completedAt: new Date().toISOString(),
  }
}

/**
 * Sum of the line items Claude returned, in rupees. Non-financial pages are
 * already hard-filtered upstream by `filterNonFinancialLineItems`, so this is
 * the number the §8 point 5 tally check compares against `total_amount`.
 * Returns null when no line item carried an amount at all — a document with
 * no extractable lines is not a tally mismatch, it is just a document with no
 * lines (cheque pages, §11.2 Day 2 exit criteria).
 */
export function lineItemTotal(extraction: ExtractionResponse): number | null {
  const amounts = extraction.line_items
    .map((item) => item.line_amount)
    .filter((amount): amount is number => amount !== null)
  if (amounts.length === 0) return null
  return amounts.reduce((sum, amount) => sum + amount, 0)
}
