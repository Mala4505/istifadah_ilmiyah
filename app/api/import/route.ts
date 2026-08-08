import { NextResponse } from 'next/server'

// Stub only (MASTER-PLAN §10 file layout). The real handler is
// parameterized by source_system and dry_run | commit, and depends on
// lib/module-mapping.ts, which another agent is writing concurrently.
// Deliberately self-contained — no lib/ imports — so this route has no
// cross-agent file dependency today.
export async function POST() {
  return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
}

export async function GET() {
  return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
}
