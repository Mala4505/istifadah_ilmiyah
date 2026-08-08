/**
 * Thin wrapper around the Anthropic SDK for the OCR extraction call
 * (MASTER-PLAN §8, §6.1, §6.4).
 *
 * The Anthropic client is constructed lazily, inside `extractDocument`,
 * never at module load — importing this file must never throw, even when
 * `hasAnthropicKey` is false (e.g. local dev before a real key is set, or
 * any code path that merely wants `MODELS`/`estimateCostUsd`).
 */

import Anthropic from '@anthropic-ai/sdk'
import { hasAnthropicKey, serverEnv } from '@/lib/env.server'
import {
  buildExtractionTool,
  EXTRACTION_TOOL_NAME,
  extractionResponseSchema,
  filterNonFinancialLineItems,
  type ExtractionResponse,
} from '@/lib/extraction-schema'

/** Model aliases used by the OCR pipeline (§8 point 3, §8 point 7). */
export const MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
} as const

export type ModelKey = keyof typeof MODELS
export type ModelId = (typeof MODELS)[ModelKey]

export const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number]

/** One rasterised page, ready to send as an image content block. */
export interface DocumentImageInput {
  /** Base64-encoded image bytes (no data: URI prefix). */
  data: string
  mediaType: SupportedImageMediaType
}

export interface ExtractDocumentParams {
  /** All pages of one document, in page order — sent in a single request per §8 point 3. */
  documentImages: DocumentImageInput[]
  /** Defaults to Haiku (§8 point 3); pass MODELS.sonnet for the manual re-escalation path (§8 point 7). */
  model?: ModelId
}

export interface ExtractDocumentResult {
  /** Validated, hard-filtered extraction (line items from non-financial pages already dropped). */
  extraction: ExtractionResponse
  usage: { inputTokens: number; outputTokens: number }
  /** Non-batched cost estimate for this single call; see estimateCostUsd for the batched rate. */
  costUsd: number
  /** The full API response, for `ocr_extraction_run.raw_response_jsonb` (§3.8). */
  rawResponse: Anthropic.Message
}

const EXTRACTION_MAX_TOKENS = 2000

const SYSTEM_PROMPT =
  'You are extracting structured data from a scanned financial document (invoice, chit, or receipt) ' +
  'submitted for expense reconciliation. The document may span multiple pages, and some pages may not ' +
  'be financial documents at all (e.g. a bank cheque, a passbook page, or an unrelated scan caught in ' +
  'the same batch) — classify every page first via the tool schema before extracting anything from it. ' +
  'Read every page as part of one document: a line-item table may continue across a page break. Never ' +
  'fabricate a value — use null for anything illegible or genuinely absent, and reflect uncertainty via ' +
  'the confidence fields rather than guessing.'

// TODO Phase 1B: Batch API path — this file intentionally implements only the
// single-request `extractDocument` call for today (MASTER-PLAN §8 points 3-4).
// The Batch API wrapper (submit, poll by custom_id, never by position — §8
// point 8) belongs in lib/jobs/handlers/batch-poll.ts once the job-queue SQL
// function exists.

/**
 * Runs one Claude extraction call for one document, all pages as image
 * blocks in a single message (§8 point 3). Throws a clear error instead of
 * attempting the call when no real API key is configured.
 */
export async function extractDocument(params: ExtractDocumentParams): Promise<ExtractDocumentResult> {
  if (!hasAnthropicKey) {
    throw new Error('ANTHROPIC_API_KEY not set — see MASTER-PLAN §6.4')
  }
  if (params.documentImages.length === 0) {
    throw new TypeError('extractDocument: documentImages must contain at least one page')
  }

  const model = params.model ?? MODELS.haiku
  const client = new Anthropic({ apiKey: serverEnv.ANTHROPIC_API_KEY })
  const tool = buildExtractionTool()

  const imageBlocks: Anthropic.ImageBlockParam[] = params.documentImages.map((image) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mediaType,
      data: image.data,
    },
  }))

  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text:
      'Classify and extract every page of this document (all pages of one document are attached above, ' +
      'in order) using the record_document_extraction tool.',
  }

  const response = await client.messages.create({
    model,
    max_tokens: EXTRACTION_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [...imageBlocks, textBlock],
      },
    ],
  })

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  )
  if (!toolUseBlock) {
    throw new Error(
      `extractDocument: Claude did not return a tool_use block for "${EXTRACTION_TOOL_NAME}" (stop_reason: ${response.stop_reason ?? 'unknown'})`
    )
  }

  const parsed = extractionResponseSchema.parse(toolUseBlock.input)
  const extraction = filterNonFinancialLineItems(parsed)

  return {
    extraction,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    costUsd: estimateCostUsd(model, response.usage.input_tokens, response.usage.output_tokens),
    rawResponse: response,
  }
}

/** Per-million-token rates from MASTER-PLAN §6.1 (full, non-batched price). */
const MODEL_RATES_USD_PER_MTOK: Record<ModelId, { input: number; output: number }> = {
  [MODELS.haiku]: { input: 1.0, output: 5.0 },
  [MODELS.sonnet]: { input: 3.0, output: 15.0 },
}

/**
 * Estimates the USD cost of a call using the §6.1 rate card. Pass
 * `batched: true` for the Batch API's 50% discount — used for every real
 * OCR run per §6.3 point 1; the non-batched rate is what a single
 * synchronous `extractDocument` call (dev/testing, manual re-escalation)
 * actually costs.
 */
export function estimateCostUsd(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
  batched = false
): number {
  const rates = MODEL_RATES_USD_PER_MTOK[model]
  const discount = batched ? 0.5 : 1
  const inputCost = (inputTokens / 1_000_000) * rates.input * discount
  const outputCost = (outputTokens / 1_000_000) * rates.output * discount
  return inputCost + outputCost
}
