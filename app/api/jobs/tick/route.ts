import { NextResponse } from 'next/server'

// Stub only (MASTER-PLAN §10 file layout). Drains the Postgres job queue —
// Vercel Cron calls this now, worker/index.ts replaces it later with
// identical handler code. Depends on lib/jobs/queue.ts, which another
// agent is writing concurrently. Deliberately self-contained — no lib/
// imports.
export async function POST() {
  return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
}

export async function GET() {
  return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
}
