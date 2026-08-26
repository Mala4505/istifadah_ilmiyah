import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SourceSystem } from '@/lib/import/portal-mapping'

/**
 * Short-lived bearer tokens for the portal-scrape bookmarklet
 * (MASTER-PLAN §17.23, Phase 3).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 *
 * The bookmarklet runs inside the PORTAL's page, on the portal's origin. The
 * Hub's session cookie is not sent with a cross-origin fetch, so the
 * bookmarklet cannot authenticate as the logged-in Hub user the way every
 * other write path does. It needs a credential it can carry itself.
 *
 * WHY NOT THE SUPABASE ACCESS TOKEN
 *
 * Because it would be pasted into a page the Hub does not control and cannot
 * audit. A Supabase JWT carries the operator's full Data-API rights; this
 * token authorises exactly one action — submit a scraped table for one source
 * system — expires in hours, and is revocable on its own without disturbing
 * the operator's login. Blast radius is the whole argument.
 *
 * WHY HASH-ONLY STORAGE
 *
 * Only SHA-256(token) is persisted. A database dump therefore yields nothing
 * usable, and the plaintext exists only in the operator's clipboard and in the
 * bookmarklet they saved. There is no recovery path — a lost token is
 * regenerated, never retrieved. That is the intended property, not a gap.
 *
 * SHA-256 rather than a slow KDF (bcrypt/argon2) is correct HERE and would not
 * be for a password: the token is 256 bits of `randomBytes` entropy, not a
 * human-chosen secret, so there is no dictionary to run and a work factor buys
 * nothing against an offline attacker. It also keeps verification to a single
 * indexed lookup on every scrape submission.
 * ---------------------------------------------------------------------------
 */

/** Bytes of entropy in a token. 32 bytes = 256 bits, base64url ~43 chars. */
const TOKEN_BYTES = 32

/**
 * Default lifetime. Portal imports for a given source system run in bursts
 * spread across weeks, so the token needs to outlive the whole campaign
 * rather than a single working day — a month covers that without the
 * operator having to re-mint and re-paste the bookmarklet mid-import.
 */
export const DEFAULT_TOKEN_TTL_HOURS = 24 * 30

/** Upper bound the API refuses to exceed, whatever the caller asks for. */
export const MAX_TOKEN_TTL_HOURS = 24 * 30

export interface MintedScrapeToken {
  /** Plaintext. Returned exactly once, at creation, and never stored. */
  token: string
  id: number
  tokenPrefix: string
  sourceSystem: SourceSystem
  expiresAt: string
}

export function hashScrapeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Creates a token for one source system and stores only its hash.
 *
 * The caller is responsible for having already established that the actor is
 * an active admin — this function deliberately does not re-check, so it cannot
 * be mistaken for the authorisation boundary. See app/api/scrape-token/route.ts
 * for the check that guards it.
 */
export async function mintScrapeToken(input: {
  createdBy: string
  sourceSystem: SourceSystem
  label?: string | null
  ttlHours?: number
}): Promise<MintedScrapeToken> {
  const ttlHours = Math.min(
    Math.max(input.ttlHours ?? DEFAULT_TOKEN_TTL_HOURS, 1),
    MAX_TOKEN_TTL_HOURS
  )

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString()

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('scrape_token')
    .insert({
      token_hash: hashScrapeToken(token),
      token_prefix: token.slice(0, 8),
      label: input.label ?? null,
      source_system: input.sourceSystem,
      created_by: input.createdBy,
      expires_at: expiresAt,
    })
    .select('id, token_prefix, source_system, expires_at')
    .single()

  if (error || !data) {
    throw new Error(`mintScrapeToken: could not create token — ${error?.message ?? 'no row returned'}`)
  }

  return {
    token,
    id: data.id as number,
    tokenPrefix: data.token_prefix as string,
    sourceSystem: data.source_system as SourceSystem,
    expiresAt: data.expires_at as string,
  }
}

export type ScrapeTokenRejection =
  | 'missing'
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'wrong_source_system'

export type VerifyScrapeTokenResult =
  | { ok: true; tokenId: number; createdBy: string; sourceSystem: SourceSystem; useCount: number }
  | { ok: false; reason: ScrapeTokenRejection }

/**
 * Verifies a presented token.
 *
 * Every rejection path returns the same shape and does the same amount of
 * work-shaped querying, and the caller maps ALL of them to one generic 401 —
 * telling a caller "that token is expired" rather than "that token does not
 * exist" confirms the token was real, which is a free oracle for anyone
 * testing leaked strings.
 *
 * `expectedSourceSystem` is checked here rather than trusted from the request
 * body: a token minted for the Departmental portal must not be usable to
 * submit rows claiming to be Audit rows, since the two write to different
 * columns on `entries`.
 */
export async function verifyScrapeToken(
  presented: string | null | undefined,
  expectedSourceSystem: SourceSystem
): Promise<VerifyScrapeTokenResult> {
  if (!presented) return { ok: false, reason: 'missing' }

  const token = presented.trim()
  // A base64url token of this length is the only shape ever issued; rejecting
  // anything else keeps obviously-junk input off the database entirely.
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return { ok: false, reason: 'malformed' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('scrape_token')
    .select('id, token_hash, source_system, created_by, expires_at, revoked_at, use_count')
    .eq('token_hash', hashScrapeToken(token))
    .maybeSingle()

  if (error || !data) return { ok: false, reason: 'unknown' }

  // The lookup above already matched on the hash, so this is belt-and-braces
  // against a future change that widens the query — but it costs nothing and
  // keeps the comparison constant-time regardless.
  const presentedHash = Buffer.from(hashScrapeToken(token), 'hex')
  const storedHash = Buffer.from(String(data.token_hash), 'hex')
  if (presentedHash.length !== storedHash.length || !timingSafeEqual(presentedHash, storedHash)) {
    return { ok: false, reason: 'unknown' }
  }

  if (data.revoked_at) return { ok: false, reason: 'revoked' }
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  if (data.source_system !== expectedSourceSystem) {
    return { ok: false, reason: 'wrong_source_system' }
  }

  return {
    ok: true,
    tokenId: data.id as number,
    createdBy: String(data.created_by),
    sourceSystem: data.source_system as SourceSystem,
    useCount: Number(data.use_count ?? 0),
  }
}

/**
 * Records a successful use. Best-effort: a failure here must not fail an
 * import that has otherwise succeeded, since this is provenance, not control.
 */
export async function recordScrapeTokenUse(tokenId: number, currentUseCount = 0): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin
      .from('scrape_token')
      .update({ last_used_at: new Date().toISOString(), use_count: currentUseCount + 1 })
      .eq('id', tokenId)
  } catch {
    // Provenance only.
  }
}

export async function revokeScrapeToken(tokenId: number, revokedBy: string): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin
    .from('scrape_token')
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy })
    .eq('id', tokenId)
    .is('revoked_at', null)

  if (error) throw new Error(`revokeScrapeToken: ${error.message}`)
}
