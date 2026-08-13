import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { withApiLogging } from '@/lib/api-log'
import {
  DEFAULT_TOKEN_TTL_HOURS,
  MAX_TOKEN_TTL_HOURS,
  mintScrapeToken,
  revokeScrapeToken,
} from '@/lib/scrape-token'

export const runtime = 'nodejs'

/**
 * Scrape-token management (MASTER-PLAN §17.23, Phase 3).
 *
 * Admin-only throughout: minting a credential that can submit an import is at
 * least as privileged as running one, and running one is admin-only (§4.4c).
 *
 * POST   mint a token — the plaintext is in the response and nowhere else
 * GET    list this admin's live tokens (prefix only, never the secret)
 * DELETE revoke one by id
 */

const mintSchema = z.object({
  sourceSystem: z.enum(['departmental', 'audit']),
  label: z.string().max(200).nullish(),
  ttlHours: z.number().int().min(1).max(MAX_TOKEN_TTL_HOURS).default(DEFAULT_TOKEN_TTL_HOURS),
})

/** Resolves the caller to an active admin, or returns the response to send. */
async function requireAdmin(): Promise<
  { ok: true; userId: string } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) }
  }

  const { data: profile, error } = await supabase
    .from('staff_profile')
    .select('role, is_active')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Could not verify staff role.' }, { status: 500 }),
    }
  }
  if (!profile || !profile.is_active || profile.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Only an active admin may manage scrape tokens.' },
        { status: 403 }
      ),
    }
  }

  return { ok: true, userId: user.id }
}

async function handlePOST(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = mintSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Invalid request.',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      { status: 400 }
    )
  }

  try {
    const minted = await mintScrapeToken({
      createdBy: auth.userId,
      sourceSystem: parsed.data.sourceSystem,
      label: parsed.data.label ?? null,
      ttlHours: parsed.data.ttlHours,
    })

    // `token` appears here and never again. The UI must show it once and tell
    // the operator to paste it into the bookmarklet immediately.
    return NextResponse.json(minted, {
      status: 201,
      // Belt and braces against an intermediary caching a response whose body
      // is a live credential.
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function handleGET() {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  // Read through the session client so scrape_token's admin-only RLS select
  // policy is the thing enforcing visibility, not this handler's own check
  // alone. token_hash is never selected.
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('scrape_token')
    .select('id, token_prefix, label, source_system, created_at, expires_at, last_used_at, use_count, revoked_at')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ error: 'Could not load scrape tokens.' }, { status: 500 })
  }

  return NextResponse.json({ tokens: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

async function handleDELETE(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const id = Number(request.nextUrl.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'Invalid token id.' }, { status: 400 })
  }

  try {
    await revokeScrapeToken(id, auth.userId)
    return NextResponse.json({ revoked: id })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const POST = withApiLogging('/api/scrape-token', handlePOST)
export const GET = withApiLogging('/api/scrape-token', handleGET)
export const DELETE = withApiLogging('/api/scrape-token', handleDELETE)
