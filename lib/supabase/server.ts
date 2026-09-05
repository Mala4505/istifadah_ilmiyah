import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { cache } from 'react'
import { publicEnv } from '@/lib/env'

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
 * Perf audit Phase 1.1 (docs/perf-ux-audit-checklist.md): every layout, page,
 * and `getStaffContext()` call used to run its own `supabase.auth.getUser()`
 * — 3-4 redundant round-trips per navigation, traced on `/entries/[id]` and
 * `/review`. React's `cache()` de-dupes calls within one request by identity
 * of this function + its (here, absent) arguments, so every caller below
 * this one in the same render gets the first call's answer instead of
 * issuing its own. Takes no `supabase` client argument on purpose — each
 * caller still creates its own client for its own queries, but a fresh
 * `createClient()` call is cheap (no I/O); only `auth.getUser()` itself was
 * the redundant network round trip. Does NOT cover `middleware.ts`, which
 * runs in a separate Edge-runtime request lifecycle (see checklist note).
 */
export const getCachedUser = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
})
