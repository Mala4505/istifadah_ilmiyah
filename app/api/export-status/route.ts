import { NextResponse } from 'next/server'

// Stub only (MASTER-PLAN §10 file layout). The real handler transforms
// entry fields into module shape and produces a .xlsx batch, and depends
// on lib/module-mapping.ts, which another agent is writing concurrently.
// Deliberately self-contained — no lib/ imports.
export async function POST() {
  return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
}

export async function GET() {
  return NextResponse.json({ error: 'not implemented yet' }, { status: 501 })
}
