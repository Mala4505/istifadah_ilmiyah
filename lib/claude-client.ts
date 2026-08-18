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

/**
 * A whole PDF, sent as a single `document` content block.
 *
 * This is the server-side ingestion path (see lib/pdf.ts). Claude renders each
 * page itself and also reads the embedded text layer, so per-page
 * classification (§8 point 3) still works — the `pages[]` array in the tool
 * schema is unchanged. Preferred over `documentImages` on the server because
 * nothing in Node can rasterise a PDF here: pdfjs-dist needs a canvas backend
 * and every one tried crashes natively on `page.render` (see the note in
 * lib/pdf.ts).
 */
export interface DocumentPdfInput {
  /** Base64-encoded PDF bytes (no data: URI prefix, no newlines). */
  data: string
}

/**
 * Raised when the model ran out of output budget mid-tool-call.
 *
 * `strict: true` guarantees the tool input *validates* — it cannot guarantee
 * the model gets to finish writing it. When `max_tokens` is hit partway
 * through, the partial JSON arrives with required fields simply missing, which
 * otherwise surfaces as a baffling Zod "line_items: Required" error a long way
 * from the actual cause. The pipeline catches this and retries with a larger
 * budget (lib/extraction.ts).
 */
export class ExtractionTruncatedError extends Error {
  constructor(
    readonly model: ModelId,
    readonly maxTokens: number
  ) {
    super(
      `extractDocument: ${model} hit max_tokens (${maxTokens}) before finishing the tool call — ` +
        'the extraction was truncated, not invalid.'
    )
    this.name = 'ExtractionTruncatedError'
  }
}

export interface ExtractDocumentParams {
  /**
   * All pages of one document, in page order — sent in a single request per
   * §8 point 3. Used by the client-side pdf.js path (Day 3/4 review UI).
   * Mutually exclusive with `documentPdf`.
   */
  documentImages?: DocumentImageInput[]
  /**
   * The whole PDF as one block — the server-side path used by
   * lib/jobs/handlers/extract.ts. Mutually exclusive with `documentImages`.
   */
  documentPdf?: DocumentPdfInput
  /** Defaults to Haiku (§8 point 3); pass MODELS.sonnet for the manual re-escalation path (§8 point 7). */
  model?: ModelId
  /**
   * Output budget. Defaults to §8's 2,000-token cap, which covers the great
   * majority of these invoices; the pipeline retries with a larger budget when
   * a long line-item table overruns it.
   */
  maxTokens?: number
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

/**
 * Default output budget for one extraction call.
 *
 * §8 specifies 2,000, which fits a typical one-page bill's tool call with room
 * to spare — but it is a *false* economy at this size, for two reasons:
 *
 *  1. `max_tokens` is a ceiling, not a reservation. Nothing is billed for
 *     headroom that goes unused, so a bill that fits in 1,200 tokens costs
 *     exactly the same under a 4,000 cap as under a 2,000 one.
 *  2. Every time the cap *is* hit, `runExtractionPipeline` retries the whole
 *     call at TRUNCATION_RETRY_MAX_TOKENS — re-billing the entire PDF's input
 *     tokens, which on a multi-page scan dwarf the output side. A cap set
 *     just below what dense invoices need makes the expensive documents cost
 *     roughly double.
 *
 * 4,000 covers the densely itemised multi-page scans in the pilot corpus that
 * were previously landing in the retry path. It also leaves room for Sonnet's
 * adaptive thinking on the manual re-escalation path: `max_tokens` caps
 * thinking *and* response text together, and `claude-sonnet-5` runs adaptive
 * thinking by default when no `thinking` parameter is set (which this SDK pin
 * cannot express — see the PdfDocumentBlockParam note above). Under the old
 * 2,000 cap, Sonnet spent part of the budget thinking and then truncated the
 * tool call mid-JSON, which is why escalation so often returned partial data.
 * The retry at 8,000 stays as the backstop for genuine outliers.
 */
const EXTRACTION_MAX_TOKENS = 4000

/**
 * Builds the system prompt, optionally appending an own-GSTIN exclusion rule
 * when `communityGstin` is set (COMMUNITY_GSTIN, lib/env.server.ts). This is
 * a function rather than a module-level constant so the prompt can vary per
 * call without threading a second parameter through the whole extraction
 * pipeline — `extractDocument` is the only caller, and it reads
 * `serverEnv.COMMUNITY_GSTIN` itself.
 */
function buildSystemPrompt(communityGstin: string | null): string {
  const base =
    'You are extracting structured data from a scanned financial document (invoice, chit, or receipt) ' +
    'submitted for expense reconciliation. The document may span multiple pages, and some pages may not ' +
    'be financial documents at all (e.g. a bank cheque, a passbook page, or an unrelated scan caught in ' +
    'the same batch) — classify every page first via the tool schema before extracting anything from it. ' +
    'A line-item table may continue across a page break, so treat continuation pages as part of the bill ' +
    'they belong to. Note that a batch scan may contain SEVERAL SEPARATE BILLS from different vendors: a ' +
    'new vendor header, invoice number, and total starting on a later page is a NEW bill, not a ' +
    'continuation of the previous one. The schema currently has room for only one bill\'s header fields — ' +
    'fill them from the FIRST bill in the document, and record each additional bill\'s vendor, invoice ' +
    'number, date and total in `notes` so a reviewer can see what else the document contains. Never ' +
    'fabricate a value — for anything illegible or genuinely absent use an empty string in a text field ' +
    'and null in a numeric field, and reflect uncertainty via the confidence fields rather than guessing. ' +
    'Every field value must be plain text transcribed from the document — never emit tag-like syntax ' +
    '(anything shaped like `<...>` or `</...>`) inside a field, even if it resembles formatting you have ' +
    'seen elsewhere; that is never part of a real invoice.'

  if (!communityGstin) return base

  return (
    base +
    ' For vendor_gstin specifically: extract the VENDOR/SELLER\'s GSTIN — the one printed under ' +
    '"GSTIN"/"Seller" near the vendor\'s own name and address — never the buyer/recipient\'s GSTIN. ' +
    `If the community's own GSTIN (${communityGstin}) appears on the page as the recipient, do not ` +
    'return it as vendor_gstin; leave vendor_gstin empty instead.'
  )
}

// TODO Phase 1B: Batch API path — this file intentionally implements only the
// single-request `extractDocument` call for today (MASTER-PLAN §8 points 3-4).
// The Batch API wrapper (submit, poll by custom_id, never by position — §8
// point 8) belongs in lib/jobs/handlers/batch-poll.ts once the job-queue SQL
// function exists.

/**
 * The wire shape of a base64 PDF `document` content block.
 *
 * Hand-written rather than imported: @anthropic-ai/sdk is pinned at 0.32.1
 * here, which predates PDF support being GA, so `ContentBlockParam` has no
 * `document` member to import. The block below is the documented GA wire
 * format and needs no beta header — the SDK serialises `content` straight to
 * JSON, so the cast at the call site is a typing gap, not a protocol one.
 * Delete this and import the SDK's own type whenever the pin moves.
 */
interface PdfDocumentBlockParam {
  type: 'document'
  source: { type: 'base64'; media_type: 'application/pdf'; data: string }
}

/** What this SDK version accepts inside a user turn's `content` array. */
type UserContentBlockParam = Anthropic.ImageBlockParam | Anthropic.TextBlockParam

function buildPdfBlock(data: string): UserContentBlockParam {
  const block: PdfDocumentBlockParam = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data },
  }
  return block as unknown as UserContentBlockParam
}

/**
 * Same hand-typed-cast pattern as `PdfDocumentBlockParam` above: this SDK
 * version (0.32.1) predates typed `cache_control` support on the non-beta
 * `client.messages` surface (it only exists on `client.beta.messages`'
 * request types) — but prompt caching itself is GA on the wire, so the field
 * is accepted by the API with no beta header regardless of which client
 * surface sent it. Casting the request body, as buildPdfBlock already does
 * for the `document` content block, avoids taking on the beta response type
 * (`Anthropic.Beta.BetaMessage`) throughout this file just to set one field.
 *
 * The system prompt (buildSystemPrompt below) and the extraction tool
 * schema (buildExtractionTool, lib/extraction-schema.ts) are both identical
 * on every call — only the per-document PDF/image content varies. Render
 * order is tools -> system -> messages, so a cache_control breakpoint on
 * this last (only) system block caches the tool schema and the system
 * prompt together; every subsequent extraction call within the 5-minute TTL
 * reads that ~90% cheaper instead of paying full price for it again.
 */
interface CachedSystemBlockParam {
  type: 'text'
  text: string
  cache_control: { type: 'ephemeral' }
}

function buildCachedSystemPrompt(communityGstin: string | null): string {
  const block: CachedSystemBlockParam = {
    type: 'text',
    text: buildSystemPrompt(communityGstin),
    cache_control: { type: 'ephemeral' },
  }
  return [block] as unknown as string
}

/**
 * Runs one Claude extraction call for one document — every page in a single
 * message, either as image blocks or as one PDF block (§8 point 3). Throws a
 * clear error instead of attempting the call when no real API key is
 * configured.
 */
export async function extractDocument(params: ExtractDocumentParams): Promise<ExtractDocumentResult> {
  if (!hasAnthropicKey) {
    throw new Error('ANTHROPIC_API_KEY not set — see MASTER-PLAN §6.4')
  }

  const hasImages = (params.documentImages?.length ?? 0) > 0
  const hasPdf = Boolean(params.documentPdf)
  if (hasImages && hasPdf) {
    throw new TypeError('extractDocument: pass documentImages or documentPdf, not both')
  }
  if (!hasImages && !hasPdf) {
    throw new TypeError('extractDocument: documentImages must contain at least one page, or documentPdf must be set')
  }

  const model = params.model ?? MODELS.haiku
  const client = new Anthropic({ apiKey: serverEnv.ANTHROPIC_API_KEY })
  const tool = buildExtractionTool()

  const sourceBlocks: UserContentBlockParam[] = hasPdf
    ? [buildPdfBlock(params.documentPdf!.data)]
    : (params.documentImages ?? []).map((image) => ({
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

  const maxTokens = params.maxTokens ?? EXTRACTION_MAX_TOKENS

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: buildCachedSystemPrompt(serverEnv.COMMUNITY_GSTIN || null),
    tools: [tool],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [...sourceBlocks, textBlock],
      },
    ],
  })

  // Check truncation before parsing: a cut-off tool call fails Zod with a
  // missing-field error that says nothing about the real cause.
  if (response.stop_reason === 'max_tokens') {
    throw new ExtractionTruncatedError(model, maxTokens)
  }

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
