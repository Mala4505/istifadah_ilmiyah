/**
 * `flags_run` job handler — Phase 2 analytics engine, the sweep that turns
 * detector output (lib/analytics/rules/) into rows in `public.flags`.
 *
 * Unlike `extract_document`, this job is not triggered by an event — there is
 * no natural "a flags-run happened" moment the way there is "a document was
 * uploaded". It is a whole-corpus sweep that makes itself recurring: on
 * success it re-inserts its own next run with `run_after` pushed into the
 * future, then marks itself succeeded. That reuses the exact claim mechanism
 * §3.11 already defines (`FOR UPDATE SKIP LOCKED` on `run_after <= now()`)
 * instead of adding a second scheduling system next to the job queue.
 *
 * JUDGEMENT CALL: full recompute every run, not incremental. At Phase 2's
 * assumed scale (~200 documents, MASTER-PLAN §14) reading every verified
 * document and every vendor's payment history on each sweep is cheap, and
 * `upsert_flag`'s dedup-key upsert (20260814000003/000004) already makes a
 * full recompute idempotent — a flag that still applies is refreshed in place,
 * one that no longer applies simply is not re-proposed (existing open flags
 * for conditions that resolved are left for a human to close, not
 * auto-dismissed — the code has no way to distinguish "the vendor fixed it"
 * from "we stopped looking"). Revisit for incremental scanning if the corpus
 * grows enough that a full sweep becomes the bottleneck.
 */

import 'server-only'
import { completeJob, failJob, type JobQueueRow } from '@/lib/jobs/queue'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchDocumentFacts, fetchVendorFacts } from '@/lib/analytics/fetch'
import { runComplianceDetectors } from '@/lib/analytics/rules/compliance'
import { runVendorDetectors } from '@/lib/analytics/rules/vendor-patterns'
import type { FlagProposal } from '@/lib/analytics/types'

/** How long after a successful sweep before the next one is due. */
const RECURRENCE_MINUTES = 15

export interface FlagsRunResult {
  documentsScanned: number
  vendorsScanned: number
  proposalsWritten: number
  proposalsFailed: number
  runId: string
}

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Runs every detector over the current corpus and upserts every proposal.
 * Exported separately from the job handler (same split as extractAndPersist in
 * lib/jobs/handlers/extract.ts) so an admin-triggered manual sweep can call
 * exactly this path without going through the queue.
 */
export async function runFlagsSweep(admin: AdminClient, runId: string): Promise<FlagsRunResult> {
  const [documents, vendors] = await Promise.all([
    fetchDocumentFacts(admin),
    fetchVendorFacts(admin),
  ])

  const proposals: FlagProposal[] = [
    ...documents.flatMap((doc) => runComplianceDetectors(doc)),
    ...vendors.flatMap((vendor) => runVendorDetectors(vendor)),
  ]

  let written = 0
  let failed = 0
  const errors: string[] = []

  // Sequential, not Promise.all: the number of proposals per sweep is small at
  // Phase 2 scale, and upsert_flag hits the same table repeatedly — running
  // them one at a time is simpler to reason about than tuning a concurrency
  // limit for a job that runs every 15 minutes regardless.
  for (const proposal of proposals) {
    const { error } = await admin.rpc('upsert_flag', {
      p_flag_type: proposal.flagType,
      p_dedup_key: proposal.dedupKey,
      p_description: proposal.description,
      p_severity: proposal.severity,
      p_entry_id: proposal.entryId ?? null,
      p_related_entry_ids: proposal.relatedEntryIds ?? null,
      p_vendor_id: proposal.vendorId ?? null,
      p_amount_at_risk: proposal.amountAtRisk ?? null,
      p_evidence: proposal.evidence ?? null,
      p_detected_by_run: runId,
    })

    if (error) {
      failed++
      errors.push(`${proposal.dedupKey}: ${error.message}`)
    } else {
      written++
    }
  }

  if (errors.length > 0) {
    // Individual upsert failures do not fail the whole sweep — one malformed
    // proposal should not block every other detector's findings from
    // landing. They are surfaced in the log line the job handler writes below.
    console.error(`[flags-run] ${errors.length} upsert_flag call(s) failed:`, errors.slice(0, 10))
  }

  return {
    documentsScanned: documents.length,
    vendorsScanned: vendors.length,
    proposalsWritten: written,
    proposalsFailed: failed,
    runId,
  }
}

/** Inserts the next scheduled run. Mirrors the payload shape any other flags_run row uses. */
async function scheduleNextRun(admin: AdminClient): Promise<void> {
  const runAfter = new Date(Date.now() + RECURRENCE_MINUTES * 60_000).toISOString()
  const { error } = await admin.from('job_queue').insert({
    job_type: 'flags_run',
    payload: {},
    run_after: runAfter,
  })
  if (error) {
    // Not re-thrown: failing to schedule the NEXT run must not turn THIS run's
    // successful sweep into a failed job. Losing recurrence here means the
    // sweep goes quiet until someone notices and re-seeds it manually — worth
    // knowing about, not worth discarding a completed sweep's results over.
    console.error(`[flags-run] failed to schedule next run: ${error.message}`)
  }
}

/**
 * The JobHandler contract from worker/index.ts: take the claimed row, do the
 * work, and mark the job succeeded/failed against the queue.
 */
export async function handleFlagsRun(job: JobQueueRow): Promise<void> {
  const admin = createAdminClient()
  const runId = `flags_run:${job.id}`

  try {
    const result = await runFlagsSweep(admin, runId)
    console.log(
      `[flags-run] job ${job.id}: docs=${result.documentsScanned} vendors=${result.vendorsScanned} ` +
        `written=${result.proposalsWritten} failed=${result.proposalsFailed}`
    )
    await scheduleNextRun(admin)
    await completeJob(job.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[flags-run] job ${job.id} failed:`, message)
    // Even a failed sweep re-schedules itself — a single bad run (e.g. a
    // transient DB error) should not silently end recurrence. The job-queue
    // sweeper's retry/backoff (§3.11) handles THIS attempt; scheduleNextRun
    // guarantees there is always a future attempt queued regardless of how
    // this one resolves.
    await scheduleNextRun(admin)
    await failJob(job.id, message.slice(0, 2000))
  }
}

export default handleFlagsRun
