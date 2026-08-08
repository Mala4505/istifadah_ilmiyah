import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { publicEnv, serverEnv } from '@/lib/env'

/**
 * Service-role Supabase client — bypasses RLS entirely (§4.5). Only for the
 * server-side code paths that are explicitly designed to cross department
 * boundaries: the importer (§3.6, runs as service_role by design), the
 * status-export generator (§3.7), and job handlers (§3.11).
 *
 * Never import this into a Server Component or anything reachable from a
 * user request without an explicit authorization check first — RLS is not
 * there to catch a mistake here.
 */
export function createAdminClient() {
  return createSupabaseClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, serverEnv.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
