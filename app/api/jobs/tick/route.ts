import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { serverEnv } from '@/lib/env.server'
import { claimNextJob, failJob, type JobQueueRow } from '@/lib/jobs/queue'
import { getStaffContext } from '@/lib/export/auth'

/**
 * The Vercel-side caller of the one worker loop (MASTER-PLAN §3.11).
 *
 * A Cron entry calls this every minute; it drains the queue for ~50 seconds
 * and returns, staying inside Vercel Pro's function limit. worker/index.ts is
 * the other caller — an infinite loop instead of a bounded drain — and both
 * dispatch to the *same* handler code in lib/jobs/handlers/, which is the
 * whole point of having a queue (§3.11's closing line).
 *
 * The dispatch table below mirrors worker/index.ts exactly; if a job type
 * gains a handler there, add it here too.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

type JobHandler = (job: JobQueueRow) => Promise<void>

/** Leave headroom under maxDuration so the response still gets sent. */
const DRAIN_BUDGET_MS = 50_000

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
    default:
      // No handler wired yet (generate_export, rasterize_retry). Marking the
      // job failed would be a lie about a handler that was never attempted,
      // so it is left running for the sweeper to reclaim (§3.11).
      return 'skipped'
  }
}

/**
 * Cron secret when one is configured, otherwise an admin session. Vercel Cron
 * sends `Authorization: Bearer <CRON_SECRET>`; CRON_SECRET is read straight
 * from process.env rather than lib/env.server's schema so that deployments
 * without it keep working (they fall back to the admin check).
 */
async function authorize(request: NextRequest): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const header = request.headers.get('authorization')
    if (header === `Bearer ${cronSecret}`) return { ok: true }
  }

  const staff = await getStaffContext()
  if (!staff) return { ok: false, status: 401, error: 'You must be signed in.' }
  if (!staff.isActive) return { ok: false, status: 403, error: 'Your account is pending activation.' }
  if (staff.role !== 'admin') {
    return { ok: false, status: 403, error: 'Draining the job queue is an admin-only action.' }
  }
  return { ok: true }
}

async function drain(request: NextRequest) {
  const gate = await authorize(request)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const deadline = Date.now() + DRAIN_BUDGET_MS
  const workerId = `${serverEnv.WORKER_ID}-tick`

  let claimed = 0
  let handled = 0
  let skipped = 0
  const errors: string[] = []

  while (Date.now() < deadline) {
    let job: JobQueueRow | null
    try {
      job = await claimNextJob(workerId)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
      Sentry.captureException(err, { tags: { job_type: 'tick', phase: 'claim' } })
      break
    }
    if (!job) break

    claimed++
    try {
      const outcome = await dispatch(job)
      if (outcome === 'handled') handled++
      else skipped++
    } catch (err) {
      // Handlers record their own failure state; this catch only exists so one
      // bad job can't abort the whole drain.
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

  return NextResponse.json({ ok: true, workerId, claimed, handled, skipped, errors })
}

export const POST = drain
export const GET = drain
