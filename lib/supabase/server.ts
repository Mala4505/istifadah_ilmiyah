import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
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
            // `setAll` was called from a Server Component, which cannot set
            // cookies. Safe to ignore as long as middleware (or a Route
            // Handler / Server Action) refreshes the session elsewhere.
          }
        },
      },
    }
  )
}
