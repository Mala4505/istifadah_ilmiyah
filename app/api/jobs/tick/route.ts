import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { serverEnv } from '@/lib/env.server'
import { drainJobQueue } from '@/lib/jobs/drain'
import { getStaffContext } from '@/lib/export/auth'
import { isAdminOrAbove } from '@/lib/auth/roles'
import { originProblem } from '@/lib/http-guards'
import { publicEnv } from '@/lib/env'

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
 * Who may drain the queue (security-audit-fix-plan.md 4.3):
 *  - the cron secret (`Authorization: Bearer <CRON_SECRET>`), on GET or POST --
 *    Vercel Cron sends GET, curl/other schedulers may send POST;
 *  - an admin session, on POST ONLY. GET is a "safe" method that a browser
 *    navigates to, an <img src> can trigger, or a link prefetch can hit with the
 *    admin's cookies attached, so a cookie must never authorise it. A session
 *    POST must also come from our own origin (cross-site request forgery).
 * CRON_SECRET is read straight from process.env rather than lib/env.server's
 * schema so that deployments without it keep working (they use the admin check).
 */
async function authorize(request: NextRequest): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    // Constant-time compare; hashing first gives both sides equal length.
    const sha = (s: string) => createHash('sha256').update(s).digest()
    const header = request.headers.get('authorization') ?? ''
    if (timingSafeEqual(sha(header), sha(`Bearer ${cronSecret}`))) return { ok: true }
  }

  if (request.method !== 'POST') {
    return { ok: false, status: 401, error: 'This endpoint needs the scheduler’s secret.' }
  }

  const problem = originProblem(request.headers, publicEnv.NEXT_PUBLIC_SITE_URL)
  if (problem) return { ok: false, status: problem.status, error: problem.error }

  const staff = await getStaffContext()
  if (!staff) return { ok: false, status: 401, error: 'You must be signed in.' }
  if (!staff.isActive) return { ok: false, status: 403, error: 'Your account is pending activation.' }
  if (!isAdminOrAbove(staff.role)) {
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
