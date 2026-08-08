import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { publicEnv } from '@/lib/env'
import { serverEnv } from '@/lib/env.server'

/**
 * Service-role Supabase client — server-only, bypasses Row Level Security
 * entirely (MASTER-PLAN §4.5). Used where a job legitimately crosses
 * department boundaries by design: importers, the OCR worker, and the
 * status-export generator. Never import this into anything reachable from
 * an unauthenticated request without an explicit role check first — see
 * app/api/import/route.ts for the pattern (check staff_profile.role via the
 * request's session-bound client, THEN reach for this one).
 *
 * This is a plain (non-SSR) supabase-js client: it carries no user session,
 * no cookies, and issues every request as the `service_role` principal via
 * the secret key. It is not a substitute for lib/supabase/server.ts.
 *
 * NOTE (MASTER-PLAN §3.6 day-2 scope): lib/import/run-import.ts does its
 * transactional writes over a direct `pg` connection (DATABASE_URL) instead
 * of through this client, because supabase-js/PostgREST has no multi-
 * statement transaction control and dry-run import needs a real ROLLBACK
 * (see the comment at the top of lib/import/run-import.ts). This client
 * still exists as the general-purpose service-role door for everything else
 * that needs to bypass RLS without needing transactional writes (batch
 * history reads that want to skip RLS, future OCR/export jobs, etc).
 */
export function createAdminClient() {
  return createSupabaseClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, serverEnv.SUPABASE_SECRET_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
