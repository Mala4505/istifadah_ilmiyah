'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { itsNumberSchema, itsNumberToLoginEmail } from '@/lib/auth/its'

export type LoginResult = { ok: true } | { ok: false; error: string }

const GENERIC_INVALID_CREDENTIALS = 'Incorrect ITS number or password.'
const RATE_LIMITED_MESSAGE = 'Too many failed attempts. Try again in a few minutes.'

async function requestIp(): Promise<string | null> {
  const headerList = await headers()
  // Windows Server deployment sits behind IIS as a reverse proxy (§4.4b);
  // Vercel sets the same header. Only the first hop is trusted (§13.2 — the
  // deploy target is never branched on beyond this kind of header lookup).
  const forwardedFor = headerList.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0]!.trim()
  return headerList.get('x-real-ip')
}

/** Fire-and-forget audit row — a logging failure must never block login. */
async function recordAttempt(itsNumber: string, ip: string | null, success: boolean) {
  try {
    const admin = createAdminClient()
    await admin.from('auth_login_attempt').insert({ its_number: itsNumber, ip, success })
  } catch {
    // Best-effort only.
  }
}

const RATE_LIMIT_WINDOW_MINUTES = 15
const MAX_FAILED_ATTEMPTS_PER_ITS = 10

// Per-IP protection counts DISTINCT ITS numbers, not raw failures. Many
// legitimate users share one public IP — an office behind a single NAT, and
// especially phones on mobile carrier-grade NAT (hundreds of unrelated users
// on one address; §5 has staff uploading bills from their phones). A raw
// per-IP failure cap locks out everyone at that location the moment a handful
// of them mistype a password around the same time, which is exactly what a
// rollout looks like. What actually signals an attack from one source is
// failures sprayed across many different accounts (credential stuffing / ITS
// sweep) — that is what this threshold catches, and shared-IP traffic from
// real users does not come close to it.
const MAX_FAILED_DISTINCT_ITS_PER_IP = 30
// Bounds the per-IP read. A real sweep trips the distinct-count threshold
// long before this many rows accumulate; legitimate traffic never gets here.
const IP_ATTEMPT_SCAN_LIMIT = 3000

/**
 * Two plain reads rather than a database function: `private` (where the
 * app's other SECURITY DEFINER helpers live) is deliberately never exposed
 * to PostgREST (20260808000002), so nothing there is reachable via
 * supabase-js's `.rpc()`. Locked out when EITHER window trips. Time-based,
 * not attempt-based, so a lockout can't be raced by succeeding once
 * elsewhere.
 */
async function isRateLimited(itsNumber: string, ip: string | null): Promise<boolean> {
  const admin = createAdminClient()
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString()

  const { count: itsFailures } = await admin
    .from('auth_login_attempt')
    .select('id', { count: 'exact', head: true })
    .eq('its_number', itsNumber)
    .eq('success', false)
    .gt('created_at', since)
  if ((itsFailures ?? 0) >= MAX_FAILED_ATTEMPTS_PER_ITS) return true

  if (ip) {
    // DISTINCT its_number, computed here: PostgREST has no COUNT(DISTINCT),
    // and the app keeps no callable RPC for this by design (see
    // 20260810000002_auth_login_attempt.sql).
    const { data: ipRows } = await admin
      .from('auth_login_attempt')
      .select('its_number')
      .eq('ip', ip)
      .eq('success', false)
      .gt('created_at', since)
      .limit(IP_ATTEMPT_SCAN_LIMIT)
    if (ipRows) {
      const distinctIts = new Set(ipRows.map((row) => row.its_number)).size
      if (distinctIts >= MAX_FAILED_DISTINCT_ITS_PER_IP) return true
    }
  }

  return false
}

/**
 * ITS-number login. The client never sees the synthetic email this maps
 * to — this server action resolves it, then hands off to Supabase Auth's
 * normal signInWithPassword, which is what actually issues/refreshes the
 * session's JWT access + refresh tokens (unchanged from before this
 * feature; see lib/supabase/server.ts and middleware.ts). Rate limiting is
 * app-owned defense-in-depth on top of that, checked BEFORE Supabase Auth
 * is ever called, so a lockout costs nothing extra against the hosted
 * project's own limits.
 */
export async function loginWithIts(itsNumber: string, password: string): Promise<LoginResult> {
  const parsedIts = itsNumberSchema.safeParse(itsNumber)
  if (!parsedIts.success) {
    return { ok: false, error: parsedIts.error.issues[0]!.message }
  }
  if (!password) {
    return { ok: false, error: 'Password is required.' }
  }
  const normalizedIts = parsedIts.data
  const ip = await requestIp()

  // Fails open on an infra error checking the limiter (isRateLimited throws
  // -> caught here) — a broken rate-limit check must not itself become the
  // outage. Supabase Auth's own built-in protection still applies underneath
  // regardless.
  try {
    if (await isRateLimited(normalizedIts, ip)) {
      return { ok: false, error: RATE_LIMITED_MESSAGE }
    }
  } catch {
    // Proceed to the real sign-in attempt below.
  }

  const supabase = await createClient()
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: itsNumberToLoginEmail(normalizedIts),
    password,
  })

  if (signInError || !signInData.user) {
    await recordAttempt(normalizedIts, ip, false)
    return { ok: false, error: GENERIC_INVALID_CREDENTIALS }
  }

  const { data: profile, error: profileError } = await supabase
    .from('staff_profile')
    .select('is_active')
    .eq('id', signInData.user.id)
    .maybeSingle()

  if (profileError) {
    console.warn('[login] staff_profile check failed:', profileError.message)
  } else if (profile && profile.is_active === false) {
    await supabase.auth.signOut()
    await recordAttempt(normalizedIts, ip, false)
    return { ok: false, error: 'Your account is pending activation. Ask an administrator to activate it.' }
  }

  await recordAttempt(normalizedIts, ip, true)
  return { ok: true }
}

/** Bound directly to the nav rail's sign-out `<form action>` — no client
 * round-trip needed, the redirect happens server-side once the session
 * cookie is cleared. */
export async function signOut(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
