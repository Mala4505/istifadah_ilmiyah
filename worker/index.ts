/**
 * worker/index.ts
 *
 * Unused on Vercel — Vercel Cron calls /api/jobs/tick instead (MASTER-PLAN
 * §3.11). This becomes the Windows Service `istifadah-ilmiyah-worker` on
 * cutover (§13).
 *
 * Standalone Node process: loop { claim job; run handler }. This is the
 * SECOND of the "one worker loop, two ways to run it" callers described in
 * §3.11 — app/api/jobs/tick/route.ts is the first. Both callers claim a job
 * from the same `job_queue` table via lib/jobs/queue.ts and dispatch to the
 * same handler code in lib/jobs/handlers/; only the caller differs (a Vercel
 * Cron invocation that drains for ~50s and returns, vs this process's
 * infinite loop). Keeping the handlers identical is the whole point of the
 * queue — see §3.11's closing line.
 *
 * Run locally with `npm run worker` (tsx watch worker/index.ts).
 * Run in production (post-cutover) as the Windows Service `istifadah-ilmiyah-worker`.
 */

import * as Sentry from '@sentry/nextjs'
import { serverEnv } from '@/lib/env.server'
import { publicEnv } from '@/lib/env'
import { claimNextJob } from '@/lib/jobs/queue'

// This is a standalone Node process (not booted through Next.js), so it
// doesn't go through instrumentation.ts — it needs its own Sentry.init(),
// same DSN source and empty-DSN guard as sentry.server.config.ts (§2,
// §11.1 Day 7: "day-7 failures are invisible" without this).
Sentry.init({
  dsn: publicEnv.NEXT_PUBLIC_SENTRY_DSN || undefined,
  enabled: publicEnv.NEXT_PUBLIC_SENTRY_DSN !== '',
  tracesSampleRate: 0.1,
})

// ---------------------------------------------------------------------------
// Shape of a row in public.job_queue (MASTER-PLAN §3.11). Defined locally
// rather than imported so this file has no compile-time dependency on how
// lib/jobs/queue.ts (owned by another agent, may not exist yet) chooses to
// export its types. Once that module lands, this can be swapped for
// `import type { JobQueueRow } from '@/lib/jobs/queue'` if it exports one
// with this shape.
// ---------------------------------------------------------------------------
export interface JobQueueRow {
  id: number
  job_type: 'extract_document' | 'poll_batch' | 'generate_export' | 'rasterize_retry'
  payload: Record<string, unknown>
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead'
  priority: number
  attempts: number
  max_attempts: number
  run_after: string
  locked_by: string | null
  locked_at: string | null
  last_error: string | null
  created_at: string
  completed_at: string | null
}

/**
 * Contract assumed for every handler module under lib/jobs/handlers/: a
 * default export that takes the claimed job row and does the work,
 * including marking the job succeeded/failed against the queue (that's
 * "identical handler code" per §3.11 — completion bookkeeping lives in the
 * handler, not the caller, so /api/jobs/tick and this loop can both call it
 * the same way). If the real handler exports differently once written,
 * update the two dynamic imports below — nothing else in this file needs
 * to change.
 */
type JobHandler = (job: JobQueueRow) => Promise<void>

// How long to sleep after an empty poll (no queued job found) before
// checking again. Keeps the loop from hammering Postgres when idle.
const EMPTY_POLL_BACKOFF_MS = 2000

// How long to sleep after a job-claim/handler error before retrying, so a
// persistent failure (e.g. DB unreachable) doesn't spin the CPU.
const ERROR_BACKOFF_MS = 5000

let shuttingDown = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function dispatch(job: JobQueueRow): Promise<void> {
  switch (job.job_type) {
    case 'extract_document': {
      const { default: handleExtractDocument } = (await import(
        '@/lib/jobs/handlers/extract'
      )) as { default: JobHandler }
      await handleExtractDocument(job)
      return
    }
    case 'poll_batch': {
      const { default: handlePollBatch } = (await import(
        '@/lib/jobs/handlers/batch-poll'
      )) as { default: JobHandler }
      await handlePollBatch(job)
      return
    }
    case 'generate_export':
    case 'rasterize_retry':
      // Not implemented yet — log and skip rather than claiming and
      // silently dropping. The job stays 'running'/locked until the
      // sweeper (§3.11) reclaims it, which is preferable to marking it
      // failed for a handler that was never attempted.
      console.log(
        `[worker] job ${job.id} (${job.job_type}) has no handler wired yet — skipping`
      )
      return
    default: {
      // Exhaustiveness guard in case job_type grows without this switch
      // being updated.
      const unknown: never = job.job_type
      console.warn(`[worker] unrecognized job_type: ${String(unknown)} — skipping`)
      return
    }
  }
}

async function loopOnce(): Promise<'claimed' | 'empty'> {
  const job = await claimNextJob(serverEnv.WORKER_ID)
  if (!job) {
    return 'empty'
  }

  console.log(`[worker] claimed job ${job.id} (${job.job_type}), attempt ${job.attempts}`)
  try {
    await dispatch(job)
    console.log(`[worker] finished job ${job.id}`)
  } catch (err) {
    // Handlers are expected to record their own failure state against the
    // job row (see JobHandler contract above); this catch exists so a bug
    // in a handler can't take the whole worker process down. Reported to
    // Sentry with job type/id as context — this is exactly the "day-7
    // failures are invisible" scenario §2 calls out.
    console.error(`[worker] job ${job.id} threw unhandled error:`, err)
    Sentry.captureException(err, {
      tags: { job_type: job.job_type, job_id: String(job.id) },
      extra: { attempts: job.attempts, payload: job.payload },
    })
  }
  return 'claimed'
}

async function main(): Promise<void> {
  console.log(`[worker] starting — worker id = ${serverEnv.WORKER_ID}`)

  while (!shuttingDown) {
    let outcome: 'claimed' | 'empty'
    try {
      outcome = await loopOnce()
    } catch (err) {
      console.error('[worker] error claiming next job:', err)
      Sentry.captureException(err, { tags: { job_type: 'claim_next_job' } })
      await sleep(ERROR_BACKOFF_MS)
      continue
    }

    if (outcome === 'empty' && !shuttingDown) {
      await sleep(EMPTY_POLL_BACKOFF_MS)
    }
  }

  console.log('[worker] shut down cleanly')
}

function requestShutdown(signal: string): void {
  if (shuttingDown) return
  console.log(`[worker] received ${signal}, finishing current job then exiting...`)
  shuttingDown = true
}

process.on('SIGINT', () => requestShutdown('SIGINT'))
process.on('SIGTERM', () => requestShutdown('SIGTERM'))

main().catch(async (err) => {
  console.error('[worker] fatal error:', err)
  Sentry.captureException(err, { tags: { job_type: 'worker_fatal' } })
  await Sentry.flush(2000)
  process.exit(1)
})
