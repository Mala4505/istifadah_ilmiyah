import { createBrowserClient } from '@supabase/ssr'
import { publicEnv } from '@/lib/env'

/**
 * Browser Supabase client — Client Components only. Session lives in
 * cookies via @supabase/ssr so the same session is readable server-side
 * (lib/supabase/server.ts) without a separate auth round trip.
 *
 * Uses the publishable key. RLS in the database is what actually enforces
 * access — see MASTER-PLAN §4.
 */
export function createClient() {
  return createBrowserClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  )
}
