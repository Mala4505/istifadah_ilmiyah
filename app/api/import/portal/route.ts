import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient, getAuthUser } from '@/lib/supabase/server'
import { withApiLogging } from '@/lib/api-log'
import { canonicalPayloadHash, runPortalImport, type ScrapePayload } from '@/lib/import/run-portal-import'
import { recordScrapeTokenUse, verifyScrapeToken } from '@/lib/scrape-token'
import { isAdminOrAbove } from '@/lib/auth/roles'

export const runtime = 'nodejs'
// Missing until 2026-09-27 -- this route was falling back to the platform's
// much shorter default, so a large scrape (this path does a SAVEPOINT +
// RELEASE round trip per row on top of the resolver/upsert round trips
// lib/import/route.ts's own maxDuration comment already accounts for) got
// killed mid-request. The kill returns a non-JSON error page, which fails
// res.json() on the client and surfaces as "Could not reach the server" --
// indistinguishable from a real network drop, which is what actually sent us
// looking for this. Matches the .xlsx path's own ceiling (see that file's
// comment for why 180s is the right number under Vercel Pro's 300s cap);
// this route's per-row cost is currently higher, not lower, so it gets no
// less headroom. Still just a ceiling -- see the per-row SAVEPOINT comment
// below for the real fix this route needs.
export const maxDuration = 180

/**
 * Portal-scrape ingest (MASTER-PLAN §17.23, Phase 3 item 1).
 *
 * Accepts the `{ headers, rows }` payload the bookmarklet reads out of an
 * already-logged-in portal tab and hands it to lib/import/run-portal-import.ts.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS IN, ON PURPOSE
 *
 * 1. Bearer scrape token (`Authorization: Bearer <token>`) — the bookmarklet.
 *    It runs on the PORTAL's origin, so no Hub cookie is sent and no session
 *    exists to read. The token is the whole credential; see lib/scrape-token.ts
 *    for why it is deliberately narrower than the operator's session.
 *
 * 2. Hub session cookie — the paste/upload fallback inside the Hub's own UI,
 *    for when a portal's CSP blocks the bookmarklet's fetch. Same admin-only
 *    rule as /api/import (§4.4c).
 *
 * A request carrying a valid token is NOT additionally required to have a
 * session, and vice versa. Both paths converge on the same importer.
 *
 * CORS
 *
 * The preflight is answered for any origin, because the set of portal origins
 * is not known here and changes when a portal moves. That is safe precisely
 * because authorisation is a bearer token and never a cookie:
 * `Access-Control-Allow-Credentials` is never sent, so a hostile page can
 * reach this endpoint only if it already holds a valid token — at which point
 * CORS was never the control that mattered. Reflecting the origin rather than
 * sending `*` keeps the response uncacheable across origins by shared proxies.
 * ---------------------------------------------------------------------------
 */

/**
 * Caps. A portal table is hundreds of rows, not hundreds of thousands; these
 * bound the work a single valid token can ask for, since the request body is
 * parsed and held in memory before any of it is validated.
 */
const MAX_ROWS = 20_000
const MAX_COLUMNS = 100
const MAX_CELL_LENGTH = 2_000

const payloadSchema = z.object({
  sourceSystem: z.enum(['departmental', 'audit']),
  headers: z.array(z.string().max(MAX_CELL_LENGTH)).min(1).max(MAX_COLUMNS),
  rows: z.array(z.array(z.string().max(MAX_CELL_LENGTH)).max(MAX_COLUMNS)).max(MAX_ROWS),
  sourceUrl: z.string().max(2_000).nullish(),
  scraperVersion: z.string().max(100).nullish(),
  scrapedAt: z.string().max(100).nullish(),
  mode: z.enum(['dry_run', 'commit']).default('dry_run'),
  // Chunk metadata (components/import/import-workspace.tsx), never part of
  // ScrapePayload/canonicalPayloadHash — see run-portal-import.ts's
  // RunPortalImportParams for what these mean and supabase/migrations/
  // 20260927000001 for why the server needs them at all.
  scrapeSessionId: z.string().max(100).nullish(),
  isFinalChunk: z.boolean().nullish(),
})

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin')
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(request: NextRequest, body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1]!.trim() : null
}

async function handlePOST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(request, { error: 'Expected a JSON body.' }, 400)
  }

  const parsed = payloadSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      request,
      {
        error: 'Invalid scrape payload.',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      400
    )
  }

  const { mode, scrapeSessionId, isFinalChunk, ...payloadFields } = parsed.data
  const payload: ScrapePayload = {
    sourceSystem: payloadFields.sourceSystem,
    headers: payloadFields.headers,
    rows: payloadFields.rows,
    sourceUrl: payloadFields.sourceUrl ?? null,
    scraperVersion: payloadFields.scraperVersion ?? null,
    scrapedAt: payloadFields.scrapedAt ?? null,
  }

  // ---- authorise: bearer token, else Hub session -------------------------
  let importedBy: string | null = null
  const token = bearerToken(request)

  if (token) {
    const verified = await verifyScrapeToken(token, payload.sourceSystem)
    if (!verified.ok) {
      // Every rejection reason collapses to one message on purpose — see
      // lib/scrape-token.ts. "Expired" vs "unknown" would confirm which
      // strings are real tokens.
      return json(request, { error: 'Invalid or expired scrape token.' }, 401)
    }
    importedBy = verified.createdBy
    await recordScrapeTokenUse(verified.tokenId, verified.useCount)
  } else {
    const supabase = await createClient()
    const user = await getAuthUser(supabase)

    if (!user) {
      return json(request, { error: 'Not authenticated.' }, 401)
    }

    const { data: profile, error: profileError } = await supabase
      .from('staff_profile')
      .select('role, is_active')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      return json(request, { error: 'Could not verify staff role.' }, 500)
    }
    if (!profile || !profile.is_active || !isAdminOrAbove(profile.role)) {
      return json(
        request,
        { error: 'Only an active admin may run an import.' },
        403
      )
    }
    importedBy = user.id
  }

  if (payload.rows.length === 0) {
    return json(
      request,
      {
        error:
          'The scrape found no rows. Open the portal table, make sure at least one row is on screen, then run the bookmarklet again.',
      },
      400
    )
  }

  try {
    const result = await runPortalImport({
      payload,
      fileHashSha256: canonicalPayloadHash(payload),
      filename: `${payload.sourceSystem}-portal-scrape`,
      mode,
      importedBy,
      scrapeSessionId: scrapeSessionId ?? null,
      isFinalChunk: isFinalChunk ?? undefined,
    })

    // Always 200 -- see the identical comment in app/api/import/route.ts.
    // `result` already carries `status: 'failed'` plus `errorMessage`/`rowLog`
    // when something in the data (not the request) went wrong; forcing a 500
    // used to make the Import page and the bookmarklet both discard that body
    // for a generic "Commit failed." / "portal is blocking the connection"
    // message instead of showing the operator what actually happened.
    return json(request, result, 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json(request, { error: `Portal import failed: ${message}` }, 500)
  }
}

export const POST = withApiLogging('/api/import/portal', handlePOST)
