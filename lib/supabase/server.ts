import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { cache } from 'react'
import { publicEnv } from '@/lib/env'

export type MinimalAuthUser = { id: string; email: string | null }

/**
 * Server Supabase client — Server Components and Route Handlers only. Not
 * an admin/service-role client: this reads the same cookie-based session as
 * the browser and stays subject to RLS. A service-role client (for the
 * importer, which must cross department boundaries by design) is a
 * separate concern for whoever builds `app/api/import/route.ts` for real.
 *
 * Next.js 15's `cookies()` is async, so this function is async too — every
 * caller must `await createClient()`.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // `cookieStore.set()` only throws when Next's request-store phase
            // isn't 'action' -- i.e. we're in a Server Component (or
            // layout/page render), which cannot set cookies. Safe to ignore
            // there as long as middleware refreshes the session instead.
            //
            // Route Handlers and Server Actions run with phase 'action', so
            // this write does NOT throw for them -- it actually lands, and
            // Next's app-route module merges the resulting Set-Cookie headers
            // onto whatever Response the handler returns (see
            // `next/dist/server/route-modules/app-route/module.js`, "It's
            // possible cookies were set in the handler, so we need to merge
            // the modified cookies and the returned response here"). That's
            // what makes this same client safe to reuse, unmodified, from
            // `app/api/documents/status/route.ts` (perf remediation plan
            // 7.6) to refresh a poll-only session that middleware's
            // `/api/*`-excluded matcher never touches.
          }
        },
      },
    }
  )
}

/**
 * Perf remediation (docs/performance-remediation-plan.md, "Not doing" ->
 * asymmetric JWT verification, since landed): `getClaims()` verifies the
 * JWT locally against the project's cached JWKS when the project's signing
 * keys are asymmetric (ECC/RSA), with no network round trip. Under the
 * legacy HS256 shared secret it transparently falls back to a network call
 * identical to `getUser()` -- so this is a no-regression swap regardless of
 * which signing key mode the project is in, and gets strictly faster the
 * moment the project's keys are rotated to asymmetric (Supabase dashboard ->
 * Settings -> JWT Keys -> "Migrate JWT secret" then "Rotate keys"; confirmed
 * zero-downtime, non-expired tokens under the old secret keep verifying
 * during rotation).
 *
 * Every caller of `getCachedUser`/`getAuthUser` across the app only ever
 * reads `.id` (and, in one place, `.email`) off the result -- never the rest
 * of the Supabase Auth `User` shape -- so both return this minimal
 * `MinimalAuthUser` instead of the full object `getUser()` used to return.
 */
export async function getAuthUser(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<MinimalAuthUser | null> {
  const { data } = await supabase.auth.getClaims()
  if (!data) return null
  return { id: data.claims.sub, email: (data.claims.email as string | undefined) ?? null }
}

/**
 * Perf audit Phase 1.1 (docs/perf-ux-audit-checklist.md): every layout, page,
 * and `getStaffContext()` call used to run its own `supabase.auth.getUser()`
 * — 3-4 redundant round-trips per navigation, traced on `/entries/[id]` and
 * `/review`. React's `cache()` de-dupes calls within one request by identity
 * of this function + its (here, absent) arguments, so every caller below
 * this one in the same render gets the first call's answer instead of
 * issuing its own. Takes no `supabase` client argument on purpose — each
 * caller still creates its own client for its own queries, but a fresh
 * `createClient()` call is cheap (no I/O); only the auth check itself was
 * the redundant network round trip. Does NOT cover `middleware.ts`, which
 * runs in a separate Edge-runtime request lifecycle (see checklist note).
 */
export const getCachedUser = cache(async (): Promise<MinimalAuthUser | null> => {
  const supabase = await createClient()
  return getAuthUser(supabase)
})
