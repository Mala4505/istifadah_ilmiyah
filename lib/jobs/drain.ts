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
import { claimNextJob, failJob, sweepJobQueue, type JobQueueRow } from '@/lib/jobs/queue'

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
    default:
      // No handler wired yet (generate_export, rasterize_retry) — left
      // running for sweepJobQueue() to reclaim once stale, same reasoning as
      // worker/index.ts's dispatch().
      return 'skipped'
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
