/**
 * Shared claim/dispatch/budget loop for the job queue (MASTER-PLAN §3.11).
 *
 * Two callers need the exact same "claim a job, dispatch it, repeat until the
 * queue is empty or a time budget runs out" logic:
 *   - app/api/jobs/tick/route.ts — the Vercel Cron safety net. On the Hobby
 *     plan cron fires at most once/day, so this is a backstop, not the
 *     primary trigger.
 *   - app/api/documents/ingest/route.ts — fires this from a Next.js after()
 *     callback right after enqueueing a fresh extract_document job, so
 *     extraction starts as soon as a document is uploaded instead of waiting
 *     for the next cron tick.
 *
 * Both go through claim_next_job's `for update skip locked` (lib/jobs/queue.ts),
 * so concurrent drains — an upload's after() overlapping the daily cron tick,
 * or several uploads landing at once — can never claim the same row twice.
 */

import 'server-only'
import * as Sentry from '@sentry/nextjs'
import { claimJobById, claimNextJob, failJob, sweepJobQueue, type JobQueueRow } from '@/lib/jobs/queue'

type JobHandler = (job: JobQueueRow) => Promise<void>

async function dispatch(job: JobQueueRow): Promise<'handled' | 'skipped'> {
  switch (job.job_type) {
    case 'extract_document': {
      const { default: handler } = (await import('@/lib/jobs/handlers/extract')) as {
        default: JobHandler
      }
      await handler(job)
      return 'handled'
    }
    case 'poll_batch': {
      const { default: handler } = (await import('@/lib/jobs/handlers/batch-poll')) as {
        default: JobHandler
      }
      await handler(job)
      return 'handled'
    }
    case 'flags_run': {
      const { default: handler } = (await import('@/lib/jobs/handlers/flags-run')) as {
        default: JobHandler
      }
      await handler(job)
      return 'handled'
    }
    case 'board_pack': {
      const { default: handler } = (await import('@/lib/jobs/handlers/board-pack')) as {
        default: JobHandler
      }
      await handler(job)
      return 'handled'
    }
    default:
      // No handler wired yet (generate_export, rasterize_retry) — left
      // running for sweepJobQueue() to reclaim once stale, same reasoning as
      // worker/index.ts's dispatch().
      return 'skipped'
  }
}

/**
 * Runs ONE known job to completion, ahead of any backlog — the post-upload
 * path in app/api/documents/ingest/route.ts.
 *
 * Shares `dispatch` (and therefore the handler wiring) with `drainJobQueue`
 * below; the only difference is which row gets claimed. See `claimJobById`
 * (lib/jobs/queue.ts) for why the upload path must not go through
 * `claim_next_job`'s oldest-first ordering.
 *
 * Returns what happened, for logging. Never throws: a handler that blows up
 * records its own failure against the job row (the JobHandler contract in
 * worker/index.ts), and this adds the same `failJob` backstop `drainJobQueue`
 * uses, so one bad document can't turn a successful upload into a 500.
 */
export async function runJobById(
  workerId: string,
  jobId: number
): Promise<'handled' | 'skipped' | 'unavailable' | 'failed'> {
  let job: JobQueueRow | null
  try {
    job = await claimJobById(jobId, workerId)
  } catch (err) {
    Sentry.captureException(err, { tags: { job_type: 'drain', phase: 'claim_by_id' } })
    return 'failed'
  }
  // Already claimed by a concurrent drain or the cron tick — not an error, and
  // specifically not something to retry here: whoever holds it is running it.
  if (!job) return 'unavailable'

  try {
    return await dispatch(job)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    Sentry.captureException(err, {
      tags: { job_type: job.job_type, job_id: String(job.id) },
    })
    try {
      await failJob(job.id, message.slice(0, 2000))
    } catch {
      // Already reported above; nothing further to do.
    }
    return 'failed'
  }
}

export interface DrainResult {
  sweep: { reclaimedCount: number; deadenedCount: number; purgedCount: number } | null
  claimed: number
  handled: number
  skipped: number
  errors: string[]
}

/**
 * Claims and dispatches queued jobs one at a time until the queue is empty or
 * `budgetMs` elapses. `runSweep` is on for the cron tick (its one scheduled
 * chance to reclaim stale rows) and off for the per-upload trigger — no need
 * to run a full-table sweep on every single upload when the daily tick
 * already covers it.
 */
export async function drainJobQueue(
  workerId: string,
  budgetMs: number,
  runSweep: boolean
): Promise<DrainResult> {
  const deadline = Date.now() + budgetMs
  let claimed = 0
  let handled = 0
  let skipped = 0
  const errors: string[] = []

  let sweep: DrainResult['sweep'] = null
  if (runSweep) {
    try {
      sweep = await sweepJobQueue()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`sweep: ${message}`)
      Sentry.captureException(err, { tags: { job_type: 'drain', phase: 'sweep' } })
    }
  }

  while (Date.now() < deadline) {
    let job: JobQueueRow | null
    try {
      job = await claimNextJob(workerId)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
      Sentry.captureException(err, { tags: { job_type: 'drain', phase: 'claim' } })
      break
    }
    if (!job) break

    claimed++
    try {
      const outcome = await dispatch(job)
      if (outcome === 'handled') handled++
      else skipped++
    } catch (err) {
      // Handlers record their own failure state against the job row; this
      // catch only exists so one bad job can't abort the whole drain.
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`job ${job.id}: ${message}`)
      Sentry.captureException(err, {
        tags: { job_type: job.job_type, job_id: String(job.id) },
      })
      try {
        await failJob(job.id, message.slice(0, 2000))
      } catch {
        // Already logged above; nothing further to do.
      }
    }
  }

  return { sweep, claimed, handled, skipped, errors }
}
