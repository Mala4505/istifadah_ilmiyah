import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { serverEnv } from '@/lib/env.server'
import { drainJobQueue } from '@/lib/jobs/drain'
import { getStaffContext } from '@/lib/export/auth'

/**
 * The Vercel-side caller of the shared drain loop (MASTER-PLAN §3.11,
 * lib/jobs/drain.ts).
 *
 * On Hobby, Vercel Cron fires this at most once/day (the plan's own cap), so
 * this is a safety net, not the primary trigger — extraction is normally
 * attempted synchronously by app/api/documents/ingest/route.ts before it
 * responds to the upload. This route exists to catch anything that missed
 * (a job that failed and needs a retry pickup, a stale lock the sweep should
 * reclaim, etc.). worker/index.ts is a third caller —
 * an infinite loop instead of a bounded drain — and all three dispatch to the
 * *same* handler code in lib/jobs/handlers/, which is the whole point of
 * having a queue (§3.11's closing line).
 */

export const runtime = 'nodejs'
export const maxDuration = 60

/** Leave headroom under maxDuration so the response still gets sent. */
const DRAIN_BUDGET_MS = 50_000

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

  const workerId = `${serverEnv.WORKER_ID}-tick`
  const result = await drainJobQueue(workerId, DRAIN_BUDGET_MS, /* runSweep */ true)

  return NextResponse.json({ ok: true, workerId, ...result })
}

export const POST = drain
export const GET = drain
