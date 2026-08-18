/**
 * `poll_batch` job handler (MASTER-PLAN §3.11, §8 point 8; plan.md Phase 3 I16).
 *
 * Claimed by either caller of the one worker loop (§3.11) —
 * app/api/jobs/tick/route.ts on Vercel, worker/index.ts as a Windows service.
 * `submitExtractionBatchAndEnqueuePoll` (lib/jobs/handlers/extract.ts)
 * enqueues one of these jobs immediately after submitting a Message Batch to
 * Anthropic (gated by OCR_USE_BATCH_API, lib/env.server.ts, default false).
 *
 * What it does, once claimed:
 *   1. Retrieves the batch's current status (lib/claude-client.ts).
 *   2. Not yet `ended`: releases the job back to `'queued'` for a later poll
 *      (`requeueJob`, lib/jobs/queue.ts) — never `failJob`, since a batch can
 *      legitimately take up to 24h and "still processing" is not a failure.
 *   3. `ended`: fetches every result line and finds the ONE matching this
 *      job's `source_document_id` by `custom_id` (never by array position —
 *      §8 point 8: "results arrive in any order"), then persists it through
 *      the same `persistExtractionPipelineResult` (lib/jobs/handlers/extract.ts)
 *      the synchronous path uses, so this file carries no second copy of the
 *      document_extraction/document_page/line-item/tally-check block.
 */

import 'server-only'
import { completeJob, failJob, requeueJob, type JobQueueRow } from '@/lib/jobs/queue'
import { nextPollBackoffMs } from '@/lib/jobs/poll-backoff'
import { parseExtractionBatchCustomId } from '@/lib/jobs/batch-custom-id'
import { createAdminClient } from '@/lib/supabase/admin'
import { toBase64 } from '@/lib/pdf'
import {
  retrieveExtractionBatch,
  listExtractionBatchResults,
  interpretBatchResult,
  extractDocument,
  MODELS,
  type ModelId,
} from '@/lib/claude-client'
import { TRUNCATION_RETRY_MAX_TOKENS, type ExtractionAttempt, type ExtractionPipelineResult } from '@/lib/extraction'
import {
  fetchSourceDocumentForExtraction,
  downloadDocumentPdf,
  persistExtractionPipelineResult,
  recordExtractionFailure,
  type PollBatchPayload,
} from '@/lib/jobs/handlers/extract'

/**
 * Grace period past a batch's own `expires_at` before treating "still not
 * ended" as a real failure rather than an ordinary poll. Anthropic
 * auto-ends processing at `expires_at` (up to 24h after submission); this
 * only fires if that guarantee is somehow violated, so it exists purely as a
 * defensive backstop against polling forever.
 */
const EXPIRY_GRACE_MS = 15 * 60 * 1000

export async function handlePollBatch(job: JobQueueRow): Promise<void> {
  const payload = job.payload as Partial<PollBatchPayload>
  const batchId = typeof payload.batch_id === 'string' ? payload.batch_id : null
  const sourceDocumentId = Number(payload.source_document_id)
  const model = payload.model as ModelId | undefined
  const maxTokens = Number(payload.max_tokens)

  if (
    !batchId ||
    !Number.isInteger(sourceDocumentId) ||
    sourceDocumentId <= 0 ||
    !model ||
    !Number.isFinite(maxTokens)
  ) {
    await failJob(
      job.id,
      'poll_batch payload missing/invalid batch_id, source_document_id, model, or max_tokens'
    )
    return
  }

  const admin = createAdminClient()

  try {
    const batch = await retrieveExtractionBatch(batchId)

    if (batch.processing_status !== 'ended') {
      const expiresAt = new Date(batch.expires_at).getTime()
      if (Number.isFinite(expiresAt) && expiresAt < Date.now() - EXPIRY_GRACE_MS) {
        throw new Error(
          `poll_batch: batch ${batchId} is past its expires_at (${batch.expires_at}) but ` +
            `processing_status is still '${batch.processing_status}' -- treating as stuck`
        )
      }

      // Not a failure -- release the job back to 'queued' for a later poll.
      // See requeueJob's doc comment (lib/jobs/queue.ts) for why this must
      // never go through failJob.
      await requeueJob(job.id, new Date(Date.now() + nextPollBackoffMs(job.attempts)))
      return
    }

    const results = await listExtractionBatchResults(batchId)
    const match = results.find((item) => parseExtractionBatchCustomId(item.custom_id) === sourceDocumentId)

    if (!match) {
      throw new Error(
        `poll_batch: batch ${batchId} ended but no result's custom_id matched source_document ` +
          `${sourceDocumentId} (${results.length} result(s) in batch)`
      )
    }

    const outcome = interpretBatchResult(match.result, model, maxTokens)

    let attempt: ExtractionAttempt
    const completedAt = batch.ended_at ?? new Date().toISOString()

    if (outcome.status === 'succeeded') {
      attempt = {
        model,
        runReason: 'initial',
        extraction: outcome.extraction.extraction,
        usage: outcome.extraction.usage,
        costUsd: outcome.extraction.costUsd,
        rawResponse: outcome.extraction.rawResponse,
        startedAt: batch.created_at,
        completedAt,
      }
    } else if (outcome.status === 'truncated') {
      // Same rescue the sync pipeline performs (lib/extraction.ts callOnce)
      // on ExtractionTruncatedError, triggered from the batch path instead:
      // same model, bigger budget, one direct synchronous call -- NOT a
      // second batch submission (see the "no auto-escalation in v1" design
      // comment on submitExtractionBatchAndEnqueuePoll in
      // lib/jobs/handlers/extract.ts for why this stays synchronous rather
      // than chaining another up-to-24h batch). Billed at the full
      // non-batched rate, same as the sync retry.
      const doc = await fetchSourceDocumentForExtraction(admin, sourceDocumentId)
      const pdfBytes = await downloadDocumentPdf(doc.storagePath)
      const retryStartedAt = new Date().toISOString()
      const retryResult = await extractDocument({
        documentPdf: { data: toBase64(pdfBytes) },
        model,
        maxTokens: TRUNCATION_RETRY_MAX_TOKENS,
      })
      attempt = {
        model,
        runReason: 'initial',
        extraction: retryResult.extraction,
        usage: retryResult.usage,
        costUsd: retryResult.costUsd,
        rawResponse: retryResult.rawResponse,
        startedAt: retryStartedAt,
        completedAt: new Date().toISOString(),
      }
    } else {
      // 'errored' | 'canceled' | 'expired' -- a genuine failure for this
      // request. Caught below, recorded via recordExtractionFailure, and
      // failJob'd so the sweeper's normal retry/dead-letter machinery
      // applies (this is a real error, unlike "still processing" above).
      const reason =
        outcome.status === 'errored'
          ? `errored: ${outcome.message}`
          : outcome.status === 'canceled'
            ? 'was canceled'
            : 'expired before completing'
      throw new Error(`poll_batch: batch request for source_document ${sourceDocumentId} ${reason}`)
    }

    const doc = await fetchSourceDocumentForExtraction(admin, sourceDocumentId)
    const pipeline: ExtractionPipelineResult = {
      attempts: [attempt],
      final: attempt,
      escalated: false,
      totalCostUsd: attempt.costUsd,
    }

    const result = await persistExtractionPipelineResult(admin, {
      sourceDocumentId,
      doc,
      pipeline,
      triggeredBy: null,
    })

    console.log(
      `[batch-poll] document ${sourceDocumentId}: batch=${batchId} model=${model} bills=${result.billCount} ` +
        `lines=${result.lineItemCount} cost=$${result.totalCostUsd.toFixed(6)} ` +
        `exceptions=[${result.exceptionsRaised.join(',')}]`
    )
    await completeJob(job.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[batch-poll] job ${job.id} (source_document ${sourceDocumentId}) failed:`, message)
    await recordExtractionFailure(admin, sourceDocumentId, model ?? MODELS.haiku, 'initial', null, err)
    await failJob(job.id, message.slice(0, 2000))
  }
}

// worker/index.ts (and app/api/jobs/tick/route.ts) dynamically import this
// module and call its default export — see the JobHandler contract
// documented there.
export default handlePollBatch
