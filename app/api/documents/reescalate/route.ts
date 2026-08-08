import { NextResponse } from 'next/server'

// Stub only (MASTER-PLAN §10 file layout). The real handler depends on
// lib/jobs/* and lib/claude-client.ts, which another agent is writing
// concurrently. Deliberately self-contained — no lib/ imports.
export async function POST() {
  return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
}
