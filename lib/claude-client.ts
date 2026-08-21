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
  dropEmptyBills,
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
 * When `max_tokens` is hit partway through, the partial JSON arrives with
 * required fields simply missing, which otherwise surfaces as a baffling Zod
 * "line_items: Required" error a long way from the actual cause —
 * `parseExtractionMessage` below checks `stop_reason` before ever handing the
 * input to Zod, specifically to turn that into a clear signal instead. The
 * pipeline catches this and retries with a larger budget (lib/extraction.ts).
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
 * `max_tokens` is a ceiling, not a reservation — nothing is billed for
 * headroom that goes unused, so a bill that fits in 1,200 tokens costs
 * exactly the same under an 8,000 cap as under a 2,000 one. There is no cost
 * downside to raising it; the only downside is truncation, which is far more
 * expensive: every time the cap IS hit, `runExtractionPipeline` retries the
 * whole call at TRUNCATION_RETRY_MAX_TOKENS — re-billing the entire input a
 * second time.
 *
 * Since extraction moved to one call per PAGE (lib/jobs/handlers/extract.ts —
 * see lib/pdf.ts's `splitPdfPage`), a single call's output is usually just one
 * page's worth of line items, which rarely comes close to even the old 4,000
 * cap. 8,000 is set anyway as a defensive margin for the rare densely
 * itemised single page, and because it also leaves room for Sonnet's adaptive
 * thinking on the manual re-escalation path: `max_tokens` caps thinking *and*
 * response text together, and `claude-sonnet-5` runs adaptive thinking by
 * default when no `thinking` parameter is set. That parameter is deliberately
 * left unset rather than `{ type: 'disabled' }`: disabling thinking on a
 * Claude 5-generation model carries two documented failure modes — tool calls
 * occasionally emitted as plain assistant text instead of a real tool_use
 * block, and internal <thinking> content leaking into field values (the
 * leaked-tag syntax `sanitizeLeakedTagSyntax` guards against). Raising
 * max_tokens fixes truncation without either risk.
 *
 * Exported (not just used internally) so the Batch API submission path
 * (plan.md Phase 3 I16, submitExtractionBatch below and
 * lib/jobs/handlers/extract.ts's submitExtractionBatchAndEnqueuePoll) uses
 * the exact same default rather than a second hard-coded copy.
 */
export const EXTRACTION_MAX_TOKENS = 8000

/**
 * How long a single extraction call is allowed to run before it's aborted.
 *
 * Exists because of what used to happen without it: a Vercel function has a
 * hard wall-clock limit (`maxDuration`, currently 60s on every route that can
 * trigger extraction), and when that limit hits mid-call, the platform kills
 * the function outright — no exception is thrown, nothing is caught, and the
 * job_queue row this call was working on stays `'running'` forever with
 * nothing to notice or recover it. Aborting the call ourselves, comfortably
 * before that wall, turns an invisible platform kill into an ordinary
 * exception the caller already knows how to handle: `handleExtractDocument`
 * catches it and marks the job `'failed'`, and `sweepJobQueue` (now running
 * regularly via the GitHub Actions cron hitting /api/jobs/tick, see the repo
 * root's .github/workflows/) requeues it with backoff shortly after — minutes,
 * not the 10-minute staleness timeout a genuinely stuck lock would otherwise
 * need. Now that extraction is one call per page rather than one call per
 * whole document, no single call should ever legitimately need anywhere near
 * this long; hitting this timeout means the call is genuinely hung, not just
 * working through a big document.
 */
export const EXTRACTION_CALL_TIMEOUT_MS = 45_000

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
    'be financial documents at all (e.g. a bank cheque, a passbook page, a government ID card or photo ' +
    'ID, or an unrelated scan caught in the same batch) — classify every page first via the tool schema ' +
    'before extracting anything from it. ' +
    'A line-item table may continue across a page break, so treat continuation pages as part of the bill ' +
    'they belong to. For every financial page, also set continues_previous_bill: true when the page has ' +
    'no vendor letterhead or invoice number of its own — it is simply more line items or totals carrying ' +
    'on from the page before it — and false when it starts a bill (its own header) or is not a financial ' +
    'page at all. When you are shown only one page at a time, judge this from that page alone: the ' +
    'absence of a new header is itself the signal, even without seeing what came before it. When you are ' +
    'shown several pages together, use them directly: a page whose table simply keeps going with no new ' +
    'header is a continuation of the bill on the page(s) before it. ' +
    'Note that a batch scan may contain SEVERAL SEPARATE BILLS from different vendors: a ' +
    'new vendor header, invoice number, and total starting on a later page is a NEW bill — extract it as ' +
    'its own entry in `bills[]`, never folded into `notes` and never merged with the previous bill\'s ' +
    'line items. Give each bill entry the page_number_start/page_number_end its own header and totals ' +
    'were read from. ' +
    'A page that is ITSELF an internal cover sheet, routing slip, or index/summary table LISTING several ' +
    'other bills or vendor payments (rather than being one of those bills itself — e.g. a handwritten ' +
    'table of vendor names and amounts used to tally a batch before scanning) is not a financial document ' +
    'to extract: classify it is_financial_document=false and return zero entries in bills[] for it, even ' +
    'though it contains names and amounts that superficially resemble a bill. Do not create one bill per ' +
    'row of such a table — those rows describe OTHER pages, not charges of their own. When genuinely ' +
    'unsure whether an isolated page is a real invoice versus an administrative page like this, prefer ' +
    'classifying it as non-financial with zero bills over guessing; a missed real bill is a page a human ' +
    'reviewer can revisit, but a fabricated bill entry with no real content behind it pollutes the review ' +
    'queue with something that can never be corrected because there was never anything there to correct ' +
    'it to. A vendor\'s own contact details — email address, phone number, GSTIN, or address, however they ' +
    'are printed or positioned on the page, including in a footer/signature block below the line-item ' +
    'table — are header information, never a line item of their own: never create a line-item row whose ' +
    'description is an email address, a phone number, or similar contact text, even if it visually sits ' +
    'in the same area as the line items. Never ' +
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

/** What this SDK version accepts inside a user turn's `content` array. */
type UserContentBlockParam = Anthropic.ImageBlockParam | Anthropic.TextBlockParam | Anthropic.DocumentBlockParam

function buildPdfBlock(data: string): UserContentBlockParam {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data },
  }
}

/**
 * The system prompt (buildSystemPrompt below) and the extraction tool
 * schema (buildExtractionTool, lib/extraction-schema.ts) are both identical
 * on every call — only the per-document PDF/image content varies. Render
 * order is tools -> system -> messages, so a cache_control breakpoint on
 * this last (only) system block caches the tool schema and the system
 * prompt together; every subsequent extraction call within the 5-minute TTL
 * reads that ~90% cheaper instead of paying full price for it again.
 */
function buildCachedSystemPrompt(communityGstin: string | null): Anthropic.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: buildSystemPrompt(communityGstin),
      cache_control: { type: 'ephemeral' },
    },
  ]
}

/**
 * Builds the `client.messages.create` request body shared by the synchronous
 * path (`extractDocument` below) and the Batch API submission path
 * (`submitExtractionBatch` below, plan.md Phase 3 I16) — same system prompt,
 * same tool, same tool_choice; only the source content blocks and per-call
 * model/max_tokens vary. `MessageCreateParamsNonStreaming` is exactly the
 * shape `BatchCreateParams.Request.params` expects (see batches.d.ts), so
 * this one function is reused for both call shapes rather than kept in sync
 * by hand in two places.
 */
function buildExtractionRequestParams(params: {
  sourceBlocks: UserContentBlockParam[]
  model: ModelId
  maxTokens: number
}): Anthropic.MessageCreateParamsNonStreaming {
  const tool = buildExtractionTool()
  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text:
      'Classify and extract every page of this document (all pages of one document are attached above, ' +
      'in order) using the record_document_extraction tool.',
  }

  return {
    model: params.model,
    max_tokens: params.maxTokens,
    system: buildCachedSystemPrompt(serverEnv.COMMUNITY_GSTIN || null),
    // `tool` is built from `extractionToolInputSchema`'s `as const` literal
    // (lib/extraction-schema.ts), whose `required` arrays are readonly
    // tuples; the SDK's `Tool.InputSchema.required` is typed as a mutable
    // `string[]`. That's a TS array-variance formality — the wire shapes are
    // identical, and JSON.stringify does not care about readonly — not a
    // missing-type gap like the casts this file used to carry, so it is not
    // worth widening `required` throughout the schema file to avoid it.
    tools: [tool as unknown as Anthropic.Tool],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [...params.sourceBlocks, textBlock],
      },
    ],
  }
}

/**
 * Turns one `Anthropic.Message` (a completed, non-streaming response) into
 * the same `ExtractDocumentResult` shape regardless of whether it arrived
 * synchronously from `client.messages.create` or asynchronously from a
 * Batch API result (plan.md Phase 3 I16) — a `MessageBatchSucceededResult`'s
 * `.message` field is typed as exactly this same `Anthropic.Message`, so one
 * parse/validate/cost path covers both. `batched` selects the 50% Batch API
 * discount in `estimateCostUsd` (see its own doc comment) — the only thing
 * that differs between the two call shapes once a `Message` is in hand.
 */
function parseExtractionMessage(
  response: Anthropic.Message,
  model: ModelId,
  maxTokens: number,
  batched: boolean
): ExtractDocumentResult {
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
  // Order matters: dropEmptyBills only correctly identifies a truly empty
  // bill once filterNonFinancialLineItems has already stripped any line
  // items that belonged to a non-financial page.
  const extraction = dropEmptyBills(filterNonFinancialLineItems(parsed))

  return {
    extraction,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    costUsd: estimateCostUsd(model, response.usage.input_tokens, response.usage.output_tokens, batched),
    rawResponse: response,
  }
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

  const maxTokens = params.maxTokens ?? EXTRACTION_MAX_TOKENS

  // `signal` is a per-request option (the SDK's second argument), not part of
  // the request body — see EXTRACTION_CALL_TIMEOUT_MS's doc comment for why
  // this exists. AbortSignal.timeout() (Node 18+) needs no manual cleanup: it
  // fires once and is done, unlike a hand-rolled setTimeout + AbortController
  // that would need a matching clearTimeout in every return/throw path.
  const response = await client.messages.create(
    buildExtractionRequestParams({ sourceBlocks, model, maxTokens }),
    { signal: AbortSignal.timeout(EXTRACTION_CALL_TIMEOUT_MS) }
  )

  return parseExtractionMessage(response, model, maxTokens, false)
}

// ---------------------------------------------------------------------------
// Batch API (plan.md Phase 3 I16) — same request shape as extractDocument
// above, submitted asynchronously at a 50% cost discount. Opt-in via
// OCR_USE_BATCH_API (lib/env.server.ts, default false); the only caller is
// lib/jobs/handlers/extract.ts's submitExtractionBatchAndEnqueuePoll, and the
// only consumer of results is lib/jobs/handlers/batch-poll.ts. Server-side
// only (documentPdf, not documentImages) — batch submission always runs from
// the queue-driven ingest path, which already has the PDF bytes in hand the
// same way extractAndPersist does, never from a browser.
// ---------------------------------------------------------------------------

/** One request to submit as part of a Batch API call. */
export interface BatchSubmitRequest {
  /** Unique within this batch; see buildExtractionBatchCustomId below. */
  customId: string
  documentPdf: DocumentPdfInput
  model: ModelId
  maxTokens?: number
}

export interface BatchSubmitResult {
  batchId: string
  createdAt: string
  /** RFC 3339 — Anthropic auto-ends processing 24h after creation. */
  expiresAt: string
}

/**
 * Submits one Anthropic Message Batch containing `requests.length` requests
 * and returns immediately with the batch id — processing happens
 * asynchronously on Anthropic's side (up to 24h) and is picked up later by
 * `retrieveExtractionBatch`/`listExtractionBatchResults` from a `poll_batch`
 * job (lib/jobs/handlers/batch-poll.ts).
 *
 * `client.messages.batches` is a non-beta surface on this SDK version (see
 * node_modules/@anthropic-ai/sdk/resources/messages/batches.d.ts — `Batches`
 * is a plain field on the `Messages` resource, not under `client.beta`), so
 * no beta header is needed.
 */
export async function submitExtractionBatch(requests: BatchSubmitRequest[]): Promise<BatchSubmitResult> {
  if (!hasAnthropicKey) {
    throw new Error('ANTHROPIC_API_KEY not set — see MASTER-PLAN §6.4')
  }
  if (requests.length === 0) {
    throw new TypeError('submitExtractionBatch: requests must not be empty')
  }

  const client = new Anthropic({ apiKey: serverEnv.ANTHROPIC_API_KEY })

  const batchRequests: Anthropic.Messages.BatchCreateParams.Request[] = requests.map((req) => ({
    custom_id: req.customId,
    params: buildExtractionRequestParams({
      sourceBlocks: [buildPdfBlock(req.documentPdf.data)],
      model: req.model,
      maxTokens: req.maxTokens ?? EXTRACTION_MAX_TOKENS,
    }),
  }))

  const batch = await client.messages.batches.create({ requests: batchRequests })

  return { batchId: batch.id, createdAt: batch.created_at, expiresAt: batch.expires_at }
}

/** Thin wrapper — current status of a submitted batch, incl. request_counts and results_url once ended. */
export async function retrieveExtractionBatch(batchId: string): Promise<Anthropic.Messages.MessageBatch> {
  if (!hasAnthropicKey) {
    throw new Error('ANTHROPIC_API_KEY not set — see MASTER-PLAN §6.4')
  }
  const client = new Anthropic({ apiKey: serverEnv.ANTHROPIC_API_KEY })
  return client.messages.batches.retrieve(batchId)
}

/**
 * Fetches every result line for an ended batch. `client.messages.batches.results`
 * streams a `.jsonl` file as an async iterator (results are NOT guaranteed to
 * be in request order — §8 point 8, plan.md's "keyed by custom_id, never by
 * position"); this buffers it into an array because every batch this
 * pipeline submits today is a single request (see the design-decision
 * comment on submitExtractionBatchAndEnqueuePoll in
 * lib/jobs/handlers/extract.ts), so the buffered size is always tiny. If a
 * future change pools many documents into one batch, this should become a
 * streaming consumer instead of buffering the whole file.
 */
export async function listExtractionBatchResults(
  batchId: string
): Promise<Anthropic.Messages.MessageBatchIndividualResponse[]> {
  if (!hasAnthropicKey) {
    throw new Error('ANTHROPIC_API_KEY not set — see MASTER-PLAN §6.4')
  }
  const client = new Anthropic({ apiKey: serverEnv.ANTHROPIC_API_KEY })
  const decoder = await client.messages.batches.results(batchId)

  const results: Anthropic.Messages.MessageBatchIndividualResponse[] = []
  for await (const line of decoder) {
    results.push(line)
  }
  return results
}

/** What interpretBatchResult found for one batch request, after parsing. */
export type BatchResultOutcome =
  | { status: 'succeeded'; extraction: ExtractDocumentResult }
  /** Same condition ExtractionTruncatedError signals synchronously — caller decides how to rescue it. */
  | { status: 'truncated' }
  | { status: 'errored'; message: string }
  | { status: 'canceled' }
  | { status: 'expired' }

/**
 * Interprets one `MessageBatchResult` (the `result` field of one line from
 * `listExtractionBatchResults`) using the same parse/validate/cost logic
 * `extractDocument` uses for a synchronous response — see
 * `parseExtractionMessage` above. `maxTokens` must be the exact value that
 * request was submitted with (the caller's own record of it — a batch result
 * carries no `max_tokens` echo), so the truncation check is correct.
 */
export function interpretBatchResult(
  result: Anthropic.Messages.MessageBatchResult,
  model: ModelId,
  maxTokens: number
): BatchResultOutcome {
  switch (result.type) {
    case 'succeeded':
      try {
        return { status: 'succeeded', extraction: parseExtractionMessage(result.message, model, maxTokens, true) }
      } catch (err) {
        if (err instanceof ExtractionTruncatedError) return { status: 'truncated' }
        throw err
      }
    case 'errored': {
      const inner = result.error.error
      const message = inner && typeof inner === 'object' && 'message' in inner
        ? String((inner as { message: unknown }).message)
        : JSON.stringify(result.error.error)
      return { status: 'errored', message }
    }
    case 'canceled':
      return { status: 'canceled' }
    case 'expired':
      return { status: 'expired' }
  }
}

// custom_id encoding/decoding lives in lib/jobs/batch-custom-id.ts, not here
// — it's pure (no serverEnv, no network) and kept in a module free of this
// file's transitive `server-only` import so it stays unit-testable. Callers
// (lib/jobs/handlers/extract.ts, lib/jobs/handlers/batch-poll.ts) import
// buildExtractionBatchCustomId/parseExtractionBatchCustomId from there
// directly.

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
