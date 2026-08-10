import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'

// Stub only (MASTER-PLAN §10 file layout). Drains the Postgres job queue —
// Vercel Cron calls this now, worker/index.ts replaces it later with
// identical handler code. Depends on lib/jobs/queue.ts, which another
// agent is writing concurrently. Deliberately self-contained — no lib/
// imports (other than Sentry, wired in per §2/§11.1 Day 7).
//
// Sentry is already initialized process-wide via instrumentation.ts, so no
// Sentry.init() call belongs here. The try/catch below is scaffolding for
// whoever wires up the real drain loop (worker/index.ts's `dispatch`/
// `loopOnce` shape is the reference): wrap each claimed job's handling the
// same way worker/index.ts does, and pass `{ tags: { job_type, job_id } }`
// to Sentry.captureException so a failed tick reports which job it was.
export async function POST() {
  try {
    return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
  } catch (err) {
    Sentry.captureException(err, { tags: { job_type: 'tick' } })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}

export async function GET() {
  try {
    return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
  } catch (err) {
    Sentry.captureException(err, { tags: { job_type: 'tick' } })
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
